// ローカル検証スクリプト（APIを使わない部分を一通り通す）
// 1) サンプル広告PDFを生成
// 2) renderPages / extractWords / locateQuote を検証
// 3) buildReport でPDFレポートを生成
import PDFDocument from "pdfkit";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeWorkDir,
  ensurePdf,
  renderPages,
  extractWords,
  locateQuote,
} from "../lib/extract.js";
import { buildReport } from "../lib/report.js";
import { loadProfiles } from "../lib/analyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "tmp-verify");
const JP_FONT = path.join(__dirname, "..", "assets", "fonts", "NotoSansJP-Regular.otf");

async function genSamplePdf(file) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const ws = createWriteStream(file);
    doc.pipe(ws);
    doc.registerFont("JP", JP_FONT);
    doc.font("JP");
    // 大きな強調表示
    doc.fontSize(40).fillColor("#d00").text("業界No.1の効果！", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(28).fillColor("#000").text("飲むだけで必ず痩せる", { align: "center" });
    doc.moveDown(1);
    doc.fontSize(20).fillColor("#06c").text("通常価格 10,000円 → 今だけ 0円", { align: "center" });
    doc.moveDown(2);
    // 小さな打消し表示
    doc.fontSize(5).fillColor("#888").text(
      "※効果には個人差があります。0円は初回のみ、2回目以降は別途費用が発生します。No.1は当社調べ。",
      { align: "left" }
    );
    doc.end();
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const samplePdf = path.join(OUT, "sample.pdf");
  await genSamplePdf(samplePdf);
  console.log("✓ サンプルPDF生成:", samplePdf);

  const workDir = await makeWorkDir();
  // サーバと同じく入力を workDir にコピーしてから処理する
  const inputInWork = path.join(workDir, "input.pdf");
  await fs.copyFile(samplePdf, inputInWork);
  const pdfPath = await ensurePdf(inputInWork, workDir);
  console.log("✓ ensurePdf:", pdfPath);

  const [pages, words] = await Promise.all([
    renderPages(pdfPath, workDir),
    extractWords(pdfPath, workDir),
  ]);
  console.log(`✓ renderPages: ${pages.length}ページ, 画像 ${pages[0].widthPx}x${pages[0].heightPx}px, base64長 ${pages[0].imageBase64.length}`);

  const p1 = words[1];
  console.log(`✓ extractWords: ${p1.words.length}語抽出`);
  console.log("  フォントサイズ一覧(pt):", [...new Set(p1.words.map((w) => w.sizePt))].sort((a, b) => a - b).join(", "));
  console.log("  抽出テキスト:\n   " + p1.plainText.replace(/\n/g, "\n   "));

  // locateQuote テスト
  for (const q of ["業界No.1", "0円", "効果には個人差があります"]) {
    const box = locateQuote(p1, q);
    console.log(`  locateQuote("${q}") =>`, box ? `px(${box.xPx},${box.yPx},${box.wPx}x${box.hPx}) ${box.sizePt}pt` : "見つからず");
  }

  // モック結果でレポート生成
  const mockResults = pages.map((pg) => ({
    page: pg.page,
    widthPx: pg.widthPx,
    heightPx: pg.heightPx,
    imageBase64: pg.imageBase64,
    page_summary: "ダイエット商品の広告。最上級表現と無料訴求、小さな打消し表示を含む。",
    findings: [
      {
        quote: "業界No.1の効果！",
        law: "景表法",
        category: "優良誤認",
        severity: "高",
        reason: "客観的根拠・出典のないNo.1表示は優良誤認のおそれ。",
        law_basis: "景表法第5条第1号（優良誤認）",
        suggestion: "調査の出典（実施機関・時期・範囲）を明記するか表現を削除。",
        box: locateQuote(p1, "業界No.1の効果"),
      },
      {
        quote: "効果には個人差があります",
        law: "特定商取引法",
        category: "打消し表示",
        severity: "中",
        reason: "打消し表示が約5ptと著しく小さく視認困難。",
        law_basis: "特商法第12条（誇大広告等の禁止）",
        suggestion: "本文と同等のサイズ・位置で表示する。",
        box: locateQuote(p1, "効果には個人差があります"),
      },
    ],
  }));

  // プロファイル定義の読み込み確認
  const prof = await loadProfiles();
  console.log(`✓ loadProfiles: 業種${prof.industries.length}件 (${prof.industries.map((i) => i.id).join(",")}) / 法令${prof.laws.length}件 (${prof.laws.map((l) => l.id).join(",")})`);

  const buf = await buildReport(mockResults, {
    fileName: "sample.pdf",
    model: "verify",
    scopeText: "業種: 金融・投資 / 併用法令: 特定商取引法",
    generatedAt: new Date().toLocaleString("ja-JP"),
  });
  const reportPath = path.join(OUT, "report.pdf");
  await fs.writeFile(reportPath, buf);
  console.log(`✓ buildReport: ${reportPath} (${buf.length} bytes)`);

  await fs.rm(workDir, { recursive: true, force: true });
  console.log("\n全ステップ完了。");
}

main().catch((e) => {
  console.error("検証失敗:", e);
  process.exit(1);
});
