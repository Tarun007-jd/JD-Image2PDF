/* =====================================================================
   JD Image2PDF — end-to-end verification
   Drives a real Chrome, exercises the UI, and inspects the PDFs that
   actually land on disk. Screenshots land in tmp-verify/.
   ===================================================================== */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE = 'http://127.0.0.1:5173/index.html';
const OUT = path.resolve('tmp-verify');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ helpers ----------------------------- */

let buildSeq = 0;

/** Clicks generate and waits for *this* build to report Finished. */
async function build(page, label = '') {
  const seq = ++buildSeq;
  /* snapshot the exact settings the engine will receive, so a later mismatch
     is diagnosable instead of mysterious */
  const before = await readSettings(page);
  await page.evaluate(() => {
    const el = document.getElementById('progressText');
    el.textContent = '';
    delete el.dataset.build;
  });
  await page.click('#generate');
  await page.waitForFunction(
    (s) => {
      const el = document.getElementById('progressText');
      return el.dataset.build === String(s) && /^Finished/.test(el.textContent);
    },
    { timeout: 90000, polling: 120 },
    seq,
  ).catch(() => problems.push(`build #${seq} (${label}) never finished`));
  await sleep(2200);
  const after = await page.evaluate(() => ({
    progress: document.getElementById('progressText').textContent,
    estimate: document.getElementById('estimateText').textContent,
    againVisible: !document.getElementById('downloadAgain').hidden,
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
  }));
  return { ...after, settings: pick(before) };
}

/* only the fields that change output geometry or content */
function pick(s) {
  const out = {};
  for (const k of ['size', 'orientation', 'fit', 'margin', 'resolution', 'quality',
    'footerOn', 'footerText', 'footerAlign', 'pageNumbers', 'lockOn', 'title']) {
    out[k] = s[k];
  }
  return out;
}

/** Sets a batch of form fields the way a user would. */
const setFields = (page, entries) => page.evaluate((list) => {
  for (const [sel, value, ev] of list) {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`missing field ${sel}`);
    el.value = value;
    el.dispatchEvent(new Event(ev || (el.tagName === 'SELECT' ? 'change' : 'input'), { bubbles: true }));
  }
}, entries);

/**
 * Switch toggles are click-driven, so a lost click silently desyncs the rest of
 * the run. Drive them by observed state instead of counting clicks.
 */
const setSwitch = async (page, sel, want) => {
  const now = await page.$eval(sel, (el) => el.getAttribute('aria-checked') === 'true');
  if (now !== want) await page.click(sel);
  await sleep(150);
  const after = await page.$eval(sel, (el) => el.getAttribute('aria-checked') === 'true');
  if (after !== want) problems.push(`${sel} would not switch to ${want} (still ${after})`);
  return after;
};

/** read the settings the engine will actually receive */
const readSettings = (page) => page.evaluate(async () => {
  const { getSettings } = await import('/assets/js/store.js');
  return getSettings();
});

/**
 * Ask the engine itself what boxes it intends to emit. Comparing the PDF against
 * planPage validates the write path (rotation bake, addImage, addPage sizes)
 * without hardcoding numbers that break whenever the fixture pages change.
 */
const plannedBoxes = (page) => page.evaluate(async () => {
  const { getPages, getSettings } = await import('/assets/js/store.js');
  const { planPage } = await import('/assets/js/pdf-engine.js');
  const pages = getPages();
  const settings = getSettings();
  return pages.map((p) => {
    const plan = planPage(p, settings, pages);
    return `${Math.round(plan.pageW * 100) / 100}x${Math.round(plan.pageH * 100) / 100}`;
  });
});

/**
 * Page content streams are Flate-compressed, so text written with doc.text()
 * is invisible to a raw byte scan. Inflate every stream so footer text and
 * page numbers can actually be found.
 */
function inflateStreams(buf) {
  const out = [];
  const s = buf.toString('latin1');
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    try {
      out.push(zlib.inflateSync(buf.subarray(start, end)).toString('latin1'));
    } catch { /* not a flate stream (image payload, etc.) */ }
    re.lastIndex = end;
  }
  return out;
}

function inspectPdf(file) {
  const buf = fs.readFileSync(file);
  const raw = buf.toString('latin1');
  const decoded = inflateStreams(buf).join('\n');
  const text = `${raw}\n${decoded}`;
  const boxes = [...raw.matchAll(/\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]/g)]
    .map((m) => `${Math.round((Number(m[3]) - Number(m[1])) * 100) / 100}x${Math.round((Number(m[4]) - Number(m[2])) * 100) / 100}`);
  return {
    file: path.basename(file),
    kb: Math.round(buf.length / 1024),
    valid: raw.startsWith('%PDF-') && raw.trimEnd().endsWith('%%EOF'),
    pages: (raw.match(/\/Type\s*\/Page[^s]/g) || []).length,
    boxes,
    encrypted: raw.includes('/Encrypt'),
    images: (raw.match(/\/Subtype\s*\/Image/g) || []).length,
    title: (raw.match(/\/Title\s*\(([^)]*)\)/) || [])[1],
    author: (raw.match(/\/Author\s*\(([^)]*)\)/) || [])[1],
    streams: inflateStreams(buf).length,
    hasFooterText: decoded.includes('Confidential'),
    hasPageNumber: /\b1 of \d\b/.test(decoded) || decoded.includes('Page 1'),
  };
}

/* ------------------------------- boot ------------------------------- */

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
/* never serve stale modules during verification */
await page.setCacheEnabled(false);
await page.setViewport({ width: 1440, height: 1000 });

page.on('console', (m) => {
  if (m.type() === 'error') { problems.push(`console.error: ${m.text()}`); log('  [error]', m.text()); }
});
page.on('pageerror', (e) => { problems.push(`pageerror: ${e.message}`); log('  [pageerror]', e.message); });
page.on('requestfailed', (r) => {
  if (r.url().includes('fonts.g')) { log('  [font network unavailable — using fallback stack]'); return; }
  problems.push(`requestfailed: ${r.url()}`);
});

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
await sleep(800);

/* ---------------------------- audit --------------------------------- */
log('== load ==');
const audit = await page.evaluate(() => ({
  missingIds: ['dropzone', 'fileInput', 'pages', 'toolbar', 'generate', 'settingsRail', 'progress', 'toasts']
    .filter((id) => !document.getElementById(id)),
  brokenUseRefs: [...document.querySelectorAll('use')]
    .map((u) => u.getAttribute('href'))
    .filter((h) => h?.startsWith('#') && !document.querySelector(h)),
  emptyIcons: [...document.querySelectorAll('svg.icon')].filter((s) => !s.querySelector('use')).length,
  seals: document.querySelectorAll('use[href="#seal"]').length,
  jsPDF: typeof globalThis.jspdf?.jsPDF === 'function',
  bodyFont: getComputedStyle(document.body).fontFamily.split(',')[0],
  displayFont: getComputedStyle(document.querySelector('.hero__title')).fontFamily.split(',')[0],
}));
log(JSON.stringify(audit));
if (audit.missingIds.length) problems.push(`missing ids: ${audit.missingIds}`);
if (audit.brokenUseRefs.length) problems.push(`broken icon refs: ${audit.brokenUseRefs}`);
if (audit.emptyIcons) problems.push(`${audit.emptyIcons} empty icons`);
if (audit.seals !== 3) problems.push(`expected 3 brand seals, found ${audit.seals}`);
if (!audit.jsPDF) problems.push('jsPDF missing');
await page.screenshot({ path: path.join(OUT, '01-hero.png') });

/* ---------------------------- theme --------------------------------- */
log('\n== theme ==');
await page.click('#themeToggle');
await sleep(450);
const themed = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.body).backgroundColor,
}));
log(JSON.stringify(themed));
if (themed.theme !== 'light') problems.push('theme toggle failed');
await page.screenshot({ path: path.join(OUT, '02-hero-light.png') });
await page.click('#themeToggle');
await sleep(400);

/* --------------------------- ingest --------------------------------- */
log('\n== add sample pages ==');
await page.click('#heroSample');
await sleep(2200);
const ingest = await page.evaluate(() => ({
  cards: document.querySelectorAll('.page-card').length,
  count: document.getElementById('pageCount').textContent,
  decoded: [...document.querySelectorAll('.page-card__thumb img')].filter((i) => i.naturalWidth > 0).length,
  dims: [...document.querySelectorAll('.page-card__dims')].map((d) => d.textContent),
  dropzoneHidden: document.getElementById('dropzone').hidden,
  generateEnabled: !document.getElementById('generate').disabled,
}));
log(JSON.stringify(ingest));
if (ingest.cards !== 4) problems.push(`expected 4 cards, got ${ingest.cards}`);
if (ingest.decoded !== 4) problems.push(`thumbnails not decoded (${ingest.decoded}/4)`);
if (!ingest.generateEnabled) problems.push('generate button disabled with pages present');
if (ingest.dims.some((d) => d === '—')) problems.push('page dimensions never resolved');

await page.evaluate(() => document.getElementById('workbench').scrollIntoView());
await sleep(900);
await page.screenshot({ path: path.join(OUT, '03-studio.png') });

/* ------------------------ page operations --------------------------- */
log('\n== page operations ==');
await page.click('.page-card:nth-child(2) [data-act="rotr"]');
await page.click('.page-card:nth-child(2) [data-act="dup"]');
await sleep(500);
let ops = await page.evaluate(() => ({
  cards: document.querySelectorAll('.page-card').length,
  rot: document.querySelector('.page-card:nth-child(2) .page-card__rot')?.textContent,
  names: [...document.querySelectorAll('.page-card__name')].map((n) => n.textContent),
  rotStyle: document.querySelector('.page-card:nth-child(2) .page-card__thumb img')?.style.transform,
}));
log(JSON.stringify(ops));
if (ops.cards !== 5) problems.push(`duplicate failed (${ops.cards})`);
if (ops.rot !== '90°') problems.push(`rotate failed (${ops.rot})`);
if (!ops.rotStyle?.includes('90deg')) problems.push('thumbnail does not preview the rotation');
if (!ops.names[2]?.includes('copy')) problems.push(`duplicate naming: ${ops.names[2]}`);

await page.click('.page-card:nth-child(3) [data-act="del"]');
await sleep(400);
ops = await page.evaluate(() => ({
  cards: document.querySelectorAll('.page-card').length,
  brokenThumbs: [...document.querySelectorAll('.page-card__thumb img')].filter((i) => i.complete && i.naturalWidth === 0).length,
}));
log(JSON.stringify(ops));
if (ops.cards !== 4) problems.push(`delete failed (${ops.cards})`);
if (ops.brokenThumbs) problems.push(`${ops.brokenThumbs} thumbnails lost their object URL`);

/* Alt+Arrow keyboard reorder */
await page.focus('.page-card:nth-child(1)');
await page.keyboard.down('Alt');
await page.keyboard.press('ArrowRight');
await page.keyboard.up('Alt');
await sleep(400);
const reordered = await page.evaluate(() => document.querySelector('.page-card:nth-child(2) .page-card__name').textContent);
log('after Alt+Arrow, page 2 =', reordered);
if (reordered !== 'jd-01-cover.png') problems.push(`keyboard reorder failed (${reordered})`);
await page.focus('.page-card:nth-child(2)');
await page.keyboard.down('Alt');
await page.keyboard.press('ArrowLeft');
await page.keyboard.up('Alt');
await sleep(300);

/* ------------------------- per-page override ------------------------ */
log('\n== per-page override ==');
await page.select('.page-card:nth-child(1) [data-page-prop="size"]', 'a4');
await page.select('.page-card:nth-child(1) [data-page-prop="orientation"]', 'landscape');
await sleep(400);
const override = await page.evaluate(() => ({
  overridden: document.querySelectorAll('.page-card.is-overridden').length,
  optsVisible: !document.querySelector('.page-card:nth-child(1) .page-card__opts').hidden,
  badge: !!document.querySelector('.page-card:nth-child(1) .page-card__badge'),
}));
log(JSON.stringify(override));
if (override.overridden !== 1 || !override.optsVisible || !override.badge) problems.push(`per-page override UI wrong: ${JSON.stringify(override)}`);

/* ---------------------------- settings ------------------------------ */
log('\n== settings ==');
await setFields(page, [
  ['#pageSize', 'a4'],
  ['#margin', '18'],
  ['#quality', '75'],
  ['#resolution', '150'],
  ['#filename', 'jd-test-doc'],
  ['#mTitle', 'Quarterly pack'],
  ['#mAuthor', 'JD'],
  ['#mSubject', 'Scanned document'],
  ['#footerText', 'Confidential JD'],
  ['#pageNumbers', 'n-of-t'],
  ['#password', 'hunter2'],
]);
await setSwitch(page, '#footerOn', true);
await setSwitch(page, '#lockOn', true);
await sleep(400);
const cfg = await page.evaluate(() => ({
  footerFieldsShown: !document.getElementById('footerFields').hidden,
  lockFieldsShown: !document.getElementById('lockFields').hidden,
  estimate: document.getElementById('estimateText').textContent,
  marginOut: document.getElementById('marginOut').textContent,
  qualityOut: document.getElementById('qualityOut').textContent,
  sizeSelect: document.getElementById('pageSize').value,
}));
log(JSON.stringify(cfg));
if (!cfg.footerFieldsShown || !cfg.lockFieldsShown) problems.push('switches did not reveal dependent fields');
if (/NaN|undefined/.test(cfg.estimate)) problems.push(`estimate is not a number: ${cfg.estimate}`);
if (cfg.sizeSelect !== 'a4') problems.push('page size did not persist');
await page.screenshot({ path: path.join(OUT, '04-settings.png') });

/* ---------------------------- generate ------------------------------ */
log('\n== generate: A4 + footer + encryption ==');
const client = await page.target().createCDPSession();
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT, eventsEnabled: true });

const run1 = await build(page, 'a4/footer/encrypted');
log(JSON.stringify(run1, null, 2));
if (!run1.againVisible) problems.push('download-again hidden after build');
if (!/^\d+ pages · \d/.test(run1.estimate)) problems.push(`estimate did not update to real size: ${run1.estimate}`);
await page.screenshot({ path: path.join(OUT, '05-done.png') });

/* plain run: auto page size, no margin, all rotated */
log('\n== generate: auto size, no margin, all pages rotated ==');
await page.click('#lockOn');
await setFields(page, [
  ['#pageSize', 'auto'], ['#margin', '0'], ['#quality', '92'],
  ['#resolution', '0'], ['#footerText', ''], ['#pageNumbers', 'off'],
  ['#filename', 'jd-auto'],
]);
await setSwitch(page, '#footerOn', false);
await page.click('#rotateAll');
await sleep(400);
const run2 = await build(page, 'auto/rotated');
log(JSON.stringify(run2));
/* engine's own intent for this exact page set + settings */
let autoWant = await plannedBoxes(page);
log('planned boxes:', JSON.stringify(autoWant));
await page.screenshot({ path: path.join(OUT, '06-auto-size.png') });

/* unencrypted run so the PDF structure can be introspected */
log('\n== generate: unencrypted, mixed sizes, footer + metadata ==');
await setFields(page, [
  ['#pageSize', 'auto'], ['#margin', '8'], ['#quality', '92'],
  ['#resolution', '0'], ['#filename', 'jd-open-doc'],
  ['#footerText', 'Confidential — JD Image2PDF'],
  ['#pageNumbers', 'n-of-t'], ['#footerAlign', 'center'],
  ['#mTitle', 'Quarterly pack'], ['#mAuthor', 'JD Studio'],
  ['#mSubject', 'Sample document'], ['#mKeywords', 'sample, brand, verification'],
]);
await setSwitch(page, '#footerOn', true);
await sleep(400);
const footerState = await readSettings(page);
log('footer store state:', JSON.stringify(pick(footerState)));
if (!footerState.footerOn) problems.push('footer switch did not turn on');
if (!footerState.footerText.trim()) problems.push(`footer text empty in store (${JSON.stringify(footerState.footerText)})`);
if (footerState.pageNumbers === 'off') problems.push('page numbers still off in store');
const run3 = await build(page, 'unencrypted');
log(JSON.stringify(run3));

/* --------------------------- fit modes ------------------------------ */
log('\n== fit modes (A4, 10mm margin) ==');
await setSwitch(page, '#footerOn', false);
await page.click('#rotateAll'); // back to 0
await setFields(page, [['#pageSize', 'a4'], ['#margin', '10'], ['#filename', 'jd-fit']]);
for (const fit of ['contain', 'cover', 'stretch']) {
  await page.click(`[data-seg="fit"][data-value="${fit}"]`);
  const r = await build(page, `fit=${fit}`);
  log(`  ${fit}: ${r.progress}`);
}

/* ---------------------------- responsive ---------------------------- */
log('\n== responsive ==');
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await sleep(900);
await page.evaluate(() => document.getElementById('workbench').scrollIntoView());
await sleep(600);
await page.screenshot({ path: path.join(OUT, '07-mobile-studio.png') });

const mobile = await page.evaluate(() => new Promise((res) => {
  const doc = document.documentElement;
  /* `overflow-x: clip` keeps scrollWidth inflated by off-canvas content, so the
     only honest test is whether the page can actually be scrolled sideways */
  scrollTo(9999, 0);
  const scrolledX = scrollX;
  scrollTo(0, 0);
  document.getElementById('toggleSettings').click();
  setTimeout(() => res({
    scrolledX,
    railOpen: document.getElementById('settingsRail').classList.contains('is-open'),
    railOnScreen: document.getElementById('settingsRail').getBoundingClientRect().right <= doc.clientWidth + 1,
    scrimShown: !document.getElementById('railScrim').hidden,
  }), 600);
}));
log(JSON.stringify(mobile));
if (mobile.scrolledX !== 0) problems.push(`page scrolls horizontally (scrollX reached ${mobile.scrolledX})`);
if (!mobile.railOpen) problems.push('mobile rail did not open');
if (!mobile.railOnScreen) problems.push('mobile rail did not slide into view');
if (!mobile.scrimShown) problems.push('mobile scrim not shown');
await page.screenshot({ path: path.join(OUT, '08-mobile-rail.png') });

await page.keyboard.press('Escape');
await sleep(400);
await page.evaluate(() => scrollTo(0, 0));
await sleep(400);
await page.screenshot({ path: path.join(OUT, '09-mobile-hero.png') });

await page.setViewport({ width: 820, height: 1180 });
await sleep(600);
await page.screenshot({ path: path.join(OUT, '10-tablet.png') });

/* --------------------------- full page ------------------------------ */
await page.setViewport({ width: 1440, height: 1000 });
await sleep(700);
for (const [name, sel] of [
  ['11-features', '#features'], ['12-how', '#how'], ['13-faq', '#faq'],
  ['14-cta', '.cta-band'], ['15-footer', '.site-footer'],
]) {
  await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), sel);
  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

/* ------------------------- inspect the PDFs ------------------------- */
log('\n== downloaded PDFs ==');
await sleep(1500);
const pdfs = fs.readdirSync(OUT).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
if (!pdfs.length) problems.push('no PDF downloaded');
for (const name of pdfs) {
  const info = inspectPdf(path.join(OUT, name));
  log(JSON.stringify(info));
  if (!info.valid) problems.push(`${name}: malformed PDF`);
  if (info.pages !== 4) problems.push(`${name}: expected 4 pages, got ${info.pages}`);
  if (info.images !== 4) problems.push(`${name}: expected 4 images, got ${info.images}`);
  const shouldBeEncrypted = name.startsWith('jd-test-doc');
  if (info.encrypted !== shouldBeEncrypted) problems.push(`${name}: encryption mismatch (encrypted=${info.encrypted})`);
}

/* encrypted output: strings must be scrambled, which proves encryption is real */
const enc = pdfs.find((f) => f.startsWith('jd-test-doc'));
if (enc) {
  const i = inspectPdf(path.join(OUT, enc));
  if (!i.encrypted) problems.push(`${enc}: /Encrypt dictionary missing`);
  if (i.title === 'Quarterly pack') problems.push(`${enc}: title left in plaintext — encryption not applied`);
}

/* unencrypted output: metadata and footer must be introspectable */
const plain = pdfs.find((f) => f.startsWith('jd-open-doc')) || pdfs.find((f) => f.startsWith('jd-plain'));
if (plain) {
  const i = inspectPdf(path.join(OUT, plain));
  if (i.title !== 'Quarterly pack') problems.push(`${plain}: title metadata missing (${i.title})`);
  if (i.encrypted) problems.push(`${plain}: unexpectedly encrypted`);
  if (!i.hasFooterText) problems.push(`${plain}: footer text not written`);
  if (!i.hasPageNumber) problems.push(`${plain}: page numbers not written`);
} else {
  problems.push('no unencrypted PDF to verify metadata against');
}

/* page 1 carries a per-page A4-landscape override and every page has been
   rotated, so this checks the whole write path: rotation bake, auto page sizing
   and per-page override must all land in the emitted /MediaBox values. */
const auto = pdfs.find((f) => f.startsWith('jd-auto'));
if (auto) {
  const i = inspectPdf(path.join(OUT, auto));
  log('auto boxes:   ', JSON.stringify(i.boxes));
  log('planPage says:', JSON.stringify(autoWant));
  if (JSON.stringify(i.boxes) !== JSON.stringify(autoWant)) {
    problems.push(`${auto}: emitted boxes do not match planPage`);
  }
  /* the override must actually be visible in the output */
  if (!autoWant.length || autoWant[0] !== '841.89x595.28') {
    problems.push(`per-page A4-landscape override missing from plan (page 1 = ${autoWant[0]})`);
  }
  /* auto sizing means at least one box is not a named preset */
  if (autoWant.every((b) => /^(595\.28x841\.89|841\.89x595\.28)$/.test(b))) {
    problems.push('auto page size did not take effect');
  }
}

await browser.close();

log('\n================ RESULT ================');
if (!problems.length) log('✅ ALL CHECKS PASSED');
else {
  log(`❌ ${problems.length} PROBLEM(S):`);
  for (const p of problems) log('  -', p);
}
fs.writeFileSync(path.join(OUT, 'problems.json'), JSON.stringify(problems, null, 2));
log(`pdfs: ${pdfs.join(', ') || 'none'}`);
process.exit(problems.length ? 1 : 0);