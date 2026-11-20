import { createJobClient, JobArmError, type JobClientOptions } from "./job-client.js";
import { HttpError } from "./settings.js";

interface NativeExecution { name: string; status: string }
export interface ExecutionState {
  jobName: string;
  active: NativeExecution[];
  updating: boolean;
  pending: boolean;
  uncertain: boolean;
}
export interface StartResult { jobName: string; executionName: string | null }
export interface ExecutionStore {
  read(): Promise<ExecutionState>;
  start(requestId: string): Promise<StartResult>;
}

export function createExecutionStore(env: NodeJS.ProcessEnv = process.env,
  options: JobClientOptions = {}): ExecutionStore | undefined {
  const client = createJobClient(env, options);
  if (!client) return undefined;
  let starting = false;
  let pending: { before: Set<string>; name: string | null; uncertain: boolean } | null = null;
  const requests = new Map<string, Promise<StartResult>>();

  async function executions(): Promise<NativeExecution[]> {
    const result: NativeExecution[] = [];
    const visited = new Set<string>();
    let path: string | null = "/executions";
    while (path) {
      if (visited.has(path) || visited.size >= 20) throw new Error("Cannot finish job execution pagination");
      visited.add(path);
      const page = await (await client!.request("GET", path)).json() as {
        value?: { name?: unknown; properties?: { status?: unknown } }[]; nextLink?: unknown;
      };
      if (!Array.isArray(page.value)) throw new Error("Invalid ARM execution list");
      for (const item of page.value) {
        if (typeof item?.name !== "string" || !item.name || typeof item.properties?.status !== "string" || !item.properties.status) {
          throw new Error("Invalid ARM execution status");
        }
        result.push({ name: item.name, status: item.properties.status });
      }
      if (page.nextLink != null && typeof page.nextLink !== "string") throw new Error("Invalid ARM nextLink");
      path = page.nextLink || null;
    }
    return result;
  }
  async function inspect() {
    const [job, items] = await Promise.all([
      client!.request("GET").then((response) => response.json()) as Promise<{ properties?: { provisioningState?: unknown } }>,
      executions(),
    ]);
    if (typeof job.properties?.provisioningState !== "string") throw new Error("Invalid ARM job provisioning state");
    if (pending && items.some((item) => pending!.name ? item.name === pending!.name : !pending!.before.has(item.name))) {
      pending = null;
    }
    return { items, active: items.filter((item) => !["Succeeded", "Failed", "Stopped"].includes(item.status)),
      updating: job.properties.provisioningState !== "Succeeded" };
  }
  return {
    async read() {
      const current = await inspect();
      return { jobName: client.name, active: current.active, updating: current.updating,
        pending: starting || pending !== null, uncertain: pending?.uncertain ?? false };
    },
    start(requestId) {
      const previous = requests.get(requestId);
      if (previous) return previous;
      if (starting) return Promise.reject(new HttpError(409, "起動を処理中です。実行状況を更新して確認してください。"));
      starting = true;
      const work = (async () => {
        const current = await inspect();
        if (current.updating || current.active.length || pending) {
          throw new HttpError(409, "実行中・起動確認中、またはジョブ更新中です。実行状況を更新して確認してください。");
        }
        const attempt = { before: new Set(current.items.map((item) => item.name)), name: null as string | null, uncertain: false };
        pending = attempt;
        try {
          // Deliberately omit the execution template; caller input must never reach ARM.
          const response = await client.request("POST", "/start");
          if (response.status !== 202) {
            const value = await response.json() as { name?: unknown };
            if (typeof value.name !== "string" || !value.name) throw new Error("ARM start response has no execution name");
            attempt.name = value.name;
          }
          pending = attempt;
          return { jobName: client.name, executionName: attempt.name };
        } catch (error) {
          if (error instanceof JobArmError && error.status >= 400 && error.status < 500) pending = null;
          else { attempt.uncertain = true; pending = attempt; }
          throw error;
        }
      })().finally(() => { starting = false; });
      requests.set(requestId, work);
      if (requests.size > 100) requests.delete(requests.keys().next().value!);
      return work;
    },
  };
}
