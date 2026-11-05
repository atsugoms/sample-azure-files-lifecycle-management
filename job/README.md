# バッチの設定・運用

## 実装範囲

App Configuration からルールを読み、Azure Files を再帰走査して Blob または別の Files 共有へ移動します。
実行履歴・ファイル結果・進捗をローカルSQLiteへ保存し、CLIで参照・明示的に再開できます。
PostgreSQLへ切り替えるアダプターもあります。Web UI、キュー、自動再試行はありません。
SDK の短い通信リトライはありますが、ジョブ全体の自動リトライは Terraform の初期設定で無効です。

ロックは排他制御のために使用します。これは進捗保存ではありませんが、ファイルリース自体は
サービス側に残るため、強制停止時の手動復旧が必要です。

## App Configuration への設定

### 1. 設定を準備・検証

App Configuration のキー **`archive:settings`** に、`version`、`dryRun`、
`maxFilesPerRun`、`rules` を含む設定 JSON 全体を 1 つの値として登録します。
コンテンツタイプは `application/json`、既定ラベルは `production` です。

#### 投入する JSON のサンプル

以下の JSON 全体を App Configuration のキー `archive:settings` の値として登録します。
`key` や `label` を含むインポート用の JSON ではなく、アプリが読み込む設定そのものです。
ファイル版は [settings.appconfig.example.json](./settings.appconfig.example.json) です。

```json
{
  "version": 1,
  "dryRun": true,
  "maxFilesPerRun": 1000,
  "rules": [
    {
      "id": "documents-to-blob",
      "source": {
        "account": "sourcestorage",
        "share": "documents",
        "path": "completed"
      },
      "destination": {
        "kind": "blob",
        "account": "archivestorage",
        "container": "archive",
        "path": "documents",
        "tier": "Cool"
      },
      "olderThanDays": 90
    }
  ]
}
```

この例は `sourcestorage` の Files 共有 `documents` 内の `completed` 以下を再帰走査し、
最終書き込みから 90 日より古いファイルを対象にします。移動先は `archivestorage` の
Blob コンテナー `archive` 内の `documents` 以下で、アクセス層は `Cool` です。
`dryRun: true` のため実際のコピー・削除は行いません。実在するリソース名に置き換えて
対象を確認した後、移動を実行する場合のみ `dryRun: false` に変更してください。

別の Files 共有への移動も含む複数ルールの例は
[settings.example.json](./settings.example.json) を参照してください。

#### 設定ファイルの準備と検証

リポジトリルートで実行します。

```powershell
Copy-Item .\job\settings.example.json .\job\settings.local.json
# settings.local.json を編集し、実在する account / share / container / path に置き換える
# 不要なルールは削除し、最初は dryRun: true のままにする
Set-Location job
npm ci
npm run build
npm run check-config -- settings.local.json
Set-Location ..
```

設定例のアカウント・共有・コンテナーはプレースホルダーです。
移動元、移動先の共有・コンテナーは事前に作成してください。
アプリはアカウント、共有、コンテナーを作成しません。移動先 Files のサブディレクトリのみ作成します。
設定に接続文字列、アカウントキー、SAS、秘密情報を入れないでください。

| 設定 | 意味 |
| --- | --- |
| `version` | `1` 固定 |
| `dryRun` | 省略時 `true`。`false` にするとコピー・検証後に元を削除 |
| `maxFilesPerRun` | 1 回の候補処理上限。省略時 `1000`、1～100000。失敗・Dry-run も消費 |
| `rules` | 1～20 件。記載順に実行 |
| `rules[].id` | 重複しない英数字・`_`・`-` の識別子 |
| `source.account` / `source.share` | 移動元アカウント・SMB 共有 |
| `source.path` | 共有ルートからの相対パス。省略または空文字は共有全体 |
| `olderThanDays` | 最終書き込みからの日数。整数 1～36500 |
| `destination.kind` | `blob` または `files` |
| `destination.account` | 移動先アカウント |
| `destination.container` | `blob` の場合のみ指定 |
| `destination.share` | `files` の場合のみ指定 |
| `destination.path` | 移動先プレフィックス／相対ディレクトリ。省略または空文字はルート |
| `destination.tier` | `blob` の場合のみ `Hot` / `Cool` / `Cold`。省略時 `Cool` |

Azure パスの区切りは OS にかかわらず `/` です。先頭・末尾の `/`、`..`、`\`、
末尾ドット・空白などの不明確なパスは設定で拒否します。未知の項目やスペル誤りも拒否します。
別のルールを含め、移動先 Files 共有を移動元にも指定することはできません。
重複する移動元パス、重複する移動先パスも拒否します。循環移動や衝突を防ぐための制約です。

例: 移動元 `documents/completed/2024/report.pdf`、`source.path=completed`、
移動先 `container=archive`、`destination.path=documents` の場合、
Blob 名は `documents/2024/report.pdf` になります。

`maxFilesPerRun` は走査件数・容量の上限ではありません。非対象ファイルが多ければ走査は続きます。
上限を超える候補が見つかった場合は `limit_reached` を記録して終了コード 1 になります。
進捗カーソルはないため毎回先頭から走査します。同じ実行IDの再開では処理済みを照合して除外し、
各再開で新たに処理する候補に上限を適用します。競合が多い場合は先に手動解消してください。
大規模環境では対象パスを絞り、実行時間を測定してから日次運用してください。

### 2. Portal で登録する方法

1. App Configuration の「構成エクスプローラー」を開きます。
2. 種類「キー値」を作成します。Feature flag や Key Vault reference ではありません。
3. キーを `archive:settings`、ラベルを `production` にします。
4. 値に `settings.local.json` の **JSON 全体**を貼り付けます。JSON をさらに文字列で囲まないでください。
5. コンテンツタイプを `application/json` にし、保存します。

登録者には対象ストアの `App Configuration Data Owner` が必要です。
Job は `App Configuration Data Reader` のみを持ち、設定を書き換えません。
RBAC 反映には時間がかかることがあります。

**キー・値・ラベル等を合わせて 10 KB 以内**です。スキーマ上は最大 20 ルールですが、
内容によっては容量制限が先に到達します。1 回の更新・取得で設定全体の一貫性を保ちます。

### 3. Azure CLI で登録する方法

PowerShell の JSON 引数の引用符問題を避けるため、KVSet 形式のファイルをインポートします。
リポジトリルートから、検証済みの `settings.local.json` を使います。

```powershell
az login
$storeName = "<App Configuration のストア名>"
$label = "production"
$settings = Get-Content -Raw -Encoding UTF8 .\job\settings.local.json | ConvertFrom-Json
$kvset = @{
    items = @(
        @{
            key = "archive:settings"
            label = $label
            value = ($settings | ConvertTo-Json -Depth 20 -Compress)
            content_type = "application/json"
            tags = @{}
        }
    )
}
[System.IO.File]::WriteAllText(
    (Join-Path (Get-Location) "job\settings.kvset.json"),
    ($kvset | ConvertTo-Json -Depth 30),
    [System.Text.UTF8Encoding]::new($false)
)
az appconfig kv import --name $storeName --auth-mode login --source file `
    --path .\job\settings.kvset.json --format json --profile appconfig/kvset --dry-run
# プレビューを確認した後に実行
az appconfig kv import --name $storeName --auth-mode login --source file `
    --path .\job\settings.kvset.json --format json --profile appconfig/kvset --yes
az appconfig kv show --name $storeName --auth-mode login `
    --key "archive:settings" --label $label
```

`--strict` は付けないでください。他の設定を削除する必要はありません。
更新時も同じ手順で JSON 全体を置き換えます。同時編集は避けてください。
既に起動した Job は開始時に読み込んだ設定を使い続け、変更は次の実行から反映されます。

## 認証・実行環境

| 環境変数 | 既定値・用途 |
| --- | --- |
| `APP_CONFIG_ENDPOINT` | 必須。`https://<store>.azconfig.io` |
| `APP_CONFIG_KEY` | `archive:settings` |
| `APP_CONFIG_LABEL` | `production`。空文字はラベルなし |
| `AUTH_MODE` | `managed-identity`。ローカル検証のみ `azure-cli` |
| `AZURE_CLIENT_ID` | `managed-identity` 時に必須。ユーザー割り当て ID の client ID |
| `JOB_TIMEOUT_SECONDS` | `3300`。整数 1～86400。Container Apps の replica timeout より短くする |
| `HISTORY_DB_PROVIDER` | `sqlite`。`postgres`に切り替え可能 |
| `HISTORY_SQLITE_PATH` | `./data/history.sqlite`。コンテナー内は`/app/data/history.sqlite` |
| `HISTORY_POSTGRES_AUTH_MODE` | `password`（既定）または`entra` |
| `HISTORY_POSTGRES_URL` | `password`時に必須。`postgresql://<user>:<password>@<host>:5432/<database>` |
| `HISTORY_POSTGRES_HOST` | `entra`時に必須。`<server>.postgres.database.azure.com` |
| `HISTORY_POSTGRES_DATABASE` / `HISTORY_POSTGRES_USER` | `entra`時に必須。Terraformは`archive_history` / `archive_job`を設定 |
| `HISTORY_POSTGRES_SCHEMA` | 任意。小文字英数字と`_`のSQL識別子（先頭は英字または`_`、最大63文字）。Terraformは`archive` |
| `HISTORY_POSTGRES_TLS` | `verify-full`。ローカル検証のみ明示的に`disable`を選択可能 |
| `HISTORY_POSTGRES_CA_PATH` | 任意。PostgreSQLのサーバー証明書検証に使うCAファイル |

コンテナーでは Managed Identity のみを使用し、開発者の認証情報へのフォールバックはしません。
ローカルは明示的な `AzureCliCredential` を使います。

```powershell
Set-Location job
az login
$env:AUTH_MODE = "azure-cli"
$env:APP_CONFIG_ENDPOINT = "https://<store>.azconfig.io"
$env:APP_CONFIG_KEY = "archive:settings"
$env:APP_CONFIG_LABEL = "production"
npm run build
npm start
```

この実行も Azure の実データにアクセスします。設定が `dryRun: false` なら削除を伴います。
初回は専用のテスト共有・コンテナーと `dryRun: true` を使ってください。
ローカルユーザーにも Job と同等の対象ストレージ権限が必要です。

Azure Files は FileREST の OAuth と `backup` intent を使うため、
通常の SMB Share Contributor ではなく **Storage File Data Privileged Contributor** を使います。
NTFS ACL を迂回する強い権限なので、対象共有に絞り、実行 ID を他用途と共用しないでください。
Blob 移動先には **Storage Blob Data Contributor** が必要です。

## コピーと削除の安全設計

- 判定には SMB の最終書き込み時刻を使います。REST の `Last-Modified` や最終アクセス時刻ではありません。
- 走査後にリースを獲得し、ファイル ID、ETag、サイズ、最終書き込み時刻を再確認します。
  変化があれば `changed` を記録し、その回は移動しません。
- リース獲得中は SMB の新規 write/delete が拒否されます。既存の書き込みハンドルやリースがある場合は
  エラーにして元を残します。ハンドルの強制クローズや他のリースの自動解除はしません。
- Blob は `If-None-Match: *` で空の移動先を排他的に作り、リース下でブロックをアップロードします。
  完了まで移動先に空 Blob が見えることがあります。
- Files は一意な `.__archive-<UUID>/content` にコピーし、検証後に
  `replaceIfExists: false` の rename で最終パスへ公開します。公開後にも同じリースを確認します。
- 転送は 4 MiB 単位、各アップロードに MD5、全体検証に SHA-256 を使用します。
  元と移動先の内容が一致し、元が変更されていない場合のみ削除します。
- 元の ACL・属性を扱う Files と異なり、**Blob は NTFS ACL を保持しません**。
  Blob メタデータの `archive_source_*` はこのジョブ用に予約され、元の同名メタデータは置き換わります。
- ディレクトリ ACL の複製、空ディレクトリの削除、復元機能はありません。
- ジョブやルール全体のトランザクションではありません。一部ファイルの失敗時も残りの処理を続けます。
  設定不正、事前接続確認、走査自体のエラー、期限切れはジョブを停止します。

同時実行をスケジュール設定だけで完全には防げません。`parallelism=1` は各 execution 内の設定です。
同じ元ファイルはリースで競合し、同じ移動先は排他的作成／rename で保護しますが、
運用上も日次実行中に手動 Job を重ねないでください。

## ログと終了コード

標準出力の各行は JSON です。`runId`、時刻、イベント名が付きます。

| イベント | 意味 |
| --- | --- |
| `started` | Dry-run、ルール数、使用した設定のキー・ラベル・ETag |
| `dry_run` | 移動候補。ファイルのパス・サイズ |
| `source_lease_acquire` | リース取得を試みる元 URL |
| `archive_create` | 移動先 URL。Files では一時ディレクトリも記録 |
| `moved` | コピー・検証・元削除・リース後処理が正常終了 |
| `changed` | 走査後に変更されており移動しなかった |
| `file_failed` | ファイル処理またはリース後処理の失敗 |
| `limit_reached` | 候補処理件数の上限に到達 |
| `summary` | 走査・候補・移動・Dry-run・変更・失敗件数 |
| `fatal` | 設定取得・走査・タイムアウト等でジョブを中断 |

終了コードは、全件成功／対象なし／正常な Dry-run が `0`、失敗または上限到達が `1` です。
`summary` ログ自体は再開に使用せず、DBの台帳を使用します。
再開した試行に失敗がなくても、同じ実行の過去に失敗・要確認が残っていれば終了コードは1です。
削除の応答を受信できなかった場合や、削除後のリース解除が失敗した場合も `file_failed` になります。
その場合は元が既に削除されている可能性があるため、ログだけで判断せず両側の実データを確認します。
パスに個人情報等を含む場合は、Log Analyticsと履歴DBの閲覧権限・保持期間も管理してください。

## 実行履歴と進捗

### ローカルSQLite

引数なしの`npm start`は新規実行です。既定の`job\data\history.sqlite`へ履歴を保存します。
パスは**現在の作業ディレクトリ基準**なので、異なる場所から実行する場合は絶対パスを設定してください。
DBファイルとそのディレクトリは単一ホストのローカルディスク上に置きます。

```powershell
Set-Location job
$env:HISTORY_DB_PROVIDER = "sqlite"
$env:HISTORY_SQLITE_PATH = Join-Path (Get-Location) "data\history.sqlite"
npm run build
npm start
```

DB接続・スキーマ初期化・保存の失敗はジョブを停止し、別DBやメモリへ自動フォールバックしません。
設定取得・検証より前の失敗はJSONログのみです。設定検証後、接続事前確認・走査の前に履歴を作成します。
DBには設定スナップショットとハッシュ、判定基準日時、設定キー・ラベル・ETagを保存します。
設定は秘密情報を含めないでください。接続URLやパスワードは履歴へ保存しません。

SQLiteはWALと完全同期を使用し、ファイル結果と試行集計は短いトランザクションで保存します。
コピー中に長時間のDBトランザクションは保持しません。SQLiteファイルをAzure Files、
SMB/NFS共有、ネットワークドライブに置かないでください。複数ホストからの利用にはPostgreSQLを使います。

Dockerは非rootの`node`ユーザーで`/app/data`へ書き込みます。
**現行TerraformのContainer Apps Jobsには永続ボリュームがありません。**
コンテナーのローカル履歴は実行をまたいで保持されず、同じDBを開けなければ再開もできません。
Azureでの継続保存には、[TerraformのPostgreSQL構成](../infra/README.md#postgresqlを選ぶ場合)を選択します。

### CLIでの参照

参照コマンドはApp Configuration・Storageへの接続を要求しません。結果はJSONで出力します。
SQLiteとパスワード認証のPostgreSQLではAzure認証も不要です。
Entra認証のPostgreSQLではDB接続用のAzure認証とプライベートネットワーク到達性が必要です。

```powershell
npm start -- history list --limit 50 --offset 0
npm start -- history show "<runId>" --limit 50 --offset 0
npm start -- history progress "<runId>"
```

`list`は新しい実行順です。`show`は設定・実行状態と、指定ページの試行履歴・ファイル台帳を返します。
`--limit`は1～1000、既定50、`--offset`は0以上です。試行とファイルには同じページ指定を適用します。
ファイルは安定した識別キー順です。ページを送ってすべての要確認ファイルを調べてください。
`progress`は最新試行の集計、論理実行全体の状態別ファイル件数、処理中ファイルの段階・バイト数を返します。
一覧が同時更新されるとページ境界が変わる場合があります。

転送バイト数はコピー段階の値であり、検証・公開・削除の完了を意味しません。
転送中は約1秒ごとと最終ブロックで保存し、段階遷移・結果も保存します。
走査件数は100件ごと、候補開始・結果・試行終了でも保存します。
全対象数を事前確定しないため、総件数・全体完了率・残り時間は表示しません。
再走査した件数は各試行の観測値です。論理実行全体の処理件数は台帳を集計し、試行の走査数を合算しません。

| 実行状態 | 意味 |
| --- | --- |
| `running` | 実行中、または強制終了後に未確定の試行が残っている |
| `succeeded` | 全体に失敗・要確認・未完了がない |
| `completed_with_errors` | 一部ファイルに失敗・要確認が残っている |
| `limited` | 候補処理上限に到達。未処理分を再開可能 |
| `interrupted` | シグナル・期限切れ等で中断 |
| `failed` | 接続事前確認、走査、DB保存等の致命的失敗 |

ファイル状態は`processing`、`moved`、`dryRun`、`changed`、`failed`、`needs_review`です。
未処理ファイルはまだ台帳にありません。実移動の副作用より前に`processing`を保存します。

### 明示的な再開

```powershell
npm start -- resume "<runId>"
# 強制終了でrunningの試行が残った場合のみ、旧プロセス停止を確認した後に指定
npm start -- resume "<runId>" --recover
```

同じ論理実行IDの下に新しい試行IDを作成し、過去の試行履歴を残します。
`attempt_started`ログに試行IDを出力し、エンジンのログにも付与します。
再開は保存した設定・判定基準日時を使い、App Configurationの現在値を読み直しません。
現在の認証環境変数は必要です。Dry-runから実移動へ変える場合や設定を変える場合は新規実行にします。

- 先頭から再走査し、同じルール・パス・バージョンの処理済みファイルを除外します。
- 失敗・要確認のパスはバージョンが変わっていても除外します。自動再試行しません。
- `processing`が残っていれば、再走査で元が見つからなくても`needs_review`へ変更します。
- 再開の候補上限は新たに処理する分に適用します。除外分は上限を消費しません。
- 成功済み実行の再開や同一実行の二重再開は拒否します。

SQLiteの異常終了回復は、記録されたホスト名が現在と一致し、所有プロセスが存在しないと確認できる場合だけ許可します。
PID再利用やホスト名変更で確認できない場合も拒否します。稼働中のプロセスから自動的に所有権を奪いません。
PostgreSQLは専用接続のセッションadvisory lockで同一実行の二重起動を防ぎます。
異常終了後はロック解放を確認でき、かつ`--recover`を指定した場合に未完了試行を回復します。
これらは**同一実行ID**の保護です。異なる実行ID間の対象共有全体をロックする機能ではありません。

DBとAzure Storageにまたがるトランザクション・exactly-onceは保証しません。
元削除成功後・DB結果保存前の停止も成功と推測せず「要確認」にします。
台帳だけで削除可否を判断せず、以下の手動復旧で実データとリースを確認してください。
台帳の失敗・要確認を手動で成功へ変更するCLIはありません。復旧後に再処理する場合は新規実行とします。

### PostgreSQLへの切り替え

通常のPostgreSQLへパスワードで接続する例です。

```powershell
$env:HISTORY_DB_PROVIDER = "postgres"
$env:HISTORY_POSTGRES_AUTH_MODE = "password"
# 接続URLはシークレット管理から環境変数へ注入し、Gitや共有ログへ保存しない
$env:HISTORY_POSTGRES_URL = "<secret PostgreSQL URL>"
$env:HISTORY_POSTGRES_TLS = "verify-full"
# 独自CAが必要な場合のみ
$env:HISTORY_POSTGRES_CA_PATH = "C:\certificates\postgres-ca.pem"
npm start -- history list
```

DBは事前作成し、接続先スキーマにテーブル・インデックスを作成できる権限を用意します。
URL内のユーザー名・パスワードは必要に応じてURLエンコードしてください。
スキーマ指定には`HISTORY_POSTGRES_SCHEMA`を使用できます。省略時は接続URLまたはサーバーの既定値を使います。
スキーマ環境変数と接続URLの`options`は併用できません。
TLSは既定でホスト名と証明書チェーンを検証します。ローカル検証でのみ`HISTORY_POSTGRES_TLS=disable`を使います。
接続URLの`sslmode`等のSSLパラメーターは設定の競合を避けるため拒否します。
接続タイムアウトは10秒、SQL文のタイムアウトは15秒です。接続断で実行を続行しません。
SQLiteとPostgreSQLは同じ履歴API・スキーマバージョンを使いますが、**保存先を切り替えても既存履歴は移送しません。**
DB間のデータ移行機能は含みません。

Azure PostgreSQLのEntra認証は次の設定を使います。TerraformがJobへ同じ値を自動設定します。
DBのロールと専用スキーマは、[管理者による初期設定](../infra/README.md#postgresqlを選ぶ場合)で先に作成します。

```powershell
$env:HISTORY_DB_PROVIDER = "postgres"
$env:HISTORY_POSTGRES_AUTH_MODE = "entra"
$env:HISTORY_POSTGRES_HOST = "<server>.postgres.database.azure.com"
$env:HISTORY_POSTGRES_DATABASE = "archive_history"
$env:HISTORY_POSTGRES_USER = "archive_job"
$env:HISTORY_POSTGRES_SCHEMA = "archive"
$env:HISTORY_POSTGRES_TLS = "verify-full"
# Managed Identityを利用する実行環境の例。client IDはJob用IDの値
$env:AUTH_MODE = "managed-identity"
$env:AZURE_CLIENT_ID = "<job-identity-client-id>"
npm start -- history list
```

Entraモードでは接続URLを設定せず、TLS検証を無効にできません。対象はAzureパブリッククラウドの5432番ポートです。
接続時に`https://ossrdbms-aad.database.windows.net/.default`のトークンを取得し、
パスワードとしてメモリ内だけで渡します。トークンはDB・ログ・Terraform stateへ保存しません。
接続中の定期的な再認証は不要で、接続し直すときに新たに取得します。接続断で処理を自動再開することはありません。
ローカルから`AUTH_MODE=azure-cli`を使う場合は、そのユーザー自身に対応するDBログインと権限、
およびプライベートネットワークとDNSへの接続が必要です。`archive_job`はJob用Managed Identityに紐づくため、
開発者のAzure CLIトークンではそのままログインできません。DB管理者権限を通常のアプリ実行に流用しないでください。

履歴の自動削除・保持期限はありません。ファイルパス・設定を含むため、DBファイルやDBユーザーのアクセス権を制限し、
容量・バックアップを管理してください。SQLiteのバックアップは全実行停止・接続終了後に行うか、
SQLite対応のバックアップ方式を使い、稼働中にDBファイルだけをコピーしないでください。

### PostgreSQL契約テスト

通常の`npm test`はSQLiteと既存のAzureモックを検証し、接続先未指定時はPostgreSQLテストをスキップします。
PostgreSQLも検証する場合は、テスト用DBとスキーマ作成権限を持つ接続先を明示してください。
テストは一意な`archive_test_*`スキーマのみを作成・削除し、既存テーブルは変更しません。

```powershell
$env:HISTORY_TEST_POSTGRES_URL = "<secret test database URL>"
$env:HISTORY_TEST_POSTGRES_TLS = "verify-full"
# 独自CAが必要な場合のみ: HISTORY_TEST_POSTGRES_CA_PATH
# ローカルの隔離DBでTLSを使わない場合のみ "disable"
npm test
```

## 異常終了後の復旧

**途中コピーの自動復旧・既存コピーの自動流用はしません。**
同じ実行の再開では途中処理を「要確認」として除外します。新規実行では再走査し、
元と移動先が両方あれば競合、リースが残っていれば失敗になります。
移動先が存在するだけでは、コピーの完全性を保証できません。

1. スケジュールを無効化し、すべての execution が終了していることを確認します。
   実行が続いている間は、リースを解除しないでください。
2. `source_lease_acquire` / `archive_create` / `file_failed` の URL を確認します。
   ログ末尾が欠落していれば元・移動先の実データも確認します。
3. 残存リースを対象ファイル／Blob **単位**で手動解除します。他アプリのリースではないことを確認してください。
4. 両側が存在する場合はサイズ・SHA-256・必要な属性を比較し、完全なコピーか判断します。
   不明な場合は元を削除しません。
5. 再コピーするなら不完全な移動先を別名へ退避するか、管理者が対象を確認して削除します。
   Files の `.__archive-*` も対象がこの実行で作成されたものか確認してから整理します。
6. Dry-run と 1 回の手動実行を確認し、スケジュールを再開します。

Files リースは無期限で、コンテナー停止では消えません。Blob のリースもこの実装は無期限です。
通常の `finally` と SIGTERM では解除を試みますが、強制終了・期限による強制停止・ネットワーク障害では
実行できない場合があります。特に取得応答や rename 応答を受信できなかった場合は、両方のパスを確認してください。

### 対象 1 ファイルのリース解除例

以下は **実行停止・対象確認後に管理者が手動実行する復旧操作**です。自動実行しないでください。
リポジトリの `job` ディレクトリで、依存パッケージを導入し `az login` 済みの状態で使います。

```powershell
$env:RECOVERY_URL = "https://<account>.file.core.windows.net/<share>/<encoded-path>"
@'
import { AzureCliCredential } from "@azure/identity";
import { ShareFileClient } from "@azure/storage-file-share";
const client = new ShareFileClient(process.env.RECOVERY_URL, new AzureCliCredential(), {
  fileRequestIntent: "backup", allowTrailingDot: true
});
await client.getShareLeaseClient().breakLease();
console.log("Lease broken:", client.url);
'@ | node --input-type=module
```

Blob の場合は次のようにします。

```powershell
$env:RECOVERY_URL = "https://<account>.blob.core.windows.net/<container>/<encoded-blob-name>"
@'
import { AzureCliCredential } from "@azure/identity";
import { BlobClient } from "@azure/storage-blob";
const client = new BlobClient(process.env.RECOVERY_URL, new AzureCliCredential());
await client.getBlobLeaseClient().breakLease(0);
console.log("Lease broken:", client.url);
'@ | node --input-type=module
```

これはロック解除のみです。データ削除・コピー完了判定は行いません。

## 実環境での受け入れ確認

Azure Files のロックと OAuth は Azurite では再現できません。
本番共有ではなく、専用のテスト共有・コンテナーで以下を確認してください。

| ケース | 期待結果 |
| --- | --- |
| Dry-run、古い／新しい／境界時刻のファイル | 古いファイルだけ候補。書き込み・削除なし |
| Blob と Files への各移動 | 内容一致、元だけ削除。Files は ACL・属性・時刻も確認 |
| 空ファイル、4 MiB 超、Unicode 名、階層パス | 正しい相対パス・内容で移動 |
| 同名移動先あり | 元・既存移動先ともに保持し、失敗を通知 |
| SMB で書き込み中 | リース獲得失敗、元保持。強制クローズなし |
| コピー中に Job 停止 | 元保持。残存リース・コピーを手動復旧できる |
| 権限不足／Storage firewall 拒否 | 明示的エラー。コピー・検証未完了なら元削除なし |
| Files の rename 前後 | 最終名の上書きなし、公開後のリース確認に成功 |
| `dryRun: false` の設定変更 | 既存 execution は開始時設定、次回から新設定 |

### Dry-run 用の合成データ

`scripts\azure-dryrun-fixture.mjs` は検証専用です。通常の Job イメージには含まれません。
`atfileslm` で始まる専用 Storage アカウントに、`source` / `archive` 共有と
`archive` Blob コンテナーを事前作成してください。Azure CLI でログインし、
App Configuration Data Owner と対象共有／コンテナーの書き込み・読み取り権限、
Storage へのネットワーク接続を持つ端末で実行します。

```powershell
Set-Location job
$env:TEST_STORAGE_ACCOUNT = "<atfileslmで始まる専用アカウント名>"
$env:APP_CONFIG_ENDPOINT = "https://<store-name>.azconfig.io"
$env:APP_CONFIG_LABEL = "validation"
npm run build
node scripts\azure-dryrun-fixture.mjs seed ..\.azure\dryrun-baseline.json
# archive:settings / validation を読む手動 Job を開始し、完了ログを確認
node scripts\azure-dryrun-fixture.mjs verify ..\.azure\dryrun-baseline.json
```

`seed` は指定ラベル (省略時 `validation`) の `archive:settings` に `dryRun: true` の 2 ルールを登録し、
各移動先用に 100 日前・1 日前・89 日前・空・日本語名の計 10 ファイルを作成します。
90 日より古い候補は計 6 件です。既存ディレクトリ・異なる設定・既存スナップショットは
上書きしません。途中失敗時は無条件で再実行せず、作成済みデータを確認してください。
`configure` モードは設定の登録・一致確認だけを実施します。
`verify` は元ファイルのハッシュ、ETag、更新日時、サイズ、リース状態と、
移動先一覧が実行前と一致するか確認します。候補件数と Job の成功状態は別途ログで確認します。
スナップショットは受け入れ確認用であり、アプリケーションの進捗保存機能ではありません。

## 参考

- [App Configuration の制限](https://learn.microsoft.com/en-us/azure/azure-app-configuration/faq)
- [App Configuration CLI](https://learn.microsoft.com/en-us/cli/azure/appconfig/kv)
- [Files の OAuth / RBAC](https://learn.microsoft.com/en-us/azure/storage/files/authorize-oauth-rest)
- [Files のリース](https://learn.microsoft.com/en-us/rest/api/storageservices/lease-file)
- [SMB と FileREST のロック](https://learn.microsoft.com/en-us/rest/api/storageservices/managing-file-locks)
- [Files の rename](https://learn.microsoft.com/en-us/rest/api/storageservices/rename-file)
