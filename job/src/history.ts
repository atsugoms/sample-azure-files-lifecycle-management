import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { TokenCredential } from "@azure/identity";
import { Pool } from "pg";
import { joinPath, type Rule } from "./config.js";
import type { FileInfo, Summary } from "./model.js";

export type FileOutcome = "moved" | "changed" | "dry_run" | "failed";
export type RunOutcome = "succeeded" | "failed" | "limit_reached";

export interface ExecutionHistory {
  startRun(runId: string): Promise<void>;
  configureRun(runId: string, details: Record<string, unknown>): Promise<void>;
  finishRun(runId: string, status: RunOutcome, summary?: Summary, error?: Record<string, unknown>): Promise<void>;
  startFile(runId: string, rule: Rule, file: FileInfo, dryRun: boolean): Promise<string>;
  finishFile(id: string, status: FileOutcome, error?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

interface Database {
  execute(sql: string, values?: (string | number | null)[]): Promise<void>;
  close(): Promise<void>;
}

const schema = [
  `CREATE TABLE IF NOT EXISTS execution_runs (
    run_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'limit_reached')),
    configuration_json TEXT,
    summary_json TEXT,
    error_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS file_executions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES execution_runs(run_id),
    rule_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    destination_url TEXT NOT NULL,
    source_version TEXT NOT NULL,
    source_last_write TEXT NOT NULL,
    bytes BIGINT NOT NULL,
    dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'moved', 'changed', 'dry_run', 'failed')),
    error_json TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS file_executions_run_id ON file_executions(run_id)",
  "CREATE INDEX IF NOT EXISTS execution_runs_started_at ON execution_runs(started_at)",
];

export class SqlExecutionHistory implements ExecutionHistory {
  constructor(private readonly db: Database) {}

  async initialize(): Promise<void> {
    for (const sql of schema) await this.db.execute(sql);
  }

  async startRun(runId: string): Promise<void> {
    await this.db.execute(
      "INSERT INTO execution_runs (run_id, started_at, status) VALUES ($1, $2, 'running')",
      [runId, new Date().toISOString()],
    );
  }

  async configureRun(runId: string, details: Record<string, unknown>): Promise<void> {
    await this.db.execute("UPDATE execution_runs SET configuration_json = $1 WHERE run_id = $2",
      [JSON.stringify(details), runId]);
  }

  async finishRun(
    runId: string, status: RunOutcome, summary?: Summary, error?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.execute(
      `UPDATE execution_runs SET finished_at = $1, status = $2, summary_json = $3, error_json = $4
       WHERE run_id = $5`,
      [new Date().toISOString(), status, summary ? JSON.stringify(summary) : null,
        error ? JSON.stringify(error) : null, runId],
    );
  }

  async startFile(runId: string, rule: Rule, file: FileInfo, dryRun: boolean): Promise<string> {
    const id = randomUUID();
    const destination = rule.destination;
    const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
    const sourceUrl = `https://${rule.source.account}.file.core.windows.net/${rule.source.share}/${encodePath(file.path)}`;
    const destinationUrl = destination.kind === "blob"
      ? `https://${destination.account}.blob.core.windows.net/${destination.container}`
      : `https://${destination.account}.file.core.windows.net/${destination.share}`;
    await this.db.execute(
      `INSERT INTO file_executions
       (id, run_id, rule_id, source_url, destination_url, source_version, source_last_write,
        bytes, dry_run, started_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'running')`,
      [id, runId, rule.id, sourceUrl,
        `${destinationUrl}/${encodePath(joinPath(destination.path, file.relativePath))}`,
        file.version, file.lastWrite.toISOString(), file.size, dryRun ? 1 : 0, new Date().toISOString()],
    );
    return id;
  }

  async finishFile(id: string, status: FileOutcome, error?: Record<string, unknown>): Promise<void> {
    await this.db.execute(
      "UPDATE file_executions SET finished_at = $1, status = $2, error_json = $3 WHERE id = $4",
      [new Date().toISOString(), status, error ? JSON.stringify(error) : null, id],
    );
  }

  async close(): Promise<void> { await this.db.close(); }
}

export function sqliteDatabase(path: string): Database {
  if (!path.trim() || path === ":memory:" || path.startsWith("file:")) {
    throw new Error("SQLITE_PATH must be a persistent filesystem path");
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    async execute(sql, values = []) {
      // node:sqlite binds numbered named parameters by name, not positional order.
      const parameters = Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));
      db.prepare(sql).run(parameters);
    },
    async close() { db.close(); },
  };
}

export async function openHistory(
  env: NodeJS.ProcessEnv, credential: TokenCredential, mode: "managed-identity" | "azure-cli",
): Promise<ExecutionHistory> {
  const driver = env.DB_DRIVER ?? (mode === "azure-cli" ? "sqlite" : "postgres");
  let db: Database;
  if (driver === "sqlite") {
    if (mode !== "azure-cli") throw new Error("SQLite is only supported for local azure-cli execution");
    db = sqliteDatabase(env.SQLITE_PATH ?? "execution-log.sqlite");
  } else if (driver === "postgres") {
    for (const key of ["PGHOST", "PGDATABASE", "PGUSER"] as const) {
      if (!env[key]?.trim()) throw new Error(`${key} is required for PostgreSQL execution history`);
    }
    const pool = new Pool({
      host: env.PGHOST!, database: env.PGDATABASE!, user: env.PGUSER!, port: 5432,
      password: async () => {
        const token = await credential.getToken("https://ossrdbms-aad.database.windows.net/.default");
        if (!token) throw new Error("Unable to acquire PostgreSQL access token");
        return token.token;
      },
      ssl: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      max: 1, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000,
      query_timeout: 15000, statement_timeout: 10000,
      application_name: "azure-files-archive-job",
    });
    // Checked on each query, including when a pooled connection has failed while idle.
    let connectionError: Error | undefined;
    pool.on("error", (error: Error) => { connectionError = error; });
    db = {
      async execute(sql, values = []) {
        if (connectionError) throw connectionError;
        await pool.query(sql, values);
      },
      async close() {
        await pool.end();
        if (connectionError) throw connectionError;
      },
    };
  } else {
    throw new Error("DB_DRIVER must be postgres or sqlite");
  }
  const history = new SqlExecutionHistory(db);
  try {
    await history.initialize();
    return history;
  } catch (error) {
    try { await history.close(); } catch (closeError) {
      throw new AggregateError([error, closeError], "History initialization and cleanup failed");
    }
    throw error;
  }
}
