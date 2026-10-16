# PocketScan - offline document scanner (PWA)

A CamScanner-style scanner that runs **entirely in the browser**: no backend, no account, no uploads.
Scan with the camera (or import photos), straighten the page, clean it up, run OCR, and export PDF / TXT / CSV / images.
Installable on iOS and Android and fully usable offline.

## Features

| Area | What you get |
|---|---|
| Capture | Live camera via `getUserMedia` (rear camera preferred), flip camera, torch toggle (where the browser exposes it), live edge-detection overlay, graceful permission/HTTPS/no-camera errors with an upload fallback |
| Import | PNG, JPG, WebP, HEIC/HEIF (native on Safari, `heic2any` fallback elsewhere), multi-select |
| Crop | Auto edge detection + 4 draggable corners with a magnifier loupe; true perspective (homography) warp to a flat rectangle |
| Filters | Original · B&W document mode (adaptive threshold) · Magic colour (shadow removal + contrast + sharpen) · Grayscale; apply to one page or all |
| Pages | Multi-page sessions, thumbnail strip + grid drawer, drag-to-reorder (desktop) or move buttons (touch), rotate, re-crop, delete, swipe between pages |
| Export | PDF (A4 / Letter / fit, 3 quality levels), **searchable PDF** (invisible OCR text layer), TXT, CSV, clipboard, PNG/JPG single or ZIP |
| OCR | `tesseract.js` in its own Web Worker; 11 languages in the UI; editable text before export |
| Offline | Service worker caches the shell + libraries; documents live in IndexedDB; installable manifest |

## Files

```
index.html            UI: library, camera, crop, editor, export modal
style.css             mobile-first styles (light/dark), no framework
app.js                camera, detection, homography, filters, OCR, export, storage
sw.js                 service worker (offline caching)
manifest.json         PWA metadata + icons + shortcuts
icons/                192 / 512 / maskable / apple-touch icons
package.json          only used for the optional self-hosted "vendor" build
scripts/vendor.mjs    copies libraries from node_modules into ./vendor
.github/workflows/    GitHub Pages deploy (bundles ./vendor for true offline)
```

## Run locally

The camera API requires a **secure context**: `https://` or `http://localhost`.

```bash
git clone https://github.com/<you>/pocketscan.git
cd pocketscan
python3 -m http.server 8080        # or: npx serve -l 8080 .
# open http://localhost:8080
```

To test on a phone, localhost won't work (it points at the phone itself). Either deploy to GitHub Pages (below), or tunnel
your dev server over HTTPS: `npx localtunnel --port 8080`, `cloudflared tunnel --url http://localhost:8080`, or `ngrok http 8080`.

### Library sources: CDN vs. self-hosted

By default, `jspdf`, `jszip` and `tesseract.js` load from a CDN (pinned versions) on first use, and the service worker caches them,
so **one online visit is enough**. The OCR language data (about 10 MB per language) is downloaded the first time you run OCR and is stored in
IndexedDB by tesseract.js. Open *Export → Text & CSV → "Download OCR engine for offline use"* while online to pre-fetch it.

For a build with **zero CDN dependency** (recommended for production / air-gapped use):

```bash
npm install
npm run vendor                      # copies libs + English OCR data to ./vendor
LANGS=eng,hin,spa npm run vendor    # add more OCR languages
```

`app.js` auto-detects `vendor/manifest.json` and prefers local files over the CDN. Commit `vendor/` (about 15 MB) or let the included GitHub Action build it.

## Deploy to GitHub Pages

**Option A - GitHub Action (recommended, bundles vendor/):**
1. Push the project to a GitHub repo (`main` branch).
2. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push again (or run the workflow manually). The site appears at `https://<user>.github.io/<repo>/`.

**Option B - plain branch deploy:**
1. (Optional) run `npm install && npm run vendor` and commit `vendor/`.
2. **Settings → Pages → Source: Deploy from a branch → `main` / root**.

All paths are relative, so project sites under `/<repo>/` work without changes. Pages serves HTTPS, so the camera works.

## Install on a phone

- **Android / Chrome:** open the site → menu → *Install app* (or use the in-app *Install* button).
- **iOS / Safari:** Share → *Add to Home Screen*. (iOS only allows camera access from Safari and installed home-screen apps.)

## How it works

- **Edge detection** (`detectDocument`): downscale → blur → Otsu threshold → flood-fill connected components → for each of
  the bright-on-dark and dark-on-bright masks pick the component whose four extreme points (min/max of x+y, x-y) enclose it best
  (fill ratio and area scoring). Runs about 4×/s on the live feed and once on the captured frame. Works best with a contrasting surface;
  otherwise drag the corners.
- **Perspective** (`homography` + `warp`): solves the 8×8 linear system for the matrix mapping the output rectangle to the quad, then inverse-maps every
  output pixel with bilinear sampling. Output size comes from the quad's edge lengths, capped at 3000 px (preview: about 1600 px).
- **Filters**: B&W is a Bradley adaptive threshold on an integral image. Magic estimates the paper colour (downscale → grey dilation → blur), divides it out
  (removes shadows, white-balances), applies a contrast curve, boosts saturation and sharpens.
- **Storage**: IndexedDB `docs` store (settings, thumbnails, OCR results) + `blobs` store (original photos, loaded lazily). Edits are non-destructive: crop corners,
  rotation and filter are re-applied from the original photo, so you can re-crop later.
- **Searchable PDF**: each page image is drawn full-page, then every OCR word is placed with `renderingMode: 'invisible'` at its bounding box.
- **CSV**: OCR lines are split on wide word gaps, tabs and pipes; receipt-style trailing prices are split into their own column when at least 30% of lines have one.

## Limitations

- Flashlight needs `ImageCapture`/torch support (Chrome on Android); iOS Safari does not expose it. The button hides when unsupported.
- The searchable-PDF text layer uses the built-in Helvetica font, so only Latin-1 characters are embedded. Non-Latin OCR (Hindi, Arabic, CJK) works for TXT/CSV/copy but is skipped in the PDF layer.
- Auto-detect assumes one rectangular page, rotated less than about 45°. Highly curved pages (open books) need manual corners.
- Processing runs on the main thread (OCR runs in a worker). Very large photos are downscaled to 3200 px on import to stay within mobile canvas memory limits.
- Browsers can evict site data under storage pressure; the app requests persistent storage, but export anything important.

## Customising

- Change cached files or versions → edit `SHELL` / `VERSION` in `sw.js` (bump `VERSION` on every release so clients refresh).
- Colours → CSS variables at the top of `style.css`. Name/icons → `manifest.json`, `index.html`, `icons/`.
- Pin other library versions → `LIBS` and `TESS` in `app.js` (and the `OPTIONAL` list in `sw.js`, `package.json`).

## Troubleshooting

- *Camera says "permission blocked"*: reset the site permission in the browser's address-bar menu, then press **Try again**.
- *Camera never appears*: you're on plain `http://` (not localhost). Use HTTPS.
- *OCR fails offline*: the engine and language data were never downloaded. Go online once and use "Download OCR engine for offline use", or use the `vendor` build.
- *Old version keeps loading*: bump `VERSION` in `sw.js`, or in DevTools → Application → Service Workers → *Unregister*.

## License

MIT for this project's code. Third-party libraries (jsPDF, JSZip, tesseract.js, heic2any) retain their own licenses.
