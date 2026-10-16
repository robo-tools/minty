// Small SVG charts for the dashboard's popups (CFA now; EGG later): grouped bars, lines and a
// legend. No library and no CDN, so the CSP stays 'self'. Colours come from CSS classes on each
// series (cfa.css), so light and dark follow the dashboard's tokens. Each chart returns an SVG
// string; values in a <title> show on hover. Loaded as a classic script: window.MintyCharts.
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const PAD = { l: 52, r: 8, t: 10, b: 24 };    // drawn at the container's width (`width`), so text stays its CSS size

  /** Round gridline steps: 0, then 1, 2 or 5 × a power of ten. */
  function ticks(lo, hi, n = 4) {
    if (lo === hi) hi = lo + 1;
    const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map(m => m * p).find(s => s >= raw);
    const out = [];
    for (let v = Math.floor(lo / step) * step; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  function frame(labels, values, h, fmt, W, gap = 48) {
    const all = values.flat().filter(v => Number.isFinite(v));
    const t = ticks(Math.min(0, ...all), Math.max(0, ...all));
    const lo = t[0], hi = t[t.length - 1];
    const y = v => PAD.t + (h - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo || 1));
    const every = Math.ceil(labels.length / Math.max(2, Math.floor((W - PAD.l) / gap)));   // a label every `gap` px at most
    const grid = t.map(v => `<line class="ch-grid${v === 0 ? " zero" : ""}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/>` +
      `<text class="ch-axis" x="${PAD.l - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`).join("");
    return { y, grid, every };
  }

  /** Grouped bars: one group per label, one bar per series. */
  function bars({ labels, series, width = 640, height = 200, fmt = String, short = l => l }) {
    const W = width, { y, grid, every } = frame(labels, series.map(s => s.values), height, fmt, W);
    const slot = (W - PAD.l - PAD.r) / labels.length, gap = Math.min(10, slot * 0.25), bw = (slot - gap) / series.length;
    let body = "";
    labels.forEach((l, i) => {
      series.forEach((s, j) => {
        const v = s.values[i];
        if (!Number.isFinite(v)) return;
        const x = PAD.l + i * slot + gap / 2 + j * bw, top = Math.min(y(v), y(0)), hgt = Math.abs(y(v) - y(0));
        body += `<rect class="ch-bar ${esc(s.cls)}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${Math.max(0.5, hgt).toFixed(1)}"><title>${esc(`${l} · ${s.name}: ${fmt(v)}`)}</title></rect>`;
      });
      if (i % every === 0) body += `<text class="ch-axis" x="${(PAD.l + i * slot + slot / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(short(l))}</text>`;
    });
    return `<svg class="ch" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img">${grid}${body}</svg>`;
  }

  /** Lines over evenly spaced labels; null values leave a gap. */
  function lines({ labels, series, width = 640, height = 180, fmt = String, short = l => l, dots = false, gap = 48 }) {
    const W = width, { y, grid, every } = frame(labels, series.map(s => s.values), height, fmt, W, gap);
    const n = labels.length, x = i => PAD.l + (n === 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1));
    let body = "";
    for (const s of series) {
      let d = "", pen = false;
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
      });
      body += `<path class="ch-line ${esc(s.cls)}" d="${d}"/>`;
      s.values.forEach((v, i) => {
        if (Number.isFinite(v) && (dots || n === 1 || i === n - 1)) body += `<circle class="ch-dot ${esc(s.cls)}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"><title>${esc(`${labels[i]} · ${s.name}: ${fmt(v)}`)}</title></circle>`;
      });
    }
    // every `every`-th label, and the last one unless it would sit on top of the one before
    labels.forEach((l, i) => { if ((i % every === 0 && (i === 0 || n - 1 - i >= every * 0.8)) || i === n - 1) body += `<text class="ch-axis" x="${x(i).toFixed(1)}" y="${height - 6}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(short(l))}</text>`; });
    return `<svg class="ch" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img">${grid}${body}</svg>`;
  }

  const legend = series => `<div class="ch-legend">${series.map(s => `<span><i class="${esc(s.cls)}"></i>${esc(s.name)}</span>`).join("")}</div>`;

  window.MintyCharts = { bars, lines, legend, ticks };
})();
