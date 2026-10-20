// Alexa request signature verification. On by default for every public request (through the tunnel);
// ALEXA_VERIFY_SIGNATURE=0 turns it off, for local fixture runs only (src/alexa/plugin.ts).
// Implements Amazon's checks for a custom skill hosted as a web service:
//   1. SignatureCertChainUrl: https, host s3.amazonaws.com, path under /echo.api/, port 443 if given
//   2. the PEM chain it points to: the leaf is valid now and names echo-api.amazon.com, every cert is
//      signed by the next, and the last one chains to a root this Node trusts (tls.rootCertificates)
//   3. Signature-256: base64 RSA-SHA256 of the raw request body, verified with the leaf's key
// Chains are cached per URL. Node built-ins only.
import { verify as cryptoVerify, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

export type SigResult = { ok: true } | { ok: false; reason: string };

export function certUrlOk(raw: string | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname.toLowerCase() === "s3.amazonaws.com" && (u.port === "" || u.port === "443") && u.pathname.startsWith("/echo.api/");
}

export function splitPem(pem: string): X509Certificate[] {
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((b) => new X509Certificate(b));
}

export interface SignatureVerifierOptions {
  fetchChain?: (url: string) => Promise<string>; // default: fetch with a 2 s timeout
  roots?: X509Certificate[]; // default: tls.rootCertificates
  now?: () => number;
  urlOk?: (url: string | undefined) => boolean; // default: certUrlOk (tests point it elsewhere)
}

export function signatureVerifier(opts: SignatureVerifierOptions = {}) {
  // Chains by normalized URL, at most CHAIN_CACHE entries (least recently used out). A failed
  // fetch is remembered for FAIL_TTL_MS, so a flood of bad requests does not become a flood of fetches.
  const CHAIN_CACHE = 8;
  const FAIL_TTL_MS = 60_000;
  const cache = new Map<string, X509Certificate[]>();
  const failed = new Map<string, { until: number; reason: string }>();
  const keyOf = (u: string) => {
    try {
      return new URL(u).href;
    } catch {
      return u;
    }
  };
  const roots = opts.roots ?? rootCertificates.map((p) => new X509Certificate(p));
  const now = opts.now ?? (() => Date.now());
  const urlOk = opts.urlOk ?? certUrlOk;
  const fetchChain = opts.fetchChain ?? (async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`cert chain HTTP ${r.status}`);
    return r.text();
  });

  function chainOk(chain: X509Certificate[]): string | null {
    const leaf = chain[0];
    if (!leaf) return "empty certificate chain";
    const t = now();
    for (const c of chain) if (t < Date.parse(c.validFrom) || t > Date.parse(c.validTo)) return "a certificate in the chain is not valid now";
    if (!(leaf.subjectAltName ?? "").split(/,\s*/).includes("DNS:echo-api.amazon.com")) return "the signing certificate is not for echo-api.amazon.com";
    for (let i = 0; i + 1 < chain.length; i++) if (!chain[i]!.checkIssued(chain[i + 1]!) || !chain[i]!.verify(chain[i + 1]!.publicKey)) return "the certificate chain is broken";
    const top = chain[chain.length - 1]!;
    const trusted = roots.some((r) => r.fingerprint256 === top.fingerprint256 || (top.checkIssued(r) && top.verify(r.publicKey)));
    return trusted ? null : "the certificate chain does not reach a trusted root";
  }

  return async (headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<SigResult> => {
    const h = (k: string) => {
      const v = headers[k.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const url = h("signaturecertchainurl");
    const sig = h("signature-256");
    if (!urlOk(url)) return { ok: false, reason: "bad SignatureCertChainUrl" };
    if (!sig) return { ok: false, reason: "no Signature-256 header" };
    const key = keyOf(url!);
    let chain = cache.get(key);
    if (chain) (cache.delete(key), cache.set(key, chain));
    if (!chain) {
      const f = failed.get(key);
      if (f && f.until > now()) return { ok: false, reason: f.reason };
      try {
        chain = splitPem(await fetchChain(url!));
      } catch (err) {
        const reason = `could not load the certificate chain: ${(err as Error).message}`;
        failed.set(key, { until: now() + FAIL_TTL_MS, reason });
        if (failed.size > 64) failed.delete(failed.keys().next().value!);
        return { ok: false, reason };
      }
      const bad = chainOk(chain);
      if (bad) {
        failed.set(key, { until: now() + FAIL_TTL_MS, reason: bad });
        if (failed.size > 64) failed.delete(failed.keys().next().value!);
        return { ok: false, reason: bad };
      }
      failed.delete(key);
      cache.set(key, chain);
      if (cache.size > CHAIN_CACHE) cache.delete(cache.keys().next().value!);
    } else {
      const bad = chainOk(chain); // re-check validity dates on every request
      if (bad) return { ok: false, reason: bad };
    }
    let good = false;
    try {
      good = cryptoVerify("sha256", rawBody, chain[0]!.publicKey, Buffer.from(sig, "base64"));
    } catch {
      good = false;
    }
    return good ? { ok: true } : { ok: false, reason: "signature does not match the body" };
  };
}
