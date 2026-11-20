import { createHash } from "node:crypto";
import { HttpError } from "./settings.js";
import { createJobClient, type JobClientOptions } from "./job-client.js";

export interface Schedule {
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string;
  weekdays: number[];
}
export interface ScheduleDocument {
  settings: Schedule | null;
  revision: string;
  cronUtc: string | null;
  nextRun: string | null;
  jobName: string;
  trigger: string;
  updating: boolean;
}
export interface ScheduleStore {
  read(): Promise<ScheduleDocument>;
  write(settings: Schedule, revision: string): Promise<ScheduleDocument>;
}
interface TriggerConfig {
  parallelism?: number;
  replicaCompletionCount?: number;
  cronExpression?: string;
}
interface Job {
  tags?: Record<string, string>;
  properties: {
    provisioningState: string;
    configuration: {
      triggerType: string;
      replicaTimeout: number;
      manualTriggerConfig?: TriggerConfig | null;
      scheduleTriggerConfig?: TriggerConfig | null;
      secrets?: unknown;
      [key: string]: unknown;
    };
  };
}
const preferenceTag = "archive-console-schedule";

export function parseSchedule(input: unknown): Schedule {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "スケジュールの形式が不正です。");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["enabled", "frequency", "time", "weekdays"].includes(key))
    || typeof value.enabled !== "boolean" || (value.frequency !== "daily" && value.frequency !== "weekly")
    || typeof value.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)
    || !Array.isArray(value.weekdays)
    || value.weekdays.some((day: unknown) => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new HttpError(400, "有効・無効、周期、時刻（HH:mm）、曜日を正しく指定してください。");
  }
  const weekdays = value.weekdays as number[];
  if (new Set(weekdays).size !== weekdays.length
    || (value.frequency === "weekly" ? weekdays.length === 0 : weekdays.length !== 0)) {
    throw new HttpError(400, "毎週は曜日を重複なく 1 つ以上選択してください。毎日は曜日を指定しません。");
  }
  return { enabled: value.enabled, frequency: value.frequency, time: value.time,
    weekdays: [...weekdays].sort((a, b) => a - b) };
}

export function scheduleCron(schedule: Schedule): string {
  const [hour, minute] = schedule.time.split(":").map(Number) as [number, number];
  const days = schedule.frequency === "daily" ? "*" : schedule.weekdays
    .map((day) => (day + (hour < 9 ? 6 : 0)) % 7).sort((a, b) => a - b).join(",");
  return `${minute} ${(hour + 15) % 24} * * ${days}`;
}

export function scheduleFromCron(cron: string): Schedule | null {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-6](?:,[0-6])*)$/.exec(cron.trim());
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return null;
  const hour = Number(match[2]);
  const weekdays = match[3] === "*" ? [] : [...new Set(match[3]!.split(",")
    .map((day) => (Number(day) + (hour >= 15 ? 1 : 0)) % 7))].sort((a, b) => a - b);
  return { enabled: true, frequency: match[3] === "*" ? "daily" : "weekly",
    time: `${String((hour + 9) % 24).padStart(2, "0")}:${match[1]!.padStart(2, "0")}`, weekdays };
}

export function nextScheduleRun(schedule: Schedule, now = new Date()): string | null {
  if (!schedule.enabled) return null;
  const japan = new Date(now.getTime() + 9 * 3600_000);
  const [hour, minute] = schedule.time.split(":").map(Number) as [number, number];
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(Date.UTC(japan.getUTCFullYear(), japan.getUTCMonth(), japan.getUTCDate() + offset, hour - 9, minute));
    const weekday = new Date(candidate.getTime() + 9 * 3600_000).getUTCDay();
    if (candidate > now && (schedule.frequency === "daily" || schedule.weekdays.includes(weekday))) return candidate.toISOString();
  }
  throw new Error("Cannot calculate next schedule run");
}

export function createScheduleStore(
  env: NodeJS.ProcessEnv = process.env,
  options: JobClientOptions & { wait?: () => Promise<void> } = {},
): ScheduleStore | undefined {
  const client = createJobClient(env, options);
  if (!client) return undefined;
  const jobName = client.name;
  const arm = (method: "GET" | "PATCH", value?: unknown) => client.request(method, "", value);
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 2000)));
  let pending: Promise<unknown> = Promise.resolve();
  async function readJob(): Promise<Job> {
    const job = await (await arm("GET")).json() as Job;
    if (!job.properties?.configuration?.triggerType || !Number.isInteger(job.properties.configuration.replicaTimeout)
      || typeof job.properties.provisioningState !== "string") throw new Error("Invalid ARM job response");
    return job;
  }
  function document(job: Job): ScheduleDocument {
    const config = job.properties.configuration;
    const cronUtc = config.scheduleTriggerConfig?.cronExpression ?? null;
    let settings: Schedule | null = null;
    if (config.triggerType === "Schedule" && cronUtc) settings = scheduleFromCron(cronUtc);
    if (config.triggerType === "Manual") {
      const saved = job.tags?.[preferenceTag];
      settings = saved ? { ...parseSchedule(JSON.parse(saved) as unknown), enabled: false }
        : { enabled: false, frequency: "daily", time: "09:00", weekdays: [] };
    }
    return { settings, cronUtc: config.triggerType === "Schedule" ? cronUtc : settings ? scheduleCron(settings) : null,
      revision: `"${createHash("sha256").update(JSON.stringify({ tags: job.tags, config })).digest("hex")}"`,
      nextRun: settings ? nextScheduleRun(settings) : null, jobName, trigger: config.triggerType,
      updating: job.properties.provisioningState !== "Succeeded" };
  }
  return {
    async read() { return document(await readJob()); },
    write(input, revision) {
      const work = pending.then(async () => {
        const settings = parseSchedule(input);
        const job = await readJob();
        const before = document(job);
        if (before.revision !== revision) throw new HttpError(409, "ジョブ設定が更新されています。再読み込みして変更をやり直してください。");
        if (!before.settings) throw new HttpError(409, "このジョブのトリガー・cron 式は画面から変更できません。Azure 側で確認してください。");
        if (before.updating) throw new HttpError(409, "Azure がジョブを更新中です。完了後に再読み込みしてください。");
        const configuration = job.properties.configuration;
        const counts = (before.trigger === "Schedule" ? configuration.scheduleTriggerConfig : configuration.manualTriggerConfig)!;
        if (!counts || !Number.isInteger(counts.parallelism) || !Number.isInteger(counts.replicaCompletionCount)) {
          throw new Error("Job trigger replica settings are missing");
        }
        const trigger = { parallelism: counts.parallelism, replicaCompletionCount: counts.replicaCompletionCount };
        await arm("PATCH", {
          tags: { [preferenceTag]: JSON.stringify(settings) },
          properties: { configuration: {
            triggerType: settings.enabled ? "Schedule" : "Manual",
            manualTriggerConfig: settings.enabled ? null : trigger,
            scheduleTriggerConfig: settings.enabled ? { ...trigger, cronExpression: scheduleCron(settings) } : null,
          } },
        });
        for (let attempt = 0; attempt < 45; attempt++) {
          await wait();
          const current = await readJob();
          if (current.properties.provisioningState === "Failed") throw new Error("Azure job schedule update failed");
          if (current.properties.provisioningState === "Succeeded") {
            const result = document(current);
            if (JSON.stringify(result.settings) !== JSON.stringify(settings)) throw new Error("Azure schedule differs from the requested settings; reload before retrying");
            return result;
          }
        }
        throw new Error("Azure schedule update is still pending; reload before retrying");
      });
      pending = work.then(() => undefined, () => undefined);
      return work;
    },
  };
}
