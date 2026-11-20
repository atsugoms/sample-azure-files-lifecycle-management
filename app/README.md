# Archive Console

Azure Files アーカイブジョブの日本語 Web UI です。
設定編集、現行 DB の実行・ファイル履歴参照、定期実行の設定、単発起動に対応します。
履歴 DB は読み取り専用とし、スキーマ変更・自動再開・障害復旧は行いません。

機能、環境変数、ローカル起動、コンテナービルド、Azure 公開時の前提条件は、
[Web UI の解説](../docs/web-ui.md) を参照してください。

Node.js 24 を使用し、リポジトリルートから次を実行します。
設定と、ジョブが初期化した履歴 DB が別途必要です。

```powershell
npm ci --prefix .\job
npm ci --prefix .\app
npm run build --prefix .\app
# docs\web-ui.md に従って Azure 認証・設定先・履歴 DB の環境変数を指定
npm start --prefix .\app
```

ローカル URL は `http://127.0.0.1:3000` です。
旧 `HISTORY_*` ではなく、バッチと同じ `DB_DRIVER`、`SQLITE_PATH`、`PG*` を使用します。
