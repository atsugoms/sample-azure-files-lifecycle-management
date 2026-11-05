import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { FileInfo, Summary } from "./model.js";
import { emptySummary, HistoryError, validatePage, type AttemptRecord, type ErrorDetails,
  type FileRecord, type FileState, type HistoryRepository, type Page, type Progress,
  type RunRecord, type RunStatus } from "./history.js";

export interface Row { [key: string]: string | number | boolean | null }
export interface HistoryDriver {
  query(sql: string, values?: (string | number | null)[]): Promise<Row[]>;
  transaction<T>(work: () => Promise<T>): Promise<T>;
  lock(runId: string): Promise<void>;
  unlock(runId: string): Promise<void>;
  canRecover(owner: AttemptRecord["owner"]): boolean;
  close(): Promise<void>;
}

// SQL and serialization stay behind the repository; both backends use this contract.
export class SqlHistoryRepository implements HistoryRepository {
  private active: AttemptRecord | undefined;
  constructor(private readonly db: HistoryDriver) {}

  async initialize(): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.query("CREATE TABLE IF NOT EXISTS archive_schema (version INTEGER NOT NULL)");
      const versions = await this.db.query("SELECT version FROM archive_schema");
      if (versions.length && (versions.length !== 1 || versions[0]!.version !== 1)) {
        throw new HistoryError("Unsupported history schema version");
      }
      if (versions.length) return;
      await this.db.query(`CREATE TABLE archive_runs (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)`);
      await this.db.query(`CREATE TABLE archive_attempts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES archive_runs(id),
        ordinal INTEGER NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE (run_id, ordinal))`);
      await this.db.query(`CREATE TABLE archive_files (
        key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES archive_runs(id),
        attempt_id TEXT NOT NULL REFERENCES archive_attempts(id), path_key TEXT NOT NULL,
        state TEXT NOT NULL, data TEXT NOT NULL)`);
      await this.db.query("CREATE INDEX archive_file_run ON archive_files(run_id, key)");
      await this.db.query("CREATE INDEX archive_file_path ON archive_files(run_id, path_key, state)");
      await this.db.query("CREATE INDEX archive_file_state ON archive_files(run_id, state)");
      await this.db.query("INSERT INTO archive_schema(version) VALUES (1)");
    });
  }

  async createRun(record: RunRecord): Promise<void> {
    await this.db.query("INSERT INTO archive_runs(id, created_at, status, data) VALUES (?, ?, ?, ?)",
      [record.id, record.createdAt, record.status, JSON.stringify(record)]);
  }

  async getRun(id: string): Promise<RunRecord> {
    const rows = await this.db.query("SELECT data, status FROM archive_runs WHERE id = ?", [id]);
    if (!rows.length) throw new HistoryError(`Run not found: ${id}`);
    return { ...decode<RunRecord>(rows[0]!), status: rows[0]!.status as RunStatus };
  }

  async listRuns(page: Page): Promise<RunRecord[]> {
    validatePage(page);
    const rows = await this.db.query(
      "SELECT data, status FROM archive_runs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
      [page.limit, page.offset]);
    return rows.map((row) => ({ ...decode<RunRecord>(row), status: row.status as RunStatus }));
  }

  async beginAttempt(runId: string, recover: boolean): Promise<AttemptRecord> {
    if (this.active) throw new HistoryError("Repository already owns an attempt");
    await this.db.lock(runId);
    try {
      const attempt = await this.db.transaction(async () => {
        const run = await this.getRun(runId);
        if (run.status === "succeeded") throw new HistoryError("A successful run cannot be resumed");
        const running = await this.db.query(
          "SELECT data FROM archive_attempts WHERE run_id = ? AND status = 'running'", [runId]);
        for (const row of running) {
          const previous = decode<AttemptRecord>(row);
          if (!recover) throw new HistoryError("Unfinished attempt; confirm the old process has stopped and use --recover");
          if (!this.db.canRecover(previous.owner)) throw new HistoryError("Attempt owner is still alive or cannot be verified");
          previous.status = "interrupted";
          previous.finishedAt = new Date().toISOString();
          previous.error = { message: "Explicit recovery after owner termination; unfinished files require review" };
          await this.saveAttempt(previous);
        }
        await this.markUnfinished(runId);
        const last = await this.db.query(
          "SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM archive_attempts WHERE run_id = ?", [runId]);
        const result: AttemptRecord = {
          id: randomUUID(), runId, ordinal: Number(last[0]!.ordinal) + 1,
          startedAt: new Date().toISOString(), finishedAt: null,
          status: "running", summary: emptySummary(), skipped: 0, owner: { host: hostname(), pid: process.pid }, error: null,
        };
        await this.db.query(
          "INSERT INTO archive_attempts(id, run_id, ordinal, started_at, status, data) VALUES (?, ?, ?, ?, ?, ?)",
          [result.id, runId, result.ordinal, result.startedAt, result.status, JSON.stringify(result)]);
        await this.db.query("UPDATE archive_runs SET status = 'running' WHERE id = ?", [runId]);
        return result;
      });
      this.active = attempt;
      return attempt;
    } catch (error) {
      await this.db.unlock(runId);
      throw error;
    }
  }

  async assertOwnership(): Promise<void> {
    if (!this.active) throw new HistoryError("No active attempt");
    const rows = await this.db.query("SELECT status FROM archive_attempts WHERE id = ?", [this.active.id]);
    if (rows[0]?.status !== "running") throw new HistoryError("Attempt ownership lost");
  }

  private async owned<T>(id: string, work: (attempt: AttemptRecord) => Promise<T>): Promise<T> {
    if (!this.active || this.active.id !== id) throw new HistoryError("Attempt ownership mismatch");
    const attempt = this.active;
    return this.db.transaction(async () => {
      await this.assertOwnership();
      return work(attempt);
    });
  }

  async checkpoint(id: string, summary: Summary, skipped: number): Promise<void> {
    await this.owned(id, async (attempt) => {
      await this.saveAttempt({ ...attempt, summary, skipped });
      this.active = { ...attempt, summary: { ...summary }, skipped };
    });
  }

  async shouldSkip(runId: string, ruleId: string, file: FileInfo): Promise<boolean> {
    const pathKey = digest([runId, ruleId, file.path]);
    const key = digest([runId, ruleId, file.path, file.version]);
    const rows = await this.db.query(
      `SELECT key FROM archive_files WHERE run_id = ? AND path_key = ?
       AND (key = ? OR state IN ('needs_review', 'processing', 'failed')) LIMIT 1`, [runId, pathKey, key]);
    return rows.length > 0;
  }

  async startFile(id: string, ruleId: string, file: FileInfo, summary: Summary, skipped: number): Promise<FileRecord> {
    return this.owned(id, async (attempt) => {
      const record: FileRecord = {
        key: digest([attempt.runId, ruleId, file.path, file.version]),
        runId: attempt.runId, attemptId: id, ruleId, path: file.path, relativePath: file.relativePath,
        version: file.version, size: file.size, lastWrite: file.lastWrite.toISOString(),
        state: "processing", phase: "checking", bytes: 0, updatedAt: new Date().toISOString(), error: null,
      };
      await this.db.query(
        "INSERT INTO archive_files(key, run_id, attempt_id, path_key, state, data) VALUES (?, ?, ?, ?, ?, ?)",
        [record.key, record.runId, id, digest([record.runId, ruleId, file.path]), record.state, JSON.stringify(record)]);
      await this.saveAttempt({ ...attempt, summary, skipped });
      return record;
    });
  }

  async updateFile(record: FileRecord, summary: Summary, skipped: number): Promise<void> {
    await this.owned(record.attemptId, async (attempt) => {
      if (record.runId !== attempt.runId) throw new HistoryError("File ownership mismatch");
      await this.saveFile(record);
      await this.saveAttempt({ ...attempt, summary, skipped });
    });
  }

  async finishAttempt(id: string, status: Exclude<RunStatus, "running">, summary: Summary,
    skipped: number, error: ErrorDetails | null): Promise<void> {
    const runId = this.active?.runId;
    await this.owned(id, async (attempt) => {
      await this.saveAttempt({ ...attempt, status, summary, skipped, error, finishedAt: new Date().toISOString() });
      await this.markUnfinished(attempt.runId);
      // Historical failures and uncertain effects cannot turn into a successful logical run.
      const issues = await this.db.query(
        "SELECT key FROM archive_files WHERE run_id = ? AND state IN ('failed', 'needs_review', 'processing') LIMIT 1",
        [attempt.runId]);
      const runStatus = status === "succeeded" && issues.length ? "completed_with_errors" : status;
      await this.db.query("UPDATE archive_runs SET status = ? WHERE id = ?", [runStatus, attempt.runId]);
    });
    this.active = undefined;
    if (runId) await this.db.unlock(runId);
  }

  async listAttempts(runId: string, page: Page): Promise<AttemptRecord[]> {
    validatePage(page);
    await this.getRun(runId);
    return (await this.db.query(
      "SELECT data FROM archive_attempts WHERE run_id = ? ORDER BY ordinal DESC LIMIT ? OFFSET ?",
      [runId, page.limit, page.offset])).map((row) => decode<AttemptRecord>(row));
  }

  async listFiles(runId: string, page: Page): Promise<FileRecord[]> {
    validatePage(page);
    await this.getRun(runId);
    return (await this.db.query(
      "SELECT data FROM archive_files WHERE run_id = ? ORDER BY key LIMIT ? OFFSET ?",
      [runId, page.limit, page.offset])).map((row) => decode<FileRecord>(row));
  }

  async progress(runId: string): Promise<Progress> {
    return this.db.transaction(async () => {
      const run = await this.getRun(runId);
      const attempts = await this.listAttempts(runId, { limit: 1, offset: 0 });
      const counts = await this.db.query(
        "SELECT state, COUNT(*) AS count FROM archive_files WHERE run_id = ? GROUP BY state", [runId]);
      const totals: Partial<Record<FileState, number>> = {};
      for (const row of counts) totals[row.state as FileState] = Number(row.count);
      const activeFiles = (await this.db.query(
        "SELECT data FROM archive_files WHERE run_id = ? AND state = 'processing' ORDER BY key LIMIT 1", [runId]))
        .map((row) => decode<FileRecord>(row));
      return { run, latestAttempt: attempts[0] ?? null, totals, activeFiles };
    });
  }

  private async saveAttempt(record: AttemptRecord): Promise<void> {
    const updated = await this.db.query(
      "UPDATE archive_attempts SET status = ?, data = ? WHERE id = ? AND status = 'running' RETURNING id",
      [record.status, JSON.stringify(record), record.id]);
    if (updated.length !== 1) throw new HistoryError("Attempt update rejected; ownership or state changed");
  }
  private async markUnfinished(runId: string): Promise<void> {
    for (;;) {
      const rows = await this.db.query(
        "SELECT data FROM archive_files WHERE run_id = ? AND state = 'processing' LIMIT 100", [runId]);
      if (!rows.length) return;
      for (const row of rows) {
        const file = decode<FileRecord>(row);
        file.state = "needs_review";
        file.updatedAt = new Date().toISOString();
        file.error = { message: "Unfinished operation; inspect source, destination and leases before manual reconciliation" };
        await this.saveFile(file);
      }
    }
  }
  private async saveFile(record: FileRecord): Promise<void> {
    const updated = await this.db.query(
      `UPDATE archive_files SET state = ?, data = ? WHERE key = ? AND attempt_id = ? AND run_id = ?
       AND state = 'processing' RETURNING key`,
      [record.state, JSON.stringify(record), record.key, record.attemptId, record.runId]);
    if (updated.length !== 1) throw new HistoryError("File update rejected; ownership or state changed");
  }
  async close(): Promise<void> { await this.db.close(); }
}

function decode<T>(row: Row): T {
  if (typeof row.data !== "string") throw new HistoryError("Invalid history record");
  return JSON.parse(row.data) as T;
}
function digest(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
