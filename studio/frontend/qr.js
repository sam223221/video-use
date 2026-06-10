/* =============================================================================
   qr.js — OPTIONAL in-page QR helper (desktop convenience).
   -----------------------------------------------------------------------------
   The PRIMARY phone-onboarding QR is printed in the terminal by the launcher
   (ARCHITECTURE.md §7.3). This module is a tiny, dependency-free, vendored QR
   encoder used only as a desktop fallback to hand a deep-link to a phone — it
   does NOT load any runtime CDN.

   It implements a compact byte-mode QR encoder (versions 1–10, EC level L/M),
   sufficient for a LAN URL with an embedded token. If encoding ever fails for an
   over-long string, the caller falls back to showing the plain URL text.

   This is intentionally self-contained so the rest of the app has zero deps.
============================================================================= */

/* --- Galois field tables for Reed–Solomon ---------------------------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function rsGenerator(deg) {
  let poly = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift(); res.push(0);
    for (let j = 0; j < gen.length; j++) res[j] ^= gfMul(gen[j], factor);
  }
  return res;
}

/* --- capacity tables (byte mode) for versions 1..10, EC level M ------------- */
/* [version]: { size, ecPerBlock, blocks:[ [count, dataCodewordsPerBlock], ... ], totalData } */
const VERSIONS_M = {
  1:  { ec: 10, groups: [[1, 16]] },
  2:  { ec: 16, groups: [[1, 28]] },
  3:  { ec: 26, groups: [[1, 44]] },
  4:  { ec: 18, groups: [[2, 32]] },
  5:  { ec: 24, groups: [[2, 43]] },
  6:  { ec: 16, groups: [[4, 27]] },
  7:  { ec: 18, groups: [[4, 31]] },
  8:  { ec: 22, groups: [[2, 38], [2, 39]] },
  9:  { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
};
const ALIGN_POS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

function versionSize(v) { return 17 + v * 4; }

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const cfg = VERSIONS_M[v];
    let totalData = 0;
    for (const [count, dpb] of cfg.groups) totalData += count * dpb;
    // mode(4) + count(8 for v<10, byte mode) bits = 12 bits = 1.5 bytes overhead + terminator
    const capacity = totalData - 2;
    if (byteLen <= capacity) return v;
  }
  return null;
}

/* --- bit buffer ------------------------------------------------------------ */
class Bits {
  constructor() { this.bits = []; }
  push(val, len) { for (let i = len - 1; i >= 0; i--) this.bits.push((val >> i) & 1); }
  get length() { return this.bits.length; }
}

function encodeData(str, version) {
  const cfg = VERSIONS_M[version];
  let totalData = 0;
  for (const [count, dpb] of cfg.groups) totalData += count * dpb;
  const bytes = new TextEncoder().encode(str);

  const bits = new Bits();
  bits.push(0b0100, 4);                 // byte mode
  bits.push(bytes.length, 8);           // count (8 bits for versions 1..9; v10 also 8 in byte mode <256? actually 16)
  if (version >= 10) {
    // correct: byte-mode count indicator is 16 bits for versions 10..26
    // rebuild header with 16-bit count
    bits.bits.length = 0;
    bits.push(0b0100, 4);
    bits.push(bytes.length, 16);
  }
  for (const b of bytes) bits.push(b, 8);

  // terminator
  const cap = totalData * 8;
  const term = Math.min(4, cap - bits.length);
  bits.push(0, term);
  // pad to byte boundary
  while (bits.length % 8 !== 0) bits.bits.push(0);
  // pad bytes
  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0; for (let j = 0; j < 8; j++) byte = (byte << 1) | bits.bits[i + j];
    dataCodewords.push(byte);
  }
  const padBytes = [0xEC, 0x11];
  let pi = 0;
  while (dataCodewords.length < totalData) dataCodewords.push(padBytes[pi++ % 2]);

  // split into blocks, compute EC, interleave
  const blocks = [];
  let idx = 0;
  for (const [count, dpb] of cfg.groups) {
    for (let c = 0; c < count; c++) {
      const data = dataCodewords.slice(idx, idx + dpb); idx += dpb;
      const ec = rsEncode(data, cfg.ec);
      blocks.push({ data, ec });
    }
  }
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  const result = [];
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) result.push(b.data[i]);
  for (let i = 0; i < cfg.ec; i++) for (const b of blocks) result.push(b.ec[i]);
  return result;
}

/* --- matrix construction --------------------------------------------------- */
function buildMatrix(version, codewords) {
  const size = versionSize(version);
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserve = Array.from({ length: size }, () => new Array(size).fill(false));

  function placeFinder(r, c) {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
      const rr = r + i, cc = c + j;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inRing = (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6));
      const inCore = i >= 2 && i <= 4 && j >= 2 && j <= 4;
      m[rr][cc] = (inRing || inCore) ? 1 : 0;
      reserve[rr][cc] = true;
    }
  }
  placeFinder(0, 0); placeFinder(0, size - 7); placeFinder(size - 7, 0);

  // separators handled by the -1..7 loop writing 0 around finders

  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = (i % 2 === 0) ? 1 : 0; reserve[6][i] = true;
    m[i][6] = (i % 2 === 0) ? 1 : 0; reserve[i][6] = true;
  }

  // alignment patterns
  const pos = ALIGN_POS[version];
  for (const r of pos) for (const c of pos) {
    if (reserve[r][c]) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const ring = Math.max(Math.abs(i), Math.abs(j));
      m[r + i][c + j] = (ring === 1) ? 0 : 1;
      reserve[r + i][c + j] = true;
    }
  }

  // dark module
  m[size - 8][8] = 1; reserve[size - 8][8] = true;

  // reserve format info areas
  for (let i = 0; i < 9; i++) { if (!reserve[8][i]) reserve[8][i] = true; if (!reserve[i][8]) reserve[i][8] = true; }
  for (let i = 0; i < 8; i++) { reserve[8][size - 1 - i] = true; reserve[size - 1 - i][8] = true; }

  // place data with mask 0
  let bitIdx = 0;
  const allBits = [];
  for (const cw of codewords) for (let b = 7; b >= 0; b--) allBits.push((cw >> b) & 1);

  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let n = 0; n < size; n++) {
      const row = up ? size - 1 - n : n;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserve[row][cc]) continue;
        let bit = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
        // mask 0: (row + col) % 2 === 0 → invert
        if (((row + cc) % 2) === 0) bit ^= 1;
        m[row][cc] = bit;
      }
    }
    up = !up;
  }

  // format info for EC level M (10) + mask 0 → bits 0b101 0000000000... per spec
  // EC M = 0b00, mask 0 = 0b000 → 5 data bits = 0b00000; BCH → standard string:
  const FORMAT_M0 = 0b101010000010010; // EC=M, mask=0 (precomputed with XOR mask)
  const fmt = FORMAT_M0;
  // place format bits
  for (let i = 0; i <= 5; i++) m[8][i] = (fmt >> (14 - i)) & 1;
  m[8][7] = (fmt >> 8) & 1;
  m[8][8] = (fmt >> 7) & 1;
  m[7][8] = (fmt >> 6) & 1;
  for (let i = 9; i <= 14; i++) m[14 - i][8] = (fmt >> (14 - i)) & 1;
  for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = (fmt >> i) & 1;
  for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = (fmt >> i) & 1;

  return m;
}

/** Encode a string into a boolean matrix, or return null if too long. */
export function encodeQR(str) {
  const byteLen = new TextEncoder().encode(str).length;
  const version = pickVersion(byteLen);
  if (!version) return null;
  try {
    const codewords = encodeData(str, version);
    const matrix = buildMatrix(version, codewords);
    return matrix.map((row) => row.map((v) => v === 1));
  } catch {
    return null;
  }
}

/** Render a QR matrix into an SVG element (crisp at any size). */
export function renderQRSvg(matrix, { size = 180, quiet = 4, dark = "#0b0a09", light = "#f4f0e8" } = {}) {
  const n = matrix.length;
  const total = n + quiet * 2;
  const cell = size / total;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code");

  const bg = document.createElementNS(svgNS, "rect");
  bg.setAttribute("width", String(total)); bg.setAttribute("height", String(total));
  bg.setAttribute("fill", light);
  svg.append(bg);

  let path = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (matrix[r][c]) path += `M${c + quiet},${r + quiet}h1v1h-1z`;
  }
  const p = document.createElementNS(svgNS, "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", dark);
  svg.append(p);
  svg.style.borderRadius = "10px";
  return svg;
}
