"use strict";

const STRINGS = {
  en: {
    loading: "Checking…",
    on: "Internet is ON",
    off: "Internet is OFF",
    onUntil: "Turns off automatically at {time}",
    onUntilTomorrow: "Turns off automatically tomorrow at {time}",
    offDetail: "Blocked on home Wi-Fi",
    turnOn: "Turn internet on",
    m30: "30 min",
    h1: "1 hour",
    h2: "2 hours",
    bedtime: "Until {time}",
    turnOff: "Turn internet off now",
    working: "One moment…",
    error: "Couldn't reach the router. Try again in a moment.",
    updated: "Updated {time}",
  },
  pt: {
    loading: "Verificando…",
    on: "Internet LIGADA",
    off: "Internet DESLIGADA",
    onUntil: "Desliga automaticamente às {time}",
    onUntilTomorrow: "Desliga automaticamente amanhã às {time}",
    offDetail: "Bloqueada no Wi-Fi de casa",
    turnOn: "Ligar a internet",
    m30: "30 min",
    h1: "1 hora",
    h2: "2 horas",
    bedtime: "Até às {time}",
    turnOff: "Desligar a internet agora",
    working: "Um momento…",
    error: "Não foi possível falar com o roteador. Tente de novo daqui a pouco.",
    updated: "Atualizado às {time}",
  },
};

// Auto-detect: any Portuguese preference picks pt (pt-BR wording), otherwise English.
const LANG = (navigator.languages || [navigator.language || "en"])
  .map(l => l.toLowerCase())
  .find(l => l.startsWith("pt") || l.startsWith("en"))?.startsWith("pt") ? "pt" : "en";
const LOCALE = LANG === "pt" ? "pt-BR" : undefined;
document.documentElement.lang = LANG === "pt" ? "pt-BR" : "en";

const t = (key, vars = {}) =>
  (STRINGS[LANG][key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

const fmtTime = d => d.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });

const $ = id => document.getElementById(id);
const statusEl = $("status"), headline = $("headline"), detail = $("detail"), errorEl = $("error");
const buttons = [...document.querySelectorAll("button")];

document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });

let busy = false;

function render(s) {
  statusEl.dataset.state = s.internet;
  $("device").textContent = s.device || "";
  headline.textContent = t(s.internet);
  if (s.internet === "on" && s.until) {
    const until = new Date(s.until);
    const sameDay = until.toDateString() === new Date().toDateString();
    detail.textContent = t(sameDay ? "onUntil" : "onUntilTomorrow", { time: fmtTime(until) });
  } else {
    detail.textContent = s.internet === "off" ? t("offDetail") : "";
  }
  if (s.bedtime) {
    const [h, m] = s.bedtime.split(":").map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0);
    $("bedtime-btn").textContent = t("bedtime", { time: fmtTime(d) });
  }
  $("off-btn").hidden = s.internet !== "on";
  errorEl.hidden = true;
}

function setBusy(on) {
  busy = on;
  buttons.forEach(b => { b.disabled = on; });
  if (on) { headline.textContent = t("working"); detail.textContent = ""; statusEl.dataset.state = "loading"; }
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  } : { credentials: "same-origin", cache: "no-store" });
  // An expired OIDC session comes back as a redirect to the login page.
  if (res.redirected || (res.headers.get("content-type") || "").includes("text/html")) {
    location.reload();
    throw new Error("session expired");
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function refresh() {
  if (busy) return;
  try { render(await api("/api/status")); }
  catch (e) { showError(e); }
}

function showError(e) {
  console.error(e);
  statusEl.dataset.state = "error";
  headline.textContent = "—";
  detail.textContent = "";
  errorEl.textContent = t("error");
  errorEl.hidden = false;
}

async function act(body) {
  setBusy(true);
  try { render(await api("/api/internet", body)); }
  catch (e) { showError(e); }
  finally { setBusy(false); }
}

document.querySelectorAll("[data-minutes]").forEach(b =>
  b.addEventListener("click", () => act({ state: "on", minutes: Number(b.dataset.minutes) })));
$("bedtime-btn").addEventListener("click", () => act({ state: "on", until: "bedtime" }));
$("off-btn").addEventListener("click", () => act({ state: "off" }));

refresh();
setInterval(refresh, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
