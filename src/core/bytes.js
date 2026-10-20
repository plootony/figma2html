// Small byte helpers that work the same in the browser and in Node (no Buffer, no WebCrypto:
// crypto.subtle is missing on plain-http pages).

export function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function sha1(bytes) {
  const ml = bytes.length;
  const withPad = new Uint8Array(((ml + 9 + 63) >> 6) << 6);
  withPad.set(bytes);
  withPad[ml] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, (ml * 8) >>> 0);
  view.setUint32(withPad.length - 8, Math.floor((ml * 8) / 2 ** 32));
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h));
  return out;
}

// A valid zstd frame made of raw (stored) blocks. Figma requires zstd for the .fig message
// chunk; storing instead of compressing keeps this dependency-free (the file is a bit larger).
export function zstdStore(data) {
  const MAX_BLOCK = 128 * 1024;
  const blocks = Math.max(1, Math.ceil(data.length / MAX_BLOCK));
  const out = new Uint8Array(4 + 1 + 8 + blocks * 3 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0xfd2fb528, true); // magic
  out[4] = 0xe0; // frame header: 8-byte content size, single segment (no window byte), no checksum
  view.setUint32(5, data.length >>> 0, true);
  view.setUint32(9, Math.floor(data.length / 2 ** 32), true);
  let pos = 13;
  for (let i = 0; i < blocks; i++) {
    const chunk = data.subarray(i * MAX_BLOCK, (i + 1) * MAX_BLOCK);
    const last = i === blocks - 1 ? 1 : 0;
    const header = last | (0 << 1) | (chunk.length << 3); // block type 0 = raw
    out[pos] = header & 0xff;
    out[pos + 1] = (header >> 8) & 0xff;
    out[pos + 2] = (header >> 16) & 0xff;
    out.set(chunk, pos + 3);
    pos += 3 + chunk.length;
  }
  return out;
}
