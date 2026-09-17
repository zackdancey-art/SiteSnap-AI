import type { DiaryGeneration } from "@/lib/types";

export type ProvenanceLabel = {
  label: string;
  detail: string | null;
  tone: "ai" | "fallback" | "unknown";
};

/**
 * Three states, and the third is not a rounding error: null means the diary was
 * created before provenance was recorded (API migration 030), or arrived with a
 * signature the API refused. Its generator is genuinely unknown and must never
 * be rendered as either one.
 */
export function describeGeneration(generation: DiaryGeneration | null | undefined): ProvenanceLabel {
  if (!generation) {
    return {
      label: "Generator unknown",
      detail: "This report was created before SiteSnap recorded which generator wrote it.",
      tone: "unknown",
    };
  }
  if (generation.generator === "openai") {
    return {
      label: `AI report${generation.model ? ` · ${generation.model}` : ""}`,
      detail: generation.warning,
      tone: "ai",
    };
  }
  return {
    label: "Basic report — AI unavailable",
    detail: generation.warning ?? "Written by the built-in template generator, not AI.",
    tone: "fallback",
  };
}
