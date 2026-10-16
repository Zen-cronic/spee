// Live-mode policy (src/hub/live/policy.ts): off by default, auto-expiry, cooldowns, caps, quiet
// hours, warm-up, drills, wrist-down, and the demo pace. Every suppression has a reason.
import { describe, expect, it } from "vitest";
import { humanMs, inQuietHours, LivePolicy, modeNarration } from "../src/hub/live/policy.js";

const TZ = "America/Toronto";
const NOON = Date.parse("2026-10-20T12:00:00-04:00");
const MIN = 60_000;
const ok = { conversationMs: 120_000, drillActive: false, wristDownUntil: null };

describe("live mode", () => {
  it("is off by default, and a rule that fires is skipped with reason off", () => {
    const p = new LivePolicy({ pace: 1, tz: TZ });
    expect(p.mode(NOON)).toMatchObject({ enabled: false, reason: "default", since: null, expiresAt: null, rules: { "hedge-streak": true, "like-streak": true, monologue: true, "fast-rate": false } });
    expect(p.decide({ rule: "hedge-streak", now: NOON, ...ok })).toMatchObject({ allow: false, reason: "off" });
  });
  it("turns on for 60 minutes by default (frozen numbers), then expires", () => {
    const p = new LivePolicy({ pace: 1, tz: TZ });
    const m = p.set({ enabled: true, by: "alexa" }, NOON);
    expect(m).toMatchObject({ enabled: true, since: NOON, expiresAt: NOON + 60 * MIN, by: "alexa", reason: "on", warmupMs: 60_000, cooldownMs: 180_000, ruleCooldownMs: 600_000, capPerHour: 6, capPerDay: 20, quietHours: { startHour: 22, endHour: 8 } });
    expect(modeNarration(m)).toBe("Live coaching is on for 60 minutes. I'll tap your wrist if a habit streaks.");
    expect(p.expireIfDue(NOON + 59 * MIN)).toBeNull();
    expect(p.expireIfDue(NOON + 60 * MIN)).toMatchObject({ enabled: false, reason: "expired", by: "auto" });
    expect(p.decide({ rule: "hedge-streak", now: NOON + 61 * MIN, ...ok })).toMatchObject({ reason: "off" });
  });
  it("custom minutes and rule switches; turning off", () => {
    const p = new LivePolicy({ pace: 1, tz: TZ });
    expect(p.set({ enabled: true, minutes: 15, rules: { "fast-rate": true, monologue: false } }, NOON)).toMatchObject({ expiresAt: NOON + 15 * MIN, rules: { "fast-rate": true, monologue: false } });
    expect(p.set({ enabled: false }, NOON + MIN)).toMatchObject({ enabled: false, reason: "off", expiresAt: null });
  });
});

describe("suppressions", () => {
  const on = (pace = 1) => {
    const p = new LivePolicy({ pace, tz: TZ });
    p.set({ enabled: true, minutes: 180 }, NOON);
    return p;
  };
  it("warm-up: no nudge in the first 60 s of a conversation", () => {
    const d = on().decide({ rule: "hedge-streak", now: NOON, ...ok, conversationMs: 42_000 });
    expect(d).toMatchObject({ allow: false, reason: "warmup", retryAfterMs: 18_000 });
    expect(on().decide({ rule: "hedge-streak", now: NOON, ...ok })).toEqual({ allow: true });
  });
  it("quiet hours 22:00-08:00 local", () => {
    expect(inQuietHours(Date.parse("2026-10-20T22:30:00-04:00"), { startHour: 22, endHour: 8 }, TZ)).toBe(true);
    expect(inQuietHours(Date.parse("2026-10-20T07:59:00-04:00"), { startHour: 22, endHour: 8 }, TZ)).toBe(true);
    expect(inQuietHours(Date.parse("2026-10-20T08:00:00-04:00"), { startHour: 22, endHour: 8 }, TZ)).toBe(false);
    const p = new LivePolicy({ pace: 1, tz: TZ });
    const night = Date.parse("2026-10-20T23:00:00-04:00");
    p.set({ enabled: true }, night);
    expect(p.decide({ rule: "monologue", now: night, ...ok })).toMatchObject({ reason: "quiet-hours", retryAfterMs: null });
  });
  it("drill active and wrist down", () => {
    expect(on().decide({ rule: "hedge-streak", now: NOON, ...ok, drillActive: true })).toMatchObject({ reason: "drill-active" });
    expect(on().decide({ rule: "hedge-streak", now: NOON, ...ok, wristDownUntil: NOON + 5 * MIN })).toMatchObject({ reason: "wrist-down", retryAfterMs: 5 * MIN });
    const p = on();
    p.turnOff("wrist-down", NOON);
    expect(p.decide({ rule: "hedge-streak", now: NOON, ...ok })).toMatchObject({ reason: "wrist-down" });
  });
  it("3 min between any two nudges (cooldown before rule-cooldown), 10 min per rule", () => {
    const p = on();
    p.recordSent("hedge-streak", NOON);
    const d = p.decide({ rule: "hedge-streak", now: NOON + 112_000, ...ok });
    expect(d).toEqual({ allow: false, reason: "cooldown", detail: "a nudge went out 1 min 52 s ago; nudges are at least 3 min apart", retryAfterMs: 68_000 });
    expect(p.decide({ rule: "hedge-streak", now: NOON + 4 * MIN, ...ok })).toMatchObject({ reason: "rule-cooldown", retryAfterMs: 6 * MIN });
    expect(p.decide({ rule: "like-streak", now: NOON + 4 * MIN, ...ok })).toEqual({ allow: true });
    expect(p.decide({ rule: "hedge-streak", now: NOON + 10 * MIN, ...ok })).toEqual({ allow: true });
  });
  it("caps: 6 per hour, 20 per day", () => {
    const p = on();
    const rules = ["hedge-streak", "like-streak", "monologue", "fast-rate"] as const;
    for (let i = 0; i < 6; i++) p.recordSent(rules[i % 4]!, NOON - 50 * MIN + i * 10 * MIN - 1);
    const d = p.decide({ rule: "monologue", now: NOON + 9 * MIN, ...ok });
    expect(d).toMatchObject({ allow: false, reason: "cap-hour" });
    expect(p.mode(NOON + 9 * MIN).sent).toEqual({ lastHour: 6, today: 6 });
    const q = new LivePolicy({ pace: 1, tz: TZ });
    const morning = Date.parse("2026-10-20T08:00:00-04:00");
    q.set({ enabled: true, minutes: 180 }, morning);
    for (let i = 0; i < 20; i++) q.recordSent(rules[i % 4]!, morning + i * 11 * MIN);
    const late = morning + 20 * 11 * MIN + 30 * MIN;
    q.set({ enabled: true }, late);
    expect(q.decide({ rule: "hedge-streak", now: late, ...ok })).toMatchObject({ reason: "cap-day", detail: "20 nudges today (the cap is 20 a day)" });
  });
  it("demo pace scales the story durations but not mode expiry", () => {
    const p = on(0.02);
    p.recordSent("hedge-streak", NOON);
    // 111 story seconds after the nudge = 2.22 real seconds at pace 0.02.
    const d = p.decide({ rule: "hedge-streak", now: NOON + 2220, ...ok });
    expect(d).toMatchObject({ reason: "cooldown", detail: "a nudge went out 1 min 51 s ago; nudges are at least 3 min apart", retryAfterMs: 1380 });
    expect(p.decide({ rule: "like-streak", now: NOON + 3600, ...ok })).toEqual({ allow: true });
    expect(p.mode(NOON).expiresAt).toBe(NOON + 180 * MIN);
  });
  it("formats durations for narration", () => {
    expect(humanMs(42_000)).toBe("42 s");
    expect(humanMs(112_000)).toBe("1 min 52 s");
    expect(humanMs(180_000)).toBe("3 min");
  });
});
