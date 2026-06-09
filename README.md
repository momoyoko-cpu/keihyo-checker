# 景表チェッカー

PDF / PowerPoint をアップロードすると、**Claude（AI）が景表法・特商法などの不当表示のおそれを検出**し、
ページ画像上にハイライト表示・文字サイズの可視化を行い、**PDF指摘レポート**をダウンロードできる Web アプリです。

## 主な機能

- 📄 **PDF / PowerPoint(.pptx/.ppt) のアップロード**（ドラッグ&ドロップ）
- 🔍 **AI判定**: 優良誤認・有利誤認・指定告示・打消し表示の観点でページごとに審査（テキスト＋画像の両方を解析）
- 🎯 **ビジュアル表示**: 問題箇所をページ画像上にハイライト枠で表示
- 🔠 **文字サイズの可視化**: 打消し表示などの実フォントサイズ(pt)を抽出・表示
- 📥 **PDFレポート出力**: 指摘・根拠条文・改善案をまとめてダウンロード

## 仕組み

```
アップロード
   │  (PPTXなら LibreOffice で PDF 変換)
   ▼
PDF ──┬─ pdftoppm   → 各ページを PNG 画像化
      └─ pdftotext  → 単語ごとの座標・フォントサイズ(pt)を抽出
   ▼
Claude API (vision + text) で景表法判定 → 構造化された指摘
   ▼
該当表現を座標に突き合わせ → Web overlay / PDFレポートにハイライト
```

- 判定基準データ（モジュール構成）: [`knowledge/`](knowledge/)
  （出典: e-Gov法令検索「不当景品類及び不当表示防止法」法令ID 337AC0000000134 ／「特定商取引に関する法律」法令ID 351AC0000000057 ／ 消費者庁ガイドライン・各公正競争規約）

## 業種プロファイル・併用法令のカスタマイズ

アップロード画面で **業種プロファイル** と **併用してチェックする法令** を選ぶと、
選択に応じて判定基準（システムプロンプト）と検出類型が動的に切り替わります。

| 種別 | 同梱モジュール |
|------|----------------|
| 共通（常に適用） | `knowledge/base.md`（景表法 第5条3類型・打消し表示・No.1表示 等） |
| 業種: 金融・投資 | `knowledge/industries/finance.md`（利回り/リスク表示/断定的表現 等） |
| 業種: 不動産 | `knowledge/industries/realestate.md`（おとり広告/徒歩分数/新築要件/二重価格 等、公正競争規約準拠） |
| 併用法令: 特定商取引法 | `knowledge/laws/tokushoho.md`（通販表示義務・誇大広告・定期購入規制 等） |

### 新しいプロファイルの追加方法

1. `knowledge/industries/`（業種）または `knowledge/laws/`（法令）に Markdown モジュールを追加
2. [`knowledge/profiles.json`](knowledge/profiles.json) に `id` / `label` / `description` / `module`（相対パス）のエントリを追加
3. 再起動するだけで UI の選択肢に反映される（コード変更不要）

各指摘には「主に抵触するおそれのある法令（`law`）」が付与され、Web表示・PDFレポートともに法令タグ・法令別内訳が表示されます。

## ローカル実行

### 前提

- Node.js 20 以上
- **LibreOffice**（PPTX→PDF変換用） … PDFのみ扱うなら不要
- **poppler-utils**（`pdftoppm` / `pdftotext`）

#### poppler / LibreOffice のインストール

- **Windows**: [poppler for Windows](https://github.com/oschwartz10612/poppler-windows/releases) を入れて `bin` を PATH に追加。LibreOffice は [公式サイト](https://ja.libreoffice.org/) から。`soffice.exe` のパスは `SOFFICE_PATH` 環境変数で指定可。
- **Docker利用**: 同梱の `Dockerfile` に全て含まれるため不要。

### 手順

```bash
npm install
copy .env.example .env   # macOS/Linux は cp
# .env を編集し ANTHROPIC_API_KEY を設定
npm start
```

→ http://localhost:3000 を開く

## Railway へのデプロイ

本リポジトリには `Dockerfile`（LibreOffice + poppler + 日本語フォント同梱）と `railway.json` を含みます。

1. このフォルダを Git リポジトリにして GitHub へ push
2. [Railway](https://railway.app/) で **New Project → Deploy from GitHub repo** を選択
3. Railway が `Dockerfile` を自動検出してビルド
4. **Variables** に環境変数を設定:
   - `ANTHROPIC_API_KEY` （必須）
   - `KEIHYO_MODEL`（任意）
   - `PORT` は Railway が自動設定するため不要
5. デプロイ完了後、公開URLにアクセス

## 環境変数

| 変数 | 必須 | 既定値 | 説明 |
|------|------|--------|------|
| `ANTHROPIC_API_KEY` | ✅ | – | Claude APIキー |
| `KEIHYO_MODEL` | – | `claude-sonnet-4-6` | 判定モデル |
| `KEIHYO_CONCURRENCY` | – | `3` | ページ並列解析数 |
| `PORT` | – | `3000` | 待受ポート（Railwayは自動） |
| `SOFFICE_PATH` | – | `soffice` | LibreOffice実行パス（Windows等） |
| `FONT_PATH` | – | 自動検出 | PDFレポートの日本語フォント |

## 注意事項

- 本ツールは **AIによる一次チェック** です。最終的な判断は条文原文の確認および専門家への相談を推奨します。
- アップロードファイルと解析結果はサーバのメモリ上に一時保持され、1時間で自動破棄されます（永続保存はしません）。
- API利用にはトークン課金が発生します（ページ数×画像解析）。
