// ─────────────────────────────────────────────────────────────────────────────
// An age X25519 identity as raw bytes, and back.
//
// `AGE-SECRET-KEY-1…` is bech32 (BIP-173) of the 32-byte scalar under the HRP `age-secret-key-`,
// upper-cased. Key escrow (key-shares.ts) splits those 32 BYTES — not the 74-character string — so a
// share is 33 SLIP-39 words rather than ~60, and the rebuilt bytes re-encode to exactly the original
// identity. bech32 is small enough to carry here rather than add a dependency for it.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const IDENTITY_HRP = "age-secret-key-";

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >>> 5), 0, ...codes.map((c) => c & 31)];
}

/** Regroup a bit stream, e.g. 8-bit bytes ↔ 5-bit bech32 symbols. */
export function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < 0 || v >> from !== 0) throw new Error(`value ${v} does not fit in ${from} bits`);
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error("invalid padding");
  }
  return out;
}

/** BIP-173 encode (lower case). No 90-character limit — age does not impose one. */
export function bech32Encode(hrp: string, data5: number[]): string {
  const chk = polymod([...hrpExpand(hrp), ...data5, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data5, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

/** BIP-173 decode. Throws on mixed case, a bad character or a bad checksum. */
export function bech32Decode(str: string): { hrp: string; data5: number[] } {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error("bech32: mixed case");
  const s = str.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) throw new Error("bech32: missing separator or checksum");
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => {
    const d = CHARSET.indexOf(c);
    if (d === -1) throw new Error(`bech32: invalid character '${c}'`);
    return d;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error("bech32: checksum mismatch");
  return { hrp, data5: data.slice(0, -6) };
}

/** `AGE-SECRET-KEY-1…` → the 32-byte X25519 scalar. */
export function identityToSecret(identity: string): Uint8Array {
  const { hrp, data5 } = bech32Decode(identity.trim());
  if (hrp !== IDENTITY_HRP) throw new Error(`not an age identity (prefix "${hrp.toUpperCase()}")`);
  const bytes = convertBits(data5, 5, 8, false);
  if (bytes.length !== 32) throw new Error(`age identity decodes to ${bytes.length} bytes, expected 32`);
  return Uint8Array.from(bytes);
}

/** The 32-byte scalar → `AGE-SECRET-KEY-1…`. */
export function secretToIdentity(secret: Uint8Array): string {
  if (secret.length !== 32) throw new Error(`an age identity is 32 bytes, got ${secret.length}`);
  return bech32Encode(IDENTITY_HRP, convertBits(secret, 8, 5, true)).toUpperCase();
}

/**
 * Resolve an identity given the way this repo always takes one (AGE_IDENTITY): the key ITSELF, or a
 * path to a key file. A key file carries `# created:` / `# public key:` comments; exactly one
 * AGE-SECRET-KEY line is accepted, so a file holding several keys cannot pick one silently.
 */
export function readIdentity(value: string): string {
  let text = value;
  try {
    if (statSync(value).isFile()) text = readFileSync(value, "utf8");
  } catch {
    /* not a path — the value is the key */
  }
  const keys = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("AGE-SECRET-KEY-1"));
  if (keys.length !== 1) throw new Error(`expected exactly one AGE-SECRET-KEY line, found ${keys.length}`);
  identityToSecret(keys[0]); // validates the checksum and length
  return keys[0];
}

/** The public `age1…` recipient for an identity, from `age-keygen -y` (identity on stdin, never argv). */
export function recipientOf(identity: string): string {
  const r = spawnSync("age-keygen", ["-y"], { input: `${identity}\n`, encoding: "utf8" });
  if (r.error) throw new Error(`age-keygen: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`age-keygen -y failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
