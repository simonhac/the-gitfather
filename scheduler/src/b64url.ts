// ─────────────────────────────────────────────────────────────────────────────
// base64url (RFC 4648 §5, no padding) — the encoding of every JWT segment. Used to SIGN the GitHub App
// JWT (github.ts) and to VERIFY GitHub's OIDC tokens (oidc.ts). Inputs here are small (< a few KB).
// ─────────────────────────────────────────────────────────────────────────────

export function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const b64urlJson = (o: unknown): string => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));

/** Decode base64url (padding optional). Throws on anything that isn't base64url. */
export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
