import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs";

const { PDFDocument, degrees } = window.PDFLib;

const fileInput = document.getElementById("file-input");
const fileDrop = document.getElementById("file-drop");
const fileDropLabel = document.getElementById("file-drop-label");
const optionsPanel = document.getElementById("options-panel");
const pagesPanel = document.getElementById("pages-panel");
const pagesGrid = document.getElementById("pages-grid");
const downloadPanel = document.getElementById("download-panel");
const detectBtn = document.getElementById("detect-btn");
const resetBtn = document.getElementById("reset-btn");
const downloadBtn = document.getElementById("download-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");

let originalBytes = null;
let originalFileName = "document.pdf";
let pages = []; // { originalRotation, extraRotation, canvas }

function normalizeAngle(angle) {
  return ((angle % 360) + 360) % 360;
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function setProgress(current, total, label) {
  progressWrap.hidden = false;
  progressFill.style.width = `${(current / total) * 100}%`;
  progressLabel.textContent = label ?? `處理中… ${current}/${total}`;
}

function hideProgress() {
  progressWrap.hidden = true;
}

function updateThumbTransform(pageState) {
  const canvas = pageState.canvas;
  canvas.style.transform = `rotate(${pageState.extraRotation}deg)`;
  pageState.labelEl.textContent = `第 ${pageState.index + 1} 頁 · 額外旋轉 ${pageState.extraRotation}°`;
}

async function loadPdf(file) {
  originalFileName = file.name.replace(/\.pdf$/i, "");
  originalBytes = new Uint8Array(await file.arrayBuffer());

  const loadingTask = pdfjsLib.getDocument({ data: originalBytes.slice() });
  const pdf = await loadingTask.promise;

  pages = [];
  pagesGrid.innerHTML = "";

  const targetWidth = 320;

  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    const card = document.createElement("div");
    card.className = "page-card";

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "page-thumb-wrap";
    thumbWrap.appendChild(canvas);

    const label = document.createElement("div");
    label.className = "page-label";

    const controls = document.createElement("div");
    controls.className = "page-controls";
    const rotLeft = document.createElement("button");
    rotLeft.className = "btn small";
    rotLeft.textContent = "⟲ -90°";
    const rotRight = document.createElement("button");
    rotRight.className = "btn small";
    rotRight.textContent = "⟳ +90°";
    controls.append(rotLeft, rotRight);

    card.append(thumbWrap, label, controls);
    pagesGrid.appendChild(card);

    const pageState = {
      index: i,
      originalRotation: page.rotate,
      extraRotation: 0,
      canvas,
      labelEl: label,
      detectedAngle: null,
      confidence: null,
    };
    pages.push(pageState);

    rotLeft.addEventListener("click", () => {
      pageState.extraRotation = normalizeAngle(pageState.extraRotation - 90);
      updateThumbTransform(pageState);
    });
    rotRight.addEventListener("click", () => {
      pageState.extraRotation = normalizeAngle(pageState.extraRotation + 90);
      updateThumbTransform(pageState);
    });

    updateThumbTransform(pageState);
  }

  optionsPanel.hidden = false;
  pagesPanel.hidden = false;
  downloadPanel.hidden = false;
  fileDropLabel.textContent = `已載入：${file.name}（共 ${pdf.numPages} 頁）`;
}

async function detectOrientation() {
  if (pages.length === 0) return;
  detectBtn.disabled = true;

  const worker = await Tesseract.createWorker();

  try {
    for (let i = 0; i < pages.length; i++) {
      setProgress(i, pages.length, `偵測方向中… 第 ${i + 1}/${pages.length} 頁`);
      const pageState = pages[i];
      try {
        const { data } = await worker.detect(pageState.canvas);
        const angle = normalizeAngle(Math.round((data.orientation_degrees ?? 0) / 90) * 90);
        pageState.detectedAngle = angle;
        pageState.confidence = data.orientation_confidence ?? 0;
      } catch (err) {
        console.warn(`第 ${i + 1} 頁方向偵測失敗`, err);
        pageState.detectedAngle = 0;
        pageState.confidence = 0;
      }
    }
    setProgress(pages.length, pages.length, "偵測完成");
  } finally {
    await worker.terminate();
  }

  applyDetectionResults();
  hideProgress();
  detectBtn.disabled = false;
}

function applyDetectionResults() {
  const mode = currentMode();

  if (mode === "per-page") {
    for (const pageState of pages) {
      pageState.extraRotation = normalizeAngle(pageState.detectedAngle ?? 0);
      updateThumbTransform(pageState);
    }
    return;
  }

  // uniform: pick the most common detected angle across all pages
  const counts = { 0: 0, 90: 0, 180: 0, 270: 0 };
  for (const pageState of pages) {
    const angle = normalizeAngle(pageState.detectedAngle ?? 0);
    counts[angle] = (counts[angle] ?? 0) + 1;
  }
  let bestAngle = 0;
  let bestCount = -1;
  for (const [angle, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestCount = count;
      bestAngle = Number(angle);
    }
  }
  for (const pageState of pages) {
    pageState.extraRotation = bestAngle;
    updateThumbTransform(pageState);
  }
}

function applyUniformDelta(delta) {
  for (const pageState of pages) {
    pageState.extraRotation = normalizeAngle(pageState.extraRotation + delta);
    updateThumbTransform(pageState);
  }
}

function resetRotations() {
  for (const pageState of pages) {
    pageState.extraRotation = 0;
    pageState.detectedAngle = null;
    pageState.confidence = null;
    updateThumbTransform(pageState);
  }
}

async function downloadRotatedPdf() {
  if (!originalBytes) return;
  downloadBtn.disabled = true;
  downloadBtn.textContent = "產生中…";
  try {
    const pdfDoc = await PDFDocument.load(originalBytes);
    const pdfPages = pdfDoc.getPages();
    pages.forEach((pageState, i) => {
      const finalAngle = normalizeAngle(pageState.originalRotation + pageState.extraRotation);
      pdfPages[i].setRotation(degrees(finalAngle));
    });
    const bytes = await pdfDoc.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${originalFileName}-rotated.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = "下載轉正後的 PDF";
  }
}

fileDrop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) loadPdf(file);
});

["dragover", "dragenter"].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDrop.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDrop.classList.remove("drag-over");
  })
);
fileDrop.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file && file.type === "application/pdf") loadPdf(file);
});

detectBtn.addEventListener("click", detectOrientation);
resetBtn.addEventListener("click", resetRotations);
downloadBtn.addEventListener("click", downloadRotatedPdf);

document.querySelectorAll("[data-quick-rotate]").forEach((btn) => {
  btn.addEventListener("click", () => {
    applyUniformDelta(Number(btn.dataset.quickRotate));
  });
});

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (pages.some((p) => p.detectedAngle !== null)) {
      applyDetectionResults();
    }
  });
});
