import { openHistoryReader } from "./history.js";
import { createSettingsStore } from "./settings.js";
import { createApp } from "./server.js";
import { readHosting } from "./hosting.js";
import { createScheduleStore } from "./schedule.js";
import { createExecutionStore } from "./execution.js";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1..65535");
const settings = createSettingsStore();
const hosting = readHosting();
if (hosting.mode === "container-apps" && process.env.DB_DRIVER && process.env.DB_DRIVER !== "postgres") {
  throw new Error("Container Apps hosting requires persistent PostgreSQL history");
}
const history = await openHistoryReader({
  ...process.env,
  ...(hosting.mode === "container-apps" ? { DB_DRIVER: "postgres" } : {}),
});
const server = createApp({ settings, history, hosting, schedules: createScheduleStore(), executions: createExecutionStore() });
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  server.close((error) => {
    void history.close().then(() => {
      if (error) { console.error(error); process.exitCode = 1; }
    }).catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });
  });
  server.closeIdleConnections();
}
server.once("error", (error) => { console.error(error); process.exitCode = 1; stop(); });
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
server.listen(port, hosting.host, () => console.log(`Archive console: ${
  hosting.mode === "local" ? `http://127.0.0.1:${port}` : hosting.origin
}`));
