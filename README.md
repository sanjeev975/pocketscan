# PocketScan - Offline Document Scanner (PWA)

A privacy-first mobile document scanner that runs **entirely in your browser**: zero backend, no user accounts, and zero cloud uploads.

Scan via live camera (or import existing files), auto-detect edges, straighten perspective, enhance document clarity, run client-side OCR, and export directly to searchable PDF, TXT, CSV, or ZIP. Fully installable on iOS and Android with complete offline functionality.

[**Live Demo**](https://sanjeev975.github.io/pocketscan/) | [Report an Issue](https://github.com/sanjeev975/pocketscan/issues)

---

## Features

| Capability | Details |
|---|---|
| **Capture** | Live camera stream via `getUserMedia` (rear/environment camera preferred), camera switcher, torch toggle (where supported by browser hardware API), real-time edge detection overlay, and graceful HTTPS/permission fallback to manual file picker. |
| **Import** | Supports PNG, JPG, WebP, and HEIC/HEIF (native on Safari, dynamic `heic2any` fallback for other browsers), multi-file batch selection. |
| **Crop & Deskew** | Automatic quadrilateral document edge detection + 4 draggable corner pins with magnifier loupe; true perspective (homography) transformation to flat rectangular aspect ratios. |
| **Document Filters** | Original · Document B&W (Bradley adaptive threshold) · Magic Color (shadow removal + contrast stretch + unsharp mask) · Grayscale. Apply per page or batch-apply to all pages. |
| **Page Management** | Multi-page sessions, thumbnail strip + drawer grid view, drag-and-drop reordering (desktop) or touch step buttons, 90° rotation, re-crop, delete, swipe navigation. |
| **Export Formats** | Standard PDF (A4, Letter, Fit; 3 quality levels), **Searchable PDF** (invisible OCR text layer), TXT, tabular CSV, clipboard copy, single images (PNG/JPG), or ZIP archive. |
| **Client-Side OCR** | Powered by `tesseract.js` in a dedicated Web Worker; supports 11 selectable languages in UI; editable text pane before export. |
| **Offline-First** | Service Worker pre-caching application shell and dependencies; persistent IndexedDB document and raw photo blob storage; installable Web App Manifest. |

---

## Project Structure

```text
pocketscan/
├── index.html            # Main SPA layout: camera, crop canvas, editor, export dialogs
├── style.css             # Lightweight, responsive mobile-first UI (dark/light theme)
├── app.js                # Core controller: camera, CV algorithms, filters, OCR, exports
├── sw.js                 # Service worker caching strategy for complete offline operation
├── manifest.json         # Web App Manifest for native home-screen installation
├── icons/                # PWA icons (192px, 512px, maskable, apple-touch)
├── package.json          # Dependency specs for the optional local vendor build
├── scripts/
│   └── vendor.mjs        # Script to bundle vendor dependencies locally
└── .github/
    └── workflows/        # GitHub Actions workflow for automated Pages deployment
```

---

## Quick Start (Run Locally)

The camera API requires a **secure context** (`https://` or `http://localhost`).

```bash
# 1. Clone the repository
git clone https://github.com/sanjeev975/pocketscan.git
cd pocketscan

# 2. Start a local HTTP server
python3 -m http.server 8080
# or: npx serve -l 8080 .

# 3. Open in your browser
# http://localhost:8080
```

> **Testing on mobile devices:**  
> Accessing `localhost` directly on a mobile phone will fail (it resolves to the phone itself). To test live camera feeds on a phone during local development, tunnel your local port over HTTPS:
> ```bash
> npx localtunnel --port 8080
> # or: cloudflared tunnel --url http://localhost:8080
> # or: ngrok http 8080
> ```

---

## Offline Assets: CDN vs. Self-Hosted

By default, runtime libraries (`jspdf`, `jszip`, `tesseract.js`) load from pinned CDNs on first use and are permanently cached by the Service Worker for subsequent offline use. OCR language training models (~10 MB per language) download on initial extraction and persist in IndexedDB.

### Fully Air-Gapped / Vendor Build (Zero CDN Dependency)

To bundle all libraries and language data locally for air-gapped or guaranteed offline use:

```bash
npm install
npm run vendor                       # Copies libs + English OCR model to ./vendor
LANGS=eng,hin,spa npm run vendor     # Add more OCR training languages as needed
```

`app.js` automatically detects `vendor/manifest.json` and prioritizes local vendor scripts over CDN requests.

---

## Deploy to GitHub Pages

### Option A: GitHub Actions (Recommended)
1. Push your code to the `main` branch.
2. In your GitHub repository, navigate to: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push a commit or manually trigger the workflow from the **Actions** tab.
4. Your site will be live at: `https://sanjeev975.github.io/pocketscan/`

### Option B: Deploy from Branch
1. *(Optional)* Run `npm run vendor` locally and commit the `vendor/` folder.
2. Go to **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Select branch: `main` and folder: `/ (root)`. Click **Save**.

---

## Mobile Installation (PWA)

* **Android (Chrome):** Tap the browser menu `⋮` → **Install app** (or use the in-app *Install* button).
* **iOS (Safari):** Tap the **Share** button → **Add to Home Screen**. *(Note: iOS Safari only grants camera access within Safari tabs or installed home screen PWAs).*

---

## Technical Pipeline

* **Edge Detection (`detectDocument`):** Downscales the frame → applies Gaussian blur → runs Otsu thresholding → flood-fills connected components. Scans dual masks (bright-on-dark and dark-on-bright) and selects the component whose 4 extreme coordinates form the best-scoring bounding quad.
* **Perspective Rectification (`homography` + `warp`):** Solves an 8×8 linear system to compute the 3×3 projective homography matrix mapping the distorted quad to an orthogonal rectangle. Applies reverse pixel mapping with bilinear sampling (capped at 3000 px).
* **Filter Algorithms:**
  * **Document B&W:** Bradley-Roth local adaptive thresholding over an integral image map for uneven lighting correction.
  * **Magic Color:** Background illumination estimation via morphological grayscale dilation and blur; pixel-level division for shadow suppression, contrast stretching, and unsharp masking.
* **Non-Destructive Storage:** IndexedDB key-value stores (`docs` for session state, thumbnails, and OCR strings; `blobs` for raw captured images). Crop coordinates, rotations, and filters can be re-adjusted anytime without re-capturing.
* **Searchable PDF Engine:** Renders document canvases at native dimensions, overlaying word-level OCR text boxes at matching coordinates using invisible text mode (`renderingMode: 'invisible'`).
* **CSV Export:** Tokenizes OCR lines across tab stops, pipes, and wide whitespace gaps; parses trailing price patterns into dedicated columns when detected in ≥30% of lines.

---

## Hardware & Environment Limitations

* **Hardware Torch:** Flashlight control relies on the `ImageCapture` API (`torch` constraint), supported in Chromium-based browsers on Android. iOS Safari does not expose hardware torch controls.
* **Searchable PDF Font Support:** The invisible OCR text layer uses built-in PDF standard Type 1 Helvetica (Latin-1 range). Non-Latin OCR languages (Hindi, Japanese, Arabic, etc.) export cleanly via TXT, CSV, or clipboard, but are omitted from the PDF text overlay.
* **Curved Surfaces:** Edge detection expects single flat pages angled under 45°. Bound book gutters and heavily folded documents require manual corner adjustments.
* **Memory Limits:** Images above 3200 px are downscaled proportionally on import to prevent mobile canvas out-of-memory errors.
* **Storage Eviction:** Browsers can evict IndexedDB records under severe device storage pressure. Always export finalized scans.

---

## Configuration & Customization

* **Service Worker Caching:** Update `SHELL` or increment `VERSION` in `sw.js` to invalidate client caches across new releases.
* **Styling & Themes:** Modify CSS custom properties at the top of `style.css`.
* **App Identity & Icons:** Adjust app details in `manifest.json`, `index.html`, and replace assets inside `icons/`.
* **Pinned Dependencies:** Update library hashes/versions inside `LIBS` and `TESS` in `app.js` and `sw.js`.

---

## Troubleshooting

| Symptom | Cause | Resolution |
|---|---|---|
| Camera permission blocked | Permission denied in browser | Reset site camera permissions in browser address bar settings and click *Try again*. |
| Camera feed black / missing | Running on insecure origin | Access site via `https://` or `http://localhost`. Plain `http://` IP addresses block camera access. |
| OCR fails when offline | Models not cached locally | Connect online once and select *Export → Text & CSV → "Download OCR engine for offline use"*, or run the vendor build. |
| Outdated code keeps loading | Aggressive Service Worker cache | Increment `VERSION` in `sw.js`, or unregister the worker in browser DevTools (**Application → Service Workers**). |

---

## License

This project is licensed under the [MIT License](LICENSE).

### Third-Party Dependencies
This project uses the following open-source libraries:
* **[jsPDF](https://github.com/parallax/jsPDF)** (MIT License) - Client-side PDF generation
* **[JSZip](https://github.com/Stuk/jszip)** (MIT License / GPLv3) - ZIP archive compression
* **[tesseract.js](https://github.com/naptha/tesseract.js)** (Apache License 2.0) - In-browser OCR engine
* **[heic2any](https://github.com/alexcorvi/heic2any)** (MIT License) - HEIC/HEIF image conversion
