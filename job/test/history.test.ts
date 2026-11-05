import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "pg";
import { parseSettings } from "../src/config.js";
import { parseCommand, readHistory } from "../src/cli.js";
import { createExecution, execute } from "../src/execution.js";
import { emptySummary, type HistoryRepository, type FileRecord } from "../src/history.js";
import { openHistory } from "../src/history-config.js";
import { openSqliteHistory } from "../src/history-sqlite.js";
import type { FileInfo, RuleStorage } from "../src/model.js";

const now = new Date("2026-09-18T00:00:00Z");
const settings = parseSettings(JSON.stringify({
  version: 1, dryRun: true, maxFilesPerRun: 1, rules: [{
    id: "rule", source: { account: "sourceaccount", share: "source" },
    destination: { kind: "blob", account: "archiveaccount", container: "archive" }, olderThanDays: 90,
  }],
}));
const file: FileInfo = {
  path: "old.txt", relativePath: "old.txt", version: "original", size: 7,
  lastWrite: new Date("2020-01-01T00:00:00Z"),
};
const page = { limit: 50, offset: 0 };
const signal = () => new AbortController().signal;
const noop = () => {};

function storage(files: FileInfo[] = [file], failAt?: string) {
  const calls: string[] = [];
  const step = (name: string) => {
    calls.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
  };
  const store: RuleStorage = {
    async preflight() { step("preflight"); },
    async *list() { step("list"); yield* files; if (failAt === "scan") throw new Error("scan failed"); },
    async destinationExists() { step("exists"); return false; },
    async lock(info) {
      step("lock");
      return {
        info,
        async read(offset, count) { step("read"); return Buffer.from("content").subarray(offset, offset + count); },
        async assertUnchanged() { step("check"); },
        async delete() { step("delete"); },
        async release() { step("release"); },
      };
    },
    async createArchive() {
      step("create");
      return {
        async write() { step("write"); },
        async seal() { step("seal"); },
        async verify(size, hash) {
          step("verify");
          assert.equal(size, 7);
          assert.equal(hash, createHash("sha256").update("content").digest("hex"));
        },
        async publish() { step("publish"); },
        async assertProtected() { step("protected"); },
        async close() { step("close"); },
      };
    },
  };
  return { store, calls };
}

async function sqlite(work: (repo: HistoryRepository, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "archive-history-"));
  const path = join(dir, "history.sqlite");
  const repo = await openSqliteHistory(path);
  try { await work(repo, path); }
  finally {
    await repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function contract(repo: HistoryRepository, reopen: () => Promise<HistoryRepository>) {
  const original = await createExecution(repo, settings, { etag: "test" }, randomUUID(), now);
  const f = storage([file, { ...file, path: "second.txt" }]);
  const first = await execute(repo, original, () => f.store, noop, signal());
  assert.equal(first.dryRun, 1);
  assert.equal(first.limitReached, true);
  assert.equal((await repo.getRun(original.id)).status, "limited");
  const reader = await reopen();
  try {
    assert.equal((await reader.getRun(original.id)).settingsHash, original.settingsHash);
    const progress = await reader.progress(original.id);
    assert.equal(progress.totals.dryRun, 1);
    assert.equal(progress.latestAttempt!.summary.dryRun, 1);
    assert.equal((await readHistory(reader, parseCommand(["history", "list"]))) !== null, true);
  } finally { await reader.close(); }
  const resumed = await execute(repo, await repo.getRun(original.id), () => f.store, noop, signal());
  assert.equal(resumed.dryRun, 1);
  assert.equal(resumed.eligible, 1);
  assert.equal((await repo.progress(original.id)).totals.dryRun, 2);
  assert.equal((await repo.getRun(original.id)).status, "succeeded");
  assert.equal((await repo.listAttempts(original.id, page)).length, 2);
  assert.equal((await repo.progress(original.id)).latestAttempt!.ordinal, 2);
  assert.equal((await repo.progress(original.id)).latestAttempt!.skipped, 1);
  assert.equal((await repo.listFiles(original.id, { limit: 1, offset: 1 })).length, 1);
  assert.equal((await repo.listFiles(original.id, { limit: 1, offset: 2 })).length, 0);
  await assert.rejects(repo.beginAttempt(original.id, false), /successful/);
  await assert.rejects(repo.getRun(randomUUID()), /not found/);
  await assert.rejects(repo.listRuns({ limit: 1001, offset: 0 }), /Page/);
  await assert.rejects(repo.listFiles(original.id, { limit: 1, offset: -1 }), /Page/);

  const unfinished = await createExecution(repo, settings, {}, randomUUID(), now);
  const attempt = await repo.beginAttempt(unfinished.id, false);
  const writer = await reopen();
  try { await assert.rejects(writer.beginAttempt(unfinished.id, true), /alive|owned/); }
  finally { await writer.close(); }
  const started = await repo.startFile(attempt.id, "rule", file, emptySummary(), 0);
  await repo.updateFile({ ...started, phase: "copying", bytes: 3 }, emptySummary(), 0);
  const liveReader = await reopen();
  try {
    assert.equal((await liveReader.progress(unfinished.id)).activeFiles[0]!.bytes, 3);
  } finally { await liveReader.close(); }
  await repo.finishAttempt(attempt.id, "interrupted", emptySummary(), 0, { message: "stop" });
  assert.equal((await repo.listFiles(unfinished.id, page))[0]!.state, "needs_review");
  const next = await repo.beginAttempt(unfinished.id, false);
  assert.equal(await repo.shouldSkip(unfinished.id, "rule", { ...file, version: "new" }), true);
  await repo.finishAttempt(next.id, "succeeded", emptySummary(), 0, null);
  assert.equal((await repo.getRun(unfinished.id)).status, "completed_with_errors");
}

test("SQLite repository contract, durable reopening, paging, ownership and safe resume", async () => {
  await sqlite(async (repo, path) => contract(repo, () => openSqliteHistory(path)));
});

test("PostgreSQL repository shares the SQLite contract on an isolated schema", {
  skip: !process.env.HISTORY_TEST_POSTGRES_URL,
}, async () => {
  const url = new URL(process.env.HISTORY_TEST_POSTGRES_URL!);
  const ssl = process.env.HISTORY_TEST_POSTGRES_TLS === "disable" ? false : {
    rejectUnauthorized: true,
    ...(process.env.HISTORY_TEST_POSTGRES_CA_PATH
      ? { ca: await readFile(process.env.HISTORY_TEST_POSTGRES_CA_PATH, "utf8") } : {}),
  };
  const admin = new Client({ connectionString: url.toString(), ssl });
  const schema = `archive_test_${randomUUID().replaceAll("-", "")}`;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const open = () => openHistory({
      HISTORY_DB_PROVIDER: "postgres", HISTORY_POSTGRES_URL: url.toString(),
      HISTORY_POSTGRES_TLS: process.env.HISTORY_TEST_POSTGRES_TLS ?? "verify-full",
      ...(process.env.HISTORY_TEST_POSTGRES_CA_PATH
        ? { HISTORY_POSTGRES_CA_PATH: process.env.HISTORY_TEST_POSTGRES_CA_PATH } : {}),
    });
    const repo = await open();
    try {
      const columns = await admin.query(
        "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1",
        [schema]);
      assert.equal(columns.rows.length, 17);
      assert.deepEqual([...new Set(columns.rows.map((row) => row.table_name))].sort(),
        ["archive_attempts", "archive_files", "archive_runs", "archive_schema"]);
      for (const column of columns.rows) {
        assert.equal(column.data_type, ["ordinal", "version"].includes(column.column_name) ? "integer" : "text");
      }
      await contract(repo, open);
      const moveRun = await createExecution(repo, { ...settings, dryRun: false }, {}, randomUUID(), now);
      const moved = storage();
      const result = await execute(repo, moveRun, () => moved.store, noop, signal());
      assert.equal(result.moved, 1);
      assert.ok(moved.calls.includes("delete"));
      const reconnected = await open();
      try {
        assert.equal((await reconnected.getRun(moveRun.id)).status, "succeeded");
        const saved = (await reconnected.listFiles(moveRun.id, page))[0]!;
        assert.equal(saved.state, "moved");
        assert.equal(saved.bytes, file.size);
        assert.equal((await reconnected.progress(moveRun.id)).totals.moved, 1);
      } finally { await reconnected.close(); }
      const victimUrl = new URL(url);
      const applicationName = `${schema}_victim`;
      victimUrl.searchParams.set("application_name", applicationName);
      const victim = await openHistory({
        HISTORY_DB_PROVIDER: "postgres", HISTORY_POSTGRES_URL: victimUrl.toString(),
        HISTORY_POSTGRES_TLS: process.env.HISTORY_TEST_POSTGRES_TLS ?? "verify-full",
        ...(process.env.HISTORY_TEST_POSTGRES_CA_PATH
          ? { HISTORY_POSTGRES_CA_PATH: process.env.HISTORY_TEST_POSTGRES_CA_PATH } : {}),
      });
      const interrupted = await createExecution(victim, { ...settings, dryRun: false }, {}, randomUUID(), now);
      const f = storage();
      const create = f.store.createArchive.bind(f.store);
      f.store.createArchive = async (source) => {
        const archive = await create(source);
        const verify = archive.verify.bind(archive);
        archive.verify = async (size, hash) => {
          await verify(size, hash);
          await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
            [applicationName]);
        };
        return archive;
      };
      try {
        await assert.rejects(execute(victim, interrupted, () => f.store, noop, signal()));
        assert.ok(!f.calls.includes("publish"));
        assert.ok(!f.calls.includes("delete"));
        assert.ok(f.calls.includes("release"));
      } finally { await victim.close(); }
      await assert.rejects(repo.beginAttempt(interrupted.id, false), /--recover/);
      await execute(repo, await repo.getRun(interrupted.id), () => storage([]).store, noop, signal(), true);
      assert.equal((await repo.listFiles(interrupted.id, page))[0]!.state, "needs_review");
      assert.equal((await repo.getRun(interrupted.id)).status, "completed_with_errors");
    }
    finally { await repo.close(); }
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("move phases and bytes persist; errors in copy and cleanup require review", async () => {
  for (const failAt of [undefined, "verify", "close", "delete"]) {
    await sqlite(async (repo) => {
      const original = await createExecution(repo, { ...settings, dryRun: false }, {}, randomUUID(), now);
      const f = storage([file], failAt);
      const result = await execute(repo, original, () => f.store, noop, signal());
      const saved = (await repo.listFiles(original.id, page))[0]!;
      assert.equal(saved.state, failAt ? "needs_review" : "moved");
      assert.equal(saved.bytes, file.size);
      assert.equal(result.failed, failAt ? 1 : 0);
      assert.ok(f.calls.includes("release"));
      if (failAt === "verify") assert.ok(!f.calls.includes("delete"));
    });
  }
});

test("DB failure before file start prevents all move side effects", async () => {
  await sqlite(async (repo) => {
    const original = await createExecution(repo, { ...settings, dryRun: false }, {}, randomUUID(), now);
    repo.startFile = async () => { throw new Error("disk full"); };
    const f = storage();
    await assert.rejects(execute(repo, original, () => f.store, noop, signal()), /persistence/);
    assert.deepEqual(f.calls, ["preflight", "list"]);
    assert.equal((await repo.getRun(original.id)).status, "failed");
  });
});

test("DB failure during a move stops deletion and subsequent files but releases leases", async () => {
  await sqlite(async (repo) => {
    const original = await createExecution(repo, { ...settings, dryRun: false, maxFilesPerRun: 10 }, {}, randomUUID(), now);
    const update = repo.updateFile.bind(repo);
    repo.updateFile = async (record, summary, skipped) => {
      if (record.phase === "deleting") throw new Error("database unavailable");
      await update(record, summary, skipped);
    };
    const f = storage([file, { ...file, path: "second.txt" }]);
    await assert.rejects(execute(repo, original, () => f.store, noop, signal()), /Move or lease/);
    assert.ok(!f.calls.includes("delete"));
    assert.equal(f.calls.filter((call) => call === "lock").length, 1);
    assert.ok(f.calls.includes("close"));
    assert.ok(f.calls.includes("release"));
    assert.equal((await repo.listFiles(original.id, page))[0]!.state, "needs_review");
    const last = (await repo.listAttempts(original.id, page))[0]!;
    assert.match(JSON.stringify(last.error), /database unavailable/);
  });
});

test("failed final result persistence never guesses success after source deletion", async () => {
  await sqlite(async (repo) => {
    const original = await createExecution(repo, { ...settings, dryRun: false }, {}, randomUUID(), now);
    const update = repo.updateFile.bind(repo);
    repo.updateFile = async (record, summary, skipped) => {
      if (record.state === "moved") throw new Error("final write failed");
      await update(record, summary, skipped);
    };
    const f = storage();
    await assert.rejects(execute(repo, original, () => f.store, noop, signal()), /persistence/);
    assert.ok(f.calls.includes("delete"));
    assert.equal((await repo.listAttempts(original.id, page))[0]!.summary.moved, 0);
    const next = storage([]);
    await execute(repo, await repo.getRun(original.id), () => next.store, noop, signal());
    assert.equal((await repo.listFiles(original.id, page))[0]!.state, "needs_review");
    assert.equal((await repo.getRun(original.id)).status, "completed_with_errors");
  });
});

test("preflight and scan failures finalize history; pre-aborted run is interrupted", async () => {
  for (const failAt of ["preflight", "scan", "aborted"]) {
    await sqlite(async (repo) => {
      const original = await createExecution(repo, settings, {}, randomUUID(), now);
      const f = storage([], failAt);
      await assert.rejects(execute(repo, original, () => f.store, noop,
        failAt === "aborted" ? AbortSignal.abort(new Error("stop")) : signal()));
      assert.equal((await repo.getRun(original.id)).status, failAt === "aborted" ? "interrupted" : "failed");
      assert.ok(!f.calls.includes("delete"));
    });
  }
});

test("resume retains the reference time and does not repeat failed candidates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() + 365 * 86400000 });
  await sqlite(async (repo) => {
    const original = await createExecution(repo, { ...settings, maxFilesPerRun: 10 }, {}, randomUUID(), now);
    const f = storage([file], "exists");
    const first = await execute(repo, original, () => f.store, noop, signal());
    assert.equal(first.failed, 1);
    const recent: FileInfo = { ...file, path: "recent.txt", lastWrite: new Date(now.getTime() - 89 * 86400000) };
    const resumed = storage([file, recent]);
    const result = await execute(repo, await repo.getRun(original.id), () => resumed.store, noop, signal());
    assert.equal(result.eligible, 0);
    assert.deepEqual(resumed.calls, ["preflight", "list"]);
    assert.equal((await repo.getRun(original.id)).status, "completed_with_errors");
    const changedSettings = { ...original, settings: { ...settings, dryRun: false } };
    await assert.rejects(execute(repo, changedSettings, () => resumed.store, noop, signal()), /invalid/);
  });
});

test("crashed process requires explicit recovery, including files absent from the source", async () => {
  await sqlite(async (repo, path) => {
    const original = await createExecution(repo, settings, {}, randomUUID(), now);
    const moduleUrl = new URL("../src/history-sqlite.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { openSqliteHistory } from ${JSON.stringify(moduleUrl)};
      const repo = await openSqliteHistory(process.env.TEST_DB_PATH);
      const attempt = await repo.beginAttempt(process.env.TEST_RUN_ID, false);
      const file = ${JSON.stringify(file)};
      file.lastWrite = new Date(file.lastWrite);
      await repo.startFile(attempt.id, "rule", file, attempt.summary, 0);
      await repo.close();
    `], { env: { ...process.env, TEST_DB_PATH: path, TEST_RUN_ID: original.id }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    await assert.rejects(repo.beginAttempt(original.id, false), /--recover/);
    await execute(repo, await repo.getRun(original.id), () => storage([]).store, noop, signal(), true);
    assert.equal((await repo.listFiles(original.id, page))[0]!.state, "needs_review");
    assert.equal((await repo.getRun(original.id)).status, "completed_with_errors");
    assert.equal((await repo.listAttempts(original.id, page)).length, 2);
  });
});

test("unknown schema is rejected without modifying its version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "archive-schema-"));
  const path = join(dir, "history.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE archive_schema(version INTEGER NOT NULL); INSERT INTO archive_schema VALUES (99)");
    db.close();
    await assert.rejects(openSqliteHistory(path), /Unsupported/);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("SELECT version FROM archive_schema").get()!.version, 99);
    check.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI validates arguments and history works without any Azure configuration", async () => {
  assert.deepEqual(parseCommand([]), { kind: "run" });
  assert.deepEqual(parseCommand(["history", "list", "--limit", "3", "--offset", "2"]),
    { kind: "list", page: { limit: 3, offset: 2 } });
  for (const args of [
    ["history"], ["resume"], ["resume", "invalid"], ["history", "show"],
    ["history", "list", "--limit", "0"], ["history", "list", "--offset", "-1"],
    ["history", "list", "--limit", "2", "--limit", "3"], ["history", "list", "--limit"],
    ["history", "progress", randomUUID(), "--limit", "2"],
  ]) assert.throws(() => parseCommand(args), /Usage/);
  await sqlite(async (repo, path) => {
    const record = await createExecution(repo, settings, {}, randomUUID(), now);
    const index = fileURLToPath(new URL("../src/index.js", import.meta.url));
    const env = {
      ...process.env, APP_CONFIG_ENDPOINT: "", AZURE_CLIENT_ID: "", HISTORY_DB_PROVIDER: "sqlite",
      HISTORY_SQLITE_PATH: path,
    };
    for (const action of ["list", "show", "progress"]) {
      const args = ["history", action, ...(action === "list" ? [] : [record.id])];
      const result = spawnSync(process.execPath, [index, ...args], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(JSON.parse(result.stdout));
    }
    const invalid = spawnSync(process.execPath, [index, "history", "show", randomUUID()],
      { env, encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout, /Run not found/);
  });
});

test("history configuration rejects unknown provider, unsafe paths and ambiguous TLS", async () => {
  await assert.rejects(openHistory({ HISTORY_DB_PROVIDER: "other" }), /PROVIDER/);
  await assert.rejects(openSqliteHistory(":memory:"), /local file/);
  await assert.rejects(openSqliteHistory("\\\\server\\share\\history.sqlite"), /network share/);
  await assert.rejects(openHistory({ HISTORY_DB_PROVIDER: "postgres" }), /URL/);
  await assert.rejects(openHistory({ HISTORY_DB_PROVIDER: "postgres", HISTORY_POSTGRES_URL: "bad" }), /Invalid/);
  await assert.rejects(openHistory({
    HISTORY_DB_PROVIDER: "postgres", HISTORY_POSTGRES_URL: "postgres://localhost/test?sslmode=no-verify",
  }), /TLS/);
});

test("interruption during copying is durable and releases leases", async () => {
  await sqlite(async (repo) => {
    const record = await createExecution(repo, { ...settings, dryRun: false }, {}, randomUUID(), now);
    const controller = new AbortController();
    const update = repo.updateFile.bind(repo);
    repo.updateFile = async (progress: FileRecord, summary, skipped) => {
      await update(progress, summary, skipped);
      if (progress.phase === "copying" && progress.bytes > 0) controller.abort(new Error("Job interrupted"));
    };
    const f = storage();
    await assert.rejects(execute(repo, record, () => f.store, noop, controller.signal));
    assert.equal((await repo.getRun(record.id)).status, "interrupted");
    assert.equal((await repo.listFiles(record.id, page))[0]!.state, "needs_review");
    assert.ok(f.calls.includes("close"));
    assert.ok(f.calls.includes("release"));
    assert.ok(!f.calls.includes("delete"));
  });
});
