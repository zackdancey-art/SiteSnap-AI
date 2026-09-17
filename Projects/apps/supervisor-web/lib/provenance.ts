/**
 * How a diary's provenance is described to a human.
 *
 * Three states, and the third is not a rounding error: `null` means the diary
 * predates provenance (migration 030) or arrived with a signature the API
 * refused, and its generator is genuinely unknown. It must never be rendered as
 * either generator.
 */
export type DiaryGeneration = {
  generator: "openai" | "fallback";
  model: string | null;
  promptVersion: string;
  warning: string | null;
  generatedAtMs: number;
  tokenUsage: { input: number; output: number } | null;
};

export type ProvenanceLabel = {
  /** Short label for a badge or an export header. */
  label: string;
  /** The longer explanation, or null when there is nothing more to say. */
  detail: string | null;
  tone: "ai" | "fallback" | "unknown";
};

export function describeGeneration(generation: DiaryGeneration | null | undefined): ProvenanceLabel {
  if (!generation) {
    return {
      label: "Generator unknown",
      detail: "This diary was created before SiteSnap recorded which generator wrote it.",
      tone: "unknown",
    };
  }
  if (generation.generator === "openai") {
    return {
      label: `AI-generated${generation.model ? ` (${generation.model})` : ""}`,
      detail: generation.warning,
      tone: "ai",
    };
  }
  return {
    label: "Not AI-generated — built-in template",
    detail: generation.warning,
    tone: "fallback",
  };
}
