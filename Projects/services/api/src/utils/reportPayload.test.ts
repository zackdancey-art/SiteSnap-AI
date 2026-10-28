/**
 * AUDIT L96 and L97. Pure logic, no store, so it runs in the in-memory suite.
 *
 * Both findings are about content that existed everywhere except in the
 * document it was collected for, so every test here is written the same way:
 * assert what the report now says, and assert in the SAME test what the field
 * the old code read says, so a passing test cannot mean the rendering was
 * skipped and the strings happened to match.
 *
 * The store-backed halves — which company's members are consulted for a name,
 * and whether the five fields survive Postgres — are in
 * `storage/report-payload-db.test.ts`. They cannot be answered here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAuthorNameIndex,
  effectiveEntryNotes,
  formatHourLabel,
  renderHourlyNotes,
  renderSafetyRecord,
  resolveAuthorName,
} from "./reportPayload";

test("the hour label matches the capture form, and a nonsense hour keeps its note", () => {
  assert.equal(formatHourLabel(7), "07:00");
  assert.equal(formatHourLabel(0), "00:00");
  assert.equal(formatHourLabel(23), "23:00");

  // Out of range, fractional and not-a-number all label rather than throw.
  for (const hour of [24, -1, 7.5, Number.NaN]) {
    assert.equal(formatHourLabel(hour), "Unrecorded hour", `hour ${hour}`);
  }

  // And the note survives the label — the whole of L97 is content being
  // dropped, so a validation rule must not drop it a second time.
  const rendered = renderHourlyNotes([{ hour: 99, note: "Crane off-hired." }]);
  assert.match(rendered.text, /Crane off-hired\./);
  assert.equal(rendered.recordedHours, 1);
});

test("the hourly log drops the form's empty hours and keeps the rest in order", () => {
  // Exactly what apps/mobile/app/new-entry.tsx writes: every hour in the
  // chosen window, most of them blank. Built here the way the form builds it
  // so the fixture cannot drift from the shape in production.
  const window = [];
  for (let hour = 7; hour <= 17; hour += 1) window.push({ hour, note: "" });
  const byHour = new Map([
    [9, "Set out footings to grid A."],
    [7, "Toolbox talk, then plant checks."],
    [14, "  Concrete pour, 12m³.  "],
  ]);
  const hourlyNotes = window.map((row) => ({ hour: row.hour, note: byHour.get(row.hour) ?? "" }));
  assert.equal(hourlyNotes.length, 11, "the form writes every hour in the window");

  const rendered = renderHourlyNotes(hourlyNotes);

  // Only the hours that said something, oldest first, trimmed.
  assert.equal(
    rendered.text,
    ["07:00 — Toolbox talk, then plant checks.", "09:00 — Set out footings to grid A.", "14:00 — Concrete pour, 12m³."].join("\n")
  );
  // Measured from the fixture above rather than written as a number: three
  // hours carry a note, eight do not.
  assert.equal(rendered.recordedHours, byHour.size);
  assert.equal(rendered.text.split("\n").length, byHour.size);

  // The positive control for "the blanks were dropped": they were in the input.
  assert.equal(hourlyNotes.filter((row) => !row.note.trim()).length, 11 - byHour.size);
  assert.doesNotMatch(rendered.text, /10:00/, "an hour with no note is not printed");
});

test("an hourly entry's content reaches the report, which is what L97 cost", () => {
  // The entry as the capture form saves it when the user chose hourly: the
  // free-text column is EMPTY and all the work is in hourlyNotes.
  const entry = {
    notes: "",
    notesMode: "hourly" as const,
    hourlyNotes: [
      { hour: 8, note: "Scaffold handover inspection." },
      { hour: 13, note: "Blockwork to lift 2." },
    ],
  };

  const effective = effectiveEntryNotes(entry);
  assert.equal(effective.source, "hourly");
  assert.match(effective.text, /Scaffold handover inspection\./);
  assert.match(effective.text, /Blockwork to lift 2\./);
  assert.equal(effective.recordedHours, 2);

  // THE CONTROL, in the same test: the field the old payload read. It is empty,
  // so the old code sent a blank entry to the model for a day with two records
  // on it. Both assertions are needed — the first alone would pass if
  // `effectiveEntryNotes` simply echoed `notes`.
  assert.equal(entry.notes.trim(), "", "the field the old payload read is empty");
  assert.notEqual(effective.text.trim(), "", "the field the report now reads is not");
});

test("free text and an hourly log both survive, with notesMode deciding only the order", () => {
  const both = {
    notes: "Shift started late; access road blocked.",
    hourlyNotes: [{ hour: 10, note: "Road cleared, works resumed." }],
  };

  const freeFirst = effectiveEntryNotes({ ...both, notesMode: "free" });
  const hourlyFirst = effectiveEntryNotes({ ...both, notesMode: "hourly" });

  for (const rendered of [freeFirst, hourlyFirst]) {
    assert.equal(rendered.source, "both");
    assert.match(rendered.text, /access road blocked/);
    assert.match(rendered.text, /Road cleared, works resumed\./);
  }
  // The mode changes the order and nothing else. An entry switched from free to
  // hourly mid-shift has content in both columns, and picking one is the defect.
  assert.ok(freeFirst.text.indexOf("access road") < freeFirst.text.indexOf("Road cleared"));
  assert.ok(hourlyFirst.text.indexOf("Road cleared") < hourlyFirst.text.indexOf("access road"));
  assert.equal(freeFirst.text.length, hourlyFirst.text.length, "the same content, reordered");

  const neither = effectiveEntryNotes({ notes: "   ", hourlyNotes: [{ hour: 9, note: " " }] });
  assert.equal(neither.source, "none");
  assert.equal(neither.text, "");
});

test("the safety record keeps 'not held' and 'never answered' apart", () => {
  const held = renderSafetyRecord({ swmsRef: "SWMS-114", hazardNotes: "Open penetration, barricaded.", toolboxTalk: true });
  assert.match(String(held), /SWMS reference: SWMS-114/);
  assert.match(String(held), /Hazards noted: Open penetration, barricaded\./);
  assert.match(String(held), /Toolbox talk: Held/);

  // `false` is a person answering the question. It must appear.
  const notHeld = renderSafetyRecord({ swmsRef: "SWMS-114", toolboxTalk: false });
  assert.match(String(notHeld), /Toolbox talk: Not held/);

  // `undefined` is the question never having been asked — on every entry older
  // than the field, and on any client that does not send it. It must NOT
  // appear, in either direction. The two assertions above are this one's
  // positive control: the line is printable, so its absence here is a decision.
  const unanswered = renderSafetyRecord({ swmsRef: "SWMS-114" });
  assert.match(String(unanswered), /SWMS reference: SWMS-114/);
  assert.doesNotMatch(String(unanswered), /Toolbox talk/);

  // Nothing recorded is null, not "N/A" — the caller decides whether to print
  // a heading. The old code's hardcoded "N/A" sat on top of these three fields.
  assert.equal(renderSafetyRecord({}), null);
  assert.equal(renderSafetyRecord({ swmsRef: "  ", hazardNotes: "" }), null);
});

test("an author resolves to a display name and never to the email address", () => {
  const index = buildAuthorNameIndex([
    { email: "Sam.Okafor@example.com", fullName: "Sam Okafor" },
    { email: "jo@example.com", fullName: "  Jo Whitlam  " },
    { email: "noname@example.com", fullName: "   " },
  ]);

  // Case-insensitive on both sides: the entry row and the member row are
  // written by different code paths and only one normalises case.
  assert.equal(resolveAuthorName(index, "sam.okafor@example.com"), "Sam Okafor");
  assert.equal(resolveAuthorName(index, "SAM.OKAFOR@EXAMPLE.COM"), "Sam Okafor");
  assert.equal(resolveAuthorName(index, " jo@example.com "), "Jo Whitlam");

  // Unresolvable is undefined — never the address. Asserted as "no @ anywhere
  // in any resolved value", because the failure that matters is an email
  // reaching the report and the OpenAI payload, not a specific wrong string.
  assert.equal(resolveAuthorName(index, "gone@example.com"), undefined, "removed from the company");
  assert.equal(resolveAuthorName(index, "noname@example.com"), undefined, "member row has no name");
  assert.equal(resolveAuthorName(index, ""), undefined);
  assert.equal(resolveAuthorName(index, undefined), undefined);
  for (const name of index.byEmail.values()) {
    assert.doesNotMatch(name, /@/, `resolved name "${name}" must not be an address`);
  }
  // The control for those three undefineds: this index CAN resolve a name.
  assert.equal(index.byEmail.size, 2, "two members have both an address and a name");
});

test("two members sharing a name are reported as ambiguous rather than presented as one", () => {
  const clashing = buildAuthorNameIndex([
    { email: "j.smith@example.com", fullName: "John Smith" },
    { email: "john.smith@example.com", fullName: "John Smith" },
    { email: "ada@example.com", fullName: "Ada Nwosu" },
  ]);
  assert.deepEqual(clashing.duplicateNames, ["John Smith"]);
  // Both addresses still resolve — the limitation is that they resolve to the
  // same name, which is why the collision is named rather than hidden.
  assert.equal(resolveAuthorName(clashing, "j.smith@example.com"), "John Smith");
  assert.equal(resolveAuthorName(clashing, "john.smith@example.com"), "John Smith");

  // The positive control for the empty case: the same shape with no collision
  // reports none, so an empty array means "checked and clear".
  const clear = buildAuthorNameIndex([
    { email: "j.smith@example.com", fullName: "John Smith" },
    { email: "ada@example.com", fullName: "Ada Nwosu" },
  ]);
  assert.deepEqual(clear.duplicateNames, []);
});
