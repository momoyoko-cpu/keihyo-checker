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
                description:
                  "対応の必要度。高=必須（法令違反のおそれが高く修正が必須。措置命令・課徴金等のリスク）／中=推奨（強）（誤認のおそれがあり修正を強く推奨）／低=推奨（弱）（直ちに違反とは言い難いが改善が望ましい）",
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

# 審査方針（重要）
あなたの役割は、広告審査担当者が見落としを防ぐための**網羅的な一次スクリーニング**です。
「明確な違反」だけでなく、**問題となる『おそれ』があるものは漏れなく列挙**してください。
確度が高くないものは severity を「低」にして拾い上げる方針です（見逃しの方が重大なリスク）。
広告的な訴求が1つでもあるページで findings が空になることは通常ありません。

# 必ず確認するチェックリスト（各ページで順に検討）
1. **強調表示 vs 打消し表示**: ページ内で最も大きい/目立つ訴求に対し、例外・条件・限定・注意（「※」「注」「条件」「個人差」「対象外」「別途」「初回のみ」等の注釈）が、小さい文字・隅・薄い色で示されていないか。フォントサイズ比（注釈pt÷最大pt）が小さいほど打消し表示として問題。**該当すれば必ず指摘**。
2. **効果・性能・品質の断定/誇張**: 「必ず」「確実」「必須」「No.1」「最高」「日本一」「世界初」「完全」など、客観的根拠・出典が示されないと優良誤認のおそれ。
3. **価格・取引条件の有利誤認**: 「無料」「0円」「実質」「期間限定」「今だけ」「割引」「通常価格」等。条件・総額・対象範囲が不明瞭でないか。二重価格の根拠。
4. **補助金・制度・キャンペーン**: 「補助金がもらえる」「対象」等の表示で、受給条件・上限・対象外要件・申請主体が小さくしか書かれていないと有利誤認/打消し表示のおそれ。
5. **限定・数量・期限**: 「先着」「限定」「期間」が実態と乖離していないか（資料からは断定できなくても、注記の有無に注目）。
6. **体験談・推奨・比較**: 個人の感想・他社比較の根拠、出典の明示。
7. 業種特化観点・併用法令（対象法令）の固有チェック項目も必ず適用する。

# 出力の指示
- ページ画像（レイアウト・文字サイズ・色・配置）と抽出テキスト（実フォントサイズpt付き）の両方を根拠に判断する。フォントサイズが読み取れる場合は理由に「注釈◯pt / 最大◯pt（約◯分の1）」のように数値を入れる。
- quote は必ずページ内の文言を**原文どおり正確に**抜き出す（ハイライト位置特定に使う）。画像からしか読めない極小の注釈も、可能な限り正確に書き起こして指摘対象にする。
- 各指摘の law は対象法令の中から、主に抵触するおそれのあるものを選ぶ。
- 表現は「〜のおそれ」「〜の可能性」とし、断定を避ける。重複しすぎないよう、同一の論点は1件にまとめてよい。
- 純粋な会社情報・目次・問い合わせ先のみで広告的訴求が全く無いページに限り findings を空配列にしてよい。
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
    max_tokens: 8192,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: "report_findings" },
    messages: [{ role: "user", content: userContent }],
  });

  const toolUse = resp.content.find((c) => c.type === "tool_use");
  const result = toolUse?.input || { page_summary: "", findings: [] };

  // 重複指摘の除去（同一ページで law+category+引用が同じものは1件に）
  const seen = new Set();
  const findings = (result.findings || [])
    .filter((f) => {
      const key = `${f.law}|${f.category}|${(f.quote || "").replace(/\s+/g, "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((f) => {
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
