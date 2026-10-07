/* SkyCast AI model. Runs in a Web Worker so training never freezes the page.

   For every city it learns, from decades of daily weather:
     "standing on day t, with recent weather and the El Nino state looking like this,
      what happened h days later?"   for every lead h from 1 to 366 days.
   Learners: gradient boosted decision trees (histogram based, written from scratch below)
     tmax anomaly, tmin anomaly  (squared loss)
     snow day, rain day          (log loss, gives probabilities)
   Before trusting itself it backtests on the last three years against the 30 year normals.
*/
"use strict";

const YEAR = 365.25, HORIZON = 366, SNOW_CM = 0.5, WET_MM = 1.0;
const BUCKETS = [[1, 3], [4, 7], [8, 16], [17, 45], [46, 120], [121, 366]];
const FEATS = ["lead", "log_lead", "t_sin1", "t_cos1", "t_sin2", "t_cos2", "i_sin1", "i_cos1",
  "a1", "a3", "a7", "a30", "a90", "n7", "n30", "p30", "s30", "s7", "oni", "a7_decay", "a30_decay"];
const F = FEATS.length;
const NB = 32; // histogram bins per feature

/* ---------- dates ---------- */
function dayInfo(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  const doy = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5) + 1;
  return { y, m, doy };
}
function addDays(iso, k) {
  return new Date(Date.parse(iso + "T00:00:00Z") + k * 864e5).toISOString().slice(0, 10);
}

/* ---------- climatology: seasonal cycle (3 harmonics) + linear trend ---------- */
function designRow(iso, t0) {
  const { y, doy } = dayInfo(iso);
  const r = [1, y + doy / YEAR - t0];
  for (let k = 1; k <= 3; k++) { const w = 2 * Math.PI * k * doy / YEAR; r.push(Math.sin(w), Math.cos(w)); }
  return r;
}
function solve(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}
function fitClim(dates, tmax, tmin) {
  const t0 = +dates[0].slice(0, 4), P = 8;
  const XtX = Array.from({ length: P }, () => new Array(P).fill(0)), bx = new Array(P).fill(0), bn = new Array(P).fill(0);
  for (let i = 0; i < dates.length; i++) {
    const r = designRow(dates[i], t0);
    for (let a = 0; a < P; a++) { bx[a] += r[a] * tmax[i]; bn[a] += r[a] * tmin[i]; for (let b = 0; b < P; b++) XtX[a][b] += r[a] * r[b]; }
  }
  return { t0, cx: solve(XtX, bx), cn: solve(XtX, bn) };
}
function normals(clim, iso) {
  const r = designRow(iso, clim.t0);
  let x = 0, n = 0; for (let k = 0; k < r.length; k++) { x += r[k] * clim.cx[k]; n += r[k] * clim.cn[k]; }
  return [x, n];
}

/* ---------- features ---------- */
function rollMean(a, w) {
  const out = new Float64Array(a.length); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= w) s -= a[i - w]; out[i] = s / Math.min(i + 1, w); }
  return out;
}
function rollSum(a, w) { const m = rollMean(a, w); return m.map((v, i) => v * Math.min(i + 1, w)); }

function oniLookup(oni) { // ONI published ~1 month late: on a date, use the season ending last month
  const map = new Map(); let lo = Infinity, hi = -Infinity;
  for (const o of oni || []) { const k = o.year * 12 + o.month - 1; map.set(k, o.oni); lo = Math.min(lo, k); hi = Math.max(hi, k); }
  return (iso) => {
    if (!map.size) return 0;
    const { y, m } = dayInfo(iso); let k = Math.min(y * 12 + m - 2, hi);
    while (k >= lo) { if (map.has(k)) return map.get(k); k--; }
    return 0;
  };
}

function issueFeatures(obs, clim, oni) {
  const n = obs.dates.length, ax = new Float64Array(n), an = new Float64Array(n);
  for (let i = 0; i < n; i++) { const [x, m] = normals(clim, obs.dates[i]); ax[i] = obs.tmax[i] - x; an[i] = obs.tmin[i] - m; }
  const getOni = oniLookup(oni);
  const f = {
    a1: ax, a3: rollMean(ax, 3), a7: rollMean(ax, 7), a30: rollMean(ax, 30), a90: rollMean(ax, 90),
    n7: rollMean(an, 7), n30: rollMean(an, 30),
    p30: rollSum(obs.precip, 30), s30: rollSum(obs.snow, 30), s7: rollSum(obs.snow, 7),
    i_sin1: new Float64Array(n), i_cos1: new Float64Array(n), oni: new Float64Array(n), ax, an,
  };
  for (let i = 0; i < n; i++) {
    const { doy } = dayInfo(obs.dates[i]);
    f.i_sin1[i] = Math.sin(2 * Math.PI * doy / YEAR); f.i_cos1[i] = Math.cos(2 * Math.PI * doy / YEAR);
    f.oni[i] = getOni(obs.dates[i]);
  }
  return f;
}

function fillRow(X, r, f, i, targetIso, lead) {
  const o = r * F, { doy } = dayInfo(targetIso);
  const v = {
    lead, log_lead: Math.log1p(lead),
    t_sin1: Math.sin(2 * Math.PI * doy / YEAR), t_cos1: Math.cos(2 * Math.PI * doy / YEAR),
    t_sin2: Math.sin(4 * Math.PI * doy / YEAR), t_cos2: Math.cos(4 * Math.PI * doy / YEAR),
    a7_decay: f.a7[i] * Math.exp(-lead / 5), a30_decay: f.a30[i] * Math.exp(-lead / 30),
  };
  for (let k = 0; k < F; k++) { const name = FEATS[k]; X[o + k] = name in v ? v[name] : f[name][i]; }
}

function trainingSet(obs, f) {
  const n = obs.dates.length, rows = [];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 90; i < n - 1; i += 5) {
    for (let k = 0; k < 12; k++) { const L = 1 + Math.floor(rnd() * 30); if (i + L < n) rows.push(i, L); }
    for (let k = 0; k < 20; k++) { const L = 31 + Math.floor(rnd() * (HORIZON - 30)); if (i + L < n) rows.push(i, L); }
  }
  const N = rows.length / 2, X = new Float32Array(N * F);
  const issue = new Int32Array(N), lead = new Int32Array(N);
  const yx = new Float32Array(N), yn = new Float32Array(N), ys = new Float32Array(N), yr = new Float32Array(N);
  for (let r = 0; r < N; r++) {
    const i = rows[2 * r], L = rows[2 * r + 1], t = i + L;
    fillRow(X, r, f, i, obs.dates[t], L);
    issue[r] = i; lead[r] = L;
    yx[r] = f.ax[t]; yn[r] = f.an[t];
    ys[r] = obs.snow[t] >= SNOW_CM ? 1 : 0; yr[r] = obs.precip[t] >= WET_MM ? 1 : 0;
  }
  return { N, X, issue, lead, yx, yn, ys, yr };
}

/* ---------- gradient boosted trees (histogram based) ---------- */
function makeBins(X, N) {
  const edges = [], B = new Uint8Array(N * F);
  for (let k = 0; k < F; k++) {
    const step = Math.max(1, Math.floor(N / 20000)), s = [];
    for (let r = 0; r < N; r += step) s.push(X[r * F + k]);
    s.sort((a, b) => a - b);
    const e = [];
    for (let q = 1; q < NB; q++) { const v = s[Math.floor(q * (s.length - 1) / NB)]; if (!e.length || v > e[e.length - 1]) e.push(v); }
    edges.push(e);
    for (let r = 0; r < N; r++) {
      const x = X[r * F + k]; let lo = 0, hi = e.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (x <= e[mid]) hi = mid; else lo = mid + 1; }
      B[r * F + k] = lo;
    }
  }
  return { edges, B };
}

function buildTree(B, idx, g, h, opt, edges) {
  const nodes = [];
  const G = new Float64Array(F * NB), H = new Float64Array(F * NB), C = new Int32Array(F * NB);
  function grow(rows, depth) {
    let sg = 0, sh = 0;
    for (const r of rows) { sg += g[r]; sh += h[r]; }
    const id = nodes.length;
    nodes.push({ f: -1, v: -opt.lr * sg / (sh + opt.lambda) });
    if (depth >= opt.depth || rows.length < 2 * opt.minLeaf) return id;
    G.fill(0); H.fill(0); C.fill(0);
    for (const r of rows) { const o = r * F; for (let k = 0; k < F; k++) { const j = k * NB + B[o + k]; G[j] += g[r]; H[j] += h[r]; C[j]++; } }
    const parent = sg * sg / (sh + opt.lambda);
    let best = 1e-9, bf = -1, bb = -1;
    for (let k = 0; k < F; k++) {
      let gl = 0, hl = 0, cl = 0;
      for (let b = 0; b < edges[k].length; b++) {
        const j = k * NB + b; gl += G[j]; hl += H[j]; cl += C[j];
        const cr = rows.length - cl;
        if (cl < opt.minLeaf) continue; if (cr < opt.minLeaf) break;
        const gr = sg - gl, hr = sh - hl;
        const gain = gl * gl / (hl + opt.lambda) + gr * gr / (hr + opt.lambda) - parent;
        if (gain > best) { best = gain; bf = k; bb = b; }
      }
    }
    if (bf < 0) return id;
    const L = [], R = [];
    for (const r of rows) (B[r * F + bf] <= bb ? L : R).push(r);
    nodes[id] = { f: bf, b: bb, t: edges[bf][bb], l: 0, r: 0 };
    nodes[id].l = grow(L, depth + 1);
    nodes[id].r = grow(R, depth + 1);
    return id;
  }
  grow(idx, 0);
  return nodes;
}
const walkBin = (nodes, B, r) => { let n = nodes[0]; while (n.f >= 0) n = nodes[B[r * F + n.f] <= n.b ? n.l : n.r]; return n.v; };
const walkRaw = (nodes, x, o) => { let n = nodes[0]; while (n.f >= 0) n = nodes[x[o + n.f] <= n.t ? n.l : n.r]; return n.v; };
const sigmoid = z => 1 / (1 + Math.exp(-z));

function fitGBM(data, y, trainIdx, valIdx, loss, bins, onTree) {
  const opt = { lr: 0.1, depth: 4, minLeaf: 300, lambda: 5, maxTrees: 160, patience: 12 };
  let base = 0; for (const r of trainIdx) base += y[r]; base /= trainIdx.length;
  if (loss === "log") {
    if (base * trainIdx.length < 30) return { constant: base }; // event almost never happens here
    base = Math.log(base / (1 - base));
  }
  const N = data.N, Fm = new Float64Array(N).fill(base), g = new Float64Array(N), h = new Float64Array(N).fill(1);
  const trees = []; let bestLoss = Infinity, bestK = 0;
  for (let k = 0; k < opt.maxTrees; k++) {
    for (const r of trainIdx) {
      if (loss === "log") { const p = sigmoid(Fm[r]); g[r] = p - y[r]; h[r] = Math.max(p * (1 - p), 1e-6); }
      else g[r] = Fm[r] - y[r];
    }
    const t = buildTree(bins.B, trainIdx, g, h, opt, bins.edges);
    trees.push(t);
    for (const r of trainIdx) Fm[r] += walkBin(t, bins.B, r);
    let vl = 0;
    for (const r of valIdx) {
      Fm[r] += walkBin(t, bins.B, r);
      if (loss === "log") { const p = Math.min(1 - 1e-7, Math.max(1e-7, sigmoid(Fm[r]))); vl -= y[r] * Math.log(p) + (1 - y[r]) * Math.log(1 - p); }
      else vl += (Fm[r] - y[r]) ** 2;
    }
    if (vl < bestLoss - 1e-9) { bestLoss = vl; bestK = k + 1; }
    if (onTree) onTree(k);
    if (k + 1 - bestK >= opt.patience) break;
  }
  return { base, loss, trees: trees.slice(0, bestK) };
}
function predictGBM(m, x, o) {
  if ("constant" in m) return m.constant;
  let z = m.base; for (const t of m.trees) z += walkRaw(t, x, o);
  return m.loss === "log" ? sigmoid(z) : z;
}

function splitByTime(idxList, issue, frac = 0.15) {
  const sorted = [...idxList].sort((a, b) => issue[a] - issue[b]);
  const cut = Math.floor(sorted.length * (1 - frac));
  return [sorted.slice(0, cut), sorted.slice(cut)];
}
const bucketOf = L => BUCKETS.findIndex(([lo, hi]) => L >= lo && L <= hi);

/* ---------- train ---------- */
function train(obs, oni) {
  const n = obs.dates.length;
  if (n < 3 * 365) throw new Error("Not enough history to learn from.");
  progress("Fitting the seasonal cycle and climate trend", 0.02);
  const clim = fitClim(obs.dates, obs.tmax, obs.tmin);
  const f = issueFeatures(obs, clim, oni);
  progress("Building training examples", 0.05);
  const data = trainingSet(obs, f);
  const bins = makeBins(data.X, data.N);
  const all = Array.from({ length: data.N }, (_, i) => i);

  // 1) Honest backtest: learn from everything before the last 3 years, forecast those 3 years.
  const cutIssue = n - 3 * 365 - HORIZON;
  const tr = all.filter(r => data.issue[r] <= cutIssue), te = all.filter(r => data.issue[r] > cutIssue + HORIZON);
  const skill = BUCKETS.map(() => ({ ai: 0, norm: 0, n: 0 }));
  const stages = 5; let stage = 0;
  const tick = label => k => progress(label, 0.08 + 0.9 * (stage + Math.min(k / 80, 1)) / stages);
  if (tr.length > 5000 && te.length > 500) {
    const [a, b] = splitByTime(tr, data.issue);
    const mv = fitGBM(data, data.yx, a, b, "l2", bins, tick("Backtesting on the last 3 years"));
    for (const r of te) {
      const p = predictGBM(mv, data.X, r * F), k = bucketOf(data.lead[r]);
      skill[k].ai += Math.abs(p - data.yx[r]); skill[k].norm += Math.abs(data.yx[r]); skill[k].n++;
    }
  }
  stage++;
  const skillOut = BUCKETS.map(([lo, hi], k) => skill[k].n
    ? { bucket: `${lo}-${hi}`, ai: skill[k].ai / skill[k].n, norm: skill[k].norm / skill[k].n, n: skill[k].n }
    : { bucket: `${lo}-${hi}`, ai: null, norm: null, n: 0 });

  // 2) Final models on everything.
  const [a, b] = splitByTime(all, data.issue);
  const models = {};
  models.tmax = fitGBM(data, data.yx, a, b, "l2", bins, tick("Learning daily highs")); stage++;
  models.tmin = fitGBM(data, data.yn, a, b, "l2", bins, tick("Learning daily lows")); stage++;
  models.snow = fitGBM(data, data.ys, a, b, "log", bins, tick("Learning when it snows")); stage++;
  models.rain = fitGBM(data, data.yr, a, b, "log", bins, tick("Learning when it rains")); stage++;

  let snowDays = 0, lastSnow = null;
  for (let i = 0; i < n; i++) if (obs.snow[i] >= SNOW_CM) { snowDays++; lastSnow = obs.dates[i]; }
  return {
    version: 2, clim, models, skill: skillOut, examples: data.N, trainedThrough: obs.dates[n - 1],
    years: +(n / YEAR).toFixed(1), snowDays, lastSnow,
  };
}

/* ---------- predict the next 366 days ---------- */
function predict(model, obs, oni) {
  const n = obs.dates.length, f = issueFeatures(obs, model.clim, oni), i = n - 1, issueDate = obs.dates[i];
  const x = new Float32Array(F), rows = [];
  for (let L = 1; L <= HORIZON; L++) {
    const iso = addDays(issueDate, L);
    fillRow(x, 0, f, i, iso, L);
    const k = bucketOf(L), s = model.skill[k];
    // Trust the AI's departure from normal only as far as its backtest earned.
    let trust = 1;
    if (s && s.n) trust = Math.min(1, Math.max(0.3, 0.3 + 10 * (s.norm - s.ai) / s.norm));
    const sigma = s && s.n ? 1.25 * Math.min(s.ai, s.norm) : 3;
    const [nx, nn] = normals(model.clim, iso);
    const ax = predictGBM(model.models.tmax, x, 0) * trust, an = predictGBM(model.models.tmin, x, 0) * trust;
    const hi = nx + ax, lo = Math.min(nn + an, hi - 0.5);
    rows.push({
      date: iso, lead: L, tmax: hi, tmin: lo, hiLo: hi - 1.28 * sigma, hiHi: hi + 1.28 * sigma,
      normHi: nx, normLo: nn,
      pSnow: predictGBM(model.models.snow, x, 0), pRain: predictGBM(model.models.rain, x, 0), source: "AI",
    });
  }
  return { issueDate, rows };
}

function progress(label, frac) { self.postMessage({ type: "progress", label, frac }); }

self.onmessage = (e) => {
  const { id, cmd, obs, oni, model } = e.data;
  try {
    if (cmd === "train") self.postMessage({ id, ok: true, model: train(obs, oni) });
    else if (cmd === "predict") self.postMessage({ id, ok: true, result: predict(model, obs, oni) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
