import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Pool } from "pg";
import { parseSettings } from "azure-files-archive-job/config";
import { SqlExecutionHistory, sqliteDatabase } from "azure-files-archive-job/history";
import { openHistoryReader } from "../src/history.js";

test("reads the job's unchanged SQLite schema, nullable metadata and every file outcome without writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "archive-web-history-"));
  const path = join(directory, "history.sqlite");
  const writer = new SqlExecutionHistory(sqliteDatabase(path));
  const rule = parseSettings(JSON.stringify({
    version: 1, rules: [{
      id: "archive", source: { account: "sourceacct", share: "source", path: "" },
      destination: { kind: "blob", account: "destacct", container: "archive", path: "" },
      olderThanDays: 90,
    }],
  })).rules[0]!;
  try {
    await writer.initialize();
    await writer.startRun("run'1");
    await writer.configureRun("run'1", { dryRun: true, ruleCount: 1, configurationEtag: "'etag" });
    for (const outcome of ["moved", "dry_run", "changed", "failed", "running"] as const) {
      const id = await writer.startFile("run'1", rule, {
        path: "日本語 'file.txt", relativePath: "日本語 'file.txt",
        version: "'version", size: 2 ** 32, lastWrite: new Date("2020-01-01T00:00:00Z"),
      }, outcome === "dry_run");
      if (outcome !== "running") {
        await writer.finishFile(id, outcome, outcome === "failed" ? { message: "copy failed" } : undefined);
      }
    }
    await writer.finishRun("run'1", "limit_reached", {
      scanned: 5, eligible: 5, moved: 1, dryRun: 1, changed: 1, failed: 1, limitReached: true,
    });
    await writer.startRun("before-config");
    await writer.finishRun("before-config", "failed", undefined, { message: "configuration failed" });
  } finally { await writer.close(); }

  let connection: DatabaseSync | undefined;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    connection = this;
    return prepare.call(this, sql);
  });
  const reader = await openHistoryReader({ AUTH_MODE: "azure-cli", SQLITE_PATH: path });
  try {
    const run = await reader.getRun("run'1");
    assert.equal(run?.status, "limit_reached");
    assert.equal(run.configuration?.configurationEtag, "'etag");
    assert.equal(run.summary?.limitReached, true);
    const failed = await reader.getRun("before-config");
    assert.equal(failed?.configuration, null);
    assert.equal(failed?.summary, null);
    assert.equal(failed?.error?.message, "configuration failed");
    const files = await reader.listFiles("run'1", { limit: 100, offset: 0 });
    assert.deepEqual(files.map((file) => file.status).sort(), ["changed", "dry_run", "failed", "moved", "running"]);
    assert.ok(files.every((file) => file.bytes === 2 ** 32 && file.sourceVersion === "'version"));
    assert.match(files[0]!.sourceUrl, /%E6%97%A5%E6%9C%AC%E8%AA%9E/);
    assert.equal(files.find((file) => file.status === "running")?.finishedAt, null);
    assert.equal(files.find((file) => file.status === "dry_run")?.dryRun, true);
    assert.equal(files.find((file) => file.status === "failed")?.error?.message, "copy failed");
    assert.deepEqual(await reader.totals("run'1"), { changed: 1, dry_run: 1, failed: 1, moved: 1, running: 1 });
    assert.equal(await reader.getRun("missing' OR 1=1 --"), null);
    assert.equal((await reader.listRuns({ limit: 1, offset: 1 })).length, 1);
    for (const page of [{ limit: 101, offset: 0 }, { limit: 25, offset: -1 }]) {
      await assert.rejects(reader.listFiles("run'1", page), /History page/);
    }
    assert.ok(connection);
    const sqlite = connection;
    assert.equal(sqlite.prepare("PRAGMA query_only").get()!.query_only, 1);
    assert.throws(() => sqlite.exec("DELETE FROM execution_runs"), /readonly|read-only/i);
    assert.equal((await reader.getRun("run'1"))?.status, "limit_reached");
  } finally {
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails explicitly for missing databases and incompatible schemas without creating or migrating them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archive-web-schema-"));
  const path = join(directory, "history.sqlite");
  const env = { AUTH_MODE: "azure-cli", SQLITE_PATH: path };
  try {
    await assert.rejects(openHistoryReader(env), /open database/i);
    await assert.rejects(stat(path), { code: "ENOENT" });
    const db = new DatabaseSync(path);
    db.close();
    await assert.rejects(openHistoryReader(env), /no such table/);
    const existing = new DatabaseSync(path);
    try { assert.deepEqual(existing.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), []); }
    finally { existing.close(); }
    await assert.rejects(openHistoryReader({ ...env, SQLITE_PATH: ":memory:" }), /persistent/);
    await assert.rejects(openHistoryReader({ ...env, HISTORY_SQLITE_PATH: "old.sqlite" }), /Legacy HISTORY_/);
    await assert.rejects(openHistoryReader({ ...env, DB_DRIVER: "none" }), /DB_DRIVER/);
    await assert.rejects(openHistoryReader({ DB_DRIVER: "sqlite" }), /only supported for local/);
    await assert.rejects(openHistoryReader({}), /PGHOST/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("PostgreSQL uses verified TLS and read-only sessions; schema and idle connection errors are not hidden", async (t) => {
  const queries: string[] = [];
  let pool: Pool | undefined;
  t.mock.method(Pool.prototype, "query", async function (this: Pool, sql: string) {
    pool = this;
    queries.push(sql);
    return { rows: [], rowCount: 0 };
  });
  t.mock.method(Pool.prototype, "end", async () => {});
  const reader = await openHistoryReader({
    AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000001",
    PGHOST: "history.postgres.database.azure.com", PGDATABASE: "executionlog", PGUSER: "web-mi",
  });
  assert.ok(pool);
  assert.equal(pool.options.database, "executionlog");
  assert.equal(pool.options.user, "web-mi");
  assert.equal(pool.options.options, "-c default_transaction_read_only=on");
  assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true, minVersion: "TLSv1.2" });
  assert.equal(typeof pool.options.password, "function");
  assert.ok(queries.every((query) => query.startsWith("SELECT ")));
  pool.emit("error", new Error("idle database disconnected"));
  await assert.rejects(reader.listRuns({ limit: 25, offset: 0 }), /idle database disconnected/);
  await assert.rejects(reader.close(), /idle database disconnected/);

  let closed = false;
  t.mock.method(Pool.prototype, "query", async () => { throw new Error("permission denied for execution_runs"); });
  t.mock.method(Pool.prototype, "end", async () => { closed = true; });
  await assert.rejects(openHistoryReader({
    AUTH_MODE: "azure-cli", DB_DRIVER: "postgres", PGHOST: "history.postgres.database.azure.com",
    PGDATABASE: "executionlog", PGUSER: "web-user",
  }), /permission denied/);
  assert.equal(closed, true);
});
