import assert from "node:assert/strict";
import { test } from "node:test";
import { createUser, initAuthSchema, resetAuthStoreForTests } from "../storage/authStore";
import {
  createDiary,
  createEntry,
  createSite,
  getScopedBootstrap,
  initProjectSchema,
  listDiaries,
  resetProjectStoreForTests,
  updateDiary,
} from "../storage/projectsStore";
import { hashPassword } from "../utils/password";
import { createAuthToken, verifyAuthToken } from "../utils/authToken";

test("RBAC project workflow supports supervisor approval and scoped reads", async () => {
  await resetAuthStoreForTests();
  await resetProjectStoreForTests();
  await initAuthSchema();
  await initProjectSchema();

  const workerEmail = "worker1@example.com";
  const supervisorEmail = "supervisor1@example.com";
  const testCompanyId = "company_test_e2e";
  await createUser(workerEmail, await hashPassword("Password123!"), "+14155550124", "Worker One", "worker", testCompanyId, "crew");
  await createUser(
    supervisorEmail,
    await hashPassword("Password123!"),
    "+14155550125",
    "Supervisor One",
    "supervisor",
    testCompanyId,
    "manager"
  );

  const workerClaims = verifyAuthToken(
    createAuthToken({ email: workerEmail, fullName: "Worker One", role: "worker", companyId: testCompanyId, companyRole: "crew", tokenGeneration: 0 })
  );
  const supervisorClaims = verifyAuthToken(
    createAuthToken({ email: supervisorEmail, fullName: "Supervisor One", role: "supervisor", companyId: testCompanyId, companyRole: "manager", tokenGeneration: 0 })
  );

  assert.ok(workerClaims);
  assert.ok(supervisorClaims);

  const workerActor = { email: workerClaims?.email ?? "", role: workerClaims?.role ?? "worker", companyId: workerClaims?.companyId ?? testCompanyId, companyRole: workerClaims?.companyRole ?? "crew" as const };
  const supervisorActor = {
    email: supervisorClaims?.email ?? "",
    role: supervisorClaims?.role ?? "supervisor",
    companyId: supervisorClaims?.companyId ?? testCompanyId,
    companyRole: supervisorClaims?.companyRole ?? "manager" as const,
  };

  const site = await createSite(workerActor, {
    name: "Pipeline Upgrade",
    address: "22 Dock Street",
    client: "City Utilities",
    startDate: "2026-03-05",
    status: "active",
  });
  await createEntry(workerActor, {
    siteId: site.id,
    date: "2026-03-05",
    locationAddress: "22 Dock Street",
    weather: "Sunny",
    crewCount: "8",
    notes: "Completed trench inspection.",
    photos: [],
  });
  const diary = await createDiary(workerActor, {
    siteId: site.id,
    status: "draft",
    summary: "Draft summary",
    reportPeriod: "daily",
    fullReport: "Detailed draft report",
    safetyChecklist: ["PPE checked"],
    sections: [{ date: "2026-03-05", workCompleted: "Inspection done" }],
  });

  const workerVisible = await getScopedBootstrap(workerActor);
  assert.equal(workerVisible.sites.length, 1);
  assert.equal(workerVisible.entries.length, 1);
  assert.equal(workerVisible.diaries.length, 1);
  assert.equal(workerVisible.diaries[0].status, "draft");

  const approved = await updateDiary(supervisorActor, diary.id, { status: "approved" });
  assert.equal(approved?.status, "approved");

  const supervisorVisible = await listDiaries(supervisorActor);
  assert.equal(supervisorVisible.length, 1);
  assert.equal(supervisorVisible[0].status, "approved");
});
