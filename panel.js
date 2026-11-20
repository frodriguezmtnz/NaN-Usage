import {
  refresh, summarize, summarizeSplit, dailySeries, recentDelta,
  getSettings, saveSettings, BREAKDOWN_URL, PORTAL_URL, BUY_URL, COLORS,
  fmt, fmt2, fmtPct, fmtCompact, fmtTokens, fmtMillions, fmtDate, fmtDateTime, fmtDuration, fmtAgo,
} from "./lib.js";

const $ = (s) => document.querySelector(s);
const MODELS_COLLAPSED = 5;
const CHART_DAYS = 14;

const ui = { showAllModels: false, cacheRange: "last30d" };
let snap = null;
let history = [];

// Helper para crear nodos sin innerHTML (los nombres de modelo vienen del servidor).
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const open = (url) => chrome.tabs.create({ url });
$("#open").addEventListener("click", () => open(PORTAL_URL));
$("#buy").addEventListener("click", () => open(BUY_URL));
$("#refresh").addEventListener("click", () => load());

// ── Tema (auto / claro / oscuro) ──────────────────────────────
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

async function applyTheme() {
  const { theme } = await getSettings();
  const dark = theme === "dark" || (theme !== "light" && darkQuery.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";  // resuelto: controla los colores
  root.dataset.themeMode = theme;                 // auto | light | dark: controla el icono
}

darkQuery.addEventListener("change", applyTheme);
applyTheme(); // se aplica antes del primer render para evitar el flash

const THEME_NEXT = { auto: "light", light: "dark", dark: "auto" };
$("#theme-toggle").addEventListener("click", async () => {
  const { theme } = await getSettings();
  saveSettings({ theme: THEME_NEXT[theme] ?? "auto" });
});

async function load() {
  $("#refresh").classList.add("spinning");
  try {
    await refresh(); // el render llega por storage.onChanged
  } finally {
    $("#refresh").classList.remove("spinning");
  }
}

// El panel se queda abierto: se repinta cuando el service worker guarda datos nuevos.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.history) history = ch.history.newValue || [];
  if (ch.snapshot) snap = ch.snapshot.newValue;
  if (ch.settings) applyTheme();
  if (ch.snapshot || ch.history) render();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (!snap?.fetchedAt || Date.now() - snap.fetchedAt > 60_000)) load();
});
setInterval(updateFooter, 30_000);

(async () => {
  ({ snapshot: snap = null, history = [] } = await chrome.storage.local.get(["snapshot", "history"]));
  if (snap?.data) render();
  await load();
})();

// ── Render ─────────────────────────────────────────────────────
function render() {
  const main = $("#main");
  main.replaceChildren();
  renderBanner();

  if (!snap?.data) {
    const isAuth = snap?.state === "auth";
    main.append(
      h("div", { class: "card empty" },
        h("h2", {}, isAuth ? "Inicia sesión en NaN Cloud" : snap ? "No se pudo leer el uso" : "Cargando…"),
        snap && h("p", {}, isAuth
          ? "La extensión usa tu sesión del navegador. Entra en cloud.nan.builders y vuelve a este panel."
          : snap.message || "Inténtalo de nuevo en un momento."),
        snap && h("button", { class: "btn", onclick: () => open(PORTAL_URL) }, "Abrir NaN Cloud")),
      settingsCard()
    );
    setPulse("off");
    updateFooter();
    return;
  }

  const s = summarize(snap.data);
  const split = snap.breakdown ? summarizeSplit(snap.breakdown, ui.cacheRange) : null;
  const left = 100 - s.usedPct;
  const tone = left > 20 ? "" : left > 10 ? "warn" : "bad";
  setPulse(s.status === "frozen" ? "bad" : snap.state !== "ok" ? "off" : tone);

  main.append(
    creditsCard(s, tone),
    statsRow(s),
    dailyCard(),
    split ? cacheCard(split) : cacheSavedCard(s),
    modelsCard(s),
    settingsCard()
  );
  updateFooter();
}

function updateFooter() {
  $("#updated").textContent = snap?.fetchedAt ? `Actualizado ${fmtAgo(snap.fetchedAt)}` : "";
}

function renderBanner() {
  const b = $("#banner");
  b.hidden = true;
  b.className = "";
  b.replaceChildren();
  if (!snap) return;
  const show = (tone, ...content) => {
    b.hidden = false;
    b.className = tone;
    b.append(...content);
  };
  const login = h("button", { class: "link", onclick: () => open(PORTAL_URL) }, "Iniciar sesión");

  if (snap.data && snap.state === "auth") return show("warn", `Sesión caducada. Mostrando el dato de ${fmtAgo(snap.fetchedAt)}.`, login);
  if (snap.data && snap.state === "error") return show("warn", `No se pudo actualizar (${snap.message}). Mostrando el dato de ${fmtAgo(snap.fetchedAt)}.`);
  const d = snap.data;
  if (!d) return;
  if (d.frozen) return show("bad", "Cuenta congelada. Revisa el dashboard de NaN Cloud.");
  if (d.enabled === false) return show("bad", "El acceso a inferencia está desactivado.");
  if (d.frontierPaused) return show("warn", "Los modelos frontier están en pausa.");
}

// ── Créditos ───────────────────────────────────────────────────
function creditsCard(s, tone) {
  const ahead = s.usedPct - s.elapsedPct;
  const pace =
    ahead <= -5 ? ["good", "Gastas por debajo del ritmo del periodo"]
    : ahead <= 5 ? ["warn", "Gastas justo al ritmo del periodo"]
    : ["bad", "Gastas por encima del ritmo del periodo"];

  return h("section", { class: "card credits" },
    h("div", { class: "label" }, "Créditos de este periodo"),
    h("div", { class: "credits-inner" },
      h("div", { class: "hero" },
        h("span", { class: "big" }, fmt(s.remaining)),
        h("span", { class: "of" }, `de ${fmt(s.capacity)} disponibles`)),
      h("div", { class: "bar", title: "La línea marca cuánto del periodo ha pasado" },
        h("div", { class: `fill ${tone}`, style: `width:${Math.min(s.usedPct, 100)}%` }),
        h("div", { class: "marker", style: `left:calc(${s.elapsedPct}% - 1px)` })),
      h("div", { class: "bar-legend" },
        h("span", {}, "Usado ", h("b", {}, `${fmt(s.used)} (${Math.round(s.usedPct)} %)`)),
        h("span", {}, "Periodo ", h("b", {}, `${Math.round(s.elapsedPct)} %`))),
      s.pack > 0 &&
        h("div", { class: "label plain", style: "margin-top:6px" },
          `Incluye ${fmt(s.pack)} de packs` + (s.packExpiresAt ? `, caducan el ${fmtDate(s.packExpiresAt)}` : ""))),
    h("div", { class: `chip ${pace[0]}` }, pace[1]));
}

function statsRow(s) {
  const today = todayCredits();
  const hour = recentDelta(history, 60);
  const hourSub = !hour ? "sin datos aún" : hour.spanMin >= 55 ? "créditos" : `en ${Math.max(1, Math.round(hour.spanMin))} min`;
  const projection = s.exhaustsAt
    ? stat("Al ritmo actual", "Se agotan", `el ${fmtDateTime(s.exhaustsAt)}`, "bad", true)
    : stat("Al cierre", `~${fmtCompact(s.leftoverAtEnd)}`, "sobrarán al ritmo actual", "good", true);

  return h("div", { class: "stats" },
    stat("Hoy", today == null ? "–" : fmt(today), "créditos (UTC)"),
    stat("Última hora", hour ? fmt(hour.delta) : "–", hourSub),
    stat("Media diaria", fmt(s.perDay), "créditos/día"),
    stat("Renueva en", fmtDuration(s.msLeft), fmtDateTime(s.end), "", true),
    projection);
}

function todayCredits() {
  const { points } = dailySeries(snap.breakdown, history, 1);
  return points[0]?.total ?? null;
}

function stat(label, value, sub, tone = "", wide = false) {
  return h("div", { class: `stat${wide ? " wide" : ""}` },
    h("div", { class: "label" }, label),
    h("div", { class: `value ${tone}` }, value),
    h("div", { class: "sub", title: sub }, sub));
}

// ── Gasto diario ───────────────────────────────────────────────
function dailyCard() {
  const { points, split } = dailySeries(snap.breakdown, history, CHART_DAYS);
  const withData = points.filter((p) => p.total != null);
  const max = Math.max(1, ...withData.map((p) => p.total));
  const sum = withData.reduce((a, p) => a + p.total, 0);
  const keys = ["uncached", "cached", "output", "other"];

  const cols = points.map((p) => {
    if (p.total == null) return h("div", { class: "col empty", title: `${fmtDate(Date.parse(p.day))}: sin datos` });
    const title = split
      ? `${fmtDate(Date.parse(p.day))}: ${fmt2(p.total)} créditos\n` +
        keys.map((k) => `${LABELS[k]}: ${fmt2(p.parts[k])}`).join("\n")
      : `${fmtDate(Date.parse(p.day))}: ${fmt2(p.total)} créditos`;
    const height = (p.total / max) * 100;
    const segs = p.total === 0
      ? [h("div", { class: "zero" })]
      : split
        ? keys.map((k) => h("div", { style: `height:${(p.parts[k] / p.total) * height}%;background:${COLORS[k]}` }))
        : [h("div", { style: `height:${height}%;background:${COLORS.uncached}` })];
    return h("div", { class: `col${p.isToday ? " today" : ""}`, title }, segs);
  });

  const axis = points.map((p, i) =>
    h("span", {}, i % 2 === (points.length - 1) % 2 ? String(Number(p.day.slice(8))) : ""));

  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("div", { class: "label" }, `Gasto diario · ${CHART_DAYS} días`),
      h("div", { class: "label" }, `máx ${fmt(max)} · total ${fmt(sum)}`)),
    h("div", { class: "chart" }, cols),
    h("div", { class: "chart-axis" }, axis),
    split
      ? h("div", { class: "legend" },
          keys.map((k) => h("span", {}, h("i", { style: `background:${COLORS[k]}` }), LABELS[k])),
          h("span", {}, h("i", { class: "nodata" }), "sin datos"))
      : h("div", { class: "hint", style: "margin-top:8px" },
          snap.breakdown === null && !BREAKDOWN_URL
            ? "Construida con el historial local desde que instalaste la extensión. Añade BREAKDOWN_URL en lib.js para ver el reparto por tipo."
            : "Construida con el historial local."));
}

const LABELS = { uncached: "Input sin caché", cached: "Cacheado", output: "Output", other: "Otros" };

// ── Caché ──────────────────────────────────────────────────────
function cacheCard(sp) {
  const seg = (range, text) =>
    h("button", { class: ui.cacheRange === range ? "on" : "", onclick: () => { ui.cacheRange = range; render(); } }, text);
  const track = (field) =>
    h("div", { class: "track" },
      sp.rows.filter((r) => r[field] > 0).map((r) =>
        h("div", { style: `width:${r[field]}%;background:${COLORS[r.key]}`, title: `${r.label}: ${fmtPct(r[field] / 100, 1)}` })));

  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("div", { class: "label" }, "Uso de caché", sp.since ? h("span", { style: "margin-left:6px;text-transform:none;letter-spacing:0" }, `desde ${fmtDate(sp.since)}`) : null),
      h("div", { class: "seg" }, seg("last24h", "24h"), seg("last30d", "30d"))),
    h("div", { class: "hit" },
      h("span", { class: "big" }, String(Math.round(sp.hitRate * 100)), h("small", {}, "%")),
      h("span", { class: "sub" }, "cache hit rate")),
    h("div", { class: "hint" }, `${fmtMillions(sp.cachedTokens)} de ${fmtMillions(sp.inputAll)} tokens de input servidos desde la caché`),
    h("div", { class: "stack" },
      h("span", { class: "label" }, "Tokens"), track("tokenPct"),
      h("span", { class: "label" }, "Gasto"), track("creditPct")),
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Tipo"), h("th", {}, "Tokens"), h("th", {}, "% tok"), h("th", {}, "Créditos"), h("th", {}, "% cr"))),
      h("tbody", {},
        sp.rows.map((r) =>
          h("tr", {},
            h("td", {}, h("span", { class: "dot", style: `background:${COLORS[r.key]}` }), r.label, r.sub && h("small", {}, r.sub)),
            h("td", { class: r.tokens == null ? "muted" : "" }, r.tokens == null ? "–" : fmtMillions(r.tokens)),
            h("td", { class: "muted" }, r.tokenPct == null ? "–" : r.tokenPct < 1 && r.tokenPct > 0 ? "<1 %" : `${Math.round(r.tokenPct)} %`),
            h("td", {}, fmt2(r.credits)),
            h("td", { class: "muted" }, r.creditPct < 1 && r.creditPct > 0 ? "<1 %" : `${Math.round(r.creditPct)} %`))),
        h("tr", { class: "total" },
          h("td", {}, "Total"), h("td", {}, fmtMillions(sp.totalTokens)), h("td", {}, "100 %"),
          h("td", {}, fmt2(sp.totalCredits)), h("td", {}, "100 %")))),
    h("div", { class: "saved-line" },
      `La caché te ha ahorrado ${fmt(sp.saved)} créditos (≈ ${fmt(sp.savedEur)} €)`));
}

// Respaldo si no hay breakdown: solo el ahorro que trae /usage/credits.
function cacheSavedCard(s) {
  return h("section", { class: "card cache" },
    h("div", {},
      h("div", { class: "label" }, "Ahorro por caché"),
      h("div", { class: "value saved" }, `${fmt(s.cacheSaved)} créditos`),
      s.cacheSince && h("div", { class: "label plain", style: "margin-top:2px" }, `desde el ${fmtDate(s.cacheSince)}`)),
    h("div", { class: "eur", title: "A 0,01 € por crédito, el precio de los planes" },
      h("div", { class: "label" }, "Equivale a"),
      h("div", { class: "value" }, `≈ ${fmt(s.cacheSavedEur)} €`)));
}

// ── Modelos ────────────────────────────────────────────────────
function modelsCard(s) {
  const perModel = snap.breakdown ? summarizeSplit(snap.breakdown, "last30d")?.byModel : null;
  const list = ui.showAllModels ? s.models : s.models.slice(0, MODELS_COLLAPSED);
  const hidden = s.models.length - list.length;

  return h("section", { class: "card" },
    h("div", { class: "models-head" },
      h("div", { class: "label" }, "Gasto por modelo este periodo"),
      h("div", { class: "label" }, `${s.models.length} en uso`)),
    s.models.length === 0 && h("div", { class: "label plain" }, "Aún no hay gasto en este periodo."),
    list.map((m) => {
      const hit = perModel?.get(m.model)?.hitRate;
      return h("div", { class: "model" },
        h("div", { class: "model-row" },
          h("span", { class: "model-name", title: m.description || m.model }, m.displayName || m.model),
          h("span", { class: "model-credits" }, fmt(m.creditsThisMonth), h("span", {}, `${Math.round(m.share)} %`))),
        h("div", { class: "model-bar" }, h("div", { style: `width:${m.share}%` })),
        h("div", { class: "model-meta" },
          h("span", {}, `${fmtTokens(m.tokensThisMonth)} tok` + (hit != null ? ` · caché ${hit < 1 ? Math.min(99, Math.round(hit * 100)) : 100} %` : "")),
          costBadge(m)));
    }),
    (hidden > 0 || ui.showAllModels) && s.models.length > MODELS_COLLAPSED &&
      h("button", { class: "link toggle", onclick: () => { ui.showAllModels = !ui.showAllModels; render(); } },
        ui.showAllModels ? "Ver menos" : `Ver ${hidden} más`),
    h("div", { class: "hint", style: "margin-top:8px" },
      "Coste real = créditos ÷ tokens del periodo, frente a la tarifa aproximada del modelo. Por debajo de 1 M tokens no es representativo."));
}

function costBadge(m) {
  if (m.effPerM == null || !m.listPerM) return h("span", {});
  const title = `Pagas ${fmt2(m.effPerM)} créditos por millón de tokens. Tarifa aproximada: ${fmt2(m.listPerM)}.`;
  if (!m.enoughData) return h("span", { title }, `${fmt2(m.effPerM)} cr/M · poco uso`);
  const pct = Math.round(Math.abs(m.vsList) * 100);
  const cls = m.vsList <= -0.05 ? "cheaper" : m.vsList >= 0.05 ? "pricier" : "";
  const txt = cls === "cheaper" ? `${pct} % bajo tarifa` : cls === "pricier" ? `${pct} % sobre tarifa` : "en tarifa";
  return h("span", { title }, `${fmt2(m.effPerM)} cr/M · `, h("span", { class: cls }, txt));
}

// ── Ajustes ────────────────────────────────────────────────────
let settingsEl = null;
function settingsCard() {
  if (settingsEl) return settingsEl; // se crea una vez para no perder lo que estás escribiendo
  settingsEl = h("details", { class: "card" }, h("summary", {}, h("span", { class: "label" }, "Ajustes y alertas")));
  getSettings().then((st) => {
    const num = (key, min, max) =>
      h("input", { type: "number", min, max, value: st[key], onchange: (e) => {
        const v = Math.min(Math.max(Number(e.target.value) || min, min), max);
        e.target.value = v;
        saveSettings({ [key]: v });
      } });
    const check = (key) =>
      h("input", { type: "checkbox", checked: st[key] || null, onchange: (e) => saveSettings({ [key]: e.target.checked }) });
    const poll = h("select", { onchange: (e) => saveSettings({ pollMinutes: Number(e.target.value) }) },
      [1, 2, 5, 10, 15].map((m) => h("option", { value: m, selected: m === st.pollMinutes || null }, `${m} min`)));

    settingsEl.append(
      h("div", { class: "setting" }, h("span", {}, "Actualizar cada"), poll),
      h("div", { class: "setting" },
        h("span", {}, "Avisar de gasto anómalo"),
        h("span", { class: "inline" }, check("spikeEnabled"), num("spikeCredits", 5, 5000), "créditos en", num("spikeWindow", 5, 240), "min")),
      h("div", { class: "setting" }, h("span", {}, "Avisos al 80, 90 y 100 % y de ritmo"), check("thresholdAlerts")),
      h("div", { class: "hint" },
        "El gasto anómalo se calcula con el historial local, así que depende de la frecuencia de actualización. ",
        "Con 5 min, una ventana de 15 min compara 3 lecturas."));
  });
  return settingsEl;
}

function setPulse(tone) {
  $(".pulse").className = `pulse ${tone}`;
}
