import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Pool } from "pg";
import { parseSettings } from "../src/config.js";
import { openHistory, SqlExecutionHistory, sqliteDatabase } from "../src/history.js";
import type { Summary } from "../src/model.js";

const rule = parseSettings(JSON.stringify({
  version: 1, rules: [{
    id: "archive", source: { account: "sourceacct", share: "source", path: "old" },
    destination: { kind: "blob", account: "destacct", container: "archive", path: "saved" },
    olderThanDays: 90,
  }],
})).rules[0]!;
const file = {
  path: "old/日本語 'file.txt", relativePath: "日本語 'file.txt",
  size: 2 ** 32, version: "version'1", lastWrite: new Date("2020-01-01T00:00:00Z"),
};
const summary: Summary = {
  scanned: 1, eligible: 1, moved: 1, dryRun: 0, changed: 0, failed: 0, limitReached: false,
};

async function exercise(history: SqlExecutionHistory): Promise<void> {
  await history.initialize();
  await history.initialize();
  await history.startRun("run'1");
  await history.configureRun("run'1", { configurationEtag: "'etag", dryRun: false });
  const first = await history.startFile("run'1", rule, file, false);
  await history.finishFile(first, "moved");
  for (const status of ["dry_run", "changed", "failed"] as const) {
    const id = await history.startFile("run'1",
      { ...rule, destination: { kind: "files", account: "destacct", share: "archive", path: "" } },
      file, status === "dry_run");
    await history.finishFile(id, status, status === "failed" ? { message: "copy 'failed" } : undefined);
  }
  await history.startFile("run'1", rule, file, false);
  await history.finishRun("run'1", "succeeded", summary);
  await history.startRun("fatal");
  await history.finishRun("fatal", "failed", undefined, { message: "configuration failed" });
  await history.startRun("limited");
  await history.finishRun("limited", "limit_reached", { ...summary, limitReached: true });
  await history.startRun("interrupted");
}

test("SQLite retains runs, file outcomes and incomplete attempts after closing and reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archive-history-"));
  const path = join(directory, "history.sqlite");
  try {
    const history = new SqlExecutionHistory(sqliteDatabase(path));
    try { await exercise(history); } finally { await history.close(); }
    const db = new DatabaseSync(path);
    try {
      const run = db.prepare("SELECT * FROM execution_runs WHERE run_id = ?").get("run'1")!;
      assert.equal(run.status, "succeeded");
      assert.deepEqual(JSON.parse(String(run.summary_json)), summary);
      assert.equal(JSON.parse(String(run.configuration_json)).configurationEtag, "'etag");
      assert.ok(run.finished_at);
      const files = db.prepare("SELECT * FROM file_executions WHERE run_id = ? ORDER BY rowid").all("run'1");
      assert.deepEqual(files.map((item) => item.status), ["moved", "dry_run", "changed", "failed", "running"]);
      assert.equal(files[0]!.bytes, 2 ** 32);
      assert.equal(files[0]!.source_version, "version'1");
      assert.equal(files[0]!.source_url, "https://sourceacct.file.core.windows.net/source/old/%E6%97%A5%E6%9C%AC%E8%AA%9E%20'file.txt");
      assert.equal(files[0]!.destination_url, "https://destacct.blob.core.windows.net/archive/saved/%E6%97%A5%E6%9C%AC%E8%AA%9E%20'file.txt");
      assert.equal(files[1]!.dry_run, 1);
      assert.equal(JSON.parse(String(files[3]!.error_json)).message, "copy 'failed");
      assert.equal(files[4]!.finished_at, null);
      assert.equal(db.prepare("SELECT status FROM execution_runs WHERE run_id = 'interrupted'").get()!.status, "running");
      assert.equal(db.prepare("SELECT status FROM execution_runs WHERE run_id = 'fatal'").get()!.status, "failed");
      assert.equal(db.prepare("SELECT status FROM execution_runs WHERE run_id = 'limited'").get()!.status, "limit_reached");
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true }); }
});

test("history configuration fails closed and local mode selects persistent SQLite", async () => {
  const credential = { async getToken() { throw new Error("Credentials should not be requested"); } };
  await assert.rejects(openHistory({}, credential, "managed-identity"), /PGHOST/);
  await assert.rejects(openHistory({ DB_DRIVER: "sqlite" }, credential, "managed-identity"), /only supported for local/);
  await assert.rejects(openHistory({ DB_DRIVER: "none" }, credential, "azure-cli"), /DB_DRIVER/);
  assert.throws(() => sqliteDatabase(":memory:"), /persistent/);
  assert.throws(() => sqliteDatabase("file:memory"), /persistent/);
  const directory = await mkdtemp(join(tmpdir(), "archive-local-"));
  try {
    const history = await openHistory({ SQLITE_PATH: join(directory, "local.sqlite") }, credential, "azure-cli");
    await history.startRun("local");
    await history.close();
  } finally { await rm(directory, { recursive: true }); }
});

test("PostgreSQL uses verified TLS and refreshable Entra tokens; idle errors stop subsequent writes", async (t) => {
  let pool: Pool | undefined;
  const queries: string[] = [];
  t.mock.method(Pool.prototype, "query", async function (this: Pool, sql: string) {
    pool = this;
    queries.push(sql);
    return { rows: [], rowCount: 0 };
  });
  t.mock.method(Pool.prototype, "end", async () => {});
  const scopes: string[] = [];
  const credential = {
    async getToken(scope: string | string[]) {
      scopes.push(String(scope));
      return { token: `token-${scopes.length}`, expiresOnTimestamp: Date.now() + 3600000 };
    },
  };
  const history = await openHistory({
    PGHOST: "history.postgres.database.azure.com", PGDATABASE: "executionlog", PGUSER: "job-mi",
  }, credential, "managed-identity");
  try {
    assert.ok(pool);
    assert.equal(pool.options.host, "history.postgres.database.azure.com");
    assert.equal(pool.options.user, "job-mi");
    assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true, minVersion: "TLSv1.2" });
    const password = pool.options.password;
    assert.equal(typeof password, "function");
    if (typeof password !== "function") throw new Error("Missing token callback");
    assert.equal(await password(), "token-1");
    assert.equal(await password(), "token-2");
    assert.deepEqual(scopes, Array(2).fill("https://ossrdbms-aad.database.windows.net/.default"));
    pool.emit("error", new Error("idle database disconnected"));
    const count = queries.length;
    await assert.rejects(history.startRun("no-fallback"), /idle database disconnected/);
    assert.equal(queries.length, count);
  } finally { await assert.rejects(history.close(), /idle database disconnected/); }
});

test("PostgreSQL executes the same schema and lifecycle with parameterized values", {
  skip: !process.env.TEST_POSTGRES_URL,
}, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URL! });
  const history = new SqlExecutionHistory({
    async execute(sql, values) { await pool.query(sql, values); },
    async close() { await pool.end(); },
  });
  try {
    await exercise(history);
    const runs = await pool.query("SELECT * FROM execution_runs WHERE run_id = $1", ["run'1"]);
    assert.equal(runs.rows[0].status, "succeeded");
    assert.deepEqual(JSON.parse(runs.rows[0].summary_json), summary);
    const files = await pool.query("SELECT status, bytes FROM file_executions WHERE run_id = $1", ["run'1"]);
    assert.equal(files.rowCount, 5);
    assert.deepEqual(files.rows.map((row: { status: string }) => row.status).sort(),
      ["changed", "dry_run", "failed", "moved", "running"]);
    assert.equal(Number(files.rows[0].bytes), 2 ** 32);
  } finally { await history.close(); }
});
