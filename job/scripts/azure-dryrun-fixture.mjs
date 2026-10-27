import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { AzureCliCredential } from "@azure/identity";
import { ShareServiceClient } from "@azure/storage-file-share";
import { BlobServiceClient } from "@azure/storage-blob";
import { AppConfigurationClient } from "@azure/app-configuration";
import { parseSettings } from "../dist/src/config.js";

const [mode, snapshotPath] = process.argv.slice(2);
assert.ok(["configure", "seed", "verify"].includes(mode), "Specify configure, seed or verify");
assert.ok(mode === "configure" || snapshotPath, "Specify an external baseline snapshot path");
const account = process.env.TEST_STORAGE_ACCOUNT;
const endpoint = process.env.APP_CONFIG_ENDPOINT;
assert.match(account ?? "", /^atfileslm[a-z0-9]+$/, "Use a dedicated atfileslm test account");
assert.ok(endpoint, "APP_CONFIG_ENDPOINT is required");
const credential = new AzureCliCredential();
const files = new ShareServiceClient(`https://${account}.file.core.windows.net`, credential, {
  fileRequestIntent: "backup",
});
const blobs = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential);
const source = files.getShareClient("source");
const archive = files.getShareClient("archive");
const container = blobs.getContainerClient("archive");
const config = new AppConfigurationClient(endpoint, credential);
const key = process.env.APP_CONFIG_KEY ?? "archive:settings";
const label = process.env.APP_CONFIG_LABEL ?? "validation";
const specs = [
  { name: "old.txt", days: 100, text: "Synthetic old document\n", candidate: true },
  { name: "recent.txt", days: 1, text: "Synthetic recent document\n", candidate: false },
  { name: "near-boundary.txt", days: 89, text: "Newer than the ninety-day threshold\n", candidate: false },
  { name: "empty.txt", days: 100, text: "", candidate: true },
  { name: "\u65e5\u672c\u8a9e.txt", days: 100, text: "Unicode path fixture\n", candidate: true },
];
const rules = ["blob", "files"].map((kind) => ({
  id: `test-${kind}`,
  source: { account, share: "source", path: `to-${kind}` },
  destination: kind === "blob"
    ? { kind, account, container: "archive", path: "blob-test", tier: "Cool" }
    : { kind, account, share: "archive", path: "files-test" },
  olderThanDays: 90,
}));
const settings = parseSettings(JSON.stringify({ version: 1, dryRun: true, maxFilesPerRun: 100, rules }));

async function snapshot() {
  const result = { source: [], archiveFiles: [], archiveBlobs: [] };
  for (const branch of ["to-blob", "to-files"]) {
    const directory = source.getDirectoryClient(branch);
    for await (const entry of directory.listFilesAndDirectories()) {
      assert.equal(entry.kind, "file");
      const client = directory.getFileClient(entry.name);
      const properties = await client.getProperties();
      const bytes = properties.contentLength === 0 ? Buffer.alloc(0) : await client.downloadToBuffer();
      result.source.push({
        path: `${branch}/${entry.name}`, size: properties.contentLength,
        etag: properties.etag, lastWrite: properties.fileLastWriteOn.toISOString(),
        sha256: createHash("sha256").update(bytes).digest("hex"), leaseStatus: properties.leaseStatus,
      });
    }
  }
  for await (const entry of archive.rootDirectoryClient.listFilesAndDirectories()) {
    result.archiveFiles.push(`${entry.kind}:${entry.name}`);
  }
  for await (const blob of container.listBlobsFlat()) result.archiveBlobs.push(blob.name);
  result.source.sort((a, b) => a.path.localeCompare(b.path));
  result.archiveFiles.sort();
  result.archiveBlobs.sort();
  return result;
}

if (mode === "configure" || mode === "seed") {
  const existing = await config.getConfigurationSetting({ key, label })
    .catch((error) => {
      if (error.statusCode === 404) return null;
      throw error;
    });
  if (existing) {
    assert.deepEqual(parseSettings(existing.value), settings, "Refusing to replace different test configuration");
  } else {
    await config.addConfigurationSetting({
      key, label, value: JSON.stringify(settings), contentType: "application/json",
    });
  }
  if (mode === "configure") {
    console.log(JSON.stringify({ configured: true, dryRun: true, key, label }));
    process.exit(0);
  }
  for (const branch of ["to-blob", "to-files"]) {
    const directory = source.getDirectoryClient(branch);
    await directory.create(); // Existing directory is an error: never replace an earlier fixture.
    for (const spec of specs) {
      const client = directory.getFileClient(spec.name);
      const bytes = Buffer.from(spec.text);
      await client.create(bytes.length);
      if (bytes.length) await client.uploadRange(bytes, 0, bytes.length);
      await client.setProperties({ lastWriteTime: new Date(Date.now() - spec.days * 86400000) });
    }
  }
  const baseline = await snapshot();
  assert.equal(baseline.source.length, 10);
  assert.deepEqual(baseline.archiveFiles, []);
  assert.deepEqual(baseline.archiveBlobs, []);
  await writeFile(snapshotPath, JSON.stringify(baseline, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ seeded: 10, expectedCandidates: 6, dryRun: true, baseline: snapshotPath }));
} else {
  const setting = await config.getConfigurationSetting({ key, label });
  assert.deepEqual(parseSettings(setting.value), settings);
  const baseline = JSON.parse(await readFile(snapshotPath, "utf8"));
  const current = await snapshot();
  assert.deepEqual(current, baseline, "Dry-run changed source content/properties/leases or destination listing");
  console.log(JSON.stringify({
    verified: true, sourceFilesUnchanged: current.source.length,
    archiveFiles: current.archiveFiles.length, archiveBlobs: current.archiveBlobs.length,
  }));
}
