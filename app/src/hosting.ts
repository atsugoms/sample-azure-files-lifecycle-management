import type { IncomingMessage } from "node:http";
import { HttpError } from "./settings.js";

export type Hosting = { mode: "local"; host: "127.0.0.1" } | {
  mode: "container-apps";
  host: "0.0.0.0";
  origin: string;
  tenant: string;
  allowedUsers: Set<string>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readHosting(env: NodeJS.ProcessEnv = process.env): Hosting {
  if ((env.WEB_HOST_MODE ?? "local") === "local") return { mode: "local", host: "127.0.0.1" };
  if (env.WEB_HOST_MODE !== "container-apps") throw new Error("WEB_HOST_MODE must be local or container-apps");
  const origin = env.WEB_PUBLIC_ORIGIN ?? "";
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9.-]+\.azurecontainerapps\.io$/.test(origin)) {
    throw new Error("WEB_PUBLIC_ORIGIN must be the exact Container Apps HTTPS origin, without a trailing slash");
  }
  const tenant = env.WEB_AUTH_TENANT_ID ?? "";
  const users = (env.WEB_AUTH_ALLOWED_OBJECT_IDS ?? "").split(",").map((id) => id.trim().toLowerCase());
  if (!uuid.test(tenant) || !users.length || users.some((id) => !uuid.test(id))) {
    throw new Error("Azure hosting requires WEB_AUTH_TENANT_ID and WEB_AUTH_ALLOWED_OBJECT_IDS UUIDs");
  }
  return { mode: "container-apps", host: "0.0.0.0", origin, tenant: tenant.toLowerCase(), allowedUsers: new Set(users) };
}

export function requestOrigin(request: IncomingMessage, hosting: Hosting): string {
  const origin = hosting.mode === "local" ? `http://127.0.0.1:${request.socket.localPort}` : hosting.origin;
  if (request.headers.host !== new URL(origin).host) throw new HttpError(403, "許可された URL で接続してください。");
  if (hosting.mode === "container-apps") {
    const encoded = request.headers["x-ms-client-principal"];
    if (typeof encoded !== "string" || encoded.length > 32_768) throw new HttpError(401, "サインインが必要です。");
    let principal: unknown;
    try { principal = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown; }
    catch { throw new HttpError(401, "サインイン情報が不正です。"); }
    if (!principal || typeof principal !== "object" || !("auth_typ" in principal)
      || (principal.auth_typ !== "aad" && principal.auth_typ !== "Bearer")
      || !("claims" in principal) || !Array.isArray(principal.claims)) {
      throw new HttpError(401, "Microsoft Entra ID でサインインしてください。");
    }
    const claims = principal.claims.filter((claim): claim is { typ: string; val: string } =>
      claim !== null && typeof claim === "object" && typeof claim.typ === "string" && typeof claim.val === "string");
    const values = (types: string[]) => claims.filter((claim) => types.includes(claim.typ)).map((claim) => claim.val.toLowerCase());
    const tenants = values(["tid", "http://schemas.microsoft.com/identity/claims/tenantid"]);
    const users = values(["oid", "http://schemas.microsoft.com/identity/claims/objectidentifier"]);
    const issuers = values(["iss"]);
    const allowedIssuers = [
      `https://login.microsoftonline.com/${hosting.tenant}/v2.0`,
      `https://sts.windows.net/${hosting.tenant}/`,
    ];
    if (issuers.length !== 1 || !allowedIssuers.includes(issuers[0]!)
      || tenants.length !== 1 || tenants[0] !== hosting.tenant || users.length !== 1 || !hosting.allowedUsers.has(users[0]!)) {
      throw new HttpError(403, "この管理画面へのアクセスは許可されていません。");
    }
  }
  return origin;
}
