import type { Rule } from "./config.js";

export interface FileInfo {
  path: string;
  relativePath: string;
  size: number;
  lastWrite: Date;
  version: string;
}

export interface LockedFile {
  info: FileInfo;
  read(offset: number, count: number): Promise<Buffer>;
  assertUnchanged(): Promise<void>;
  delete(): Promise<void>;
  release(): Promise<void>;
}

export interface ArchiveWriter {
  write(data: Buffer, offset: number): Promise<void>;
  seal(): Promise<void>;
  verify(size: number, sha256: string): Promise<void>;
  publish(): Promise<void>;
  assertProtected(): Promise<void>;
  close(): Promise<void>;
}

export interface RuleStorage {
  preflight(): Promise<void>;
  list(): AsyncIterable<FileInfo>;
  lock(file: FileInfo): Promise<LockedFile>;
  destinationExists(file: FileInfo): Promise<boolean>;
  createArchive(file: LockedFile): Promise<ArchiveWriter>;
}

export type StorageFactory = (rule: Rule) => RuleStorage;
export type Log = (event: string, details: Record<string, unknown>) => void;

export interface Summary {
  scanned: number;
  eligible: number;
  moved: number;
  dryRun: number;
  changed: number;
  failed: number;
  limitReached: boolean;
}

export class ConflictError extends Error {
  override name = "ConflictError";
}
