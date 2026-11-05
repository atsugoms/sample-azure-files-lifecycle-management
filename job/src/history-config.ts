import { readFile } from "node:fs/promises";
import type { HistoryRepository } from "./history.js";
import { HistoryError } from "./history.js";
import { createCredential, type TokenProvider } from "./auth.js";
import type { PostgresOptions } from "./history-postgres.js";

export const POSTGRES_TOKEN_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

export async function openHistory(env: NodeJS.ProcessEnv = process.env): Promise<HistoryRepository> {
  const provider = env.HISTORY_DB_PROVIDER ?? "sqlite";
  if (provider === "sqlite") {
    const { openSqliteHistory } = await import("./history-sqlite.js");
    return openSqliteHistory(env.HISTORY_SQLITE_PATH ?? "./data/history.sqlite");
  }
  if (provider !== "postgres") throw new HistoryError("HISTORY_DB_PROVIDER must be sqlite or postgres");
  const options = await buildPostgresOptions(env);
  const { openPostgresHistory } = await import("./history-postgres.js");
  return openPostgresHistory(options);
}

export async function buildPostgresOptions(
  env: NodeJS.ProcessEnv, tokenProvider?: TokenProvider,
): Promise<PostgresOptions> {
  const mode = env.HISTORY_POSTGRES_AUTH_MODE ?? "password";
  if (mode !== "password" && mode !== "entra") throw new HistoryError("HISTORY_POSTGRES_AUTH_MODE must be password or entra");
  const tls = env.HISTORY_POSTGRES_TLS ?? "verify-full";
  if (tls !== "verify-full" && tls !== "disable") throw new HistoryError("HISTORY_POSTGRES_TLS must be verify-full or disable");
  if (mode === "entra" && tls !== "verify-full") throw new HistoryError("Entra PostgreSQL authentication requires verify-full TLS");
  const caPath = env.HISTORY_POSTGRES_CA_PATH;
  if (tls === "disable" && caPath) throw new HistoryError("CA path requires TLS");
  const ca = caPath ? await readFile(caPath, "utf8") : undefined;
  const schema = env.HISTORY_POSTGRES_SCHEMA;
  if (schema !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new HistoryError("HISTORY_POSTGRES_SCHEMA must be a lowercase SQL identifier (1..63 characters)");
  }
  const common = {
    ssl: tls === "disable" ? false as const : { rejectUnauthorized: true as const, ...(ca ? { ca } : {}) },
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  };
  if (mode === "password") {
    const connectionString = env.HISTORY_POSTGRES_URL;
    if (!connectionString) throw new HistoryError("HISTORY_POSTGRES_URL is required");
    let url: URL;
    try { url = new URL(connectionString); } catch { throw new HistoryError("Invalid HISTORY_POSTGRES_URL"); }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new HistoryError("Invalid PostgreSQL URL protocol");
    // pg connection-string SSL parameters can override verified TLS options.
    if ([...url.searchParams.keys()].some((key) => key.toLowerCase().startsWith("ssl"))) {
      throw new HistoryError("Configure TLS with HISTORY_POSTGRES_TLS and HISTORY_POSTGRES_CA_PATH, not URL SSL parameters");
    }
    if (schema && url.searchParams.has("options")) {
      throw new HistoryError("Configure the schema using HISTORY_POSTGRES_SCHEMA or URL options, not both");
    }
    return { ...common, connectionString };
  }
  if (env.HISTORY_POSTGRES_URL) throw new HistoryError("HISTORY_POSTGRES_URL must not be set for Entra authentication");
  const host = required(env, "HISTORY_POSTGRES_HOST");
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.postgres\.database\.azure\.com$/.test(host)) {
    throw new HistoryError("HISTORY_POSTGRES_HOST must be an Azure public-cloud PostgreSQL hostname");
  }
  const database = required(env, "HISTORY_POSTGRES_DATABASE");
  const user = required(env, "HISTORY_POSTGRES_USER");
  const credential = tokenProvider ?? createCredential(env);
  return {
    ...common, host, database, user, port: 5432,
    password: async () => {
      const token = await credential.getToken(POSTGRES_TOKEN_SCOPE);
      if (!token?.token || token.expiresOnTimestamp <= Date.now()) {
        throw new HistoryError("Failed to obtain a valid PostgreSQL Entra token");
      }
      return token.token;
    },
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || !value.trim() || /[\u0000\r\n]/.test(value)) throw new HistoryError(`${key} is required and must be a single-line value`);
  return value;
}
