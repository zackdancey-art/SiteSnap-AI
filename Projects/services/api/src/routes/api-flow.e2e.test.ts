import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { AddressInfo } from "net";
import { after, test } from "node:test";
import { createApp } from "../server";
import { createUser, initAuthSchema, resetAuthStoreForTests } from "../storage/authStore";
import { initProjectSchema, resetProjectStoreForTests } from "../storage/projectsStore";
import { createAuthToken } from "../utils/authToken";
import { hashPassword } from "../utils/password";

const originalCwd = process.cwd();

after(async () => {
  process.chdir(originalCwd);
});

test("HTTP API flow persists site and entry data and generates diary by siteId", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sitesnap-api-flow-"));
  process.chdir(tempDir);

  await resetAuthStoreForTests();
  await resetProjectStoreForTests();
  await initAuthSchema();
  await initProjectSchema();

  const app = createApp();
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });

  try {
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    // THE ROW IS NOW REQUIRED, NOT OPTIONAL.
    //
    // This test used to mint a token for an email with no auth_users row and
    // drive the whole flow with it. That worked while authorisation read the
    // token's claims: a valid signature was a valid session, and the user
    // needed only to exist in the token. `requireAuth` now reads the row on
    // every authenticated request — authority comes from it, not from the
    // claims (THE SESSION MODEL, storage/authStore.ts) — so a token for a
    // non-existent user is a dead session and answers 401.
    //
    // Seeding the user is the correct fix rather than a concession to the
    // middleware: a bearer token that no account backs is exactly what this
    // API should refuse, and `projects.e2e.test.ts` has always set its
    // fixtures up this way.
    await createUser(
      "flow@example.com",
      await hashPassword("Password123!"),
      "+14155550199",
      "Flow User",
      "supervisor",
      "flow-test-company",
      "owner",
    );
    const token = createAuthToken({ email: "flow@example.com", fullName: "Flow User", role: "supervisor", companyId: "flow-test-company", companyRole: "owner", tokenGeneration: 0 });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    const siteRes = await fetch(`${baseUrl}/api/projects/sites`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "API Flow Site",
        address: "9 Integration Lane",
        client: "QA",
        startDate: "2026-03-07",
        status: "active",
      }),
    });
    assert.equal(siteRes.status, 201);
    const sitePayload = (await siteRes.json()) as { site: { id: string } };

    const entryRes = await fetch(`${baseUrl}/api/projects/entries`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        siteId: sitePayload.site.id,
        date: "2026-03-07",
        locationAddress: "9 Integration Lane",
        weather: "Sunny",
        crewCount: "3",
        notes: "Installed framing and secured site.",
        photos: [],
      }),
    });
    assert.equal(entryRes.status, 201);

    const bootstrapRes = await fetch(`${baseUrl}/api/projects/bootstrap`, { headers });
    assert.equal(bootstrapRes.status, 200);
    const bootstrapPayload = (await bootstrapRes.json()) as {
      sites: Array<{ id: string }>;
      entries: Array<{ siteId: string }>;
      diaries: unknown[];
    };
    assert.equal(bootstrapPayload.sites.length, 1);
    assert.equal(bootstrapPayload.entries.length, 1);
    assert.equal(bootstrapPayload.entries[0]?.siteId, sitePayload.site.id);
    assert.equal(bootstrapPayload.diaries.length, 0);

    const diaryRes = await fetch(`${baseUrl}/api/generate-diary`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        siteId: sitePayload.site.id,
        period: "daily",
      }),
    });
    assert.equal(diaryRes.status, 200);
    const diaryPayload = (await diaryRes.json()) as {
      success: boolean;
      diary?: { sections?: Array<{ workCompleted?: string }>; reportPeriod?: string };
    };
    assert.equal(diaryPayload.success, true);
    assert.equal(diaryPayload.diary?.reportPeriod, "daily");
    assert.match(diaryPayload.diary?.sections?.[0]?.workCompleted || "", /Installed framing/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
