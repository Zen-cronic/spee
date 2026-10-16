// Live-coaching policy: deterministic code decides whether a rule that fired becomes a wrist
// nudge. It reads structured fields only (rule, times, counts), never model text.
//
// Frozen numbers (docs/CONTRACT.md "Live mode policy"): off by default; turning it on lasts
// `minutes` (default 60, 1-180) and then turns itself off ("expired"). Nudges are at least 3 min
// apart, the same rule at most once per 10 min, at most 6 per hour and 20 per day. No nudge in a
// conversation's first 60 s, in quiet hours (22:00-08:00 local) or while a drill is active.
// Every suppression has a reason (nudge.skipped).
//
// Demo pace. Story durations (cooldowns, warm-up, the hour of the hourly cap) are multiplied by
// the demo pace when compared with the hub clock, so a paced demo keeps the same story. Live mode
// is pace 1. Mode expiry and quiet hours always use the hub clock unscaled.
import type { LiveMode, LiveModeRequest, NudgeRule, NudgeSkipReason } from "../contract.js";
import { localDate } from "../../real/deck.js";

export const MODE_DEFAULT_MINUTES = 60;
export const MODE_MAX_MINUTES = 180;
const HOUR = 3_600_000;

export interface PolicyConfig {
  quietHours: { startHour: number; endHour: number };
  warmupMs: number;
  cooldownMs: number;
  ruleCooldownMs: number;
  capPerHour: number;
  capPerDay: number;
}
export const DEFAULT_POLICY: PolicyConfig = { quietHours: { startHour: 22, endHour: 8 }, warmupMs: 60_000, cooldownMs: 180_000, ruleCooldownMs: 600_000, capPerHour: 6, capPerDay: 20 };

export type Decision = { allow: true } | { allow: false; reason: NudgeSkipReason; detail: string; retryAfterMs: number | null };

export interface DecideInput {
  rule: NudgeRule;
  now: number; // hub ms
  conversationMs: number; // story ms since the conversation started (ct), for the warm-up
  drillActive: boolean;
  wristDownUntil: number | null; // the wrist circuit is open until then
}

// "1 min 52 s", "42 s", "4 min".
export function humanMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

export function localHour(ms: number, tz?: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return Number(h) % 24;
}

export function inQuietHours(ms: number, q: { startHour: number; endHour: number }, tz?: string): boolean {
  const h = localHour(ms, tz);
  return q.startHour > q.endHour ? h >= q.startHour || h < q.endHour : h >= q.startHour && h < q.endHour;
}

export class LivePolicy {
  private enabled = false;
  private since: number | null = null;
  private expiresAt: number | null = null;
  private changedAt: number | null = null;
  private by: string | null = null;
  private reason: LiveMode["reason"] = "default";
  private rules: Record<NudgeRule, boolean>;
  private readonly defaultRules: Record<NudgeRule, boolean>;
  private sentAt: { at: number; rule: NudgeRule; day: string }[] = [];

  constructor(
    private opts: { pace: number; tz?: string; config?: PolicyConfig; fastRate?: boolean },
  ) {
    this.defaultRules = { "hedge-streak": true, "like-streak": true, monologue: true, "fast-rate": !!opts.fastRate };
    this.rules = { ...this.defaultRules };
  }

  get config(): PolicyConfig {
    return this.opts.config ?? DEFAULT_POLICY;
  }
  private scaled(ms: number) {
    return ms * this.opts.pace;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
  ruleEnabled(rule: NudgeRule): boolean {
    return this.rules[rule];
  }
  get expiry(): number | null {
    return this.enabled ? this.expiresAt : null;
  }

  mode(now: number): LiveMode {
    const c = this.config;
    return {
      enabled: this.enabled,
      since: this.since,
      expiresAt: this.expiresAt,
      changedAt: this.changedAt,
      by: this.by,
      reason: this.reason,
      rules: { ...this.rules },
      quietHours: { ...c.quietHours },
      warmupMs: c.warmupMs,
      cooldownMs: c.cooldownMs,
      ruleCooldownMs: c.ruleCooldownMs,
      capPerHour: c.capPerHour,
      capPerDay: c.capPerDay,
      sent: this.sentCounts(now),
    };
  }

  sentCounts(now: number) {
    const today = localDate(now, this.opts.tz);
    return { lastHour: this.sentAt.filter((s) => now - s.at < this.scaled(HOUR)).length, today: this.sentAt.filter((s) => s.day === today).length };
  }

  // POST /api/live/mode. The request is validated by the caller.
  set(req: LiveModeRequest, now: number): LiveMode {
    const by = req.by ?? "http";
    if (req.rules) for (const [k, v] of Object.entries(req.rules)) if (k in this.rules && typeof v === "boolean") this.rules[k as NudgeRule] = v;
    if (req.enabled) {
      const minutes = req.minutes ?? MODE_DEFAULT_MINUTES;
      this.enabled = true;
      this.since = now;
      this.expiresAt = now + minutes * 60_000;
      this.reason = "on";
    } else {
      this.enabled = false;
      this.expiresAt = null;
      this.reason = "off";
    }
    this.changedAt = now;
    this.by = by;
    return this.mode(now);
  }

  // Auto-off: "expired" (time is up) or "wrist-down" (the wrist circuit opened).
  turnOff(reason: "expired" | "wrist-down", now: number): LiveMode | null {
    if (!this.enabled) return null;
    this.enabled = false;
    this.expiresAt = null;
    this.reason = reason;
    this.changedAt = now;
    this.by = "auto";
    return this.mode(now);
  }

  expireIfDue(now: number): LiveMode | null {
    return this.enabled && this.expiresAt != null && now >= this.expiresAt ? this.turnOff("expired", now) : null;
  }

  decide(i: DecideInput): Decision {
    const c = this.config;
    const skip = (reason: NudgeSkipReason, detail: string, retryAfterMs: number | null = null): Decision => ({ allow: false, reason, detail, retryAfterMs: retryAfterMs == null ? null : Math.max(0, Math.round(retryAfterMs)) });
    this.expireIfDue(i.now);
    if (!this.enabled) {
      if (this.reason === "wrist-down") return skip("wrist-down", "live coaching turned itself off: the wrist channel failed 3 times in a row");
      return skip("off", "live coaching is off: turn it on to get wrist nudges");
    }
    if (i.wristDownUntil != null && i.now < i.wristDownUntil) return skip("wrist-down", "the wrist channel failed 3 times in a row; it is retried later", i.wristDownUntil - i.now);
    if (inQuietHours(i.now, c.quietHours, this.opts.tz)) return skip("quiet-hours", `quiet hours (${String(c.quietHours.startHour).padStart(2, "0")}:00 to ${String(c.quietHours.endHour).padStart(2, "0")}:00): no nudges`);
    if (i.drillActive) return skip("drill-active", "a drill is in progress: no nudges while drilling");
    if (i.conversationMs < c.warmupMs) return skip("warmup", `the conversation started ${humanMs(i.conversationMs)} ago; no nudges in the first ${humanMs(c.warmupMs)}`, this.scaled(c.warmupMs - i.conversationMs));
    const today = localDate(i.now, this.opts.tz);
    const day = this.sentAt.filter((s) => s.day === today);
    if (day.length >= c.capPerDay) return skip("cap-day", `${day.length} nudges today (the cap is ${c.capPerDay} a day)`);
    const hour = this.sentAt.filter((s) => i.now - s.at < this.scaled(HOUR));
    if (hour.length >= c.capPerHour) return skip("cap-hour", `${hour.length} nudges in the last hour (the cap is ${c.capPerHour} an hour)`, hour[0]!.at + this.scaled(HOUR) - i.now);
    const last = this.sentAt[this.sentAt.length - 1];
    if (last && i.now - last.at < this.scaled(c.cooldownMs)) {
      const ago = (i.now - last.at) / this.opts.pace;
      return skip("cooldown", `a nudge went out ${humanMs(ago)} ago; nudges are at least ${humanMs(c.cooldownMs)} apart`, last.at + this.scaled(c.cooldownMs) - i.now);
    }
    const lastRule = [...this.sentAt].reverse().find((s) => s.rule === i.rule);
    if (lastRule && i.now - lastRule.at < this.scaled(c.ruleCooldownMs)) {
      const ago = (i.now - lastRule.at) / this.opts.pace;
      return skip("rule-cooldown", `the same rule nudged ${humanMs(ago)} ago; each rule nudges at most once per ${humanMs(c.ruleCooldownMs)}`, lastRule.at + this.scaled(c.ruleCooldownMs) - i.now);
    }
    return { allow: true };
  }

  recordSent(rule: NudgeRule, now: number) {
    this.sentAt.push({ at: now, rule, day: localDate(now, this.opts.tz) });
    const keepFrom = now - Math.max(this.scaled(HOUR), 26 * HOUR);
    this.sentAt = this.sentAt.filter((s) => s.at >= keepFrom);
  }
}

export function modeNarration(m: LiveMode, tz?: string): string {
  if (m.enabled) {
    const mins = m.expiresAt != null && m.since != null ? Math.round((m.expiresAt - m.since) / 60_000) : MODE_DEFAULT_MINUTES;
    return `Live coaching is on for ${mins} minutes. I'll tap your wrist if a habit streaks.`;
  }
  if (m.reason === "expired") return "Live coaching has turned itself off after its time ran out.";
  if (m.reason === "wrist-down") return "Live coaching turned itself off because the wrist channel kept failing.";
  void tz;
  return "Live coaching is off. Your conversations still get a recap.";
}

export function clockTime(ms: number, tz?: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}
