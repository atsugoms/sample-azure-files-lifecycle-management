import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { fixture } from "./fixture.js";

test("Web API shares settings validation, SQLite history and conditional writes", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const get = (path: string) => fetch(app.url + path);
  const rawStatus = (path: string, headers: Record<string, string>) => new Promise<number | undefined>((resolve, reject) => {
    const req = request(app.url + path, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.once("error", reject);
    req.end();
  });
  const put = (value: unknown, etag: string, extra: Record<string, string> = {}) => fetch(`${app.url}/api/settings`, {
    method: "PUT", headers: {
      Origin: app.url, "Content-Type": "application/json", "If-Match": etag, "X-Archive-Request": "1", ...extra,
    }, body: typeof value === "string" ? value : JSON.stringify(value),
  });

  await t.test("serves static assets with restrictive headers", async () => {
    for (const path of ["/", "/app.js", "/styles.css"]) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.ok((await response.text()).length > 100);
    }
    assert.equal((await get("/src/index.ts")).status, 404);
  });

  await t.test("reads and pages the job's current execution history without inventing fields", async () => {
    const runs = await (await get("/api/runs")).json();
    assert.equal(runs.length, 25);
    assert.equal(runs[0].runId, "run-25");
    assert.equal(runs[0].settings, undefined);
    const next = await (await get("/api/runs?limit=25&offset=25")).json();
    assert.equal(next.length, 1);
    assert.equal(next[0].runId, "run-00");
    const progress = await (await get("/api/runs/run-25")).json();
    assert.equal(progress.run.status, "succeeded");
    assert.equal(progress.totals.dry_run, 1);
    const files = await (await get("/api/runs/run-25/files")).json();
    assert.equal(files[0].sourceUrl, "https://sourcestorage.file.core.windows.net/documents/completed/quarterly-report.pdf");
    assert.equal(files[0].status, "dry_run");
    assert.equal(files[0].phase, undefined);
    assert.equal((await get("/api/runs/run-25/attempts")).status, 404);
    assert.equal((await (await get("/api/runs/run-25/files?offset=1")).json()).length, 0);
    assert.equal((await get("/api/runs/missing")).status, 404);
    for (const query of ["limit=0", "limit=101", "offset=-1", "offset=1.5", "offset=999999999999999999999"]) {
      assert.equal((await get(`/api/runs?${query}`)).status, 400, query);
    }
  });

  await t.test("supports concurrent read-only history requests", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => get("/api/runs/run-25")));
    assert.ok(responses.every((response) => response.status === 200));
  });

  await t.test("rejects foreign origins, DNS rebinding and unsupported methods", async () => {
    const rebound = await rawStatus("/", { Host: "attacker.example" });
    assert.equal(rebound, 403);
    assert.equal(await rawStatus("/", {
      "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate",
    }), 200);
    assert.equal((await fetch(`${app.url}/api/runs`, {
      headers: { "Sec-Fetch-Site": "cross-site" },
    })).status, 403);
    assert.equal((await fetch(`${app.url}/api/settings`, { headers: { Origin: "https://attacker.example" } })).status, 403);
    assert.equal((await fetch(`${app.url}/api/settings`, { method: "PUT" })).status, 403);
    assert.equal((await fetch(`${app.url}/api/runs`, { method: "POST" })).status, 405);
    assert.equal((await put({}, "*")).status, 428);
    assert.equal((await put({}, "revision-1", { "X-Archive-Request": "" })).status, 403);
  });

  await t.test("validates syntax, schema, overlap and request size without saving", async () => {
    const original = await app.settings.read();
    assert.equal((await put("{", original.etag)).status, 400);
    assert.equal((await put({ ...original.settings, maxFilesPerRun: 0 }, original.etag)).status, 400);
    const duplicate = { ...original.settings, rules: [...original.settings.rules, ...original.settings.rules] };
    assert.equal((await put(duplicate, original.etag)).status, 400);
    assert.equal((await put("x".repeat(33_000), original.etag)).status, 413);
    assert.equal((await put({}, original.etag, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await app.settings.read()).etag, original.etag);
  });

  await t.test("persists settings and rejects stale writes without altering history", async () => {
    const original = await (await get("/api/settings")).json();
    const changed = { ...original.settings, dryRun: false, maxFilesPerRun: 42 };
    const response = await put(changed, original.etag);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.notEqual(result.etag, original.etag);
    assert.equal((await (await get("/api/settings")).json()).settings.maxFilesPerRun, 42);
    assert.equal((await put(original.settings, original.etag)).status, 409);
    assert.equal((await app.history.getRun("run-25"))?.configuration?.dryRun, true);
    assert.equal((await app.settings.read()).settings.dryRun, false);
  });

  await t.test("reports backend failure without exposing internal details", async () => {
    const read = app.settings.read;
    app.settings.read = async () => { throw new Error("secret-backend-details"); };
    const response = await get("/api/settings");
    assert.equal(response.status, 502);
    const message = (await response.json()).error;
    assert.match(message, /参照 ID/);
    assert.doesNotMatch(message, /secret-backend-details/);
    app.settings.read = read;
    assert.equal((await get("/api/settings")).status, 200);
    assert.ok(app.errors.length > 0);
  });
});
