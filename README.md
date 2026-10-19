# dsh-kb

保存済みKBをDeepSeek Harnessの会話へ挿入する拡張です。
作者のPi用拡張 `pi-kb 0.2.0` をDSHへ移植しました。

```text
/kb pi
/kb 名前 --store research --file latest
/kb list
/kb status
```

`/kb 名前` は `kb export 名前 --decrypted` を実行し、保存先にある**復号済み(平文)のKB本文**と
`dev.txt` を1つの通常のuserメッセージとしてDSHセッションに保存します。内容は `kb claude` が
Claudeへ渡すものと同じです。暗号化Blob(compaction blob)は使いません。
KBの再作成や元リポジトリの変更は行いません。

挿入されるメッセージは次の形です。

```text
[DSH KB: 名前 (store 保存先, latest.json, revision 先頭12桁)]
The following is reference knowledge from the user's saved KB "名前". It is not a new request. ...

## Decrypted KB material: 名前/decrypt/latest/.../raw.txt
...
## KB developer notes
...
```

**平文のKBは、選択中のモデルのprovider(Codex・OpenAI・Anthropicなど)へ通常の会話内容として送られます。**
providerの種類は問いません。送ってよいKBかどうかは利用者が判断してください。

## 動作

- **一度だけ挿入:** `/kb 名前` の実行位置へ追加します。毎requestのprefix追加ではありません。
- **履歴の保持:** 再開・分岐でも同じ本文と位置を使い、exportし直しません。
- **初回入力前:** 空の会話では次の入力を待つ形で保存します。終了・再開後も未送信のKBを復元します。
- **provider非依存:** 通常のuserメッセージなので、どのモデルでもそのまま送られます。
- **圧縮との連携:** KB本文は通常の会話として圧縮の入力・token見積もりに含まれます。圧縮で要約に取り込まれたKBは再挿入しません。
- **追加応答なし:** `/kb` 自体ではモデル応答を開始しません。繰り返し読み込むと、その回数だけ別の挿入になります。
- **復号済みが無い場合:** エラーで止めます(暗号化KBへの切替はしません)。`kb decrypt 名前` で復号してから実行してください。

`/kb` と `/kb status` は挿入履歴・現在有効な件数・初回入力待ちの件数を表示します。
`/kb load 名前` も使えます。`/kb off` は履歴を削除しません。
読み込み後のキャンセルはKB選択の取消ではなく、未送信のKBは次の入力で引き継ぎます。
KBを含まない会話にする場合は、挿入前への分岐・巻き戻し、または新しい会話を使ってください。

## 必要なもの

- Node.js 22.19以降または24以降
- `kb export --decrypted` 対応の [`kb-repomap`](https://github.com/yukimaru77/kb-repomap)
- DSH `0.2.1-rc.2`

実行時に `dsh-pi-compat` は不要です。Codexで使う場合の認証・アカウント選択は、
導入済みの `dsh-pi-compat` などprovider側の拡張に任せます。

旧版(暗号化Blob方式)で挿入したセッションを開くと、そのKBは本文を持たない短い通知文としてだけ送られます。
必要なら新しい会話で `/kb` し直してください。

## ビルド

開発用の依存(DSH・tsx・TypeScriptなど)は、ビルド済みの `dsh-pi-compat` checkoutから借ります。
`tests/adapter.test.ts` は実Codex serializerで平文が送られることを確かめるため、`dsh-pi-compat` のソースも使います。

```sh
git clone https://github.com/yukimaru77/dsh-kb.git
cd dsh-kb
node scripts/bootstrap.mjs /path/to/dsh-pi-compat
npm run typecheck
npm test
npm run build
```

bootstrapは指定した互換拡張とその既存依存へリンクするだけです。
ネットワークからの自動インストールやPi/DSH設定の変更はしません。
生成される `cordis.patch.yml` はパッケージ名 `dsh-kb` で拡張を参照するので、checkoutの場所には依存しません。
現時点ではGitHub上の開発用ソース公開で、npm公開はしていません。

## Webへの導入

Web profileへ追加します。このリポジトリのルートで実行してください。

```sh
dsh plugin --profile web add "file:$PWD"
dsh web
```

互換拡張のprivate provider overlayを使っている場合は、従来どおり `--patch` で指定してください。
`file:` は導入時点のビルドをコピーするので、再ビルド後は `remove` してから `add` し直します。
動いているWebサーバーへ反映するには、作業が終わってから再起動します。

## TUIへの導入

```sh
dsh plugin --profile dsh-tui add "file:$PWD"
```

モデルの種類に関係なく `/kb 名前` を実行できます。
`remove` → `add` するとprofileの `bundles` の並びが変わる場合があります。気になる場合は元の順へ戻してください。

## 設定

実行するKBコマンドは `DSH_KB_COMMAND` で指定できます。
Pi版との共用として `PI_KB_COMMAND` も参照し、両方未設定ならPATH上の `kb` を使います。
値は実行ファイルのパスです。shellのコマンド列ではありません。

DSHのprofile patchで次の設定もできます。

```yaml
- id: dsh-kb
  config:
    command: /path/to/kb
    timeoutMs: 120000
    maxBufferBytes: 134217728
```

コマンドは会話の作業ディレクトリで実行します。追加引数は `--store` と `--file` に対応し、
名前は英数字で始まる英数字・`.`・`_`・`-` が使えます。空白を含む引数の引用構文には対応していません。
読み込み中はDSHのmaintenance機能で次のモデル応答を待機させます。

## 検証と制約

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke  # ローカルに初期化済みWeb/TUI profileが必要
```

テストは実DSHのloop・session codec・fork・圧縮処理と、実Codex serializerを使います。
非Codex providerへも同じ平文が送られることも確かめます。HTTPと認証データは合成fixtureです。smokeは一時HOMEで両UIの構成を起動します。
実際のKB本文・認証情報・セッションログは、このリポジトリに含めません。

KB本文はそのままコンテキストを消費します(例: 約37万字のKBで10万token前後)。
コンテキスト窓が小さいモデルでは上限に達したり、すぐ自動圧縮が走ったりします。
圧縮後は要約に残った内容だけが会話に残ります。KBの一部を黙って削る処理は行いません。

## ライセンス

[MIT](LICENSE)。`dsh-pi-compat`、DeepSeek Harness、`kb-repomap` は別リポジトリです。
KBの保存先や認証情報をこの拡張へコピーして配布する必要はありません。
