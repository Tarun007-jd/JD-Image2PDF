/* =====================================================================
   Unit tests for the layout engine, executed inside a real browser.
   Usage: node tests/geometry.test.mjs
   ===================================================================== */
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'domcontentloaded' });

const results = await page.evaluate(async () => {
  const { planPage, estimateBytes, outputName, buildEncryption, MM, PAGE_SIZES } =
    await import('/assets/js/pdf-engine.js');

  const tests = [];
  const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
  const check = (name, actual, expected, tol = 0.5) => {
    const ok = typeof expected === 'number' ? near(actual, expected, tol) : actual === expected;
    tests.push({ name, ok, actual: round(actual), expected: round(expected) });
  };
  const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

  const S = (over = {}) => ({
    size: 'a4', orientation: 'auto', margin: 0, fit: 'contain',
    resolution: 0, quality: 88, ...over,
  });
  const P = (w, h, over = {}) => ({
    id: 'x', w, h, rotation: 0,
    sizeTouched: false, orientationTouched: false, fitTouched: false,
    size: 'a4', orientation: 'auto', fit: 'contain', ...over,
  });

  const A4_SHORT = 210 * MM;   // 595.28 pt
  const A4_LONG = 297 * MM;    // 841.89 pt

  /* --- paper geometry ------------------------------------------------- */
  check('a4 portrait image -> portrait page', planPage(P(1000, 1414), S()).pageW, A4_SHORT);
  check('a4 portrait image -> page height', planPage(P(1000, 1414), S()).pageH, A4_LONG);
  check('a4 landscape image -> landscape page', planPage(P(1600, 1067), S()).pageW, A4_LONG);
  check('a4 landscape image -> page height', planPage(P(1600, 1067), S()).pageH, A4_SHORT);
  check('forced portrait on landscape image', planPage(P(1600, 1067), S({ orientation: 'portrait' })).pageW, A4_SHORT);
  check('forced landscape on portrait image', planPage(P(1000, 1414), S({ orientation: 'landscape' })).pageW, A4_LONG);

  /* --- rotation ------------------------------------------------------- */
  check('90deg swaps page to landscape', planPage(P(1000, 1414, { rotation: 90 }), S()).pageW, A4_LONG);
  check('180deg keeps portrait', planPage(P(1000, 1414, { rotation: 180 }), S()).pageW, A4_SHORT);
  check('270deg swaps page to landscape', planPage(P(1000, 1414, { rotation: 270 }), S()).pageW, A4_LONG);
  check('90deg marks swapped', planPage(P(1000, 1414, { rotation: 90 }), S()).swapped, true);
  check('180deg not swapped', planPage(P(1000, 1414, { rotation: 180 }), S()).swapped, false);
  check('normalised 450 -> 90', planPage(P(1000, 1414, { rotation: 450 }), S()).pageW, A4_LONG);
  check('normalised -90 -> 270', planPage(P(1000, 1414, { rotation: -90 }), S()).pageW, A4_LONG);

  /* --- per-page override wins ----------------------------------------- */
  check('page override beats document', planPage(P(1000, 1414, { sizeTouched: true, size: 'letter' }), S()).pageW, 612);
  check('page override fit beats document', planPage(P(1000, 1414, { fitTouched: true, fit: 'stretch' }), S({ margin: 10 })).drawW, A4_SHORT - 20 * MM);

  /* --- fit modes ------------------------------------------------------ */
  const m = 20 * MM;
  const contain = planPage(P(4000, 3000), S({ size: 'auto', margin: 0, fit: 'contain' }));
  check('auto+contain zero margin keeps px size', contain.drawW, 4000 * 0.75);
  check('auto+contain no overflow', contain.drawW <= contain.pageW, true);

  const stretch = planPage(P(1000, 1414), S({ margin: 20, fit: 'stretch' }));
  check('stretch fills width', stretch.drawW, A4_SHORT - 2 * m);
  check('stretch fills height', stretch.drawH, A4_LONG - 2 * m);

  const cover = planPage(P(1000, 1414), S({ margin: 20, fit: 'cover' }));
  check('cover overflows on one axis', cover.drawW >= A4_SHORT - 2 * m || cover.drawH >= A4_LONG - 2 * m, true);
  check('cover keeps aspect', cover.drawW / cover.drawH, 1000 / 1414, 0.01);

  const contain2 = planPage(P(1000, 1414), S({ margin: 20, fit: 'contain' }));
  check('contain stays inside', contain2.drawW <= A4_SHORT - 2 * m + 0.01 && contain2.drawH <= A4_LONG - 2 * m + 0.01, true);
  check('contain centred horizontally', contain2.drawX + contain2.drawW / 2, A4_SHORT / 2);
  check('contain centred vertically', contain2.drawY + contain2.drawH / 2, A4_LONG / 2);

  /* --- margin --------------------------------------------------------- */
  check('margin 40mm inset', planPage(P(1000, 1414), S({ margin: 40, fit: 'stretch' })).drawX, 40 * MM);
  check('negative margin clamps to 0', planPage(P(1000, 1414), S({ margin: -20 })).margin, 0);

  /* --- estimate scales with dpi and quality --------------------------- */
  /* on a fixed paper size a 4000px photo is ~490 DPI, so caps bite hard */
  const A4SET = { size: 'a4', orientation: 'auto', margin: 0 };
  const pages = [P(4000, 3000), P(4000, 3000), P(4000, 3000)];
  const full = estimateBytes(pages, S({ ...A4SET, resolution: 0, quality: 88 }));
  const dpi300 = estimateBytes(pages, S({ ...A4SET, resolution: 300, quality: 88 }));
  const dpi150 = estimateBytes(pages, S({ ...A4SET, resolution: 150, quality: 88 }));
  const dpi96 = estimateBytes(pages, S({ ...A4SET, resolution: 96, quality: 88 }));
  const lowQ = estimateBytes(pages, S({ ...A4SET, resolution: 0, quality: 45 }));
  check('estimate is finite', Number.isFinite(full), true);
  check('150dpi is smaller than full', dpi150 < full, true);
  check('96dpi smaller than 150dpi', dpi96 < dpi150, true);
  check('300dpi smaller than full', dpi300 < full, true);
  check('96dpi drops below 15% of full', dpi96 / full < 0.15, true);
  check('lower quality is smaller', lowQ < full, true);
  check('estimate has per-page overhead', estimateBytes([], S(A4SET)), 0);
  check('three pages cost more than one', estimateBytes(pages, S(A4SET)) > estimateBytes([pages[0]], S(A4SET)), true);

  /* with "match image" the page already equals the bitmap, so a DPI cap
     cannot shrink anything — it must never upscale or corrupt either */
  const autoSet = { size: 'auto', margin: 0, resolution: 0, quality: 88 };
  check('auto size: dpi cap is a no-op', estimateBytes([P(4000, 3000)], S({ ...autoSet, resolution: 150 })), estimateBytes([P(4000, 3000)], S(autoSet)));

  /* --- file naming ---------------------------------------------------- */
  check('plain name', outputName({ filename: 'report' }), 'report.pdf');
  check('keeps extension', outputName({ filename: 'report.pdf' }), 'report.pdf');
  check('strips illegal chars', outputName({ filename: 'a/b:c*d?e"f<g>h|i' }), 'a-b-c-d-e-f-g-h-i.pdf');
  check('empty falls back', outputName({ filename: '   ' }), 'document.pdf');
  check('trims length', outputName({ filename: 'x'.repeat(200) }).length, 94);

  /* --- encryption ----------------------------------------------------- */
  check('no lock -> undefined', buildEncryption({ lockOn: false }), undefined);
  const enc = buildEncryption({
    lockOn: true, password: 'pw', perms: { print: true, copy: false, modify: false, annotate: true },
  });
  check('user password', enc.userPassword, 'pw');
  check('print token', enc.userPermissions.includes('print'), true);
  check('annotate token', enc.userPermissions.includes('annot-forms'), true);
  check('copy excluded', enc.userPermissions.includes('copy'), false);
  check('modify excluded', enc.userPermissions.includes('modify'), false);

  /* --- all presets have sane numbers --------------------------------- */
  for (const [key, [shortS, longS]] of Object.entries(PAGE_SIZES)) {
    const pl = planPage(P(1000, 1000), S({ size: key, orientation: 'auto' }));
    const ok = (near(pl.pageW, shortS * MM, 0.6) && near(pl.pageH, longS * MM, 0.6))
      || (near(pl.pageW, longS * MM, 0.6) && near(pl.pageH, shortS * MM, 0.6));
    tests.push({ name: `preset ${key} matches spec`, ok, actual: `${round(pl.pageW)}x${round(pl.pageH)}`, expected: `${shortS * MM}x${longS * MM}` });
  }

  return tests;
});

await browser.close();

const failed = results.filter((t) => !t.ok);
for (const t of results) {
  console.log(`  ${t.ok ? 'PASS' : 'FAIL'}  ${t.name}${t.ok ? '' : `  (got ${t.actual}, want ${t.expected})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} geometry tests passed`);
process.exit(failed.length ? 1 : 0);