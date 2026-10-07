/* SkyCast AI: website logic. Crawls live data in the browser, trains/loads the model in a worker,
   blends live forecasts, corrects itself from its own track record, and answers questions. */
"use strict";

const SRC = {
  geo: "https://geocoding-api.open-meteo.com/v1/search",
  archive: "https://archive-api.open-meteo.com/v1/archive",
  forecast: "https://api.open-meteo.com/v1/forecast",
  oniLocal: "oni.json",
  oniNoaa: "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt",
};
const VARS = "temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum";
const HISTORY_START = "1980-01-01";
const SNOW_CM = 0.5, WET_MM = 1.0;
const BUCKETS = [[1, 3], [4, 7], [8, 16], [17, 45], [46, 120], [121, 366]];
const DAY = 864e5;

/* ---------- small helpers ---------- */
const addDays = (iso, k) => new Date(Date.parse(iso + "T00:00:00Z") + k * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("skycast", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("cities");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction("cities", mode), req = fn(t.objectStore("cities"));
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); };
  return {
    get: k => tx("readonly", s => s.get(k)).catch(() => null),
    set: (k, v) => tx("readwrite", s => s.put(v, k)).catch(() => null),
  };
})();

async function getJSON(url, params, tries = 3) {
  const u = url + "?" + new URLSearchParams(params);
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u);
      if (r.status === 429) { await new Promise(s => setTimeout(s, 3000 * (i + 1))); continue; }
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) { last = e; await new Promise(s => setTimeout(s, 1000 * (i + 1))); }
  }
  throw new Error("Couldn't reach the weather data service (" + (last && last.message) + "). Try again in a minute.");
}

/* ---------- crawlers ---------- */
const US_STATES = { al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
  ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois",
  in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland",
  ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana",
  ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york",
  nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania",
  ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah",
  vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
  dc: "district of columbia" };

async function geocode(query) {
  const parts = query.split(",").map(s => s.trim()).filter(Boolean);
  let qual = parts[1] ? parts[1].toLowerCase() : null;
  if (qual && US_STATES[qual]) qual = US_STATES[qual];
  const j = await getJSON(SRC.geo, { name: parts[0], count: 10, language: "en", format: "json" });
  let res = j.results || [];
  if (!res.length) throw new Error(`I couldn't find a place called "${query}". Try adding the state or country.`);
  if (qual) {
    const f = res.filter(r => [r.admin1, r.country, r.country_code].some(v => (v || "").toLowerCase().includes(qual)));
    if (f.length) res = f;
  }
  const b = res[0];
  return { name: b.name, admin1: b.admin1 || "", country: b.country || "", cc: b.country_code || "",
    lat: b.latitude, lon: b.longitude };
}

function daily(j) {
  const d = j.daily;
  return d.time.map((t, i) => ({ date: t, tmax: d.temperature_2m_max[i], tmin: d.temperature_2m_min[i],
    precip: d.precipitation_sum[i], snow: d.snowfall_sum[i], pop: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null }));
}

async function fetchHistory(lat, lon, end) {
  const chunks = [];
  for (let y = +HISTORY_START.slice(0, 4); y <= +end.slice(0, 4); y += 16) {
    const s = y === +HISTORY_START.slice(0, 4) ? HISTORY_START : `${y}-01-01`;
    const e = `${y + 15}-12-31` < end ? `${y + 15}-12-31` : end;
    chunks.push(getJSON(SRC.archive, { latitude: lat, longitude: lon, start_date: s, end_date: e, daily: VARS, timezone: "auto" }));
  }
  const parts = await Promise.all(chunks);
  return parts.flatMap(daily).filter(r => r.tmax != null && r.tmin != null);
}

async function fetchLive(lat, lon) {
  const j = await getJSON(SRC.forecast, { latitude: lat, longitude: lon, daily: VARS + ",precipitation_probability_max",
    past_days: 92, forecast_days: 16, timezone: "auto" });
  const today = new Date(Date.now() + (j.utc_offset_seconds || 0) * 1000).toISOString().slice(0, 10);
  const rows = daily(j);
  return { today, recent: rows.filter(r => r.date < today && r.tmax != null), forecast: rows.filter(r => r.date >= today) };
}

async function loadOni() {
  const cached = ls.get("oni");
  if (cached && Date.now() - cached.at < 7 * DAY && cached.data.length) return cached.data;
  let data = [];
  try { const r = await fetch(SRC.oniLocal, { cache: "no-cache" }); if (r.ok) data = await r.json(); } catch { /* fall through */ }
  if (!data.length) {
    try { // NOAA directly (works when the browser allows it)
      const txt = await (await fetch(SRC.oniNoaa)).text();
      const S = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"];
      for (const line of txt.split("\n")) { const p = line.trim().split(/\s+/);
        if (p.length === 4 && S.includes(p[0])) data.push({ year: +p[1], month: S.indexOf(p[0]) + 1, oni: +p[3] }); }
    } catch { /* model works without it */ }
  }
  if (data.length) ls.set("oni", { at: Date.now(), data });
  return data;
}

/* ---------- worker ---------- */
const worker = new Worker("model.js");
let jobId = 0; const jobs = new Map();
worker.onmessage = e => {
  const m = e.data;
  if (m.type === "progress") return onProgress(m.label, m.frac);
  const j = jobs.get(m.id); jobs.delete(m.id);
  m.ok ? j.res(m) : j.rej(new Error(m.error));
};
const runWorker = msg => new Promise((res, rej) => { const id = ++jobId; jobs.set(id, { res, rej }); worker.postMessage({ id, ...msg }); });
let onProgress = () => {};

/* ---------- assemble a complete daily record ---------- */
function buildObs(history, recent) {
  const map = new Map();
  for (const r of history) map.set(r.date, r);
  for (const r of recent) if (!map.has(r.date)) map.set(r.date, r); // reanalysis wins where both exist
  const keys = [...map.keys()].sort();
  const start = keys[0], end = keys[keys.length - 1], n = daysBetween(start, end) + 1;
  const o = { dates: new Array(n), tmax: new Float64Array(n), tmin: new Float64Array(n), precip: new Float64Array(n), snow: new Float64Array(n) };
  const tx = new Array(n), tn = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = addDays(start, i), r = map.get(d); o.dates[i] = d;
    tx[i] = r ? r.tmax : null; tn[i] = r ? r.tmin : null;
    o.precip[i] = r && r.precip != null ? r.precip : 0; o.snow[i] = r && r.snow != null ? r.snow : 0;
  }
  const fill = (src, dst) => { // linear interpolation over gaps, edges held
    let prev = -1;
    for (let i = 0; i < n; i++) if (src[i] != null) {
      if (prev < 0) for (let k = 0; k < i; k++) dst[k] = src[i];
      else for (let k = prev + 1; k < i; k++) dst[k] = src[prev] + (src[i] - src[prev]) * (k - prev) / (i - prev);
      dst[i] = src[i]; prev = i;
    }
    for (let k = prev + 1; k < n; k++) dst[k] = src[prev];
  };
  fill(tx, o.tmax); fill(tn, o.tmin);
  return o;
}

/* ---------- live blend + self correction ---------- */
function blendLive(rows, forecast) {
  if (!forecast.length) return;
  const byDate = new Map(forecast.map(r => [r.date, r])), first = forecast[0].date;
  for (const r of rows) {
    const f = byDate.get(r.date); if (!f) continue;
    const k = daysBetween(first, r.date), w = k <= 6 ? 0.9 : Math.max(0.35, 0.9 - 0.06 * (k - 6));
    if (f.tmax != null && f.tmin != null) {
      r.tmax = w * f.tmax + (1 - w) * r.tmax; r.tmin = w * f.tmin + (1 - w) * r.tmin;
      const spread = Math.max(1.5 + 0.35 * k, k > 10 ? (r.hiHi - r.hiLo) / 2 : 0);
      r.hiLo = r.tmax - spread; r.hiHi = r.tmax + spread;
    }
    if (f.snow != null) { const p = f.snow >= SNOW_CM ? 0.85 : f.snow > 0 ? 0.35 : 0.02; r.pSnow = w * p + (1 - w) * r.pSnow; }
    const pr = f.pop != null ? f.pop / 100 : f.precip != null ? (f.precip >= WET_MM ? 0.8 : 0.1) : null;
    if (pr != null) r.pRain = w * pr + (1 - w) * r.pRain;
    r.source = "live models + AI";
  }
}

function selfCorrect(slug, rows, obs, issueDate) {
  const key = "log:" + slug, log = ls.get(key) || {};
  const at = new Map(obs.dates.map((d, i) => [d, i]));
  const errs = BUCKETS.map(() => ({ x: 0, n: 0, abs: 0, cnt: 0 }));
  const since = addDays(issueDate, -120);
  for (const [iss, rec] of Object.entries(log)) {
    for (let L = 1; L <= rec.t.length; L++) {
      const d = addDays(iss, L); if (d < since) continue;
      const i = at.get(d); if (i === undefined || d > issueDate) continue;
      const k = BUCKETS.findIndex(([lo, hi]) => L >= lo && L <= hi), e = errs[k];
      e.x += rec.t[L - 1] - obs.tmax[i]; e.n += rec.n[L - 1] - obs.tmin[i]; e.abs += Math.abs(rec.t[L - 1] - obs.tmax[i]); e.cnt++;
    }
  }
  const corr = errs.map(e => {
    if (e.cnt < 10) return null;
    const s = e.cnt / (e.cnt + 30), clip = v => Math.max(-3, Math.min(3, v));
    return { tx: clip(-e.x / e.cnt * s), tn: clip(-e.n / e.cnt * s), n: e.cnt, mae: e.abs / e.cnt };
  });
  for (const r of rows) {
    const c = corr[BUCKETS.findIndex(([lo, hi]) => r.lead >= lo && r.lead <= hi)];
    if (c) { r.tmax += c.tx; r.hiLo += c.tx; r.hiHi += c.tx; r.tmin += c.tn; }
  }
  // Log today's outlook so future visits can grade it.
  log[issueDate] = { t: rows.map(r => +r.tmax.toFixed(1)), n: rows.map(r => +r.tmin.toFixed(1)) };
  const keys = Object.keys(log).sort(); while (keys.length > 30) delete log[keys.shift()];
  ls.set(key, log);
  return { checks: corr.reduce((s, c) => s + (c ? c.n : 0), 0), corr };
}

/* ---------- the pipeline for one city ---------- */
const memo = new Map();
async function getOutlook(query, status) {
  const qkey = query.toLowerCase().trim();
  let city = ls.get("alias:" + qkey);
  if (!city) { status(`Looking up ${query}`); city = await geocode(query); ls.set("alias:" + qkey, city); }
  const slug = [city.name, city.admin1, city.cc].join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const hit = memo.get(slug);
  if (hit && Date.now() - hit.at < 3600e3) return hit.value;

  const cached = (await idb.get(slug)) || {};
  status(`Getting the latest observations and live forecast for ${city.name}`);
  const [live, oni] = await Promise.all([fetchLive(city.lat, city.lon), loadOni()]);
  let history = cached.history;
  if (!history || Date.now() - (cached.histAt || 0) > 7 * DAY) {
    status(`Downloading ${new Date().getFullYear() - 1980} years of daily weather history for ${city.name}`);
    history = await fetchHistory(city.lat, city.lon, addDays(live.today, -6));
    cached.history = history; cached.histAt = Date.now();
  }
  const obs = buildObs(history, live.recent);

  let model = cached.model;
  if (!model || model.version !== 2 || Date.now() - (cached.modelAt || 0) > DAY) {
    onProgress = (label, frac) => status(`Training the AI for ${city.name} in your browser: ${label.toLowerCase()}`, frac);
    model = (await runWorker({ cmd: "train", obs, oni })).model;
    cached.model = model; cached.modelAt = Date.now();
  }
  idb.set(slug, cached);

  status("Forecasting the next 12 months");
  const { issueDate, rows } = (await runWorker({ cmd: "predict", obs, oni, model })).result;
  blendLive(rows, live.forecast);
  const sc = selfCorrect(slug, rows, obs, issueDate);
  for (const r of rows) { r.pSnow = Math.min(1, Math.max(0, r.pSnow)); r.pRain = Math.min(1, Math.max(0, r.pRain)); }
  const out = rows.filter(r => r.date >= live.today);
  const value = { city, slug, rows: out, today: live.today, model, obs, oni: oni.length ? oni[oni.length - 1].oni : null,
    checks: sc.checks, lastObs: obs.dates[obs.dates.length - 1] };
  memo.set(slug, { at: Date.now(), value });
  return value;
}
