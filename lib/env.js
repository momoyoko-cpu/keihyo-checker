// 依存なしの軽量 .env ローダー
// プロジェクトルートの .env を読み、未設定の環境変数だけを補完する。
// （Railway等では実際の環境変数が使われ .env は無くてよい）
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!existsSync(envPath)) return;
  let text;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 前後のクォートを除去
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

// import された時点で（他モジュールの評価前に）.env を読み込む副作用。
// 既存の環境変数は上書きしないため、テストやRailwayの実環境変数が優先される。
loadEnv();
