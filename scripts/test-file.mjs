// 任意のPDFの指定ページだけを解析して指摘を表示する検証スクリプト
// 使い方: node scripts/test-file.mjs "<pdf path>" [industry] [pageCount]
import "../lib/env.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeWorkDir, ensurePdf, renderPages, extractWords } from "../lib/extract.js";
import { analyzeDocument } from "../lib/analyze.js";

const file = process.argv[2];
const industry = process.argv[3] || "general";
const pageCount = Number(process.argv[4] || 1);

async function main() {
  if (!file) { console.error("PDFパスを指定してください"); process.exit(1); }
  const workDir = await makeWorkDir();
  const ext = path.extname(file).toLowerCase();
  await fs.copyFile(file, path.join(workDir, `input${ext}`));
  const pdfPath = await ensurePdf(path.join(workDir, `input${ext}`), workDir);
  let [pages, words] = await Promise.all([renderPages(pdfPath, workDir), extractWords(pdfPath, workDir)]);
  console.log(`総ページ数: ${pages.length} → 先頭${pageCount}ページを解析 (業種=${industry})`);
  pages = pages.slice(0, pageCount);

  const { results } = await analyzeDocument(pages, words, (d, t) => process.stdout.write(`\r  ${d}/${t}`), { industry, laws: [] });
  for (const r of results) {
    console.log(`\n=== ページ${r.page} : ${r.findings.length}件 ===`);
    if (r.error) console.log("  エラー:", r.error);
    console.log("  要約:", r.page_summary);
    r.findings.forEach((f, i) => {
      console.log(`  [${i + 1}] 【${f.severity}】[${f.law}] ${f.category}${f.box ? ` (約${f.box.sizePt}pt,位置OK)` : " (位置未特定)"}`);
      console.log(`      該当: 「${f.quote}」`);
      console.log(`      理由: ${f.reason}`);
      console.log(`      改善: ${f.suggestion}`);
    });
  }
  await fs.rm(workDir, { recursive: true, force: true });
}
main().catch((e) => { console.error("\n失敗:", e); process.exit(1); });
