import { AppConfigurationClient } from "@azure/app-configuration";
import { createCredential } from "azure-files-archive-job/auth";
import { parseSettings, type Settings } from "azure-files-archive-job/config";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface SettingsDocument {
  settings: Settings;
  etag: string;
  source: { key: string; label: string };
}

export interface SettingsStore {
  read(): Promise<SettingsDocument>;
  write(settings: Settings, etag: string): Promise<SettingsDocument>;
}

export interface ConfigurationClient {
  getConfigurationSetting(...args: Parameters<AppConfigurationClient["getConfigurationSetting"]>):
    Promise<Pick<Awaited<ReturnType<AppConfigurationClient["getConfigurationSetting"]>>, "value" | "etag">>;
  setConfigurationSetting(...args: Parameters<AppConfigurationClient["setConfigurationSetting"]>):
    Promise<Pick<Awaited<ReturnType<AppConfigurationClient["setConfigurationSetting"]>>, "value" | "etag">>;
}

export function createSettingsStore(
  env: NodeJS.ProcessEnv = process.env,
  configurationClient?: ConfigurationClient,
): SettingsStore {
  const endpoint = env.APP_CONFIG_ENDPOINT;
  if (!endpoint || !/^https:\/\/[a-zA-Z0-9-]+\.azconfig\.io\/?$/.test(endpoint)) {
    throw new Error("APP_CONFIG_ENDPOINT must be an Azure public-cloud App Configuration HTTPS endpoint");
  }
  const client = configurationClient ?? new AppConfigurationClient(endpoint, createCredential(env));
  const source = {
    key: env.APP_CONFIG_KEY ?? "archive:settings",
    label: env.APP_CONFIG_LABEL ?? "production",
  };
  function document(value: string | undefined, etag: string | undefined): SettingsDocument {
    if (!value || !etag) throw new Error("App Configuration setting requires a JSON value and ETag");
    return { settings: parseSettings(value), etag, source };
  }
  return {
    async read() {
      const setting = await client.getConfigurationSetting(source, { abortSignal: AbortSignal.timeout(15_000) });
      return document(setting.value, setting.etag);
    },
    async write(settings, etag) {
      const value = JSON.stringify(settings);
      // App Configuration's 10 KB limit includes the key, label and other attributes.
      if (Buffer.byteLength(value + source.key + source.label + "application/json", "utf8") > 9500) {
        throw new HttpError(400, "設定が大きすぎます。キー・ラベルを含めて 9,500 バイト以内にしてください。");
      }
      const setting = await client.setConfigurationSetting({
        ...source, value, etag, contentType: "application/json",
      }, { onlyIfUnchanged: true, abortSignal: AbortSignal.timeout(15_000) });
      return document(setting.value, setting.etag);
    },
  };
}
