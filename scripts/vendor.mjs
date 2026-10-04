/* =====================================================================
   Re-vendors the jsPDF UMD build into vendor/ so the app keeps working
   with no network access at runtime.

   Usage: npm run vendor
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('vendor');
const OUT_FILE = path.join(OUT_DIR, 'jspdf.umd.min.js');
const pkg = JSON.parse(fs.readFileSync(path.join(OUT_DIR, '..', 'node_modules', 'jspdf', 'package.json'), 'utf8'));

const candidates = [
  path.join('node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js'),
  path.join('node_modules', 'jspdf', 'dist', 'jspdf.umd.js'),
];

const src = candidates.find((c) => fs.existsSync(c));
if (!src) {
  console.error(`Could not find a jsPDF UMD build. Looked in:\n  ${candidates.join('\n  ')}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const bytes = fs.readFileSync(src);
fs.writeFileSync(OUT_FILE, bytes);

console.log(`Vendored jsPDF ${pkg.version}`);
console.log(`  from  ${src}`);
console.log(`  to    ${OUT_FILE}`);
console.log(`  size  ${(bytes.length / 1024).toFixed(1)} KB`);
