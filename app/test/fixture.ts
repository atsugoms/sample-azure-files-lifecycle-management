import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseSettings } from "azure-files-archive-job/config";
import { SqlExecutionHistory, sqliteDatabase } from "azure-files-archive-job/history";
import { openHistoryReader } from "../src/history.js";
import { createApp } from "../src/server.js";
import type { SettingsDocument, SettingsStore } from "../src/settings.js";
import type { ScheduleStore } from "../src/schedule.js";
import type { ExecutionStore } from "../src/execution.js";

export async function fixture(schedules?: ScheduleStore, executions?: ExecutionStore) {
  const directory = await mkdtemp(join(tmpdir(), "archive-web-"));
  const path = join(directory, "history.sqlite");
  const writer = new SqlExecutionHistory(sqliteDatabase(path));
  await writer.initialize();
  let current: SettingsDocument = {
    settings: parseSettings(JSON.stringify({
      version: 1, dryRun: true, maxFilesPerRun: 1000, rules: [{
        id: "documents-to-blob", olderThanDays: 90,
        source: { account: "sourcestorage", share: "documents", path: "completed" },
        destination: { kind: "blob", account: "archivestorage", container: "archive", path: "documents", tier: "Cool" },
      }],
    })),
    etag: "revision-1", source: { key: "archive:settings", label: "test" },
  };
  let revision = 1;
  const settings: SettingsStore = {
    async read() { return structuredClone(current); },
    async write(value, etag) {
      if (etag !== current.etag) throw Object.assign(new Error("ETag mismatch"), { statusCode: 412 });
      revision += 1;
      current = { ...current, settings: value, etag: `revision-${revision}` };
      return structuredClone(current);
    },
  };
  for (let index = 0; index < 26; index += 1) {
    const id = `run-${String(index).padStart(2, "0")}`;
    await writer.startRun(id);
    await writer.configureRun(id, { dryRun: true, ruleCount: 1, configurationEtag: "revision-1" });
    const file = await writer.startFile(id, current.settings.rules[0]!, {
      path: "completed/quarterly-report.pdf", relativePath: "quarterly-report.pdf",
      version: "v1", size: 8192, lastWrite: new Date("2020-01-01T00:00:00Z"),
    }, true);
    await writer.finishFile(file, "dry_run");
    await writer.finishRun(id, "succeeded", {
      scanned: 1, eligible: 1, dryRun: 1, moved: 0, changed: 0, failed: 0, limitReached: false,
    });
  }
  await writer.close();
  const db = new DatabaseSync(path);
  try {
    for (let index = 0; index < 26; index += 1) {
      db.prepare("UPDATE execution_runs SET started_at = ? WHERE run_id = ?")
        .run(new Date(Date.UTC(2026, 9, index + 1, 18)).toISOString(), `run-${String(index).padStart(2, "0")}`);
    }
  } finally { db.close(); }
  const history = await openHistoryReader({ AUTH_MODE: "azure-cli", SQLITE_PATH: path });
  const errors: unknown[] = [];
  const server = createApp({ settings, history, schedules, executions, log: (error) => { errors.push(error); } });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return {
    url: `http://127.0.0.1:${address.port}`, server, history, settings, errors, directory,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
        server.closeAllConnections();
      });
      await history.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
