# Azure Files archive job

Azure Files の指定ディレクトリを定期走査し、一定期間更新されていないファイルを、
事前に用意した Azure Blob Storage または別の Azure Files 共有へ移動するサンプルです。

主な構成として以下を利用します。

- アプリ
  - Node.js 24 / TypeScript
- インフラ
  - Azure Container Apps Jobs
  - Azure App Configuration

Web UI、進捗 DB、処理台帳、履歴画面、自動復旧・自動再開は実装していません。
実行中の情報はメモリのみで保持し、運用ログを標準出力へ JSON 形式で出力します。

## 構成

| ディレクトリ | 内容 |
| --- | --- |
| `infra/` | Terraform。Container Apps Job、実行環境、App Configuration、ACR、Managed Identity、RBAC、ログ |
| `job/` | 1 回実行して終了するコンテナーバッチ、設定例、テスト、設定・運用マニュアル |

設定は App Configuration の **1 つの JSON 値**として読み込みます。
既定のキーは `archive:settings`、ラベルは `production` です。
実行開始時に 1 回だけ取得するため、実行中の設定変更は次回から反映されます。

## 動作

1. 設定全体を検証し、移動元と移動先への読み取り接続を確認します。
2. 指定パス配下を再帰的に走査します。日時判定は SMB の **最終書き込み時刻 (`fileLastWriteOn`)** です。
3. `実行開始時刻 UTC - olderThanDays × 24 時間` より古いファイルを選びます。境界と同時刻のファイルは対象外です。
4. `dryRun: true` では候補と競合をログに出すだけで、コピー・ロック・削除をしません。
5. 実移動では元ファイルをリースで保護し、4 MiB 単位でコピーします。
6. 移動先を再読み取りし、サイズと SHA-256 を照合します。
7. 元ファイルの同一性と両側のロックを再確認してから、元ファイルを削除します。

移動元の相対パスを維持します。空ディレクトリは移動・削除しません。
Azure Files のティアは共有単位なので、Files 移動先は用意済み共有のティアを利用します。

## 最初に読むマニュアル

- [アプリケーション設計](docs/application-design.md)
- [インフラストラクチャ設計](docs/infrastructure-design.md)
- [インフラ構築・イメージ登録・定期実行](infra/README.md)
- [App Configuration の設定・ローカル実行・障害復旧](job/README.md)
- [設定例：Blob / Files の両方](job/settings.example.json)

初期設定は **Dry-run** です。Terraform も既定では Job を作らず、
イメージ登録と設定投入後に手動 Job を作り、検証後に定期実行へ切り替えます。
既定スケジュールは **毎日 03:00 JST (`0 18 * * *` UTC)** です。

## Azureへデプロイ・実行

アプリは **Azure Container Apps Jobs 上のコンテナー**として実行します。
以下はローカルでバッチを動かす手順ではなく、インフラを作成し、アプリを Azure へ配置して実行する手順です。
コマンドはリポジトリを取得した端末の PowerShell で、記載順に実行してください。
各コマンドが成功したことを確認してから次へ進みます。
`terraform apply` 以降は Azure リソースの作成・利用に伴う料金が発生します。

### 前提条件

- Terraform 1.9 以降、Azure CLI、Docker (Linux コンテナー) を用意します。
  Node.js 24 と依存パッケージは Docker イメージ内に組み込むため、Azure 上での実行用に別途インストールする必要はありません。
- Azure でリソースを作成する権限、必要なリソースプロバイダーの登録権限、
  対象 Storage を含むスコープでの `Microsoft.Authorization/roleAssignments/write` 権限が必要です。
- イメージを登録する利用者には、作成する Azure Container Registry (ACR) の `AcrPush` 権限が必要です。
  Terraform は実行用 ID に `AcrPull` を付与しますが、利用者の `AcrPush` は付与しません。
  イメージ登録前に管理者へ割り当てを依頼してください。
- 移動元の **Classic SMB Azure Files 共有**と、移動先の **Blob コンテナーまたは別の Files 共有**を事前に用意します。
  この Terraform は Storage アカウント・共有・コンテナーを作成しません。
- この構成は公開 HTTPS エンドポイントを使います。
  Job から Storage への通信、および操作端末から ACR・App Configuration への通信が許可されている必要があります。
  Private Endpoint 必須の環境では、そのままデプロイせず
  [ネットワーク要件](infra/README.md#権限とネットワーク)に従って構成を見直してください。

作成対象は、リソースグループ、Container Apps 実行環境、Container Apps Job、
ACR、App Configuration、ユーザー割り当て Managed Identity、RBAC、Log Analytics です。
Job の認証と環境変数は Terraform が設定します。
ストレージキー、SAS、接続文字列は使用しません。

### 1. デプロイ先と対象 Storage を設定

リポジトリルートから開始します。
既に `terraform.tfvars` がある場合はコピーで上書きせず、既存ファイルを編集してください。

```powershell
az login
az account set --subscription "<subscription-id>"
az extension add --name containerapp --upgrade

Set-Location .\infra
Copy-Item .\terraform.tfvars.example .\terraform.tfvars
```

`infra\terraform.tfvars` の以下の項目を編集します。
`<subscription-id>` は利用するサブスクリプション ID に置き換えてください。

| 項目 | 設定内容 |
| --- | --- |
| `subscription_id` | `az account set` で選択したサブスクリプション ID |
| `location` | デプロイ先リージョン。既定は `japaneast` |
| `name_prefix` | リソース名の接頭辞。別環境を作る場合は変更 |
| `source_file_share_resource_ids` | すべての移動元 Files 共有の ARM リソース ID |
| `destination_file_share_resource_ids` | Files 移動先の ARM リソース ID。使わない場合は `[]` |
| `destination_blob_container_resource_ids` | Blob 移動先の ARM リソース ID。使わない場合は `[]` |
| `configuration_operator_object_ids` | 設定登録者の Entra オブジェクト ID。`App Configuration Data Owner` を付与 |
| `image_tag` | 発行するイメージのタグ。初回例は `v1` |
| `create_job` / `enable_schedule` | 初回は両方とも `false` |

Storage の入力は HTTPS URL やアカウント単位の ID ではなく、次の形式です。
設定 JSON で使用するすべての共有・コンテナーを指定します。

```text
Files: /subscriptions/<subscription-id>/resourceGroups/<storage-rg>/providers/Microsoft.Storage/storageAccounts/<account>/fileServices/default/shares/<share>
Blob:  /subscriptions/<subscription-id>/resourceGroups/<storage-rg>/providers/Microsoft.Storage/storageAccounts/<account>/blobServices/default/containers/<container>
```

Files のデータアクセス用 RBAC スコープへの変換は Terraform が行います。
設定登録者の ID はアプリケーションの client ID ではなく、ユーザー・グループ等の **オブジェクト ID**です。
Contributor だけでは App Configuration の設定値を登録できません。

### 2. インフラ基盤をデプロイ

引き続き `infra` ディレクトリで実行します。
plan の作成・変更・削除対象を確認してから apply してください。
この段階では Job を作らないため、アプリはまだ実行されません。

```powershell
terraform init
terraform validate
terraform plan -out=foundations.tfplan
terraform apply .\foundations.tfplan

$rg = terraform output -raw resource_group_name
$acr = terraform output -raw container_registry_name
$image = terraform output -raw container_image
$storeName = terraform output -raw app_configuration_name
$storeName
```

`terraform.tfvars`、state、plan は Git に登録しないでください。
既定の state はローカル保存のため、紛失しないように管理します。
共同運用ではアクセス制御・ロックを備えたリモート backend を用意してください。
既存リソースグループの利用方法や本番向け SKU・削除保護は
[インフラの詳細手順](infra/README.md)を参照してください。

### 3. アプリのコンテナーイメージを登録

ACR への `AcrPush` 権限を確認し、`infra` ディレクトリで実行します。
`$image` には、Terraform が Job に設定するレジストリ名・リポジトリ名・タグが含まれます。

```powershell
az acr login --name $acr
docker build --platform linux/amd64 --tag $image ..\job
docker push $image
```

Docker が利用できない場合は、必要な実行権限を用意したうえで
[ACR Tasks によるリモートビルド](infra/README.md#2-イメージと設定を登録)を利用できます。

### 4. App Configuration に実行設定を登録

`infra` ディレクトリから、設定例をコピーします。
既存の `settings.local.json` がある場合は上書きせず編集してください。

```powershell
Copy-Item ..\job\settings.example.json ..\job\settings.local.json
```

1. `job\settings.local.json` の `account`、`share`、`container`、`path`、
   `olderThanDays` を利用環境に合わせ、不要なルールを削除します。
   初回は必ず **`dryRun: true`** にします。
2. Azure portal で、手順 2 の `$storeName` に表示された App Configuration を開きます。
3. 「構成エクスプローラー」で種類「キー値」を作成し、キーを **`archive:settings`**、
   ラベルを **`production`**、コンテンツタイプを **`application/json`** にします。
4. 値に `settings.local.json` の **JSON 全体を 1 つの値として**貼り付けて保存します。
   JSON をさらに文字列で囲んだり、各項目を別々のキーに分けたりしないでください。

キー・ラベルを Terraform で変更した場合は、登録時も同じ値にします。
Terraform は設定値を登録しません。
設定には認証情報を含めず、キー・値・ラベル等の合計を 10 KB 以内にしてください。
設定項目、スキーマ検証、Azure CLI での登録方法は
[App Configuration の設定手順](job/README.md#app-configuration-への設定)を参照してください。
403 が発生した場合は、ログイン先と RBAC を確認し、権限の反映を待って再試行します。

### 5. Azure 上で手動実行 (Dry-run)

イメージと設定の登録後、`infra\terraform.tfvars` を
**`create_job = true`、`enable_schedule = false`** に変更します。
`infra` ディレクトリで Job を作成し、Azure 上で 1 回実行します。

```powershell
terraform plan -out=manual.tfplan
terraform apply .\manual.tfplan
$job = terraform output -raw job_name

az containerapp job start --name $job --resource-group $rg
az containerapp job execution list --name $job --resource-group $rg --output table
```

`start` の成功は実行要求の受付であり、バッチの正常完了ではありません。
`execution list` で対象実行が `Succeeded` になるまで確認します。
Azure portal で手順 2 のリソースグループ内の Log Analytics を開き、
`ContainerAppConsoleLogs_CL` の JSON ログにある `dry_run` と `summary` を確認してください。
移動候補・件数が意図どおりで、失敗がなく、元ファイルと移動先が変更されていないことを確認します。
失敗時は `fatal`、`file_failed` とシステムログを確認し、原因を解消してから再実行します。
ログの意味は [ログと終了コード](job/README.md#ログと終了コード)を参照してください。

### 6. 実移動を実行し、定期実行へ切り替え

**`dryRun: false` ではコピー・検証後に元ファイルを削除します。**
バックアップ、対象パス、保存期間、移動先、ACL の要件を確認してください。
Dry-run だけではリース・コピー・削除の成功は確認できません。
本番対象へ広げる前に、専用の共有・コンテナーで
[実環境の受け入れ確認](job/README.md#実環境での受け入れ確認)を実施してください。

1. 実行中の Job がないことを確認し、`settings.local.json` の `dryRun` を `false` に変更します。
2. 手順 4 と同じキー・ラベルに JSON 全体を再登録します。
3. 手順 5 の `az containerapp job start` と `execution list` で 1 回実行し、
   `summary`、移動先の内容・属性、元ファイルの削除結果を確認します。
4. 正常完了後、`infra\terraform.tfvars` を
   **`create_job = true`、`enable_schedule = true`** にし、次を実行します。

```powershell
terraform plan -out=schedule.tfplan
terraform apply .\schedule.tfplan
```

以降は **毎日 03:00 JST (`0 18 * * *` UTC)** に Azure 上で自動実行します。
手動から定期実行への切り替えは Job の置き換えになるため、実行中には適用しないでください。
`parallelism = 1` は実行単位の制限であり、別の実行との排他制御ではありません。
定期実行中に同じ対象への手動実行を重ねないでください。

定期起動を停止する場合は `enable_schedule = false` に戻し、plan を確認して apply します。
これは既に動いている実行の停止操作ではありません。
アプリ更新時は新しいタグでイメージを登録し、`image_tag` を変更して plan / apply します。
設定だけの変更は App Configuration に再登録すれば、次回実行から反映されます。
強制停止後の競合や残存リースは自動復旧しないため、
[異常終了後の復旧](job/README.md#異常終了後の復旧)に従ってください。

参考: [Azure Container Apps Jobs](https://learn.microsoft.com/azure/container-apps/jobs)
の「Scheduled jobs」では、cron 式は UTC で評価されると説明されています。

## 重要な制約

- **同名ファイルは上書きしません。** 移動先に既存データがある場合はエラーとし、元を残します。
- 進捗を保存しないため、コピー後・削除前の停止は自動修復しません。次回は競合として報告します。
- **Azure Files のファイルリースは無期限です。** 通常終了・処理エラー・SIGTERM では解除を試みますが、
  強制終了や通信断で残ることがあります。ジョブ停止確認後の手動解除が必要です。
- Files 移動先ではファイルの ACL、属性、作成時刻、最終書き込み時刻を設定します。
  ディレクトリの ACL・属性は複製せず、移動先から継承します。
- Blob 移動先では元の NTFS ACL を保存・適用しません。本文、HTTP 属性、メタデータをコピーし、
  元 URL（Base64）、作成時刻、最終書き込み時刻、SMB 属性をメタデータへ記録します。
  元と同じ ACL が必須なら Files を選択してください。
- 初期対応は Azure パブリッククラウドの **Classic SMB Azure Files (`Microsoft.Storage`)** です。
  NFS、新しい `Microsoft.FileShares` リソース、SMB 以外のファイルシステム固有情報は対象外です。
- Blob の移動先ティアは `Hot` / `Cool` / `Cold`。オフラインの `Archive` ティアは初期版対象外です。
- 1 ファイル最大 **209,715,200,000 バイト (195.3125 GiB)**、ファイルは直列処理です。
  全ファイルをローカルディスクへ保存しません。
- 検証のため移動先を全量再読み取りします。走査・コピー・検証の操作料金と転送量が発生します。
  Blob は Hot で作成・検証し、その後に指定ティアへ変更します。
- ファイルリースは共有・コンテナー全体の削除や管理者による強制解除からは保護しません。
  実行中は対象リソースの削除・リース解除・移動先の外部更新を行わないでください。

## 開発・検証

```powershell
Set-Location job
npm ci
npm test
npm run check-config -- settings.example.json
```

テストは Azure へ接続せず、条件判定・異常系と Azure SDK の呼び出し契約を検証します。
実際の SMB ロック、Managed Identity、RBAC、ネットワーク、Files の rename は、
[マニュアルの実環境確認項目](job/README.md#実環境での受け入れ確認)でも確認してください。