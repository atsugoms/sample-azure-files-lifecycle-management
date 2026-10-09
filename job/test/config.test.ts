import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { joinPath, parseSettings } from "../src/config.js";

function example(): Record<string, unknown> {
  return {
    version: 1,
    rules: [{
      id: "archive",
      source: { account: "sourceaccount", share: "source", path: "" },
      destination: { kind: "blob", account: "archiveaccount", container: "archive" },
      olderThanDays: 90,
    }],
  };
}

test("safe defaults and path joining", () => {
  const settings = parseSettings(JSON.stringify(example()));
  assert.equal(settings.dryRun, true);
  assert.equal(settings.maxFilesPerRun, 1000);
  assert.equal(settings.rules[0]?.destination.path, "");
  assert.equal(joinPath("", "日本語", "report.txt"), "日本語/report.txt");
});

test("both documented destination examples are valid", async () => {
  const settings = parseSettings(await readFile("settings.example.json", "utf8"));
  assert.equal(settings.rules.length, 2);
  assert.equal(settings.rules[1]?.destination.kind, "files");
});

test("reject invalid, misspelled and unsafe configuration before any data operations", () => {
  const base = example();
  for (const patch of [
    { version: 2 }, { dryrun: false }, { dryRun: "false" }, { rules: [] },
    { maxFilesPerRun: 0 }, { unexpected: "value" },
  ]) {
    assert.throws(() => parseSettings(JSON.stringify({ ...base, ...patch })));
  }
  assert.throws(() => parseSettings("{"));
  const rule = parseSettings(JSON.stringify(base)).rules[0]!;
  for (const path of ["/root", "root/", "..", "root/../secret", "a\\b", "a//b", "a.", "a "]) {
    assert.throws(() => parseSettings(JSON.stringify({
      ...base, rules: [{ ...rule, source: { ...rule.source, path } }],
    })));
  }
  for (const days of [0, -1, 0.5, "90"]) {
    assert.throws(() => parseSettings(JSON.stringify({ ...base, rules: [{ ...rule, olderThanDays: days }] })));
  }
  assert.throws(() => parseSettings(JSON.stringify({
    ...base, rules: [{ ...rule, destination: { ...rule.destination, tier: "Archive" } }],
  })));
});

test("reject same-share destinations, cycles, duplicate ids and overlapping paths", () => {
  const base = parseSettings(JSON.stringify(example()));
  const rule = base.rules[0]!;
  const other = { ...rule, id: "other" };
  assert.throws(() => parseSettings(JSON.stringify({ ...base, rules: [rule, rule] })));
  assert.throws(() => parseSettings(JSON.stringify({
    ...base, rules: [{ ...rule, destination: { kind: "files", ...rule.source } }],
  })));
  assert.throws(() => parseSettings(JSON.stringify({
    ...base, rules: [
      { ...rule, source: { ...rule.source, path: "Reports" } },
      { ...other, source: { ...rule.source, path: "reports/sub" },
        destination: { ...rule.destination, path: "different" } },
    ],
  })));
  assert.throws(() => parseSettings(JSON.stringify({
    ...base, rules: [rule, { ...other, source: { ...rule.source, share: "another" } }],
  })));
  assert.throws(() => parseSettings(JSON.stringify({
    ...base, rules: [
      { ...rule, destination: { kind: "files", account: "archiveaccount", share: "archive", path: "" } },
      { ...other, source: { account: "archiveaccount", share: "archive", path: "" },
        destination: { kind: "files", ...rule.source } },
    ],
  })));
});
