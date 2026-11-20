import assert from "node:assert/strict";
import { Client } from "pg";
import { AppConfigurationClient } from "@azure/app-configuration";
import { ShareServiceClient } from "@azure/storage-file-share";
import { BlobServiceClient } from "@azure/storage-blob";
import { createCredential } from "../dist/src/auth.js";
import { openHistory } from "../dist/src/history.js";
import { openHistoryReader } from "../../app/dist/src/history.js";
import { parseSettings } from "../dist/src/config.js";

const credential = createCredential(process.env);
const selector = { key: "archive:settings", label: "validation" };
const configuration = () => new AppConfigurationClient(process.env.APP_CONFIG_ENDPOINT, credential);
const expected = new Map([
  ["old-report.txt", { old: true, content: Buffer.from("Archive Console synthetic old report\n") }],
  ["recent-report.txt", { old: false, content: Buffer.from("Archive Console synthetic recent report\n") }],
]);
function storageClients() {
  const account = process.env.TEST_STORAGE_ACCOUNT;
  assert.match(account ?? "", /^[a-z0-9]{3,24}$/);
  return {
    files: new ShareServiceClient(`https://${account}.file.core.windows.net`, credential, { fileRequestIntent: "backup" }),
    blobs: new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential),
  };
}
async function adminDatabase(database, action) {
  assert.ok(process.env.DB_ADMIN_TOKEN);
  assert.ok(process.env.ADMIN_NAME);
  const db = new Client({
    host: process.env.PGHOST, database, user: process.env.ADMIN_NAME,
    password: process.env.DB_ADMIN_TOKEN,
    ssl: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeoutMillis: 15000, statement_timeout: 15000,
  });
  await db.connect();
  try { await action(db); } finally { await db.end(); }
}
async function verifyHistory() {
  const history = await openHistoryReader();
  try {
    const runs = await history.listRuns({ limit: 25, offset: 0 });
    assert.ok(runs.length, "Missing execution history");
    const run = runs[0];
    assert.equal(run.status, "succeeded");
    assert.equal(run.configuration?.dryRun, true);
    assert.equal(run.summary?.dryRun, 1);
    assert.deepEqual(await history.totals(run.runId), { dry_run: 1 });
    const files = await history.listFiles(run.runId, { limit: 25, offset: 0 });
    assert.equal(files.length, 1);
    assert.equal(files[0].status, "dry_run");
    assert.equal(files[0].dryRun, true);
    assert.equal(files[0].bytes, expected.get("old-report.txt").content.length);
    console.log(JSON.stringify({ event: "history_verified", runId: run.runId, status: run.status, files: files.length }));
  } finally { await history.close(); }
}

switch (process.argv[2]) {
  case "configure": {
    assert.equal(process.env.AUTH_MODE, "azure-cli");
    const account = process.env.TEST_STORAGE_ACCOUNT;
    assert.match(account ?? "", /^[a-z0-9]{3,24}$/);
    const settings = parseSettings(JSON.stringify({
      version: 1, dryRun: true, maxFilesPerRun: 100,
      rules: [{
        id: "documents-to-blob", source: { account, share: "source", path: "" },
        destination: { kind: "blob", account, container: "archive", path: "documents", tier: "Cool" },
        olderThanDays: 90,
      }],
    }));
    await configuration().addConfigurationSetting({
      ...selector, value: JSON.stringify(settings), contentType: "application/json",
    });
    console.log(JSON.stringify({ event: "configuration_created", dryRun: true, rules: settings.rules.length }));
    break;
  }
  case "bootstrap": {
    await adminDatabase("postgres", async (db) => {
      for (const [name, id] of [
        ["archive_job", process.env.JOB_PRINCIPAL_ID], ["archive_web", process.env.WEB_PRINCIPAL_ID],
      ]) {
        assert.match(id ?? "", /^[0-9a-f-]{36}$/i);
        assert.equal((await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name])).rowCount, 0,
          "Bootstrap is only for a newly created database");
        await db.query("SELECT * FROM pg_catalog.pgaadauth_create_principal_with_oid($1,$2,'service',false,false)", [name, id]);
      }
      await db.query("REVOKE ALL ON DATABASE executionlog FROM PUBLIC");
      await db.query("GRANT CONNECT ON DATABASE executionlog TO CURRENT_USER, archive_job, archive_web");
    });
    await adminDatabase("executionlog", async (db) => {
      await db.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      await db.query("GRANT USAGE, CREATE ON SCHEMA public TO archive_job");
      await db.query("GRANT USAGE ON SCHEMA public TO archive_web");
      await db.query("GRANT archive_job TO CURRENT_USER");
      try {
        await db.query("ALTER DEFAULT PRIVILEGES FOR ROLE archive_job IN SCHEMA public GRANT SELECT ON TABLES TO archive_web");
      } finally { await db.query("REVOKE archive_job FROM CURRENT_USER"); }
    });
    const history = await openHistory(process.env, credential, "managed-identity");
    await history.close();
    console.log(JSON.stringify({ event: "bootstrap_complete", database: "executionlog" }));
    break;
  }
  case "seed": {
    const { files } = storageClients();
    const directory = files.getShareClient("source").getDirectoryClient("");
    for (const [name, { old, content }] of expected) {
      const file = directory.getFileClient(name);
      assert.equal(await file.exists(), false, `Refusing to overwrite ${name}`);
      await file.create(content.length);
      await file.uploadRange(content, 0, content.length);
      const lastWriteTime = old ? new Date("2020-01-01T00:00:00Z") : new Date();
      await file.setProperties({ lastWriteTime });
      assert.equal((await file.getProperties()).fileLastWriteOn?.getTime(), lastWriteTime.getTime());
    }
    console.log(JSON.stringify({ event: "seed_complete", count: expected.size }));
    break;
  }
  case "verify": {
    const setting = await configuration().getConfigurationSetting(selector);
    assert.equal(parseSettings(setting.value).dryRun, true);
    await verifyHistory();
    const { files, blobs } = storageClients();
    const directory = files.getShareClient("source").getDirectoryClient("");
    const names = [];
    for await (const item of directory.listFilesAndDirectories()) names.push(item.name);
    assert.deepEqual(names.sort(), [...expected.keys()].sort());
    for (const [name, { old, content }] of expected) {
      const file = directory.getFileClient(name);
      assert.ok((await file.downloadToBuffer()).equals(content));
      const lastWrite = (await file.getProperties()).fileLastWriteOn;
      assert.ok(lastWrite);
      assert.equal(lastWrite.getUTCFullYear(), old ? 2020 : new Date().getUTCFullYear());
    }
    for await (const blob of blobs.getContainerClient("archive").listBlobsFlat()) {
      assert.fail(`Unexpected destination blob: ${blob.name}`);
    }
    console.log(JSON.stringify({ event: "storage_unchanged", sourceFiles: names, destinationEmpty: true }));
    break;
  }
  case "web-check": {
    const client = configuration();
    const before = await client.getConfigurationSetting(selector);
    assert.equal(parseSettings(before.value).dryRun, true);
    await client.setConfigurationSetting({ ...selector, value: before.value, etag: before.etag,
      contentType: "application/json" }, { onlyIfUnchanged: true });
    await verifyHistory();
    const token = await credential.getToken("https://ossrdbms-aad.database.windows.net/.default");
    const db = new Client({
      host: process.env.PGHOST, database: process.env.PGDATABASE, user: process.env.PGUSER,
      password: token.token, ssl: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      connectionTimeoutMillis: 15000,
    });
    await db.connect();
    try {
      const result = await db.query(`SELECT
        has_table_privilege(current_user,'public.execution_runs','SELECT') AS read,
        has_table_privilege(current_user,'public.execution_runs','INSERT,UPDATE,DELETE') AS write`);
      assert.equal(result.rows[0].read, true);
      assert.equal(result.rows[0].write, false);
    } finally { await db.end(); }
    console.log(JSON.stringify({ event: "web_backends_verified", configurationWritable: true, historyReadOnly: true }));
    break;
  }
  default: throw new Error("Use configure, bootstrap, seed, verify or web-check");
}
