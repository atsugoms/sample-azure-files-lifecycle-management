import type { HistoryRepository, Page } from "./history.js";
import { HistoryError } from "./history.js";

export type Command =
  | { kind: "run" }
  | { kind: "resume"; runId: string; recover: boolean }
  | { kind: "list"; page: Page }
  | { kind: "show" | "progress"; runId: string; page: Page };

export function parseCommand(args: string[]): Command {
  if (!args.length) return { kind: "run" };
  if (args[0] === "resume" && args[1] && args.length <= 3 && (args.length === 2 || args[2] === "--recover")) {
    validateId(args[1]);
    return { kind: "resume", runId: args[1], recover: args[2] === "--recover" };
  }
  if (args[0] !== "history" || !["list", "show", "progress"].includes(args[1] ?? "")) throw usage();
  const kind = args[1] as "list" | "show" | "progress";
  const start = kind === "list" ? 2 : 3;
  if (kind !== "list") validateId(args[2] ?? "");
  const page = { limit: 50, offset: 0 };
  const seen = new Set<string>();
  for (let i = start; i < args.length; i += 2) {
    const flag = args[i]!;
    if (kind === "progress" || !["--limit", "--offset"].includes(flag) || seen.has(flag)) throw usage();
    seen.add(flag);
    const value = args[i + 1];
    if (!value || !/^\d+$/.test(value)) throw usage();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || (flag === "--limit" ? number < 1 || number > 1000 : number < 0)) throw usage();
    if (flag === "--limit") page.limit = number;
    else page.offset = number;
  }
  return kind === "list" ? { kind, page } : { kind, runId: args[2]!, page };
}

export async function readHistory(repository: HistoryRepository, command: Command): Promise<unknown> {
  if (command.kind === "list") return { page: command.page, runs: await repository.listRuns(command.page) };
  if (command.kind === "progress") return repository.progress(command.runId);
  if (command.kind === "show") {
    return {
      run: await repository.getRun(command.runId), page: command.page,
      attempts: await repository.listAttempts(command.runId, command.page),
      files: await repository.listFiles(command.runId, command.page),
    };
  }
  throw usage();
}

function validateId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw usage();
}
function usage(): HistoryError {
  return new HistoryError(
    "Usage: npm start -- [history list [--limit 1..1000] [--offset N] | "
    + "history show <runId> [--limit 1..1000] [--offset N] | history progress <runId> | resume <runId> [--recover]]");
}
