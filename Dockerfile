# 景表法チェックツール 本番イメージ
# LibreOffice(PPTX→PDF変換) + poppler-utils(PDF→画像/座標抽出) + 日本語フォント を同梱
FROM node:20-bookworm-slim

# システム依存をインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      libreoffice-writer \
      libreoffice-core \
      poppler-utils \
      fonts-noto-cjk \
      fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存インストール（キャッシュ最適化）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# アプリ本体
COPY . .

# Railway は $PORT を注入する
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
