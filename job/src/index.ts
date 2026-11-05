import { randomUUID } from "node:crypto";
import { AppConfigurationClient } from "@azure/app-configuration";
import { createCredential } from "./auth.js";
import { AzureRuleStorage } from "./azure-storage.js";
import { parseSettings } from "./config.js";
import { describeError } from "./engine.js";
import { parseCommand, readHistory, type Command } from "./cli.js";
import { createExecution, execute } from "./execution.js";
import { openHistory } from "./history-config.js";
import type { HistoryRepository, RunRecord } from "./history.js";
import type { Log } from "./model.js";

let runId: string = randomUUID();
const log: Log = (event, details) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), runId, event, ...details }));
};
const controller = new AbortController();
const stop = () => controller.abort(new Error("Job interrupted"));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
let timer: NodeJS.Timeout | undefined;
let history: HistoryRepository | undefined;

try {
  const command = parseCommand(process.argv.slice(2));
  history = await openHistory();
  if (command.kind !== "run" && command.kind !== "resume") {
    console.log(JSON.stringify(await readHistory(history, command)));
  } else {
    await runJob(history, command);
  }
} catch (error) {
  log("fatal", { error: describeError(error) });
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  if (history) {
    try { await history.close(); }
    catch (error) { log("fatal", { error: describeError(error) }); process.exitCode = 1; }
  }
}

async function runJob(history: HistoryRepository, command: Extract<Command, { kind: "run" | "resume" }>): Promise<void> {
  if (command.kind === "resume") runId = command.runId;
  const timeout = Number(process.env.JOB_TIMEOUT_SECONDS ?? "3300");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) {
    throw new Error("JOB_TIMEOUT_SECONDS must be an integer from 1 to 86400");
  }
  timer = setTimeout(() => controller.abort(new Error("Job deadline exceeded")), timeout * 1000);
  const credential = createCredential();
  let record: RunRecord;
  if (command.kind === "resume") {
    record = await history.getRun(command.runId);
  } else {
    const endpoint = process.env.APP_CONFIG_ENDPOINT;
    if (!endpoint || !/^https:\/\/[a-zA-Z0-9-]+\.azconfig\.io\/?$/.test(endpoint)) {
      throw new Error("APP_CONFIG_ENDPOINT must be an Azure public-cloud App Configuration HTTPS endpoint");
    }
    const client = new AppConfigurationClient(endpoint, credential);
    const setting = await client.getConfigurationSetting({
      key: process.env.APP_CONFIG_KEY ?? "archive:settings",
      label: process.env.APP_CONFIG_LABEL ?? "production",
    }, { abortSignal: controller.signal });
    if (!setting.value) throw new Error("App Configuration setting is empty");
    record = await createExecution(history, parseSettings(setting.value), {
      key: setting.key, label: setting.label ?? "", etag: setting.etag ?? "",
    }, runId);
  }
  const settings = record.settings;
  log("started", {
    dryRun: settings.dryRun, ruleCount: settings.rules.length,
    configurationEtag: record.configuration.etag, configurationKey: record.configuration.key,
    configurationLabel: record.configuration.label, resumed: command.kind === "resume",
  });
  const summary = await execute(
    history, record, (rule) => new AzureRuleStorage(rule, credential, controller.signal, log),
    log, controller.signal, command.kind === "resume" && command.recover,
  );
  if (summary.failed > 0 || summary.limitReached || (await history.getRun(runId)).status !== "succeeded") process.exitCode = 1;
}
