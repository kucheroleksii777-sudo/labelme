(() => {
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const stage = document.getElementById("stage");
  const fileList = document.getElementById("file-list");
  const shapeList = document.getElementById("shape-list");
  const labelList = document.getElementById("label-list");
  const fileFilter = document.getElementById("file-filter");
  const fileCount = document.getElementById("file-count");
  const workdirEl = document.getElementById("workdir");
  const emptyEl = document.getElementById("empty");
  const emptyPath = document.getElementById("empty-path");
  const hintEl = document.getElementById("hint");
  const statusEl = document.getElementById("status");
  const toastEl = document.getElementById("toast");
  const modal = document.getElementById("modal");
  const labelForm = document.getElementById("label-form");
  const labelInput = document.getElementById("label-input");
  const groupInput = document.getElementById("group-input");
  const descInput = document.getElementById("desc-input");
  const labelOptions = document.getElementById("label-options");
  const labelChips = document.getElementById("label-chips");
  const askLabel = document.getElementById("ask-label");
  const showLabels = document.getElementById("show-labels");
  if (localStorage.getItem("labelling-show-labels") === "0") showLabels.checked = false;
  const newLabel = document.getElementById("new-label");

  const HINTS = {
    polygon: "Click to add points. Click the first point or press Enter to close. Esc cancels.",
    rectangle: "Drag a rectangle.",
    circle: "Drag from the center to the edge.",
    line: "Drag a straight line.",
    linestrip: "Click to add points. Enter finishes the open line. Esc cancels.",
    point: "Click to place a point.",
    edit: "Drag a shape or a vertex. Double-click a polygon edge to insert a point. Arrows nudge.",
    pan: "Drag to pan. Wheel zooms.",
  };

  const state = {
    workdir: "",
    dataset: localStorage.getItem("labelling-dataset") || "",
    folder: localStorage.getItem("labelling-folder:" + (localStorage.getItem("labelling-dataset") || "")) || "",
    datasets: [],
    images: [],
    fileRows: [],
    labels: [],
    colors: {},
    index: -1,
    shapes: [],
    selected: -1,
    hidden: new Set(),
    armed: "",
    tool: "rectangle",
    draft: null,
    pending: null,
    drag: null,
    hover: null,
    image: null,
    view: { x: 0, y: 0, scale: 1 },
    dirty: false,
    undo: [],
    redo: [],
    token: 0,
    navigating: false,
    modal: null,
    space: false,
  };

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function toast(text) {
    toastEl.textContent = text;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      toastEl.textContent = "";
    }, 2600);
  }

  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function current() {
    return state.images[state.index] || null;
  }

  // LabelMe auto mode: imgviz label_colormap entry 1 + class index.
  function labelmeColor(index) {
    let value = (1 + index) & 255;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let j = 0; j < 8; j += 1) {
      const shift = 7 - j;
      r |= (value & 1) << shift;
      g |= ((value >> 1) & 1) << shift;
      b |= ((value >> 2) & 1) << shift;
      value >>= 3;
    }
    const hex = (channel) => channel.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  function defaultColor(label) {
    const names = palette();
    const index = names.indexOf(label);
    return labelmeColor(index < 0 ? names.length : index);
  }

  function labelColor(label) {
    const chosen = state.colors[label];
    if (typeof chosen === "string" && /^#[0-9a-fA-F]{6}$/.test(chosen)) return chosen;
    return defaultColor(label);
  }

  function currentLabelColor() {
    return state.armed ? labelColor(state.armed) : "#00ff00";
  }

  const PRESET_COLORS = [
    "#ff5a5a", "#ff9f43", "#ffe14a", "#3ddc78", "#2ee6c7",
    "#3db7ff", "#6d7dff", "#c084fc", "#ff6ad5", "#f4f7fb",
  ];
  let colorLabel = "";
  let colorHue = 0;
  let colorSat = 1;
  let colorVal = 1;
  let colorDrag = false;

  function hexToHsv(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    return { h: hue, s: max === 0 ? 0 : delta / max, v: max };
  }

  function hsvToHex(hue, sat, val) {
    const h = ((hue % 360) + 360) % 360;
    const c = val * sat;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = val - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    const byte = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
    return `#${byte(r)}${byte(g)}${byte(b)}`;
  }

  function paintColorUi(writeHex) {
    const hex = hsvToHex(colorHue, colorSat, colorVal);
    const pad = document.getElementById("sv");
    pad.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${colorHue} 100% 50%))`;
    const cursor = document.getElementById("sv-cursor");
    cursor.style.left = `${colorSat * 100}%`;
    cursor.style.top = `${(1 - colorVal) * 100}%`;
    document.getElementById("hue").value = String(Math.round(colorHue));
    document.getElementById("color-preview").style.background = hex;
    if (writeHex !== false) document.getElementById("color-hex").value = hex.toUpperCase();
    for (const button of document.querySelectorAll("#color-presets button")) {
      button.classList.toggle("picked", button.dataset.preset === hex);
    }
  }

  function openColor(label) {
    colorLabel = label;
    const hsv = hexToHsv(labelColor(label));
    colorHue = hsv.h;
    colorSat = hsv.s;
    colorVal = hsv.v;
    document.getElementById("color-title").textContent = label;
    const presets = document.getElementById("color-presets");
    if (!presets.childElementCount) {
      presets.innerHTML = PRESET_COLORS.map((color) =>
        `<button type="button" data-preset="${color}" style="background:${color}" title="${color}"></button>`
      ).join("");
    }
    document.getElementById("color-modal").classList.remove("hidden");
    paintColorUi();
  }

  function closeColor() {
    colorLabel = "";
    document.getElementById("color-modal").classList.add("hidden");
  }

  function normalizeColors(raw) {
    const colors = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return colors;
    for (const [label, color] of Object.entries(raw)) {
      if (typeof label === "string" && label && typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
        colors[label] = color.toLowerCase();
      }
    }
    return colors;
  }

  function colorsUrl() {
    return state.dataset ? `/api/colors?dataset=${encodeURIComponent(state.dataset)}` : "/api/colors";
  }

  async function persistColors() {
    const data = await api(colorsUrl(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ colors: state.colors }),
    });
    state.colors = normalizeColors(data.colors);
  }

  function fillMissingColors() {
    let changed = false;
    state.labels.forEach((label, index) => {
      if (!state.colors[label]) {
        state.colors[label] = labelmeColor(index);
        changed = true;
      }
    });
    return changed;
  }

  async function applyColor() {
    if (!colorLabel) return;
    state.colors[colorLabel] = hsvToHex(colorHue, colorSat, colorVal);
    closeColor();
    renderLabels();
    renderShapes();
    draw();
    try {
      await persistColors();
    } catch (error) {
      toast(error.message);
    }
  }

  function colorFromPad(event) {
    const rect = document.getElementById("sv").getBoundingClientRect();
    const width = rect.width || 1;
    const height = rect.height || 1;
    colorSat = Math.min(1, Math.max(0, (event.clientX - rect.left) / width));
    colorVal = Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / height));
    paintColorUi();
  }

  function roundPt(point) {
    return [Math.round(point[0] * 100) / 100, Math.round(point[1] * 100) / 100];
  }

  function cloneShapes(shapes) {
    return JSON.parse(JSON.stringify(shapes));
  }

  function snapshot() {
    state.undo.push(JSON.stringify(state.shapes));
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
  }

  function markDirty() {
    state.dirty = true;
    updateChrome();
  }

  function imageReady() {
    return !!(state.image && state.image.naturalWidth);
  }

  function toImage(event) {
    const rect = canvas.getBoundingClientRect();
    return [
      (event.clientX - rect.left - state.view.x) / state.view.scale,
      (event.clientY - rect.top - state.view.y) / state.view.scale,
    ];
  }

  function screenDist(a, b) {
    const dx = (a[0] - b[0]) * state.view.scale;
    const dy = (a[1] - b[1]) * state.view.scale;
    return Math.hypot(dx, dy);
  }

  function hidden(shape) {
    return state.hidden.has(shape.label);
  }

  function shapeShown(shape) {
    return showLabels.checked && !hidden(shape);
  }

  function distToSegment(point, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    if (len === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]);
    let t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
  }

  function pointInPoly(point, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const yi = points[i][1];
      const yj = points[j][1];
      const intersect = (yi > point[1]) !== (yj > point[1])
        && point[0] < ((points[j][0] - points[i][0]) * (point[1] - yi)) / (yj - yi) + points[i][0];
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function shapeHit(shape, point) {
    const pts = shape.points;
    if (!pts || !pts.length) return false;
    const tol = 7 / state.view.scale;
    if (shape.shape_type === "point") return Math.hypot(point[0] - pts[0][0], point[1] - pts[0][1]) <= tol;
    if (shape.shape_type === "circle" && pts.length >= 2) {
      const radius = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      return Math.hypot(point[0] - pts[0][0], point[1] - pts[0][1]) <= radius + tol;
    }
    if (shape.shape_type === "rectangle" && pts.length >= 2) {
      const x0 = Math.min(pts[0][0], pts[1][0]) - tol;
      const x1 = Math.max(pts[0][0], pts[1][0]) + tol;
      const y0 = Math.min(pts[0][1], pts[1][1]) - tol;
      const y1 = Math.max(pts[0][1], pts[1][1]) + tol;
      return point[0] >= x0 && point[0] <= x1 && point[1] >= y0 && point[1] <= y1;
    }
    if (shape.shape_type === "line" || shape.shape_type === "linestrip") {
      for (let i = 1; i < pts.length; i += 1) {
        if (distToSegment(point, pts[i - 1], pts[i]) <= tol) return true;
      }
      return false;
    }
    if (pointInPoly(point, pts)) return true;
    for (let i = 0; i < pts.length; i += 1) {
      if (distToSegment(point, pts[i], pts[(i + 1) % pts.length]) <= tol) return true;
    }
    return false;
  }

  function hitShapeIndex(point) {
    for (let i = state.shapes.length - 1; i >= 0; i -= 1) {
      if (shapeShown(state.shapes[i]) && shapeHit(state.shapes[i], point)) return i;
    }
    return -1;
  }

  function hitVertex(shape, point) {
    const tol = 8;
    for (let i = 0; i < shape.points.length; i += 1) {
      if (screenDist(shape.points[i], point) <= tol) return i;
    }
    return -1;
  }

  function hitVertexAny(point) {
    const order = [];
    if (state.selected >= 0) order.push(state.selected);
    for (let i = state.shapes.length - 1; i >= 0; i -= 1) {
      if (i !== state.selected) order.push(i);
    }
    for (const index of order) {
      const shape = state.shapes[index];
      if (!shapeShown(shape)) continue;
      const vertex = hitVertex(shape, point);
      if (vertex >= 0) return { index, vertex };
    }
    return null;
  }

  function nearestEdge(points, point, closed) {
    const tol = 8 / state.view.scale;
    let best = -1;
    let bestDist = tol;
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i += 1) {
      const dist = distToSegment(point, points[i], points[(i + 1) % points.length]);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  function setTool(tool) {
    state.tool = tool;
    state.draft = null;
    for (const button of document.querySelectorAll("#tools button")) {
      button.classList.toggle("active", button.dataset.tool === tool);
    }
    updateCursor();
    hintEl.textContent = HINTS[tool] || "";
    draw();
  }

  function formatScore(score) {
    return String(Math.round(score * 10000) / 10000);
  }

  function formatFalsePositive(value) {
    const tenths = Math.round(value * 10) / 10;
    if (Math.abs(value - tenths) < 1e-6) return tenths.toFixed(1);
    return formatScore(value);
  }

  function scoreFormula(item) {
    if (!item || !Number.isFinite(item.map50) || !Number.isFinite(item.false_positive)) return "";
    const total = Number.isFinite(item.score) ? item.score : 0.6 * item.map50 + 0.4 * item.false_positive;
    return `0.6*${formatScore(item.map50)}(map50)+0.4*${formatFalsePositive(item.false_positive)}(false_positive)=${formatScore(total)}`;
  }

  function perClassText(item) {
    if (!item || !Array.isArray(item.map50_per_class) || !item.map50_per_class.length) return "";
    if (!item.map50_per_class.every((value) => Number.isFinite(value))) return "";
    return `mAP50:  ${item.map50_per_class.map(formatScore).join(", ")}`;
  }

  function falsePositiveCountText(item) {
    if (!item || !Number.isFinite(item.false_positive)) return "";
    const count = Math.max(0, Math.round((1 - item.false_positive) * 10));
    return `false_positive:  ${count}`;
  }

  function updateCursor() {
    if (state.space || state.tool === "pan") {
      canvas.style.cursor = state.drag && state.drag.kind === "pan" ? "grabbing" : "grab";
    } else if (state.tool === "edit") {
      canvas.style.cursor = "default";
    } else {
      canvas.style.cursor = "crosshair";
    }
  }

  function updateChrome() {
    const item = current();
    document.title = "LabelMe";
    const rows = state.fileRows;
    const labeled = rows.reduce((sum, index) => sum + (state.images[index] && state.images[index].labeled ? 1 : 0), 0);
    fileCount.textContent = rows.length ? `${labeled}/${rows.length}` : "";
    document.getElementById("btn-prev").disabled = neighbor(-1) < 0;
    document.getElementById("btn-next").disabled = neighbor(1) < 0;
    document.getElementById("btn-save").disabled = !item;
    document.getElementById("btn-clear").disabled = !item;
    const pos = state.hover && imageReady()
      ? `${Math.round(state.hover[0])}, ${Math.round(state.hover[1])}`
      : "—";
    const size = imageReady() ? `${state.image.naturalWidth} × ${state.image.naturalHeight}` : "";
    const sizeEl = document.getElementById("image-size");
    sizeEl.textContent = item && size ? size : "";
    sizeEl.classList.toggle("hidden", !item || !size);
    const scoreEl = document.getElementById("image-score");
    const formula = scoreFormula(item);
    const score = formula || (item && Number.isFinite(item.score) ? formatScore(item.score) : "");
    scoreEl.textContent = score;
    scoreEl.classList.toggle("hidden", !score || !item || !size);
    const classEl = document.getElementById("image-classes");
    const classes = perClassText(item);
    classEl.textContent = classes;
    classEl.classList.toggle("hidden", !classes || !item || !size);
    const fpEl = document.getElementById("image-fp");
    const fpCount = falsePositiveCountText(item);
    fpEl.textContent = fpCount;
    fpEl.classList.toggle("hidden", !fpCount || !item || !size);
    const zoom = imageReady() ? `${Math.round(state.view.scale * 100)}%` : "—";
    const place = item ? `${state.index + 1}/${state.images.length}  ${item.path}` : "no image";
    statusEl.textContent = `${place}    ${size || "—"}    ${zoom}    xy ${pos}    ${state.shapes.length} shapes${state.dirty ? "    unsaved" : ""}`;
  }

  const FILE_ROW = 50;
  const FILE_PAD = 8;

  function filteredIndexes() {
    const query = fileFilter.value.trim().toLowerCase();
    const folder = state.folder;
    const rows = [];
    state.images.forEach((image, index) => {
      if (folder && image.dir !== folder) return;
      if (query && !`${image.path} ${image.name}`.toLowerCase().includes(query)) return;
      rows.push(index);
    });
    return rows;
  }

  function neighbor(delta) {
    const rows = state.fileRows;
    if (!rows.length) return -1;
    const pos = rows.indexOf(state.index);
    if (pos < 0) return delta > 0 ? rows[0] : -1;
    const next = pos + delta;
    if (next < 0 || next >= rows.length) return -1;
    return rows[next];
  }

  function renderFolders() {
    const select = document.getElementById("folder");
    const dirs = [];
    const seen = new Set();
    for (const image of state.images) {
      const dir = image.dir || "";
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      dirs.push(dir);
    }
    if (state.folder && !dirs.includes(state.folder)) state.folder = "";
    select.innerHTML = [`<option value="">All folders</option>`].concat(
      dirs.map((dir) => `<option value="${esc(dir)}">${esc(dir || "(root)")}</option>`)
    ).join("");
    select.value = state.folder;
    select.disabled = dirs.length === 0;
  }

  function fileRowsEl() {
    let inner = document.getElementById("file-rows");
    if (!inner) {
      fileList.innerHTML = `<div id="file-rows"></div>`;
      inner = document.getElementById("file-rows");
    }
    return inner;
  }

  function paintFiles() {
    const rows = state.fileRows;
    const inner = fileRowsEl();
    if (!rows.length) {
      inner.innerHTML = `<div class="sub" style="padding:8px">No matching files</div>`;
      return;
    }
    const top = fileList.scrollTop;
    const height = fileList.clientHeight || 600;
    const start = Math.max(0, Math.floor((top - FILE_PAD) / FILE_ROW) - 6);
    const end = Math.min(rows.length, Math.ceil((top + height - FILE_PAD) / FILE_ROW) + 8);
    const html = [`<div style="height:${start * FILE_ROW}px"></div>`];
    for (let i = start; i < end; i += 1) {
      const index = rows[i];
      const image = state.images[index];
      const dims = index === state.index && imageReady()
        ? `${state.image.naturalWidth} × ${state.image.naturalHeight}`
        : "";
      const sub = [image.dir, dims].filter(Boolean).join(" · ");
      html.push(
        `<div class="file${index === state.index ? " active" : ""}${image.labeled ? " labeled" : ""}" data-index="${index}">` +
          `<span class="mark"></span>` +
          `<span class="meta"><span class="name">${esc(image.name)}</span>` +
          `<span class="sub">${esc(sub)}</span></span></div>`
      );
    }
    html.push(`<div style="height:${(rows.length - end) * FILE_ROW}px"></div>`);
    inner.innerHTML = html.join("");
  }

  function renderFiles(reveal) {
    const rows = filteredIndexes();
    state.fileRows = rows;
    if (reveal) {
      const pos = rows.indexOf(state.index);
      if (pos >= 0) {
        const rowTop = FILE_PAD + pos * FILE_ROW;
        const rowBottom = rowTop + FILE_ROW;
        const viewTop = fileList.scrollTop;
        const viewBottom = viewTop + fileList.clientHeight;
        if (rowTop < viewTop) fileList.scrollTop = Math.max(0, rowTop - FILE_PAD);
        else if (rowBottom > viewBottom) fileList.scrollTop = rowBottom - fileList.clientHeight + FILE_PAD;
      }
    }
    paintFiles();
    updateChrome();
  }

  function palette() {
    const names = [...state.labels];
    const known = new Set(names);
    for (const shape of state.shapes) {
      if (shape.label && !known.has(shape.label)) {
        names.push(shape.label);
        known.add(shape.label);
      }
    }
    return names;
  }

  function renderLabels() {
    const names = palette();
    if (!showLabels.checked) {
      for (const label of names) state.hidden.add(label);
    }
    labelList.innerHTML = names.map((label) => {
      const checked = showLabels.checked && !state.hidden.has(label) ? "checked" : "";
      const color = labelColor(label);
      return `<div class="label-row${label === state.armed ? " armed" : ""}" data-label="${esc(label)}">` +
        `<input type="checkbox" data-hide="${esc(label)}" ${checked} title="Show this class" />` +
        `<span class="swatch" style="background:${color}" title="${esc(label)}"></span>` +
        `<span class="name">${esc(label)}</span>` +
        `<button type="button" class="edit-btn" data-pick="${esc(label)}" title="Edit color" aria-label="Edit color">` +
        `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">` +
        `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>` +
        `</svg></button>` +
        `<button type="button" data-remove="${esc(label)}" title="Remove from palette">×</button></div>`;
    }).join("") || `<div class="sub" style="padding:8px">No labels yet</div>`;
    labelOptions.innerHTML = names.map((label) => `<option value="${esc(label)}"></option>`).join("");
  }

  function revealSelectedShape() {
    const row = shapeList.querySelector(".shape.active");
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  function renderShapes() {
    if (!state.shapes.length) {
      shapeList.innerHTML = `<div class="sub" style="padding:8px">No objects on this image</div>`;
      return;
    }
    shapeList.innerHTML = state.shapes.map((shape, index) => {
      const group = shape.group_id == null ? "" : ` #${shape.group_id}`;
      return `<div class="shape${index === state.selected ? " active" : ""}" data-shape="${index}">` +
        `<span class="swatch" style="background:${labelColor(shape.label)}"></span>` +
        `<span class="meta"><span class="name">${esc(shape.label)}${esc(group)}</span>` +
        `<span class="sub">${esc(shape.shape_type)}</span></span>` +
        `<button type="button" data-del="${index}" title="Delete">×</button></div>`;
    }).join("");
  }

  function fit() {
    if (!imageReady()) return;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const pad = 28;
    const availW = Math.max(1, width - pad);
    const availH = Math.max(1, height - pad);
    state.view.scale = Math.max(
      0.01,
      Math.min(availW / state.image.naturalWidth, availH / state.image.naturalHeight)
    );
    state.view.x = (width - state.image.naturalWidth * state.view.scale) / 2;
    state.view.y = (height - state.image.naturalHeight * state.view.scale) / 2;
  }

  function zoomAt(factor, sx, sy) {
    const next = Math.min(80, Math.max(0.02, state.view.scale * factor));
    const ix = (sx - state.view.x) / state.view.scale;
    const iy = (sy - state.view.y) / state.view.scale;
    state.view.scale = next;
    state.view.x = sx - ix * next;
    state.view.y = sy - iy * next;
    draw();
  }

  function traceShape(shape) {
    const pts = shape.points || [];
    if (!pts.length) return;
    ctx.beginPath();
    if (shape.shape_type === "point") {
      const radius = 4 / state.view.scale;
      ctx.arc(pts[0][0], pts[0][1], radius, 0, Math.PI * 2);
      return;
    }
    if (shape.shape_type === "circle" && pts.length >= 2) {
      const radius = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      ctx.arc(pts[0][0], pts[0][1], radius, 0, Math.PI * 2);
      return;
    }
    if (shape.shape_type === "rectangle" && pts.length >= 2) {
      const x = Math.min(pts[0][0], pts[1][0]);
      const y = Math.min(pts[0][1], pts[1][1]);
      ctx.rect(x, y, Math.abs(pts[1][0] - pts[0][0]), Math.abs(pts[1][1] - pts[0][1]));
      return;
    }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
    if (shape.shape_type === "polygon") ctx.closePath();
  }

  function drawVertices(points) {
    const size = 5 / state.view.scale;
    ctx.fillStyle = "#fff";
    for (const point of points) {
      ctx.fillRect(point[0] - size / 2, point[1] - size / 2, size, size);
      ctx.strokeRect(point[0] - size / 2, point[1] - size / 2, size, size);
    }
  }

  function drawLabel(shape) {
    const pts = shape.points || [];
    if (!pts.length) return;
    let x = pts[0][0];
    let y = pts[0][1];
    for (const point of pts) {
      if (point[1] < y || (point[1] === y && point[0] < x)) {
        x = point[0];
        y = point[1];
      }
    }
    ctx.save();
    ctx.font = `${12 / state.view.scale}px Segoe UI, sans-serif`;
    ctx.textBaseline = "bottom";
    const text = shape.group_id == null ? shape.label : `${shape.label} #${shape.group_id}`;
    ctx.fillStyle = labelColor(shape.label);
    ctx.fillText(text, x, y - 1 / state.view.scale);
    ctx.restore();
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0c0e12";
    ctx.fillRect(0, 0, width, height);
    if (!imageReady()) {
      updateChrome();
      return;
    }
    ctx.save();
    ctx.translate(state.view.x, state.view.y);
    ctx.scale(state.view.scale, state.view.scale);
    ctx.imageSmoothingEnabled = state.view.scale < 2;
    ctx.drawImage(state.image, 0, 0);
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1 / state.view.scale;
    ctx.strokeRect(0, 0, state.image.naturalWidth, state.image.naturalHeight);

    state.shapes.forEach((shape, index) => {
      if (!shapeShown(shape) || !shape.points || !shape.points.length) return;
      const color = labelColor(shape.label || "?");
      traceShape(shape);
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = (index === state.selected ? 2.4 : 1.5) / state.view.scale;
      if (shape.shape_type !== "line" && shape.shape_type !== "linestrip") {
        ctx.save();
        ctx.globalAlpha = 0.22;
        ctx.fill();
        ctx.restore();
      }
      ctx.stroke();
      if (index === state.selected) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1 / state.view.scale;
        drawVertices(shape.points);
      }
      drawLabel(shape);
    });

    if (state.draft && state.draft.points.length) {
      const preview = {
        shape_type: state.draft.shape_type,
        points: state.draft.points.slice(),
        label: "",
      };
      if (state.hover && (state.tool === "polygon" || state.tool === "linestrip")) {
        preview.points = preview.points.concat([state.hover]);
      }
      traceShape(preview);
      const draftColor = currentLabelColor();
      ctx.strokeStyle = draftColor;
      ctx.fillStyle = draftColor;
      ctx.lineWidth = 1.5 / state.view.scale;
      ctx.stroke();
      drawVertices(state.draft.points);
    }

    if (state.pending && state.pending.points) {
      const pendingColor = currentLabelColor();
      traceShape({ shape_type: state.pending.shape_type, points: state.pending.points });
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = pendingColor;
      if (state.pending.shape_type !== "line" && state.pending.shape_type !== "linestrip") ctx.fill();
      ctx.restore();
      ctx.strokeStyle = pendingColor;
      ctx.lineWidth = 1.5 / state.view.scale;
      ctx.stroke();
    }

    if (state.drag && state.drag.origin && state.drag.current) {
      traceShape({
        shape_type: state.drag.kind,
        points: [state.drag.origin, state.drag.current],
      });
      ctx.strokeStyle = currentLabelColor();
      ctx.lineWidth = 1.5 / state.view.scale;
      ctx.stroke();
    }
    ctx.restore();
    updateChrome();
  }

  function askMeta(initial) {
    if (!askLabel.checked && (state.armed || initial.label)) {
      return Promise.resolve({
        label: initial.label || state.armed,
        group_id: initial.group_id ?? null,
        description: initial.description || "",
      });
    }
    return new Promise((resolve) => {
      state.modal = resolve;
      modal.classList.remove("hidden");
      labelInput.value = initial.label || state.armed || "";
      groupInput.value = initial.group_id == null ? "" : String(initial.group_id);
      descInput.value = initial.description || "";
      const names = palette();
      labelChips.innerHTML = names.slice(0, 24).map((label) =>
        `<button type="button" data-chip="${esc(label)}">${esc(label)}</button>`
      ).join("");
      labelInput.focus();
      labelInput.select();
    });
  }

  function closeModal(result) {
    if (!state.modal) return;
    const resolve = state.modal;
    state.modal = null;
    modal.classList.add("hidden");
    resolve(result);
  }

  function labelsUrl() {
    return state.dataset ? `/api/labels?dataset=${encodeURIComponent(state.dataset)}` : "/api/labels";
  }

  function renderDatasets() {
    const select = document.getElementById("dataset");
    select.innerHTML = state.datasets.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
    select.value = state.datasets.includes(state.dataset) ? state.dataset : "";
    select.disabled = state.datasets.length === 0;
    select.title = state.workdir || "";
  }

  async function remember(label) {
    if (!label || state.labels.includes(label)) {
      renderLabels();
      return;
    }
    state.labels.push(label);
    renderLabels();
    try {
      const data = await api(labelsUrl(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: state.labels }),
      });
      state.labels = data.labels;
      renderLabels();
    } catch (error) {
      toast(error.message);
    }
  }

  async function commitShape(partial) {
    state.pending = partial;
    draw();
    const meta = await askMeta({ label: state.armed || "" });
    state.pending = null;
    if (!meta) {
      draw();
      return;
    }
    snapshot();
    state.shapes.push({
      label: meta.label,
      points: partial.points,
      group_id: meta.group_id,
      description: meta.description,
      shape_type: partial.shape_type,
      flags: {},
      mask: null,
    });
    state.selected = state.shapes.length - 1;
    state.armed = meta.label;
    markDirty();
    renderShapes();
    revealSelectedShape();
    draw();
    await remember(meta.label);
  }

  async function renameSelected(index) {
    const shape = state.shapes[index];
    if (!shape) return;
    const meta = await askMeta(shape);
    if (!meta) return;
    snapshot();
    shape.label = meta.label;
    shape.group_id = meta.group_id;
    shape.description = meta.description;
    state.armed = meta.label;
    markDirty();
    renderShapes();
    draw();
    await remember(meta.label);
  }

  function readMeta() {
    const label = labelInput.value.trim();
    if (!label) return null;
    const groupText = groupInput.value.trim();
    let group_id = null;
    if (groupText) {
      if (!/^-?\d+$/.test(groupText)) {
        toast("Group id must be an integer");
        return null;
      }
      group_id = Number(groupText);
    }
    return { label, group_id, description: descInput.value.trim() };
  }

  function deleteSelected() {
    if (state.selected < 0) return;
    snapshot();
    state.shapes.splice(state.selected, 1);
    state.selected = Math.min(state.selected, state.shapes.length - 1);
    markDirty();
    renderShapes();
    draw();
  }

  function undo() {
    if (state.draft && state.draft.points.length) {
      state.draft.points.pop();
      if (!state.draft.points.length) state.draft = null;
      draw();
      return;
    }
    if (!state.undo.length) return;
    state.redo.push(JSON.stringify(state.shapes));
    state.shapes = JSON.parse(state.undo.pop());
    state.selected = Math.min(state.selected, state.shapes.length - 1);
    markDirty();
    renderShapes();
    draw();
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(JSON.stringify(state.shapes));
    state.shapes = JSON.parse(state.redo.pop());
    state.selected = Math.min(state.selected, state.shapes.length - 1);
    markDirty();
    renderShapes();
    draw();
  }

  function nudge(dx, dy) {
    const shape = state.shapes[state.selected];
    if (!shape) return;
    snapshot();
    for (const point of shape.points) {
      point[0] = Math.round((point[0] + dx) * 100) / 100;
      point[1] = Math.round((point[1] + dy) * 100) / 100;
    }
    markDirty();
    draw();
  }

  async function saveCurrent() {
    const item = current();
    if (!item) return;
    if (!imageReady()) throw new Error("Image is still loading");
    const saved = await api(`/api/annotation?path=${encodeURIComponent(item.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "5.5.0",
        flags: {},
        shapes: state.shapes,
        imagePath: item.name,
        imageData: null,
        imageHeight: state.image.naturalHeight,
        imageWidth: state.image.naturalWidth,
      }),
    });
    state.shapes = saved.shapes;
    if (saved.labels) state.labels = saved.labels;
    item.labeled = true;
    state.dirty = false;
    renderFiles(false);
    toast(saved.unstored ? `Saved. ${saved.unstored} shape${saved.unstored === 1 ? "" : "s"} kept beside the image` : "Saved");
    renderShapes();
    renderLabels();
    updateChrome();
  }

  async function clearAnnotation() {
    const item = current();
    if (!item) return;
    if (!window.confirm(`Remove every box from ${item.name}?`)) return;
    const data = await api(`/api/annotation?path=${encodeURIComponent(item.path)}`, { method: "DELETE" });
    snapshot();
    state.shapes = [];
    state.selected = -1;
    state.dirty = false;
    item.labeled = !!data.exists;
    renderFiles(false);
    renderShapes();
    draw();
    toast("Annotation removed");
  }

  async function loadIndex(index) {
    if (index < 0 || index >= state.images.length) return;
    const my = ++state.token;
    state.index = index;
    state.shapes = [];
    state.selected = -1;
    state.draft = null;
    state.drag = null;
    state.undo = [];
    state.redo = [];
    state.dirty = false;
    state.image = null;
    const item = state.images[index];
    renderFiles(true);
    renderShapes();
    draw();
    try {
      const ann = await api(`/api/annotation?path=${encodeURIComponent(item.path)}`);
      if (my !== state.token) return;
      if (ann.error) toast(ann.error);
      state.shapes = Array.isArray(ann.shapes) ? ann.shapes : [];
    } catch (error) {
      if (my === state.token) toast(error.message);
    }
    const img = new Image();
    img.onload = () => {
      if (my !== state.token) return;
      state.image = img;
      fit();
      paintFiles();
      renderShapes();
      renderLabels();
      draw();
    };
    img.onerror = () => {
      if (my === state.token) toast(`Could not load ${item.name}`);
    };
    img.src = `/api/image?path=${encodeURIComponent(item.path)}&t=${Date.now()}`;
  }

  async function goTo(index) {
    if (state.navigating || index === state.index || index < 0 || index >= state.images.length) return;
    state.navigating = true;
    try {
      if (state.dirty) await saveCurrent();
      await loadIndex(index);
    } catch (error) {
      toast(error.message);
    } finally {
      state.navigating = false;
    }
  }

  async function refresh(options = {}) {
    if (state.dirty) {
      try {
        await saveCurrent();
      } catch (error) {
        toast(error.message);
        return;
      }
    }
    const previous = options.forgetPath ? null : current()?.path;
    const query = state.dataset ? `?dataset=${encodeURIComponent(state.dataset)}` : "";
    const data = await api(`/api/state${query}`);
    state.workdir = data.workdir;
    state.dataset = data.dataset || "";
    state.datasets = data.datasets || [];
    if (options.forgetPath) {
      state.folder = localStorage.getItem("labelling-folder:" + state.dataset) || "";
    }
    if (state.dataset) localStorage.setItem("labelling-dataset", state.dataset);
    state.labels = data.labels;
    state.colors = normalizeColors(data.colors);
    if (fillMissingColors()) {
      try {
        await persistColors();
      } catch (error) {
        toast(error.message);
      }
    }
    state.images = data.images;
    renderDatasets();
    renderFolders();
    workdirEl.textContent = data.workdir;
    emptyPath.textContent = data.workdir;
    emptyEl.classList.toggle("hidden", state.images.length > 0);
    hintEl.style.display = state.images.length ? "" : "none";
    renderLabels();
    if (!state.images.length) {
      state.index = -1;
      state.shapes = [];
      state.image = null;
      renderFiles(false);
      renderShapes();
      draw();
      return;
    }
    let index = options.forgetPath ? -1 : state.images.findIndex((image) => image.path === previous);
    if (index < 0) {
      const visible = filteredIndexes();
      index = visible.length ? visible[0] : 0;
    }
    await loadIndex(index);
  }

  function finishDraft() {
    if (!state.draft) return;
    const draft = state.draft;
    const min = draft.shape_type === "polygon" ? 3 : 2;
    if (draft.points.length < min) {
      toast(draft.shape_type === "polygon" ? "A polygon needs at least 3 points" : "Add at least 2 points");
      return;
    }
    state.draft = null;
    void commitShape({ shape_type: draft.shape_type, points: draft.points.map((point) => point.slice()) });
  }

  function onPointerDown(event) {
    if (state.modal || state.pending || colorLabel) return;
    if (event.button === 0 || event.button === 1) {
      try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* already released */ }
    }
    if (event.button === 1) event.preventDefault();
    if (event.button === 2) return;
    const point = imageReady() ? roundPt(toImage(event)) : null;
    if (event.button === 1 || state.space || state.tool === "pan") {
      state.drag = {
        kind: "pan",
        sx: event.clientX,
        sy: event.clientY,
        vx: state.view.x,
        vy: state.view.y,
      };
      updateCursor();
      return;
    }
    if (!imageReady() || !point) return;
    if (state.tool === "edit") {
      const vertex = hitVertexAny(point);
      if (vertex) {
        state.selected = vertex.index;
        state.drag = { kind: "vertex", index: vertex.index, vertex: vertex.vertex, moved: false };
        renderShapes();
        draw();
        return;
      }
      const hit = hitShapeIndex(point);
      state.selected = hit;
      if (hit >= 0) state.drag = { kind: "shape", index: hit, last: point, moved: false };
      renderShapes();
      draw();
      return;
    }
    if (state.tool === "point") {
      void commitShape({ shape_type: "point", points: [point] });
      return;
    }
    if (state.tool === "polygon" || state.tool === "linestrip") {
      if (!state.draft) state.draft = { shape_type: state.tool, points: [] };
      if (state.tool === "polygon" && state.draft.points.length >= 3 && screenDist(state.draft.points[0], point) < 12) {
        finishDraft();
        return;
      }
      state.draft.points.push(point);
      draw();
      return;
    }
    if (state.tool === "rectangle" || state.tool === "circle" || state.tool === "line") {
      state.drag = { kind: state.tool, origin: point, current: point };
      draw();
    }
  }

  function onPointerMove(event) {
    if (imageReady()) state.hover = toImage(event);
    const drag = state.drag;
    if (!drag) {
      if (state.draft) draw();
      else updateChrome();
      return;
    }
    if (drag.kind === "pan") {
      state.view.x = drag.vx + (event.clientX - drag.sx);
      state.view.y = drag.vy + (event.clientY - drag.sy);
      draw();
      return;
    }
    if (!imageReady()) return;
    const point = roundPt(toImage(event));
    if (drag.kind === "vertex" || drag.kind === "shape") {
      if (!drag.moved) {
        snapshot();
        drag.moved = true;
        markDirty();
      }
      if (drag.kind === "vertex") {
        state.shapes[drag.index].points[drag.vertex] = point;
      } else {
        const dx = point[0] - drag.last[0];
        const dy = point[1] - drag.last[1];
        for (const pt of state.shapes[drag.index].points) {
          pt[0] = Math.round((pt[0] + dx) * 100) / 100;
          pt[1] = Math.round((pt[1] + dy) * 100) / 100;
        }
        drag.last = point;
      }
      draw();
      return;
    }
    drag.current = point;
    draw();
  }

  function onPointerUp() {
    const drag = state.drag;
    state.drag = null;
    updateCursor();
    if (!drag || drag.kind === "pan" || drag.kind === "vertex" || drag.kind === "shape") {
      draw();
      return;
    }
    const a = drag.origin;
    const b = drag.current;
    const far = Math.hypot(a[0] - b[0], a[1] - b[1]) >= 2;
    if (!far) {
      draw();
      return;
    }
    void commitShape({ shape_type: drag.kind, points: [a.slice(), b.slice()] });
  }

  function onDoubleClick(event) {
    if (state.modal || colorLabel) return;
    if (state.tool === "polygon" || state.tool === "linestrip") {
      if (state.draft && state.draft.points.length) state.draft.points.pop();
      finishDraft();
      return;
    }
    if (state.tool !== "edit" || !imageReady()) return;
    const point = roundPt(toImage(event));
    const shape = state.shapes[state.selected];
    if (!shape || shape.shape_type !== "polygon") return;
    const edge = nearestEdge(shape.points, point, true);
    if (edge < 0) return;
    snapshot();
    shape.points.splice(edge + 1, 0, point);
    markDirty();
    draw();
  }

  function onKeyDown(event) {
    if (colorLabel) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeColor();
      }
      return;
    }
    if (state.modal) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal(null);
      }
      return;
    }
    const typing = event.target.matches("input, textarea, select");
    if (typing) return;
    if (event.code === "Space") {
      event.preventDefault();
      state.space = true;
      updateCursor();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrent().catch((error) => toast(error.message));
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (event.key === "Escape") {
      state.draft = null;
      draw();
      return;
    }
    if (event.key === "Enter") {
      finishDraft();
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      if (state.draft && state.draft.points.length) {
        state.draft.points.pop();
        if (!state.draft.points.length) state.draft = null;
        draw();
      }
      return;
    }
    if (event.key === "Delete") {
      deleteSelected();
      return;
    }
    if (event.key === "PageDown") {
      event.preventDefault();
      void goTo(neighbor(1));
      return;
    }
    if (event.key === "PageUp") {
      event.preventDefault();
      void goTo(neighbor(-1));
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      if (state.tool === "edit" && state.selected >= 0 && !event.ctrlKey) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        nudge(dx, dy);
        return;
      }
      if (event.key === "ArrowLeft") void goTo(neighbor(-1));
      if (event.key === "ArrowRight") void goTo(neighbor(1));
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const tools = {
      p: "polygon",
      r: "rectangle",
      c: "circle",
      l: "line",
      t: "linestrip",
      m: "point",
      v: "edit",
      h: "pan",
    };
    if (tools[event.key.toLowerCase()]) {
      setTool(tools[event.key.toLowerCase()]);
      return;
    }
    if (event.key === "0") {
      fit();
      draw();
    }
  }

  document.getElementById("tools").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tool]");
    if (button) setTool(button.dataset.tool);
  });
  document.getElementById("btn-undo").addEventListener("click", undo);
  document.getElementById("btn-redo").addEventListener("click", redo);
  document.getElementById("btn-fit").addEventListener("click", () => { fit(); draw(); });
  document.getElementById("btn-prev").addEventListener("click", () => { void goTo(neighbor(-1)); });
  document.getElementById("btn-next").addEventListener("click", () => { void goTo(neighbor(1)); });
  document.getElementById("btn-save").addEventListener("click", () => {
    saveCurrent().catch((error) => toast(error.message));
  });
  document.getElementById("btn-clear").addEventListener("click", () => {
    clearAnnotation().catch((error) => toast(error.message));
  });
  document.getElementById("btn-refresh").addEventListener("click", () => {
    refresh().catch((error) => toast(error.message));
  });
  document.getElementById("dataset").addEventListener("change", (event) => {
    const next = event.target.value;
    if (next === state.dataset) return;
    state.dataset = next;
    state.hidden = new Set();
    state.armed = "";
    localStorage.setItem("labelling-dataset", next);
    refresh({ forgetPath: true }).catch((error) => toast(error.message));
  });
  fileFilter.addEventListener("input", () => {
    fileList.scrollTop = 0;
    renderFiles(false);
  });
  document.getElementById("folder").addEventListener("change", (event) => {
    state.folder = event.target.value;
    localStorage.setItem("labelling-folder:" + state.dataset, state.folder);
    fileList.scrollTop = 0;
    renderFiles(false);
  });
  fileList.addEventListener("scroll", () => paintFiles());
  fileList.addEventListener("click", (event) => {
    const row = event.target.closest(".file");
    if (!row) return;
    void goTo(Number(row.dataset.index));
  });
  shapeList.addEventListener("click", (event) => {
    const del = event.target.closest("[data-del]");
    if (del) {
      state.selected = Number(del.dataset.del);
      deleteSelected();
      return;
    }
    const row = event.target.closest("[data-shape]");
    if (!row) return;
    state.selected = Number(row.dataset.shape);
    renderShapes();
    draw();
  });
  shapeList.addEventListener("dblclick", (event) => {
    const row = event.target.closest("[data-shape]");
    if (!row) return;
    void renameSelected(Number(row.dataset.shape));
  });
  showLabels.addEventListener("change", () => {
    localStorage.setItem("labelling-show-labels", showLabels.checked ? "1" : "0");
    if (showLabels.checked) state.hidden.clear();
    else {
      for (const label of palette()) state.hidden.add(label);
    }
    renderLabels();
    draw();
  });

  labelList.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      state.labels = state.labels.filter((label) => label !== remove.dataset.remove);
      if (state.armed === remove.dataset.remove) state.armed = "";
      renderLabels();
      api(labelsUrl(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: state.labels }),
      }).then((data) => {
        state.labels = data.labels;
        renderLabels();
      }).catch((error) => toast(error.message));
      return;
    }
    if (event.target.matches("[data-hide]")) return;
    const pick = event.target.closest("[data-pick]");
    if (pick) {
      openColor(pick.dataset.pick);
      return;
    }
    const row = event.target.closest("[data-label]");
    if (!row) return;
    state.armed = row.dataset.label;
    renderLabels();
  });
  labelList.addEventListener("change", (event) => {
    const input = event.target.closest("[data-hide]");
    if (!input) return;
    if (input.checked) {
      state.hidden.delete(input.dataset.hide);
      state.armed = input.dataset.hide;
      if (!showLabels.checked) {
        showLabels.checked = true;
        localStorage.setItem("labelling-show-labels", "1");
      }
    } else {
      state.hidden.add(input.dataset.hide);
    }
    renderLabels();
    draw();
  });
  document.getElementById("add-label-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const label = newLabel.value.trim();
    if (!label) return;
    newLabel.value = "";
    state.armed = label;
    void remember(label);
  });
  labelForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const meta = readMeta();
    if (meta) closeModal(meta);
  });
  document.getElementById("modal-cancel").addEventListener("click", () => closeModal(null));
  labelChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-chip]");
    if (!chip) return;
    labelInput.value = chip.dataset.chip;
    labelInput.focus();
  });

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (state.modal || state.pending || colorLabel) return;
    if (state.draft) {
      state.draft = null;
      draw();
      return;
    }
    if (!imageReady()) return;
    const hit = hitShapeIndex(roundPt(toImage(event)));
    if (hit < 0) return;
    state.selected = hit;
    renderShapes();
    revealSelectedShape();
    draw();
  });
  canvas.addEventListener("wheel", (event) => {
    if (!imageReady()) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      state.space = false;
      updateCursor();
    }
  });
  window.addEventListener("blur", () => {
    state.space = false;
    updateCursor();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
  new ResizeObserver(() => draw()).observe(stage);

  const sv = document.getElementById("sv");
  sv.addEventListener("pointerdown", (event) => {
    colorDrag = true;
    try { sv.setPointerCapture(event.pointerId); } catch (_) { /* already released */ }
    colorFromPad(event);
  });
  sv.addEventListener("pointermove", (event) => {
    if (!colorDrag) return;
    colorFromPad(event);
  });
  const endColorDrag = () => { colorDrag = false; };
  sv.addEventListener("pointerup", endColorDrag);
  sv.addEventListener("pointercancel", endColorDrag);
  document.getElementById("hue").addEventListener("input", (event) => {
    colorHue = Number(event.target.value);
    paintColorUi();
  });
  document.getElementById("color-hex").addEventListener("input", (event) => {
    const match = event.target.value.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (!match) return;
    const hsv = hexToHsv(`#${match[1]}`);
    colorHue = hsv.h;
    colorSat = hsv.s;
    colorVal = hsv.v;
    paintColorUi(false);
  });
  document.getElementById("color-presets").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) return;
    const hsv = hexToHsv(button.dataset.preset);
    colorHue = hsv.h;
    colorSat = hsv.s;
    colorVal = hsv.v;
    paintColorUi();
  });
  document.getElementById("color-form").addEventListener("submit", (event) => {
    event.preventDefault();
    applyColor();
  });
  document.getElementById("color-cancel").addEventListener("click", closeColor);
  document.getElementById("color-modal").addEventListener("pointerdown", (event) => {
    if (event.target.id === "color-modal") closeColor();
  });

  setTool("rectangle");
  refresh().catch((error) => {
    statusEl.textContent = error.message;
    toast(error.message);
  });
})();
