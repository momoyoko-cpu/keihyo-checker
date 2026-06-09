// ファイル抽出モジュール
// - PPTX/PPT → LibreOffice で PDF に変換
// - PDF → poppler(pdftoppm) で各ページを PNG 画像化
// - PDF → poppler(pdftotext -bbox-layout) で単語ごとの座標・フォントサイズを抽出
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

// 画像レンダリングの解像度（DPI）。pdftotextの座標は72dpi基準なので倍率に使う。
export const RENDER_DPI = 150;
const PT_PER_INCH = 72;
export const PX_PER_PT = RENDER_DPI / PT_PER_INCH;

const SOFFICE = process.env.SOFFICE_PATH || "soffice";

/**
 * 一時作業ディレクトリを作る
 */
export async function makeWorkDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "keihyo-"));
}

/**
 * PPTX/PPT を PDF に変換して、生成されたPDFのパスを返す。
 * 入力が既にPDFならそのまま返す。
 */
export async function ensurePdf(inputPath, workDir) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".pdf") return inputPath;
  if (ext !== ".pptx" && ext !== ".ppt") {
    throw new Error(`未対応のファイル形式です: ${ext}`);
  }
  // LibreOffice headless で PDF 変換。
  // 非ASCIIな絶対パスを渡すと一部環境で失敗するため、cwd=workDir + 相対ファイル名で実行する。
  const inputName = path.basename(inputPath);
  await execFileAsync(
    SOFFICE,
    ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", ".", inputName],
    { timeout: 120000, cwd: workDir }
  );
  const base = path.basename(inputPath, path.extname(inputPath));
  const pdfPath = path.join(workDir, `${base}.pdf`);
  await fs.access(pdfPath); // 変換失敗なら例外
  return pdfPath;
}

/**
 * PDF の各ページを PNG 画像にして、{ page, imagePath, imageBase64, widthPx, heightPx } の配列を返す
 */
export async function renderPages(pdfPath, workDir) {
  // cwd=workDir + 相対ファイル名（非ASCIIパス対策）
  await execFileAsync(
    "pdftoppm",
    ["-png", "-r", String(RENDER_DPI), path.basename(pdfPath), "page"],
    { timeout: 180000, cwd: workDir }
  );
  const files = (await fs.readdir(workDir))
    .filter((f) => f.startsWith("page") && f.endsWith(".png"))
    .sort(naturalSort);
  const pages = [];
  for (let i = 0; i < files.length; i++) {
    const imagePath = path.join(workDir, files[i]);
    const buf = await fs.readFile(imagePath);
    const { width, height } = pngSize(buf);
    pages.push({
      page: i + 1,
      imagePath,
      imageBase64: buf.toString("base64"),
      widthPx: width,
      heightPx: height,
    });
  }
  return pages;
}

/**
 * PDF から単語ごとの座標(pt)・推定フォントサイズ(pt)・テキストを抽出。
 * pdftotext -bbox-layout が出力する簡易HTML(XHTML)をパースする。
 * 返り値: { [pageNumber]: { words: [{text,x,y,w,h,sizePt}], pageWidthPt, pageHeightPt, plainText } }
 */
export async function extractWords(pdfPath, workDir) {
  // cwd=workDir + 相対ファイル名（非ASCIIパス対策）
  await execFileAsync(
    "pdftotext",
    ["-bbox-layout", path.basename(pdfPath), "bbox.html"],
    { timeout: 120000, cwd: workDir }
  );
  const xml = await fs.readFile(path.join(workDir, "bbox.html"), "utf8");
  return parseBboxHtml(xml);
}

// --- bbox-layout HTML パーサ ---
function parseBboxHtml(xml) {
  const pages = {};
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  let pm;
  let pageNo = 0;
  while ((pm = pageRe.exec(xml)) !== null) {
    pageNo += 1;
    const pageWidthPt = parseFloat(pm[1]);
    const pageHeightPt = parseFloat(pm[2]);
    const body = pm[3];
    const words = [];
    const lineParts = [];

    // 行単位（フォントサイズの基準にもなる）
    const lineRe = /<line[^>]*>([\s\S]*?)<\/line>/g;
    let lm;
    while ((lm = lineRe.exec(body)) !== null) {
      const lineBody = lm[1];
      const wordRe =
        /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
      let wm;
      const lineWords = [];
      while ((wm = wordRe.exec(lineBody)) !== null) {
        const xMin = parseFloat(wm[1]);
        const yMin = parseFloat(wm[2]);
        const xMax = parseFloat(wm[3]);
        const yMax = parseFloat(wm[4]);
        const text = decodeEntities(wm[5]).trim();
        if (!text) continue;
        const w = {
          text,
          x: xMin,
          y: yMin,
          w: xMax - xMin,
          h: yMax - yMin,
          // 推定フォントサイズ(pt) ≒ 行高さ。1文字単語などのばらつきを抑えるため行高さを優先採用。
          sizePt: round1(yMax - yMin),
        };
        lineWords.push(w);
        words.push(w);
      }
      if (lineWords.length) {
        const lineH = Math.max(...lineWords.map((w) => w.h));
        // 行内の各単語のサイズを行高さでならす（より安定したフォントサイズ推定）
        for (const w of lineWords) w.sizePt = round1(lineH);
        lineParts.push(lineWords.map((w) => w.text).join(" "));
      }
    }
    pages[pageNo] = {
      pageWidthPt,
      pageHeightPt,
      words,
      plainText: lineParts.join("\n"),
    };
  }
  return pages;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function naturalSort(a, b) {
  const na = parseInt(a.replace(/\D/g, ""), 10);
  const nb = parseInt(b.replace(/\D/g, ""), 10);
  return na - nb;
}

// PNGのIHDRから幅・高さを読む（軽量、依存ライブラリ不要）
function pngSize(buf) {
  // PNGシグネチャ(8) + IHDRチャンク長(4)+型(4) の後に width(4),height(4)
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

/**
 * Claudeが返した「該当表現の引用」を、抽出済み単語列から探して
 * 統合バウンディングボックス(px)と推定フォントサイズ(pt)を返す。
 * 見つからなければ null。
 */
export function locateQuote(pageData, quote) {
  if (!pageData || !quote) return null;
  const normalize = (s) => s.replace(/\s+/g, "").replace(/[，、。．・]/g, "");
  const target = normalize(quote);
  if (!target) return null;

  const words = pageData.words;
  // 連続する単語を結合して target を含む最小範囲を探す
  for (let i = 0; i < words.length; i++) {
    let concat = "";
    for (let j = i; j < words.length && j < i + 60; j++) {
      concat += normalize(words[j].text);
      if (concat.includes(target)) {
        const span = words.slice(i, j + 1);
        return boxOf(span);
      }
      // targetがconcatの接頭辞でなくなったら打ち切り
      if (!target.startsWith(concat.slice(0, target.length)) && !target.includes(normalize(words[i].text))) {
        break;
      }
    }
  }
  // 単語単位の部分一致フォールバック（引用が長文の場合）
  const hit = words.filter((w) => target.includes(normalize(w.text)) && normalize(w.text).length >= 2);
  if (hit.length) return boxOf(hit);
  return null;
}

function boxOf(span) {
  const x = Math.min(...span.map((w) => w.x));
  const y = Math.min(...span.map((w) => w.y));
  const xMax = Math.max(...span.map((w) => w.x + w.w));
  const yMax = Math.max(...span.map((w) => w.y + w.h));
  const sizePt = Math.min(...span.map((w) => w.sizePt));
  return {
    // pt（PDF座標, 原点左上）
    xPt: round1(x),
    yPt: round1(y),
    wPt: round1(xMax - x),
    hPt: round1(yMax - y),
    // px（レンダリング画像座標）
    xPx: Math.round(x * PX_PER_PT),
    yPx: Math.round(y * PX_PER_PT),
    wPx: Math.round((xMax - x) * PX_PER_PT),
    hPx: Math.round((yMax - y) * PX_PER_PT),
    sizePt: round1(sizePt),
  };
}
