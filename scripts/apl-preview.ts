// An APPROXIMATE preview of the Speaking Mirror APL screens (alexa/apl/speaking-mirror.json), for
// screenshots without a device: a small interpreter for the parts of APL the document uses
// (Container, Frame, Text, VectorGraphic, its own layouts, resources with `when`, data binding),
// written out as HTML, one file per screen and viewport, with synthetic datasources from the real
// screen builders (src/alexa/apl.ts). Fonts and line breaking differ from a device: check a real
// Fire TV or Echo Show (or the developer console's APL preview) before judging fine detail.
//
//   npm run alexa:apl:preview                 # HTML in out/apl-preview/
//   npm run alexa:apl:preview -- --png        # and PNG screenshots (headless Chrome: CHROME_BIN or google-chrome)
//   npm run alexa:apl:preview -- --png --out <dir>
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { aplDocument, checkingScreen, drillScreen, EMPTY, progressScreen, verdictScreen, type Screen } from "../src/alexa/apl.js";
import { REPO_ROOT } from "../src/hub/static.js";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Viewport {
  id: string;
  name: string;
  mode: "tv" | "hub";
  width: number; // dp
  height: number; // dp
  scale: number; // px per dp in the screenshot
}
export const VIEWPORTS: Viewport[] = [
  { id: "firetv-1080p", name: "Fire TV, tvLandscapeXLarge 960x540 dp (1920x1080 px)", mode: "tv", width: 960, height: 540, scale: 2 },
  { id: "echoshow-8", name: "Echo Show 8/10, hubLandscapeLarge 1280x800 dp", mode: "hub", width: 1280, height: 800, scale: 1 },
  { id: "echoshow-5", name: "Echo Show 5, hubLandscapeSmall 960x480 dp", mode: "hub", width: 960, height: 480, scale: 1 },
];

const SENTENCE = "I'll send the report to the team on Friday.";
const NEXT = "We can ship the update on Monday morning.";
const g = (over: Json) => ({ graderVersion: 1, pass: false, reasons: [], checks: [], habit: { kind: "hedge", label: "unsure words", hits: 0, found: [] }, fillerCount: 0, fillers: [], hedgeCount: 0, hedges: [], contentMatch: 1, contentThreshold: 0.8, missing: [], fuzzy: [], required: [], ...over });
export const SAMPLES: { id: string; screen: Screen }[] = [
  { id: "drill", screen: drillScreen({ resay: SENTENCE }) },
  { id: "checking", screen: checkingScreen({ resay: SENTENCE }) },
  { id: "verdict-pass", screen: verdictScreen({ kind: "pass", next: { resay: NEXT } }) },
  { id: "verdict-not-yet", screen: verdictScreen({ kind: "fail", grade: g({ checks: [{ rule: "habit", ok: false, detail: "" }], habit: { kind: "hedge", label: "unsure words", hits: 1, found: ["i guess"] } }), next: { resay: SENTENCE } }) },
  {
    id: "how-am-i-doing",
    screen: progressScreen({ narration: "This week you said unsure words 1.2 times out of every 100 words, down from 2.6. Live coaching is off.", week: { words: 4120, hedgesPer100: 1.2, likesPer100: 0.6, vaguePer100: 0.2, topHabit: { key: "hedges", label: "unsure words", per100: 1.24 } }, drills: { dueNow: 2, nextCardId: null } }),
  },
  { id: "caught-up", screen: EMPTY.caughtUp() },
];

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

class Ctx {
  constructor(
    readonly res: Record<string, string>,
    readonly scope: Record<string, unknown>,
    readonly vp: Viewport,
  ) {}
  with(extra: Record<string, unknown>) {
    return new Ctx(this.res, { ...this.scope, ...extra }, this.vp);
  }
  // One ${...} expression: the document's own, so plain JS after @resource -> a quoted value.
  expr(src: string): unknown {
    const js = src.replace(/@([A-Za-z]+)/g, (_m, k: string) => JSON.stringify(this.res[k] ?? ""));
    const names = Object.keys(this.scope);
    return new Function(...names, `return (${js});`)(...names.map((n) => this.scope[n]));
  }
  val(v: unknown): unknown {
    if (typeof v !== "string") return v;
    if (/^@[A-Za-z]+$/.test(v)) return this.res[v.slice(1)];
    const whole = /^\$\{([^}]*)\}$/.exec(v);
    if (whole) return this.expr(whole[1]!);
    return v.replace(/\$\{([^}]*)\}/g, (_m, e: string) => String(this.expr(e) ?? ""));
  }
  px(v: unknown): string | null {
    const x = this.val(v);
    if (x === undefined || x === null || x === "") return null;
    if (typeof x === "number") return `${x * this.vp.scale}px`;
    const s = String(x);
    if (s.endsWith("%")) return s;
    if (s === "100vw" || s === "100vh") return "100%";
    const n = parseFloat(s);
    return Number.isFinite(n) ? `${n * this.vp.scale}px` : null;
  }
}

function resources(doc: Json, vp: Viewport): Record<string, string> {
  const out: Record<string, string> = {};
  const ctx = new Ctx({}, { viewport: { width: vp.width, height: vp.height, mode: vp.mode } }, vp);
  for (const r of doc.resources) {
    if (r.when && !ctx.val(r.when)) continue;
    for (const group of ["colors", "dimensions", "numbers", "strings"]) Object.assign(out, r[group] ?? {});
  }
  return out;
}

function box(c: Json, ctx: Ctx): string {
  const css: string[] = [];
  const set = (k: string, v: string | null) => v !== null && css.push(`${k}:${v}`);
  set("width", ctx.px(c.width));
  set("height", ctx.px(c.height));
  for (const side of ["Left", "Right", "Top", "Bottom"]) set(`padding-${side.toLowerCase()}`, ctx.px(c[`padding${side}`]));
  if (c.grow) css.push(`flex-grow:${c.grow}`);
  const display = ctx.val(c.display);
  if (display === "none") css.push("display:none");
  return css.join(";");
}

function node(c: Json, ctx: Ctx, doc: Json): string {
  if (c.when !== undefined && !ctx.val(c.when)) return "";
  const layout = doc.layouts[c.type];
  if (layout) {
    const params: Record<string, unknown> = {};
    for (const p of layout.parameters ?? []) params[p.name] = c[p.name] !== undefined ? ctx.val(c[p.name]) : p.default;
    const inner = ctx.with(params);
    return (layout.items ?? [layout.item]).map((i: Json) => node(i, inner, doc)).join("");
  }
  const style = box(c, ctx);
  switch (c.type) {
    case "Container": {
      const flex = [`display:flex`, `flex-direction:${c.direction === "row" ? "row" : "column"}`, c.alignItems ? `align-items:${c.alignItems === "start" ? "flex-start" : c.alignItems}` : "", c.justifyContent ? `justify-content:${c.justifyContent}` : "", "box-sizing:border-box", "min-height:0"].filter(Boolean).join(";");
      let kids: string;
      if (c.data !== undefined) {
        const data = (ctx.val(c.data) as unknown[]) ?? [];
        kids = data.map((d, index) => (c.items ?? [c.item]).map((i: Json) => node(i, ctx.with({ data: d, index }), doc)).join("")).join("");
      } else kids = (c.items ?? []).map((i: Json) => node(i, ctx, doc)).join("");
      return `<div style="${flex};${style}">${kids}</div>`;
    }
    case "Frame": {
      const css = [`box-sizing:border-box`, `display:flex`, `flex-direction:column`, `background:${ctx.val(c.backgroundColor) ?? "transparent"}`, `border-radius:${ctx.px(c.borderRadius) ?? 0}`, c.borderWidth ? `border:${ctx.px(c.borderWidth)} solid ${ctx.val(c.borderColor)}` : "", `flex-shrink:0`].filter(Boolean).join(";");
      const kids = (c.items ?? (c.item ? [c.item] : [])).map((i: Json) => node(i, ctx, doc)).join("");
      return `<div style="${css};${style}">${kids}</div>`;
    }
    case "Text": {
      const lines = ctx.val(c.maxLines);
      const css = [`color:${ctx.val(c.color)}`, `font-size:${ctx.px(c.fontSize)}`, `font-weight:${c.fontWeight ?? 400}`, `line-height:1.2`, lines ? `display:-webkit-box;-webkit-line-clamp:${lines};-webkit-box-orient:vertical;overflow:hidden` : ""].filter(Boolean).join(";");
      return `<div style="${css};${style}">${esc(ctx.val(c.text))}</div>`;
    }
    case "VectorGraphic": {
      const gfx = doc.graphics[c.source];
      const params: Record<string, unknown> = {};
      for (const p of gfx.parameters ?? []) params[p.name] = ctx.val(c[p.name]);
      const gctx = ctx.with(params);
      const paths = gfx.items.map((i: Json) => `<path fill="${esc(gctx.val(i.fill))}" d="${esc(i.pathData)}"/>`).join("");
      return `<svg style="flex-shrink:0;${style}" viewBox="0 0 ${gfx.viewportWidth} ${gfx.viewportHeight}">${paths}</svg>`;
    }
    default:
      return `<div style="color:red">unsupported ${esc(c.type)}</div>`;
  }
}

export function renderHtml(screen: Screen, vp: Viewport, label: string): string {
  const doc: Json = aplDocument();
  const res = resources(doc, vp);
  const ctx = new Ctx(res, { payload: { screen }, viewport: { width: vp.width, height: vp.height, mode: vp.mode } }, vp);
  const body = doc.mainTemplate.items.map((i: Json) => node(i, ctx, doc)).join("");
  const W = vp.width * vp.scale;
  const H = vp.height * vp.scale;
  const cap = Math.round(14 * vp.scale);
  return `<!doctype html><meta charset="utf-8"><title>${esc(label)}</title>
<style>html,body{margin:0;background:#000;font-family:"Amazon Ember","Inter","Helvetica Neue",Arial,sans-serif}#vp{width:${W}px;height:${H}px;overflow:hidden;position:relative}#vp>div{width:100%;height:100%}#cap{height:${cap * 2.4}px;display:flex;align-items:center;padding:0 ${cap}px;font:${cap}px/1 monospace;color:#999;background:#222}</style>
<div id="vp">${body}</div><div id="cap">APPROXIMATE PREVIEW (not a device render) · ${esc(label)}</div>`;
}

function chrome(): string | null {
  for (const c of [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser"].filter(Boolean) as string[]) {
    if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const oi = args.indexOf("--out");
  const out = oi >= 0 ? resolve(args[oi + 1]!) : join(REPO_ROOT, "out/apl-preview");
  const png = args.includes("--png");
  mkdirSync(out, { recursive: true });
  const bin = png ? chrome() : null;
  if (png && !bin) console.error("apl-preview: no Chrome found (set CHROME_BIN); writing HTML only");
  for (const vp of VIEWPORTS) {
    for (const s of SAMPLES) {
      const name = `${vp.id}-${s.id}`;
      const html = join(out, `${name}.html`);
      writeFileSync(html, renderHtml(s.screen, vp, `${s.id} · ${vp.id} (${vp.width}x${vp.height} dp)`));
      if (bin) {
        const H = vp.height * vp.scale + Math.round(14 * vp.scale * 2.4);
        const r = spawnSync(bin, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${join(out, ".chrome")}`, `--window-size=${vp.width * vp.scale},${H}`, `--screenshot=${join(out, `${name}.png`)}`, `file://${html}`], { encoding: "utf8", timeout: 30_000 });
        if (r.status !== 0) console.error(`apl-preview: ${name}: chrome exited ${r.status}`);
      }
      console.log(`${name}${bin ? " (png)" : ""}`);
    }
  }
  console.log(`apl-preview: ${out}`);
}
