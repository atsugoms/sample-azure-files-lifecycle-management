import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { readHosting } from "../src/hosting.js";
import { createApp } from "../src/server.js";
import { fixture } from "./fixture.js";

const tenant = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000002";
const origin = "https://archive.example.japaneast.azurecontainerapps.io";
const env = { WEB_HOST_MODE: "container-apps", WEB_PUBLIC_ORIGIN: origin,
  WEB_AUTH_TENANT_ID: tenant, WEB_AUTH_ALLOWED_OBJECT_IDS: user };

test("Azure hosting fails closed without exact origin, tenant and user restrictions", () => {
  assert.equal(readHosting({}).host, "127.0.0.1");
  assert.equal(readHosting(env).host, "0.0.0.0");
  assert.throws(() => readHosting({ ...env, WEB_PUBLIC_ORIGIN: origin + "/" }));
  assert.throws(() => readHosting({ ...env, WEB_PUBLIC_ORIGIN: "http://example.com" }));
  assert.throws(() => readHosting({ ...env, WEB_AUTH_ALLOWED_OBJECT_IDS: "" }));
  assert.throws(() => readHosting({ ...env, WEB_AUTH_TENANT_ID: "" }));
  assert.throws(() => readHosting({ WEB_HOST_MODE: "public" }));
});

test("Azure hosting checks Easy Auth principal on all management routes", async (t) => {
  const dependencies = await fixture();
  t.after(() => dependencies.close());
  const server = createApp({ settings: dependencies.settings, history: dependencies.history, hosting: readHosting(env) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  const encoded = (tid: string, oid: string, provider = "aad", tokenIssuer: string | undefined = issuer) => Buffer.from(JSON.stringify({
    auth_typ: provider, claims: [
      { typ: "http://schemas.microsoft.com/identity/claims/tenantid", val: tid },
      { typ: "http://schemas.microsoft.com/identity/claims/objectidentifier", val: oid },
      ...(tokenIssuer ? [{ typ: "iss", val: tokenIssuer }] : []),
    ],
  })).toString("base64");
  const send = (path: string, principal?: string, method = "GET", headers: Record<string, string> = {}, body?: string) =>
    new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${address.port}${path}`, {
        method, headers: { Host: new URL(origin).host,
          ...(principal === undefined ? {} : { "X-MS-CLIENT-PRINCIPAL": principal }), ...headers },
      }, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => { text += chunk.toString(); });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.once("error", reject);
      req.end(body);
    });
  assert.equal((await send("/healthz")).status, 200);
  assert.equal((await send("/api/schedule")).status, 401);
  assert.equal((await send("/api/schedule", encoded(tenant, tenant))).status, 403);
  assert.equal((await send("/api/schedule", encoded(tenant, user))).status, 503);
  for (const method of ["GET", "POST"]) {
    assert.equal((await send("/api/execution", undefined, method)).status, 401);
    assert.equal((await send("/api/execution", encoded(tenant, tenant), method)).status, 403);
    assert.equal((await send("/api/execution", encoded(tenant, user), method)).status, 503);
  }
  for (const path of ["/", "/api/settings", "/api/runs", "/api/hosting"]) {
    assert.equal((await send(path)).status, 401);
    assert.equal((await send(path, "not-json")).status, 401);
    assert.equal((await send(path, encoded(user, user))).status, 403);
    assert.equal((await send(path, encoded(tenant, tenant))).status, 403);
    assert.equal((await send(path, encoded(tenant, user, "github"))).status, 401);
    assert.equal((await send(path, encoded(tenant, user))).status, 200);
    assert.equal((await send(path, encoded(tenant, user, "Bearer"))).status, 200);
    assert.equal((await send(path, encoded(tenant, user, "Bearer", `https://sts.windows.net/${tenant}/`))).status, 200);
    assert.equal((await send(path, encoded(tenant, user, "Bearer", "https://untrusted.example"))).status, 403);
    assert.equal((await send(path, encoded(tenant, user, "Bearer", ""))).status, 403);
  }
  const current = await dependencies.settings.read();
  assert.equal((await send("/api/settings", encoded(tenant, user), "PUT", {
    Origin: origin, "Content-Type": "application/json", "If-Match": current.etag, "X-Archive-Request": "1",
  }, JSON.stringify(current.settings))).status, 200);
  assert.equal((await send("/api/settings", encoded(tenant, user), "PUT", {
    Origin: "https://evil.example", "Content-Type": "application/json",
  }, "{}")).status, 403);
  assert.equal((await send("/", encoded(tenant, user), "GET", { Host: "forged.example" })).status, 403);
});
