# Terraform による最小構成

AzureRM v4 と Terraform 1.9 以降で、Container Apps Job、実行環境、ACR Basic、
App Configuration、ユーザー割り当てマネージド ID、RBAC を作成します。
Log Analytics は標準出力とプラットフォーム ログ用で、保持期間は 30 日です。
UI、アプリケーション用のデータベース、進捗管理、履歴保存サービスは作成しません。
既存の Storage アカウント、Files 共有、Blob コンテナーの作成や変更は行いません。

## 前提条件

- Terraform 1.9 以降、Azure CLI、Windows PowerShell または PowerShell 7、Docker (Linux コンテナー)
- 対象サブスクリプションでリソースを作成できる権限と、既存 Storage の指定スコープを含めた
  `Microsoft.Authorization/roleAssignments/write` 権限
- 必要なリソース プロバイダーの登録権限 (AzureRM が必要に応じて登録します)
- 設定を更新する運用者の App Configuration Data Owner 権限。Contributor だけでは設定値を更新できません。
  `configuration_operator_object_ids` に運用者の **オブジェクト ID** を指定できます。
- イメージ発行者の AcrPush 権限。実行用 ID の権限は AcrPull のみです。
- 設定 JSON 内の account/share/container が指す既存の Files 共有と Blob コンテナーを RBAC 入力にすべて指定します。
  入力は HTTPS URL ではなく **共有／コンテナー単位の ARM リソース ID** です。
  Files は通常の管理プレーン ID (`/fileServices/default/shares/<share>`) を入力し、
  Terraform が FileREST OAuth 用の RBAC スコープ (`/fileServices/default/fileshares/<share>`) に変換します。

この手順はデプロイ例です。2026-09-18 に West US 2 で基盤・手動 Job の作成と
ACR のイメージ発行と、実際の Container Apps Job での Dry-run が成功しました。
合成データ 10 件を走査し、Blob 用・Files 用に各 3 件、計 6 件を候補として検出しました。
元の内容・ETag・更新日時・サイズ・リース状態は変わらず、両移動先は空のままでした。
当初は Storage の公開アクセスを無効化する組織ポリシーで接続が拒否されましたが、
ユーザー指定の除外タグをテスト用 Storage Account に設定し、公開接続を有効化して解消しました。
実際のコピー・削除は未検証であり、定期実行も無効です。
設定は `archive:settings` の単一キーを参照します。
以下の apply は実リソースと課金を発生させるため、plan を確認してから利用してください。

## 1. 基盤のみ作成

リポジトリ ルートから実行します。

```powershell
Set-Location .\infra
Copy-Item .\terraform.tfvars.example .\terraform.tfvars
# terraform.tfvars の subscription_id、既存 Storage の ID、運用者 ID を編集
# create_job=false、enable_schedule=false のまま開始
az login
az account set --subscription '<subscription-id>'
terraform init
terraform fmt -check
terraform validate
terraform plan -out=foundations.tfplan
terraform apply .\foundations.tfplan

$rg = terraform output -raw resource_group_name
$acr = terraform output -raw container_registry_name
$image = terraform output -raw container_image
```

未発行イメージを参照する Job の作成が成功することには依存しません。
既定では **Job 自体を作成しない** ため、設定やイメージの準備前に実行されません。
名前の一意性にはサブスクリプション ID と prefix から生成した固定サフィックスを使用します。
同じサブスクリプションで複数構成を作る場合は prefix を変えてください。
リソース グループ名を固定したい場合は `resource_group_name` を指定します。
省略時は `<name_prefix>-rg` です。既存グループを指定する場合は、所有範囲を確認して
`azurerm_resource_group.main` に import してから plan を実行してください。

## 2. イメージと設定を登録

`job\Dockerfile` から Node.js 24 を含むアプリケーション イメージを作成します。
ACR 管理者アカウントは無効です。発行者は Entra 認証と AcrPush を使用します。

```powershell
az acr login --name $acr
docker build --platform linux/amd64 --tag $image ..\job
docker push $image
```

Docker daemon が利用できない場合は、ACR Tasks でリモート ビルドできます。
実行者にはレジストリ上でビルドを実行できる権限が必要です。

```powershell
az acr build --registry $acr --image "files-archive:<image_tag>" --platform linux --file ..\job\Dockerfile ..\job
```

設定 JSON の準備、スキーマ検証、Portal／Azure CLI での登録は
[バッチの設定・運用](../job/README.md#app-configuration-への設定) に従ってください。
`job\settings.example.json` を基に、実在する対象と `dryRun: true` を設定します。
**完全な JSON を 1 個のキー `archive:settings` / ラベル `production`** に登録します。
Terraform は設定キーや設定値を作成せず、設定 JSON を state に保存しません。
キーやラベルを tfvars で変更した場合は、登録時も同じ値にしてください。

```powershell
Set-Location ..
$storeName = terraform -chdir=infra output -raw app_configuration_name
# job\README.md の設定手順を実施します。ストア名には上記の出力値を使用します。
# 設定の登録と検証後、リポジトリ ルートから infra に戻ります。
Set-Location .\infra
```

ローカル設定ファイルは Git に追加しないでください。認証情報、SAS、ストレージ
キーは JSON に含めません。RBAC 反映には時間がかかるため、403 の場合は割り当てと
ログイン先テナントを確認してから、反映を待って再試行してください。

## 3. 手動 Job を作成してドライラン

`terraform.tfvars` の `create_job = true` に変更します。
`enable_schedule = false` を維持します。

```powershell
terraform plan -out=manual.tfplan
terraform apply .\manual.tfplan
$job = terraform output -raw job_name
az containerapp job start --name $job --resource-group $rg
az containerapp job execution list --name $job --resource-group $rg --output table
```

完了状態と Log Analytics の `ContainerAppConsoleLogs_CL`、システム ログを確認し、
対象ファイルと移動先が意図どおりか検証してください。CLI 拡張が必要な場合は
`az extension add --name containerapp --upgrade` を実行します。
Files リースの強制停止後の復旧や ACL の扱いは [バッチの設定・運用](../job/README.md) を参照してください。
`parallelism = 1` は **実行ごと** の設定であり、別の手動実行との排他制御ではありません。
同じソースに対する手動実行を重ねないでください。自動リトライは 0 にしています。

## 4. 日次実行を有効化

ドライラン後に設定 JSON の `dryRun` を明示的に見直し、同じ key/label に再登録します。
その後 `terraform.tfvars` の `enable_schedule = true` に変更します。

```powershell
terraform plan -out=schedule.tfplan
terraform apply .\schedule.tfplan
```

スケジュールは **`0 18 * * *` (UTC)、毎日 03:00 JST** です。
トリガー種類の変更は AzureRM で Job の置き換えになります。実行中の Job がないことを
確認してから適用してください。停止時も `enable_schedule = false` にして plan を確認します。
イメージ更新は新しいタグを発行し `image_tag` を変更します。同一タグの上書きは避けてください。

## 環境変数と出力

| 環境変数 | 値 |
| --- | --- |
| `AZURE_CLIENT_ID` | 実行用ユーザー割り当て ID の client ID |
| `APP_CONFIG_ENDPOINT` | App Configuration の HTTPS endpoint |
| `APP_CONFIG_KEY` | 既定 `archive:settings` |
| `APP_CONFIG_LABEL` | 既定 `production` |
| `AUTH_MODE` | `managed-identity` |
| `JOB_TIMEOUT_SECONDS` | 既定 `3300`。replica timeout (既定 `3600`) より小さい正整数 |

`job_environment` 出力には上記の非機密値が含まれます。その他の主な出力は
`resource_group_name`、`container_registry_name`、`container_registry_login_server`、
`container_image`、`app_configuration_name`、`app_config_endpoint`、
`job_identity_client_id`、`job_identity_principal_id`、`job_name`、`job_id`、
`log_analytics_workspace_id` です。Job 作成前の `job_name` と `job_id` は null です。

## 権限とネットワーク

| ID / 対象 | ロールとスコープ |
| --- | --- |
| 実行 ID / ACR | AcrPull / 作成したレジストリ |
| 実行 ID / App Configuration | App Configuration Data Reader / 作成したストア |
| 実行 ID / コピー元・先の Files | Storage File Data Privileged Contributor / 指定共有の `/fileServices/default/fileshares/<share>` |
| 実行 ID / コピー先の Blob | Storage Blob Data Contributor / 指定した各コンテナー |
| 任意の運用者 / App Configuration | App Configuration Data Owner / 作成したストア |

Files のロールは FileREST の Entra OAuth と backup intent に必要な権限を含み、
コピー元の削除にも対応します。SMB マウント、ストレージ キー、接続文字列は使用しません。
共有スコープ内では強い権限を持つため、専用の対象共有に限定してください。

**Files の管理プレーン ID とデータプレーン RBAC スコープは異なります。**
[公式 FileREST OAuth ドキュメント](https://learn.microsoft.com/en-us/azure/storage/files/authorize-oauth-rest#privileged-access-and-access-permissions-for-data-operations)
(2026-09-18 確認) は、管理操作には `shares`、データ操作の RBAC スコープには
`fileshares` を使い、`shares` を指定したデータアクセス用の割り当ては機能しないと明記しています。
本構成では source/destination の両方について、入力の
`.../fileServices/default/shares/<share>` を
`.../fileServices/default/fileshares/<share>` に変換してロールを割り当てます。
ARM ID の大小文字も正規化し、同一共有への割り当てを重複させません。
Blob の `.../blobServices/default/containers/<container>` はこの変換の対象外です。
対象は `Microsoft.Storage` 配下の既存共有です。`Microsoft.FileShares` 配下の共有には対応しません。
従来の `/shares/` スコープでこの Terraform を適用済みの場合は、次の plan で Files の
ロール割り当ての置き換えを確認してください。実際の Azure で割り当て作成と、
Managed Identity による Dry-run のデータ読み取りを確認しました。
実移動に必要なリース・コピー・削除の受け入れ確認は別途必要です。

Job は ingress を公開しません。アウトバウンドは公開 HTTPS エンドポイントを使用し、
ACR の管理者認証と App Configuration のローカル キー認証を無効にしています。
既存 Storage の HTTPS 必須／TLS 1.2 以降の設定を確認してください。本 Terraform は既存
Storage の設定を変更しません。Storage ファイアウォールは Job からの接続を許可する必要が
あります。RBAC だけではネットワーク制限を回避できず、「信頼されたサービス」の設定だけで
この Job の通信が許可されるとは限りません。

この最小サンプルには VNet 統合、Private Endpoint、固定送信 IP はありません。
プライベート接続が必須の環境では、本構成をそのまま利用せず VNet/DNS/送信経路を設計してください。
組織の Azure Policy が Storage の `publicNetworkAccess` を `Disabled` に変更する場合、
RBAC の追加や再ログインでは解決しません。公開接続の例外が承認されていなければ、
VNet 接続の Container Apps 環境、Files/Blob 用 Private Endpoint と Private DNS を用意してください。
テストデータの投入元も同じプライベート経路へ到達できる必要があります。
既存の Container Apps 環境に VNet を後付けする場合は、置き換えが必要になることがあります。
plan の削除／置き換えと追加費用を確認してから実施してください。

今回の検証環境では、組織独自の `StorageAccount_PublicNetwork_Modify` ポリシーに
`SecurityControl=Ignore` の除外条件があることを確認し、ユーザー指定に従って
**テスト用 Storage Account だけ**にタグを追加しました。既存のタグは保持し、
リソース グループやポリシー定義・割り当ては変更していません。
タグだけでは既に `Disabled` の設定は戻らないため、`publicNetworkAccess=Enabled`
への変更も必要でした。匿名 Blob アクセスと共有キー認証は無効のままです。
このタグは Azure 共通の機能ではありません。他の環境に無条件で適用せず、
組織のポリシー条件と例外の承認範囲を確認してください。本 Terraform はこのタグを自動付与しません。

ACR Basic や App Configuration Free は本番の可用性・ネットワーク要件に適さない場合があります。
Free の使用可能数、要求数、設定容量の制限も確認してください。

## 状態管理、削除保護、検証

- 既定はローカル state です。state、plan、実際の tfvars はコミットしないでください。
  共同運用ではアクセス制御とロックを備えたリモート backend を別途構成してください。
- 本番では App Configuration Standard と
  `app_configuration_purge_protection_enabled = true` を検討してください。
  有効化後は無効化できません。Standard の soft-delete 保持期間は 7 日です。
  Free では同じ削除保護を利用できません。
- Provider による削除時の自動 purge は無効です。soft-delete 済みストアの再作成時は
  自動復旧を試みるため、復旧／削除済みリソースの参照権限が必要になる場合があります。
  purge 保護は通常の削除そのものを防ぐ仕組みではありません。本番では管理ロックも検討してください。
- Terraform の管理対象には既存 Storage のデータは含まれませんが、アプリケーションは
  設定に応じてコピー元を削除します。バックアップ、保存期間、ドライラン結果を確認してください。
- `terraform fmt -check`、`terraform init -backend=false`、`terraform validate`
  でローカル検証できます。これらは実際のイメージ取得、RBAC 伝播、SKU/クォータ、ネットワーク、
  設定内容、コピー／削除動作までは検証しません。デプロイ後の手動ドライランが必要です。
  2026-09-18 の実環境では基盤と手動 Job の plan/apply が成功しました。
  Consumption workload profile を環境と Job の両方に明示し、apply 後の plan が
  `No changes` になることも確認しました。
  組織ポリシーの承認済み除外タグを使って接続制限を解消した後、
  実環境の Dry-run は走査 10 件・候補 6 件・移動 0 件・失敗 0 件で成功しました。
  実行前後のスナップショット比較で、元ファイルの不変と両移動先が空であることを確認しました。
- 実装時は Terraform 1.16.2 / AzureRM 4.81.0 で init、fmt、validate が成功しました。
  `terraform test` も mocked provider を使った 11 件が成功しました。既定の Job 未作成、
  手動／日次トリガー、Files のデータプレーン スコープへの変換と重複排除、
  Blob スコープの維持、入力エラーを Azure へのアクセスなしで確認しています。
  `.terraform.lock.hcl` は再現性のためコミット対象です。

参照:
[Job](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_app_job) /
[App Configuration](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/app_configuration) /
[ACR](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_registry) /
[スケジュールと実行](https://learn.microsoft.com/azure/container-apps/jobs) /
[Files OAuth](https://learn.microsoft.com/azure/storage/files/authorize-oauth-rest)
