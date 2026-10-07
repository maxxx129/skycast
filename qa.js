/* Plain English questions in, plain English answers out. */
"use strict";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON3 = MONTHS.map(m => m.slice(0, 3));

function units(city, force) {
  const imperial = force ? force === "f" : ["US", "LR", "MM", "BS", "BZ", "KY", "PW"].includes(city.cc);
  return {
    imperial,
    t: c => imperial ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`,
    dt: c => imperial ? `${Math.round(Math.abs(c) * 9 / 5)}°F` : `${Math.round(Math.abs(c))}°C`,
    conv: c => imperial ? c * 9 / 5 + 32 : c,
  };
}

const D = iso => new Date(iso + "T12:00:00Z");
const fmtDay = iso => D(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
function fmtRange(a, b) {
  const A = D(a), B = D(b), m = d => d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return A.getUTCMonth() === B.getUTCMonth() ? `${m(A)} ${A.getUTCDate()} to ${B.getUTCDate()}` : `${m(A)} ${A.getUTCDate()} to ${m(B)} ${B.getUTCDate()}`;
}
const pct = p => (p *= 100, p < 5 ? "under 5%" : `${Math.round(p / 5) * 5}%`);
function confidence(lead) {
  if (lead <= 7) return "high confidence";
  if (lead <= 16) return "moderate confidence";
  if (lead <= 45) return "low confidence, trend level only";
  return "seasonal outlook, so think of it as a likely window rather than a set date";
}
const place = c => c.cc === "US" && c.admin1 ? `${c.name}, ${c.admin1}` : [c.name, c.country].filter(Boolean).join(", ");

/* ---------- parsing ---------- */
function parseIntent(q) {
  const s = q.toLowerCase();
  if (/\bsnow|blizzard|flurr/.test(s)) return "snow";
  if (/freez|frost/.test(s)) return "freeze";
  if (/\b(colder|cooler|cool down|cold snap|get cold|winter come|chilly|cool off)/.test(s)) return "colder";
  if (/\b(warmer|warm up|heat up|get hot|hotter|heat wave|summer come|spring come)/.test(s)) return "warmer";
  if (/\b(rain|shower|storm|wet|umbrella|drizzle|precip)/.test(s)) return "rain";
  if (/how (cold|hot|warm)|temperature|degrees/.test(s)) return "temp";
  return "general";
}

const TIME = "(?:today|tonight|tomorrow|this|next|on|in|during|by|over|around|for|before|after|soon|ever|at all|anytime)";
function parseCity(q) {
  const s = q.replace(/[?!]/g, "").trim();
  const monthRe = new RegExp(`^(?:${MONTHS.join("|")}|${MON3.join("|")})\\.?(?:\\s+\\d+)?$`, "i");
  const re = new RegExp(`\\b(?:in|for|at)\\s+(.+?)(?=\\s+${TIME}\\b|$)`, "gi");
  let m;
  while ((m = re.exec(s))) {
    let c = m[1].trim().replace(/^the\s+/i, "").replace(/[.,]+$/, "");
    if (!c || monthRe.test(c) || /^(next|this|coming)\b/i.test(c) || /^\d/.test(c)) continue;
    return c;
  }
  m = s.match(/\b(?:will|does|is|did)\s+([A-Z][\w .'-]*?)\s+(?:get|be|see|have|reach)\b/);
  if (m) return m[1].trim();
  m = s.match(/^([A-Z][\w .,'-]*?)\s+(?:weather|forecast|outlook)\b/);
  return m ? m[1].replace(/[ ,]+$/, "") : null;
}

function thanksgiving(y) { const d = new Date(Date.UTC(y, 10, 1)); const thu = 1 + (4 - d.getUTCDay() + 7) % 7 + 21; return `${y}-11-${String(thu).padStart(2, "0")}`; }
function parseWindow(q, today) {
  const s = q.toLowerCase(), wd = D(today).getUTCDay(), y = +today.slice(0, 4);
  const iso = (Y, M, d) => `${Y}-${String(M).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const nextOcc = (M, d) => { let v = iso(y, M, d); return v < today ? iso(y + 1, M, d) : v; };
  if (/tomorrow/.test(s)) { const d = addDays(today, 1); return [d, d, "tomorrow"]; }
  if (/\btoday|tonight\b/.test(s)) return [today, today, "today"];
  if (/weekend/.test(s)) { let sat = addDays(today, (6 - wd + 7) % 7); if (wd === 0) sat = addDays(today, -1);
    if (/next weekend/.test(s)) sat = addDays(sat, 7); return [sat < today ? today : sat, addDays(sat, 1), /next/.test(s) ? "next weekend" : "this weekend"]; }
  if (/next week/.test(s)) { const mon = addDays(today, ((8 - wd) % 7) || 7); return [mon, addDays(mon, 6), "next week"]; }
  if (/this week/.test(s)) return [today, addDays(today, (7 - wd) % 7), "this week"];
  let m = s.match(/next (\d+) days/); if (m) return [today, addDays(today, +m[1] - 1), `the next ${m[1]} days`];
  if (/next month/.test(s)) { const M = +today.slice(5, 7) % 12 + 1, Y = M === 1 ? y + 1 : y, end = new Date(Date.UTC(Y, M, 0)).getUTCDate();
    return [iso(Y, M, 1), iso(Y, M, end), MONTHS[M - 1][0].toUpperCase() + MONTHS[M - 1].slice(1)]; }
  const hol = { christmas: [12, 25], "new year": [1, 1], halloween: [10, 31], valentine: [2, 14], "july 4": [7, 4], "fourth of july": [7, 4] };
  for (const [k, v] of Object.entries(hol)) if (s.includes(k)) { const d = nextOcc(...v); return [d, d, k.replace(/\b\w/g, c => c.toUpperCase())]; }
  if (s.includes("thanksgiving")) { let d = thanksgiving(y); if (d < today) d = thanksgiving(y + 1); return [d, d, "Thanksgiving"]; }
  m = s.match(new RegExp(`\\b(${MON3.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (m) { const M = MON3.indexOf(m[1]) + 1, dd = +m[2]; if (dd >= 1 && dd <= 31) { const d = nextOcc(M, dd); return [d, d, fmtDay(d)]; } }
  m = s.match(new RegExp(`\\b(${MONTHS.join("|")})\\b`));
  if (m) { const M = MONTHS.indexOf(m[1]) + 1, Y = M >= +today.slice(5, 7) ? y : y + 1, end = new Date(Date.UTC(Y, M, 0)).getUTCDate();
    const st = iso(Y, M, 1); return [st < today ? today : st, iso(Y, M, end), m[1][0].toUpperCase() + m[1].slice(1)]; }
  return null;
}

/* ---------- reasoning helpers ---------- */
function chanceAny(ps, block = 3) { // storms span days: group into 3 day blocks
  const out = new Array(ps.length); let survive = 1;
  for (let i = 0; i < ps.length; i += block) {
    let mx = 0;
    for (let j = i; j < Math.min(i + block, ps.length); j++) { mx = Math.max(mx, ps[j]); out[j] = 1 - survive * (1 - mx); }
    survive *= 1 - mx;
  }
  return out;
}
function smooth(rows, key, w = 7) {
  return rows.map((_, i) => { let s = 0, n = 0; for (let k = i - (w >> 1); k <= i + (w >> 1); k++) if (rows[k]) { s += rows[k][key]; n++; } return s / n; });
}
const inWin = (rows, w) => w ? rows.filter(r => r.date >= w[0] && r.date <= w[1]) : rows;
const argmax = a => a.reduce((b, v, i) => v > a[b] ? i : b, 0);
const argmin = a => a.reduce((b, v, i) => v < a[b] ? i : b, 0);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/* ---------- answers ---------- */
function answerSnow(o, u, win) {
  const P = place(o.city), rows = inWin(o.rows, win);
  if (!rows.length) return `That's beyond my one year outlook for ${P}.`;
  const ps = rows.map(r => r.pSnow), cum = chanceAny(ps), peak = rows[argmax(ps)];
  const exp = ps.reduce((a, b) => a + b, 0), when = win ? ` ${win[2]}` : " in the next 12 months";
  const { snowDays, lastSnow, years } = o.model;
  if (cum[cum.length - 1] < 0.1) {
    if (!snowDays) return `Snow is very unlikely in ${P}${when}. There hasn't been a measurable snow day there in the ${Math.round(years)} years of records I learned from.`;
    const last = D(lastSnow).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    return `Snow is unlikely in ${P}${when} (about ${pct(cum[cum.length - 1])} chance of any). It's rare there: ${plural(snowDays, "snow day")} in ${Math.round(years)} years, most recently ${last}.`;
  }
  if (win) {
    let t = `${P}${when}: about ${pct(cum[cum.length - 1])} chance of at least one snow day. The best chance is ${fmtDay(peak.date)} (${pct(peak.pSnow)})`;
    if (exp >= 1) t += `, and I expect about ${plural(Math.round(exp), "snow day")} in that stretch`;
    return t + `. (${confidence(peak.lead)})`;
  }
  const parts = [], near = rows.find(r => r.lead <= 16 && r.pSnow >= 0.3);
  if (near) parts.push(`Snow is already in the near term picture: ${fmtDay(near.date)} has about a ${pct(near.pSnow)} chance (${confidence(near.lead)}).`);
  const i50 = cum.findIndex(c => c >= 0.5), i80 = cum.findIndex(c => c >= 0.8);
  if (i50 >= 0) {
    let t = `The first snow most likely arrives around ${fmtDay(rows[i50].date)}`;
    if (i80 > i50) t += `, and I'm 80% confident it will have snowed by ${fmtDay(rows[i80].date)}`;
    parts.push(t + ` (${confidence(rows[i50].lead)}).`);
  } else parts.push(`There's about a ${pct(cum[cum.length - 1])} chance of any snow in the next 12 months.`);
  let best = 0, bi = 13;
  for (let i = 13; i < rows.length; i++) { let s = 0; for (let k = i - 13; k <= i; k++) s += rows[k].pSnow; if (s > best) { best = s; bi = i; } }
  parts.push(`The snowiest stretch looks like ${fmtRange(rows[bi - 13].date, rows[bi].date)}` + (best >= 1 ? `, with about ${plural(Math.round(best), "snow day")} in those two weeks.` : "."));
  if (exp >= 1) parts.push(`In total I expect around ${Math.round(exp)} snow days over the coming year.`);
  return parts.join(" ");
}

function answerTrend(o, u, warmer) {
  const P = place(o.city), rows = o.rows, n = o.obs.tmax.length;
  let now = 0; for (let i = n - 7; i < n; i++) now += o.obs.tmax[i]; now /= 7;
  const sm = smooth(rows, "tmax"), smLo = smooth(rows, "tmin"), sign = warmer ? 1 : -1;
  const parts = [`Highs in ${P} have averaged ${u.t(now)} over the past week.`];
  let bj = -1, bjv = 0;
  for (let i = 1; i < rows.length && rows[i].lead <= 10; i++) { const d = rows[i].tmax - rows[i - 1].tmax; if (sign * d > sign * bjv) { bjv = d; bj = i; } }
  if (bj > 0 && Math.abs(bjv) >= 4)
    parts.push(`The next noticeable ${warmer ? "warm up" : "cool down"}: highs ${warmer ? "jump" : "drop"} about ${u.dt(bjv)} to around ${u.t(rows[bj].tmax)} on ${fmtDay(rows[bj].date)}.`);
  const k = sm.findIndex(v => sign * (v - now) >= 3);
  if (k >= 0) parts.push(`It turns consistently ${warmer ? "warmer" : "colder"}, with weekly average highs ${u.dt(3)} or more ${warmer ? "above" : "below"} now, starting around ${fmtDay(rows[k].date)} (${confidence(rows[k].lead)}).`);
  for (const m of warmer ? [20, 25, 30] : [15.5, 10, 4.5, 0]) {
    if (warmer ? now >= m : now <= m) continue;
    const i = sm.findIndex(v => warmer ? v >= m : v <= m);
    if (i >= 0) parts.push(`Weekly average highs ${warmer ? "climb" : "fall"} to ${u.t(m)} around ${fmtDay(rows[i].date)}.`);
  }
  const e = warmer ? argmax(sm) : argmin(sm);
  parts.push(`The ${warmer ? "hottest" : "coldest"} week of the coming year looks like the one around ${fmtDay(rows[e].date)}, with highs near ${u.t(sm[e])} and lows near ${u.t(smLo[e])}.`);
  return parts.join(" ");
}

function answerFreeze(o, u) {
  const P = place(o.city), f = o.rows.find(r => r.tmin <= 0);
  if (!f) { const c = o.rows[argmin(o.rows.map(r => r.tmin))]; return `I don't expect a freeze in ${P} over the next year. The coldest nights bottom out near ${u.t(c.tmin)} around ${fmtDay(c.date)}.`; }
  const hard = o.rows.find(r => r.tmin <= -4.5);
  let t = `The first freeze in ${P} (a low of ${u.t(0)} or colder) is expected around ${fmtDay(f.date)} (${confidence(f.lead)}).`;
  if (hard) t += ` A hard freeze, below ${u.t(-4.5)}, becomes likely around ${fmtDay(hard.date)}.`;
  return t;
}

function answerRain(o, u, win) {
  const P = place(o.city), rows = inWin(o.rows, win);
  if (!rows.length) return `That's beyond my one year outlook for ${P}.`;
  if (win) {
    const best = rows[argmax(rows.map(r => r.pRain))];
    if (rows.length <= 10) return `Chance of rain in ${P} ${win[2]}: ` + rows.map(r => `${fmtDay(r.date)} ${pct(r.pRain)}`).join("; ") + `. (${confidence(best.lead)})`;
    return `${win[2]} in ${P}: about ${Math.round(rows.reduce((s, r) => s + r.pRain, 0))} wet days expected out of ${rows.length}; the wettest looking day is ${fmtDay(best.date)} (${pct(best.pRain)}).`;
  }
  const parts = [], soon = rows.find(r => r.pRain >= 0.5 && r.lead <= 16), cum = chanceAny(rows.map(r => r.pRain));
  if (soon) parts.push(`The next rain in ${P} looks like ${fmtDay(soon.date)} (${pct(soon.pRain)} chance, ${confidence(soon.lead)}).`);
  else { const i = cum.findIndex(c => c >= 0.5);
    parts.push(i >= 0 ? `No rain is clearly signaled soon in ${P}; the next rain most likely comes by around ${fmtDay(rows[i].date)} (${confidence(rows[i].lead)}).` : `Rain is unlikely in ${P} for a long stretch ahead.`); }
  const wet = rows.filter(r => r.lead <= 14 && r.pRain >= 0.35).slice(0, 6);
  if (wet.length) parts.push("Rain chances in the next two weeks: " + wet.map(r => `${fmtDay(r.date)} ${pct(r.pRain)}`).join("; ") + ".");
  let best = 0, bi = 29;
  for (let i = 29; i < rows.length; i++) { let s = 0; for (let k = i - 29; k <= i; k++) s += rows[k].pRain; if (s > best) { best = s; bi = i; } }
  parts.push(`The wettest month ahead looks like ${fmtRange(rows[bi - 29].date, rows[bi].date)}, with about ${Math.round(best)} wet days.`);
  return parts.join(" ");
}

function answerWindow(o, u, win) {
  const P = place(o.city), rows = inWin(o.rows, win);
  if (!rows.length) return `That's beyond my one year outlook for ${P}.`;
  if (rows.length <= 3) {
    const lines = rows.map(r => {
      const x = []; if (r.pRain >= 0.3) x.push(`${pct(r.pRain)} chance of rain`); if (r.pSnow >= 0.15) x.push(`${pct(r.pSnow)} chance of snow`);
      return `${fmtDay(r.date)}: high ${u.t(r.tmax)}, low ${u.t(r.tmin)}, ${x.length ? x.join(", ") : "mostly dry"}`;
    });
    const label = rows.length === 1 && win[2] === fmtDay(rows[0].date) ? "" : `, ${win[2]}`;
    return `${P}${label}: ${lines.join("; ")}. (${confidence(rows[0].lead)})`;
  }
  const avg = k => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  const hi = avg("tmax"), lo = avg("tmin"), diff = hi - avg("normHi");
  const vs = Math.abs(diff) < 0.8 ? "near normal" : `${u.dt(diff)} ${diff > 0 ? "warmer" : "colder"} than normal`;
  const w = rows[argmax(rows.map(r => r.tmax))], c = rows[argmin(rows.map(r => r.tmin))];
  const sn = rows.reduce((s, r) => s + r.pSnow, 0), rn = rows.reduce((s, r) => s + r.pRain, 0);
  return `${P}, ${win[2]}: average high around ${u.t(hi)} and low around ${u.t(lo)}, ${vs}. Warmest around ${fmtDay(w.date)} at ${u.t(w.tmax)}, coldest night around ${fmtDay(c.date)} at ${u.t(c.tmin)}. ` +
    `Expect about ${plural(Math.round(rn), "wet day")}` + (sn >= 0.5 ? ` and ${plural(Math.round(sn), "snow day")}` : "") + `. (${confidence(rows[0].lead)})`;
}

function answerGeneral(o, u) {
  return `Next 7 days in ${place(o.city)}: ` + o.rows.slice(0, 7).map(r => {
    const tag = r.pSnow >= 0.3 ? `, snow ${pct(r.pSnow)}` : r.pRain >= 0.3 ? `, rain ${pct(r.pRain)}` : "";
    return `${fmtDay(r.date)} ${u.t(r.tmax)} / ${u.t(r.tmin)}${tag}`;
  }).join("; ") + ".";
}

function answer(question, o, forceUnits) {
  const u = units(o.city, forceUnits), intent = parseIntent(question), win = parseWindow(question, o.today);
  let text;
  if (win && win[0] > o.rows[o.rows.length - 1].date) text = "That's further out than my one year outlook.";
  else if (intent === "snow") text = answerSnow(o, u, win);
  else if (intent === "colder" || intent === "warmer") text = win ? answerWindow(o, u, win) : answerTrend(o, u, intent === "warmer");
  else if (intent === "freeze") text = answerFreeze(o, u);
  else if (intent === "rain") text = answerRain(o, u, win);
  else if (win) text = answerWindow(o, u, win);
  else text = answerGeneral(o, u);
  return { text, u };
}
