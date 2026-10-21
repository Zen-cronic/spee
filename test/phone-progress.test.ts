// The phone's Progress tab (web/phone/src/progress.ts) on the hub's own payloads: the synthetic demo,
// and two early states computed by the same hub from a copy of the demo fixtures (nothing practised
// yet; only "like" practised, once). The words are the TV's (format.ts), the "–" rule holds for
// every period without enough speech, and no recap quote reaches the tab.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Attempt, RecapList, TransferHabit, TransferResponse } from "../src/hub/contract.js";
import { demoSetup } from "../src/hub/setup.js";
import { FIRST_SIGNAL_CAVEAT, habitPill, habitRole, transferRates, transferTitle, verdictWords } from "../tv/web/src/mirror/format.js";
import { DASH, detailsModel, errorOf, errorText, habitCard, hueClass, recapRows, recapWhen, todayModel, transferModel, weekModel } from "../web/phone/src/progress.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A demo hub on a copy of fixtures/demo whose drill attempts are filtered (the hub computes the state).
function hubWith(keep: (a: Attempt) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), "phone-progress-"));
  dirs.push(dir);
  cpSync("fixtures/demo", dir, { recursive: true });
  const file = join(dir, "attempts.json");
  const j = JSON.parse(readFileSync(file, "utf8")) as { attempts: Attempt[] };
  writeFileSync(file, JSON.stringify({ ...j, attempts: j.attempts.filter(keep) }));
  return demoSetup({ fixturesDir: dir, stateDir: null, pace: 0.01 }).hub;
}
const demo = demoSetup({ stateDir: null, pace: 0.01 }).hub;
const full = demo.transfer()! as TransferResponse;
const none = hubWith(() => false).transfer()! as TransferResponse;
const likeOnly = hubWith((a) => a.cardId === "demo:filler-like" && a.createdAt > Date.UTC(2026, 9, 18)).transfer()! as TransferResponse;

describe("Progress: before and after, from the hub's claim", () => {
  it("full demo: the TV's headline, practised habits first, the hub's verdict words and pills", () => {
    const m = transferModel(full);
    const title = transferTitle(full);
    expect(m.lead).toBe(title.lead);
    expect(m.rest).toBe(title.rest);
    expect(m.cards.map((c) => c.role)).toEqual([...full.habits.filter((h) => h.role === "drilled").map(() => "Practised"), ...full.habits.filter((h) => h.role !== "drilled").map(() => "Not practised")]);
    for (const c of m.cards) {
      const h = full.habits.find((x) => x.habit === c.habit)!;
      expect(c.pill).toBe(verdictWords(h)); // the TV's words whenever a period has started
      expect(c.tone).toBe(h.verdict === "dropped" ? "good" : h.verdict === "rose" ? "bad" : "wait");
      expect({ before: c.before, after: c.after }).toEqual(transferRates(h, full.minWordsPerPeriod));
    }
    expect(m.cards.find((c) => c.habit === "hedges")).toMatchObject({ title: "Unsure words", tone: "good" });
    expect(m.cards.find((c) => c.habit === "restart")).toMatchObject({ title: "Starting over", role: "Not practised" });
  });

  it("first signal: every measured number carries its caveat; the rest say what is missing", () => {
    const m = transferModel(full);
    expect(m.signals.length).toBe(full.firstSignal!.length);
    full.firstSignal!.forEach((f, i) => {
      expect(m.signals[i]!.caveat).toBe(f.status === "measured" ? FIRST_SIGNAL_CAVEAT : null);
      if (f.status !== "measured") expect(m.signals[i]!.text).not.toMatch(/\d\.\d/);
    });
    expect(m.signals.some((s) => s.caveat === "one conversation, not proof")).toBe(true);
  });

  it("nothing practised yet: the TV's words, a dash for every 'now', quiet pills, no first signal", () => {
    expect(none.claim).toBe("not-drilled-yet");
    const m = transferModel(none);
    expect(m.lead).toBe("Nothing practised yet.");
    expect(m.rest).toBe("Progress counts from your first practice line.");
    // never "Practised" beside "Not practised yet"; the unpractised one is not "not practised yet" either
    expect(m.cards.map((c) => [c.role, c.pill])).toEqual([["To practise", null], ["To practise", null], ["Not practised", "Starts at your first practice"]]);
    for (const c of m.cards.filter((x) => x.role === "To practise")) expect(c.after).toBeNull();
    expect(m.cards.every((c) => c.tone === "wait")).toBe(true);
    expect(m.signals).toEqual([]);
    const d = detailsModel(none);
    expect(d.habits.filter((h) => h.title !== "Starting over").every((h) => h.after === "starts at your first practice")).toBe(true);
  });

  it("only 'like' practised, once: measuring it, the other not practised yet, no number without enough speech", () => {
    expect(likeOnly.claim).toBe("partly-started");
    const m = transferModel(likeOnly);
    expect(m.rest).toBeNull(); // the cards' pills already say "not practised yet"
    expect(m.lead).toMatch(/^Measuring filler “like” now\.$/);
    expect(m.cards.find((c) => c.habit === "hedges")).toMatchObject({ role: "To practise", after: null, pill: null });
    expect(m.cards.find((c) => c.habit === "filler:like")!.role).toBe("Practised");
    for (const c of m.cards) {
      const h = likeOnly.habits.find((x) => x.habit === c.habit)!;
      if (h.after.words < likeOnly.minWordsPerPeriod) expect(c.after).toBeNull();
    }
    for (const s of m.signals) if (!s.caveat) expect(s.text).not.toMatch(/\d\.\d → /);
  });

  it("the dash rule: an empty or short period is never '0.0'", () => {
    const base: TransferHabit = { ...full.habits[0]! };
    const empty = { ...base, before: { ...base.before, words: 0, count: 0, per100: 0 }, after: { ...base.after, words: 120, count: 0, per100: 0 }, verdict: "too little data" as const };
    expect(habitCard(empty, 400)).toMatchObject({ before: null, after: null, pill: "Needs more speech", tone: "wait" });
    expect(habitCard(base, 400).before).not.toBeNull();
    expect(DASH).toBe("–");
  });

  it("details: the TV's plan line, each side's words and dates, and what too little data needs", () => {
    const d = detailsModel(full);
    expect(d.plan).toMatch(/^Set Oct 12, before you first practised\. A change counts only with 400\+ words each side and a clear gap\.$/);
    expect(d.habits[0]!.before).toMatch(/^[\d.k]+ words in \d+ conversations?, Oct \d+( to Oct \d+)?$/);
    const short = { ...full, habits: [{ ...full.habits[0]!, verdict: "too little data" as const, wordsNeededPerPeriod: 2400 }] };
    expect(detailsModel(short).habits[0]!.need).toBe("About 2.4k words each side would show a real change");
  });
});

describe("Progress: today and this week", () => {
  it("today: the hub's numbers only, the TV's bar rule and words", () => {
    expect(todayModel(null, null)).toMatchObject({ due: null, bar: null, line: null, practiseNow: false });
    expect(todayModel({ dueNow: 3 }, { passed: 2 })).toEqual({ due: 3, done: 2, bar: { shown: 5, filled: 2 }, line: "2 passed today · 3 to go", practiseNow: true });
    expect(todayModel({ dueNow: 4 }, { passed: 0 })).toMatchObject({ bar: { shown: 4, filled: 0 }, line: "None done yet today" });
    expect(todayModel({ dueNow: 0 }, { passed: 4 })).toMatchObject({ bar: { shown: 4, filled: 4 }, line: "4 passed today", practiseNow: false });
    expect(todayModel({ dueNow: 0 }, { passed: 0 })).toMatchObject({ bar: null, line: null, practiseNow: false });
    expect(todayModel({ dueNow: 30 }, { passed: 10 }).bar).toEqual({ shown: 10, filled: 3 });
  });

  it("this week: the TV's order and plain names; a dash for a week with no words", () => {
    const w = weekModel(demo.stats({ kind: "week" }));
    expect(w.rows.map((r) => r.title)).toEqual(["Unsure words", "Vague answers", "Filler words", "Starting over"]);
    expect(w.rows.find((r) => r.key === "restarts")!.sub).toBe("the one you didn’t practise");
    expect(w.rows.find((r) => r.key === "hedges")!.sub).toMatch(/^mostly “/);
    expect(w.rows.every((r) => /^\d+\.\d$/.test(r.rate))).toBe(true);
    const zero = { habits: { words: 0, lines: 0, hedges: { count: 0, per100: 0, ci95: [0, 0] as [number, number], breakdown: {} }, vague: { count: 0, per100: 0, ci95: [0, 0] as [number, number], breakdown: {} }, fillers: { count: 0, per100: 0, ci95: [0, 0] as [number, number], breakdown: {} }, restarts: { count: 0, per100: 0, ci95: [0, 0] as [number, number] }, trailingOff: { count: 0, per100: 0, ci95: [0, 0] as [number, number] }, yeahTics: { count: 0, per100: 0, ci95: [0, 0] as [number, number] } } };
    const z = weekModel(zero);
    expect(z.rows.every((r) => r.rate === DASH)).toBe(true);
    expect(z.note).toBe("No conversations from Bee this week yet");
  });

  it("habit hues follow the TV's families", () => {
    expect(["hedges", "hedge:i guess"].map(hueClass)).toEqual(["hue-hedges", "hue-hedges"]);
    expect(["filler:like", "fillers", "filler:um"].map(hueClass)).toEqual(["hue-fillers", "hue-fillers", "hue-fillers"]);
    expect(["vague", "restart", "restarts", "trailing"].map(hueClass)).toEqual(["hue-vague", "hue-restart", "hue-restart", ""]);
  });
});

describe("Progress: recent conversations", () => {
  const list = JSON.parse(readFileSync("fixtures/contract-v2/recaps.json", "utf8")) as RecapList;
  const one = list.recaps[0]!;
  const DAY = 86_400_000;
  const five: RecapList = { ...list, recaps: [0, 1, 2, 3, 4].map((i) => ({ ...one, id: `rcp_${i}`, startedAt: one.startedAt - i * DAY, setting: i === 1 ? { setting: "casual", source: "you", confidence: "high", reasons: ["you"] } : one.setting })) };

  it("at most three: when, the setting and the hub's headline", () => {
    const rows = recapRows(five, one.startedAt + 3_600_000, "America/Toronto");
    expect(rows.map((r) => r.id)).toEqual(["rcp_0", "rcp_1", "rcp_2"]);
    expect(rows[0]!.when).toBe("Today · 1:31 PM");
    expect(rows[1]).toMatchObject({ when: "Yesterday · 1:31 PM", setting: "Casual" });
    expect(rows[2]!.when).toBe("Sun Oct 18 · 1:31 PM");
    expect(rows[0]!.headline).toBe(one.headline.replace(/"([^"]*)"/g, "“$1”"));
    expect(recapRows(null, 0)).toEqual([]);
  });

  it("never carries the wearer's own moment, its rephrase or the narration", () => {
    const text = JSON.stringify(recapRows(five, one.startedAt));
    expect(one.moment).not.toBeNull();
    for (const s of [one.moment!.text, one.moment!.rephrase, one.narration, one.wristText]) expect(text).not.toContain(s);
  });

  it("the day is the phone's own time zone, 'today' the hub's clock", () => {
    const late = Date.UTC(2026, 9, 21, 3, 30); // Oct 20 23:30 in Toronto, Oct 21 in UTC
    expect(recapWhen(late, late, "America/Toronto")).toBe("Today · 11:30 PM");
    expect(recapWhen(late, late + 2 * 3_600_000, "America/Toronto")).toBe("Yesterday · 11:30 PM");
    expect(recapWhen(late, late, "UTC")).toBe("Today · 3:30 AM");
    expect(recapWhen(Number.NaN, late)).toBe(DASH);
  });
});

describe("Progress: errors in words", () => {
  it("403 is the pairing key, 5xx the hub, anything else the network", () => {
    expect(errorOf(403)).toBe("forbidden");
    expect(errorOf(503)).toBe("server");
    expect(errorOf(null)).toBe("offline");
    expect(errorOf(404)).toBe("offline");
    expect(errorText("forbidden")).toMatch(/QR/);
    expect(errorText("offline")).toBe("Can’t reach the TV’s hub right now.");
  });
});

describe("one Progress rule for the TV and the phone", () => {
  it("every verdict and role: the phone's card says the TV's role and pill (habitRole, habitPill)", () => {
    const verdicts: TransferHabit["verdict"][] = ["dropped", "no change", "rose", "too little data", "not drilled yet", "invalid"];
    const base = full.habits[0]!;
    for (const role of ["drilled", "control"] as const)
      for (const verdict of verdicts) {
        const h = { ...base, role, verdict } as TransferHabit;
        const c = habitCard(h, full.minWordsPerPeriod);
        expect([c.role, c.pill], `${role} ${verdict}`).toEqual([habitRole(h), habitPill(h)]);
      }
  });
  it("the phone has no copy of the rule: it imports the TV's", () => {
    const src = readFileSync("web/phone/src/progress.ts", "utf8");
    expect(src).toContain("role: habitRole(h),");
    expect(src).toContain("pill: habitPill(h),");
    expect(src).not.toMatch(/= "Starts at your first practice"|\? "To practise"|: "To practise"/);
  });
});
