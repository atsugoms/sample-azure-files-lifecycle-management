import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseSettings } from "../src/config.js";
import { BLOCK_SIZE, MAX_FILE_SIZE, isOldEnough, moveFile, run } from "../src/engine.js";
import type { ArchiveWriter, FileInfo, LockedFile, RuleStorage } from "../src/model.js";

const now = new Date("2026-09-18T00:00:00Z");
const cutoff = now.getTime() - 90 * 86400000;
const sourceFile: FileInfo = {
  path: "old/file.txt", relativePath: "file.txt", size: 7,
  lastWrite: new Date(cutoff - 1), version: "original",
};
const settings = parseSettings(JSON.stringify({
  version: 1, dryRun: false, rules: [{
    id: "rule", source: { account: "sourceaccount", share: "source", path: "old" },
    destination: { kind: "blob", account: "archiveaccount", container: "archive" },
    olderThanDays: 90,
  }],
}));

function fake(options: {
  failAt?: string; exists?: boolean; locked?: FileInfo; files?: FileInfo[]; data?: Buffer;
} = {}) {
  const calls: string[] = [];
  const data = options.data ?? Buffer.from("content");
  const written: Buffer[] = [];
  const step = (name: string) => {
    calls.push(name);
    if (options.failAt === name) throw new Error(`${name} failed`);
  };
  const locked: LockedFile = {
    info: options.locked ?? sourceFile,
    async read(offset, count) { step("read"); return data.subarray(offset, offset + count); },
    async assertUnchanged() { step("source-check"); },
    async delete() { step("delete"); },
    async release() { step("release-source"); },
  };
  const archive: ArchiveWriter = {
    async write(buffer) { step("write"); written.push(buffer); },
    async seal() { step("seal"); },
    async verify(size, hash) {
      step("verify");
      const output = Buffer.concat(written);
      assert.equal(output.length, size);
      assert.equal(createHash("sha256").update(output).digest("hex"), hash);
    },
    async publish() { step("publish"); },
    async assertProtected() { step("archive-check"); },
    async close() { step("close-archive"); },
  };
  const storage: RuleStorage = {
    async preflight() { step("preflight"); },
    async *list() { yield* options.files ?? [sourceFile]; },
    async lock() { step("lock"); return locked; },
    async destinationExists() { step("exists"); return options.exists ?? false; },
    async createArchive() { step("create"); return archive; },
  };
  return { calls, storage, written };
}

test("strict UTC inactivity cutoff and invalid properties", () => {
  assert.equal(isOldEnough(sourceFile, cutoff), true);
  assert.equal(isOldEnough({ ...sourceFile, lastWrite: new Date(cutoff) }, cutoff), false);
  assert.equal(isOldEnough({ ...sourceFile, lastWrite: now }, cutoff), false);
  assert.throws(() => isOldEnough({ ...sourceFile, lastWrite: new Date("invalid") }, cutoff));
  assert.throws(() => isOldEnough({ ...sourceFile, size: -1 }, cutoff));
});

test("verified and protected copy precedes source deletion", async () => {
  const f = fake();
  assert.equal(await moveFile(f.storage, sourceFile, cutoff, new AbortController().signal), "moved");
  assert.deepEqual(f.calls, [
    "lock", "exists", "create", "read", "write", "seal", "verify", "source-check",
    "publish", "archive-check", "source-check", "delete", "close-archive", "release-source",
  ]);
});

test("zero-byte and multi-block files are verified without whole-file buffering", async () => {
  for (const size of [0, BLOCK_SIZE + 7]) {
    const file = { ...sourceFile, size };
    const f = fake({ data: Buffer.alloc(size, 19), locked: file });
    assert.equal(await moveFile(f.storage, file, cutoff, new AbortController().signal), "moved");
    assert.equal(f.written.length, Math.ceil(size / BLOCK_SIZE));
    assert.ok(f.written.every((block) => block.length <= BLOCK_SIZE));
  }
});

test("every copy/verify/publish/lease error preserves source and releases leases", async () => {
  for (const failAt of ["create", "read", "write", "seal", "verify", "source-check", "publish", "archive-check"]) {
    const f = fake({ failAt });
    await assert.rejects(moveFile(f.storage, sourceFile, cutoff, new AbortController().signal));
    assert.ok(!f.calls.includes("delete"), failAt);
    assert.equal(f.calls.at(-1), "release-source", failAt);
    if (failAt !== "create") assert.ok(f.calls.includes("close-archive"), failAt);
  }
});

test("existing destination and files changed since enumeration never get overwritten/deleted", async () => {
  const collision = fake({ exists: true });
  await assert.rejects(moveFile(collision.storage, sourceFile, cutoff, new AbortController().signal));
  assert.ok(!collision.calls.includes("create"));
  for (const locked of [
    { ...sourceFile, version: "changed" },
    { ...sourceFile, lastWrite: now },
  ]) {
    const f = fake({ locked });
    assert.equal(await moveFile(f.storage, sourceFile, cutoff, new AbortController().signal), "changed");
    assert.deepEqual(f.calls, ["lock", "release-source"]);
  }
});

test("short download and cancellation do not delete source", async () => {
  const short = fake({ data: Buffer.from("bad") });
  await assert.rejects(moveFile(short.storage, sourceFile, cutoff, new AbortController().signal));
  assert.ok(!short.calls.includes("delete"));
  const controller = new AbortController();
  const f = fake();
  const original = f.storage.createArchive;
  f.storage.createArchive = async (file) => {
    const archive = await original(file);
    controller.abort(new Error("stop"));
    return archive;
  };
  await assert.rejects(moveFile(f.storage, sourceFile, cutoff, controller.signal));
  assert.ok(!f.calls.includes("delete"));
  assert.ok(f.calls.includes("release-source"));
});

test("cleanup failures are not reported as success", async () => {
  for (const failAt of ["delete", "close-archive", "release-source"]) {
    const f = fake({ failAt });
    await assert.rejects(moveFile(f.storage, sourceFile, cutoff, new AbortController().signal));
    assert.equal(f.calls.at(-1), "release-source");
  }
});

test("dry run reads only; recent files are excluded", async () => {
  const f = fake({ files: [sourceFile, { ...sourceFile, lastWrite: now }] });
  const result = await run({ ...settings, dryRun: true }, () => f.storage, () => {}, new AbortController().signal, now);
  assert.equal(result.dryRun, 1);
  assert.equal(result.scanned, 2);
  assert.equal(result.moved, 0);
  assert.deepEqual(f.calls, ["preflight", "exists"]);
});

test("failed files consume limit, continue to next file, and produce error summary", async () => {
  const files = [sourceFile, sourceFile, sourceFile];
  const f = fake({ files, exists: true });
  const result = await run(
    { ...settings, maxFilesPerRun: 2 }, () => f.storage, () => {}, new AbortController().signal, now,
  );
  assert.equal(result.failed, 2);
  assert.equal(result.limitReached, true);
  assert.equal(result.moved, 0);
  assert.ok(!f.calls.includes("lock"));
});

test("preflight failure stops before moving; oversized file is explicitly failed", async () => {
  const f = fake({ failAt: "preflight" });
  await assert.rejects(run(settings, () => f.storage, () => {}, new AbortController().signal, now));
  assert.deepEqual(f.calls, ["preflight"]);
  const large = fake({ files: [{ ...sourceFile, size: MAX_FILE_SIZE + 1 }] });
  const result = await run(settings, () => large.storage, () => {}, new AbortController().signal, now);
  assert.equal(result.failed, 1);
  assert.ok(!large.calls.includes("lock"));
});

test("all configured destinations are preflighted before the first move", async () => {
  const first = fake();
  const second = fake({ failAt: "preflight" });
  const firstRule = settings.rules[0]!;
  const expanded = {
    ...settings,
    rules: [
      firstRule,
      { ...firstRule, id: "second", source: { ...firstRule.source, share: "other" } },
    ],
  };
  await assert.rejects(run(
    expanded, (rule) => rule.id === "second" ? second.storage : first.storage,
    () => {}, new AbortController().signal, now,
  ));
  assert.deepEqual(first.calls, ["preflight"]);
  assert.deepEqual(second.calls, ["preflight"]);
});

test("pre-aborted executions do not touch storage", async () => {
  const f = fake();
  const signal = AbortSignal.abort(new Error("cancelled"));
  await assert.rejects(run(settings, () => f.storage, () => {}, signal, now));
  await assert.rejects(moveFile(f.storage, sourceFile, cutoff, signal));
  assert.deepEqual(f.calls, []);
});
