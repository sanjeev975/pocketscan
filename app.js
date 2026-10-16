/* PocketScan - client-side document scanner (no backend).
 * Sections: 0 helpers · 1 library loader · 2 storage · 3 vision (detect / homography / filters)
 *           4 camera · 5 crop view · 6 editor · 7 OCR · 8 export · 9 library UI · 10 boot
 */
'use strict';

/* ───────────────────────── 0. helpers ───────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const paint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); // let the UI repaint
const safeName = s => (s || 'scan').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80) || 'scan';
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function setBusy(msg) { const b = $('#busy'); if (msg) { $('#busy-msg').textContent = msg; b.hidden = false; } else b.hidden = true; }
async function withBusy(msg, fn) { setBusy(msg); await paint(); try { return await fn(); } finally { setBusy(null); } }

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const canvasToBlob = (c, type = 'image/jpeg', q = 0.92) =>
  new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Canvas export failed'))), type, q));
const newCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const ctx2d = c => c.getContext('2d', { willReadFrequently: true });

/* ───────────────────── 1. third-party library loader ─────────────────────
 * Order of preference: ./vendor/* (self-hosted via `npm run vendor`) → CDN.
 * The service worker caches whichever one succeeded so later visits work offline. */
const LIBS = {
  jspdf: { local: 'vendor/jspdf.umd.min.js', cdn: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', ready: () => window.jspdf },
  jszip: { local: 'vendor/jszip.min.js', cdn: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', ready: () => window.JSZip },
  tesseract: { local: 'vendor/tesseract/tesseract.min.js', cdn: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', ready: () => window.Tesseract },
  heic: { local: 'vendor/heic2any.min.js', cdn: 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js', ready: () => window.heic2any }
};
const TESS = {
  workerCdn: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  coreCdn: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0',
  langCdn: l => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${l}/4.0.0_best_int`
};
let vendorInfo = null;
async function getVendorInfo() {
  if (vendorInfo) return vendorInfo;
  try { const r = await fetch('vendor/manifest.json'); vendorInfo = r.ok ? await r.json() : {}; } catch { vendorInfo = {}; }
  return vendorInfo;
}
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src;
    if (/^https?:/.test(src)) s.crossOrigin = 'anonymous'; // CORS request → cacheable by the SW
    s.onload = () => res(); s.onerror = () => { s.remove(); rej(new Error('Failed to load ' + src)); };
    document.head.appendChild(s);
  });
}
const libPromises = {};
function loadLib(name) {
  if (LIBS[name].ready()) return Promise.resolve();
  if (!libPromises[name]) {
    libPromises[name] = (async () => {
      const d = LIBS[name], info = await getVendorInfo();
      for (const url of info.libs ? [d.local, d.cdn] : [d.cdn]) {
        try { await loadScript(url); if (d.ready()) return; } catch { /* try next */ }
      }
      throw new Error(`Could not load "${name}". Connect to the internet once so it can be cached for offline use.`);
    })().catch(e => { delete libPromises[name]; throw e; });
  }
  return libPromises[name];
}

/* ───────────────────────── 2. storage (IndexedDB) ─────────────────────────
 * "docs"  : light metadata + per-page settings (corners, rotation, filter, thumb, ocr)
 * "blobs" : original page photos, keyed by page id (loaded lazily) */
const DB = (() => {
  let dbp; const mem = { docs: new Map(), blobs: new Map() }; let useMem = false;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('IndexedDB unavailable'));
    const r = indexedDB.open('pocketscan', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('docs', { keyPath: 'id' }); r.result.createObjectStore('blobs', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  async function run(store, mode, fn, memFn) {
    if (!useMem) {
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const t = db.transaction(store, mode); const rq = fn(t.objectStore(store));
          t.oncomplete = () => res(rq && rq.result); t.onerror = t.onabort = () => rej(t.error);
        });
      } catch (e) { console.warn('IndexedDB failed, using memory only:', e); useMem = true; toast('Storage unavailable - scans will be lost on close'); }
    }
    return memFn(mem[store]);
  }
  return {
    all: s => run(s, 'readonly', st => st.getAll(), m => [...m.values()]),
    get: (s, k) => run(s, 'readonly', st => st.get(k), m => m.get(k)),
    put: (s, v) => run(s, 'readwrite', st => st.put(v), m => { m.set(v.id, v); }),
    del: (s, k) => run(s, 'readwrite', st => st.delete(k), m => { m.delete(k); })
  };
})();

/* ───────────────────────── global state ───────────────────────── */
const S = {
  doc: null, cur: 0, saveT: null,
  filter: lsGet('ps.filter', 'magic'),
  view: 'library', previewToken: 0, imgQ: [], ocrWorker: null, ocrLang: null
};
const srcCache = new Map(); // pageId → decoded source canvas (tiny LRU)

function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  S.view = name;
}

/* ───────────────────────── 3. computer vision ───────────────────────── */
/* 3a. image decoding */
async function blobToCanvas(blob, maxDim = Infinity) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch {
    bmp = await new Promise((res, rej) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Cannot decode image')); };
      img.src = url;
    });
  }
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const c = newCanvas(Math.round(w0 * s), Math.round(h0 * s));
  const x = ctx2d(c); x.imageSmoothingQuality = 'high'; x.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}
async function fileToCanvas(file, maxDim = 3200) {
  const isHeic = /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  if (isHeic) {
    try { return await blobToCanvas(file, maxDim); } // Safari decodes HEIC natively
    catch {
      await loadLib('heic');
      const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      return blobToCanvas(Array.isArray(out) ? out[0] : out, maxDim);
    }
  }
  return blobToCanvas(file, maxDim);
}

/* 3b. auto document detection: Otsu mask → largest quad-like component → extreme corners */
let detCanvas;
function boxBlurPlane(src, w, h, r) { // separable running-sum box blur (Float32 in/out)
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0; const o = y * w;
    for (let x = -r; x <= r; x++) sum += src[o + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) { tmp[o + x] = sum / n; sum += src[o + clamp(x + r + 1, 0, w - 1)] - src[o + clamp(x - r, 0, w - 1)]; }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = sum / n; sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x]; }
  }
  return out;
}
function otsu(g) {
  const hist = new Uint32Array(256); for (let i = 0; i < g.length; i++) hist[g[i]]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue; const wF = g.length - wB; if (!wF) break;
    sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}
const polyArea = p => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a) / 2; };
function bestQuadComponent(mask, w, h) {
  const label = new Int32Array(w * h), stack = new Int32Array(w * h); let best = null, id = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    id++; let sp = 0, area = 0; stack[sp++] = s; label[s] = id;
    let minS = 1e9, maxS = -1e9, minD = 1e9, maxD = -1e9, tl, br, tr, bl;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0; area++;
      const a = x + y, d = x - y;
      if (a < minS) { minS = a; tl = [x, y]; } if (a > maxS) { maxS = a; br = [x, y]; }
      if (d > maxD) { maxD = d; tr = [x, y]; } if (d < minD) { minD = d; bl = [x, y]; }
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[sp++] = p + w; }
    }
    const frac = area / (w * h); if (frac < 0.1 || frac > 0.97) continue;
    const quad = [tl, tr, br, bl], qa = polyArea(quad); if (qa < 1) continue;
    const fill = area / qa; if (fill < 0.72 || fill > 1.1) continue;
    const score = fill ** 3 * Math.sqrt(frac);
    if (!best || score > best.score) best = { score, quad };
  }
  return best;
}
/** @returns normalized [[x,y]×4] (TL,TR,BR,BL) or null */
function detectDocument(src, maxSide = 220) {
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height; if (!sw || !sh) return null;
  const sc = maxSide / Math.max(sw, sh), w = Math.max(16, Math.round(sw * sc)), h = Math.max(16, Math.round(sh * sc));
  detCanvas = detCanvas || newCanvas(w, h); detCanvas.width = w; detCanvas.height = h;
  const cx = ctx2d(detCanvas); cx.drawImage(src, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data, lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) / 256;
  const bl = boxBlurPlane(boxBlurPlane(lum, w, h, 2), w, h, 2), g = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = bl[i];
  const T = otsu(g); let best = null;
  for (const bright of [true, false]) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = (g[i] > T) === bright ? 1 : 0;
    const r = bestQuadComponent(mask, w, h); if (r && (!best || r.score > best.score)) best = r;
  }
  if (!best) return null;
  const q = best.quad.map(([x, y]) => [clamp((x + 0.5) / w, 0, 1), clamp((y + 0.5) / h, 0, 1)]);
  const minEdge = Math.min(dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0]));
  return minEdge > 0.12 ? q : null;
}
const fullQuad = (inset = 0) => [[inset, inset], [1 - inset, inset], [1 - inset, 1 - inset], [inset, 1 - inset]];
function orderQuad(p) { // TL,TR,BR,BL regardless of the order the user dragged them in
  const sum = p.map(([x, y]) => x + y), dif = p.map(([x, y]) => x - y);
  return [p[sum.indexOf(Math.min(...sum))], p[dif.indexOf(Math.max(...dif))], p[sum.indexOf(Math.max(...sum))], p[dif.indexOf(Math.min(...dif))]];
}

/* 3c. homography + perspective warp */
function homography(from, to) { // solve 8×8 for H mapping from→to (h8 = 1)
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = from[i], [x, y] = to[i];
    A.push([u, v, 1, 0, 0, 0, -x * u, -x * v, x]); A.push([0, 0, 0, u, v, 1, -y * u, -y * v, y]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; const piv = A[c][c]; if (Math.abs(piv) < 1e-10) return null;
    for (let k = c; k < 9; k++) A[c][k] /= piv;
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c]; if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map(r => r[8]);
}
/** Flatten the quadrilateral q (pixel coords, TL,TR,BR,BL) into an upright rectangle. */
function warp(src, q, maxDim) {
  const wTop = dist(q[0], q[1]), wBot = dist(q[3], q[2]), hL = dist(q[0], q[3]), hR = dist(q[1], q[2]);
  let w = Math.max(wTop, wBot), h = Math.max(hL, hR);
  const s = Math.min(1, maxDim / Math.max(w, h)); w = Math.max(8, Math.round(w * s)); h = Math.max(8, Math.round(h * s));
  // pre-shrink big sources (anti-aliasing + speed) when the output is much smaller than the quad
  const ratio = Math.max(wTop, wBot, hL, hR) / Math.max(w, h);
  if (ratio > 1.8) {
    const f = (1.3 * Math.max(w, h)) / Math.max(wTop, wBot, hL, hR);
    const small = newCanvas(Math.max(8, Math.round(src.width * f)), Math.max(8, Math.round(src.height * f)));
    const sx = ctx2d(small); sx.imageSmoothingQuality = 'high'; sx.drawImage(src, 0, 0, small.width, small.height);
    q = q.map(([x, y]) => [x * small.width / src.width, y * small.height / src.height]); src = small;
  }
  const H = homography([[0, 0], [w, 0], [w, h], [0, h]], q);
  const out = newCanvas(w, h), octx = ctx2d(out);
  if (!H) { octx.drawImage(src, 0, 0, w, h); return out; }
  const sw = src.width, sh = src.height, sd = ctx2d(src).getImageData(0, 0, sw, sh).data;
  const od = octx.createImageData(w, h), o = od.data;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = H, mx = sw - 1.001, my = sh - 1.001;
  for (let y = 0; y < h; y++) {
    const v = y + 0.5;
    for (let x = 0; x < w; x++) {
      const u = x + 0.5, dn = h6 * u + h7 * v + 1;
      let sx = (h0 * u + h1 * v + h2) / dn - 0.5, sy = (h3 * u + h4 * v + h5) / dn - 0.5;
      sx = sx < 0 ? 0 : sx > mx ? mx : sx; sy = sy < 0 ? 0 : sy > my ? my : sy;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy, oi = (y * w + x) * 4;
      o[oi] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
      o[oi + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
      o[oi + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      o[oi + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0); return out;
}
function rotateCanvas(c, deg) {
  deg = ((deg % 360) + 360) % 360; if (!deg) return c;
  const swap = deg === 90 || deg === 270, o = newCanvas(swap ? c.height : c.width, swap ? c.width : c.height), x = ctx2d(o);
  x.translate(o.width / 2, o.height / 2); x.rotate(deg * Math.PI / 180); x.drawImage(c, -c.width / 2, -c.height / 2); return o;
}

/* 3d. filters */
function maxFilterPlane(p, w, h, r) { // separable grey dilation
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = -r; k <= r; k++) { const v = p[y * w + clamp(x + k, 0, w - 1)]; if (v > m) m = v; } t[y * w + x] = m; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = -r; k <= r; k++) { const v = t[clamp(y + k, 0, h - 1) * w + x]; if (v > m) m = v; } o[y * w + x] = m; }
  return o;
}
function sharpen(d, w, h, a) { // 4-neighbour unsharp, in place
  const src = new Uint8ClampedArray(d), k = 1 + 4 * a;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) d[i + c] = k * src[i + c] - a * (src[i + c - 4] + src[i + c + 4] + src[i + c - w * 4] + src[i + c + w * 4]);
  }
}
function filterGray(c) {
  const x = ctx2d(c), img = x.getImageData(0, 0, c.width, c.height), d = img.data, hist = new Uint32Array(256), n = c.width * c.height;
  for (let i = 0; i < d.length; i += 4) { const v = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; d[i] = d[i + 1] = d[i + 2] = v; hist[v]++; }
  let lo = 0, hi = 255, acc = 0; for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.01) break; }
  acc = 0; for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.01) break; }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = clamp(((d[i] - lo) * 255) / span, 0, 255);
  x.putImageData(img, 0, 0);
}
function filterBW(c) { // Bradley adaptive threshold on an integral image
  const w = c.width, h = c.height, x = ctx2d(c), img = x.getImageData(0, 0, w, h), d = img.data;
  const g = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  const W = w + 1, I = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let xx = 0; xx < w; xx++) { row += g[y * w + xx]; I[(y + 1) * W + xx + 1] = I[y * W + xx + 1] + row; } }
  const r = Math.max(8, Math.round(Math.max(w, h) / 48)), T = 0.13;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let xx = 0; xx < w; xx++) {
      const x0 = Math.max(0, xx - r), x1 = Math.min(w, xx + r + 1);
      const sum = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0], cnt = (x1 - x0) * (y1 - y0);
      const v = g[y * w + xx], out = (v * cnt < sum * (1 - T) || v < 40) ? 0 : 255, o = (y * w + xx) * 4;
      d[o] = d[o + 1] = d[o + 2] = out;
    }
  }
  x.putImageData(img, 0, 0);
}
function filterMagic(c) { // shadow/illumination removal (divide by estimated paper colour) + contrast + sharpen
  const w = c.width, h = c.height, x = ctx2d(c);
  const sw = Math.max(16, Math.round(w / 6)), sh = Math.max(16, Math.round(h / 6));
  const small = newCanvas(sw, sh), sx = ctx2d(small); sx.imageSmoothingQuality = 'high'; sx.drawImage(c, 0, 0, sw, sh);
  const sImg = sx.getImageData(0, 0, sw, sh), sd = sImg.data;
  for (let ch = 0; ch < 3; ch++) {
    let p = new Float32Array(sw * sh); for (let i = 0; i < sw * sh; i++) p[i] = sd[i * 4 + ch];
    p = maxFilterPlane(p, sw, sh, 3); p = boxBlurPlane(boxBlurPlane(p, sw, sh, 4), sw, sh, 4);
    for (let i = 0; i < sw * sh; i++) sd[i * 4 + ch] = p[i];
  }
  sx.putImageData(sImg, 0, 0);
  const bgc = newCanvas(w, h), bx = ctx2d(bgc); bx.imageSmoothingEnabled = true; bx.imageSmoothingQuality = 'high'; bx.drawImage(small, 0, 0, w, h);
  const bg = bx.getImageData(0, 0, w, h).data, img = x.getImageData(0, 0, w, h), d = img.data;
  const lut = new Uint8Array(256); for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(Math.min(1, i / 232), 1.7);
  for (let i = 0; i < d.length; i += 4) {
    const r = lut[Math.min(255, (d[i] * 255) / Math.max(bg[i], 24)) | 0], g = lut[Math.min(255, (d[i + 1] * 255) / Math.max(bg[i + 1], 24)) | 0], b = lut[Math.min(255, (d[i + 2] * 255) / Math.max(bg[i + 2], 24)) | 0];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i] = clamp(l + (r - l) * 1.25, 0, 255); d[i + 1] = clamp(l + (g - l) * 1.25, 0, 255); d[i + 2] = clamp(l + (b - l) * 1.25, 0, 255);
  }
  sharpen(d, w, h, 0.35); x.putImageData(img, 0, 0);
}
function applyFilter(c, f) {
  if (f === 'gray') filterGray(c); else if (f === 'bw') filterBW(c); else if (f === 'magic') filterMagic(c);
  return c;
}

/* ───────────────────────── page rendering ───────────────────────── */
async function getSrcCanvas(page) {
  let c = srcCache.get(page.id);
  if (c) { srcCache.delete(page.id); srcCache.set(page.id, c); return c; }
  const rec = await DB.get('blobs', page.id); if (!rec) throw new Error('Page image missing');
  c = await blobToCanvas(rec.blob);
  srcCache.set(page.id, c); while (srcCache.size > 4) srcCache.delete(srcCache.keys().next().value);
  return c;
}
async function renderPage(page, { maxDim = 1600, filter = page.filter } = {}) {
  const src = await getSrcCanvas(page);
  let c = warp(src, page.corners.map(([x, y]) => [x * src.width, y * src.height]), maxDim);
  if (page.rot) c = rotateCanvas(c, page.rot);
  return applyFilter(c, filter);
}
async function makeThumb(page) {
  const c = await renderPage(page, { maxDim: 240 });
  page.thumb = c.toDataURL('image/jpeg', 0.72);
}

/* ───────────────────────── document model ───────────────────────── */
function newDoc() {
  const d = new Date();
  return { id: uid(), name: 'Scan ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }), created: Date.now(), updated: Date.now(), pages: [] };
}
function scheduleSave(now = false) {
  clearTimeout(S.saveT);
  const go = async () => {
    const d = S.doc; if (!d || !d.pages.length) return; d.updated = Date.now();
    await DB.put('docs', { ...d, count: d.pages.length, cover: d.pages[0].thumb });
  };
  if (now) return go(); S.saveT = setTimeout(go, 500);
}
async function addPage(canvas, corners) {
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92), id = uid();
  await DB.put('blobs', { id, docId: S.doc.id, blob });
  const page = { id, corners, rot: 0, filter: S.filter, thumb: '', ocr: null, ver: 0 };
  S.doc.pages.push(page); await makeThumb(page); await scheduleSave(true); return page;
}

/* ───────────────────────── 4. camera ───────────────────────── */
const cam = { stream: null, track: null, facing: 'environment', torch: false, timer: null, quad: null, miss: 0, auto: true, busy: false };
const camVideo = $('#cam-video'), camOverlay = $('#cam-overlay');

function camError(title, msg) { $('#cam-error-title').textContent = title; $('#cam-error-msg').textContent = msg; $('#cam-error').hidden = false; }
async function startCamera() {
  stopCamera(); $('#cam-error').hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return camError('Camera not supported', window.isSecureContext ? 'This browser cannot access the camera. You can still upload images.' : 'The camera needs a secure (HTTPS) connection. Serve the app over HTTPS or localhost, or upload images instead.');
  }
  const attempts = [
    { video: { facingMode: { ideal: cam.facing }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false },
    { video: { facingMode: { ideal: cam.facing } }, audio: false },
    { video: true, audio: false }
  ];
  let stream, lastErr;
  for (const c of attempts) {
    try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
    catch (e) { lastErr = e; if (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'NotFoundError') break; }
  }
  if (!stream) {
    const n = lastErr && lastErr.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return camError('Camera permission blocked', 'Allow camera access in your browser/site settings, then tap Try again. Or upload images instead.');
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return camError('No camera found', 'This device has no usable camera. Upload images instead.');
    if (n === 'NotReadableError' || n === 'AbortError') return camError('Camera is busy', 'Another app is using the camera. Close it and try again.');
    return camError('Camera error', (lastErr && lastErr.message) || 'Unknown error');
  }
  cam.stream = stream; cam.track = stream.getVideoTracks()[0];
  const settings = cam.track.getSettings ? cam.track.getSettings() : {};
  const front = settings.facingMode ? settings.facingMode === 'user' : cam.facing === 'user';
  camVideo.classList.toggle('mirror', front);
  camVideo.srcObject = stream; try { await camVideo.play(); } catch { /* autoplay quirks */ }
  const caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
  $('#cam-torch').hidden = !('torch' in caps); cam.torch = false; $('#cam-torch').setAttribute('aria-pressed', 'false');
  layoutOverlay(); startDetectLoop();
  $('#cam-hint').classList.remove('fade'); setTimeout(() => $('#cam-hint').classList.add('fade'), 3500);
}
function stopCamera() {
  clearInterval(cam.timer); cam.timer = null; cam.quad = null;
  if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
  cam.stream = cam.track = null; camVideo.srcObject = null;
}
function layoutOverlay() {
  const r = camOverlay.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  camOverlay.width = Math.round(r.width * dpr); camOverlay.height = Math.round(r.height * dpr);
}
function videoRect() { // displayed rect of the video inside the overlay (object-fit: contain)
  const r = camOverlay.getBoundingClientRect(), vw = camVideo.videoWidth, vh = camVideo.videoHeight;
  const s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s;
  return { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
}
function drawLiveQuad() {
  const x = camOverlay.getContext('2d'), dpr = window.devicePixelRatio || 1;
  x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, camOverlay.width, camOverlay.height);
  if (!cam.quad || !camVideo.videoWidth) return;
  const vr = videoRect(), mir = camVideo.classList.contains('mirror');
  const pts = cam.quad.map(([nx, ny]) => [vr.x + (mir ? 1 - nx : nx) * vr.w, vr.y + ny * vr.h]);
  x.beginPath(); pts.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.closePath();
  x.fillStyle = 'rgba(20,184,166,.22)'; x.fill(); x.lineWidth = 3; x.strokeStyle = '#2dd4bf'; x.stroke();
  x.fillStyle = '#fff'; pts.forEach(([px, py]) => { x.beginPath(); x.arc(px, py, 5, 0, 7); x.fill(); });
}
function startDetectLoop() {
  clearInterval(cam.timer);
  cam.timer = setInterval(() => {
    if (!cam.auto || cam.busy || !camVideo.videoWidth || camVideo.paused) { if (!cam.auto) { cam.quad = null; drawLiveQuad(); } return; }
    let q = null; try { q = detectDocument(camVideo, 160); } catch { /* ignore frame */ }
    if (q) { cam.miss = 0; cam.quad = cam.quad ? cam.quad.map((p, i) => [p[0] * 0.5 + q[i][0] * 0.5, p[1] * 0.5 + q[i][1] * 0.5]) : q; }
    else if (++cam.miss > 4) cam.quad = null;
    drawLiveQuad();
  }, 260);
}
async function setTorch(on) {
  try { await cam.track.applyConstraints({ advanced: [{ torch: on }] }); cam.torch = on; $('#cam-torch').setAttribute('aria-pressed', String(on)); }
  catch { toast('Flashlight not supported on this camera'); }
}
async function capture() {
  if (!cam.stream || !camVideo.videoWidth || cam.busy) return;
  cam.busy = true; if (navigator.vibrate) navigator.vibrate(30);
  try {
    const vw = camVideo.videoWidth, vh = camVideo.videoHeight, s = Math.min(1, 3200 / Math.max(vw, vh));
    const c = newCanvas(Math.round(vw * s), Math.round(vh * s)); ctx2d(c).drawImage(camVideo, 0, 0, c.width, c.height);
    let corners = (cam.auto && cam.quad) ? cam.quad : null;
    if (!corners) corners = detectDocument(c, 320);
    await runCropFlow(c, corners || fullQuad(0.06), { cameraMode: true });
  } finally { cam.busy = false; }
}
async function openCamera() {
  showView('camera'); updateCamCount(); layoutOverlay(); await startCamera();
}
function updateCamCount() { $('#cam-count').textContent = S.doc ? S.doc.pages.length : 0; }
function closeCamera() { stopCamera(); finishSession(); }

/* ───────────────────────── 5. crop / perspective editor ───────────────────────── */
const crop = { canvas: null, pts: [], active: -1, v: { s: 1, ox: 0, oy: 0 }, resolve: null };
const cropCanvas = $('#crop-canvas'), loupe = $('#crop-loupe');

/** Show the crop UI. Resolves with normalized corners, or null if cancelled. */
function askCrop(canvas, corners, { title = 'Adjust corners', cancelLabel = 'Cancel' } = {}) {
  crop.canvas = canvas; crop.pts = corners.map(([x, y]) => [x * canvas.width, y * canvas.height]);
  $('#crop-title').textContent = title; $('#crop-cancel').textContent = cancelLabel;
  showView('crop'); requestAnimationFrame(() => { layoutCrop(); drawCrop(); });
  return new Promise(res => { crop.resolve = res; });
}
function layoutCrop() {
  const st = $('#crop-stage').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cropCanvas.width = Math.round(st.width * dpr); cropCanvas.height = Math.round(st.height * dpr);
  const pad = 22, s = Math.min((st.width - pad * 2) / crop.canvas.width, (st.height - pad * 2) / crop.canvas.height);
  crop.v = { s, ox: (st.width - crop.canvas.width * s) / 2, oy: (st.height - crop.canvas.height * s) / 2, dpr };
}
const toScreen = ([x, y]) => [crop.v.ox + x * crop.v.s, crop.v.oy + y * crop.v.s];
const toImage = ([x, y]) => [(x - crop.v.ox) / crop.v.s, (y - crop.v.oy) / crop.v.s];
function drawCrop() {
  const x = cropCanvas.getContext('2d'), { dpr, s, ox, oy } = crop.v, cw = cropCanvas.width / dpr, ch = cropCanvas.height / dpr;
  x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, cw, ch);
  x.drawImage(crop.canvas, ox, oy, crop.canvas.width * s, crop.canvas.height * s);
  const p = crop.pts.map(toScreen);
  x.save(); x.beginPath(); x.rect(0, 0, cw, ch); x.moveTo(p[0][0], p[0][1]); p.slice(1).forEach(q => x.lineTo(q[0], q[1])); x.closePath();
  x.fillStyle = 'rgba(0,0,0,.55)'; x.fill('evenodd'); x.restore();
  x.beginPath(); p.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.closePath();
  x.lineWidth = 2.5; x.strokeStyle = '#2dd4bf'; x.stroke();
  // thirds grid
  x.lineWidth = 1; x.strokeStyle = 'rgba(255,255,255,.28)';
  for (const t of [1 / 3, 2 / 3]) {
    const a = [p[0][0] + (p[1][0] - p[0][0]) * t, p[0][1] + (p[1][1] - p[0][1]) * t], b = [p[3][0] + (p[2][0] - p[3][0]) * t, p[3][1] + (p[2][1] - p[3][1]) * t];
    const c = [p[0][0] + (p[3][0] - p[0][0]) * t, p[0][1] + (p[3][1] - p[0][1]) * t], d = [p[1][0] + (p[2][0] - p[1][0]) * t, p[1][1] + (p[2][1] - p[1][1]) * t];
    x.beginPath(); x.moveTo(...a); x.lineTo(...b); x.moveTo(...c); x.lineTo(...d); x.stroke();
  }
  p.forEach(([px, py], i) => {
    x.beginPath(); x.arc(px, py, i === crop.active ? 17 : 13, 0, 7); x.fillStyle = i === crop.active ? '#2dd4bf' : '#fff'; x.fill();
    x.lineWidth = 3; x.strokeStyle = '#0b0c10'; x.stroke();
  });
}
function drawLoupe(i) {
  const lx = loupe.getContext('2d'), [ix, iy] = crop.pts[i], rs = 120 / 3 / crop.v.s; // loupe shows 3× the on-screen zoom
  lx.clearRect(0, 0, 120, 120); lx.fillStyle = '#000'; lx.fillRect(0, 0, 120, 120);
  lx.drawImage(crop.canvas, ix - rs / 2, iy - rs / 2, rs, rs, 0, 0, 120, 120);
  lx.strokeStyle = '#2dd4bf'; lx.lineWidth = 1.5; lx.beginPath(); lx.moveTo(60, 0); lx.lineTo(60, 120); lx.moveTo(0, 60); lx.lineTo(120, 60); lx.stroke();
  const st = $('#crop-stage').getBoundingClientRect(), sx = toScreen(crop.pts[i])[0];
  loupe.classList.toggle('right', sx < st.width / 2 && toScreen(crop.pts[i])[1] < 170); loupe.hidden = false;
}
cropCanvas.addEventListener('pointerdown', e => {
  const r = cropCanvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top; let best = -1, bd = 44;
  crop.pts.map(toScreen).forEach((p, i) => { const d = Math.hypot(p[0] - px, p[1] - py); if (d < bd) { bd = d; best = i; } });
  if (best < 0) return; crop.active = best; cropCanvas.setPointerCapture(e.pointerId); drawCrop(); drawLoupe(best); e.preventDefault();
});
cropCanvas.addEventListener('pointermove', e => {
  if (crop.active < 0) return;
  const r = cropCanvas.getBoundingClientRect(), [ix, iy] = toImage([e.clientX - r.left, e.clientY - r.top]);
  crop.pts[crop.active] = [clamp(ix, 0, crop.canvas.width), clamp(iy, 0, crop.canvas.height)]; drawCrop(); drawLoupe(crop.active);
});
const endDrag = () => { crop.active = -1; loupe.hidden = true; drawCrop(); };
cropCanvas.addEventListener('pointerup', endDrag); cropCanvas.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => { if (S.view === 'crop') { layoutCrop(); drawCrop(); } if (S.view === 'camera') layoutOverlay(); if (S.view === 'editor') renderPreview(); });
$('#crop-auto').onclick = () => {
  const q = detectDocument(crop.canvas, 360);
  if (q) { crop.pts = q.map(([x, y]) => [x * crop.canvas.width, y * crop.canvas.height]); drawCrop(); toast('Edges detected'); }
  else toast('Could not find edges - drag the corners manually');
};
$('#crop-full').onclick = () => { const q = fullQuad(0); crop.pts = q.map(([x, y]) => [x * crop.canvas.width, y * crop.canvas.height]); drawCrop(); };
$('#crop-apply').onclick = () => {
  const q = orderQuad(crop.pts).map(([x, y]) => [x / crop.canvas.width, y / crop.canvas.height]);
  const res = crop.resolve; crop.resolve = null; res && res(q);
};
$('#crop-cancel').onclick = () => { const res = crop.resolve; crop.resolve = null; res && res(null); };

/** Crop a freshly captured/imported image, then add it to the current document. */
async function runCropFlow(canvas, corners, { cameraMode = false, title } = {}) {
  const q = await askCrop(canvas, corners, { title: title || (cameraMode ? 'Adjust corners' : 'Adjust corners'), cancelLabel: cameraMode ? 'Retake' : 'Skip' });
  if (!q) { if (cameraMode) showView('camera'); return false; }
  await withBusy('Flattening page…', () => addPage(canvas, q));
  if (cameraMode) { showView('camera'); updateCamCount(); toast(`Page ${S.doc.pages.length} added`, 1500); }
  return true;
}

/* ───────────────────────── 6. editor ───────────────────────── */
const preview = $('#ed-preview');
const curPage = () => S.doc && S.doc.pages[S.cur];
function finishSession() {
  stopCamera();
  if (S.doc && S.doc.pages.length) openEditor(S.doc, S.doc.pages.length - 1); else { S.doc = null; goLibrary(); }
}
async function openEditor(doc, idx = 0) {
  S.doc = doc; S.cur = clamp(idx, 0, Math.max(0, doc.pages.length - 1));
  $('#ed-name').value = doc.name; showView('editor'); $('#ed-strip').classList.remove('expanded'); refreshEditor();
}
function refreshEditor() { renderStrip(); renderPreview(); updateFilterUI(); }
function updateFilterUI() {
  const p = curPage(); $$('#ed-filters button').forEach(b => { const on = p && b.dataset.f === p.filter; b.classList.toggle('active', on); b.setAttribute('aria-checked', on); });
}
async function renderPreview() {
  const p = curPage(), token = ++S.previewToken, has = !!p;
  $('#ed-empty').hidden = has; preview.hidden = !has; $('#ed-counter').hidden = !has;
  $$('.nav-arrow').forEach(b => (b.hidden = !has || S.doc.pages.length < 2));
  $('#strip-label').textContent = has ? `Page ${S.cur + 1} of ${S.doc.pages.length}` : 'Pages';
  if (!has) return;
  $('#ed-counter').textContent = `${S.cur + 1} / ${S.doc.pages.length}`;
  const wrap = $('#preview-wrap').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const maxDim = clamp(Math.round(Math.max(wrap.width, wrap.height) * dpr), 700, 2000);
  $('#ed-spin').hidden = false; await paint();
  try {
    const c = await renderPage(p, { maxDim });
    if (token !== S.previewToken) return;
    preview.width = c.width; preview.height = c.height; ctx2d(preview).drawImage(c, 0, 0);
  } catch (e) { console.error(e); toast('Could not render page'); }
  if (token === S.previewToken) $('#ed-spin').hidden = true;
}
function renderStrip() {
  const strip = $('#ed-strip'); strip.textContent = '';
  const mkAdd = (icon, label, fn) => {
    const b = document.createElement('button'); b.className = 'thumb-add'; b.setAttribute('aria-label', label);
    b.innerHTML = `<svg class="ico"><use href="#${icon}"/></svg><span>${label}</span>`; b.onclick = fn; return b;
  };
  S.doc.pages.forEach((p, i) => {
    const t = document.createElement('div'); t.className = 'thumb' + (i === S.cur ? ' active' : ''); t.draggable = true; t.dataset.i = i;
    t.innerHTML = `<img alt="Page ${i + 1}" src="${p.thumb}"><span class="num">${i + 1}</span>`;
    t.onclick = () => { S.cur = i; setGrid(false); refreshEditor(); };
    t.ondragstart = e => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; };
    t.ondragover = e => { e.preventDefault(); t.classList.add('drop'); };
    t.ondragleave = () => t.classList.remove('drop');
    t.ondrop = e => { e.preventDefault(); t.classList.remove('drop'); const from = +e.dataTransfer.getData('text/plain'); if (!isNaN(from)) movePage(from, i); };
    strip.appendChild(t);
  });
  strip.appendChild(mkAdd('i-camera', 'Scan', () => { S.doc.pages.length && scheduleSave(true); openCamera(); }));
  strip.appendChild(mkAdd('i-image', 'Import', () => pickFiles()));
  const act = strip.querySelector('.thumb.active'); if (act && !strip.classList.contains('expanded')) act.scrollIntoView({ inline: 'center', block: 'nearest' });
}
async function movePage(from, to) {
  const ps = S.doc.pages; if (from === to || to < 0 || to >= ps.length) return;
  const [p] = ps.splice(from, 1); ps.splice(to, 0, p); S.cur = to; scheduleSave(); refreshEditor();
}
async function updateCurrent(mutator, { invalidateOcr = false } = {}) {
  const p = curPage(); if (!p) return; mutator(p); p.ver++; if (invalidateOcr) p.ocr = null;
  await makeThumb(p); scheduleSave(); renderStrip(); updateFilterUI(); await renderPreview();
}
$('#ed-filters').addEventListener('click', e => {
  const b = e.target.closest('button[data-f]'); if (!b || !curPage()) return;
  S.filter = b.dataset.f; lsSet('ps.filter', S.filter); updateCurrent(p => { p.filter = S.filter; });
});
$('#pt-rotl').onclick = () => updateCurrent(p => { p.rot = (p.rot + 270) % 360; }, { invalidateOcr: true });
$('#pt-rotr').onclick = () => updateCurrent(p => { p.rot = (p.rot + 90) % 360; }, { invalidateOcr: true });
$('#pt-moveleft').onclick = () => movePage(S.cur, S.cur - 1);
$('#pt-moveright').onclick = () => movePage(S.cur, S.cur + 1);
$('#ed-prev').onclick = () => { S.cur = (S.cur - 1 + S.doc.pages.length) % S.doc.pages.length; refreshEditor(); };
$('#ed-next').onclick = () => { S.cur = (S.cur + 1) % S.doc.pages.length; refreshEditor(); };
$('#pt-all').onclick = async () => {
  const p = curPage(); if (!p) return;
  await withBusy('Applying filter to all pages…', async () => { for (const q of S.doc.pages) { q.filter = p.filter; q.ver++; await makeThumb(q); } });
  scheduleSave(); refreshEditor(); toast('Filter applied to all pages');
};
$('#pt-delete').onclick = async () => {
  const p = curPage(); if (!p || !confirm('Delete this page?')) return;
  await DB.del('blobs', p.id); srcCache.delete(p.id); S.doc.pages.splice(S.cur, 1); S.cur = clamp(S.cur, 0, S.doc.pages.length - 1);
  if (S.doc.pages.length) scheduleSave(true); else { await DB.del('docs', S.doc.id); }
  refreshEditor();
};
$('#pt-crop').onclick = async () => {
  const p = curPage(); if (!p) return;
  const src = await withBusy('Loading…', () => getSrcCanvas(p));
  const q = await askCrop(src, p.corners, { title: 'Edit corners', cancelLabel: 'Cancel' });
  showView('editor');
  if (q) await withBusy('Flattening page…', () => updateCurrent(pg => { pg.corners = q; }, { invalidateOcr: true }));
  else refreshEditor();
};
function setGrid(on) { $('#ed-strip').classList.toggle('expanded', on); $('#view-editor').classList.toggle('grid-open', on); $('#strip-toggle').lastChild.textContent = on ? 'Close' : 'Grid'; }
$('#strip-toggle').onclick = () => setGrid(!$('#ed-strip').classList.contains('expanded'));
$('#ed-back').onclick = async () => { await scheduleSave(true); S.doc = null; goLibrary(); };
$('#ed-name').addEventListener('input', e => { if (S.doc) { S.doc.name = e.target.value.trim() || 'Untitled scan'; scheduleSave(); } });
$('#ed-name').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

/* swipe left/right on the preview to change page */
(() => {
  let x0 = null; const w = $('#preview-wrap');
  w.addEventListener('pointerdown', e => { x0 = e.clientX; });
  w.addEventListener('pointerup', e => {
    if (x0 == null || !S.doc || S.doc.pages.length < 2) return; const dx = e.clientX - x0; x0 = null;
    if (Math.abs(dx) > 70) { S.cur = clamp(S.cur + (dx < 0 ? 1 : -1), 0, S.doc.pages.length - 1); refreshEditor(); }
  });
})();

/* ───────────────────────── import (file picker) ───────────────────────── */
const fileInput = $('#file-input');
function pickFiles() { fileInput.value = ''; fileInput.click(); }
fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files].filter(f => f.type.startsWith('image/') || /\.(heic|heif|png|jpe?g|webp|bmp|gif)$/i.test(f.name));
  if (!files.length) return;
  if (!S.doc) S.doc = newDoc();
  const wasCamera = S.view === 'camera'; if (wasCamera) { stopCamera(); }
  let added = 0;
  for (const f of files) {
    let canvas;
    try { canvas = await withBusy('Reading ' + f.name + '…', () => fileToCanvas(f)); }
    catch (e) { toast(`Could not open ${f.name}: ${e.message}`, 4000); continue; }
    const corners = detectDocument(canvas, 320) || fullQuad(0.05);
    if (await runCropFlow(canvas, corners, { title: files.length > 1 ? `Adjust corners (${added + 1}/${files.length})` : undefined })) added++;
  }
  if (S.doc && S.doc.pages.length) { if (wasCamera && added === 0) { openCamera(); return; } openEditor(S.doc, S.doc.pages.length - 1); }
  else { S.doc = null; goLibrary(); }
});

/* ───────────────────────── 7. OCR (tesseract.js runs in its own Web Worker) ───────────────────────── */
async function getOcrWorker(lang, onStatus) {
  if (S.ocrWorker && S.ocrLang === lang) return S.ocrWorker;
  if (S.ocrWorker) { try { await S.ocrWorker.terminate(); } catch { /* ignore */ } S.ocrWorker = null; }
  await loadLib('tesseract'); const info = await getVendorInfo(), abs = p => new URL(p, location.href).href;
  const local = info.libs && (info.langs || []).includes(lang);
  const opts = local
    ? { workerPath: abs('vendor/tesseract/worker.min.js'), corePath: abs('vendor/tesseract-core'), langPath: abs('vendor/tessdata') }
    : { workerPath: TESS.workerCdn, corePath: TESS.coreCdn, langPath: TESS.langCdn(lang) };
  onStatus && onStatus('Loading OCR engine…');
  S.ocrWorker = await window.Tesseract.createWorker(lang, 1, { ...opts, logger: m => { if (S.ocrLogger) S.ocrLogger(m); } });
  S.ocrLang = lang; return S.ocrWorker;
}
function structureOCR(data, w, h) {
  let lines = data.lines;
  if (!lines || !lines.length) { lines = []; for (const b of data.blocks || []) for (const p of b.paragraphs || []) lines.push(...(p.lines || [])); }
  const out = lines.map(l => ({
    text: (l.text || '').replace(/\s+$/, ''), bbox: l.bbox || null,
    words: (l.words || []).map(wd => ({ text: wd.text, bbox: wd.bbox, conf: wd.confidence }))
  })).filter(l => l.text.trim());
  return { w, h, text: (data.text || out.map(l => l.text).join('\n')).trim(), lines: out };
}
async function ocrPages(pages, lang, onProgress) {
  const worker = await getOcrWorker(lang, s => onProgress(0, s));
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]; if (p.ocr && p.ocr.lang === lang) { onProgress((i + 1) / pages.length, `Page ${i + 1}/${pages.length} (cached)`); continue; }
    S.ocrLogger = m => { if (m.status === 'recognizing text') onProgress((i + m.progress) / pages.length, `Recognizing page ${i + 1}/${pages.length}…`); else if (/load|init/i.test(m.status)) onProgress(i / pages.length, 'Loading language data…'); };
    const c = await renderPage(p, { maxDim: 2600, filter: p.filter === 'original' ? 'magic' : p.filter });
    const { data } = await worker.recognize(c);
    p.ocr = { lang, ...structureOCR(data, c.width, c.height) };
    onProgress((i + 1) / pages.length, `Page ${i + 1}/${pages.length} done`);
  }
  S.ocrLogger = null; scheduleSave();
}
function pagesText(pages) {
  return pages.map((p, i) => (pages.length > 1 ? `--- Page ${i + 1} ---\n` : '') + (p.ocr ? p.ocr.text : '')).join('\n\n').trim();
}
/** Turn OCR lines into table rows: split on wide word gaps, tabs, pipes and trailing prices. */
function linesToRows(lines) {
  const priceRe = /^(.*\S)\s+([-+(]?[$€£¥₹]?\s?\d[\d,]*(?:[.,]\d{1,2})?\)?\s?[A-Za-z%]{0,3})$/;
  const rows = lines.map(l => {
    let cells;
    if (l.words && l.words.length > 1 && l.bbox) {
      const lh = Math.max(1, l.bbox.y1 - l.bbox.y0), thr = lh * 1.1; let cur = [l.words[0].text]; cells = [];
      for (let i = 1; i < l.words.length; i++) {
        const gap = l.words[i].bbox.x0 - l.words[i - 1].bbox.x1;
        if (gap > thr) { cells.push(cur.join(' ')); cur = [l.words[i].text]; } else cur.push(l.words[i].text);
      }
      cells.push(cur.join(' '));
    } else cells = l.text.split(/\t|\s{2,}|\s*\|\s*/);
    return cells.map(c => c.trim()).filter((c, i, a) => c || a.length === 1);
  });
  const withPrice = rows.filter(r => r.length === 1 && priceRe.test(r[0]) && /[A-Za-z]/.test(r[0].match(priceRe)[1])).length;
  if (rows.length && withPrice / rows.length >= 0.3) rows.forEach(r => { if (r.length === 1) { const m = r[0].match(priceRe); if (m && /[A-Za-z]/.test(m[1])) { r[0] = m[1]; r.push(m[2]); } } });
  return rows;
}
function rowsToCSV(rows) {
  const n = Math.max(1, ...rows.map(r => r.length)), esc = v => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  return '﻿' + rows.map(r => Array.from({ length: n }, (_, i) => esc(r[i] || '')).join(',')).join('\r\n');
}

/* ───────────────────────── 8. export ───────────────────────── */
const modal = $('#modal-export');
function openExport() {
  if (!S.doc || !S.doc.pages.length) return toast('Add a page first');
  $$('.page-count').forEach(e => (e.textContent = S.doc.pages.length));
  const txt = S.doc.pages.some(p => p.ocr) ? pagesText(S.doc.pages) : ''; $('#ocr-text').value = txt;
  const lang = S.doc.pages.find(p => p.ocr); if (lang) $('#ocr-lang').value = lang.ocr.lang;
  modal.hidden = false;
}
$('#ed-export').onclick = openExport;
$('#exp-close').onclick = () => { modal.hidden = true; };
modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $$('.tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
});

function setOcrProgress(frac, status) {
  $('#ocr-progress').hidden = false; $('#ocr-bar').style.width = Math.round(clamp(frac, 0, 1) * 100) + '%'; $('#ocr-status').textContent = status || '';
}
async function runOcrUI() {
  const lang = $('#ocr-lang').value; $('#btn-ocr').disabled = true;
  try {
    await ocrPages(S.doc.pages, lang, setOcrProgress);
    $('#ocr-text').value = pagesText(S.doc.pages); setOcrProgress(1, 'Done');
  } catch (e) { console.error(e); toast('OCR failed: ' + e.message, 5000); $('#ocr-progress').hidden = true; }
  $('#btn-ocr').disabled = false;
}
$('#btn-ocr').onclick = runOcrUI;
$('#btn-warm').onclick = async () => {
  try { setOcrProgress(0.1, 'Downloading OCR engine…'); $('#ocr-progress').hidden = false; await getOcrWorker($('#ocr-lang').value, s => setOcrProgress(0.3, s)); setOcrProgress(1, 'OCR engine ready for offline use'); }
  catch (e) { toast('Could not download OCR engine: ' + e.message, 5000); $('#ocr-progress').hidden = true; }
};
$('#btn-txt').onclick = () => {
  const t = $('#ocr-text').value; if (!t.trim()) return toast('Run "Recognize text" first');
  download(new Blob([t], { type: 'text/plain;charset=utf-8' }), safeName(S.doc.name) + '.txt');
};
$('#btn-copy').onclick = async () => {
  const t = $('#ocr-text').value; if (!t.trim()) return toast('Run "Recognize text" first');
  try { await navigator.clipboard.writeText(t); toast('Copied to clipboard'); }
  catch { const ta = $('#ocr-text'); ta.select(); document.execCommand('copy'); toast('Copied'); }
};
$('#btn-csv').onclick = () => {
  if (!S.doc.pages.some(p => p.ocr)) return toast('Run "Recognize text" first');
  const rows = []; S.doc.pages.forEach((p, i) => { if (!p.ocr) return; if (i && rows.length) rows.push([]); rows.push(...linesToRows(p.ocr.lines)); });
  download(new Blob([rowsToCSV(rows)], { type: 'text/csv;charset=utf-8' }), safeName(S.doc.name) + '.csv');
};

const PDF_Q = { small: { maxDim: 1500, q: 0.7 }, std: { maxDim: 2200, q: 0.82 }, high: { maxDim: 3200, q: 0.92 } };
const PAGE_PT = { a4: [595.28, 841.89], letter: [612, 792] };
async function buildPDF({ size, quality, searchable }, progress) {
  await loadLib('jspdf'); const { jsPDF } = window.jspdf, Q = PDF_Q[quality], pages = S.doc.pages; let pdf = null;
  if (searchable) { await ocrPages(pages, $('#ocr-lang').value, (f, s) => progress(f * 0.5, s)); }
  for (let i = 0; i < pages.length; i++) {
    progress(searchable ? 0.5 + (i / pages.length) * 0.5 : i / pages.length, `Rendering page ${i + 1}/${pages.length}…`); await paint();
    const c = await renderPage(pages[i], { maxDim: Q.maxDim }), cw = c.width, ch = c.height;
    let pw, ph;
    if (size === 'fit') { pw = cw * 0.48; ph = ch * 0.48; } // ≈150 dpi
    else { [pw, ph] = PAGE_PT[size]; if (cw > ch) [pw, ph] = [ph, pw]; }
    const orient = pw > ph ? 'l' : 'p';
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [pw, ph], orientation: orient, compress: true }); else pdf.addPage([pw, ph], orient);
    const sc = Math.min(pw / cw, ph / ch), iw = cw * sc, ih = ch * sc, ix = (pw - iw) / 2, iy = (ph - ih) / 2;
    pdf.addImage(c.toDataURL('image/jpeg', Q.q), 'JPEG', ix, iy, iw, ih, undefined, 'FAST');
    const o = pages[i].ocr;
    if (searchable && o) { // invisible text layer positioned from OCR word boxes
      pdf.setFont('helvetica', 'normal');
      for (const l of o.lines) for (const wd of l.words) {
        const t = wd.text.replace(/[^\x20-\x7E\xA0-\xFF]/g, ''); if (!t.trim() || !wd.bbox) continue;
        const x0 = ix + (wd.bbox.x0 / o.w) * iw, x1 = ix + (wd.bbox.x1 / o.w) * iw, yb = iy + (wd.bbox.y1 / o.h) * ih, hh = ((wd.bbox.y1 - wd.bbox.y0) / o.h) * ih;
        const fs = Math.max(4, hh * 0.85); pdf.setFontSize(fs);
        const nat = pdf.getTextWidth(t), cs = t.length > 1 ? clamp((x1 - x0 - nat) / (t.length - 1), -fs * 0.5, fs * 3) : 0;
        pdf.text(t, x0, yb - hh * 0.2, { renderingMode: 'invisible', charSpace: cs });
      }
    }
  }
  pdf.setProperties({ title: S.doc.name, creator: 'PocketScan' }); return pdf.output('blob');
}
$('#btn-pdf').onclick = async () => {
  const btn = $('#btn-pdf'); btn.disabled = true;
  try {
    const blob = await withBusy('Building PDF…', () => buildPDF({ size: $('#pdf-size').value, quality: $('#pdf-quality').value, searchable: $('#pdf-searchable').checked }, (f, s) => { $('#busy-msg').textContent = `${s} ${Math.round(f * 100)}%`; }));
    download(blob, safeName(S.doc.name) + '.pdf'); toast('PDF saved');
  } catch (e) { console.error(e); toast('PDF export failed: ' + e.message, 5000); }
  btn.disabled = false;
};
$('#btn-img').onclick = async () => {
  const fmt = $('#img-format').value, scope = $('#img-scope').value, mime = fmt === 'png' ? 'image/png' : 'image/jpeg', ext = fmt === 'png' ? 'png' : 'jpg';
  const base = safeName(S.doc.name), pages = scope === 'all' ? S.doc.pages : [curPage()];
  try {
    await withBusy('Preparing images…', async () => {
      if (pages.length === 1) { const c = await renderPage(pages[0], { maxDim: 3200 }); download(await canvasToBlob(c, mime, 0.92), `${base}${scope === 'all' ? '-1' : '-' + (S.cur + 1)}.${ext}`); return; }
      await loadLib('jszip'); const zip = new window.JSZip();
      for (let i = 0; i < pages.length; i++) {
        $('#busy-msg').textContent = `Rendering page ${i + 1}/${pages.length}…`; await paint();
        zip.file(`${base}-${String(i + 1).padStart(2, '0')}.${ext}`, await canvasToBlob(await renderPage(pages[i], { maxDim: 3200 }), mime, 0.92));
      }
      download(await zip.generateAsync({ type: 'blob' }), base + '.zip');
    });
  } catch (e) { console.error(e); toast('Image export failed: ' + e.message, 5000); }
};

/* ───────────────────────── 9. library UI ───────────────────────── */
async function goLibrary() { showView('library'); await renderLibrary(); }
async function renderLibrary() {
  const docs = (await DB.all('docs')).sort((a, b) => b.updated - a.updated), grid = $('#doc-grid'); grid.textContent = '';
  $('#lib-empty').hidden = docs.length > 0;
  for (const d of docs) {
    const card = document.createElement('div'); card.className = 'doc-card'; card.tabIndex = 0; card.setAttribute('role', 'button');
    const thumb = document.createElement('div'); thumb.className = 'doc-thumb'; if (d.cover) thumb.style.backgroundImage = `url(${d.cover})`;
    const meta = document.createElement('div'); meta.className = 'doc-meta';
    const nm = document.createElement('div'); nm.className = 'doc-name'; nm.textContent = d.name;
    const sub = document.createElement('div'); sub.className = 'doc-sub'; sub.textContent = `${d.count} page${d.count === 1 ? '' : 's'} · ${new Date(d.updated).toLocaleDateString()}`;
    meta.append(nm, sub);
    const del = document.createElement('button'); del.className = 'doc-del'; del.setAttribute('aria-label', 'Delete ' + d.name); del.innerHTML = '<svg class="ico"><use href="#i-trash"/></svg>';
    del.onclick = async e => {
      e.stopPropagation(); if (!confirm(`Delete "${d.name}"?`)) return;
      for (const p of d.pages) { await DB.del('blobs', p.id); srcCache.delete(p.id); } await DB.del('docs', d.id); renderLibrary();
    };
    const open = () => openEditor(d, 0); card.onclick = open; card.onkeydown = e => { if (e.key === 'Enter') open(); };
    card.append(thumb, meta, del); grid.appendChild(card);
  }
}
$('#fab-scan').onclick = () => { S.doc = newDoc(); openCamera(); };
$('#fab-import').onclick = () => { S.doc = newDoc(); pickFiles(); };
$('#cam-close').onclick = closeCamera;
$('#cam-done').onclick = closeCamera;
$('#cam-shutter').onclick = capture;
$('#cam-gallery').onclick = pickFiles;
$('#cam-upload').onclick = pickFiles;
$('#cam-retry').onclick = startCamera;
$('#cam-flip').onclick = () => { cam.facing = cam.facing === 'environment' ? 'user' : 'environment'; startCamera(); };
$('#cam-torch').onclick = () => setTorch(!cam.torch);
$('#cam-auto').onclick = e => { cam.auto = !cam.auto; e.currentTarget.classList.toggle('active', cam.auto); e.currentTarget.setAttribute('aria-pressed', cam.auto); if (!cam.auto) { cam.quad = null; drawLiveQuad(); } };
// If the file picker is dismissed without a choice on the library, drop the empty draft doc.
fileInput.addEventListener('cancel', () => { if (S.doc && !S.doc.pages.length && S.view === 'library') S.doc = null; });

/* ───────────────────────── 10. boot: PWA, network, install ───────────────────────── */
function updateNet() { const p = $('#net-pill'); p.textContent = navigator.onLine ? 'Online' : 'Offline'; p.classList.toggle('offline', !navigator.onLine); }
window.addEventListener('online', updateNet); window.addEventListener('offline', updateNet); updateNet();
document.addEventListener('visibilitychange', () => { if (document.hidden && S.view === 'camera') stopCamera(); else if (!document.hidden && S.view === 'camera') startCamera(); });

let deferredInstall;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('#btn-install').hidden = false; });
$('#btn-install').onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#btn-install').hidden = true; };
window.addEventListener('appinstalled', () => { $('#btn-install').hidden = true; toast('PocketScan installed'); });
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone) $('#ios-hint').hidden = false;

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed', e));
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });

(async function boot() {
  await renderLibrary();
  const action = new URLSearchParams(location.search).get('action');
  if (action === 'scan') $('#fab-scan').click(); else if (action === 'import') $('#fab-import').click();
  // Warm the cache with the big libraries while idle (online first visit) so everything works offline later.
  (window.requestIdleCallback || (f => setTimeout(f, 3000)))(() => { if (navigator.onLine) ['jspdf', 'jszip'].forEach(n => loadLib(n).catch(() => { })); });
})();

// Test hook (harmless in production): lets automated tests drive the vision pipeline.
window.__ps = { detectDocument, warp, homography, filters: { filterBW, filterMagic, filterGray }, linesToRows, rowsToCSV, S, DB };
