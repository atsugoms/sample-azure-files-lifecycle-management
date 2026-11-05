import { Client, type ClientConfig } from "pg";
import { HistoryError } from "./history.js";
import { SqlHistoryRepository, type HistoryDriver, type Row } from "./history-db.js";

export type PostgresOptions = Pick<ClientConfig, "options"> & {
  ssl: false | { rejectUnauthorized: true; ca?: string };
} & (
  | { connectionString: string }
  | { host: string; database: string; user: string; port: number; password: () => Promise<string> }
);

export async function openPostgresHistory(options: PostgresOptions): Promise<SqlHistoryRepository> {
  const client = new Client({ ...options, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
  let connectionError: Error | undefined;
  client.on("error", (error: Error) => { connectionError = error; });
  const query: HistoryDriver["query"] = async (sql, values = []) => {
    if (connectionError) throw new HistoryError("PostgreSQL connection lost", { cause: connectionError });
    let index = 0;
    const result = await client.query<Row>(sql.replace(/\?/g, () => `$${++index}`), values);
    return result.rows;
  };
  const driver: HistoryDriver = {
    query,
    async transaction(work) {
      await query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      try {
        const result = await work();
        await query("COMMIT");
        return result;
      } catch (error) {
        try { await query("ROLLBACK"); } catch (rollback) {
          throw new AggregateError([error, rollback], "History transaction and rollback failed");
        }
        throw error;
      }
    },
    async lock(runId) {
      const rows = await query("SELECT pg_try_advisory_lock(hashtextextended(?, 0)) AS locked", [runId]);
      if (!rows[0]?.locked) throw new HistoryError("Run is owned by another connection");
    },
    async unlock(runId) { await query("SELECT pg_advisory_unlock(hashtextextended(?, 0))", [runId]); },
    canRecover() { return true; },
    async close() { await client.end(); },
  };
  try {
    await client.connect();
    // Serialize first-time schema creation across connections.
    await query("SELECT pg_advisory_lock(1476893201)");
    try {
      const repository = new SqlHistoryRepository(driver);
      await repository.initialize();
      return repository;
    } finally { await query("SELECT pg_advisory_unlock(1476893201)"); }
  } catch (error) {
    await client.end();
    throw error;
  }
}
