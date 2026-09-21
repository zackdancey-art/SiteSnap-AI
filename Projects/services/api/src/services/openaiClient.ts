import OpenAI from "openai";

let _client: OpenAI | null = null;

// ── Test-mode boundary mock (mirrors the notificationService H3a guard) ───────
// In NODE_ENV=test we NEVER construct a real client or make a network call.
// Instead we return a fake whose `responses.create` records the request `input`
// (so tests can assert which images were/weren't sent to the model) and returns
// a canned valid response. This keeps the vision code path exercisable without
// exporting internal functions or hitting OpenAI.
// `request` is the FULL argument object, not just `input`. It used to record
// only `input`, which meant the fake accepted any parameter set at all — a
// request carrying a parameter the configured model rejects (Sentry
// SITESNAP-API-9: `temperature` on gpt-5.6-terra) was invisible to every test.
// A mock that silently accepts what the real API refuses is worse than no mock,
// because it converts a production 400 into a green suite.
type RecordedOpenAICall = { input: unknown; request: Record<string, unknown> };
const recordedCalls: RecordedOpenAICall[] = [];

// X2 runtime-fallback tests: queue an error the next test-client call will throw,
// so we can prove the route degrades gracefully for a reachable-but-erroring API
// (401/500/timeout) without a real network call. Consumed once, then cleared.
let _nextErrorForTests: unknown = null;
export function setOpenAINextErrorForTests(err: unknown): void {
  _nextErrorForTests = err;
}

export function getRecordedOpenAICallsForTests(): RecordedOpenAICall[] {
  return recordedCalls;
}
export function resetOpenAIRecordingForTests(): void {
  recordedCalls.length = 0;
  _nextErrorForTests = null;
}

function makeTestClient(): OpenAI {
  return {
    responses: {
      create: async (args: { input: unknown } & Record<string, unknown>) => {
        if (_nextErrorForTests) {
          const err = _nextErrorForTests;
          _nextErrorForTests = null;
          throw err;
        }
        recordedCalls.push({ input: args?.input, request: { ...args } });
        return {
          output_text: JSON.stringify({
            summary: "test",
            fullReport: "test",
            safetyChecklist: [],
            sections: [],
          }),
        };
      },
    },
  } as unknown as OpenAI;
}

export function getOpenAIClient(): OpenAI {
  if (process.env.NODE_ENV === "test") {
    return makeTestClient();
  }
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is missing. Add it to services/api/.env");
    }
    _client = new OpenAI({
      apiKey,
      timeout: 90_000,
      maxRetries: 2,
    });
  }
  return _client;
}

export function resetOpenAIClient(): void {
  _client = null;
}
