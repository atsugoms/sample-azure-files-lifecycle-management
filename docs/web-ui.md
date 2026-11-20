# Web UI「Archive Console」

## 概要

`app\` は Azure Files アーカイブジョブの日本語 Web UI です。
設定編集、実行履歴の参照、定期実行の設定、単発起動を扱います。
ファイルのコピー・削除は Web サーバーではなく、別のバッチジョブが行います。

**履歴 DB の既存スキーマを正とし、Web UI を合わせています。**
現行の `job\` と共通の認証・設定検証を利用します。
DB スキーマの変更や、旧実装の再開用テーブルの追加は行いません。

## 画面と保存データの対応

| 画面 | 主な機能・参照先 |
| --- | --- |
| 実行履歴 | `execution_runs` の実行状態、開始・終了日時、設定メタデータ、集計、エラーを表示 |
| ファイル別履歴 | `file_executions` の移動元・移動先 URL、ルール、サイズ、実行モード、開始・終了日時、状態、エラーを表示 |
| アーカイブ設定 | App Configuration の Dry-run、対象ファイル上限、移動元、Blob／Files の保存先、対象期間を編集 |
| 実行スケジュール | 指定した Container Apps Job の毎日・毎週の定期実行を、日本時間で参照・編集 |
| 単発実行 | 保存済み設定の実行モードを確認し、指定 Job を 1 回起動 |

履歴とファイル一覧は 25 件単位でページングし、更新ボタンで再取得します。
現在の設定から過去の実行モードやルール数を補完することはありません。
設定読み込み前に失敗した実行など、メタデータのない項目は「未記録」と表示します。

### 表示しない情報

現行 DB にない情報を生成したり、保存済みであるかのように表示したりしません。

- 再試行・再開専用の履歴、旧 attempts テーブルの試行 ID
- コピー中などの処理段階、転送済みバイト数
- 設定 JSON 全体のスナップショット、設定ハッシュ
- 再開カーソル、永続的な排他状態

`configuration_json` は設定キー・ラベル・ETag、Dry-run、ルール数などのメタデータです。
`summary_json` と `error_json` も含め、保存された実行情報は詳細画面で確認できます。
ファイルの `bytes` はファイルサイズであり、転送進捗ではありません。

実行状態は `running`／`succeeded`／`failed`／`limit_reached`、
ファイル状態は `running`／`moved`／`dry_run`／`changed`／`failed` です。
`running` は「実行中／結果未確定」と表示します。
異常終了で終了記録が残っていない場合もあるため、実際に処理が継続中とは限りません。
また、`failed` でも元ファイルが残っている保証はありません。

## 実装構成

Node.js 24 / TypeScript の HTTP サーバーと、HTML・CSS・JavaScript の静的画面で構成します。
React や Express などの Web フレームワークは使用しません。

| ファイル | 責務 |
| --- | --- |
| `app\src\index.ts` | 設定検証、履歴接続、HTTP サーバー起動・終了 |
| `app\src\server.ts` | 静的配信、REST API、入力検証、アクセス制限、エラー応答 |
| `app\src\history.ts` | 既存 PostgreSQL／SQLite の読み取り専用アクセス、DB 行から API 応答への変換 |
| `app\src\settings.ts` | App Configuration の読み込みと ETag 付き保存 |
| `app\src\hosting.ts` | ローカル／Container Apps モード、Host・認証情報の検査 |
| `app\src\schedule.ts` | JST／UTC 変換、次回予定、Job のスケジュール更新 |
| `app\src\execution.ts` | Job の実行状態確認、単発起動、同一プロセス内の起動要求管理 |
| `app\src\job-client.ts` | 対象 Job に限定した ARM API 呼び出し |
| `app\public\` | 画面、フォーム、確認ダイアログ、API 呼び出し、スタイル |
| `job\src\auth.ts` | バッチと Web が共用する Azure CLI／Managed Identity 認証 |
| `job\src\config.ts` | バッチと Web が共用する設定スキーマ検証 |

### 主な API

| メソッド | パス | 用途 |
| --- | --- | --- |
| GET | `/healthz` | ヘルスチェック |
| GET | `/api/hosting` | 起動モード |
| GET / PUT | `/api/settings` | 設定の参照・保存 |
| GET | `/api/runs` | 実行一覧 |
| GET | `/api/runs/{id}` | 実行レコードとファイル状態別件数 |
| GET | `/api/runs/{id}/files` | ファイル別履歴 |
| GET / PUT | `/api/schedule` | スケジュールの参照・保存 |
| GET / POST | `/api/execution` | Azure の実行状況参照・単発起動 |

履歴 API に作成・更新・削除操作はありません。旧 `/attempts` API も提供しません。
DB の接続エラー、スキーマ不一致、不正な保存値は、空の履歴として扱わずエラーにします。
API の詳細エラーは参照 ID とともにサーバーログへ記録し、画面には接続失敗を表示します。

### API の更新条件と応答

履歴一覧・ファイル一覧は `limit`（既定 25、1～100）と `offset`（既定 0、0 以上）を受け取ります。
一覧の応答は配列、実行詳細は `{ run, totals }` です。存在しない実行 ID は 404 になります。

更新要求は同一 origin から送信し、`Content-Type: application/json`、
`X-Archive-Request: 1`、`If-Match` が必要です。

| API | 本文と `If-Match` |
| --- | --- |
| PUT `/api/settings` | 設定 JSON 全体。GET で返った `etag` を指定 |
| PUT `/api/schedule` | `{ enabled, frequency, time, weekdays }`。GET の `revision` を指定。`time` は JST の `HH:mm`、毎日の `weekdays` は空配列、毎週は日曜 0～土曜 6 を重複なく 1 件以上 |
| POST `/api/execution` | `{ "requestId": "<UUIDv4>" }` のみ。確認時に GET `/api/settings` で取得した `etag` を指定 |

単発起動は 202 で `{ jobName, executionName }` を返しますが、処理完了ではありません。
`executionName` は Azure 側で起動受付が非同期の場合は NULL になることがあります。
要求の `requestId`、Azure execution 名、DB の `runId` はそれぞれ別の識別子です。

主なエラーは入力不正 400、認証・アクセス拒否 401／403、更新競合 409、
`If-Match` 不足 428、未設定の Job 機能 503、接続先の処理失敗 502 です。
起動済みの場合があるため、通信エラーや 502 を理由に起動要求を自動再送しないでください。
`/healthz` の 200 は HTTP サーバーの応答確認であり、DB・App Configuration・ARM の
継続的な正常性や、バッチの成功を保証しません。

## ローカル起動

### 前提

- Node.js 24 と npm、Azure CLI
- 登録済みの App Configuration 設定
- 設定を編集する利用者の App Configuration Data Owner 権限
- **現行ジョブが初期化した履歴 DB**

Web UI は DB やテーブルを作成しません。先にジョブを実行し、履歴 DB を用意してください。
初回は専用のテスト共有・コンテナーと `dryRun: true` を使用します。
ジョブ起動方法は [バッチの設定・運用](../job/README.md) を参照してください。

リポジトリルートの PowerShell で実行します。

```powershell
npm ci --prefix .\job
npm ci --prefix .\app
npm run build --prefix .\app

az login
$env:AUTH_MODE = "azure-cli"
$env:APP_CONFIG_ENDPOINT = "https://<store-name>.azconfig.io"
$env:APP_CONFIG_KEY = "archive:settings"
$env:APP_CONFIG_LABEL = "production"
$env:DB_DRIVER = "sqlite"
$env:SQLITE_PATH = Join-Path (Get-Location) "job\execution-log.sqlite"

npm start --prefix .\app
```

`http://127.0.0.1:3000` を開きます。`localhost` は使用しません。
ローカルモードは `127.0.0.1` のみにバインドし、終了は `Ctrl+C` です。
`app` のビルドは共有パッケージである `job` を先にビルドします。

### 環境変数

履歴 DB の設定名はバッチと同じです。旧 `HISTORY_*` の DB 接続設定が残っている場合は、
接続先の取り違えを防ぐため起動を失敗させます。旧変数を削除し、次の設定へ置き換えてください。

| 環境変数 | 用途 |
| --- | --- |
| `APP_CONFIG_ENDPOINT` | 必須。App Configuration の HTTPS endpoint |
| `APP_CONFIG_KEY` / `APP_CONFIG_LABEL` | 既定 `archive:settings`／`production` |
| `AUTH_MODE` | 既定 `managed-identity`。ローカルは明示的に `azure-cli` |
| `AZURE_CLIENT_ID` | `managed-identity` 時に必要なユーザー割り当て ID の client ID |
| `DB_DRIVER` | `postgres` または `sqlite`。既定は認証モードに応じてバッチと同じ |
| `SQLITE_PATH` | SQLite ファイル。Web の既定はリポジトリ内の `job\execution-log.sqlite` |
| `PGHOST` / `PGDATABASE` / `PGUSER` | PostgreSQL のホスト・DB 名・Entra DB ロール名 |
| `PORT` | ローカル既定 `3000`。Dockerfile は `8080` |
| `WEB_SCHEDULE_JOB_RESOURCE_ID` | スケジュール・単発起動の対象 Job の ARM リソース ID |
| `WEB_HOST_MODE` | 既定 `local`。Azure 公開時は `container-apps` |
| `WEB_PUBLIC_ORIGIN` | `azurecontainerapps.io` の既定ホストの正確な HTTPS origin。末尾 `/` なし。カスタムドメインは未対応 |
| `WEB_AUTH_TENANT_ID` | Azure 公開時に許可するテナント |
| `WEB_AUTH_ALLOWED_OBJECT_IDS` | Azure 公開時に許可する利用者のオブジェクト ID。カンマ区切り |

バッチの既定 SQLite パスは作業ディレクトリ基準なので、別の場所から動かす場合は、
Web とバッチの両方に同じ絶対パスを指定してください。
SQLite は読み取り専用で開き、DB がない場合や別スキーマの場合は起動を失敗させます。
SQLite を Azure Files 共有へ直接配置しないでください。

PostgreSQL では `DB_DRIVER=postgres` と `PG*` を設定します。
Entra トークン、証明書検証付き TLS 1.2 以上、読み取り専用セッションを使用します。
Web 用には別の Entra DB ロールを用意し、対象 DB の `CONNECT`、
`public` スキーマの `USAGE`、既存の 2 テーブルの `SELECT` だけを付与してください。
Web にテーブル所有権・作成・更新権限は不要です。
DB が Private Endpoint 接続なら、Web の実行環境にも VNet 到達性と名前解決が必要です。

## 設定・スケジュール・単発起動の注意点

設定は App Configuration の単一キーへ JSON 全体を保存します。
ジョブと同じスキーマで検証し、ETag 不一致時は上書きしません。
設定・キー・ラベル・コンテンツタイプの合計は 9,500 バイトまでです。
保存した設定は次回の新規実行で読み込まれ、実行中のジョブには反映しません。

スケジュールと即時実行は `WEB_SCHEDULE_JOB_RESOURCE_ID` の 1 個の Job を操作します。
未設定なら該当機能はエラーを表示し、履歴・設定画面は引き続き利用できます。
実行 ID には対象 Job の `Microsoft.App/jobs/read`・`write`、
`Microsoft.App/jobs/start/action`・`Microsoft.App/jobs/executions/read` が必要です。
Web 用 ID は信頼できる用途に限定し、権限スコープを対象 Job に絞ってください。

- 定期実行は毎日・毎週に対応し、JST を UTC cron に変換します。月曜 03:00 JST は `0 18 * * 0` です。
- 無効時の周期・時刻・曜日は Job の `archive-console-schedule` タグへ保持します。設定用 DB テーブルは追加しません。
- 無効時は `Manual` に切り替えますが、既に動いている execution は停止しません。
- 対応できない cron 式やイベントトリガーは、画面から上書きしません。
- 即時実行は保存済み設定を使用し、未保存の編集や任意のコマンド・イメージを送信しません。
- `dryRun: false` ではコピー・検証後に元ファイルが削除されます。確認画面でモードを確認してください。
- 起動受付は処理完了ではありません。Azure の実行状況と DB 履歴・ログを確認してください。
- 実行中、Job 更新中、起動確認中、未知の execution 状態では新しい単発起動を拒否します。
- 同じ `requestId` の重複抑止は同一 Web プロセス内の直近最大 100 件です。再起動後や別 replica には共有しません。
- 起動応答が不明な場合は再送せず、実行状況を更新して Azure 側を確認します。要求記録は履歴 DB に保存しません。
- `running` の DB 記録と Azure の実行状況は別情報です。Web は DB の状態を書き換えて復旧しません。
- 更新競合検査や重複抑止は、複数 Web レプリカ・外部操作との完全な排他制御ではありません。
- Azure Portal や IaC による同時変更を避けてください。IaC の再適用でスケジュールが上書きされる場合があります。

## コンテナーと Azure 公開

Web は継続稼働する **Azure Container App**、バッチは **Container Apps Job** として分離します。
既存 `infra\` の Terraform はバッチ基盤用であり、Web の Container App や組み込み認証は作成しません。
専用の検証環境は `infra\web-demo\` の Bicep と
`app\scripts\deploy-demo.ps1` で段階的に作成します。
現行 DB の接続設定・スキーマに対応しており、既存 `infra\` の Terraform state は使用しません。

### 専用検証環境のデプロイ

対象サブスクリプション、リソースグループ、Entra アプリ登録を事前に確認します。
スクリプトの既定値はこのサンプルの検証環境用です。他環境では引数を指定してください。
既存リソースの削除はスクリプトに含めず、別途確認して実施します。
`Bootstrap` と `Seed` は空の新規 DB・合成データ用共有に対して実行します。

#### 前提と入力

- Node.js 24／npm、Bicep を実行できる Azure CLI、Container Apps 拡張機能、PowerShell を用意します。
  イメージは ACR Tasks でビルドするため、ローカル Docker daemon は不要です。
- `az login` は対話ユーザーで行います。スクリプトは `az ad signed-in-user show` で操作者を取得します。
  Azure のリソース作成・RBAC 割り当て・ACR Tasks 実行権限に加え、対象 Entra アプリ登録の
  コールバックと資格情報を更新できる権限が必要です。
- 既存のシングルテナント Entra アプリ登録を指定します。ID トークン発行を有効にしておきます。
  アプリ登録そのものは作成しません。Web へのアクセス許可は、デプロイ操作者のオブジェクト ID に限定されます。
- `main.bicep` の VNet 範囲・SKU・固定 DB 名を確認し、リージョンの可用性・クォータ・組織ポリシーを確認します。
  新規専用リソースグループを使用し、既存 Terraform 管理環境には適用しません。

| スクリプト引数 | 用途 |
| --- | --- |
| `-Phase` | 必須。実行する段階。以下の順序で指定 |
| `-SubscriptionId` | 承認済みサブスクリプション。Azure CLI の選択先と異なる場合は停止 |
| `-ResourceGroup` | 専用リソースグループ名。Foundations が作成 |
| `-Prefix` | 新規リソース名の接頭辞。小文字英数字 3～18 文字を推奨 |
| `-Location` | リージョン。既定 `japaneast` |
| `-ImageTag` | `archive-console` イメージのリリースタグ。再ビルド時は新しいタグを指定 |
| `-AuthenticationClientId` | 専用 Entra アプリ登録の application/client ID。Managed Identity の client ID とは別 |

以下は**新規環境の初回のみ**実行します。プレースホルダーを置き換え、
同じ引数を全段階で使います。各 Bicep デプロイは what-if 後に create しますが、
スクリプトは対話承認を求めないため、実行前に定義と対象を確認してください。

```powershell
$ErrorActionPreference = 'Stop'
npm ci --prefix .\job
if ($LASTEXITCODE -ne 0) { throw 'Job dependency installation failed' }
npm ci --prefix .\app
if ($LASTEXITCODE -ne 0) { throw 'Web dependency installation failed' }
npm run build --prefix .\app
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

az account set --subscription '<approved-subscription-id>'
if ($LASTEXITCODE -ne 0) { throw 'Subscription selection failed' }
$deployment = @{
    SubscriptionId = '<approved-subscription-id>'
    ResourceGroup = '<new-dedicated-resource-group>'
    Prefix = '<new-prefix>'
    Location = 'japaneast'
    ImageTag = '<unique-release-tag>'
    AuthenticationClientId = '<single-tenant-application-client-id>'
}
foreach ($phase in @('Foundations','BuildImage','Configure','Bootstrap','Seed','Workloads','Run','Verify','WebCheck')) {
    & .\app\scripts\deploy-demo.ps1 @deployment -Phase $phase
    if (-not $?) { throw "Deployment phase failed: $phase" }
}
```

`Foundations` は専用 Storage・共有・Blob コンテナーも作成します。
`BuildImage` は ACR Tasks を使用します。バッチも同じイメージの別エントリーポイントで実行します。
`Configure` は `dryRun: true` の設定を新規登録し、既存キーを上書きしません。
`Bootstrap` は操作者の短命な Entra トークンで DB ロールを作成し、
現行ジョブ自身で履歴テーブルを初期化します。処理後は helper の管理用トークンを除去します。
DB ロールは `archive_job` と `archive_web`、DB 名は `executionlog` です。
`Seed` は過去日時・現在日時の合成ファイルを 1 件ずつ作成します。
`Workloads` は既存の専用 Entra アプリにコールバック URL を追加し、
180 日の認証用シークレットを追記して、Web と手動 Job を作成します。
シークレットの値はソースやパラメーターファイルへ保存しません。
認証用シークレットは Container App の secret に保持します。
`Run` は保存済み設定が Dry-run の場合だけ Job を 1 回起動します。
`Verify` は実 DB の成功履歴・候補 1 件と、移動元の内容・日時・保存先が変化しないことを確認します。
`WebCheck` は Web 用 ID の設定保存と DB 読み取り権限を確認します。

この構成は検証後も残り、PostgreSQL・Web レプリカ・Private Endpoint 等の課金が継続します。
定期実行は無効です。認証用シークレットは期限前に更新してください。

#### 再実行・更新時の注意点

`Configure` は設定キー、`Bootstrap` は DB ロール、`Seed` は合成ファイルが既にあると失敗します。
全段階を毎回やり直すスクリプトではありません。失敗した段階と実リソースの状態を確認し、
部分成功した初期化を無条件に再実行しないでください。
helper の起動を伴う段階は最大 15 分待機し、失敗・待機期限超過でも起動を自動再送しません。

アプリの更新では、新しい `ImageTag` で `BuildImage` → `Workloads` を実行します。
`Workloads` は Web と Job の両方を更新し、Job を Manual に戻します。
実行中の Job がないことを確認し、既存のスケジュールを退避してから適用してください。
Web 側の許可ユーザーもその時点の操作者になります。
また、実行ごとに Entra アプリへ新しい認証用シークレットを追記します。
旧シークレットは自動削除しないため、利用箇所を確認してから別途整理してください。

helper を使った再検証でも同じタグを指定します。`Verify` は最新実行が
「合成データ 2 件のうち古い 1 件だけを Dry-run」となることを前提にしています。
実コピーや別の設定を検証する汎用テストではありません。
検証 helper は環境に残りますが、Manual なので自動起動しません。
構成の詳細・RBAC スコープは [インフラ設計の Bicep 構成](infrastructure-design.md#16-web-ui-を含む専用検証環境bicep)を参照してください。

### Azure 実環境での確認結果（2026-11-20）

専用環境で Entra サインイン、実行履歴・ファイル詳細・設定・スケジュール画面を確認しました。
Web UI の単発実行から Job を起動し、正常終了と DB 履歴への反映を確認しています。
合成ファイル 2 件のうち古い 1 件（37 B）が Dry-run 対象となり、移動・失敗は 0 件でした。
元ファイルの内容・日時が変化せず、保存先が空のままであることも再確認しました。
設定の条件付き保存、無効スケジュールの保存、Web 用 DB ロールの読み取り専用権限も確認済みです。
定期実行は無効、`dryRun: true` のままです。実ファイルのコピー・削除は未検証です。
有効スケジュールの時刻到来による自動起動も、この確認実績には含みません。

### コンテナービルドと公開条件

Web イメージはリポジトリルートをビルドコンテキストにします。

```powershell
docker build --platform linux/amd64 --file .\app\Dockerfile --tag archive-console:local .
```

ルート `.dockerignore` はソース・依存定義だけを許可し、
Terraform state、実環境設定、ローカル DB、`.azure\`、依存インストール済みディレクトリを送信しません。
バッチ専用イメージのビルドコンテキストは、従来どおり `job\` です。

Azure では `WEB_HOST_MODE=container-apps` と認証関連変数を設定し、
Container Apps の組み込み Microsoft Entra ID 認証を**必須**にしてください。
アプリは組み込み認証が付与する `X-MS-CLIENT-PRINCIPAL` の発行者・テナント・利用者を検査します。
組み込み認証を無効にしたコンテナーを直接公開する構成は想定していません。
Host・Origin・Fetch Metadata と更新操作の専用ヘッダーを検査し、CSP を設定します。
`Referrer-Policy: same-origin` により、組み込み認証の更新要求検査に必要な
同一サイトの Referer を保持し、別サイトへの参照情報は送信しません。
`/healthz` は情報を含まないヘルスチェック専用エンドポイントです。

Container Apps モードでは PostgreSQL が必須です。
ジョブのコンテナーローカル SQLite は別コンテナーの Web から参照できません。
Web 用 ID とバッチ用 ID は分離し、Web 用 ID へ Storage データアクセス権を付与する必要はありません。
ローカルモードの外部公開・ポート転送は行わないでください。

## 障害時の確認

| 症状 | 確認・対応 |
| --- | --- |
| 401、サインイン画面へ戻る | 専用テナントのアカウント、認証セッション、Entra アプリのコールバック URL とシークレット期限を確認 |
| サインイン後に 403 | `WEB_AUTH_TENANT_ID`、許可オブジェクト ID、アクセス先と `WEB_PUBLIC_ORIGIN` の一致を確認 |
| GET は成功するが PUT／POST が空の 403 | Easy Auth 側の拒否を疑い、`Referrer-Policy: same-origin` が維持されているか確認。認証や Origin 検査を無効にして回避しない |
| 設定・スケジュールの 409 | 入力を控え、最新状態を再読み込みして変更をやり直す。競合した設定を無条件に上書きしない |
| 単発起動の応答不明・タイムアウト | Azure の execution 一覧とログを先に確認。「実行状況を更新」「履歴を更新」で再確認し、重複起動を避ける |
| スケジュール保存の待機期限超過 | ARM 側では更新が継続している場合があるため、再読み込みで `trigger`・保存値・`updating` を確認してから再操作 |
| 502、DB 接続・スキーマの起動エラー | 参照 ID に対応する Web ログ、`PG*`、Entra DB ロール、Private DNS／VNet 到達性、現行 DB 列を確認 |

画面は自動更新しません。Job が成功しても履歴に反映されない場合は更新ボタンで再取得します。
認証済み画面のスクリーンショットやログにはファイル URL などが含まれるため、共有前に内容を確認してください。

## 開発・検証

```powershell
npm test --prefix .\app
npm test --prefix .\job
```

Web のテストは実際のジョブ履歴ライターで作った SQLite を参照し、
DB スキーマとの一致、全状態、未記録メタデータ、ページング、読み取り専用、
DB 不在・スキーマ不一致時の明示的な失敗、設定保存、アクセス制限を確認します。
PostgreSQL の接続契約と ARM 操作はモックで確認します。
実際の Entra 認証、Private Endpoint、RBAC、Azure Job 起動は、別途専用環境で確認してください。
