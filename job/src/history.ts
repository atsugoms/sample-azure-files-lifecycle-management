import type { Settings } from "./config.js";
import type { FileInfo, Summary } from "./model.js";

export type RunStatus = "running" | "succeeded" | "completed_with_errors" | "limited" | "interrupted" | "failed";
export type FileState = "processing" | "moved" | "dryRun" | "changed" | "failed" | "needs_review";
export type Phase = "checking" | "locking" | "copying" | "verifying" | "publishing" | "deleting" | "cleanup" | "finished";
export type ErrorDetails = Record<string, unknown>;
export interface Page { limit: number; offset: number }
export interface RunRecord {
  id: string;
  settings: Settings;
  settingsHash: string;
  referenceTime: string;
  createdAt: string;
  configuration: Record<string, string>;
  status: RunStatus;
}
export interface AttemptRecord {
  id: string;
  runId: string;
  ordinal: number;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  summary: Summary;
  skipped: number;
  owner: { host: string; pid: number };
  error: ErrorDetails | null;
}
export interface FileRecord {
  key: string;
  runId: string;
  attemptId: string;
  ruleId: string;
  path: string;
  relativePath: string;
  version: string;
  size: number;
  lastWrite: string;
  state: FileState;
  phase: Phase;
  bytes: number;
  updatedAt: string;
  error: ErrorDetails | null;
}
export interface Progress {
  run: RunRecord;
  latestAttempt: AttemptRecord | null;
  totals: Partial<Record<FileState, number>>;
  activeFiles: FileRecord[];
}
export interface HistoryRepository {
  createRun(record: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord>;
  listRuns(page: Page): Promise<RunRecord[]>;
  beginAttempt(runId: string, recover: boolean): Promise<AttemptRecord>;
  checkpoint(attemptId: string, summary: Summary, skipped: number): Promise<void>;
  shouldSkip(runId: string, ruleId: string, file: FileInfo): Promise<boolean>;
  startFile(attemptId: string, ruleId: string, file: FileInfo, summary: Summary, skipped: number): Promise<FileRecord>;
  updateFile(record: FileRecord, summary: Summary, skipped: number): Promise<void>;
  finishAttempt(attemptId: string, status: Exclude<RunStatus, "running">, summary: Summary,
    skipped: number, error: ErrorDetails | null): Promise<void>;
  listAttempts(runId: string, page: Page): Promise<AttemptRecord[]>;
  listFiles(runId: string, page: Page): Promise<FileRecord[]>;
  progress(runId: string): Promise<Progress>;
  assertOwnership(): Promise<void>;
  close(): Promise<void>;
}

export class HistoryError extends Error {
  override name = "HistoryError";
}

export function emptySummary(): Summary {
  return { scanned: 0, eligible: 0, moved: 0, dryRun: 0, changed: 0, failed: 0, limitReached: false };
}

export function validatePage(page: Page): void {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1000
    || !Number.isSafeInteger(page.offset) || page.offset < 0) {
    throw new HistoryError("Page requires limit 1..1000 and a nonnegative integer offset");
  }
}
