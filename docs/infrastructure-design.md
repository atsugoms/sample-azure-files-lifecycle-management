# インフラストラクチャ設計

## 1. 目的

Azure Files アーカイブジョブを、資格情報をコードや設定へ保存せず、
Azure Container Apps Jobs で手動または日次実行するための最小 Azure 基盤です。

Terraform はジョブ実行基盤、イメージ格納、設定ストア、監視、Managed Identity、RBAC を管理します。
処理対象の Storage Account、Azure Files 共有、Blob コンテナーは既存リソースとして扱い、
Terraform では作成・変更しません。
実行履歴用 PostgreSQL と、そのプライベート接続用ネットワークも管理します。

この文書の第 2～15 節は `infra\` 直下の **バッチ用 Terraform** の設計です。
Web UI を含む専用検証環境は `infra\web-demo\` の **別の Bicep 定義**で構築します。
その差分は [第 16 節](#16-web-ui-を含む専用検証環境bicep)を参照してください。
両定義で同じリソースを管理したり、既存 Terraform state を Bicep 環境へ流用したりしません。

## 2. 論理構成

```mermaid
flowchart LR
    Operator[運用者] -->|設定 JSON 更新| AppConfig[Azure App Configuration]
    Operator -->|イメージ build / push| ACR[Azure Container Registry]

    subgraph RG[Resource Group]
        Env[Container Apps Environment<br/>Consumption]
        Job[Container Apps Job<br/>Node.js batch]
        Identity[User-assigned<br/>Managed Identity]
        Logs[Log Analytics Workspace]
        AppConfig
        ACR
    end

    Env --> Job
    Env --> Logs
    Job -->|Managed Identity| Identity
    Job -->|AcrPull| ACR
    Job -->|設定読み取り| AppConfig
    Job -->|FileREST OAuth| SourceFiles[既存 Azure Files<br/>移動元]
    Job -->|FileREST OAuth| DestinationFiles[既存 Azure Files<br/>移動先]
    Job -->|Blob OAuth| DestinationBlob[既存 Blob Container<br/>移動先]
    Job -->|Private Endpoint / Entra / TLS| History[PostgreSQL<br/>executionlog]
```

## 3. Terraform 管理対象

| リソース | 設計 |
| --- | --- |
| Resource Group | 指定名、または `<name_prefix>-rg` |
| Log Analytics Workspace | `PerGB2018`、保持 30 日 |
| Container Apps Environment | Consumption workload profile |
| Azure Container Registry | Basic、管理者認証無効 |
| Azure App Configuration | Free または Standard、ローカル認証無効 |
| User-assigned Managed Identity | Job 実行専用 |
| Container Apps Job | 0.5 vCPU、1 GiB、単一コンテナー |
| RBAC | ACR、App Configuration、Files、Blob の最小対象スコープ |
| PostgreSQL Flexible Server | PostgreSQL 16、32 GiB、Burstable、Entra のみ、バックアップ 7 日、HA なし |
| VNet／サブネット | Container Apps 専用 `/23`、DB Private Endpoint 専用 `/24` |
| Private Endpoint／Private DNS | DB 公開接続無効、`privatelink.postgres.database.azure.com` |

### Terraform 管理対象外

- 移動元 Storage Account／Azure Files 共有
- 移動先 Storage Account／Azure Files 共有／Blob コンテナー
- App Configuration の `archive:settings` の値
- ACR 内のコンテナーイメージ build
- Storage のネットワーク設定や組織固有タグ
- Log Analytics のアラートルール、通知先

## 4. 命名

`name_prefix` とサブスクリプション ID から固定サフィックスを生成します。

| リソース | 名前 |
| --- | --- |
| Resource Group | `resource_group_name` または `<prefix>-rg` |
| Log Analytics | `<prefix>-logs` |
| Container Apps Environment | `<prefix>-env` |
| Container Apps Job | `<prefix>-job` |
| Managed Identity | `<prefix>-job-mi` |
| ACR | ハイフンを除いた prefix + `acr` + 8 桁サフィックス |
| App Configuration | `<prefix>-config-<8桁サフィックス>` |

同一サブスクリプションと同一 prefix では同じサフィックスを使用します。

## 5. Container Apps Job

### コンピューティング

| 項目 | 値 |
| --- | --- |
| Workload profile | Consumption |
| CPU | 0.5 vCPU |
| メモリ | 1 GiB |
| 並列度 | 1 |
| 完了 replica 数 | 1 |
| Platform retry | 0 |
| 既定 replica timeout | 3,600 秒 |
| 既定アプリ timeout | 3,300 秒 |
| Ingress | なし |

アプリ側 timeout は platform timeout より短くし、SIGTERM 前に cleanup を試行できる余裕を持たせます。

### トリガー

| モード | Terraform 設定 | 動作 |
| --- | --- | --- |
| 基盤のみ | `create_job=false` | Job を作成しない |
| 手動検証 | `create_job=true`, `enable_schedule=false` | Manual Job |
| 日次運用 | `create_job=true`, `enable_schedule=true` | `0 18 * * *` UTC |

日次スケジュールは毎日 18:00 UTC、JST では翌日 03:00 です。
初期 apply は Job を作成せず、イメージと設定の登録後に手動 Job を作成します。
Dry-run 確認後にのみスケジュールを有効化します。

トリガー種別の変更は provider や API の動作により Job の置き換えになる可能性があるため、
実行中の execution がないことと plan を確認して適用します。

## 6. App Configuration

- 設定 JSON 全体を `archive:settings` の 1 キーとして保存します。
- 既定ラベルは `production` です。
- Terraform はストアのみを作成し、設定値を state に保存しません。
- Job は `App Configuration Data Reader` のみを持ちます。
- 指定した運用者には任意で `App Configuration Data Owner` を割り当てます。
- ローカル認証を無効化し、Entra ID 認証を使用します。
- Free は検証・サンプル向けです。本番では Standard と削除保護を検討します。
- Standard の場合、soft-delete 保持期間を 7 日に設定します。
- purge protection は Standard のみ有効化でき、有効化後は不可逆です。

## 7. ACR とイメージ

- ACR Basic を使用します。
- 管理者アカウントを無効化します。
- Job の Managed Identity には `AcrPull` のみを割り当てます。
- イメージ発行者は Entra ID と AcrPush 相当の権限を使用します。
- イメージは `files-archive:<image_tag>` として参照します。
- 同一タグの上書きを避け、リリースごとに不変タグを使用します。
- ローカル Docker が利用できない場合は `az acr build` を使用できます。

## 8. Managed Identity と RBAC

ユーザー割り当て Managed Identity を Job の実行 ID と ACR pull ID に使用します。
接続文字列、Storage Account Key、SAS、App Configuration access key は使用しません。

| 対象 | ロール | スコープ |
| --- | --- | --- |
| ACR | AcrPull | 作成したレジストリ |
| App Configuration | App Configuration Data Reader | 作成したストア |
| 移動元 Azure Files | Storage File Data Privileged Contributor | 指定した共有 |
| 移動先 Azure Files | Storage File Data Privileged Contributor | 指定した共有 |
| 移動先 Blob | Storage Blob Data Contributor | 指定したコンテナー |
| 設定運用者 | App Configuration Data Owner | 作成したストア |

### Azure Files の RBAC スコープ

Terraform 変数には通常の管理プレーン ID を指定します。

```text
.../fileServices/default/shares/<share>
```

FileREST OAuth のデータ操作では `fileshares` スコープが必要なため、
Terraform 内で次へ変換してロールを割り当てます。

```text
.../fileServices/default/fileshares/<share>
```

アカウント全体ではなく共有単位に限定します。
`Storage File Data Privileged Contributor` は NTFS ACL を迂回できる強い権限のため、
Job 専用 ID と対象共有に限定します。

## 9. ネットワーク

現在の最小構成は次の前提です。

- Job は ingress を公開しません。
- Job から ACR、App Configuration、Storage の公開 HTTPS endpoint へ接続します。
- ACR と App Configuration の public network access は有効です。
- 既存 Storage のネットワーク設定は Terraform で変更しません。
- Job 環境を VNet へ接続し、PostgreSQL は Private Endpoint と Private DNS で到達します。
- 既存環境の VNet 統合への変更では Environment と Job の置き換えが必要になる可能性があります。
- DB 管理端末の VPN／peering は対象外です。初回 DB ロール作成にはプライベート接続が必要です。

Storage firewall や Azure Policy で public network access が無効な場合、
RBAC だけでは接続できません。次のいずれかが必要です。

1. 組織で承認された例外により、対象 Storage への公開接続を許可する。
2. VNet 接続の Container Apps Environment、Private Endpoint、
   Private DNS Zone を含むプライベート構成へ拡張する。

組織固有の除外タグを使う場合は、そのポリシー定義と承認範囲を確認します。
Terraform は組織固有タグや Storage の public network access を自動変更しません。

## 10. ログと監視

- アプリケーションログは標準出力の JSON です。
- Container Apps Environment から Log Analytics へ転送します。
- Log Analytics の保持期間は 30 日です。
- Job の platform ログから image pull、replica 作成、終了コードを確認できます。
- アプリログから設定 ETag、候補、移動、失敗、summary を確認できます。
- PostgreSQL に実行とファイル単位の履歴を保存します。保持・削除は運用で管理し、自動再開には使用しません。
- DB 診断ログとメトリックを Log Analytics へ送信します。

現状はアラート、ダッシュボード、長期監査保管を Terraform で作成しません。
本番では次を追加検討します。

- Job failure／`fatal`／`file_failed` のアラート
- 実行未発生の監視
- Log Analytics の保持期間とアクセス制御
- Azure Monitor Workbook

## 11. デプロイ手順

```mermaid
flowchart LR
    A[Terraform: 基盤作成<br/>create_job=false] --> B[ACR にイメージ発行]
    B --> C[App Configuration に<br/>archive:settings 登録]
    C --> D[Terraform: Manual Job 作成]
    D --> E[専用データで Dry-run]
    E --> F{結果と元データ不変を確認}
    F -- NG --> G[設定・権限・ネットワークを修正]
    G --> E
    F -- OK --> H[必要時に dryRun=false]
    H --> I[限定データで実移動確認]
    I --> J[enable_schedule=true]
```

### 段階デプロイの理由

- 未発行イメージを参照する Job を作成しないためです。
- 設定未登録の Job が誤実行されることを防ぎます。
- 最初に手動 Dry-run を行い、対象件数とネットワーク／RBAC を確認します。
- 実移動と定期実行を明示的な別段階に分けます。

## 12. Terraform 状態管理

- 現状はローカル state です。
- state、plan、実環境用 tfvars は Git へ追加しません。
- 共同運用では、アクセス制御と state lock を備えた Azure Storage backend 等へ移行します。
- 既存 Resource Group を使用する場合は Terraform state へ import してから apply します。
- App Configuration 値や Storage データは state に保持しません。

## 13. 可用性・拡張性

現状は最小実装で、次の特性があります。

- ファイルは直列処理です。
- Job replica は 1 です。
- Job の platform retry は 0 です。
- 進捗台帳がないため、中断後は共有全体を再走査します。
- 同じ Job の複数 execution を完全には排他制御しません。
- App Configuration Free、ACR Basic、Consumption を採用します。

対象件数や処理時間が増えた場合は、次を検討します。

- ルールまたはディレクトリ単位の分割
- キューを利用したファイル単位の並列化
- 履歴 DB を拡張した自動再開用の処理台帳
- 再開・重複排除設計
- Dedicated workload profile
- App Configuration Standard
- Private Endpoint と固定送信経路

## 14. セキュリティ方針

- 共有キー、SAS、接続文字列を使用しません。
- Managed Identity と共有／コンテナー単位 RBAC を使用します。
- ACR 管理者認証と App Configuration ローカル認証を無効化します。
- コンテナーは非 root ユーザーで実行します。
- App Configuration に秘密情報を保存しません。
- Job は ingress を持ちません。
- Dry-run を既定とし、実移動とスケジュールは段階的に有効化します。
- 移動先を上書きせず、検証完了前に元ファイルを削除しません。

## 15. Terraform の対象外

- Storage Account／共有／コンテナーの Terraform 作成
- Storage／ACR／App Configuration の Private Endpoint
- Azure Monitor アラート
- リモート Terraform backend
- マルチリージョン／DR
- Job execution 間の分散排他
- Web UI 用 Container App と組み込み認証のデプロイ（Bicep で対応）
- 履歴を使用した自動再開（アプリケーションでも未実装）

## 16. Web UI を含む専用検証環境（Bicep）

`infra\web-demo\` は空の専用環境に Web UI・バッチ・合成データを配置する検証用です。
既存業務 Storage を使う Terraform と異なり、対象 Storage も新規作成します。

| 定義 | 責務 |
| --- | --- |
| `main.bicep` | VNet、NSG、実行環境、ログ、ACR、App Configuration、2 つの ID、PostgreSQL、Storage、Private Endpoint、RBAC |
| `workloads.bicep` | Web Container App、組み込み Entra 認証、Manual Job |
| `schedule-access.bicep` | Web 用 ID に指定 Job の読み取り・更新・起動・execution 参照だけを付与 |
| `helper.bicep` | DB 初期化、合成データ作成、検証を実行する Manual Job |
| `app\scripts\deploy-demo.ps1` | 基盤・イメージ・初期化・公開・検証の段階実行。既存リソースの削除は行わない |

### 構成と Terraform との差分

| 項目 | Bicep の専用検証環境 |
| --- | --- |
| Web | 外部 HTTPS ingress、0.5 vCPU／1 GiB、最小・最大とも 1 replica。`/healthz` 以外は認証必須 |
| バッチ | 0.5 vCPU／1 GiB、Manual、retry 0、replica timeout 600 秒、アプリ timeout 540 秒 |
| helper | 同じイメージを使う Manual Job、retry 0、timeout 300 秒。モードごとに実行用 Managed Identity を切り替える |
| イメージ | リポジトリルートの `app\Dockerfile` で Web と job をビルドし、`archive-console:<tag>` として共有 |
| 設定 | `archive:settings`／ラベル `validation`。Dry-run、上限 100、90 日より古い Files → Blob Cool の 1 ルール |
| PostgreSQL | 16／Standard_B1ms／32 GiB、`executionlog`、Entra のみ、TLS 1.2 以上、公開接続無効 |
| Storage | 専用 Standard LRS、SMB 共有 `source`（5 GiB）、Blob コンテナー `archive`。公開接続・共有キー・Blob 匿名アクセス無効 |
| ネットワーク | `10.46.0.0/16`、Container Apps `/23`、Private Endpoint `/24`、各 NSG。PostgreSQL・File・Blob の Private Endpoint と Private DNS |
| 外向き接続 | ACR Basic と App Configuration Free は公開 HTTPS。Container Apps サブネットの `defaultOutboundAccess` は有効。NAT／固定送信 IP は作成しない |
| 命名 | prefix とリソースグループ ID から 6 桁サフィックスを生成。Terraform の命名規則とは別 |

アドレス範囲、SKU、DB 名などは検証用の固定値を含みます。
別ネットワークへの接続や本番利用では、定義を確認してから設計を見直してください。
Terraform の DB 診断設定、削除保護などが Bicep にも同じように含まれるとは限りません。

### 権限と認証

| ID | 権限 |
| --- | --- |
| Job | ACR の AcrPull、App Configuration の Data Reader、専用 Storage アカウントの File Data Privileged Contributor、`archive` コンテナーの Blob Data Contributor |
| Web | ACR の AcrPull、App Configuration の Data Owner、指定 Job だけのカスタム管理ロール。Storage 権限なし |
| 操作者 | App Configuration の Data Owner、PostgreSQL の Entra 管理者。必要な Azure／Entra デプロイ権限は別途用意 |
| DB `archive_job` | `executionlog` への CONNECT、public スキーマへの USAGE／CREATE、履歴テーブルの所有・書き込み |
| DB `archive_web` | CONNECT／USAGE／SELECT のみ。Job が作成するテーブルへの既定 SELECT 権限も初期化 |

FileREST 権限は、合成データだけを置く専用 Storage アカウント全体への割り当てです。
業務データを置くアカウントへそのまま適用しないでください。

Web の利用者認証は既存のシングルテナント Entra アプリ登録を使用します。
デプロイ時にログインした操作者のオブジェクト ID だけをアプリ側で許可します。
DB／Storage の接続にパスワードや共有キーは使用しませんが、Easy Auth 用には
180 日のクライアントシークレットを発行し、Container App の secret に保持します。
DB 初期化用の短命な管理者トークンは helper の secure parameter／secret 経由で渡し、
初期化後は secret と環境変数参照を除去します。いずれもソースや平文の設定ファイルには保存しません。

### 検証範囲

2026-11-20 に Japan East の専用環境で、Entra サインイン、画面・API、条件付き設定保存、
無効スケジュール保存、Web UI からの単発 Dry-run と履歴記録を確認しました。
DB の読み取り専用権限、実リソースの RBAC、元ファイルの内容・日時の保持、
移動先が空のままであることも確認しています。
実コピー・削除、定期実行の発火、可用性・復旧試験は含みません。
環境は保持しており、継続課金と認証シークレット更新が必要です。

前提権限、段階実行、再デプロイ時の注意点は
[Web UI のデプロイ手順](web-ui.md#専用検証環境のデプロイ)を参照してください。

