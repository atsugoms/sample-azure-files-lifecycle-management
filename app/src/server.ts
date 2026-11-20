import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parseSettings } from "azure-files-archive-job/config";
import type { HistoryReader, Page } from "./history.js";
import { HttpError, type SettingsStore } from "./settings.js";
import { requestOrigin, type Hosting } from "./hosting.js";
import { parseSchedule, type ScheduleStore } from "./schedule.js";
import type { ExecutionStore } from "./execution.js";

interface Dependencies {
  settings: SettingsStore;
  history: HistoryReader;
  schedules?: ScheduleStore | undefined;
  executions?: ExecutionStore | undefined;
  hosting?: Hosting;
  log?: (error: unknown, requestId: string) => void;
}

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const publicDirectory = new URL("../../public/", import.meta.url);

function page(url: URL): Page {
  const integer = (name: string, fallback: number) => {
    const text = url.searchParams.get(name);
    if (text === null) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(text)) throw new HttpError(400, "ページ指定が不正です。");
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new HttpError(400, "ページ指定が大きすぎます。");
    return value;
  };
  const result = { limit: integer("limit", 25), offset: integer("offset", 0) };
  if (result.limit < 1 || result.limit > 100) throw new HttpError(400, "limit は 1～100 で指定してください。");
  return result;
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new HttpError(415, "Content-Type: application/json が必要です。");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.length;
    if (length > 32_768) throw new HttpError(413, "リクエストが大きすぎます。");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new HttpError(400, "JSON の形式が不正です。"); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

export function createApp({ settings, history, schedules, executions, hosting = { mode: "local", host: "127.0.0.1" }, log = (error, requestId) =>
  console.error(JSON.stringify({ event: "web_error", requestId, error: String(error) })) }: Dependencies) {
  let pending: Promise<unknown> = Promise.resolve();
  function readHistory<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  return createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        json(response, 200, { status: "ok" });
        return;
      }
      // Hosted mode is safe only behind Container Apps' required Entra authentication.
      // Its ingress removes caller-supplied identity headers before adding the verified principal.
      const origin = requestOrigin(request, hosting);
      const url = new URL(request.url ?? "/", origin);
      const navigation = request.method === "GET" && url.pathname === "/"
        && request.headers["sec-fetch-mode"] === "navigate";
      if ((request.headers.origin && request.headers.origin !== origin)
        || (request.headers["sec-fetch-site"] === "cross-site" && !navigation)) {
        throw new HttpError(403, "別サイトからのアクセスは許可されていません。");
      }
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname)!;
        const content = await readFile(fileURLToPath(new URL(file!, publicDirectory)));
        response.writeHead(200, { "Content-Type": type! });
        response.end(content);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        json(response, 200, await settings.read());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/hosting") {
        json(response, 200, { mode: hosting.mode });
        return;
      }
      if (url.pathname === "/api/execution" && ["GET", "POST"].includes(request.method ?? "")) {
        if (!executions) throw new HttpError(503, "即時実行は未設定です。WEB_SCHEDULE_JOB_RESOURCE_ID を設定してください。");
        if (request.method === "GET") { json(response, 200, await executions.read()); return; }
        if (request.headers["x-archive-request"] !== "1" || request.headers.origin !== origin) {
          throw new HttpError(403, "同一サイトの実行画面から起動してください。");
        }
        const input = await body(request);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1
          || !("requestId" in input) || typeof input.requestId !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
          throw new HttpError(400, "起動要求の形式が不正です。実行画面からやり直してください。");
        }
        const etag = request.headers["if-match"];
        if (typeof etag !== "string" || !etag.trim() || etag.trim() === "*") {
          throw new HttpError(428, "保存済み設定を読み直し、実行モードを確認してください。");
        }
        if ((await settings.read()).etag !== etag) {
          throw new HttpError(409, "アーカイブ設定が変更されました。実行モードを確認し直してください。");
        }
        json(response, 202, await executions.start(input.requestId));
        return;
      }
      if (url.pathname === "/api/schedule" && ["GET", "PUT"].includes(request.method ?? "")) {
        if (!schedules) throw new HttpError(503, "スケジュール管理は未設定です。WEB_SCHEDULE_JOB_RESOURCE_ID を設定してください。");
        if (request.method === "GET") { json(response, 200, await schedules.read()); return; }
        if (request.headers["x-archive-request"] !== "1" || request.headers.origin !== origin) {
          throw new HttpError(403, "同一サイトのスケジュール画面から保存してください。");
        }
        const revision = request.headers["if-match"];
        if (typeof revision !== "string" || !revision.trim() || revision.trim() === "*") {
          throw new HttpError(428, "スケジュールを読み直してから保存してください。");
        }
        json(response, 200, await schedules.write(parseSchedule(await body(request)), revision));
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        if (request.headers["x-archive-request"] !== "1" || request.headers.origin !== origin) {
          throw new HttpError(403, "同一サイトの設定画面から保存してください。");
        }
        const etag = request.headers["if-match"];
        if (typeof etag !== "string" || !etag.trim() || etag.trim() === "*") {
          throw new HttpError(428, "設定を読み直してから保存してください。");
        }
        const input = await body(request);
        let validated;
        try { validated = parseSettings(JSON.stringify(input)); }
        catch (error) {
          throw new HttpError(400, `設定の検証に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
        }
        json(response, 200, await settings.write(validated, etag));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/runs") {
        const pagination = page(url);
        json(response, 200, await readHistory(() => history.listRuns(pagination)));
        return;
      }
      const match = /^\/api\/runs\/([a-zA-Z0-9_-]{1,128})(?:\/(files))?$/.exec(url.pathname);
      if (request.method === "GET" && match) {
        const id = match[1]!;
        const pagination = page(url);
        const result = await readHistory(async () => {
          const run = await history.getRun(id);
          if (!run) throw new HttpError(404, "実行履歴が見つかりません。");
          return match[2] === "files" ? history.listFiles(id, pagination)
            : { run, totals: await history.totals(id) };
        });
        json(response, 200, result);
        return;
      }
      throw new HttpError(request.method === "GET" ? 404 : 405, "この操作は利用できません。");
    } catch (error) {
      const upstream = error !== null && typeof error === "object" && "statusCode" in error
        ? error.statusCode : undefined;
      const status = error instanceof HttpError ? error.status : upstream === 412 ? 409 : 502;
      if (!(error instanceof HttpError)) log(error, requestId);
      const message = error instanceof HttpError ? error.message
        : status === 409 ? "設定が別の操作で更新されました。入力を控え、再読み込みして変更をやり直してください。"
        : `接続先の処理に失敗しました。認証・権限・接続設定を確認してください。参照 ID: ${requestId}`;
      if (!response.headersSent) json(response, status, { error: message });
      else response.destroy();
    }
  });
}
