const $ = (id) => document.getElementById(id);
const pageSize = 25;
const state = {
  settings: null, etag: null, dirty: false, saving: false, selected: null,
  offsets: { runs: 0, files: 0 },
  counts: { runs: 0, files: 0 },
  schedule: null, scheduleDirty: false, scheduleSaving: false,
  execution: null, executionPreparing: false, executionStarting: false, executionConfirmation: null,
};
const labels = {
  running: "実行中／結果未確定", succeeded: "正常終了", limit_reached: "上限到達",
  failed: "失敗", moved: "移動済み", dry_run: "Dry-run", changed: "変更を検出",
};
const formatDate = (text) => text ? new Date(text).toLocaleString("ja-JP", { hour12: false }) : "—";
const formatNumber = (n) => Number(n).toLocaleString("ja-JP");
function bytes(n) {
  if (n < 1024) return `${formatNumber(n)} B`;
  const exponent = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return `${(n / 1024 ** exponent).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB"][exponent]}`;
}
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").className = error ? "error" : "";
  $("notice").hidden = false;
}
async function api(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
async function action(button, work) {
  button.disabled = true;
  try { await work(); }
  catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}
function badge(status) {
  const color = ["succeeded", "moved"].includes(status) ? "good"
    : status === "failed" ? "bad"
    : ["limit_reached", "changed"].includes(status) ? "warn" : "info";
  return node("span", labels[status] ?? status, `badge ${color}`);
}
function empty(tbody, columns, message) {
  tbody.replaceChildren();
  const tr = node("tr");
  const td = node("td", message, "empty");
  td.colSpan = columns;
  tr.append(td);
  tbody.append(tr);
}
function cell(parent, content, secondary) {
  const td = node("td");
  td.append(typeof content === "string" ? node("span", content) : content);
  if (secondary) td.append(node("small", secondary));
  parent.append(td);
  return td;
}
function errorText(error) {
  return error ? JSON.stringify(error, null, 2) : "—";
}
function pager(kind, count) {
  state.counts[kind] = count;
  $(`${kind}-prev`).disabled = state.offsets[kind] === 0;
  $(`${kind}-next`).disabled = count < pageSize;
  $(`${kind}-page`).textContent = `${state.offsets[kind] / pageSize + 1} ページ`;
}
async function loadRuns() {
  const offset = state.offsets.runs;
  const runs = await api(`/api/runs?limit=${pageSize}&offset=${offset}`);
  if (offset !== state.offsets.runs) return;
  const body = $("runs");
  body.replaceChildren();
  for (const run of runs) {
    const tr = node("tr");
    if (run.runId === state.selected) tr.className = "selected-run";
    cell(tr, node("code", run.runId), formatDate(run.startedAt));
    cell(tr, badge(run.status));
    const dryRun = run.configuration?.dryRun;
    cell(tr, node("span", typeof dryRun !== "boolean" ? "未記録" : dryRun ? "Dry-run" : "実移動",
      `badge ${dryRun === false ? "warn" : "info"}`));
    cell(tr, typeof run.configuration?.ruleCount === "number" ? `${run.configuration.ruleCount} ルール` : "未記録");
    const button = node("button", "詳細を見る →", "text-button");
    button.addEventListener("click", () => action(button, () => selectRun(run.runId)));
    cell(tr, button);
    body.append(tr);
  }
  if (!runs.length) empty(body, 5, "実行履歴はありません。ジョブを実行すると、ここに表示されます。");
  pager("runs", runs.length);
}
async function selectRun(id) {
  state.selected = id;
  state.offsets.files = 0;
  $("run-detail").hidden = false;
  $("detail-id").textContent = id;
  $("run-record").textContent = "";
  $("metrics").replaceChildren();
  empty($("files"), 5, "読み込み中…");
  await loadDetail();
  $("run-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function loadDetail() {
  const id = state.selected;
  const progress = await api(`/api/runs/${encodeURIComponent(id)}`);
  if (id !== state.selected) return;
  $("metrics").replaceChildren();
  for (const [label, value] of [
    ["移動済み", progress.totals.moved ?? 0],
    ["Dry-run", progress.totals.dry_run ?? 0],
    ["失敗", progress.totals.failed ?? 0],
    ["実行中／結果未確定", progress.totals.running ?? 0],
  ]) {
    const metric = node("div", undefined, "metric");
    metric.append(node("span", label), node("strong", formatNumber(value)));
    $("metrics").append(metric);
  }
  $("run-record").textContent = JSON.stringify(progress.run, null, 2);
  await loadFiles();
}
async function loadFiles() {
  const id = state.selected;
  const offset = state.offsets.files;
  const files = await api(`/api/runs/${encodeURIComponent(id)}/files?limit=${pageSize}&offset=${offset}`);
  if (id !== state.selected || offset !== state.offsets.files) return;
  const body = $("files");
  body.replaceChildren();
  for (const file of files) {
    const tr = node("tr");
    const source = cell(tr, file.sourceUrl, `ルール: ${file.ruleId}`);
    source.append(node("small", `移動先: ${file.destinationUrl}`),
      node("small", `元の最終書き込み: ${formatDate(file.sourceLastWrite)} / バージョン: ${file.sourceVersion}`));
    cell(tr, badge(file.status));
    cell(tr, bytes(file.bytes), file.dryRun ? "Dry-run" : "実移動");
    cell(tr, formatDate(file.startedAt), `終了: ${formatDate(file.finishedAt)}`);
    cell(tr, errorText(file.error));
    body.append(tr);
  }
  if (!files.length) empty(body, 5, "このページにファイルの処理記録はありません。");
  pager("files", files.length);
}
function markDirty() {
  state.dirty = true;
  $("dirty-label").textContent = "未保存の変更があります";
}
function inputField(label, value, name, { type = "text", min, max, full = false, required = true } = {}) {
  const wrapper = node("label", label, full ? "full" : "");
  const input = node("input");
  input.type = type;
  input.name = name;
  input.value = value;
  input.required = required;
  if (min !== undefined) input.min = min;
  if (max !== undefined) input.max = max;
  wrapper.append(input);
  return wrapper;
}
function selectField(label, values, value, name) {
  const wrapper = node("label", label);
  const select = node("select");
  select.name = name;
  for (const [key, title] of values) {
    const option = node("option", title);
    option.value = key;
    option.selected = key === value;
    select.append(option);
  }
  wrapper.append(select);
  return wrapper;
}
function updateRuleNumbers() {
  [...$("rules").children].forEach((rule, index) => {
    rule.querySelector("h3").textContent = `RULE ${String(index + 1).padStart(2, "0")}`;
  });
  $("add-rule").disabled = $("rules").children.length >= 20;
}
function renderRule(rule) {
  const card = node("article", undefined, "panel rule");
  const header = node("div", undefined, "rule-header");
  const remove = node("button", "ルールを削除", "remove-rule");
  remove.type = "button";
  remove.addEventListener("click", () => {
    if ($("rules").children.length === 1) { notice("少なくとも 1 ルールが必要です。", true); return; }
    card.remove();
    updateRuleNumbers();
    markDirty();
  });
  header.append(node("h3", "RULE"), remove);
  const general = node("div", undefined, "rule-general");
  general.append(inputField("ルール ID", rule.id, "id"),
    inputField("対象期間（日より前）", rule.olderThanDays, "olderThanDays", { type: "number", min: 1, max: 36500 }));
  const locations = node("div", undefined, "locations");
  const source = node("div", undefined, "location");
  source.append(node("h4", "SOURCE · Azure Files"),
    inputField("ストレージアカウント", rule.source.account, "source.account"),
    inputField("ファイル共有", rule.source.share, "source.share"),
    inputField("対象パス（共有直下は空欄）", rule.source.path, "source.path", { full: true, required: false }));
  const destination = node("div", undefined, "location");
  const kind = selectField("保存先の種類", [["blob", "Blob Storage"], ["files", "Azure Files"]], rule.destination.kind, "destination.kind");
  const resource = inputField(rule.destination.kind === "blob" ? "コンテナー" : "ファイル共有",
    rule.destination.kind === "blob" ? rule.destination.container : rule.destination.share, "destination.resource");
  const tier = selectField("アクセス層", [["Hot", "Hot"], ["Cool", "Cool"], ["Cold", "Cold"]],
    rule.destination.kind === "blob" ? rule.destination.tier : "Cool", "destination.tier");
  kind.querySelector("select").addEventListener("change", (event) => {
    resource.firstChild.textContent = event.target.value === "blob" ? "コンテナー" : "ファイル共有";
    tier.hidden = event.target.value !== "blob";
  });
  tier.hidden = rule.destination.kind !== "blob";
  destination.append(node("h4", "DESTINATION · 保存先"), kind,
    inputField("ストレージアカウント", rule.destination.account, "destination.account"),
    resource, tier, inputField("保存先パス（直下は空欄）", rule.destination.path, "destination.path", { full: true, required: false }));
  locations.append(source, destination);
  card.append(header, general, locations);
  $("rules").append(card);
  updateRuleNumbers();
}
function readForm() {
  return {
    version: 1, dryRun: $("dry-run").checked, maxFilesPerRun: Number($("max-files").value),
    rules: [...$("rules").children].map((card) => {
      const get = (name) => [...card.querySelectorAll("input,select")].find((item) => item.name === name).value;
      const kind = get("destination.kind");
      return {
        id: get("id"), olderThanDays: Number(get("olderThanDays")),
        source: { account: get("source.account"), share: get("source.share"), path: get("source.path") },
        destination: {
          kind, account: get("destination.account"), path: get("destination.path"),
          ...(kind === "blob" ? { container: get("destination.resource"), tier: get("destination.tier") } : { share: get("destination.resource") }),
        },
      };
    }),
  };
}
async function loadSettings() {
  const document = await api("/api/settings");
  state.settings = document.settings;
  state.etag = document.etag;
  state.dirty = false;
  $("dry-run").checked = document.settings.dryRun;
  $("max-files").value = document.settings.maxFilesPerRun;
  $("rules").replaceChildren();
  document.settings.rules.forEach(renderRule);
  $("live-warning").hidden = document.settings.dryRun;
  $("config-source").textContent = `キー: ${document.source.key}  /  ラベル: ${document.source.label || "（なし）"}`;
  $("dirty-label").textContent = "変更はありません";
  $("settings-fields").disabled = false;
}
async function switchView(view) {
  $("history-view").hidden = view !== "history";
  $("settings-view").hidden = view !== "settings";
  $("schedule-view").hidden = view !== "schedule";
  for (const name of ["history", "settings", "schedule"]) {
    $(`nav-${name}`).classList.toggle("active", name === view);
    if (name === view) $(`nav-${name}`).setAttribute("aria-current", "page");
    else $(`nav-${name}`).removeAttribute("aria-current");
  }
  $("notice").hidden = true;
  if (view === "settings" && !state.settings) await loadSettings();
  if (view === "schedule" && !state.schedule) await loadSchedule();
}
for (const view of ["history", "settings", "schedule"]) {
  $(`nav-${view}`).addEventListener("click", () => action($(`nav-${view}`), () => switchView(view)));
}
$("refresh-history").addEventListener("click", () => action($("refresh-history"), loadRuns));
$("refresh-detail").addEventListener("click", () => action($("refresh-detail"), loadDetail));
for (const kind of ["runs", "files"]) {
  for (const direction of ["prev", "next"]) {
    const button = $(`${kind}-${direction}`);
    button.addEventListener("click", async () => {
      const previous = state.offsets[kind];
      state.offsets[kind] += direction === "next" ? pageSize : -pageSize;
      $(`${kind}-prev`).disabled = true;
      $(`${kind}-next`).disabled = true;
      try { await ({ runs: loadRuns, files: loadFiles })[kind](); }
      catch (error) { state.offsets[kind] = previous; notice(error.message, true); pager(kind, state.counts[kind]); }
    });
  }
}
$("reload-settings").addEventListener("click", () => {
  if (state.dirty && !window.confirm("未保存の変更を破棄して、設定を読み直しますか？")) return;
  void action($("reload-settings"), loadSettings);
});
$("add-rule").addEventListener("click", () => {
  if ($("rules").children.length >= 20) return;
  renderRule({
    id: `rule-${crypto.randomUUID().slice(0, 8)}`, olderThanDays: 90,
    source: { account: "", share: "", path: "" },
    destination: { kind: "blob", account: "", container: "", path: "", tier: "Cool" },
  });
  markDirty();
});
$("settings-form").addEventListener("input", markDirty);
$("settings-form").addEventListener("change", markDirty);
$("dry-run").addEventListener("change", () => { $("live-warning").hidden = $("dry-run").checked; });
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.saving) return;
  $("save-description").textContent = $("dry-run").checked
    ? "Dry-run モードで保存します。ファイルのコピー・削除は行いません。"
    : "実移動モードで保存します。次回の新規実行では、コピー・検証後に元ファイルが削除されます。";
  $("save-dialog").returnValue = "cancel";
  $("save-dialog").showModal();
});
$("save-dialog").addEventListener("close", async () => {
  if ($("save-dialog").returnValue !== "save" || state.saving) return;
  state.saving = true;
  const settings = readForm();
  $("settings-fields").disabled = true;
  $("reload-settings").disabled = true;
  try {
    const result = await api("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json", "If-Match": state.etag, "X-Archive-Request": "1" },
      body: JSON.stringify(settings),
    });
    state.settings = result.settings;
    state.etag = result.etag;
    state.dirty = false;
    $("dirty-label").textContent = "保存済み";
    notice("設定を保存しました。次回の新規実行から反映されます。");
  } catch (error) { notice(error.message, true); }
  finally {
    state.saving = false;
    $("settings-fields").disabled = false;
    $("reload-settings").disabled = false;
  }
});
window.addEventListener("beforeunload", (event) => {
  if (state.dirty || state.scheduleDirty || state.executionStarting) { event.preventDefault(); event.returnValue = ""; }
});
function readScheduleForm() {
  const frequency = $("schedule-frequency").value;
  return { enabled: $("schedule-enabled").checked, frequency, time: $("schedule-time").value,
    weekdays: frequency === "weekly" ? [...$("schedule-weekdays").querySelectorAll("input:checked")].map((input) => Number(input.value)) : [] };
}
function previewSchedule() {
  const value = readScheduleForm();
  $("schedule-weekdays").hidden = value.frequency !== "weekly";
  const [hour, minute] = value.time.split(":").map(Number);
  const days = value.frequency === "daily" ? "*" : value.weekdays
    .map((day) => (day + (hour < 9 ? 6 : 0)) % 7).sort((a, b) => a - b).join(",");
  $("schedule-cron").textContent = value.time && days ? `${minute} ${(hour + 15) % 24} * * ${days}` : "曜日・時刻を指定してください";
}
function renderSchedule(document) {
  state.schedule = document;
  state.scheduleDirty = false;
  const value = document.settings;
  $("schedule-source").textContent = `対象ジョブ: ${document.jobName} / Azure トリガー: ${document.trigger}${document.updating ? "（更新中）" : ""}`;
  $("schedule-unsupported").hidden = value !== null;
  $("schedule-fields").disabled = !value || document.updating;
  $("schedule-dirty").textContent = document.updating ? "Azure の更新完了後に再読み込みしてください" : "変更はありません";
  $("schedule-next").textContent = document.nextRun
    ? new Date(document.nextRun).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) : "定期実行は無効です";
  if (value) {
    $("schedule-enabled").checked = value.enabled;
    $("schedule-frequency").value = value.frequency;
    $("schedule-time").value = value.time;
    for (const input of $("schedule-weekdays").querySelectorAll("input")) input.checked = value.weekdays.includes(Number(input.value));
    previewSchedule();
  } else {
    $("schedule-cron").textContent = document.cronUtc ?? "—";
    $("schedule-next").textContent = "この画面では計算できません";
  }
}
async function loadSchedule() {
  const [document, config] = await Promise.all([api("/api/schedule"), api("/api/settings")]);
  renderSchedule(document);
  $("schedule-mode").textContent = config.settings.dryRun
    ? "読み込み時のアーカイブ設定: Dry-run。実行時の設定が適用されます。"
    : "読み込み時のアーカイブ設定: 実移動。自動実行では元ファイルが削除されるため注意してください。";
  $("schedule-mode").hidden = false;
  await loadExecution();
}
$("reload-schedule").addEventListener("click", () => {
  if (state.scheduleDirty && !window.confirm("未保存のスケジュール変更を破棄して再読み込みしますか？")) return;
  void action($("reload-schedule"), loadSchedule);
});
function markScheduleDirty() {
  state.scheduleDirty = true;
  $("schedule-dirty").textContent = "未保存の変更があります";
  previewSchedule();
}
$("schedule-form").addEventListener("input", markScheduleDirty);
$("schedule-form").addEventListener("change", markScheduleDirty);
$("schedule-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.scheduleSaving || !state.schedule?.settings) return;
  const value = readScheduleForm();
  if (value.frequency === "weekly" && !value.weekdays.length) { notice("実行曜日を 1 つ以上選択してください。", true); return; }
  $("schedule-description").textContent = value.enabled
    ? `定期実行を有効にします。${value.frequency === "daily" ? "毎日" : `毎週 ${value.weekdays.map((day) => "日月火水木金土"[day]).join("・")}曜日`} ${value.time}（日本時間）に自動実行されます。`
    : "定期実行を無効にして、手動実行のみにします。時刻・曜日は保持します。実行中のジョブは停止しません。";
  $("schedule-dialog").returnValue = "cancel";
  $("schedule-dialog").showModal();
});
$("schedule-dialog").addEventListener("close", async () => {
  if ($("schedule-dialog").returnValue !== "save" || state.scheduleSaving) return;
  const value = readScheduleForm();
  state.scheduleSaving = true;
  $("schedule-fields").disabled = true;
  $("run-now").disabled = true;
  $("reload-schedule").disabled = true;
  try {
    const result = await api("/api/schedule", { method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": state.schedule.revision, "X-Archive-Request": "1" },
      body: JSON.stringify(value) });
    renderSchedule(result);
    $("schedule-dirty").textContent = "保存済み";
    notice(value.enabled ? "スケジュールを保存し、定期実行を有効にしました。" : "スケジュールを保存しました。定期実行は無効です。");
  } catch (error) { notice(`${error.message} Azure 側で更新が継続している場合があるため、再保存の前に再読み込みしてください。`, true); }
  finally {
    state.scheduleSaving = false;
    $("schedule-fields").disabled = !state.schedule?.settings || state.schedule.updating;
    $("reload-schedule").disabled = false;
    renderExecution();
  }
});
function renderExecution() {
  const current = state.execution;
  $("run-now").disabled = state.executionPreparing || state.executionStarting || !!state.executionConfirmation || state.scheduleSaving || !current
    || current.updating || current.pending || current.active.length > 0;
  if (!current) return;
  $("execution-status").textContent = current.uncertain
    ? "起動結果が不明です。再起動せず、Azure の実行履歴・ログを確認してください。"
    : current.pending ? "起動要求を送信済みです。実行状況を更新して確認してください。"
    : current.active.length ? `実行中・状態確認が必要なジョブ: ${current.active.map((item) => `${item.name} (${item.status})`).join("、")}`
    : current.updating ? "Azure がジョブを更新中です。完了後に実行状況を更新してください。"
    : "起動できます。Azure の実行履歴に、実行中のジョブはありません。";
}
async function loadExecution() {
  state.execution = null;
  $("run-now").disabled = true;
  $("execution-status").textContent = "Azure の実行状況を確認中です。";
  try { state.execution = await api("/api/execution"); }
  catch (error) { $("execution-status").textContent = "実行状況を取得できません。権限・接続を確認して更新してください。"; throw error; }
  renderExecution();
}
$("refresh-execution").addEventListener("click", () => void action($("refresh-execution"), loadExecution));
$("run-now").addEventListener("click", async () => {
  if (state.executionPreparing || state.executionStarting || state.executionConfirmation || state.scheduleSaving) return;
  state.executionPreparing = true;
  $("run-now").disabled = true;
  try {
    const [config] = await Promise.all([api("/api/settings"), loadExecution()]);
    const current = state.execution;
    if (!current || current.updating || current.pending || current.active.length) return;
    state.executionConfirmation = { etag: config.etag, requestId: crypto.randomUUID() };
    $("execution-description").textContent = config.settings.dryRun
      ? "保存済みの設定は Dry-run です。対象を確認し、ファイルのコピー・削除は行いません。"
      : "保存済みの設定は実移動モードです。コピー・検証後に元ファイルが削除されます。対象を確認してください。";
    $("execution-dialog").returnValue = "cancel";
    $("execution-dialog").showModal();
  } catch (error) { notice(error.message, true); }
  finally { state.executionPreparing = false; renderExecution(); }
});
$("execution-dialog").addEventListener("close", async () => {
  const confirmation = state.executionConfirmation;
  state.executionConfirmation = null;
  if ($("execution-dialog").returnValue !== "start" || !confirmation || state.executionStarting) { renderExecution(); return; }
  state.executionStarting = true;
  $("run-now").disabled = true;
  $("refresh-execution").disabled = true;
  $("schedule-fields").disabled = true;
  $("execution-status").textContent = "起動要求を送信中です。この画面から再送しないでください。";
  try {
    const result = await api("/api/execution", { method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": confirmation.etag, "X-Archive-Request": "1" },
      body: JSON.stringify({ requestId: confirmation.requestId }) });
    notice(`起動を受け付けました${result.executionName ? `（Azure 実行名: ${result.executionName}）` : ""}。完了ではありません。「実行状況を更新」と「実行履歴」で確認してください。`);
    $("execution-status").textContent = "起動を受け付けました。実行状況を更新して確認してください。";
  } catch (error) {
    notice(`${error.message} 起動済みの場合があるため、自動再送しません。Azure の実行履歴・ログと実行状況を確認してください。`, true);
    $("execution-status").textContent = "起動結果を確認してください。再起動前に実行状況の更新が必要です。";
  } finally {
    state.executionStarting = false;
    state.execution = null;
    $("refresh-execution").disabled = false;
    $("schedule-fields").disabled = !state.schedule?.settings || state.schedule.updating;
  }
});
void action($("refresh-history"), loadRuns);
void api("/api/hosting").then(({ mode }) => {
  $("hosting-label").textContent = mode === "local" ? "ローカル管理コンソール" : "Entra ID 認証済み";
  $("hosting-tag").textContent = mode === "local" ? "LOCAL" : "AZURE";
}).catch((error) => notice(error.message, true));
