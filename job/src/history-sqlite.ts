import { DatabaseSync } from "node:sqlite";
import { hostname } from "node:os";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HistoryError } from "./history.js";
import { SqlHistoryRepository, type HistoryDriver, type Row } from "./history-db.js";

export async function openSqliteHistory(path: string): Promise<SqlHistoryRepository> {
  if (!path.trim() || path === ":memory:" || path.startsWith("file:")) {
    throw new HistoryError("SQLite history requires a local file path");
  }
  const absolute = resolve(path);
  if (absolute.startsWith("\\\\")) throw new HistoryError("SQLite history cannot use a network share");
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(absolute);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    const driver: HistoryDriver = {
      async query(sql, values = []) {
        return db.prepare(sql).all(...values) as Row[];
      },
      async transaction(work) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await work();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch (rollback) {
            throw new AggregateError([error, rollback], "History transaction and rollback failed");
          }
          throw error;
        }
      },
      async lock() {},
      async unlock() {},
      canRecover(owner) {
        if (owner.host !== hostname()) return false;
        try { process.kill(owner.pid, 0); return false; }
        catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH"; }
      },
      async close() { db.close(); },
    };
    const repository = new SqlHistoryRepository(driver);
    await repository.initialize();
    return repository;
  } catch (error) {
    db.close();
    throw error;
  }
}
