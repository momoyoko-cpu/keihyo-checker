// 実APIを使ったエンドツーエンドのライブテスト
// 金融＋特商法(定期購入)の論点を含むサンプル広告を生成し、analyzeDocument を実呼び出しする。
import "../lib/env.js";
import PDFDocument from "pdfkit";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeWorkDir, ensurePdf, renderPages, extractWords } from "../lib/extract.js";
import { analyzeDocument } from "../lib/analyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "tmp-live");
const JP_FONT = path.join(__dirname, "..", "assets", "fonts", "NotoSansJP-Regular.otf");

async function genAdPdf(file) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const ws = createWriteStream(file);
    doc.pipe(ws);
    doc.registerFont("JP", JP_FONT);
    doc.font("JP");
    doc.fontSize(34).fillColor("#c00").text("年利20%を保証！", { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(24).fillColor("#000").text("元本保証で必ず儲かる資産運用", { align: "center" });
    doc.moveDown(0.6);
    doc.fontSize(30).fillColor("#06c").text("初回0円キャンペーン", { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(16).fillColor("#000").text("満足度No.1の投資サブスク", { align: "center" });
    doc.moveDown(2);
    doc.fontSize(5).fillColor("#999").text(
      "※投資にはリスクがあり元本を保証するものではありません。年利は過去実績であり将来を保証しません。初回0円は最低6か月の継続が条件で、2回目以降は月額9,800円が発生します。解約は電話のみ受付。満足度No.1は当社調べ。",
      { align: "left" }
    );
    doc.end();
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY が未設定です（.env を確認）。");
    process.exit(1);
  }
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const ad = path.join(OUT, "ad.pdf");
  await genAdPdf(ad);
  console.log("✓ サンプル広告PDF生成");

  const workDir = await makeWorkDir();
  await fs.copyFile(ad, path.join(workDir, "input.pdf"));
  const pdfPath = await ensurePdf(path.join(workDir, "input.pdf"), workDir);
  const [pages, words] = await Promise.all([
    renderPages(pdfPath, workDir),
    extractWords(pdfPath, workDir),
  ]);
  console.log(`✓ 抽出完了: ${pages.length}ページ`);

  console.log("→ Claude API 呼び出し中（業種=金融, 併用=特商法）...");
  const t0 = process.hrtime.bigint();
  const { results, scope } = await analyzeDocument(pages, words, (d, t) => {
    process.stdout.write(`\r  進捗 ${d}/${t}ページ`);
  }, { industry: "finance", laws: ["tokushoho"] });
  const sec = Number(process.hrtime.bigint() - t0) / 1e9;
  console.log(`\n✓ 解析完了（${sec.toFixed(1)}秒）  スコープ: ${scope.scopeText}`);

  for (const r of results) {
    console.log(`\n=== ページ${r.page} : ${r.findings.length}件 ===`);
    if (r.error) console.log("  エラー:", r.error);
    console.log("  要約:", r.page_summary);
    r.findings.forEach((f, i) => {
      const sz = f.box ? ` (約${f.box.sizePt}pt, box=${f.box ? "特定OK" : "なし"})` : " (位置特定なし)";
      console.log(`  [${i + 1}] 【${f.severity}】[${f.law}] ${f.category}${sz}`);
      console.log(`      該当: 「${f.quote}」`);
      console.log(`      理由: ${f.reason}`);
      console.log(`      根拠: ${f.law_basis}`);
      console.log(`      改善: ${f.suggestion}`);
    });
  }

  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(OUT, { recursive: true, force: true });
  console.log("\n完了。");
}

main().catch((e) => {
  console.error("\nライブテスト失敗:", e);
  process.exit(1);
});
