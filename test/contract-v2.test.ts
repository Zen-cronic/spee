// Contract v2: the fixtures and the doc blocks match the typed examples, the topic table matches
// contract.ts, and the examples keep the privacy rules (wearer-only text, others counted only).
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_TOOLS, NUDGE_HOP_ORDER, RECAP_MOMENT_MAX_WORDS, ROOM_TOPICS, SEQUENCED_TOPICS, V2_TOPICS, WRIST_TEXT_MAX, type CoachThresholds } from "../src/hub/contract.js";
import { contractV2Fixtures, fixtureJson, fixtureRefs, syncFixtureBlocks } from "../src/hub/contractExamples.js";

const DIR = "fixtures/contract-v2";
const doc = readFileSync("docs/CONTRACT.md", "utf8");
const files = contractV2Fixtures();

describe("fixtures/contract-v2", () => {
  it("are exactly the typed examples (run npm run contract:fixtures after editing src/hub/contractExamples.ts)", () => {
    expect(readdirSync(DIR).sort()).toEqual(Object.keys(files).sort());
    for (const [name, v] of Object.entries(files)) expect(readFileSync(`${DIR}/${name}`, "utf8"), name).toBe(fixtureJson(v));
  });
  it("docs/CONTRACT.md embeds them unchanged, and links every file", () => {
    expect(syncFixtureBlocks(doc, files)).toBe(doc);
    expect(fixtureRefs(doc).length).toBeGreaterThanOrEqual(12);
    for (const f of Object.keys(files)) expect(doc.includes(f), f).toBe(true);
  });
  it("the doc's topic table matches contract.ts", () => {
    const table = /<!-- topics:v2 -->([\s\S]*?)<!-- \/topics:v2 -->/.exec(doc)![1]!;
    const rows = [...table.matchAll(/^\| `([\w.]+)` \| (sequenced|room) \|/gm)].map((m) => [m[1], m[2]]);
    expect(rows.filter((r) => r[1] === "sequenced").map((r) => r[0])).toEqual([...V2_TOPICS]);
    expect(rows.filter((r) => r[1] === "room").map((r) => r[0])).toEqual([...ROOM_TOPICS]);
  });
  it("replayed events are sequenced contract topics, in time order", () => {
    for (const f of ["events-live.json", "events-practice.json"]) {
      const evs = (files[f] as { events: { atMs: number; topic: string }[] }).events;
      expect(evs.every((e) => (SEQUENCED_TOPICS as readonly string[]).includes(e.topic)), f).toBe(true);
      expect(evs.map((e) => e.atMs)).toEqual([...evs.map((e) => e.atMs)].sort((a, b) => a - b));
    }
    const story = (files["events-live.json"] as { events: { atMs: number; topic: string }[] }).events;
    const windows = story.filter((e) => e.topic === "live.window").map((e) => e.atMs);
    for (let i = 1; i < windows.length; i++) expect(windows[i]! - windows[i - 1]!).toBeGreaterThanOrEqual(3000);
  });
});

describe("privacy in the v2 examples", () => {
  const story = (files["events-live.json"] as { events: { topic: string; payload: any }[] }).events;
  const nudge = story.find((e) => e.topic === "nudge.sent")!.payload.nudge;
  const recap = files["recap.json"] as any;
  it("wrist text is generated, short and starts [coach]", () => {
    for (const t of [nudge.text, recap.wristText]) {
      expect(t.length).toBeLessThanOrEqual(WRIST_TEXT_MAX);
      expect(t.startsWith("[coach] ")).toBe(true);
    }
  });
  it("the recap moment is the wearer's own short line", () => {
    expect(recap.moment.text.split(/\s+/).length).toBeLessThanOrEqual(RECAP_MOMENT_MAX_WORDS);
  });
  it("other speakers are counts only, and live windows carry no text", () => {
    for (const e of story.filter((x) => x.topic === "live.window")) {
      const w = e.payload.window;
      expect(Object.values(w.others).every((v) => typeof v === "number")).toBe(true);
      const strings: string[] = [];
      JSON.stringify(w, (_k, v) => (typeof v === "string" && strings.push(v), v));
      expect(strings.every((s) => /^(demo-[\w-]+|en|fr|mixed|hedge-streak|like-streak|monologue|fast-rate|count|ms|wpm)$/.test(s)), strings.join("|")).toBe(true);
    }
  });
  it("nudge hops are in order and latencyMs is their difference", () => {
    const h = nudge.hops;
    const ts = NUDGE_HOP_ORDER.map((k) => h[k] as number);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(nudge.latencyMs).toEqual({ bee: h.beeAt - h.spokenAt, detect: h.detectedAt - h.beeAt, todo: h.todoAt - h.detectedAt, total: h.alarmAt - h.spokenAt });
  });
  it("examples name only the synthetic wearer", () => {
    const all = JSON.stringify(files);
    expect(all).toContain("SYNTHETIC");
    expect(all).not.toMatch(/\bSam\b/);
  });
});

describe("MCP tools and the principles template", () => {
  it("MCP tool names are unique snake_case and each maps to a documented route", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of MCP_TOOLS) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(doc.includes(t.route.split("?")[0]!.replace("<id>", "")), t.route).toBe(true);
    }
  });
  it("coach/principles.template.md ends with a thresholds block packet A can read", () => {
    const md = readFileSync("coach/principles.template.md", "utf8");
    const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)];
    const t = JSON.parse(blocks.at(-1)![1]!) as CoachThresholds;
    expect(t.version).toBe(1);
    expect(Object.keys(t).sort()).toEqual(["hedges", "like", "monologue", "pause", "pitch", "rate", "recap", "version", "volume"]);
    expect(t.pitch).toEqual({ minHz: 70, maxHz: 400, monotoneSemitones: 3 });
    expect(t.monologue.nudgeMs).toBe(90_000);
    for (const s of ["## Rate", "## Volume", "## Melody and pitch", "## Tonality", "## Pause", "## Clarity: hedges", "## Clarity: vague answers", "## Turn-taking and monologue length"]) expect(md).toContain(s);
  });
});
