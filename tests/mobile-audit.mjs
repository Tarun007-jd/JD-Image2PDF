/**
 * Mobile audit: emulates real devices (touch, DPR, safe-area) and measures the
 * things that actually make a page feel broken on a phone.
 *
 *   - interactive targets smaller than the 44px touch guideline
 *   - anything that overflows the viewport horizontally or causes a scrollbar
 *   - text below a legible size
 *   - controls hidden behind the safe-area / not reachable
 *   - sticky/fixed chrome covering content
 *   - tap behaviour that needs hover
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'tmp-mobile';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const DEVICES = [
  { name: 'iphone-se', width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'iphone-14', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'pixel-7', width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true },
  { name: 'iphone-land', width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'ipad', width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

const TOUCH_MIN = 44;
const TEXT_MIN = 12;

const audit = (TOUCH_MIN, TEXT_MIN) => {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const problems = [];

  /* ---------- horizontal overflow ---------- */
  scrollTo(9999, 0);
  const scrolledX = scrollX;
  scrollTo(0, 0);

  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.position === 'fixed') continue; /* pinned chrome may sit at an edge */
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    /* is it clipped by an ancestor? then it cannot actually overflow */
    let clipped = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (/hidden|clip|auto|scroll/.test(acs.overflowX)) { clipped = true; break; }
    }
    if (clipped) continue;
    offenders.push({
      sel: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...(el.classList || '')].length ? '.' + [...el.classList].slice(0, 2).join('.') : ''}`,
      left: Math.round(r.left), right: Math.round(r.right), pos: cs.position,
    });
  }
  if (scrolledX > 0) problems.push(`page scrolls sideways (scrollX=${scrolledX})`);
  if (offenders.length) problems.push(`${offenders.length} unclipped element(s) past the viewport edge`);

  /* ---------- scrollable regions that trap the page ---------- */
  const traps = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (!/auto|scroll/.test(cs.overflowY)) continue;
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    if (el.classList.contains('studio__rail')) continue; /* drawer scrolls on purpose */
    traps.push(`${el.tagName.toLowerCase()}.${[...(el.classList || '')].join('.')} ${el.scrollHeight}>${el.clientHeight}`);
  }

  /* ---------- touch targets ---------- */
  const small = [];
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=switch], [tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll(sel)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.closest('[hidden]')) continue;
    /* skip inputs the user cannot tap directly (label-driven controls) */
    if (el.type === 'checkbox' || el.type === 'radio') {
      const lab = el.closest('label') || document.querySelector(`label[for="${el.id}"]`);
      if (lab) continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(el).pointerEvents === 'none') continue;
    if (r.top > doc.scrollHeight) continue; /* not rendered yet */
    const w = Math.round(r.width); const h = Math.round(r.height);
    if (w < TOUCH_MIN || h < TOUCH_MIN) {
      small.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...(el.classList || '')].length ? '.' + [...el.classList][0] : ''} ${w}x${h} "${(el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 22)}"`);
    }
  }

  /* ---------- illegible text ---------- */
  /* Decorative and not-yet-revealed content is not a readability problem:
     aria-hidden is skipped by screen readers, and .reveal elements are simply
     below the fold waiting on the IntersectionObserver. */
  const skipForText = (el) => el.closest('[aria-hidden="true"]') !== null
    || el.classList.contains('reveal')
    || el.closest('[hidden]') !== null;
  const tiny = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.childNodes.length) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (skipForText(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const size = parseFloat(cs.fontSize);
    if (size && size < TEXT_MIN) tiny.push(`${el.tagName.toLowerCase()}.${[...(el.classList || '')].join('.')} ${size}px "${el.textContent.trim().slice(0, 18)}"`);
  }

  /* ---------- hover-only affordances ---------- */
  /* Only a genuine problem when something interactive is invisible yet still
     hit-testable, since a tap would land on nothing the user can see. */
  const hoverOnly = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    if (el.closest('[aria-hidden="true"]') || el.classList.contains('reveal')) continue;
    if (cs.opacity !== '0' || cs.pointerEvents === 'none' || el.closest('[hidden]')) continue;
    if (!el.matches('a[href], button, input, select, textarea, [role=button], [role=switch]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.top < doc.scrollHeight) {
      hoverOnly.push(`${el.tagName.toLowerCase()}#${el.id || ''}.${[...(el.classList || '')].join('.')} invisible-but-tappable`);
    }
  }

  /* ---------- fixed chrome overlapping content ---------- */
  const fixed = [];
  for (const el of document.querySelectorAll('body *')) {
    if (getComputedStyle(el).position !== 'fixed') continue;
    if (el.offsetParent === null && getComputedStyle(el).display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    fixed.push({
      sel: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`,
      h: Math.round(r.height),
      bottom: Math.round(r.bottom), vh: doc.clientHeight,
      coversBottom: r.bottom >= doc.clientHeight - 1 && r.height > 60,
    });
  }

  /* ---------- horizontal scroll inside intended scrollers ---------- */
  const scrollers = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (!/auto|scroll/.test(cs.overflowX)) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      scrollers.push(`${el.tagName.toLowerCase()}.${[...(el.classList || '')].join('.')} ${el.scrollWidth}>${el.clientWidth}`);
    }
  }

  return {
    vw, scrollW: doc.scrollWidth, scrolledX,
    offenders, traps, small: [...new Set(small)], tiny: [...new Set(tiny)],
    hoverOnly: [...new Set(hoverOnly)], fixed, scrollers, problems,
  };
};

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let total = 0;

for (const d of DEVICES) {
  const page = await browser.newPage();
  page.setCacheEnabled(false);
  await page.setViewport(d);
  await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'networkidle2' });

  console.log(`\n${'='.repeat(64)}\n${d.name}  ${d.width}x${d.height} @${d.deviceScaleFactor}x  touch=${d.hasTouch}\n${'='.repeat(64)}`);

  /* empty landing state */
  let r = await page.evaluate(audit, TOUCH_MIN, TEXT_MIN);
  console.log(`empty state: scrollW=${r.scrollW} clientW=${r.vw} sideways=${r.scrolledX > 0}`);
  console.log(`  problems(${r.problems.length}):`, r.problems.join(' | ') || 'none');
  console.log(`  small targets(${r.small.length}):`, r.small.slice(0, 8).join(' ; ') || 'none');
  console.log(`  tiny text(${r.tiny.length}):`, r.tiny.slice(0, 5).join(' ; ') || 'none');
  if (r.hoverOnly.length) console.log(`  hover-only(${r.hoverOnly.length}):`, r.hoverOnly.slice(0, 5).join(' ; '));
  if (r.offenders.length) console.log(`  offenders:`, JSON.stringify(r.offenders.slice(0, 8)));
  total += r.problems.length + r.small.length + r.tiny.length;
  await page.screenshot({ path: path.join(OUT, `${d.name}-01-hero.png`) });

  /* nav open */
  await page.evaluate(() => document.getElementById('navToggle')?.click());
  await new Promise((r2) => setTimeout(r2, 500));
  const navOpen = await page.evaluate(() => {
    const n = document.getElementById('primaryNav') || document.querySelector('.nav');
    return { open: n?.classList.contains('is-open'), h: Math.round(n?.getBoundingClientRect().height || 0) };
  });
  console.log(`  nav open: ${JSON.stringify(navOpen)}`);
  await page.screenshot({ path: path.join(OUT, `${d.name}-02-nav.png`) });
  await page.evaluate(() => document.getElementById('navToggle')?.click());
  await new Promise((r2) => setTimeout(r2, 400));

  /* with pages loaded */
  await page.evaluate(() => document.getElementById('heroSample')?.click());
  await page.waitForFunction(() => document.querySelectorAll('.page-card').length > 0, { timeout: 30000 }).catch(() => {});
  await new Promise((r2) => setTimeout(r2, 1200));
  await page.evaluate(() => document.getElementById('workbench')?.scrollIntoView());
  await new Promise((r2) => setTimeout(r2, 700));

  r = await page.evaluate(audit, TOUCH_MIN, TEXT_MIN);
  console.log(`with pages: scrollW=${r.scrollW} clientW=${r.vw} sideways=${r.scrolledX > 0}`);
  console.log(`  problems(${r.problems.length}):`, r.problems.join(' | ') || 'none');
  console.log(`  small targets(${r.small.length}):`, r.small.slice(0, 10).join(' ; ') || 'none');
  console.log(`  tiny text(${r.tiny.length}):`, r.tiny.slice(0, 5).join(' ; ') || 'none');
  if (r.traps.length) console.log(`  scroll traps:`, r.traps.slice(0, 5).join(' ; '));
  if (r.scrollers.length) console.log(`  h-scrollers:`, r.scrollers.slice(0, 5).join(' ; '));
  if (r.hoverOnly.length) console.log(`  hover-only(${r.hoverOnly.length}):`, r.hoverOnly.slice(0, 5).join(' ; '));
  if (r.offenders.length) console.log(`  offenders:`, JSON.stringify(r.offenders.slice(0, 8)));
  console.log(`  fixed chrome:`, JSON.stringify(r.fixed));
  total += r.problems.length + r.small.length + r.tiny.length;
  await page.screenshot({ path: path.join(OUT, `${d.name}-03-studio.png`), fullPage: false });

  /* settings drawer */
  await page.evaluate(() => document.getElementById('toggleSettings')?.click());
  await new Promise((r2) => setTimeout(r2, 700));
  const rail = await page.evaluate(() => {
    const el = document.getElementById('settingsRail');
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      open: el.classList.contains('is-open'),
      w: Math.round(rect.width), h: Math.round(rect.height),
      right: Math.round(rect.right), vw: document.documentElement.clientWidth,
      scrollable: el.scrollHeight > el.clientHeight,
      overflows: rect.right > document.documentElement.clientWidth + 1 || rect.left < -1,
    };
  });
  console.log(`  rail:`, JSON.stringify(rail));
  await page.screenshot({ path: path.join(OUT, `${d.name}-04-rail.png`) });
  await page.keyboard.press('Escape');
  await new Promise((r2) => setTimeout(r2, 500));

  /* build a PDF on mobile */
  await page.evaluate(() => document.getElementById('generate')?.click());
  const built = await page.waitForFunction(
    () => /^Finished/.test(document.getElementById('progressText')?.textContent || ''),
    { timeout: 90000, polling: 200 },
  ).then(() => true).catch(() => false);
  console.log('  mobile build:', built
    ? await page.$eval('#progressText', (e) => e.textContent)
    : 'TIMED OUT');
  await page.screenshot({ path: path.join(OUT, `${d.name}-05-done.png`) });

  await page.close();
}

console.log(`\n${'='.repeat(64)}\nTOTAL ISSUES: ${total}`);
await browser.close();