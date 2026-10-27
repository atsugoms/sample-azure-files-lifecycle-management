import { readFile } from "node:fs/promises";
import { parseSettings } from "./config.js";

try {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: npm run check-config -- <settings.json>");
  const settings = parseSettings(await readFile(path, "utf8"));
  console.log(JSON.stringify({ valid: true, rules: settings.rules.length, dryRun: settings.dryRun }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
