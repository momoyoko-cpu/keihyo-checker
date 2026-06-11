// テキスト → 単一ページPDF 生成モジュール
// 貼り付けテキスト/.txt を LibreOffice に通すと自動ページ割りで空白ページや
// 不要なページ分割が起きるため、pdfkit で「内容の高さに合わせた1ページ」を直接描画する。
import PDFDocument from "pdfkit";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";

// 日本語フォントの探索候補（先に見つかったものを使う）。
// Dockerfile で fonts-ipafont-gothic / fonts-noto-cjk を導入している前提。
const FONT_CANDIDATES = [
  process.env.KEIHYO_JP_FONT,
  "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf",
  "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-JP-Regular.otf",
  "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
].filter(Boolean);

const PAGE_WIDTH_PT = 595.28; // A4 幅
const MARGIN_PT = 50;
const FONT_SIZE_PT = 14;
const LINE_GAP_PT = 6;

async function resolveFontPath() {
  for (const p of FONT_CANDIDATES) {
    try {
      await fs.access(p);
      return p;
    } catch {
      /* 次の候補へ */
    }
  }
  return null; // 見つからなければ pdfkit 既定フォント（日本語は出ないが処理は継続）
}

/**
 * テキストを内容量に合わせた高さの単一ページPDFにして workDir/input.pdf を返す。
 */
export async function textToPdf(text, workDir) {
  const fontPath = await resolveFontPath();
  const contentWidth = PAGE_WIDTH_PT - MARGIN_PT * 2;
  const clean = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n") || " ";

  // 1) 高さ測定（描画と同じフォント/サイズ/行間/幅で計測する）
  const measure = new PDFDocument({ autoFirstPage: true });
  if (fontPath) measure.font(fontPath);
  measure.fontSize(FONT_SIZE_PT);
  const textHeight = measure.heightOfString(clean, {
    width: contentWidth,
    lineGap: LINE_GAP_PT,
  });

  const pageHeight = Math.max(textHeight + MARGIN_PT * 2, 200);

  // 2) 計測した高さで1ページだけ生成
  const pdfPath = path.join(workDir, "input.pdf");
  const doc = new PDFDocument({ autoFirstPage: false });
  const stream = createWriteStream(pdfPath);
  const finished = new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  doc.pipe(stream);
  doc.addPage({ size: [PAGE_WIDTH_PT, pageHeight], margin: MARGIN_PT });
  if (fontPath) doc.font(fontPath);
  doc
    .fontSize(FONT_SIZE_PT)
    .fillColor("#111111")
    .text(clean, { width: contentWidth, lineGap: LINE_GAP_PT, align: "left" });
  doc.end();
  await finished;
  return pdfPath;
}
