import { createHash } from "node:crypto";
import type { Settings } from "./config.js";
import { ConflictError, type ArchiveWriter, type FileInfo, type LockedFile,
  type Log, type RuleStorage, type StorageFactory, type Summary } from "./model.js";

export const BLOCK_SIZE = 4 * 1024 * 1024;
// A block blob supports 50,000 blocks; keep a single bounded-memory transfer strategy.
export const MAX_FILE_SIZE = BLOCK_SIZE * 50000;

export function isOldEnough(file: FileInfo, cutoff: number): boolean {
  if (!Number.isFinite(file.lastWrite.getTime()) || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error("Invalid source file properties");
  }
  return file.lastWrite.getTime() < cutoff;
}

export async function moveFile(
  storage: RuleStorage, file: FileInfo, cutoff: number, signal: AbortSignal,
): Promise<"moved" | "changed"> {
  signal.throwIfAborted();
  const source = await storage.lock(file);
  let archive: ArchiveWriter | undefined;
  let outcome: "moved" | "changed" = "changed";
  const errors: unknown[] = [];
  try {
    signal.throwIfAborted();
    if (source.info.version === file.version && isOldEnough(source.info, cutoff)) {
      if (await storage.destinationExists(source.info)) {
        throw new ConflictError("Destination exists; source retained; manual reconciliation required");
      }
      archive = await storage.createArchive(source);
      const hash = createHash("sha256");
      for (let offset = 0; offset < source.info.size; offset += BLOCK_SIZE) {
        signal.throwIfAborted();
        const count = Math.min(BLOCK_SIZE, source.info.size - offset);
        const data = await source.read(offset, count);
        if (data.length !== count) throw new Error("Source download length mismatch");
        hash.update(data);
        await archive.write(data, offset);
      }
      signal.throwIfAborted();
      await archive.seal();
      await archive.verify(source.info.size, hash.digest("hex"));
      await source.assertUnchanged();
      await archive.publish();
      signal.throwIfAborted();
      await archive.assertProtected();
      await source.assertUnchanged();
      signal.throwIfAborted();
      await source.delete();
      outcome = "moved";
    }
  } catch (error) {
    errors.push(error);
  } finally {
    await releaseResources(source, archive, errors);
  }
  if (errors.length) throw new AggregateError(errors, "Move or lease cleanup failed; inspect source and destination");
  return outcome;
}

async function releaseResources(
  source: LockedFile, archive: ArchiveWriter | undefined, errors: unknown[],
): Promise<void> {
  if (archive) {
    try { await archive.close(); } catch (error) { errors.push(error); }
  }
  try { await source.release(); } catch (error) { errors.push(error); }
}

export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof AggregateError) {
    return { message: error.message, causes: error.errors.map(describeError) };
  }
  if (error instanceof Error) {
    return {
      name: error.name, message: error.message,
      ...("code" in error ? { code: error.code } : {}),
    };
  }
  return { message: String(error) };
}

export async function run(
  settings: Settings, factory: StorageFactory, log: Log, signal: AbortSignal, now = new Date(),
): Promise<Summary> {
  const summary: Summary = {
    scanned: 0, eligible: 0, moved: 0, dryRun: 0, changed: 0, failed: 0, limitReached: false,
  };
  const stores = settings.rules.map((rule) => ({ rule, storage: factory(rule) }));
  // Fail before any deletion if a configured source/destination cannot be reached.
  for (const { storage } of stores) {
    signal.throwIfAborted();
    await storage.preflight();
  }
  for (const { rule, storage } of stores) {
    const cutoff = now.getTime() - rule.olderThanDays * 86400000;
    for await (const file of storage.list()) {
      signal.throwIfAborted();
      summary.scanned++;
      if (!isOldEnough(file, cutoff)) continue;
      if (summary.eligible >= settings.maxFilesPerRun) {
        summary.limitReached = true;
        log("limit_reached", { maxFilesPerRun: settings.maxFilesPerRun });
        log("summary", { ...summary });
        return summary;
      }
      summary.eligible++;
      const context = { rule: rule.id, path: file.path, bytes: file.size };
      try {
        if (file.size > MAX_FILE_SIZE) {
          throw new Error(`File exceeds supported limit of ${MAX_FILE_SIZE} bytes`);
        }
        if (await storage.destinationExists(file)) {
          throw new ConflictError("Destination exists; source retained; manual reconciliation required");
        }
        if (settings.dryRun) {
          summary.dryRun++;
          log("dry_run", context);
        } else {
          const outcome = await moveFile(storage, file, cutoff, signal);
          summary[outcome]++;
          log(outcome, context);
        }
      } catch (error) {
        summary.failed++;
        log("file_failed", { ...context, error: describeError(error) });
        signal.throwIfAborted();
      }
    }
  }
  log("summary", { ...summary });
  return summary;
}
