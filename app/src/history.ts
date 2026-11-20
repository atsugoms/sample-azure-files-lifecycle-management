import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createCredential, readAuthMode } from "azure-files-archive-job/auth";
import type { FileOutcome, RunOutcome } from "azure-files-archive-job/history";

export interface Page { limit: number; offset: number }
type FileStatus = FileOutcome | "running";

export interface RunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunOutcome | "running";
  configuration: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

export interface FileRecord {
  id: string;
  runId: string;
  ruleId: string;
  sourceUrl: string;
  destinationUrl: string;
  sourceVersion: string;
  sourceLastWrite: string;
  bytes: number;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  status: FileStatus;
  error: Record<string, unknown> | null;
}

export interface HistoryReader {
  listRuns(page: Page): Promise<RunRecord[]>;
  getRun(id: string): Promise<RunRecord | null>;
  listFiles(runId: string, page: Page): Promise<FileRecord[]>;
  totals(runId: string): Promise<Partial<Record<FileStatus, number>>>;
  close(): Promise<void>;
}

interface Database {
  query(sql: string, values?: (string | number)[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

const runColumns = "run_id, started_at, finished_at, status, configuration_json, summary_json, error_json";
const fileColumns = `id, run_id, rule_id, source_url, destination_url, source_version, source_last_write,
  bytes, dry_run, started_at, finished_at, status, error_json`;
const fileStatuses = ["running", "moved", "dry_run", "changed", "failed"] as const;
const runStatuses = ["running", "succeeded", "failed", "limit_reached"] as const;

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid text value in execution history");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function integer(value: unknown): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error("Invalid integer value in execution history");
  }
  return number;
}

function status<T extends string>(value: unknown, allowed: readonly T[]): T {
  const match = allowed.find((candidate) => candidate === value);
  if (!match) throw new Error("Invalid status in execution history");
  return match;
}

function document(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(text(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JSON object in execution history");
  }
  return Object.fromEntries(Object.entries(parsed));
}

function runRecord(row: Record<string, unknown>): RunRecord {
  return {
    runId: text(row.run_id), startedAt: text(row.started_at), finishedAt: nullableText(row.finished_at),
    status: status(row.status, runStatuses), configuration: document(row.configuration_json),
    summary: document(row.summary_json), error: document(row.error_json),
  };
}

function validatePage(page: Page): void {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100
    || !Number.isSafeInteger(page.offset) || page.offset < 0) {
    throw new Error("History page requires limit 1..100 and a nonnegative integer offset");
  }
}

class SqlHistoryReader implements HistoryReader {
  constructor(private readonly db: Database) {}

  async listRuns(page: Page): Promise<RunRecord[]> {
    validatePage(page);
    return (await this.db.query(
      `SELECT ${runColumns} FROM execution_runs ORDER BY started_at DESC, run_id DESC LIMIT $1 OFFSET $2`,
      [page.limit, page.offset],
    )).map(runRecord);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const [row] = await this.db.query(`SELECT ${runColumns} FROM execution_runs WHERE run_id = $1`, [id]);
    return row ? runRecord(row) : null;
  }

  async listFiles(runId: string, page: Page): Promise<FileRecord[]> {
    validatePage(page);
    return (await this.db.query(
      `SELECT ${fileColumns} FROM file_executions WHERE run_id = $1
       ORDER BY started_at, id LIMIT $2 OFFSET $3`, [runId, page.limit, page.offset],
    )).map((row) => {
      const dryRun = integer(row.dry_run);
      if (dryRun > 1) throw new Error("Invalid dry_run value in execution history");
      return {
        id: text(row.id), runId: text(row.run_id), ruleId: text(row.rule_id),
        sourceUrl: text(row.source_url), destinationUrl: text(row.destination_url),
        sourceVersion: text(row.source_version), sourceLastWrite: text(row.source_last_write),
        bytes: integer(row.bytes), dryRun: dryRun === 1,
        startedAt: text(row.started_at), finishedAt: nullableText(row.finished_at),
        status: status(row.status, fileStatuses), error: document(row.error_json),
      };
    });
  }

  async totals(runId: string): Promise<Partial<Record<FileStatus, number>>> {
    const totals: Partial<Record<FileStatus, number>> = {};
    for (const row of await this.db.query(
      "SELECT status, COUNT(*) AS count FROM file_executions WHERE run_id = $1 GROUP BY status", [runId],
    )) {
      totals[status(row.status, fileStatuses)] = integer(row.count);
    }
    return totals;
  }

  async close(): Promise<void> { await this.db.close(); }
}

export async function openHistoryReader(env: NodeJS.ProcessEnv = process.env): Promise<HistoryReader> {
  if (Object.keys(env).some((key) => env[key] !== undefined
    && (key === "HISTORY_DB_PROVIDER" || key === "HISTORY_SQLITE_PATH" || key.startsWith("HISTORY_POSTGRES_")))) {
    throw new Error("Legacy HISTORY_* database settings are not supported; use DB_DRIVER, SQLITE_PATH and PG*");
  }
  const mode = readAuthMode(env);
  const driver = env.DB_DRIVER ?? (mode === "azure-cli" ? "sqlite" : "postgres");
  let db: Database;
  if (driver === "sqlite") {
    if (mode !== "azure-cli") throw new Error("SQLite is only supported for local azure-cli execution");
    const path = env.SQLITE_PATH ?? fileURLToPath(new URL("../../../job/execution-log.sqlite", import.meta.url));
    if (!path.trim() || path === ":memory:" || path.startsWith("file:")) {
      throw new Error("SQLITE_PATH must be a persistent filesystem path");
    }
    const sqlite = new DatabaseSync(resolve(path), { readOnly: true });
    try {
      sqlite.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON");
    } catch (error) {
      sqlite.close();
      throw error;
    }
    db = {
      async query(sql, values = []) {
        const parameters = Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));
        return sqlite.prepare(sql).all(parameters);
      },
      async close() { sqlite.close(); },
    };
  } else if (driver === "postgres") {
    for (const key of ["PGHOST", "PGDATABASE", "PGUSER"] as const) {
      if (!env[key]?.trim()) throw new Error(`${key} is required for PostgreSQL execution history`);
    }
    const credential = createCredential(env);
    const pool = new Pool({
      host: env.PGHOST!, database: env.PGDATABASE!, user: env.PGUSER!, port: 5432,
      password: async () => {
        const token = await credential.getToken("https://ossrdbms-aad.database.windows.net/.default");
        if (!token) throw new Error("Unable to acquire PostgreSQL access token");
        return token.token;
      },
      ssl: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      options: "-c default_transaction_read_only=on",
      max: 1, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000,
      query_timeout: 15000, statement_timeout: 10000, application_name: "azure-files-archive-web",
    });
    let connectionError: Error | undefined;
    pool.on("error", (error: Error) => { connectionError = error; });
    db = {
      async query(sql, values = []) {
        if (connectionError) throw connectionError;
        return (await pool.query<Record<string, unknown>>(sql, values)).rows;
      },
      async close() {
        await pool.end();
        if (connectionError) throw connectionError;
      },
    };
  } else {
    throw new Error("DB_DRIVER must be postgres or sqlite");
  }
  try {
    // Verify the existing schema, without creating or migrating any database objects.
    await db.query(`SELECT ${runColumns} FROM execution_runs LIMIT 0`);
    await db.query(`SELECT ${fileColumns} FROM file_executions LIMIT 0`);
    return new SqlHistoryReader(db);
  } catch (error) {
    try { await db.close(); } catch (closeError) {
      throw new AggregateError([error, closeError], "History reader initialization and cleanup failed");
    }
    throw error;
  }
}
