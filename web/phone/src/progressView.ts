// The Progress tab on the page: fetches the TV's own reads (GET /api/stats?range=week,
// /api/transfer, /api/recaps?limit=3) and renders the view model from progress.ts.
//
// Auth: the page sends the pair token it holds (from the QR's #k=) in x-pair-token, never in the
// URL, so the gate lets these three reads through a tunnel or from the LAN without --lan
// (src/hub/gate.ts PAIRED_READS). Without a token (a trusted LAN phone) it sends none.
//
// Refresh: on opening the tab (when never fetched, marked stale, or older than a minute); after
// stats.updated and recap.ready over the socket (at once when the tab is showing, debounced, else
// on the next open); and after a reconnect or a hub restart. No polling. A superseded response is
// dropped. Today's practice comes from the socket alone (hub.state, stats.updated).
// Privacy: nothing is stored (no localStorage, no cache: no-store, no cookies).
import type { DeckSummary, PracticeCounts, RecapList, StatsResponse, TransferResponse } from "../../../src/hub/contract.js";
import { DASH, detailsModel, errorOf, errorText, hueClass, PER_100, recapRows, todayModel, transferModel, weekModel, type HabitCard, type LoadError } from "./progress.js";
import { pairHeaders } from "./take.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const FETCH_TIMEOUT_MS = 8000;
const FRESH_MS = 60_000;
const DEBOUNCE_MS = 400;

type Key = "stats" | "transfer" | "recaps";
const PATHS: Record<Key, string> = { stats: "/api/stats?range=week", transfer: "/api/transfer", recaps: "/api/recaps?limit=3" };
interface Slot<T> {
  data: T | null;
  error: LoadError | null;
  loading: boolean;
  stale: boolean;
  at: number; // when the data arrived (0: never)
  gen: number; // the latest request; an older response is dropped
}
const slot = <T>(): Slot<T> => ({ data: null, error: null, loading: false, stale: true, at: 0, gen: 0 });

export interface ProgressOptions {
  root: HTMLElement; // <section id="progress">
  token: () => string | null; // the pair token in memory
  hubNow: () => number; // the hub's clock ("Today" and "Yesterday" on the recaps)
  onPractise: () => void; // the Practise now button: open the Practice line tab
  fetchImpl?: typeof fetch;
}

export function createProgress(o: ProgressOptions) {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const slots = { stats: slot<StatsResponse>(), transfer: slot<TransferResponse>(), recaps: slot<RecapList>() };
  let visible = false;
  let deck: DeckSummary | null = null;
  let practiceToday: PracticeCounts | null = null;
  let label: string | null = null;
  let bootId: string | null = null;
  let detailsOpen = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function load(k: Key) {
    const s = slots[k] as Slot<unknown>;
    const gen = ++s.gen;
    s.loading = true;
    render();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let status: number | null = null;
    try {
      const r = await f(PATHS[k], { headers: { accept: "application/json", ...pairHeaders(o.token()) }, credentials: "omit", cache: "no-store", signal: ac.signal });
      status = r.status;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (gen !== s.gen) return;
      Object.assign(s, { data: body, error: null, stale: false, at: Date.now() });
      if (typeof body?.dataLabel === "string") label = body.synthetic ? body.dataLabel : null;
    } catch {
      if (gen !== s.gen) return;
      s.error = errorOf(status);
    } finally {
      clearTimeout(t);
      if (gen === s.gen) {
        s.loading = false;
        render();
      }
    }
  }

  function refresh(force = false) {
    for (const k of Object.keys(slots) as Key[]) {
      const s = slots[k];
      if (force || s.stale || !s.at || Date.now() - s.at > FRESH_MS) void load(k);
    }
  }
  function later() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (visible) refresh();
    }, DEBOUNCE_MS);
  }
  const markStale = (...keys: Key[]) => keys.forEach((k) => (slots[k].stale = true));

  // Render

  function render() {
    if (!visible) return;
    const parts = [labelHtml(), todayHtml(), errorHtml(), weekHtml(), transferHtml(), recapsHtml(), detailsHtml()];
    o.root.innerHTML = parts.filter(Boolean).join("");
    o.root.querySelector<HTMLButtonElement>("#pg-practise")?.addEventListener("click", () => o.onPractise());
    o.root.querySelector<HTMLButtonElement>("#pg-retry")?.addEventListener("click", () => refresh(true));
    o.root.querySelector<HTMLButtonElement>("#pg-details-btn")?.addEventListener("click", () => {
      detailsOpen = !detailsOpen;
      render();
      o.root.querySelector<HTMLButtonElement>("#pg-details-btn")?.focus(); // the re-render replaced the button
    });
  }

  const labelHtml = () => (label ? `<p class="pg-label">${esc(label)}</p>` : "");

  function todayHtml() {
    const t = todayModel(deck, practiceToday);
    const big = t.due === null ? `<div class="pg-big wait">${DASH}</div>` : t.due > 0 ? `<div class="pg-big">${t.due}</div><div class="pg-big-label">line${t.due === 1 ? "" : "s"} to practise</div>` : `<div class="pg-big done">All done</div><div class="pg-big-label">Nothing due today. Nice.</div>`;
    const bar = t.bar ? `<div class="pg-segs" role="img" aria-label="${esc(t.line ?? "")}">${Array.from({ length: t.bar.shown }, (_, i) => `<span class="${i < t.bar!.filled ? "on" : ""}"></span>`).join("")}</div>` : "";
    return `<div class="card paper pg-today" id="pg-today"><div class="kicker">Today’s practice</div>${big}${bar}${t.line ? `<div class="pg-today-line">${esc(t.line)}</div>` : ""}${t.practiseNow ? `<button id="pg-practise" class="pg-cta">Practise now</button>` : ""}</div>`;
  }

  // One message for the reads that failed with nothing to show: the gate, the hub or the network.
  function errorHtml() {
    const failed = (Object.values(slots) as Slot<unknown>[]).filter((s) => s.error && !s.data && !s.loading);
    if (!failed.length) return "";
    const e = failed.find((s) => s.error === "forbidden")?.error ?? failed[0]!.error!;
    return `<div class="card pg-error" role="alert"><p>${esc(errorText(e))}</p>${e === "forbidden" ? "" : `<button id="pg-retry" class="ghost">Try again</button>`}</div>`;
  }

  const loadingCard = (title: string) => `<div class="card"><div class="pg-head"><h2>${esc(title)}</h2></div><p class="dim">Loading your progress…</p></div>`;

  function weekHtml() {
    const s = slots.stats;
    if (!s.data) return s.loading ? loadingCard("This week") : "";
    const w = weekModel(s.data);
    const rows = w.rows.map((r) => `<li class="pg-row ${hueClass(r.key)}"><span class="pg-dot" aria-hidden="true"></span><span class="pg-row-name"><b>${esc(r.title)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ""}</span><span class="pg-rate${r.rate === DASH ? " none" : ""}">${esc(r.rate)}</span></li>`).join("");
    return `<div class="card" id="pg-week"><div class="pg-head"><h2>This week</h2><span class="pg-gloss">${PER_100}</span></div><ul class="pg-rows">${rows}</ul><p class="pg-note">${esc(w.note)}</p></div>`;
  }

  function transferHtml() {
    const s = slots.transfer;
    if (!s.data) return s.loading ? loadingCard("Since you started practising") : "";
    const t = transferModel(s.data);
    const cards = t.cards.map(cardHtml).join("");
    const signals = t.signals.length ? `<div class="card pg-signal" id="pg-signal"><div class="kicker">First signal</div>${t.signals.map((x) => `<p>${esc(x.text)}${x.caveat ? `<small>${esc(x.caveat)}</small>` : ""}</p>`).join("")}</div>` : "";
    return `<div class="pg-transfer" id="pg-transfer"><div class="kicker">Since you started practising</div><h2 class="pg-title">${esc(t.lead)}</h2>${t.rest ? `<p class="pg-title-rest">${esc(t.rest)}</p>` : ""}<p class="pg-gloss">Your real conversations, heard by Bee · ${PER_100}</p>${cards}${signals}</div>`;
  }

  function cardHtml(c: HabitCard) {
    const num = (v: string | null, cls: string) => `<span class="${cls}${v ? "" : " none"}">${esc(v ?? DASH)}</span>`;
    return `<div class="pg-card ${hueClass(c.habit)}" data-habit="${esc(c.habit)}"><div class="pg-card-name"><b>${esc(c.title)}</b><span>${c.role}</span></div><div class="pg-card-body"><div class="pg-nums"><div>${num(c.before, "pg-before")}<small>before</small></div><span class="pg-arrow" aria-hidden="true">→</span><div>${num(c.after, "pg-after")}<small>now</small></div></div>${c.pill ? `<span class="pg-pill ${c.tone}">${esc(c.pill)}</span>` : ""}</div></div>`;
  }

  function recapsHtml() {
    const s = slots.recaps;
    if (!s.data) return s.loading ? loadingCard("Recent conversations") : "";
    const rows = recapRows(s.data, o.hubNow());
    const body = rows.length ? `<ul class="pg-recaps">${rows.map((r) => `<li><div class="pg-recap-meta"><span>${esc(r.when)}</span>${r.setting ? `<span class="pg-chip">${esc(r.setting)}</span>` : ""}</div><p>${esc(r.headline)}</p></li>`).join("")}</ul>` : `<p class="dim">After a conversation of 60 words or more, its recap shows here.</p>`;
    return `<div class="card" id="pg-recaps"><div class="pg-head"><h2>Recent conversations</h2></div>${body}</div>`;
  }

  function detailsHtml() {
    const t = slots.transfer.data;
    if (!t) return "";
    const btn = `<button id="pg-details-btn" class="ghost pg-details-btn" aria-expanded="${detailsOpen}" aria-controls="pg-details">${detailsOpen ? "Hide details" : "Details"}</button>`;
    if (!detailsOpen) return btn;
    const d = detailsModel(t);
    const habits = d.habits.map((h) => `<div class="pg-detail"><b>${esc(h.title)}</b><p>Before: ${esc(h.before)}</p><p>Now: ${esc(h.after)}</p>${h.need ? `<p class="dim">${esc(h.need)}</p>` : ""}</div>`).join("");
    return `${btn}<div class="card pg-details" id="pg-details"><div class="pg-detail"><b>The plan</b><p>${esc(d.plan)}</p></div>${habits}</div>`;
  }

  return {
    /** The tab is showing: render what is held and fetch what is missing or old. */
    open() {
      visible = true;
      render();
      refresh();
    },
    hide() {
      visible = false;
    },
    /** A sequenced hub event from the socket. */
    onEvent(topic: string, p: Record<string, any>) {
      if (topic === "hub.state") {
        deck = p.deck ?? deck;
        practiceToday = p.practiceToday ?? practiceToday;
        if (typeof p.bootId === "string") {
          if (bootId && bootId !== p.bootId) markStale("stats", "transfer", "recaps");
          bootId = p.bootId;
        }
        if (visible) {
          render();
          later();
        }
      } else if (topic === "stats.updated") {
        deck = p.deck ?? deck;
        practiceToday = p.practiceToday ?? practiceToday;
        // a settled attempt, a finished conversation or a setting change: the rates and the recaps' settings may move
        markStale("stats", "transfer", "recaps");
        if (visible) {
          render();
          later();
        }
      } else if (topic === "recap.ready") {
        markStale("recaps");
        if (visible) later();
      }
    },
    /** The socket came back after a drop: anything may have changed meanwhile. */
    onReconnect() {
      markStale("stats", "transfer", "recaps");
      if (visible) later();
    },
  };
}
