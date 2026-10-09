import { randomUUID } from "node:crypto";
import { AppConfigurationClient } from "@azure/app-configuration";
import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";
import { AzureRuleStorage } from "./azure-storage.js";
import { parseSettings } from "./config.js";
import { describeError, run } from "./engine.js";
import type { Log } from "./model.js";

const runId = randomUUID();
const log: Log = (event, details) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), runId, event, ...details }));
};
const controller = new AbortController();
const stop = () => controller.abort(new Error("Job interrupted"));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
let timer: NodeJS.Timeout | undefined;

try {
  const timeout = Number(process.env.JOB_TIMEOUT_SECONDS ?? "3300");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) {
    throw new Error("JOB_TIMEOUT_SECONDS must be an integer from 1 to 86400");
  }
  timer = setTimeout(() => controller.abort(new Error("Job deadline exceeded")), timeout * 1000);
  const endpoint = process.env.APP_CONFIG_ENDPOINT;
  if (!endpoint || !/^https:\/\/[a-zA-Z0-9-]+\.azconfig\.io\/?$/.test(endpoint)) {
    throw new Error("APP_CONFIG_ENDPOINT must be an Azure public-cloud App Configuration HTTPS endpoint");
  }
  const mode = process.env.AUTH_MODE ?? "managed-identity";
  if (mode !== "managed-identity" && mode !== "azure-cli") {
    throw new Error("AUTH_MODE must be managed-identity or azure-cli");
  }
  if (mode === "managed-identity" && !process.env.AZURE_CLIENT_ID) {
    throw new Error("AZURE_CLIENT_ID is required for user-assigned managed identity");
  }
  const credential = mode === "azure-cli"
    ? new AzureCliCredential()
    : new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID! });
  const client = new AppConfigurationClient(endpoint, credential);
  const setting = await client.getConfigurationSetting({
    key: process.env.APP_CONFIG_KEY ?? "archive:settings",
    label: process.env.APP_CONFIG_LABEL ?? "production",
  }, { abortSignal: controller.signal });
  if (!setting.value) throw new Error("App Configuration setting is empty");
  const settings = parseSettings(setting.value);
  log("started", {
    dryRun: settings.dryRun, ruleCount: settings.rules.length,
    configurationEtag: setting.etag, configurationKey: setting.key, configurationLabel: setting.label,
  });
  const summary = await run(
    settings, (rule) => new AzureRuleStorage(rule, credential, controller.signal, log),
    log, controller.signal,
  );
  if (summary.failed > 0 || summary.limitReached) process.exitCode = 1;
} catch (error) {
  log("fatal", { error: describeError(error) });
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
}
