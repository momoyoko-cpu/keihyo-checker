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
import { textToPdf } from "./lib/textPdf.js";

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

// ファイルチェック（非同期開始）。即座にジョブIDを返し、バックグラウンドで解析する。
// 進捗は GET /api/status/:id でポーリングする（長時間処理でHTTPタイムアウトしないため）。
// 受付可能なアップロード拡張子
const ACCEPTED_EXTS = [".pdf", ".pptx", ".ppt", ".docx", ".doc", ".rtf", ".odt", ".odp", ".txt"];

app.post("/api/check", upload.single("file"), async (req, res) => {
  // プロファイル選択（業種・追加法令）をフォームから受け取る
  const industry = req.body.industry || "general";
  let laws = [];
  try {
    laws = req.body.laws ? JSON.parse(req.body.laws) : [];
  } catch {
    laws = [];
  }

  const pastedText = (req.body.text || "").trim();

  let source; // { kind:'file', uploadPath, ext, originalName } | { kind:'text', text, originalName }
  if (req.file) {
    // multer/busboy はファイル名を latin1 で解釈するため、UTF-8 に直す（日本語ファイル名の文字化け対策）
    const originalName = decodeFileName(req.file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    if (!ACCEPTED_EXTS.includes(ext)) {
      await safeUnlink(req.file.path);
      return res.status(400).json({
        error: "対応形式: PDF / PowerPoint(.pptx,.ppt) / Word(.docx,.doc,.rtf) / テキスト(.txt)",
      });
    }
    source = { kind: "file", uploadPath: req.file.path, ext, originalName };
  } else if (pastedText) {
    const title = (req.body.title || "").trim();
    source = { kind: "text", text: pastedText, originalName: (title || "テキスト入力") + ".txt" };
  } else {
    return res.status(400).json({ error: "ファイルをアップロードするか、テキストを入力してください。" });
  }

  const id = randomUUID();
  jobs.set(id, {
    status: "processing",
    progress: { phase: "準備中", done: 0, total: 0 },
    meta: { fileName: source.originalName, model: MODEL },
    results: null,
    error: null,
    createdAt: Date.now(),
  });

  // 先にIDを返す（クライアントはポーリングへ）
  res.status(202).json({ id });

  // バックグラウンド処理（awaitしない）
  processJob(id, { source, industry, laws }).catch((err) => {
    const job = jobs.get(id);
    if (job) {
      job.status = "error";
      job.error = String(err?.message || err);
    }
    console.error(`[job ${id}] failed:`, err);
  });
});

async function processJob(id, { source, industry, laws }) {
  const job = jobs.get(id);
  let workDir;
  try {
    workDir = await makeWorkDir();

    job.progress.phase = "ページの画像化・テキスト抽出中";

    // 入力を PDF にする。
    // テキスト系は LibreOffice の自動ページ割り（空白ページ・不要なページ分割）を避けるため、
    // pdfkit で「内容の高さに合わせた1ページ」を直接生成する。
    let pdfPath;
    if (source.kind === "text") {
      pdfPath = await textToPdf(source.text, workDir);
    } else if (source.ext === ".txt") {
      // .txt は文字コードの取り違えを防ぐため UTF-8 として読む
      const raw = await fs.readFile(source.uploadPath, "utf8");
      pdfPath = await textToPdf(raw, workDir);
    } else {
      const conversionPath = path.join(workDir, `input${source.ext}`);
      await fs.copyFile(source.uploadPath, conversionPath);
      pdfPath = await ensurePdf(conversionPath, workDir);
    }
    const [pages, wordsByPage] = await Promise.all([
      renderPages(pdfPath, workDir),
      extractWords(pdfPath, workDir),
    ]);
    if (!pages.length) throw new Error("ページを読み取れませんでした。");

    job.progress = { phase: "AI判定中", done: 0, total: pages.length };
    const { results, scope } = await analyzeDocument(
      pages,
      wordsByPage,
      (done, total) => {
        job.progress = { phase: "AI判定中", done, total };
      },
      { industry, laws }
    );

    job.meta = {
      fileName: source.originalName,
      model: MODEL,
      generatedAt: new Date().toLocaleString("ja-JP"),
      scopeText: scope.scopeText,
      lawLabels: scope.lawLabels,
    };
    job.results = results;
    job.status = "done";
  } finally {
    if (source.kind === "file") await safeUnlink(source.uploadPath);
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 解析の進捗・結果を取得
app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "ジョブが見つかりません（期限切れの可能性）。" });
  if (job.status === "processing") {
    return res.json({ status: "processing", progress: job.progress });
  }
  if (job.status === "error") {
    return res.json({ status: "error", error: job.error });
  }
  // done
  res.json({
    status: "done",
    id: req.params.id,
    meta: job.meta,
    pages: job.results.map((r) => ({
      page: r.page,
      widthPx: r.widthPx,
      heightPx: r.heightPx,
      imageBase64: r.imageBase64,
      page_summary: r.page_summary,
      error: r.error || null,
      findings: r.findings,
    })),
  });
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
