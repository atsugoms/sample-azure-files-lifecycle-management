import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createExecutionStore } from "../src/execution.js";
import { fixture } from "./fixture.js";

const resourceId = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/test-rg/providers/Microsoft.App/jobs/archive-job";
const base = `https://management.azure.com${resourceId}`;
function armFixture() {
  const state = {
    items: [] as { name: string; properties: { status: string } }[],
    later: [] as { name: string; properties: { status: string } }[],
    nextLink: null as string | null, provisioningState: "Succeeded",
    starts: 0, failure: 0, startFailure: 0, acceptedOnly: false,
  };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://management.azure.com");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer arm-token");
    if (state.failure) return new Response("private-upstream-error", { status: state.failure });
    if (init?.method === "POST") {
      assert.equal(url.pathname, `${resourceId}/start`);
      assert.equal(init.body, undefined);
      state.starts++;
      if (state.startFailure) return new Response("private-start-error", { status: state.startFailure });
      return state.acceptedOnly ? new Response(null, { status: 202 }) : Response.json({ name: `execution-${state.starts}` });
    }
    assert.equal(init?.method, "GET");
    if (url.pathname === resourceId) return Response.json({ properties: { provisioningState: state.provisioningState } });
    assert.equal(url.pathname, `${resourceId}/executions`);
    return Response.json(url.searchParams.has("page")
      ? { value: state.later, nextLink: null } : { value: state.items, nextLink: state.nextLink });
  };
  const store = createExecutionStore({ WEB_SCHEDULE_JOB_RESOURCE_ID: resourceId }, {
    request, credential: { async getToken() { return { token: "arm-token", expiresOnTimestamp: Date.now() + 60_000 }; } },
  })!;
  return { state, store };
}
const item = (name: string, status: string) => ({ name, properties: { status } });

test("one-off execution starts the unchanged job once and deduplicates request retries", async () => {
  const { store, state } = armFixture();
  const id = randomUUID();
  const first = store.start(id);
  const duplicate = store.start(id);
  await assert.rejects(store.start(randomUUID()), /処理中/);
  assert.deepEqual(await first, { jobName: "archive-job", executionName: "execution-1" });
  assert.deepEqual(await duplicate, await first);
  assert.equal(state.starts, 1);
  assert.equal((await store.read()).pending, true);
  await assert.rejects(store.start(randomUUID()), /確認中/);
  state.items = [item("execution-1", "Running")];
  assert.equal((await store.read()).active.length, 1);
  await assert.rejects(store.start(randomUUID()), /実行中/);
  state.items[0]!.properties.status = "Succeeded";
  assert.equal((await store.read()).pending, false);
  await store.start(id);
  assert.equal(state.starts, 1);
  await store.start(randomUUID());
  assert.equal(state.starts, 2);
});

test("native status checks follow pages, block unknown states and fail closed", async () => {
  const { store, state } = armFixture();
  state.items = [item("old", "Succeeded")];
  state.nextLink = `${base}/executions?api-version=2025-01-01&page=2`;
  for (const status of ["Running", "Processing", "Unknown", "Degraded"]) {
    state.later = [item("other", status)];
    await assert.rejects(store.start(randomUUID()), /実行中/);
  }
  assert.equal(state.starts, 0);
  state.later = [];
  state.provisioningState = "Updating";
  await assert.rejects(store.start(randomUUID()), /更新中/);
  state.provisioningState = "Succeeded";
  state.nextLink = "https://untrusted.example/executions";
  await assert.rejects(store.read(), /configured job/);
  assert.equal(state.starts, 0);
  state.nextLink = null;
  state.failure = 403;
  await assert.rejects(store.start(randomUUID()), /403/);
  assert.equal(state.starts, 0);
});

test("accepted and ambiguous starts remain blocked until native execution becomes visible", async () => {
  const accepted = armFixture();
  accepted.state.acceptedOnly = true;
  assert.equal((await accepted.store.start(randomUUID())).executionName, null);
  assert.equal((await accepted.store.read()).pending, true);
  accepted.state.items = [item("generated-name", "Succeeded")];
  assert.equal((await accepted.store.read()).pending, false);

  const ambiguous = armFixture();
  ambiguous.state.startFailure = 500;
  const id = randomUUID();
  await assert.rejects(ambiguous.store.start(id), /500/);
  await assert.rejects(ambiguous.store.start(id), /500/);
  assert.equal(ambiguous.state.starts, 1);
  assert.equal((await ambiguous.store.read()).uncertain, true);
  await assert.rejects(ambiguous.store.start(randomUUID()), /確認中/);
  assert.equal(ambiguous.state.starts, 1);

  const rejected = armFixture();
  rejected.state.startFailure = 403;
  await assert.rejects(rejected.store.start(randomUUID()), /403/);
  assert.equal((await rejected.store.read()).uncertain, false);
  assert.equal((await rejected.store.read()).pending, false);
});

test("one-off API rejects CSRF, overrides and stale confirmations without starting, and masks errors", async (t) => {
  const { store, state } = armFixture();
  const app = await fixture(undefined, store);
  t.after(() => app.close());
  const current = await app.settings.read();
  const headers = { Origin: app.url, "Content-Type": "application/json",
    "X-Archive-Request": "1", "If-Match": current.etag };
  const post = (value: unknown = { requestId: randomUUID() }, extra: Record<string, string> = {}) =>
    fetch(`${app.url}/api/execution`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  assert.equal((await fetch(`${app.url}/api/execution`)).status, 200);
  assert.equal((await post(undefined, { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await post(undefined, { "X-Archive-Request": "" })).status, 403);
  assert.equal((await post(undefined, { "If-Match": "*" })).status, 428);
  assert.equal((await post(undefined, { "If-Match": "stale" })).status, 409);
  assert.equal((await post({ requestId: randomUUID(), containers: [] })).status, 400);
  assert.equal((await post({ requestId: "invalid" })).status, 400);
  assert.equal(state.starts, 0);
  const id = randomUUID();
  assert.equal((await post({ requestId: id })).status, 202);
  assert.equal((await post({ requestId: id })).status, 202);
  assert.equal(state.starts, 1);
  assert.equal((await post()).status, 409);
  state.failure = 403;
  const failed = await fetch(`${app.url}/api/execution`);
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /private-upstream-error|arm-token/);
  assert.equal(app.errors.length, 1);
  assert.equal(state.starts, 1);
  assert.deepEqual(await app.settings.read(), current);
});
