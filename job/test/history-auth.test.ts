import assert from "node:assert/strict";
import { test } from "node:test";
import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";
import { createCredential, type TokenProvider } from "../src/auth.js";
import { buildPostgresOptions, POSTGRES_TOKEN_SCOPE } from "../src/history-config.js";

const entra: NodeJS.ProcessEnv = {
  HISTORY_POSTGRES_AUTH_MODE: "entra",
  HISTORY_POSTGRES_HOST: "archive-pg.postgres.database.azure.com",
  HISTORY_POSTGRES_DATABASE: "archive_history",
  HISTORY_POSTGRES_USER: "archive_job",
  HISTORY_POSTGRES_SCHEMA: "archive",
};

test("Entra configuration obtains a fresh token only when opening a connection", async () => {
  const calls: unknown[] = [];
  const provider: TokenProvider = {
    async getToken(scope) {
      calls.push(scope);
      return { token: `test-token-${calls.length}`, expiresOnTimestamp: Date.now() + 60000 };
    },
  };
  const options = await buildPostgresOptions(entra, provider);
  assert.ok("host" in options);
  assert.equal(options.host, entra.HISTORY_POSTGRES_HOST);
  assert.equal(options.database, "archive_history");
  assert.equal(options.user, "archive_job");
  assert.equal(options.port, 5432);
  assert.equal(options.options, "-c search_path=archive");
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.deepEqual(calls, []);
  assert.equal(await options.password(), "test-token-1");
  assert.equal(await options.password(), "test-token-2");
  assert.deepEqual(calls, [POSTGRES_TOKEN_SCOPE, POSTGRES_TOKEN_SCOPE]);
  assert.ok(!JSON.stringify(options).includes("test-token"));
});

test("missing and expired Entra tokens fail explicitly", async () => {
  for (const token of [null, { token: "", expiresOnTimestamp: Date.now() + 60000 },
    { token: "expired", expiresOnTimestamp: Date.now() - 1 }]) {
    const options = await buildPostgresOptions(entra, { async getToken() { return token; } });
    assert.ok("password" in options);
    await assert.rejects(options.password(), /valid PostgreSQL Entra token/);
  }
  const options = await buildPostgresOptions(entra, { async getToken() { throw new Error("identity unavailable"); } });
  assert.ok("password" in options);
  await assert.rejects(options.password(), /identity unavailable/);
});

test("Entra settings reject insecure TLS, ambiguous credentials, invalid schema and missing fields", async () => {
  const provider: TokenProvider = { async getToken() { throw new Error("must not request a token"); } };
  const invalid = [
    { HISTORY_POSTGRES_TLS: "disable" },
    { HISTORY_POSTGRES_URL: "postgres://localhost/history" },
    { HISTORY_POSTGRES_HOST: "localhost" },
    { HISTORY_POSTGRES_HOST: "" },
    { HISTORY_POSTGRES_DATABASE: "" },
    { HISTORY_POSTGRES_USER: "" },
    { HISTORY_POSTGRES_SCHEMA: "archive; DROP SCHEMA public" },
    { HISTORY_POSTGRES_AUTH_MODE: "unknown" },
  ];
  for (const values of invalid) {
    await assert.rejects(buildPostgresOptions({ ...entra, ...values }, provider));
  }
});

test("password URL configuration remains available without Azure credentials", async () => {
  const options = await buildPostgresOptions({
    HISTORY_POSTGRES_URL: "postgres://localhost/history", HISTORY_POSTGRES_TLS: "disable",
    HISTORY_POSTGRES_SCHEMA: "archive",
  });
  assert.ok("connectionString" in options);
  assert.equal(options.connectionString, "postgres://localhost/history");
  assert.equal(options.ssl, false);
  assert.equal(options.options, "-c search_path=archive");
  await assert.rejects(buildPostgresOptions({
    HISTORY_POSTGRES_URL: "postgres://localhost/history?options=-csearch_path=other",
    HISTORY_POSTGRES_SCHEMA: "archive",
  }), /not both/);
});

test("Azure credential selection remains explicit, without fallback", () => {
  assert.ok(createCredential({ AUTH_MODE: "azure-cli" }) instanceof AzureCliCredential);
  assert.ok(createCredential({
    AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
  }) instanceof ManagedIdentityCredential);
  assert.throws(() => createCredential({}), /AZURE_CLIENT_ID/);
  assert.throws(() => createCredential({ AUTH_MODE: "default" }), /AUTH_MODE/);
});
