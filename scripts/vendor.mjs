#!/usr/bin/env node
/**
 * Copies third-party libraries from node_modules into ./vendor so the app can be
 * self-hosted with ZERO CDN dependency (fully offline from the very first visit).
 *
 *   npm install && npm run vendor
 *   LANGS=eng,hin,spa npm run vendor      # extra OCR languages
 */
import { cpSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const nm = 'node_modules';
const out = 'vendor';
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'tesseract'), { recursive: true });
mkdirSync(join(out, 'tesseract-core'), { recursive: true });
mkdirSync(join(out, 'tessdata'), { recursive: true });

const copy = (from, to) => {
  if (!existsSync(from)) throw new Error(`Missing ${from} - run "npm install" first`);
  cpSync(from, to);
  console.log('  +', to);
};

copy(`${nm}/jspdf/dist/jspdf.umd.min.js`, `${out}/jspdf.umd.min.js`);
copy(`${nm}/jszip/dist/jszip.min.js`, `${out}/jszip.min.js`);
copy(`${nm}/heic2any/dist/heic2any.min.js`, `${out}/heic2any.min.js`);
copy(`${nm}/tesseract.js/dist/tesseract.min.js`, `${out}/tesseract/tesseract.min.js`);
copy(`${nm}/tesseract.js/dist/worker.min.js`, `${out}/tesseract/worker.min.js`);
for (const f of readdirSync(`${nm}/tesseract.js-core`)) {
  if (f.startsWith('tesseract-core')) copy(`${nm}/tesseract.js-core/${f}`, `${out}/tesseract-core/${f}`);
}

const langs = (process.env.LANGS || 'eng').split(',').map(s => s.trim()).filter(Boolean);
for (const l of langs) {
  const dir = `${nm}/@tesseract.js-data/${l}`;
  if (!existsSync(dir)) {
    console.log(`  installing @tesseract.js-data/${l} ...`);
    execSync(`npm install --no-save --no-audit --no-fund @tesseract.js-data/${l}`, { stdio: 'inherit' });
  }
  copy(`${dir}/4.0.0_best_int/${l}.traineddata.gz`, `${out}/tessdata/${l}.traineddata.gz`);
}

writeFileSync(join(out, 'manifest.json'), JSON.stringify({ libs: true, langs, built: new Date().toISOString() }, null, 2));
console.log('\nDone. Commit the vendor/ folder (or build it in CI) to ship a fully self-hosted app.');
