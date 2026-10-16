// Alexa request signature verification (packet C stretch, src/alexa/signature.ts), with a throwaway
// CA and an echo-api.amazon.com leaf made by the openssl CLI, plus the plugin wiring (public
// requests only). Skipped when openssl is not installed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign, X509Certificate } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlexaPlugin } from "../src/alexa/plugin.js";
import { certUrlOk, signatureVerifier } from "../src/alexa/signature.js";
import { createPlugins } from "../src/hub/plugins.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { raw } from "./helpers-http.js";

let hasOpenssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  hasOpenssl = false;
}

const URL_OK = "https://s3.amazonaws.com/echo.api/echo-api-cert-test.pem";
let dir = "";
let chainPem = "";
let leafKey = "";
let ca: X509Certificate;

beforeAll(() => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), "alexa-sig-"));
  const o = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "ignore" });
  o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  o("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=echo-api.amazon.com");
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:echo-api.amazon.com\n");
  o("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "ext.cnf");
  chainPem = readFileSync(join(dir, "leaf.pem"), "utf8") + readFileSync(join(dir, "ca.pem"), "utf8");
  leafKey = readFileSync(join(dir, "leaf.key"), "utf8");
  ca = new X509Certificate(readFileSync(join(dir, "ca.pem")));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const body = Buffer.from(JSON.stringify({ version: "1.0", request: { type: "LaunchRequest" } }));
const sigOf = (b: Buffer) => sign("sha256", b, leafKey).toString("base64");
const verifier = (o: { roots?: X509Certificate[]; now?: () => number } = {}) => signatureVerifier({ fetchChain: async () => chainPem, roots: o.roots ?? [ca], now: o.now });

describe("SignatureCertChainUrl rules", () => {
  it.each([
    ["https://s3.amazonaws.com/echo.api/echo-api-cert.pem", true],
    ["https://s3.amazonaws.com:443/echo.api/echo-api-cert.pem", true],
    ["https://S3.AMAZONAWS.COM/echo.api/echo-api-cert.pem", true],
    ["https://s3.amazonaws.com/echo.api/../echo.api/echo-api-cert.pem", true],
    ["http://s3.amazonaws.com/echo.api/echo-api-cert.pem", false],
    ["https://notamazon.com/echo.api/echo-api-cert.pem", false],
    ["https://s3.amazonaws.com/EcHo.aPi/echo-api-cert.pem", false],
    ["https://s3.amazonaws.com/invalid.path/echo-api-cert.pem", false],
    ["https://s3.amazonaws.com:563/echo.api/echo-api-cert.pem", false],
  ])("%s -> %s", (u, ok) => expect(certUrlOk(u)).toBe(ok));
});

describe.skipIf(!hasOpenssl)("signature", () => {
  it("accepts a body signed by the echo-api leaf of a trusted chain", async () => {
    expect(await verifier()({ signaturecertchainurl: URL_OK, "signature-256": sigOf(body) }, body)).toEqual({ ok: true });
  });
  it("rejects a changed body, a missing signature, a bad URL, an untrusted root and an expired chain", async () => {
    const h = { signaturecertchainurl: URL_OK, "signature-256": sigOf(body) };
    expect((await verifier()(h, Buffer.from(body.toString().replace("Launch", "Intent")))).ok).toBe(false);
    expect(await verifier()({ signaturecertchainurl: URL_OK }, body)).toEqual({ ok: false, reason: "no Signature-256 header" });
    expect(await verifier()({ ...h, signaturecertchainurl: "https://evil.test/echo.api/x.pem" }, body)).toEqual({ ok: false, reason: "bad SignatureCertChainUrl" });
    expect(await verifier({ roots: [] })(h, body)).toEqual({ ok: false, reason: "the certificate chain does not reach a trusted root" });
    expect(await verifier({ now: () => Date.now() + 5 * 86_400_000 })(h, body)).toEqual({ ok: false, reason: "a certificate in the chain is not valid now" });
  });
});

describe.skipIf(!hasOpenssl)("POST /alexa with the signature check on", () => {
  const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
  let s: HubServer;
  beforeAll(async () => {
    const plugins = createPlugins().map((p) => (p.name === "alexa" ? createAlexaPlugin({ skillId: SKILL, verifySignature: verifier() }) : p));
    s = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.05, stateDir: null }), plugins, pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
  });
  afterAll(async () => s?.close());
  const help = () => {
    const e = JSON.parse(readFileSync(new URL("../alexa/fixtures/help.json", import.meta.url), "utf8")).request;
    e.request.timestamp = new Date().toISOString();
    return Buffer.from(JSON.stringify(e));
  };
  const tunnel = { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", host: "bee-coach.example.app" };
  it("a signed public request passes; an unsigned one is 400; a LAN request is not signature-checked", async () => {
    const b = help();
    const ok = await raw(s.port, "/alexa", { method: "POST", headers: { ...tunnel, signaturecertchainurl: URL_OK, "signature-256": sigOf(b) }, body: b.toString() });
    expect(ok.status).toBe(200);
    const unsigned = await raw(s.port, "/alexa", { method: "POST", headers: tunnel, body: b.toString() });
    expect(unsigned.status).toBe(400);
    expect(JSON.parse(unsigned.text)).toMatchObject({ error: "alexa_rejected", message: "bad SignatureCertChainUrl" });
    expect((await raw(s.port, "/alexa", { method: "POST", headers: { "content-type": "application/json" }, body: b.toString() })).status).toBe(200);
  });
});
