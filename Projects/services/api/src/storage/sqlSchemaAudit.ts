import * as ts from "typescript";

/**
 * Every table and column name the stores' SQL references, checked against what
 * the migrations actually declare.
 *
 * WHY THIS EXISTS
 *
 * AUDIT L99: `updateSiteProgress` filtered on `project_sites.deleted_at`, a
 * column that table did not have. Postgres does not answer that question with a
 * wrong row; it raises, the request hangs, and site progress had therefore never
 * once worked in production. The in-memory store had no such column either, so
 * its twin answered a plausible 404 and the suite stayed green for the life of
 * the feature.
 *
 * That is the defect class this module closes, and it is the one class in the
 * in-memory/Postgres divergence set that NO amount of in-memory testing can
 * reach: the in-memory store cannot have a schema disagreement with a schema it
 * does not have. The only two ways to catch it are to execute the SQL against a
 * real Postgres, or to read the SQL and the schema statically and compare them.
 * The first needs a database. This is the second, and it needs nothing.
 *
 * WHY THE PARSER AND NOT A GREP
 *
 * A first cut of this read the source as text and was wrong four separate ways,
 * each of which is now a fixture test rather than a lesson:
 *
 *   1. Pairing backticks with a regex ran a "template literal" straight through
 *      a JSDoc block, producing a SQL statement that does not exist in the file.
 *      `ts.createSourceFile` has no such failure mode: comments are trivia, a
 *      template literal is a node, and the two cannot be confused.
 *   2. `\bJOIN\b` matched the JavaScript `conditions.join(" AND ")` inside an
 *      interpolation, classifying twelve single-table statements as joins and
 *      quietly dropping them from the audit. There are three real JOIN sites.
 *   3. A trailing `-- comment` after a column's comma means the NEXT segment of
 *      a CREATE TABLE body begins with the comment, so every column following a
 *      commented one was read as undeclared. Stripping comments is load-bearing,
 *      and stripping them has to respect string literals.
 *   4. `ALTER TABLE t ADD COLUMN a, ADD COLUMN b, ADD COLUMN c` declares three
 *      columns. Reading only the first invents undeclared columns wholesale.
 *
 * Note the asymmetry those four share, because it is the reason this module is
 * built the way it is. A declaration parser that under-reads produces false
 * ALARMS: loud, immediate, and safe. A reference parser that under-reads
 * produces false GREEN: silent, and indistinguishable from a clean audit. So
 * every statement this module cannot resolve is reported in `unresolved` rather
 * than skipped, and the test pins how many there are. Dropping a statement on
 * the floor has to be a visible event.
 */

/** table name -> the set of column names the migrations declare on it. */
export type DeclaredSchema = Map<string, Set<string>>;

export type SqlLiteral = {
  file: string;
  line: number;
  /** Literal text with every `${...}` replaced by INTERP_PLACEHOLDER. */
  text: string;
  interpolated: boolean;
};

export type Violation = {
  file: string;
  line: number;
  table: string;
  column: string;
};

export type Unresolved = {
  file: string;
  line: number;
  reason: string;
};

export type SqlAudit = {
  /** References naming a column the schema does not declare on that table. */
  violations: Violation[];
  /** Statements this module declined to resolve, with the reason for each. */
  unresolved: Unresolved[];
  /** DML statements examined (resolved + unresolved). */
  statements: number;
  /** Individual column references checked against the schema and found. */
  resolved: number;
};

/**
 * Stands in for `${...}` in a literal's text. Deliberately not an identifier:
 * an earlier version used `~INTERP~`, whose middle matched the identifier
 * pattern and was then reported as an undeclared column on every interpolated
 * statement in the codebase.
 */
export const INTERP_PLACEHOLDER = " ? ";

/**
 * SQL keywords, type names and function names that appear bare in these
 * statements and are not column references. Over-inclusion costs coverage (a
 * real column named `status` would be skipped if `status` were listed); it is
 * kept to words that are unambiguously syntax in this codebase's SQL.
 */
const SQL_WORDS = new Set(
  `select insert into update delete from where set values returning and or not null is as on conflict do nothing
   order by asc desc limit offset group having distinct count sum avg min max coalesce now current_timestamp
   true false case when then else end exists in between like ilike join left right inner outer full cross using
   union all with interval extract epoch date timestamp timestamptz text integer boolean jsonb uuid numeric
   default primary key unique references foreign constraint check create table alter add column if cascade index
   concurrently array to_jsonb json_agg json_build_object array_agg nullif greatest least lower upper trim length
   substring position cast excluded for of no share mode row rows only lateral at time zone without local
   tablespace generated always identity begin commit rollback set_config current_setting force level security
   policy enable disable owner grant revoke truncate vacuum analyze explain nulls first last`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Postgres system columns. `(xmax = 0) AS inserted` is the standard way to ask
 * an upsert whether it inserted or updated, and `xmax` is not in any migration.
 */
const SYSTEM_COLUMNS = new Set(["xmax", "xmin", "ctid", "tableoid", "cmin", "cmax", "oid"]);

/**
 * Removes `--` line comments and block comments, leaving anything inside a
 * single-quoted string alone. A blind regex would cut a literal containing two
 * hyphens in half, and the halves would then parse as something else entirely.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      i += 2;
      while (i < sql.length && !sql.startsWith("*/", i)) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Splits a CREATE TABLE body on its top-level commas, ignoring nested parens. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let inString = false;
  for (const ch of body) {
    if (inString) {
      cur += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Table-level constraints, which open a CREATE TABLE segment but name no column. */
const TABLE_CONSTRAINTS = ["constraint", "primary", "unique", "check", "foreign", "exclude", "like"];

/**
 * The schema the migrations declare. Takes the SQL text of every migration plus
 * any DDL the application issues itself (the migration runner creates
 * `schema_migrations` in TypeScript, so without that second source its own two
 * statements would audit against a table nothing declares).
 */
export function parseDeclarations(sources: string[]): DeclaredSchema {
  const schema: DeclaredSchema = new Map();
  const ensure = (table: string): Set<string> => {
    const key = table.toLowerCase();
    let cols = schema.get(key);
    if (!cols) {
      cols = new Set<string>();
      schema.set(key, cols);
    }
    return cols;
  };

  for (const raw of sources) {
    const sql = stripSqlComments(raw);

    const createRe = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z_]\w*)\s*\(/gi;
    let created: RegExpExecArray | null;
    while ((created = createRe.exec(sql)) !== null) {
      const cols = ensure(created[1]);
      // Walk from the opening paren to its match, so a CHECK or a REFERENCES
      // clause containing parens cannot end the body early.
      let depth = 0;
      let end = -1;
      for (let i = createRe.lastIndex - 1; i < sql.length; i += 1) {
        if (sql[i] === "(") depth += 1;
        else if (sql[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) continue;
      for (const segment of splitTopLevel(sql.slice(createRe.lastIndex, end))) {
        const trimmed = segment.trim();
        if (!trimmed) continue;
        const name = /^([A-Za-z_]\w*)/.exec(trimmed);
        if (!name) continue;
        if (TABLE_CONSTRAINTS.includes(name[1].toLowerCase())) continue;
        cols.add(name[1].toLowerCase());
      }
    }

    // One ALTER TABLE may carry many comma-separated ADD COLUMN clauses.
    const alterRe = /ALTER TABLE\s+(?:IF EXISTS\s+)?([A-Za-z_]\w*)([\s\S]*?);/gi;
    let altered: RegExpExecArray | null;
    while ((altered = alterRe.exec(sql)) !== null) {
      const cols = ensure(altered[1]);
      const addRe = /ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([A-Za-z_]\w*)/gi;
      let added: RegExpExecArray | null;
      while ((added = addRe.exec(altered[2])) !== null) cols.add(added[1].toLowerCase());
    }
  }
  return schema;
}

/**
 * Every template literal in a TypeScript source, via the real parser.
 *
 * Interpolations are replaced rather than dropped so that `WHERE id = ${x}`
 * cannot be read as `WHERE id =` and so that an interpolated TABLE name stays
 * visible as something this module must refuse to resolve.
 */
export function extractSqlLiterals(file: string, source: string): SqlLiteral[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: SqlLiteral[] = [];

  const push = (node: ts.Node, text: string, interpolated: boolean) => {
    found.push({
      file,
      line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      text,
      interpolated,
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text, false);
    } else if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) text += INTERP_PLACEHOLDER + span.literal.text;
      push(node, text, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

const DML = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
const DDL = /\b(CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|CREATE\s+POLICY|CREATE\s+TRIGGER|CREATE\s+OR\s+REPLACE)\b/i;

/** Reads `FROM t`, `JOIN t alias`, `UPDATE t`, `INSERT INTO t` targets. */
function statementTables(sql: string): { names: string[]; aliases: Map<string, string>; interpolated: boolean } {
  const names: string[] = [];
  const aliases = new Map<string, string>();
  let interpolated = false;
  const re = /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO)\s+(\?|[A-Za-z_]\w*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    if (!table || table === "?") {
      interpolated = true;
      continue;
    }
    const lower = table.toLowerCase();
    // `ON CONFLICT (id) DO UPDATE SET x = ...` puts a keyword where a table
    // name goes. Read literally, every upsert in the codebase reported a table
    // called "set" and dropped itself out of the audit.
    if (SQL_WORDS.has(lower)) continue;
    names.push(lower);
    const alias = m[2];
    // `FROM sites WHERE` — the follower is a keyword, not an alias.
    if (alias && !SQL_WORDS.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), lower);
    aliases.set(lower, lower);
  }
  // In `... ON CONFLICT (id) DO UPDATE SET x = excluded.x`, `excluded` is the
  // row proposed for insertion, so its columns are the target table's columns.
  if (names.length > 0 && /\bON\s+CONFLICT\b/i.test(sql)) aliases.set("excluded", names[0]);
  return { names, aliases, interpolated };
}

/**
 * Compares every resolvable table.column reference against the schema.
 *
 * Unqualified columns in a multi-table statement are accepted if ANY table in
 * the statement declares them. That is weaker than Postgres, which would reject
 * a genuinely ambiguous reference, and it is deliberate: the alternative is
 * guessing which table a bare column belongs to, and a guess here produces a
 * false alarm on correct code. It still catches the L99 shape, where the column
 * exists on no table in the statement at all.
 */
export function auditSqlReferences(schema: DeclaredSchema, literals: SqlLiteral[]): SqlAudit {
  const violations: Violation[] = [];
  const unresolved: Unresolved[] = [];
  let statements = 0;
  let resolved = 0;

  for (const literal of literals) {
    const sql = stripSqlComments(literal.text);
    if (!DML.test(sql) || DDL.test(sql)) continue;
    statements += 1;
    const at = { file: literal.file, line: literal.line };

    if (/\(\s*SELECT\b/i.test(sql)) {
      unresolved.push({ ...at, reason: "subquery" });
      continue;
    }
    const { names, aliases, interpolated } = statementTables(sql);
    if (interpolated) {
      unresolved.push({ ...at, reason: "interpolated-table" });
      continue;
    }
    if (names.length === 0) {
      unresolved.push({ ...at, reason: "no-table" });
      continue;
    }
    const unknown = names.filter((n) => !schema.has(n));
    if (unknown.length > 0) {
      unresolved.push({ ...at, reason: `unknown-table:${unknown.join(",")}` });
      continue;
    }

    // Output aliases name no column: `(xmax = 0) AS inserted`.
    const scrubbed = sql
      .replace(/'[^']*'/g, "''")
      .replace(/::\s*[A-Za-z_]\w*(\[\])?/g, "")
      .replace(/\bAS\s+[A-Za-z_]\w*/gi, "AS");

    const idRe = /([A-Za-z_]\w*)?\.?\b([A-Za-z_]\w*)\b/g;
    let id: RegExpExecArray | null;
    while ((id = idRe.exec(scrubbed)) !== null) {
      const qualifier = id[1] && scrubbed[id.index + id[1].length] === "." ? id[1].toLowerCase() : null;
      const word = id[2];
      const lower = word.toLowerCase();
      if (SQL_WORDS.has(lower) || SYSTEM_COLUMNS.has(lower)) continue;
      if (scrubbed[idRe.lastIndex] === "(") continue; // function call
      if (names.includes(lower) || aliases.has(lower)) continue; // a table or alias, not a column
      if (/^\d/.test(word)) continue;

      if (qualifier) {
        const table = aliases.get(qualifier);
        if (!table) {
          unresolved.push({ ...at, reason: `unknown-alias:${qualifier}` });
          continue;
        }
        if (schema.get(table)?.has(lower)) resolved += 1;
        else violations.push({ ...at, table, column: word });
        continue;
      }
      const owner = names.find((n) => schema.get(n)?.has(lower));
      if (owner) resolved += 1;
      else violations.push({ ...at, table: names.join("/"), column: word });
    }
  }
  return { violations, unresolved, statements, resolved };
}
