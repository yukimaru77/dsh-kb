# dsh-kb

保存済みKBをDeepSeek Harnessの会話へ挿入する拡張です。
作者のPi用拡張 `pi-kb 0.2.0` をDSHへ移植しました。

```text
/kb pi
/kb 名前 --store research --file latest
/kb list
/kb status
```

**`kb` コマンド本体の変更は不要です。** 既存の `kb export` で読み取った
暗号化Blob列と `dev.txt` を、読み込んだ版のままDSHセッションに保存します。
KBの再作成や元リポジトリの変更は行いません。

## 動作

- **一度だけ挿入:** `/kb 名前` の実行位置へ追加します。毎requestのprefix追加ではありません。
- **履歴の保持:** 再開・分岐でも同じsnapshotと位置を使い、exportし直しません。
- **初回入力前:** 空の会話では次の入力を待つ形で保存します。終了・再開後も未送信のKBを復元します。
- **Codexへの送信:** Blobの順番と未知フィールドを保持し、`dev.txt` はdeveloper項目として渡します。
- **圧縮との連携:** KBを展開した入力を圧縮します。圧縮済みのKBを過去のsnapshotから再挿入しません。
- **追加応答なし:** `/kb` 自体ではモデル応答を開始しません。繰り返し読み込むと、その回数だけ別の挿入になります。

`/kb` と `/kb status` は挿入履歴・現在有効な件数・初回入力待ちの件数を表示します。
`/kb load 名前` も使えます。`/kb off` は履歴を削除しません。
読み込み後のキャンセルはKB選択の取消ではなく、未送信のKBは次の入力で引き継ぎます。
KBを含まない会話にする場合は、挿入前への分岐・巻き戻し、または新しい会話を使ってください。

## 必要なもの

- Node.js 22.19以降または24以降
- `kb export` 対応の [`kb-repomap`](https://github.com/yukimaru77/kb-repomap)
- [`dsh-pi-compat`](https://github.com/yukimaru77/dsh-pi-compat) のpayload transform API対応版（[`4f7a486`](https://github.com/yukimaru77/dsh-pi-compat/commit/4f7a486) 以降）
- その互換拡張が指定するDSH `0.2.1-rc.2` のインストールとPi認証設定

暗号化KBの会話送信は `openai-codex` に対応しています。
有効なKBを残したまま別providerへ切り替えると、送信を止めます。
先にCodexで会話を圧縮してテキストへ変換するか、新しい会話を使用してください。
認証・アカウント選択は `dsh-pi-compat` に任せます。

## ビルド

先に `dsh-pi-compat` のREADMEに従って依存を準備・ビルドします。

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

`dsh-pi-compat` が導入済みのWeb profileへ追加します。
このリポジトリのルートで実行してください。

```sh
dsh plugin --profile web add "file:$PWD"
dsh web
```

互換拡張のprivate provider overlayを使っている場合は、従来どおり `--patch` で指定してください。
`file:` は導入時点のビルドをコピーするので、再ビルド後は `remove` してから `add` し直します。
動いているWebサーバーへ反映するには、作業が終わってから再起動します。

## TUIへの導入

`dsh-pi-compat` が導入済みのTUI profileへ追加します。

```sh
dsh plugin --profile dsh-tui add "file:$PWD"
```

TUIのモデルをCodexに選択してから `/kb 名前` を実行してください。

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
HTTPと認証データは合成fixtureです。smokeは一時HOMEで両UIの構成を起動します。
実際のKB本文・認証情報・セッションログは、このリポジトリに含めません。

BlobのサイズはDSHの通常のtoken見積もりには含まれません。大きいKBはサーバーの
コンテキスト上限に達する場合があります。Blobを別アカウント・モデルで利用できるかは
Codex側の互換性にも依存します。KBの一部を黙って削る処理は行いません。

## ライセンス

[MIT](LICENSE)。`dsh-pi-compat`、DeepSeek Harness、`kb-repomap` は別リポジトリです。
KBの保存先や認証情報をこの拡張へコピーして配布する必要はありません。
