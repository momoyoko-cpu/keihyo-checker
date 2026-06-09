// 景表法チェックツール フロントエンド
const $ = (id) => document.getElementById(id);

const sections = {
  upload: $("upload-section"),
  loading: $("loading-section"),
  error: $("error-section"),
  result: $("result-section"),
};
function show(name) {
  for (const [k, el] of Object.entries(sections)) el.classList.toggle("hidden", k !== name);
}

let currentJobId = null;

// ---- プロファイル（業種・追加法令）読み込み ----
let profiles = { industries: [], laws: [] };
async function loadProfiles() {
  try {
    const resp = await fetch("/api/profiles");
    profiles = await resp.json();
  } catch {
    profiles = { industries: [], laws: [] };
  }
  // 業種セレクト
  const sel = $("industry-select");
  sel.innerHTML = "";
  profiles.industries.forEach((ind) => {
    const opt = document.createElement("option");
    opt.value = ind.id;
    opt.textContent = ind.label;
    opt.dataset.desc = ind.description || "";
    sel.appendChild(opt);
  });
  const updateDesc = () => {
    const o = sel.selectedOptions[0];
    $("industry-desc").textContent = o ? o.dataset.desc : "";
  };
  sel.addEventListener("change", updateDesc);
  updateDesc();

  // 追加法令チェックボックス
  const box = $("laws-checkboxes");
  box.innerHTML = "";
  if (!profiles.laws.length) {
    box.innerHTML = '<span class="config-desc">（追加法令なし）</span>';
  }
  profiles.laws.forEach((law) => {
    const id = `law-${law.id}`;
    const wrap = document.createElement("label");
    wrap.className = "law-check";
    wrap.innerHTML = `<input type="checkbox" id="${id}" value="${law.id}" /> <span>${law.label}</span>`;
    wrap.title = law.description || "";
    box.appendChild(wrap);
  });
}
function getSelection() {
  const industry = $("industry-select").value || "general";
  const laws = [...document.querySelectorAll("#laws-checkboxes input:checked")].map((c) => c.value);
  return { industry, laws };
}
loadProfiles();

// ---- ドラッグ&ドロップ ----
const dropzone = $("dropzone");
const fileInput = $("file-input");
$("browse-btn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) uploadFile(fileInput.files[0]);
});
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

$("retry-btn").addEventListener("click", () => show("upload"));
$("new-btn").addEventListener("click", () => {
  fileInput.value = "";
  show("upload");
});
$("download-btn").addEventListener("click", () => {
  if (currentJobId) window.location.href = `/api/report/${currentJobId}`;
});

// ---- アップロード&解析 ----
async function uploadFile(file) {
  const okExt = /\.(pdf|pptx|ppt)$/i.test(file.name);
  if (!okExt) {
    return showError("PDF または PowerPoint(.pptx/.ppt) を選択してください。");
  }
  show("loading");
  const fd = new FormData();
  fd.append("file", file);
  const { industry, laws } = getSelection();
  fd.append("industry", industry);
  fd.append("laws", JSON.stringify(laws));
  try {
    const resp = await fetch("/api/check", { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "解析に失敗しました。");
    renderResult(data);
  } catch (err) {
    showError(err.message || String(err));
  }
}

function showError(msg) {
  $("error-text").textContent = msg;
  show("error");
}

// ---- 結果描画 ----
function renderResult(data) {
  currentJobId = data.id;
  $("result-filename").textContent = data.meta.fileName;
  $("result-scope").textContent = data.meta.scopeText ? `審査スコープ: ${data.meta.scopeText}` : "";

  const all = data.pages.flatMap((p) => p.findings.map((f) => ({ ...f, page: p.page })));
  const counts = { 高: 0, 中: 0, 低: 0 };
  all.forEach((f) => (counts[f.severity] = (counts[f.severity] || 0) + 1));

  const badges = $("result-summary");
  if (all.length === 0) {
    badges.innerHTML = `<span class="badge none">指摘なし</span>`;
  } else {
    badges.innerHTML =
      `<span class="badge high">高 ${counts["高"] || 0}</span>` +
      `<span class="badge mid">中 ${counts["中"] || 0}</span>` +
      `<span class="badge low">低 ${counts["低"] || 0}</span>`;
  }

  renderPages(data.pages);
  renderFindings(data.pages);
  show("result");
}

function renderPages(pages) {
  const pane = $("pages-pane");
  pane.innerHTML = "";
  for (const p of pages) {
    const card = document.createElement("div");
    card.className = "page-card";

    const head = document.createElement("div");
    head.className = "page-head";
    head.innerHTML = `<span>ページ ${p.page}</span><span>${p.findings.length} 件の指摘</span>`;
    card.appendChild(head);

    const wrap = document.createElement("div");
    wrap.className = "page-img-wrap";
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${p.imageBase64}`;
    wrap.appendChild(img);

    // ハイライト枠（画像ピクセル → %で配置）
    p.findings.forEach((f, i) => {
      if (!f.box) return;
      const box = document.createElement("div");
      box.className = `hl-box sev-${f.severity}`;
      box.style.left = (f.box.xPx / p.widthPx) * 100 + "%";
      box.style.top = (f.box.yPx / p.heightPx) * 100 + "%";
      box.style.width = (f.box.wPx / p.widthPx) * 100 + "%";
      box.style.height = (f.box.hPx / p.heightPx) * 100 + "%";
      box.dataset.fid = `${p.page}-${i}`;
      box.innerHTML = `<span class="hl-num">${i + 1}</span>`;
      box.addEventListener("click", () => focusFinding(`${p.page}-${i}`));
      wrap.appendChild(box);
    });

    card.appendChild(wrap);
    pane.appendChild(card);
  }
}

function renderFindings(pages) {
  const pane = $("findings-pane");
  pane.innerHTML = "<h2>指摘一覧</h2>";

  const total = pages.reduce((s, p) => s + p.findings.length, 0);
  if (total === 0) {
    const ok = document.createElement("p");
    ok.className = "no-findings";
    ok.textContent = "✓ 景表法上の明らかな問題は検出されませんでした。（最終判断は専門家確認を推奨）";
    pane.appendChild(ok);
    return;
  }

  for (const p of pages) {
    if (p.error) {
      const e = document.createElement("p");
      e.style.color = "var(--high)";
      e.style.fontSize = "12px";
      e.textContent = `ページ${p.page}: 解析エラー (${p.error})`;
      pane.appendChild(e);
    }
    p.findings.forEach((f, i) => {
      const fid = `${p.page}-${i}`;
      const card = document.createElement("div");
      card.className = `finding-card sev-${f.severity}`;
      card.id = `fc-${fid}`;
      const sizeLine = f.box ? `<div class="fc-size">表示サイズ: 約${f.box.sizePt}pt</div>` : "";
      const lawTag = f.law ? `<span class="fc-law">${escapeHtml(f.law)}</span>` : "";
      card.innerHTML = `
        <div class="fc-head">
          <span class="sev-pill ${f.severity}">${f.severity}</span>
          ${lawTag}
          <span class="fc-cat">${escapeHtml(f.category)}</span>
          <span class="fc-page">P${p.page} / #${i + 1}</span>
        </div>
        <div class="fc-quote">「${escapeHtml(f.quote)}」</div>
        ${sizeLine}
        <div class="fc-row"><span class="label">理由:</span> ${escapeHtml(f.reason)}</div>
        <div class="fc-row"><span class="label">根拠:</span> ${escapeHtml(f.law_basis)}</div>
        <div class="fc-suggest">改善案: ${escapeHtml(f.suggestion)}</div>
      `;
      card.addEventListener("click", () => focusFinding(fid));
      pane.appendChild(card);
    });

    if (p.page_summary) {
      const s = document.createElement("div");
      s.className = "fc-page-summary";
      s.textContent = `P${p.page}: ${p.page_summary}`;
      pane.appendChild(s);
    }
  }
}

function focusFinding(fid) {
  document.querySelectorAll(".hl-box.active, .finding-card.active").forEach((el) =>
    el.classList.remove("active")
  );
  const box = document.querySelector(`.hl-box[data-fid="${fid}"]`);
  const card = $(`fc-${fid}`);
  if (box) {
    box.classList.add("active");
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  if (card) {
    card.classList.add("active");
    if (!box) card.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
