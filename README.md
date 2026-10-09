# Azure Files archive job

Azure Files の指定ディレクトリを定期走査し、一定期間更新されていないファイルを、
事前に用意した Azure Blob Storage または別の Azure Files 共有へ移動するサンプルです。

**Node.js 24 / TypeScript、Azure Container Apps Jobs、Azure App Configuration** を使用します。
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