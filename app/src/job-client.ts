import { createCredential } from "azure-files-archive-job/auth";

export interface JobClientOptions {
  request?: typeof fetch;
  credential?: Pick<ReturnType<typeof createCredential>, "getToken">;
}

export class JobArmError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createJobClient(env: NodeJS.ProcessEnv, options: JobClientOptions = {}) {
  const resourceId = env.WEB_SCHEDULE_JOB_RESOURCE_ID;
  if (!resourceId) return undefined;
  if (!/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[a-z0-9_.()-]{1,90}\/providers\/Microsoft\.App\/jobs\/[a-z0-9-]{1,32}$/i.test(resourceId)) {
    throw new Error("WEB_SCHEDULE_JOB_RESOURCE_ID must identify one Container Apps Job");
  }
  const base = `https://management.azure.com${resourceId}`;
  const credential = options.credential ?? createCredential(env);
  const request = options.request ?? fetch;
  return {
    name: resourceId.slice(resourceId.lastIndexOf("/") + 1),
    async request(method: "GET" | "POST" | "PATCH", path = "", value?: unknown): Promise<Response> {
      const url = new URL(path.startsWith("https://") ? path : base + path);
      if (url.origin !== "https://management.azure.com" || url.username || url.password || url.hash
        || !["", "/start", "/executions"].some((suffix) => url.pathname.toLowerCase() === (resourceId + suffix).toLowerCase())) {
        throw new Error("ARM URL must stay within the configured job");
      }
      url.searchParams.set("api-version", "2025-01-01");
      const token = await credential.getToken("https://management.azure.com/.default");
      if (!token?.token || token.expiresOnTimestamp <= Date.now()) throw new Error("Missing valid ARM access token");
      const response = await request(url.href, {
        method, headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (!response.ok) throw new JobArmError(response.status,
        `Job ARM ${method} failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
      return response;
    },
  };
}
