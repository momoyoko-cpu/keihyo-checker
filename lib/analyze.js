// Claude API による景表法判定モジュール
// 各ページの「レンダリング画像 + 抽出テキスト(フォントサイズ付き)」を Claude に渡し、
// 構造化された指摘（該当表現・類型・重要度・根拠・改善案）を得る。
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locateQuote } from "./extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL = process.env.KEIHYO_MODEL || "claude-sonnet-4-6";
const MAX_CONCURRENCY = Number(process.env.KEIHYO_CONCURRENCY || 3);

const KNOWLEDGE_DIR = path.join(__dirname, "..", "knowledge");

// プロファイル定義をロード（業種・追加法令）
let profilesCache = null;
export async function loadProfiles() {
  if (profilesCache) return profilesCache;
  const raw = await fs.readFile(path.join(KNOWLEDGE_DIR, "profiles.json"), "utf8");
  profilesCache = JSON.parse(raw);
  return profilesCache;
}

// 個別モジュール（md）の読み込みキャッシュ
const moduleCache = new Map();
async function loadModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const txt = await fs.readFile(path.join(KNOWLEDGE_DIR, relPath), "utf8");
  moduleCache.set(relPath, txt);
  return txt;
}

/**
 * 選択された業種・法令から、システムプロンプト用の知識・lawラベル・scope説明を組み立てる。
 * options: { industry: string|null, laws: string[] }
 */
async function assembleScope(options = {}) {
  const profiles = await loadProfiles();
  const parts = [];
  // 1) 景表法ベース（常に）
  parts.push("## 景表法（基本・常に適用）\n" + (await loadModule("base.md")));

  const lawLabels = ["景表法"];
  const scopeLabels = [];

  // 2) 業種モジュール
  const industry = (options.industry || "general").trim();
  const ind = profiles.industries.find((i) => i.id === industry);
  if (ind) {
    scopeLabels.push(`業種: ${ind.label}`);
    if (ind.module) {
      parts.push(`\n\n## 業種特化観点（${ind.label}）\n` + (await loadModule(ind.module)));
    }
  }

  // 3) 追加法令モジュール
  const lawIds = Array.isArray(options.laws) ? options.laws : [];
  for (const lawId of lawIds) {
    const law = profiles.laws.find((l) => l.id === lawId);
    if (law) {
      lawLabels.push(law.label);
      scopeLabels.push(`併用法令: ${law.label}`);
      parts.push(`\n\n## 併用法令（${law.label}）\n` + (await loadModule(law.module)));
    }
  }

  return {
    knowledge: parts.join("\n"),
    lawLabels,
    scopeText: scopeLabels.length ? scopeLabels.join(" / ") : "業種指定なし・景表法のみ",
  };
}

// 構造化出力用のツール定義（lawの選択肢を動的に組み立て）
function buildFindingTool(lawLabels) {
  return {
    name: "report_findings",
    description:
      "1ページ分の広告表示チェック結果を報告する。指摘がなければ findings は空配列にする。",
    input_schema: {
      type: "object",
      properties: {
        page_summary: {
          type: "string",
          description: "このページに何が書かれているかの簡潔な要約（1〜2文）",
        },
        findings: {
          type: "array",
          description: "法令上問題となるおそれのある表現の指摘リスト",
          items: {
            type: "object",
            properties: {
              quote: {
                type: "string",
                description:
                  "該当する表現を、ページ内のテキストから**正確に原文どおり**引用する（ハイライト位置特定に使う）。",
              },
              law: {
                type: "string",
                enum: lawLabels,
                description: "主に抵触するおそれのある法令",
              },
              category: {
                type: "string",
                description:
                  "違反のおそれの類型（例: 優良誤認 / 有利誤認 / 指定告示 / 打消し表示 / 定期購入表示 / 表示義務違反 / おとり広告 / その他）",
              },
              severity: {
                type: "string",
                enum: ["高", "中", "低"],
                description: "重要度（高=措置命令・課徴金等のリスク, 中=文脈次第, 低=要改善）",
              },
              reason: {
                type: "string",
                description: "なぜ法令上問題となるおそれがあるかの説明",
              },
              law_basis: {
                type: "string",
                description:
                  "根拠となる条文・告示・規約・ガイドライン（例: 景表法第5条第1号 優良誤認 / 特商法第12条の6 / 不動産の表示に関する公正競争規約）",
              },
              suggestion: {
                type: "string",
                description: "具体的な改善案（修正後の表現例を含める）",
              },
            },
            required: ["quote", "law", "category", "severity", "reason", "law_basis", "suggestion"],
          },
        },
      },
      required: ["page_summary", "findings"],
    },
  };
}

function buildSystemPrompt(knowledge, scopeText, lawLabels) {
  return `あなたは日本の景品表示法（景表法）${
    lawLabels.length > 1 ? "および" + lawLabels.slice(1).join("・") : ""
  }に精通した広告審査の専門家です。
アップロードされた広告・販促資料（PDF/パワーポイント由来）の各ページを審査し、不当表示・誇大表示の問題を検出します。

# 今回の審査スコープ
${scopeText}
（対象法令: ${lawLabels.join("、")}）

# 判定基準（必ずこれに従う）
${knowledge}

# 審査の指示
- ページ画像（レイアウト・文字の大きさ・色・配置が分かる）と、抽出テキスト（実フォントサイズpt付き）の両方を見て判断する。
- 「打消し表示」は、強調表示に対して文字が著しく小さい/視認性が低い場合に指摘する。フォントサイズ(pt)の相対比を根拠に含める。
- quote は必ずページ内の文言を**原文どおり正確に**抜き出す（ハイライト表示の位置特定に使うため）。画像からしか読めない文言もできるだけ正確に書き起こす。
- 各指摘には、主に抵触するおそれのある法令を law に設定する（対象法令の中から選ぶ）。
- 業種特化観点・併用法令の観点も漏れなく審査する。
- 断定を避け「〜のおそれ」と表現する。過剰検出は避け、合理的に問題となり得るものに絞る。
- 問題が無いページは findings を空配列にする。
- 必ず report_findings ツールを呼び出して結果を返す。`;
}

/**
 * 1ページを解析
 */
async function analyzePage(client, system, tool, page, wordData) {
  // フォントサイズの分布情報をテキストで添える
  let sizeHint = "";
  if (wordData && wordData.words.length) {
    const sizes = wordData.words.map((w) => w.sizePt).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    const min = sizes[0];
    const max = sizes[sizes.length - 1];
    sizeHint = `\n\n[このページのフォントサイズ参考] 最小=${min}pt / 中央値=${median}pt / 最大=${max}pt`;
  }
  const textBlock = wordData?.plainText?.trim()
    ? wordData.plainText
    : "(テキスト抽出なし。画像から読み取ってください)";

  const userContent = [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: page.imageBase64,
      },
    },
    {
      type: "text",
      text: `これは資料の ${page.page} ページ目です。画像と下記の抽出テキストを審査してください。${sizeHint}\n\n=== 抽出テキスト ===\n${textBlock}`,
    },
  ];

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: "report_findings" },
    messages: [{ role: "user", content: userContent }],
  });

  const toolUse = resp.content.find((c) => c.type === "tool_use");
  const result = toolUse?.input || { page_summary: "", findings: [] };

  // 各指摘に座標・フォントサイズを付与
  const findings = (result.findings || []).map((f) => {
    const box = locateQuote(wordData, f.quote);
    return { ...f, box };
  });

  return {
    page: page.page,
    widthPx: page.widthPx,
    heightPx: page.heightPx,
    imageBase64: page.imageBase64,
    page_summary: result.page_summary || "",
    findings,
  };
}

/**
 * 全ページを解析（同時実行数を制限）
 * pages: renderPages の返り値
 * wordsByPage: extractWords の返り値
 * onProgress: (done, total) => void
 * options: { industry: string|null, laws: string[] }
 * 返り値: { results, scope: { scopeText, lawLabels } }
 */
export async function analyzeDocument(pages, wordsByPage, onProgress, options = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY が設定されていません。");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { knowledge, lawLabels, scopeText } = await assembleScope(options);
  const system = buildSystemPrompt(knowledge, scopeText, lawLabels);
  const tool = buildFindingTool(lawLabels);

  const results = new Array(pages.length);
  let done = 0;
  let next = 0;

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= pages.length) break;
      const page = pages[idx];
      try {
        results[idx] = await analyzePage(client, system, tool, page, wordsByPage[page.page]);
      } catch (err) {
        results[idx] = {
          page: page.page,
          widthPx: page.widthPx,
          heightPx: page.heightPx,
          imageBase64: page.imageBase64,
          page_summary: "",
          findings: [],
          error: String(err?.message || err),
        };
      }
      done++;
      onProgress?.(done, pages.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENCY, pages.length) },
    () => worker()
  );
  await Promise.all(workers);
  return { results, scope: { scopeText, lawLabels } };
}

export { MODEL };
