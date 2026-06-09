// HTTP経由のe2eテスト: 日本語ファイル名でアップロード→ポーリング→結果取得
import "../lib/env.js";
import PDFDocument from "pdfkit";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE || "http://localhost:3014";
const JP_FONT = path.join(__dirname, "..", "assets", "fonts", "NotoSansJP-Regular.otf");

async function genPdf(file) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const ws = createWriteStream(file);
    doc.pipe(ws);
    doc.registerFont("JP", JP_FONT);
    doc.font("JP").fontSize(36).fillColor("#c00").text("世界初！絶対痩せる", { align: "center" });
    doc.moveDown(2).fontSize(5).fillColor("#999").text("※個人の感想です。効果を保証するものではありません。", { align: "left" });
    doc.end();
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}

async function main() {
  const tmp = path.join(__dirname, "..", "tmp-e2e.pdf");
  await genPdf(tmp);
  const buf = await fs.readFile(tmp);
  const jpName = "テスト広告_日本語名.pdf";

  const form = new FormData();
  form.append("file", new Blob([buf], { type: "application/pdf" }), jpName);
  form.append("industry", "general");
  form.append("laws", JSON.stringify([]));

  console.log("POST /api/check ...");
  const r = await fetch(`${BASE}/api/check`, { method: "POST", body: form });
  const start = await r.json();
  console.log("  →", r.status, JSON.stringify(start));
  if (!start.id) throw new Error("ジョブIDが返りませんでした");

  let result;
  for (let i = 0; i < 120; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    const sr = await fetch(`${BASE}/api/status/${start.id}`);
    const sd = await sr.json();
    if (sd.status === "processing") {
      process.stdout.write(`\r  処理中: ${sd.progress?.phase} ${sd.progress?.done || 0}/${sd.progress?.total || 0}   `);
      continue;
    }
    result = sd;
    break;
  }
  console.log("");
  if (!result) throw new Error("タイムアウト");
  if (result.status === "error") throw new Error("解析エラー: " + result.error);

  console.log("ステータス:", result.status);
  console.log("ファイル名(文字化けしていないか):", result.meta.fileName, "→", result.meta.fileName === jpName ? "✓ 一致" : "✗ 不一致");
  console.log("ページ数:", result.pages.length, "/ 指摘数:", result.pages[0].findings.length);
  result.pages[0].findings.forEach((f, i) => console.log(`  [${i + 1}] 【${f.severity}】${f.category}: 「${f.quote}」${f.box ? ` (${f.box.sizePt}pt,位置OK)` : ""}`));

  // レポートDLも確認
  const rep = await fetch(`${BASE}/api/report/${start.id}`);
  console.log("レポートDL:", rep.status, rep.headers.get("content-type"), `${(await rep.arrayBuffer()).byteLength} bytes`);

  await fs.unlink(tmp).catch(() => {});
  console.log("\ne2e 完了");
}
main().catch((e) => { console.error("\ne2e失敗:", e); process.exit(1); });
