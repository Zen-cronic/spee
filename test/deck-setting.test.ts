// The practice deck by setting (COACH_DECK_SETTING, src/hub/settings.ts): which cards the due
// lines, "quiz me", the day's count and the TV offer. Only practice changes: the transfer and the
// stats stay as they were. Synthetic data only.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HubCard } from "../src/hub/cards.js";
import { CoachHub } from "../src/hub/core.js";
import { buildBrief } from "../src/hub/brief.js";
import { buildPrereg, DEMO_TZ } from "../src/hub/demoData.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { deckFilterFor, parseDeckSetting, SettingsBook, type SettingTag } from "../src/hub/settings.js";
import { demoSetup } from "../src/hub/setup.js";
import type { StatSession } from "../src/hub/stats.js";
import { raw } from "./helpers-http.js";

const at = (iso: string) => Date.parse(iso);

describe("COACH_DECK_SETTING", () => {
  it("unset or empty is all; work and meeting in any case; anything else is refused (null)", () => {
    expect(parseDeckSetting(undefined)).toBe("all");
    expect(parseDeckSetting("")).toBe("all");
    expect(parseDeckSetting(" Work ")).toBe("work");
    expect(parseDeckSetting("meeting")).toBe("meeting");
    expect(parseDeckSetting("all")).toBe("all");
    expect(parseDeckSetting("casual")).toBeNull();
    expect(parseDeckSetting("gym")).toBeNull();
  });

  it("all keeps every card; work keeps meetings and work talk; meeting keeps meetings; an untagged conversation is left out", () => {
    const tags: Record<string, SettingTag> = {
      m: { setting: "meeting", source: "auto", confidence: "high", reasons: ["captions"] },
      w: { setting: "work", source: "auto", confidence: "high", reasons: ["work-hours", "speakers"] },
      c: { setting: "casual", source: "auto", confidence: "high", reasons: ["weekend"] },
    };
    const tagOf = (id: string) => tags[id] ?? null;
    const cards = ["m", "w", "c", "gone"].map((session) => ({ session }));
    expect(deckFilterFor("all", tagOf)).toBeNull();
    expect(cards.filter(deckFilterFor("work", tagOf)!).map((c) => c.session)).toEqual(["m", "w"]);
    expect(cards.filter(deckFilterFor("meeting", tagOf)!).map((c) => c.session)).toEqual(["m"]);
  });
});

// A synthetic hub: a work-hours session (work), a weekend one (casual), a captions session
// (meeting), and one card from a conversation the hub has no session for.
function deckHub() {
  const line = (k: string) => ({ key: k, text: "The export is ready for the team today and works.", dom: "en" as const, uncertain: false });
  const s = (id: string, kind: StatSession["kind"], iso: string, speakers: number): StatSession => ({ id, kind, startMs: at(iso), lines: [line(`u:${id}`)], speakers, synthetic: true });
  const sessions = [s("work1", "conversation", "2026-10-13T10:00:00-04:00", 3), s("casual1", "conversation", "2026-10-17T20:00:00-04:00", 2), s("meet1", "meeting", "2026-10-14T14:00:00-04:00", 5)];
  const card = (id: string, session: string, box: number): HubCard => ({
    id,
    kind: "error",
    lang: "en",
    type: "EN_HEDGE_STACK",
    key: `u:${session}`,
    session,
    said: "I guess the export is ready",
    fix: "The export is ready",
    resay: "The export is ready for review today.",
    line: "I guess the export is ready",
    why: "Say it plainly.",
    score: 4,
    box,
    due: "2026-10-20",
    added: "2026-10-15",
    relapses: 0,
    lastSeenSession: session,
    synthetic: true,
  });
  // The casual card is box 1, so it would come first without the filter.
  const deck = { cards: [card("c:casual", "casual1", 1), card("c:work", "work1", 2), card("c:meet", "meet1", 3), card("c:none", "nowhere", 1)] };
  const now = at("2026-10-20T13:30:00-04:00");
  const hub = new CoachHub({ mode: "demo", clock: () => now, tz: DEMO_TZ, deck, deckPath: null, attemptsPath: null, sessions, prereg: buildPrereg(), preregPath: "test", wearer: { minScore: 0.5 } as never, attempts: [], dataLabel: "SYNTHETIC" });
  hub.drillEvents = () => [{ at: at("2026-10-15T12:00:00-04:00"), habitKeys: ["hedges"] }];
  return { hub, book: new SettingsBook({ hub, stateDir: null }) };
}

describe("the practice deck on the hub", () => {
  it("all: the whole deck, as before", () => {
    const { hub } = deckHub();
    expect(hub.practiceDeck()).toBe(hub.deck);
    expect(hub.deckSummary()).toMatchObject({ total: 4, dueNow: 4 });
    expect(hub.nextCard()!.id).toBe("c:casual");
  });

  it("work: due lines, quiz me (next card) and the day's count only use meetings and work talk", () => {
    const { hub, book } = deckHub();
    hub.setDeckFilter(deckFilterFor("work", (id) => book.tagSession(id)));
    expect(hub.practiceDeck().cards.map((c) => c.id)).toEqual(["c:work", "c:meet"]);
    expect(hub.deckSummary()).toMatchObject({ total: 2, dueNow: 2 });
    expect(hub.nextCard()!.id).toBe("c:work");
    // the session flow ("quiz me") opens from the same deck
    const { card } = hub.startSession({ by: "test", size: 2 });
    expect(card!.id).toBe("c:work");
  });

  it("meeting: meetings only, the brief's warm-up line too; a card named by id can still be opened", async () => {
    const { hub, book } = deckHub();
    const calendar = async () => ({ events: [], source: "test" });
    expect((await buildBrief(hub, calendar)).warmup!.id).toBe("c:casual");
    hub.setDeckFilter(deckFilterFor("meeting", (id) => book.tagSession(id)));
    expect(hub.practiceDeck().cards.map((c) => c.id)).toEqual(["c:meet"]);
    expect((await buildBrief(hub, calendar)).warmup!.id).toBe("c:meet");
    expect(hub.openCard({ cardId: "c:casual" })!.id).toBe("c:casual");
  });

  it("follows the wearer's correction of a conversation's setting", () => {
    const { hub, book } = deckHub();
    hub.setDeckFilter(deckFilterFor("work", (id) => book.tagSession(id)));
    book.set("work1", "casual");
    expect(hub.practiceDeck().cards.map((c) => c.id)).toEqual(["c:meet"]);
    book.set("casual1", "work");
    expect(hub.practiceDeck().cards.map((c) => c.id)).toEqual(["c:casual", "c:meet"]);
  });

  it("leaves the transfer and the stats exactly as they were", () => {
    const { hub, book } = deckHub();
    const t0 = JSON.stringify(hub.transfer());
    const s0 = JSON.stringify(hub.stats({ kind: "all" }));
    hub.setDeckFilter(deckFilterFor("meeting", (id) => book.tagSession(id)));
    hub.deckSummary();
    hub.nextCard();
    expect(JSON.stringify(hub.transfer())).toBe(t0);
    expect(JSON.stringify(hub.stats({ kind: "all" }))).toBe(s0);
  });
});

describe("over HTTP (demo hub, synthetic, COACH_DECK_SETTING=work)", () => {
  let s: HubServer;
  let full: number;
  const get = async (p: string) => JSON.parse((await raw(s.port, p)).text);
  const post = async (p: string, b: unknown) => JSON.parse((await raw(s.port, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).text);
  const prev = process.env.COACH_DECK_SETTING;
  beforeAll(async () => {
    process.env.COACH_DECK_SETTING = "work";
    const setup = demoSetup({ pace: 0.01, stateDir: mkdtempSync(join(tmpdir(), "deck-setting-")) });
    full = setup.hub.deck.cards.length;
    s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup, pairToken: "p".repeat(20), mcpToken: "m".repeat(20) });
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.COACH_DECK_SETTING;
    else process.env.COACH_DECK_SETTING = prev;
    await s.close();
  });

  it("GET /api/deck and /api/deck/next offer only cards from meetings and work talk; a correction drops one", async () => {
    const tags = Object.fromEntries((await get("/api/settings")).sessions.map((x: any) => [x.id, x.tag.setting]));
    const deck = await get("/api/deck");
    const views = deck.cards as { id: string; source: { session: string } }[];
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((c) => ["meeting", "work"].includes(tags[c.source.session]))).toBe(true);
    expect(deck.summary.total).toBe(views.length);
    const next = (await get("/api/deck/next")).card;
    expect(views.map((c) => c.id)).toContain(next.id);
    const t0 = (await get("/api/transfer")).headline;
    // the wearer says the first card's conversation was casual: its cards leave the practice deck
    const drop = views[0]!.source.session;
    await post(`/api/sessions/${drop}/setting`, { setting: "casual" });
    const after = (await get("/api/deck")).cards as { source: { session: string } }[];
    expect(after.some((c) => c.source.session === drop)).toBe(false);
    expect(after.length).toBeLessThan(full);
    expect((await get("/api/transfer")).headline).toBe(t0);
  });
});
