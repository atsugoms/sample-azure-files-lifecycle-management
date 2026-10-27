import { createHash, randomUUID } from "node:crypto";
import type { TokenCredential } from "@azure/identity";
import { BlobServiceClient, type BlockBlobClient, type ContainerClient } from "@azure/storage-blob";
import {
  ShareServiceClient, FileSystemAttributes, type ShareClient, type ShareFileClient,
  type FileGetPropertiesResponse, type FileHttpHeaders,
} from "@azure/storage-file-share";
import { joinPath, type FilesLocation, type Rule } from "./config.js";
import { BLOCK_SIZE } from "./engine.js";
import type { ArchiveWriter, FileInfo, LockedFile, Log, RuleStorage } from "./model.js";

function shareClient(location: FilesLocation, credential: TokenCredential): ShareClient {
  return new ShareServiceClient(
    `https://${location.account}.file.core.windows.net`, credential,
    { fileRequestIntent: "backup", allowTrailingDot: true, allowSourceTrailingDot: true,
      retryOptions: { maxTries: 3, tryTimeoutInMs: 30000 } },
  ).getShareClient(location.share);
}

function fileClient(share: ShareClient, path: string): ShareFileClient {
  const slash = path.lastIndexOf("/");
  return share.getDirectoryClient(slash < 0 ? "" : path.slice(0, slash))
    .getFileClient(path.slice(slash + 1));
}

function fileInfo(path: string, relativePath: string, properties: FileGetPropertiesResponse): FileInfo {
  const { fileLastWriteOn, contentLength, etag, fileId } = properties;
  if (!fileLastWriteOn || contentLength === undefined || !etag || !fileId) {
    throw new Error(`Missing SMB file properties: ${path}`);
  }
  return {
    path, relativePath, size: contentLength, lastWrite: fileLastWriteOn,
    version: JSON.stringify([fileId, etag, contentLength, fileLastWriteOn.toISOString()]),
  };
}

function cleanupSignal(): AbortSignal {
  return AbortSignal.timeout(15000);
}

function fileHeaders(properties: FileGetPropertiesResponse): FileHttpHeaders {
  return {
    fileContentType: properties.contentType ?? "application/octet-stream",
    fileContentEncoding: properties.contentEncoding ?? "",
    fileContentLanguage: properties.contentLanguage ?? "",
    fileContentDisposition: properties.contentDisposition ?? "",
    fileCacheControl: properties.cacheControl ?? "",
  };
}

async function verifyBytes(
  size: number, sha256: string, read: (offset: number, count: number) => Promise<Buffer>,
): Promise<void> {
  const hash = createHash("sha256");
  for (let offset = 0; offset < size; offset += BLOCK_SIZE) {
    const count = Math.min(BLOCK_SIZE, size - offset);
    const data = await read(offset, count);
    if (data.length !== count) throw new Error("Archive download length mismatch");
    hash.update(data);
  }
  if (hash.digest("hex") !== sha256) throw new Error("Archive SHA-256 verification failed");
}

class AzureLockedFile implements LockedFile {
  private deleted = false;

  constructor(
    readonly client: ShareFileClient,
    readonly share: ShareClient,
    readonly leaseId: string,
    readonly info: FileInfo,
    readonly properties: FileGetPropertiesResponse,
    private readonly signal: AbortSignal,
  ) {}

  async read(offset: number, count: number): Promise<Buffer> {
    return this.client.downloadToBuffer(offset, count, {
      abortSignal: this.signal, leaseAccessConditions: { leaseId: this.leaseId },
    });
  }

  async assertUnchanged(): Promise<void> {
    const properties = await this.client.getProperties({
      abortSignal: this.signal, leaseAccessConditions: { leaseId: this.leaseId },
    });
    if (fileInfo(this.info.path, this.info.relativePath, properties).version !== this.info.version) {
      throw new Error("Source changed while leased; deletion refused");
    }
  }

  async delete(): Promise<void> {
    await this.client.delete({
      abortSignal: this.signal, leaseAccessConditions: { leaseId: this.leaseId },
    });
    this.deleted = true;
  }

  async release(): Promise<void> {
    if (!this.deleted) {
      await this.client.getShareLeaseClient(this.leaseId).releaseLease({ abortSignal: cleanupSignal() });
    }
  }
}

class BlobArchive implements ArchiveWriter {
  private readonly blocks: string[] = [];
  private readonly blockPrefix = randomUUID();
  private etag: string | undefined;

  constructor(
    private readonly client: BlockBlobClient,
    private readonly leaseId: string,
    private readonly source: AzureLockedFile,
    private readonly tier: string,
    private readonly signal: AbortSignal,
  ) {}

  async write(data: Buffer, offset: number): Promise<void> {
    const id = Buffer.from(`${this.blockPrefix}-${String(offset / BLOCK_SIZE).padStart(6, "0")}`).toString("base64");
    await this.client.stageBlock(id, data, data.length, {
      abortSignal: this.signal, conditions: { leaseId: this.leaseId },
      transactionalContentMD5: createHash("md5").update(data).digest(),
    });
    this.blocks.push(id);
  }

  async seal(): Promise<void> {
    const properties = this.source.properties;
    const response = await this.client.commitBlockList(this.blocks, {
      abortSignal: this.signal, conditions: { leaseId: this.leaseId },
      tier: "Hot",
      blobHTTPHeaders: {
        blobContentType: properties.contentType ?? "application/octet-stream",
        blobContentEncoding: properties.contentEncoding ?? "",
        blobContentLanguage: properties.contentLanguage ?? "",
        blobContentDisposition: properties.contentDisposition ?? "",
        blobCacheControl: properties.cacheControl ?? "",
      },
      metadata: {
        ...properties.metadata,
        archive_source_url: Buffer.from(this.source.client.url).toString("base64"),
        archive_source_last_write: this.source.info.lastWrite.toISOString(),
        archive_source_created: properties.fileCreatedOn?.toISOString() ?? "",
        archive_source_attributes: properties.fileAttributes ?? "",
      },
    });
    if (!response.etag) throw new Error("Missing archive ETag after commit");
    this.etag = response.etag;
  }

  async verify(size: number, sha256: string): Promise<void> {
    const properties = await this.client.getProperties({
      abortSignal: this.signal, conditions: this.conditions(),
    });
    if (properties.contentLength !== size) throw new Error("Archive size mismatch");
    await verifyBytes(size, sha256, (offset, count) => this.client.downloadToBuffer(offset, count, {
      abortSignal: this.signal, conditions: this.conditions(),
    }));
  }

  async publish(): Promise<void> {
    await this.client.setAccessTier(this.tier, {
      abortSignal: this.signal, conditions: { leaseId: this.leaseId },
    });
  }

  async assertProtected(): Promise<void> {
    await this.client.getProperties({ abortSignal: this.signal, conditions: this.conditions() });
  }

  async close(): Promise<void> {
    await this.client.getBlobLeaseClient(this.leaseId).releaseLease({ abortSignal: cleanupSignal() });
  }

  private conditions(): { leaseId: string; ifMatch: string } {
    if (!this.etag) throw new Error("Blob is not committed");
    return { leaseId: this.leaseId, ifMatch: this.etag };
  }
}

class FilesArchive implements ArchiveWriter {
  constructor(
    private client: ShareFileClient,
    private readonly share: ShareClient,
    private readonly temporaryDirectory: string,
    private readonly destinationPath: string,
    private readonly leaseId: string,
    private readonly source: AzureLockedFile,
    private readonly signal: AbortSignal,
  ) {}

  async write(data: Buffer, offset: number): Promise<void> {
    await this.client.uploadRange(data, offset, data.length, {
      abortSignal: this.signal, leaseAccessConditions: { leaseId: this.leaseId },
      contentMD5: createHash("md5").update(data).digest(),
    });
  }

  async seal(): Promise<void> {
    const properties = this.source.properties;
    if (!properties.filePermissionKey || !properties.fileCreatedOn || !properties.fileAttributes) {
      throw new Error("Missing source SMB permissions or attributes");
    }
    const permission = await this.source.share.getPermission(properties.filePermissionKey, {
      abortSignal: this.signal,
    });
    const created = await this.share.createPermission(permission.permission, { abortSignal: this.signal });
    if (!created.filePermissionKey) throw new Error("Missing destination permission key");
    await this.client.setProperties({
      abortSignal: this.signal, leaseAccessConditions: { leaseId: this.leaseId },
      filePermissionKey: created.filePermissionKey,
      fileAttributes: FileSystemAttributes.parse(properties.fileAttributes),
      creationTime: properties.fileCreatedOn,
      lastWriteTime: this.source.info.lastWrite,
      fileHttpHeaders: fileHeaders(properties),
    });
  }

  async verify(size: number, sha256: string): Promise<void> {
    const properties = await this.client.getProperties({
      abortSignal: this.signal, leaseAccessConditions: { leaseId: this.leaseId },
    });
    if (properties.contentLength !== size) throw new Error("Archive size mismatch");
    await verifyBytes(size, sha256, (offset, count) => this.client.downloadToBuffer(offset, count, {
      abortSignal: this.signal, leaseAccessConditions: { leaseId: this.leaseId },
    }));
  }

  async publish(): Promise<void> {
    const result = await this.client.rename(this.destinationPath, {
      abortSignal: this.signal, replaceIfExists: false, ignoreReadOnly: false,
      sourceLeaseAccessConditions: { leaseId: this.leaseId },
    });
    this.client = result.destinationFileClient;
    await this.assertProtected();
    await this.share.getDirectoryClient(this.temporaryDirectory).delete({ abortSignal: this.signal });
  }

  async assertProtected(): Promise<void> {
    await this.client.getProperties({
      abortSignal: this.signal, leaseAccessConditions: { leaseId: this.leaseId },
    });
  }

  async close(): Promise<void> {
    await this.client.getShareLeaseClient(this.leaseId).releaseLease({ abortSignal: cleanupSignal() });
  }
}

export class AzureRuleStorage implements RuleStorage {
  private readonly source: ShareClient;
  private readonly files: ShareClient | undefined;
  private readonly blobs: ContainerClient | undefined;

  constructor(
    private readonly rule: Rule, credential: TokenCredential,
    private readonly signal: AbortSignal, private readonly log: Log,
  ) {
    this.source = shareClient(rule.source, credential);
    if (rule.destination.kind === "files") {
      this.files = shareClient(rule.destination, credential);
    } else {
      this.blobs = new BlobServiceClient(
        `https://${rule.destination.account}.blob.core.windows.net`, credential,
        { retryOptions: { maxTries: 3, tryTimeoutInMs: 30000 } },
      ).getContainerClient(rule.destination.container);
    }
  }

  async preflight(): Promise<void> {
    await this.source.getDirectoryClient(this.rule.source.path).getProperties({ abortSignal: this.signal });
    if (this.files) {
      await this.files.rootDirectoryClient.getProperties({ abortSignal: this.signal });
    }
    if (this.blobs) await this.blobs.getProperties({ abortSignal: this.signal });
  }

  async *list(): AsyncIterable<FileInfo> {
    const walk = async function* (
      share: ShareClient, base: string, relative: string, signal: AbortSignal,
    ): AsyncIterable<FileInfo> {
      const path = joinPath(base, relative);
      for await (const entry of share.getDirectoryClient(path).listFilesAndDirectories({ abortSignal: signal })) {
        signal.throwIfAborted();
        const child = joinPath(relative, entry.name);
        if (entry.kind === "directory") {
          yield* walk(share, base, child, signal);
        } else {
          const fullPath = joinPath(base, child);
          const properties = await fileClient(share, fullPath).getProperties({ abortSignal: signal });
          yield fileInfo(fullPath, child, properties);
        }
      }
    };
    yield* walk(this.source, this.rule.source.path, "", this.signal);
  }

  async lock(file: FileInfo): Promise<LockedFile> {
    const client = fileClient(this.source, file.path);
    const leaseId = randomUUID();
    this.log("source_lease_acquire", { rule: this.rule.id, url: client.url });
    await client.getShareLeaseClient(leaseId).acquireLease(-1, { abortSignal: this.signal });
    try {
      const properties = await client.getProperties({
        abortSignal: this.signal, leaseAccessConditions: { leaseId },
      });
      return new AzureLockedFile(
        client, this.source, leaseId, fileInfo(file.path, file.relativePath, properties), properties, this.signal,
      );
    } catch (error) {
      try {
        await client.getShareLeaseClient(leaseId).releaseLease({ abortSignal: cleanupSignal() });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Source inspection and lease cleanup failed");
      }
      throw error;
    }
  }

  async destinationExists(file: FileInfo): Promise<boolean> {
    const path = joinPath(this.rule.destination.path, file.relativePath);
    if (this.blobs) return this.blobs.getBlockBlobClient(path).exists({ abortSignal: this.signal });
    if (this.files) return fileClient(this.files, path).exists({ abortSignal: this.signal });
    throw new Error("No destination configured");
  }

  async createArchive(file: LockedFile): Promise<ArchiveWriter> {
    if (!(file instanceof AzureLockedFile)) throw new Error("Expected Azure source");
    const path = joinPath(this.rule.destination.path, file.info.relativePath);
    const leaseId = randomUUID();
    if (this.blobs && this.rule.destination.kind === "blob") {
      const client = this.blobs.getBlockBlobClient(path);
      this.log("archive_create", { rule: this.rule.id, url: client.url });
      await client.upload("", 0, {
        abortSignal: this.signal, conditions: { ifNoneMatch: "*" }, tier: "Hot",
      });
      await client.getBlobLeaseClient(leaseId).acquireLease(-1, { abortSignal: this.signal });
      return new BlobArchive(client, leaseId, file, this.rule.destination.tier, this.signal);
    }
    if (this.files) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      let current = "";
      for (const part of parent ? parent.split("/") : []) {
        current = joinPath(current, part);
        await this.files.getDirectoryClient(current).createIfNotExists({ abortSignal: this.signal });
      }
      // A unique, exclusively created directory prevents Create File from replacing another file.
      const temporaryDirectory = joinPath(parent, `.__archive-${randomUUID()}`);
      const directory = this.files.getDirectoryClient(temporaryDirectory);
      this.log("archive_create", {
        rule: this.rule.id, url: fileClient(this.files, path).url, temporaryDirectory,
      });
      await directory.create({ abortSignal: this.signal });
      const client = directory.getFileClient("content");
      await client.create(file.info.size, {
        abortSignal: this.signal, metadata: file.properties.metadata ?? {},
        fileHttpHeaders: fileHeaders(file.properties),
      });
      await client.getShareLeaseClient(leaseId).acquireLease(-1, { abortSignal: this.signal });
      return new FilesArchive(
        client, this.files, temporaryDirectory, path, leaseId, file, this.signal,
      );
    }
    throw new Error("No destination configured");
  }
}
