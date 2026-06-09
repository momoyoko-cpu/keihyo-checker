// PDF指摘レポート生成モジュール（pdfkit）
// ページ画像 + ハイライト枠 + 指摘/改善提案を1つのPDFにまとめる。
import PDFDocument from "pdfkit";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 日本語フォントの候補。同梱の NotoSansJP-Regular.otf を最優先（環境非依存で確実）。
// FONT_PATH 環境変数で上書き可。
const FONT_CANDIDATES = [
  process.env.FONT_PATH,
  path.join(__dirname, "..", "assets", "fonts", "NotoSansJP-Regular.otf"),
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJKjp-Regular.otf",
].filter(Boolean);

const SEVERITY_COLOR = { 高: "#d93025", 中: "#f29900", 低: "#1a73e8" };
const SEV_LABEL = { 高: "必須", 中: "推奨（強）", 低: "推奨（弱）" };
const sevLabel = (s) => SEV_LABEL[s] || s;

function findFont() {
  for (const p of FONT_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * results: analyzeDocument の返り値
 * meta: { fileName, model, generatedAt }
 * 返り値: PDFのBuffer
 */
export async function buildReport(results, meta) {
  const fontPath = findFont();
  const doc = new PDFDocument({ size: "A4", margin: 40, autoFirstPage: false });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // フォント登録
  let JP = "Helvetica";
  if (fontPath) {
    try {
      if (fontPath.toLowerCase().endsWith(".ttc")) {
        doc.registerFont("JP", fontPath, "Noto Sans CJK JP");
      } else {
        doc.registerFont("JP", fontPath);
      }
      JP = "JP";
    } catch {
      // フォント登録失敗時はHelvetica（日本語は表示できないが落とさない）
    }
  }
  doc.font(JP);

  const allFindings = results.flatMap((r) => r.findings.map((f) => ({ ...f, page: r.page })));
  const counts = { 高: 0, 中: 0, 低: 0 };
  for (const f of allFindings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  // ===== 表紙・サマリー =====
  doc.addPage();
  doc.fontSize(20).fillColor("#202124").text("景表チェッカー 指摘レポート", { align: "left" });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#5f6368");
  doc.text(`対象ファイル: ${meta.fileName}`);
  doc.text(`総ページ数: ${results.length}`);
  if (meta.scopeText) doc.text(`審査スコープ: ${meta.scopeText}`);
  doc.text(`判定モデル: ${meta.model}`);
  doc.text(`生成日時: ${meta.generatedAt}`);
  doc.moveDown(1);

  doc.fontSize(13).fillColor("#202124").text("指摘サマリー");
  doc.moveDown(0.3);
  doc.fontSize(11);
  doc.fillColor(SEVERITY_COLOR["高"]).text(`必須（要修正）: ${counts["高"] || 0} 件`);
  doc.fillColor(SEVERITY_COLOR["中"]).text(`推奨（強）: ${counts["中"] || 0} 件`);
  doc.fillColor(SEVERITY_COLOR["低"]).text(`推奨（弱）: ${counts["低"] || 0} 件`);
  // 法令別の内訳
  const byLaw = {};
  for (const f of allFindings) {
    const k = f.law || "景表法";
    byLaw[k] = (byLaw[k] || 0) + 1;
  }
  if (Object.keys(byLaw).length) {
    doc.moveDown(0.4);
    doc.fillColor("#5f6368").fontSize(10).text(
      "法令別: " + Object.entries(byLaw).map(([k, v]) => `${k} ${v}件`).join(" / ")
    );
  }
  doc.moveDown(1);
  doc
    .fontSize(8)
    .fillColor("#9aa0a6")
    .text(
      "※本レポートはAIによる一次チェックです。最終的な判断は条文原文の確認および専門家への相談を推奨します。",
      { width: 515 }
    );

  // ===== ページごとの指摘 =====
  for (const r of results) {
    if (!r.findings.length && !r.error) continue;
    doc.addPage();
    doc.fontSize(14).fillColor("#202124").text(`ページ ${r.page}`);
    doc.moveDown(0.3);
    if (r.page_summary) {
      doc.fontSize(9).fillColor("#5f6368").text(r.page_summary, { width: 515 });
      doc.moveDown(0.5);
    }

    // ページ画像（ハイライト枠付き）
    if (r.imageBase64) {
      const img = Buffer.from(r.imageBase64, "base64");
      const maxW = 515;
      const scale = Math.min(maxW / r.widthPx, 1);
      const drawW = r.widthPx * scale;
      const drawH = r.heightPx * scale;
      const x0 = doc.x;
      const y0 = doc.y;
      try {
        doc.image(img, x0, y0, { width: drawW });
      } catch {
        /* 画像描画失敗は無視 */
      }
      // ハイライト枠
      for (const f of r.findings) {
        if (!f.box) continue;
        const color = SEVERITY_COLOR[f.severity] || "#d93025";
        doc
          .save()
          .lineWidth(1.5)
          .strokeColor(color)
          .rect(
            x0 + f.box.xPx * scale,
            y0 + f.box.yPx * scale,
            f.box.wPx * scale,
            f.box.hPx * scale
          )
          .stroke()
          .restore();
      }
      doc.y = y0 + drawH + 10;
      doc.x = x0;
    }

    if (r.error) {
      doc.fontSize(9).fillColor(SEVERITY_COLOR["高"]).text(`解析エラー: ${r.error}`);
    }

    // 指摘リスト
    let n = 1;
    for (const f of r.findings) {
      ensureSpace(doc, 90);
      const color = SEVERITY_COLOR[f.severity] || "#202124";
      const lawTag = f.law ? `[${f.law}] ` : "";
      doc.fontSize(11).fillColor(color).text(`【${sevLabel(f.severity)}】${lawTag}${f.category}  #${n}`);
      doc.fontSize(9).fillColor("#202124");
      doc.text(`該当表現: 「${f.quote}」`, { width: 515 });
      if (f.box) {
        doc.fillColor("#5f6368").text(`表示サイズ: 約${f.box.sizePt}pt`, { width: 515 });
        doc.fillColor("#202124");
      }
      doc.text(`理由: ${f.reason}`, { width: 515 });
      doc.fillColor("#5f6368").text(`根拠: ${f.law_basis}`, { width: 515 });
      doc.fillColor("#188038").text(`改善案: ${f.suggestion}`, { width: 515 });
      doc.moveDown(0.6);
      n++;
    }
  }

  doc.end();
  return done;
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}
