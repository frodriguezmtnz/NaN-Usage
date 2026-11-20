// ───────────────────────────────────────────────────────────────
// CONFIGURACIÓN
// Endpoints que usa el propio dashboard (no documentados: si cambian, se tocan aquí).
// ───────────────────────────────────────────────────────────────
export const USAGE_URL = "https://cloud-api.nan.builders/api/usage/credits";
// Bloque "Usage breakdown" del dashboard (caché, reparto y gasto diario).
// Si se deja vacía, el panel funciona sin esa parte.
export const BREAKDOWN_URL = "https://cloud-api.nan.builders/api/metrics/usage";

export const PORTAL_URL = "https://cloud.nan.builders/dashboard";
export const BUY_URL = "https://cloud.nan.builders/dashboard?buy=credits";

export const DEFAULT_SETTINGS = {
  pollMinutes: 5,
  thresholdAlerts: true, // avisos al 80 / 90 / 100 % y de ritmo
  spikeEnabled: true,    // alerta de gasto anómalo
  spikeCredits: 50,
  spikeWindow: 15,       // minutos
  theme: "auto",         // auto | light | dark
};

const ALERT_THRESHOLDS = [80, 90, 100];
const EUR_PER_CREDIT = 0.01; // nan_member: 70 € / 7.000 créditos; Premium: 200 € / 20.000
const HISTORY_DAYS = 8;
const DAY = 86_400_000;
const MIN = 60_000;

const PURPLE = "#7c3aed";
const AMBER = "#d97706";
const RED = "#dc2626";
const GRAY = "#525252";

export const COLORS = {
  uncached: "#8b5cf6",
  cached: "#2dd4bf",
  output: "#fbbf24",
  other: "#737373",
};

// ── Ajustes ────────────────────────────────────────────────────
export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

// ── Peticiones ─────────────────────────────────────────────────
// La cookie `nan_session` (HttpOnly, dominio .nan.builders) se adjunta sola
// gracias a credentials: "include" + host_permissions. La extensión nunca la lee.
async function fetchJSON(url) {
  let res;
  try {
    res = await fetch(url, { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    return { state: "error", message: "Sin conexión con NaN Cloud" };
  }
  if (res.status === 401 || res.status === 403) return { state: "auth" };
  if (!res.ok) return { state: "error", message: `Error HTTP ${res.status}` };
  // Si la sesión ha caducado y el servidor redirige al login, llega HTML.
  if (!(res.headers.get("content-type") || "").includes("json")) return { state: "auth" };
  try {
    return { state: "ok", data: await res.json() };
  } catch {
    return { state: "error", message: "Respuesta no válida" };
  }
}

// ── Ciclo principal (lo usan el service worker y el panel) ─────
export async function refresh() {
  const { snapshot: prev = {} } = await chrome.storage.local.get("snapshot");
  const [c, b] = await Promise.all([
    fetchJSON(USAGE_URL),
    BREAKDOWN_URL ? fetchJSON(BREAKDOWN_URL) : Promise.resolve(null),
  ]);

  let snapshot;
  if (c.state === "ok") {
    snapshot = {
      state: "ok",
      data: c.data,
      breakdown: b?.state === "ok" ? b.data : prev.breakdown ?? null,
      breakdownState: b ? b.state : "unset",
      fetchedAt: Date.now(),
    };
  } else {
    snapshot = { ...prev, state: c.state, message: c.message, failedAt: Date.now() };
  }

  await chrome.storage.local.set({ snapshot });
  await updateBadge(snapshot);

  if (c.state === "ok") {
    const settings = await getSettings();
    const history = await recordHistory(c.data);
    if (settings.thresholdAlerts) await maybeNotify(c.data);
    if (settings.spikeEnabled) await checkSpike(history, settings);
  }
  return snapshot;
}

// ── Historial local (para "última hora" y gasto anómalo) ──────
async function recordHistory(d) {
  const { history = [] } = await chrome.storage.local.get("history");
  const now = Date.now();
  const last = history.at(-1);
  const point = { t: now, used: d.usedCredits || 0, period: d.periodStart };
  if (last && now - last.t < 30_000) history[history.length - 1] = point; // evita duplicados
  else history.push(point);
  const pruned = history.filter((p) => p.t >= now - HISTORY_DAYS * DAY);
  await chrome.storage.local.set({ history: pruned });
  return pruned;
}

/** Créditos gastados en los últimos `minutes` según el historial local. */
export function recentDelta(history = [], minutes, now = Date.now()) {
  const last = history.at(-1);
  if (!last) return null;
  const pts = history.filter((p) => p.period === last.period && p.t >= now - minutes * MIN);
  if (pts.length < 2) return null;
  return { delta: Math.max(last.used - pts[0].used, 0), spanMin: (last.t - pts[0].t) / MIN };
}

/** Gasto por día a partir del historial local (respaldo si no hay breakdown). */
export function dailyFromHistory(history = []) {
  const byDay = new Map();
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1], b = history[i];
    if (a.period !== b.period) continue;
    const day = isoDay(b.t);
    byDay.set(day, (byDay.get(day) || 0) + Math.max(b.used - a.used, 0));
  }
  return byDay;
}

async function checkSpike(history, s) {
  const r = recentDelta(history, s.spikeWindow);
  if (!r || r.delta < s.spikeCredits) return;
  const { lastSpikeAt = 0 } = await chrome.storage.local.get("lastSpikeAt");
  if (Date.now() - lastSpikeAt < s.spikeWindow * 2 * MIN) return; // no repetir en bucle
  chrome.notifications.create(`nan-spike-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Gasto anómalo en NaN",
    message: `${fmt(r.delta)} créditos en los últimos ${Math.max(1, Math.round(r.spanMin))} min. ¿Algún agente en bucle?`,
    priority: 2,
  });
  await chrome.storage.local.set({ lastSpikeAt: Date.now() });
}

// ── Cálculos: créditos ─────────────────────────────────────────
export function summarize(d, now = Date.now()) {
  const start = Date.parse(d.periodStart);
  const end = Date.parse(d.periodEnd);
  const pack = d.packCredits || 0;
  const used = d.usedCredits || 0;
  const remaining = Math.max(d.remainingCredits ?? (d.allowanceCredits || 0) - used, 0) + pack;
  const capacity = used + remaining;
  const usedPct = capacity > 0 ? (used / capacity) * 100 : 0;
  const elapsedPct = clamp(((now - start) / (end - start)) * 100, 0, 100);
  const daysElapsed = Math.max((now - start) / DAY, 0.5);
  const msLeft = Math.max(end - now, 0);
  const daysLeft = msLeft / DAY;
  const perDay = used / daysElapsed;
  const runwayDays = perDay > 0 ? remaining / perDay : Infinity;
  const exhaustsAt = runwayDays < daysLeft ? now + runwayDays * DAY : null;
  const leftoverAtEnd = Math.max(remaining - perDay * daysLeft, 0);

  const active = (d.models || [])
    .filter((m) => m.creditsThisMonth > 0)
    .sort((a, b) => b.creditsThisMonth - a.creditsThisMonth);
  const modelTotal = active.reduce((s, m) => s + m.creditsThisMonth, 0);

  return {
    used, remaining, capacity, pack, usedPct, elapsedPct, perDay,
    daysLeft, msLeft, end, exhaustsAt, leftoverAtEnd,
    status: d.frozen ? "frozen" : d.enabled === false ? "disabled" : d.frontierPaused ? "frontierPaused" : "ok",
    models: active.map((m) => {
      // Coste real por millón de tokens frente a la tarifa aproximada del modelo.
      const eff = m.tokensThisMonth > 0 ? (m.creditsThisMonth / m.tokensThisMonth) * 1e6 : null;
      const list = m.approxCreditsPerMTokens || null;
      return {
        ...m,
        share: modelTotal ? (m.creditsThisMonth / modelTotal) * 100 : 0,
        effPerM: eff,
        listPerM: list,
        vsList: eff != null && list ? eff / list - 1 : null, // -0,57 = 57 % más barato
        enoughData: m.tokensThisMonth >= 1e6,
      };
    }),
    cacheSaved: d.cacheSavedCredits || 0,
    cacheSavedEur: (d.cacheSavedCredits || 0) * EUR_PER_CREDIT,
    cacheSince: d.cacheSavedSince ? Date.parse(d.cacheSavedSince) : null,
    packExpiresAt: d.packExpiresAt ? Date.parse(d.packExpiresAt) : null,
  };
}

// ── Cálculos: breakdown (caché, reparto y diario) ─────────────
export function summarizeSplit(b, range = "last30d") {
  const u = b?.usageSplit;
  const r = u?.[range];
  if (!r) return null;
  const inputAll = r.inputTokens + r.cachedTokens;
  const rows = [
    { key: "uncached", label: "Input sin caché", tokens: r.inputTokens, credits: r.inputCredits },
    { key: "cached", label: "Cacheado", tokens: r.cachedTokens, credits: r.cachedCredits },
    { key: "output", label: "Output", tokens: r.outputTokens, credits: r.outputCredits },
    { key: "other", label: "Otros", sub: "escrituras de caché, imágenes", tokens: null, credits: r.otherCredits || 0 },
  ];
  const totalTokens = inputAll + r.outputTokens;
  const totalCredits = rows.reduce((s, x) => s + x.credits, 0);
  rows.forEach((x) => {
    x.tokenPct = x.tokens != null && totalTokens ? (x.tokens / totalTokens) * 100 : null;
    x.creditPct = totalCredits ? (x.credits / totalCredits) * 100 : 0;
  });

  const byModel = new Map(
    (r.byModel || []).map((m) => {
      const inAll = m.inputTokens + m.cachedTokens;
      return [m.model, { hitRate: inAll ? m.cachedTokens / inAll : null, saved: m.savedCredits || 0 }];
    })
  );

  return {
    since: u.since ? Date.parse(u.since) : null,
    hitRate: inputAll ? r.cachedTokens / inputAll : 0,
    cachedTokens: r.cachedTokens,
    inputAll,
    saved: r.savedCredits || 0,
    savedEur: (r.savedCredits || 0) * EUR_PER_CREDIT,
    rows, totalTokens, totalCredits, byModel,
  };
}

/**
 * Serie diaria de los últimos `days` días (UTC), con créditos por tipo.
 * Usa el breakdown si existe; si no, el historial local.
 */
export function dailySeries(breakdown, history, days = 14, now = Date.now()) {
  const out = [];
  const u = breakdown?.usageSplit;
  const sinceDay = u?.since ? u.since.slice(0, 10) : null;
  const map = new Map();
  if (u?.daily) {
    for (const r of u.daily) {
      const e = map.get(r.date) || { uncached: 0, cached: 0, output: 0, other: 0 };
      e.uncached += r.inputCredits || 0;
      e.cached += r.cachedCredits || 0;
      e.output += r.outputCredits || 0;
      e.other += r.otherCredits || 0;
      map.set(r.date, e);
    }
  }
  const local = u?.daily ? null : dailyFromHistory(history);
  const firstLocal = history?.[0] ? isoDay(history[0].t) : null;

  for (let i = days - 1; i >= 0; i--) {
    const day = isoDay(now - i * DAY);
    let parts = null;
    if (u?.daily) {
      if (!sinceDay || day >= sinceDay) parts = map.get(day) || { uncached: 0, cached: 0, output: 0, other: 0 };
    } else if (firstLocal && day >= firstLocal) {
      parts = { total: local.get(day) || 0 };
    }
    const total = parts ? (parts.total ?? parts.uncached + parts.cached + parts.output + parts.other) : null;
    out.push({ day, parts, total, isToday: i === 0 });
  }
  return { points: out, split: !!u?.daily };
}

// ── Badge y notificaciones ─────────────────────────────────────
export async function updateBadge({ state, data } = {}) {
  if (state === "auth") return setBadge("!", GRAY, "NaN Usage: inicia sesión en cloud.nan.builders");
  if (!data) return setBadge("?", GRAY, "NaN Usage: no se pudo leer el uso");
  const s = summarize(data);
  if (s.status === "frozen") return setBadge("OFF", RED, "NaN Usage: cuenta congelada");
  const left = 100 - s.usedPct;
  const color = left > 20 ? PURPLE : left > 10 ? AMBER : RED;
  const stale = state === "error" ? " (último dato, no se pudo actualizar)" : "";
  return setBadge(fmtCompact(s.remaining), color, `NaN: ${fmt(s.remaining)} créditos disponibles (${Math.round(left)} %)${stale}`);
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  await chrome.action.setTitle({ title });
}

async function maybeNotify(d) {
  const s = summarize(d);
  const key = d.periodStart;
  const { alerts = {} } = await chrome.storage.local.get("alerts");
  const done = new Set(alerts[key] || []);
  const notify = (id, title, message) =>
    chrome.notifications.create(`nan-${key}-${id}`, { type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 1 });

  const crossed = ALERT_THRESHOLDS.filter((t) => s.usedPct >= t && !done.has(t));
  if (crossed.length) {
    const t = Math.max(...crossed);
    notify(
      t,
      t >= 100 ? "Has agotado los créditos de NaN" : `Llevas el ${t} % de tus créditos de NaN`,
      `Te quedan ${fmt(s.remaining)} créditos. El periodo se renueva el ${fmtDateTime(s.end)}.`
    );
    crossed.forEach((t) => done.add(t));
  }
  if (s.exhaustsAt && s.elapsedPct >= 10 && !done.has("pace")) {
    notify("pace", "A este ritmo te quedas sin créditos", `Se agotarían el ${fmtDateTime(s.exhaustsAt)}, antes de la renovación (${fmtDate(s.end)}).`);
    done.add("pace");
  }
  if (d.frozen && !done.has("frozen")) {
    notify("frozen", "Cuenta de NaN congelada", "Revisa el dashboard de NaN Cloud.");
    done.add("frozen");
  }
  await chrome.storage.local.set({ alerts: { [key]: [...done] } }); // solo el periodo actual
}

// ── Formato (es-ES) ────────────────────────────────────────────
const nf0 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0, useGrouping: true });
const nf1 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });
const dateTimeFmt = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const fmt = (n) => nf0.format(n);
export const fmt1 = (n) => nf1.format(n);
export const fmt2 = (n) => nf2.format(n);
export const fmtDate = (t) => dateFmt.format(t).replace(".", "");
export const fmtDateTime = (t) => dateTimeFmt.format(t).replace(".", "");
export const fmtPct = (x, digits = 0) => `${(x * 100).toFixed(digits).replace(".", ",")} %`;

export function fmtCompact(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return (n / 1000).toFixed(1).replace(".", ",") + "k";
  return Math.round(n / 1000) + "k";
}

export function fmtTokens(n) {
  if (n >= 1e9) return fmt1(n / 1e9) + " B";
  if (n >= 1e6) return fmt1(n / 1e6) + " M";
  if (n >= 1e3) return fmt1(n / 1e3) + " k";
  return String(n);
}

/** Tokens en millones, como el dashboard (1.103 M, 23,5 M). */
export function fmtMillions(n) {
  if (n >= 1e8) return fmt(n / 1e6) + " M";
  if (n >= 1e6) return fmt1(n / 1e6) + " M";
  return fmtTokens(n);
}

export function fmtDuration(ms) {
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d} d ${h % 24} h`;
  const m = Math.floor((ms % 3_600_000) / MIN);
  return `${h} h ${m} min`;
}

export function fmtAgo(t, now = Date.now()) {
  const s = Math.round((now - t) / 1000);
  if (s < 60) return "ahora mismo";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

function clamp(n, a, b) {
  return Math.min(Math.max(n, a), b);
}
