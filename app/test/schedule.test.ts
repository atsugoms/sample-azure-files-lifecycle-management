import assert from "node:assert/strict";
import { test } from "node:test";
import { createScheduleStore, nextScheduleRun, parseSchedule, scheduleCron, scheduleFromCron, type Schedule } from "../src/schedule.js";
import { fixture } from "./fixture.js";

const resourceId = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/test-rg/providers/Microsoft.App/jobs/archive-job";
const weekly: Schedule = { enabled: true, frequency: "weekly", time: "00:15", weekdays: [0, 1, 6] };

function armFixture() {
  const job = {
    tags: { owner: "demo" } as Record<string, string>,
    properties: {
      provisioningState: "Succeeded",
      configuration: { triggerType: "Manual", replicaTimeout: 600, replicaRetryLimit: 0,
        manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
        scheduleTriggerConfig: null as null | { cronExpression: string },
        secrets: [{ name: "unrelated-secret" }], registries: [{ server: "test.azurecr.io", identity: "/identity/job" }] },
    },
  };
  const patches: Record<string, unknown>[] = [];
  let failing = false;
  let failUpdate = false;
  const request: typeof fetch = async (input, init) => {
    assert.equal(String(input), `https://management.azure.com${resourceId}?api-version=2025-01-01`);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer arm-token");
    if (failing) return new Response("private-upstream-error", { status: 403 });
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as {
        tags: Record<string, string>; properties: { configuration: typeof job.properties.configuration };
      };
      patches.push(patch);
      Object.assign(job.tags, patch.tags);
      Object.assign(job.properties.configuration, patch.properties.configuration);
      if (failUpdate) job.properties.provisioningState = "Failed";
      return new Response(null, { status: 202 });
    }
    return Response.json(structuredClone(job));
  };
  const store = createScheduleStore({ WEB_SCHEDULE_JOB_RESOURCE_ID: resourceId }, {
    request, wait: async () => {},
    credential: { async getToken() { return { token: "arm-token", expiresOnTimestamp: Date.now() + 60_000 }; } },
  })!;
  return { job, patches, store, fail() { failing = true; }, failUpdate() { failUpdate = true; } };
}

test("Japanese daily/weekly times round-trip UTC including Sunday and midnight boundaries", () => {
  assert.equal(scheduleCron(weekly), "15 15 * * 0,5,6");
  assert.deepEqual(scheduleFromCron("15 15 * * 0,5,6"), weekly);
  for (const hour of [0, 8, 9, 23]) {
    const time = `${String(hour).padStart(2, "0")}:45`;
    for (const frequency of ["daily", "weekly"] as const) {
      const value = { ...weekly, time, frequency, weekdays: frequency === "weekly" ? weekly.weekdays : [] };
      assert.deepEqual(scheduleFromCron(scheduleCron(value)), value);
    }
  }
  assert.equal(nextScheduleRun(weekly, new Date("2026-12-31T23:59:00Z")), "2027-01-01T15:15:00.000Z");
  assert.equal(nextScheduleRun({ ...weekly, weekdays: [0] }, new Date("2026-11-14T15:15:00Z")), "2026-11-21T15:15:00.000Z");
  assert.equal(nextScheduleRun({ ...weekly, enabled: false }), null);
  assert.equal(scheduleFromCron("0 */2 * * *"), null);
  assert.equal(scheduleFromCron("60 0 * * *"), null);
  assert.equal(scheduleFromCron("0 24 * * *"), null);
});

test("schedule validation rejects ambiguous input rather than ignoring it", () => {
  for (const input of [
    { ...weekly, enabled: "true" }, { ...weekly, time: "24:00" }, { ...weekly, time: "9:00" },
    { ...weekly, weekdays: [] }, { ...weekly, weekdays: [1, 1] }, { ...weekly, weekdays: [7] },
    { ...weekly, weekdays: ["1"] }, { ...weekly, frequency: "daily" }, { ...weekly, resourceId: "/other/job" },
    { ...weekly, frequency: ["daily"], weekdays: [] },
    null, [],
  ]) assert.throws(() => parseSchedule(input));
  assert.deepEqual(parseSchedule({ ...weekly, weekdays: [6, 0, 1] }), weekly);
  assert.throws(() => createScheduleStore({ WEB_SCHEDULE_JOB_RESOURCE_ID: resourceId + "/../other" }));
});

test("ARM schedule update preserves unrelated settings and disabled preferences, and rejects stale writes", async () => {
  const { store, job, patches } = armFixture();
  const original = await store.read();
  assert.equal(original.settings?.enabled, false);
  const saved = await store.write(weekly, original.revision);
  assert.equal(saved.trigger, "Schedule");
  assert.equal(saved.cronUtc, "15 15 * * 0,5,6");
  assert.equal(job.tags.owner, "demo");
  const payload = patches[0] as { properties: { configuration: Record<string, unknown> } };
  assert.ok(!("replicaTimeout" in payload.properties.configuration));
  assert.ok(!("registries" in payload.properties.configuration));
  assert.equal(job.properties.configuration.replicaTimeout, 600);
  assert.deepEqual(job.properties.configuration.registries, [{ server: "test.azurecr.io", identity: "/identity/job" }]);
  assert.ok(!("secrets" in payload.properties.configuration));
  assert.ok(!("template" in payload.properties));
  await assert.rejects(store.write(weekly, original.revision), /更新されています/);
  const disabled = await store.write({ ...weekly, enabled: false }, saved.revision);
  assert.equal(disabled.trigger, "Manual");
  assert.deepEqual((await store.read()).settings, { ...weekly, enabled: false });
  const outcomes = await Promise.allSettled([
    store.write({ ...weekly, time: "02:00", enabled: false }, disabled.revision),
    store.write({ ...weekly, time: "03:00", enabled: false }, disabled.revision),
  ]);
  assert.deepEqual(outcomes.map((item) => item.status), ["fulfilled", "rejected"]);
});

test("unsupported native triggers and failed Azure operations are not reported as saved", async () => {
  const unsupported = armFixture();
  unsupported.job.properties.configuration.triggerType = "Event";
  const readOnly = await unsupported.store.read();
  assert.equal(readOnly.settings, null);
  await assert.rejects(unsupported.store.write(weekly, readOnly.revision), /変更できません/);
  assert.equal(unsupported.patches.length, 0);
  const failed = armFixture();
  const before = await failed.store.read();
  failed.failUpdate();
  await assert.rejects(failed.store.write(weekly, before.revision), /update failed/);
  assert.equal(failed.patches.length, 1);
});

test("schedule API enforces CSRF, revision and input validation, and hides ARM errors", async (t) => {
  const arm = armFixture();
  const app = await fixture(arm.store);
  t.after(() => app.close());
  const put = (value: unknown, revision: string, extra: Record<string, string> = {}) => fetch(`${app.url}/api/schedule`, {
    method: "PUT", headers: { Origin: app.url, "Content-Type": "application/json",
      "If-Match": revision, "X-Archive-Request": "1", ...extra }, body: JSON.stringify(value),
  });
  const original = await (await fetch(`${app.url}/api/schedule`)).json() as { revision: string };
  assert.equal((await put(weekly, original.revision, { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await put(weekly, original.revision, { "X-Archive-Request": "" })).status, 403);
  assert.equal((await put(weekly, "*")).status, 428);
  assert.equal((await put({ ...weekly, time: "99:00" }, original.revision)).status, 400);
  assert.equal(arm.patches.length, 0);
  assert.equal((await put(weekly, original.revision)).status, 200);
  assert.equal((await put(weekly, original.revision)).status, 409);
  arm.fail();
  const failed = await fetch(`${app.url}/api/schedule`);
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /private-upstream-error|arm-token/);
  assert.equal(app.errors.length, 1);
});
