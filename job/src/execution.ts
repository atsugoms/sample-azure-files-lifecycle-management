import { createHash, randomUUID } from "node:crypto";
import { parseSettings, type Settings } from "./config.js";
import { describeError, run, type Execution } from "./engine.js";
import { HistoryError, type HistoryRepository, type RunRecord } from "./history.js";
import type { Log, StorageFactory, Summary } from "./model.js";

export async function createExecution(
  repository: HistoryRepository, settings: Settings, configuration: Record<string, string>,
  id: string = randomUUID(), now = new Date(),
): Promise<RunRecord> {
  settings = parseSettings(JSON.stringify(settings));
  const record: RunRecord = {
    id, settings, settingsHash: hashSettings(settings), configuration,
    referenceTime: now.toISOString(), createdAt: new Date().toISOString(), status: "running",
  };
  await repository.createRun(record);
  return record;
}

export async function execute(
  repository: HistoryRepository, record: RunRecord, factory: StorageFactory, log: Log,
  signal: AbortSignal, recover = false,
): Promise<Summary> {
  const settings = parseSettings(JSON.stringify(record.settings));
  if (hashSettings(settings) !== record.settingsHash || !Number.isFinite(Date.parse(record.referenceTime))) {
    throw new HistoryError("Saved execution settings or reference time are invalid");
  }
  const attempt = await repository.beginAttempt(record.id, recover);
  const execution: Execution = {
    repository, runId: record.id, attemptId: attempt.id, summary: attempt.summary, skipped: 0,
  };
  const attemptLog: Log = (event, details) => log(event, { ...details, attemptId: attempt.id });
  try {
    attemptLog("attempt_started", { referenceTime: record.referenceTime, recover });
    const summary = await run(settings, factory, attemptLog, signal, new Date(record.referenceTime), execution);
    signal.throwIfAborted();
    await repository.finishAttempt(attempt.id,
      summary.limitReached ? "limited" : summary.failed ? "completed_with_errors" : "succeeded",
      summary, execution.skipped, null);
    return summary;
  } catch (error) {
    try {
      await repository.finishAttempt(attempt.id, signal.aborted ? "interrupted" : "failed",
        execution.summary, execution.skipped, describeError(error));
    } catch (finishError) {
      throw new AggregateError([error, finishError], "Execution and history finalization failed");
    }
    throw error;
  }
}

function hashSettings(settings: Settings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}
