// 景表法チェックツール サーバ
import "./lib/env.js"; // 最初に .env を読み込む（KEIHYO_MODEL等がimport時に確定するため最上部）
import express from "express";
import multer from "multer";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  makeWorkDir,
  ensurePdf,
  renderPages,
  extractWords,
} from "./lib/extract.js";
import { analyzeDocument, loadProfiles, MODEL } from "./lib/analyze.js";
import { buildReport } from "./lib/report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, "uploads");
await fs.mkdir(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "1mb" }));

// 解析結果の一時保管（メモリ）。一定時間で破棄。
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000; // 1時間
function putJob(id, data) {
  jobs.set(id, { ...data, createdAt: Date.now() });
}
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, apiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
});

// プロファイル一覧（業種・追加法令）をUIへ提供
app.get("/api/profiles", async (_req, res) => {
  try {
    res.json(await loadProfiles());
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ファイルチェック
app.post("/api/check", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ファイルがありません。" });
  // multer/busboy はファイル名を latin1 で解釈するため、UTF-8 に直す（日本語ファイル名の文字化け対策）
  const originalName = decodeFileName(req.file.originalname);
  const ext = path.extname(originalName).toLowerCase();
  if (![".pdf", ".pptx", ".ppt"].includes(ext)) {
    await safeUnlink(req.file.path);
    return res.status(400).json({ error: "PDF または PowerPoint(.pptx/.ppt) をアップロードしてください。" });
  }

  // プロファイル選択（業種・追加法令）をフォームから受け取る
  const industry = req.body.industry || "general";
  let laws = [];
  try {
    laws = req.body.laws ? JSON.parse(req.body.laws) : [];
  } catch {
    laws = [];
  }

  let workDir;
  try {
    workDir = await makeWorkDir();
    // 元ファイルを正しい拡張子で作業ディレクトリにコピー
    const inputPath = path.join(workDir, `input${ext}`);
    await fs.copyFile(req.file.path, inputPath);

    const pdfPath = await ensurePdf(inputPath, workDir);
    const [pages, wordsByPage] = await Promise.all([
      renderPages(pdfPath, workDir),
      extractWords(pdfPath, workDir),
    ]);

    if (!pages.length) {
      throw new Error("ページを読み取れませんでした。");
    }

    const { results, scope } = await analyzeDocument(pages, wordsByPage, null, {
      industry,
      laws,
    });

    const id = randomUUID();
    const meta = {
      fileName: originalName,
      model: MODEL,
      generatedAt: new Date().toLocaleString("ja-JP"),
      scopeText: scope.scopeText,
      lawLabels: scope.lawLabels,
    };
    putJob(id, { results, meta });

    // クライアントには表示用に画像と指摘を返す
    res.json({
      id,
      meta,
      pages: results.map((r) => ({
        page: r.page,
        widthPx: r.widthPx,
        heightPx: r.heightPx,
        imageBase64: r.imageBase64,
        page_summary: r.page_summary,
        error: r.error || null,
        findings: r.findings,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  } finally {
    await safeUnlink(req.file?.path);
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// PDFレポートのダウンロード
app.get("/api/report/:id", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "レポートが見つかりません（期限切れの可能性）。" });
  try {
    const buf = await buildReport(job.results, job.meta);
    const safeName = job.meta.fileName.replace(/\.[^.]+$/, "").replace(/[^\w\-一-龯ぁ-んァ-ヶ]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`景表法チェック_${safeName}.pdf`)}`
    );
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

async function safeUnlink(p) {
  if (!p) return;
  await fs.unlink(p).catch(() => {});
}

// multer/busboy が latin1 で解釈したファイル名を UTF-8 に復元する。
// 既に正しいUTF-8の場合に壊さないよう、latin1→utf8 変換で不正文字(�)が出る場合は元のまま返す。
function decodeFileName(name) {
  if (!name) return "file";
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    if (decoded.includes("�")) return name;
    return decoded;
  } catch {
    return name;
  }
}

app.listen(PORT, () => {
  console.log(`景表チェッカー listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[警告] ANTHROPIC_API_KEY が未設定です。/api/check は失敗します。");
  }
});
