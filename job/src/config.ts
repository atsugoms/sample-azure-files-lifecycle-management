import { z } from "zod";

const account = z.string().regex(/^[a-z0-9]{3,24}$/);
const resourceName = z.string().min(3).max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const relativePath = z.string().max(900).refine(
  (path) => path === "" || path.split("/").every(
    (part) => part.length > 0 && part !== "." && part !== ".."
      && !/[\\\u0000-\u001f":<>|?*]/.test(part) && !/[. ]$/.test(part),
  ),
  "Use a relative Azure path with '/' separators, without dot segments or trailing dots/spaces",
);
const filesLocation = z.object({
  account,
  share: resourceName,
  path: relativePath.default(""),
}).strict();
const destination = z.discriminatedUnion("kind", [
  filesLocation.extend({ kind: z.literal("files") }),
  z.object({
    kind: z.literal("blob"),
    account,
    container: resourceName,
    path: relativePath.default(""),
    tier: z.enum(["Hot", "Cool", "Cold"]).default("Cool"),
  }).strict(),
]);
const rule = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  source: filesLocation,
  destination,
  olderThanDays: z.number().int().min(1).max(36500),
}).strict();
const settingsSchema = z.object({
  version: z.literal(1),
  dryRun: z.boolean().default(true),
  maxFilesPerRun: z.number().int().min(1).max(100000).default(1000),
  rules: z.array(rule).min(1).max(20),
}).strict().superRefine((settings, ctx) => {
  const seen = new Set<string>();
  for (const [index, current] of settings.rules.entries()) {
    if (seen.has(current.id)) {
      ctx.addIssue({ code: "custom", path: ["rules", index, "id"], message: "Duplicate rule id" });
    }
    seen.add(current.id);
    for (const [otherIndex, other] of settings.rules.entries()) {
      if (current.destination.kind === "files"
        && sameShare(current.destination, other.source)) {
        ctx.addIssue({
          code: "custom", path: ["rules", index, "destination"],
          message: "A destination share must not be a source share in any rule",
        });
      }
      if (otherIndex <= index) continue;
      if (sameShare(current.source, other.source)
        && overlaps(current.source.path, other.source.path)) {
        ctx.addIssue({ code: "custom", path: ["rules", index], message: "Overlapping source paths" });
      }
      if (sameDestination(current.destination, other.destination)
        && overlaps(current.destination.path, other.destination.path)) {
        ctx.addIssue({ code: "custom", path: ["rules", index], message: "Overlapping destination paths" });
      }
    }
  }
});

export type Settings = z.infer<typeof settingsSchema>;
export type Rule = Settings["rules"][number];
export type FilesLocation = Rule["source"];
export type Destination = Rule["destination"];

function sameShare(a: FilesLocation, b: FilesLocation): boolean {
  return a.account === b.account && a.share === b.share;
}

function sameDestination(a: Destination, b: Destination): boolean {
  return a.kind === b.kind && a.account === b.account
    && (a.kind === "files" && b.kind === "files" ? a.share === b.share
      : a.kind === "blob" && b.kind === "blob" && a.container === b.container);
}

function overlaps(a: string, b: string): boolean {
  const first = a.toLowerCase();
  const second = b.toLowerCase();
  return !first || !second || first === second
    || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

export function parseSettings(text: string): Settings {
  return settingsSchema.parse(JSON.parse(text));
}

export function joinPath(...parts: string[]): string {
  return parts.filter((part) => part !== "").join("/");
}
