import assert from "node:assert/strict";
import { test } from "node:test";
import { createSettingsStore, HttpError, type ConfigurationClient } from "../src/settings.js";

test("App Configuration uses the job key/label and an ETag precondition", async () => {
  const settings = {
    version: 1 as const, dryRun: true, maxFilesPerRun: 1000, rules: [{
      id: "documents", olderThanDays: 90,
      source: { account: "sourcestorage", share: "documents", path: "" },
      destination: { kind: "blob" as const, account: "archivestorage", container: "archive", path: "", tier: "Cool" as const },
    }],
  };
  let writes = 0;
  const client: ConfigurationClient = {
    async getConfigurationSetting(selector) {
      assert.equal(selector.key, "archive:settings");
      assert.equal(selector.label, "production");
      return { key: selector.key, value: JSON.stringify(settings), etag: "v1", isReadOnly: false };
    },
    async setConfigurationSetting(setting, options) {
      writes += 1;
      assert.equal(setting.etag, "v1");
      assert.equal(options?.onlyIfUnchanged, true);
      assert.equal(setting.contentType, "application/json");
      assert.equal(setting.key, "archive:settings");
      return { key: setting.key, value: JSON.stringify(settings), etag: "v2", isReadOnly: false };
    },
  };
  const store = createSettingsStore({ APP_CONFIG_ENDPOINT: "https://example.azconfig.io" }, client);
  const original = await store.read();
  assert.equal(original.etag, "v1");
  assert.equal((await store.write(original.settings, original.etag)).etag, "v2");
  assert.equal(writes, 1);
  const oversized = { ...settings, rules: Array.from({ length: 20 }, (_, i) => ({
    ...settings.rules[0]!, id: `rule-${i}`, source: { ...settings.rules[0]!.source, path: "a".repeat(900) },
  })) };
  await assert.rejects(store.write(oversized, "v1"), (error: unknown) =>
    error instanceof HttpError && error.status === 400);
  assert.equal(writes, 1);
  assert.throws(() => createSettingsStore({ APP_CONFIG_ENDPOINT: "http://example.com" }, client));
});
