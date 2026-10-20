// Which Alexa surfaces really reached the skill: the interfaces a device lists, the APL version it
// runs and its viewport. The plugin logs this once per distinct device kind (`alexa.device`), so a
// real-device run shows, for example, whether the Fire TV or the Alexa iPhone app can show APL.
// Never the device id, the user id or anything said: only Amazon's interface names and numbers.
//
// https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-support-for-your-skill.html
import type { AlexaRequestEnvelope } from "./types.js";

export interface DeviceSurface {
  interfaces: string[]; // the keys of context.System.device.supportedInterfaces, sorted
  apl: string | null; // supportedInterfaces["Alexa.Presentation.APL"].runtime.maxVersion
  viewport: string | null; // context.Viewport as "<mode> <width>x<height> <shape>"
}

const NAME = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;
const WORD = /^[A-Z_]{1,16}$/;
const VERSION = /^\d{4}\.\d{1,2}$/;
const MAX_INTERFACES = 12;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const px = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 100_000 ? v : null);

/** The device's interfaces, APL version and viewport, from the request alone. Odd values are dropped. */
export function deviceSurface(env: AlexaRequestEnvelope): DeviceSurface {
  const supported = obj(env.context?.System?.device?.supportedInterfaces) ?? {};
  const interfaces = Object.keys(supported).filter((k) => NAME.test(k)).sort().slice(0, MAX_INTERFACES);
  const max = obj(obj(supported["Alexa.Presentation.APL"])?.runtime)?.maxVersion;
  const vp = obj(env.context?.Viewport);
  const w = px(vp?.pixelWidth);
  const h = px(vp?.pixelHeight);
  const mode = typeof vp?.mode === "string" && WORD.test(vp.mode) ? vp.mode : null;
  const shape = typeof vp?.shape === "string" && WORD.test(vp.shape) ? vp.shape : null;
  const viewport = w && h ? [mode, `${w}x${h}`, shape].filter(Boolean).join(" ") : null;
  return { interfaces, apl: typeof max === "string" && VERSION.test(max) ? max : null, viewport };
}

/** A recorder that returns a request's surface the first time that kind of device is seen, else null. */
export function deviceRecorder(max = 32): (env: AlexaRequestEnvelope) => DeviceSurface | null {
  const seen = new Set<string>();
  return (env) => {
    const d = deviceSurface(env);
    const key = JSON.stringify(d);
    if (seen.has(key) || seen.size >= max) return null;
    seen.add(key);
    return d;
  };
}
