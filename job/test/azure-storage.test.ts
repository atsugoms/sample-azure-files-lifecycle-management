import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BlobClient, BlockBlobClient, BlobLeaseClient } from "@azure/storage-blob";
import {
  ShareClient, ShareDirectoryClient, ShareFileClient, ShareLeaseClient,
  type FileDeleteOptions, type FileDownloadToBufferOptions, type FileGetPropertiesOptions,
  type FileRenameOptions, type FileUploadRangeOptions, type FileProperties,
} from "@azure/storage-file-share";
import type {
  BlobDownloadToBufferOptions, BlobGetPropertiesOptions, BlobSetTierOptions,
  BlockBlobUploadOptions, BlockBlobStageBlockOptions, BlockBlobCommitBlockListOptions,
} from "@azure/storage-blob";
import { AzureRuleStorage } from "../src/azure-storage.js";
import { parseSettings } from "../src/config.js";
import { moveFile } from "../src/engine.js";

const credential = {
  async getToken(): Promise<never> { throw new Error("Unexpected network call in unit test"); },
};
const sourceUrl = "https://sourceaccount.file.core.windows.net/source/file.txt";
const data = Buffer.from("safe archive content");
const lastWrite = new Date("2020-01-01T00:00:00Z");
const cutoff = new Date("2025-01-01T00:00:00Z").getTime();

function mockStorage(t: TestContext, corrupt = false) {
  const contents = new Map([[sourceUrl, data]]);
  const leases = new Map<string, string>();
  const events: string[] = [];
  let sourceDeleted = false;
  const assertLease = (url: string, id: string | undefined) => {
    assert.ok(id, `Missing lease: ${url}`);
    assert.equal(id, leases.get(url));
  };
  t.mock.method(ShareLeaseClient.prototype, "acquireLease", async function (this: ShareLeaseClient, duration: number) {
    assert.equal(duration, -1);
    assert.equal(leases.has(this.url), false);
    leases.set(this.url, this.leaseId);
    return { leaseId: this.leaseId };
  });
  t.mock.method(ShareLeaseClient.prototype, "releaseLease", async function (this: ShareLeaseClient) {
    assertLease(this.url, this.leaseId);
    leases.delete(this.url);
    return {};
  });
  t.mock.method(ShareDirectoryClient.prototype, "listFilesAndDirectories", async function* () {
    yield { kind: "file", name: "file.txt" };
  });
  t.mock.method(ShareFileClient.prototype, "getProperties", async function (
    this: ShareFileClient, options: FileGetPropertiesOptions,
  ) {
    if (options.leaseAccessConditions) assertLease(this.url, options.leaseAccessConditions.leaseId);
    return {
      fileLastWriteOn: lastWrite, fileCreatedOn: lastWrite,
      contentLength: contents.get(this.url)?.length, etag: "etag", fileId: "file-id",
      filePermissionKey: "source-permission", fileAttributes: "Archive", contentType: "text/plain",
    };
  });
  t.mock.method(ShareFileClient.prototype, "downloadToBuffer", async function (
    this: ShareFileClient, offset: number, count: number, options: FileDownloadToBufferOptions,
  ) {
    assertLease(this.url, options.leaseAccessConditions?.leaseId);
    const buffer = contents.get(this.url);
    assert.ok(buffer);
    return corrupt && this.url !== sourceUrl ? Buffer.alloc(count) : buffer.subarray(offset, offset + count);
  });
  t.mock.method(ShareFileClient.prototype, "delete", async function (this: ShareFileClient, options: FileDeleteOptions) {
    assert.equal(this.url, sourceUrl);
    assertLease(this.url, options.leaseAccessConditions?.leaseId);
    events.push("source-deleted");
    sourceDeleted = true;
    contents.delete(this.url);
    leases.delete(this.url);
    return {};
  });
  return { contents, leases, events, assertLease, sourceDeleted: () => sourceDeleted };
}

test("Blob adapter creates exclusively, verifies under lease, sets tier then deletes", async (t) => {
  const state = mockStorage(t);
  const blocks: Buffer[] = [];
  t.mock.method(BlobClient.prototype, "exists", async function (this: BlobClient) {
    return state.contents.has(this.url);
  });
  t.mock.method(BlockBlobClient.prototype, "upload", async function (
    this: BlockBlobClient, _body: string, _length: number, options: BlockBlobUploadOptions,
  ) {
    assert.equal(options.conditions?.ifNoneMatch, "*");
    assert.equal(options.tier, "Hot");
    state.contents.set(this.url, Buffer.alloc(0));
    return {};
  });
  t.mock.method(BlobLeaseClient.prototype, "acquireLease", async function (this: BlobLeaseClient, duration: number) {
    assert.equal(duration, -1);
    state.leases.set(this.url, this.leaseId);
    return { leaseId: this.leaseId };
  });
  t.mock.method(BlobLeaseClient.prototype, "releaseLease", async function (this: BlobLeaseClient) {
    state.assertLease(this.url, this.leaseId);
    state.leases.delete(this.url);
    return {};
  });
  t.mock.method(BlockBlobClient.prototype, "stageBlock", async function (
    this: BlockBlobClient, _id: string, body: Buffer, length: number, options: BlockBlobStageBlockOptions,
  ) {
    state.assertLease(this.url, options.conditions?.leaseId);
    assert.equal(length, body.length);
    assert.ok(options.transactionalContentMD5);
    blocks.push(body);
    return {};
  });
  t.mock.method(BlockBlobClient.prototype, "commitBlockList", async function (
    this: BlockBlobClient, ids: string[], options: BlockBlobCommitBlockListOptions,
  ) {
    state.assertLease(this.url, options.conditions?.leaseId);
    assert.equal(ids.length, blocks.length);
    assert.equal(options.metadata?.archive_source_last_write, lastWrite.toISOString());
    state.contents.set(this.url, Buffer.concat(blocks));
    return { etag: "blob-etag" };
  });
  t.mock.method(BlobClient.prototype, "getProperties", async function (
    this: BlobClient, options: BlobGetPropertiesOptions,
  ) {
    state.assertLease(this.url, options.conditions?.leaseId);
    assert.equal(options.conditions?.ifMatch, "blob-etag");
    return { contentLength: state.contents.get(this.url)?.length };
  });
  t.mock.method(BlobClient.prototype, "downloadToBuffer", async function (
    this: BlobClient, offset: number, count: number, options: BlobDownloadToBufferOptions,
  ) {
    state.assertLease(this.url, options.conditions?.leaseId);
    assert.equal(options.conditions?.ifMatch, "blob-etag");
    state.events.push("verified-read");
    return state.contents.get(this.url)!.subarray(offset, offset + count);
  });
  t.mock.method(BlobClient.prototype, "setAccessTier", async function (
    this: BlobClient, tier: string, options: BlobSetTierOptions,
  ) {
    assert.equal(tier, "Cool");
    state.assertLease(this.url, options.conditions?.leaseId);
    state.events.push("tier");
    return {};
  });
  const rule = parseSettings(JSON.stringify({
    version: 1, rules: [{
      id: "test", source: { account: "sourceaccount", share: "source" },
      destination: { kind: "blob", account: "archiveaccount", container: "archive" },
      olderThanDays: 90,
    }],
  })).rules[0]!;
  const storage = new AzureRuleStorage(rule, credential, new AbortController().signal, () => {});
  for await (const file of storage.list()) {
    assert.equal(await moveFile(storage, file, cutoff, new AbortController().signal), "moved");
  }
  assert.deepEqual(state.events, ["verified-read", "tier", "source-deleted"]);
  assert.equal(state.sourceDeleted(), true);
  assert.equal(state.leases.size, 0);
});

for (const corrupt of [false, true]) {
  test(`Files adapter preserves SMB properties and refuses corrupt copy (${corrupt})`, async (t) => {
    const state = mockStorage(t, corrupt);
    t.mock.method(ShareFileClient.prototype, "exists", async function (this: ShareFileClient) {
      return state.contents.has(this.url);
    });
    t.mock.method(ShareDirectoryClient.prototype, "create", async () => ({}));
    t.mock.method(ShareDirectoryClient.prototype, "delete", async () => ({}));
    t.mock.method(ShareFileClient.prototype, "create", async function (this: ShareFileClient, size: number) {
      assert.match(this.url, /\/\.__archive-[^/]+\/content$/);
      state.contents.set(this.url, Buffer.alloc(size));
      return {};
    });
    t.mock.method(ShareFileClient.prototype, "uploadRange", async function (
      this: ShareFileClient, body: Buffer, offset: number, count: number, options: FileUploadRangeOptions,
    ) {
      state.assertLease(this.url, options.leaseAccessConditions?.leaseId);
      assert.equal(count, body.length);
      assert.ok(options.contentMD5);
      body.copy(state.contents.get(this.url)!, offset);
      return {};
    });
    t.mock.method(ShareClient.prototype, "getPermission", async (_key: string) => ({ permission: "sddl" }));
    t.mock.method(ShareClient.prototype, "createPermission", async (permission: string) => {
      assert.equal(permission, "sddl");
      return { filePermissionKey: "destination-permission" };
    });
    t.mock.method(ShareFileClient.prototype, "setProperties", async function (
      this: ShareFileClient, properties: FileProperties,
    ) {
      state.assertLease(this.url, properties.leaseAccessConditions?.leaseId);
      assert.equal(properties.filePermissionKey, "destination-permission");
      assert.equal(properties.lastWriteTime, lastWrite);
      assert.equal(properties.creationTime, lastWrite);
      assert.ok(properties.fileAttributes);
      return {};
    });
    t.mock.method(ShareFileClient.prototype, "rename", async function (
      this: ShareFileClient, path: string, options: FileRenameOptions,
    ) {
      state.assertLease(this.url, options.sourceLeaseAccessConditions?.leaseId);
      assert.equal(options.replaceIfExists, false);
      assert.equal(path, "file.txt");
      assert.equal(corrupt, false);
      const destinationFileClient = new ShareFileClient(
        "https://archiveaccount.file.core.windows.net/archive/file.txt", credential,
        { fileRequestIntent: "backup" },
      );
      state.contents.set(destinationFileClient.url, state.contents.get(this.url)!);
      state.leases.set(destinationFileClient.url, state.leases.get(this.url)!);
      state.leases.delete(this.url);
      state.contents.delete(this.url);
      state.events.push("renamed");
      return { destinationFileClient };
    });
    const rule = parseSettings(JSON.stringify({
      version: 1, rules: [{
        id: "test", source: { account: "sourceaccount", share: "source" },
        destination: { kind: "files", account: "archiveaccount", share: "archive" },
        olderThanDays: 90,
      }],
    })).rules[0]!;
    const storage = new AzureRuleStorage(rule, credential, new AbortController().signal, () => {});
    for await (const file of storage.list()) {
      const operation = moveFile(storage, file, cutoff, new AbortController().signal);
      if (corrupt) await assert.rejects(operation);
      else assert.equal(await operation, "moved");
    }
    assert.equal(state.sourceDeleted(), !corrupt);
    assert.equal(state.leases.size, 0);
    assert.deepEqual(state.events, corrupt ? [] : ["renamed", "source-deleted"]);
  });
}
