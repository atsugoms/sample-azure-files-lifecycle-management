# バッチの設定・運用

## 実装範囲

App Configuration からルールを読み、Azure Files を再帰走査して Blob または別の Files 共有へ移動します。
Web UI、DB、履歴機能、進捗ファイル、キュー、永続的な再試行台帳はありません。
SDK の短い通信リトライはありますが、ジョブ全体の自動リトライは Terraform の初期設定で無効です。

ロックは排他制御のために使用します。これは進捗保存ではありませんが、ファイルリース自体は
サービス側に残るため、強制停止時の手動復旧が必要です。

## App Configuration への設定

### 1. 設定を準備・検証

App Configuration のキー **`archive:settings`** に、`version`、`dryRun`、
`maxFilesPerRun`、`rules` を含む設定 JSON 全体を 1 つの値として登録します。
コンテンツタイプは `application/json`、既定ラベルは `production` です。

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
進捗カーソルはないため毎回先頭から走査します。競合が多い場合は先に手動解消してください。
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
`summary` は進捗台帳ではなくログで、次回実行からは読みません。
削除の応答を受信できなかった場合や、削除後のリース解除が失敗した場合も `file_failed` になります。
その場合は元が既に削除されている可能性があるため、ログだけで判断せず両側の実データを確認します。
パスに個人情報等を含む場合は、Log Analytics の閲覧権限・保持期間も管理してください。

## 異常終了後の復旧

**自動再開・既存コピーの自動流用はしません。** 次回は再走査し、
元が消えていれば対象外、元と移動先が両方あれば競合、リースが残っていれば失敗になります。
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
