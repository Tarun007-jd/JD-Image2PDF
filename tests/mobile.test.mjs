/**
 * Regression suite for the mobile work. These are behavioural assertions that
 * only fail on a real touch device profile, so a desktop e2e run cannot catch
 * them. Each check maps to a specific bug fixed in this pass.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'tmp-mobile-verify';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const DEVICES = [
  { name: 'iphone-se', width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'iphone-14', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'pixel-7', width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true },
  { name: 'iphone-land', width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];

const TOUCH_MIN = 44;
const problems = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

for (const d of DEVICES) {
  const page = await browser.newPage();
  page.setCacheEnabled(false);
  await page.setViewport(d);
  page.on('pageerror', (e) => problems.push(`${d.name}: pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${d.name}: console.error ${m.text()}`); });
  await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'networkidle2' });

  console.log(`\n${'='.repeat(60)}\n${d.name} ${d.width}x${d.height}\n${'='.repeat(60)}`);

  /* ---- 1. layout viewport must equal the visual viewport ----
     Regression: overflow-x:clip only on <html> left the ICB at 469px on a
     390px phone, so every fixed control anchored off-screen. */
  const icb = await page.evaluate(() => ({
    clientW: document.documentElement.clientWidth,
    innerW: window.innerWidth,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
  }));
  ok(icb.innerW === icb.clientW, `${d.name}: layout viewport inflated (innerW=${icb.innerW} vs clientW=${icb.clientW})`);
  ok(icb.bodyOverflowX === 'clip', `${d.name}: body overflow-x is "${icb.bodyOverflowX}", expected clip`);
  console.log(`  ICB ok: innerW=${icb.innerW} clientW=${icb.clientW} bodyOverflowX=${icb.bodyOverflowX}`);

  /* ---- 2. no sideways scrolling ---- */
  const sideways = await page.evaluate(() => { scrollTo(9999, 0); const x = scrollX; scrollTo(0, 0); return x; });
  ok(sideways === 0, `${d.name}: page scrolls sideways (scrollX=${sideways})`);
  console.log(`  no sideways scroll: ${sideways === 0}`);

  /* ---- 3. every interactive target is at least 44x44 ---- */
  const small = await page.evaluate((min) => {
    const out = [];
    const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=switch]';
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.closest('[hidden]')) continue;
      /* elements that cannot be tapped right now are not touch targets */
      if (cs.pointerEvents === 'none') continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        const lab = el.closest('label') || document.querySelector(`label[for="${el.id}"]`);
        if (lab) continue; /* label provides the target */
      }
      /* offsetWidth/Height is the laid-out size and ignores transforms, so an
         element parked mid-entry-animation (e.g. the to-top FAB at scale(.9)
         before it fades in) is not falsely reported as too small. */
      const w = el.offsetWidth; const h = el.offsetHeight;
      if (!w || !h) continue;
      if (w < min || h < min) {
        out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...(el.classList || [])].join('.')} "${(el.textContent || '').trim().slice(0, 16)}" ${w}x${h}`);
      }
    }
    return [...new Set(out)];
  }, TOUCH_MIN);
  ok(!small.length, `${d.name}: touch targets under ${TOUCH_MIN}px: ${small.join('; ')}`);
  console.log(`  touch targets >= ${TOUCH_MIN}px: ${small.length ? small.join('; ') : 'all ok'}`);

  /* ---- 4. no text below the 12px legibility floor ---- */
  const tiny = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!el.childNodes.length) continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.closest('[aria-hidden="true"]') || el.classList.contains('reveal') || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const size = parseFloat(cs.fontSize);
      if (size && size < 12) out.push(`${el.tagName.toLowerCase()}.${[...(el.classList || [])].join('.')} ${size}px`);
    }
    return [...new Set(out)];
  });
  ok(!tiny.length, `${d.name}: text under 12px: ${tiny.join('; ')}`);
  console.log(`  text >= 12px: ${tiny.length ? tiny.join('; ') : 'all ok'}`);

  /* ---- 5. text inputs are >= 16px so iOS does not zoom on focus ---- */
  const smallInputs = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('input[type=text], input[type=password], input[type=number], select, textarea')) {
      if (getComputedStyle(el).display === 'none') continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16) out.push(`${el.tagName.toLowerCase()}#${el.id || ''} ${size}px`);
    }
    return [...new Set(out)];
  });
  ok(!smallInputs.length, `${d.name}: inputs under 16px trigger iOS zoom: ${smallInputs.join('; ')}`);
  console.log(`  inputs >= 16px: ${smallInputs.length ? smallInputs.join('; ') : 'all ok'}`);

  /* ---- 6. load pages, then re-check layout with content present ---- */
  await page.evaluate(() => document.getElementById('heroSample').click());
  await page.waitForFunction(() => document.querySelectorAll('.page-card').length > 0, { timeout: 30000 });
  await sleep(1400);
  await page.evaluate(() => document.getElementById('workbench').scrollIntoView());
  await sleep(600);

  const withPages = await page.evaluate(() => {
    scrollTo(9999, 0); const x = scrollX; scrollTo(0, 0);
    return {
      x,
      innerW: window.innerWidth,
      clientW: document.documentElement.clientWidth,
      toTopRight: Math.round(document.getElementById('toTop').getBoundingClientRect().right),
      toastRight: Math.round(document.getElementById('toasts').getBoundingClientRect().right),
    };
  });
  ok(withPages.x === 0, `${d.name}: scrolls sideways with pages (${withPages.x})`);
  ok(withPages.innerW === withPages.clientW, `${d.name}: ICB inflated with pages (${withPages.innerW} vs ${withPages.clientW})`);
  ok(withPages.toTopRight <= withPages.clientW + 1, `${d.name}: to-top FAB off-screen (${withPages.toTopRight} > ${withPages.clientW})`);
  console.log(`  with pages: innerW=${withPages.innerW} toTopR=${withPages.toTopRight} toastR=${withPages.toastRight} clientW=${withPages.clientW}`);

  /* ---- 7. page actions are visible without hover ----
     Regression: the overlay was opacity:0 until :hover, so rotate/duplicate/
     delete were unreachable on a phone. */
  const actionsVisible = await page.evaluate(() => {
    const overlay = document.querySelector('.page-card__actions');
    if (!overlay) return { missing: true };
    const cs = getComputedStyle(overlay);
    const btns = [...overlay.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      const s = getComputedStyle(b);
      return { w: Math.round(r.width), h: Math.round(r.height), display: s.display, vis: s.visibility };
    });
    return { opacity: cs.opacity, display: cs.display, btns };
  });
  ok(!actionsVisible.missing, `${d.name}: page action overlay missing`);
  ok(parseFloat(actionsVisible.opacity) === 1, `${d.name}: page actions hidden without hover (opacity=${actionsVisible.opacity})`);
  ok(actionsVisible.btns.length >= 6, `${d.name}: expected rotate/dup/delete + reorder buttons, got ${actionsVisible.btns.length}`);
  const tooSmall = actionsVisible.btns.filter((b) => b.w < TOUCH_MIN || b.h < TOUCH_MIN);
  ok(!tooSmall.length, `${d.name}: page action buttons under 44px: ${JSON.stringify(tooSmall)}`);

  /* The action overlay is absolutely positioned over the thumbnail, so a row
     wider than the card spills outside it and is clipped or overlapping. */
  const rows = await page.evaluate(() => {
    const card = document.querySelector('.page-card');
    const thumbW = card.querySelector('.page-card__thumb').getBoundingClientRect().width;
    const out = [];
    for (const row of card.querySelectorAll('.page-card__actions-row')) {
      const r = row.getBoundingClientRect();
      if (r.width > thumbW + 1) out.push(`${Math.round(r.width)}px row in ${Math.round(thumbW)}px card`);
    }
    return [...new Set(out)];
  });
  ok(!rows.length, `${d.name}: page action row overflows the card: ${rows.join('; ')}`);
  console.log(`  page actions: opacity=${actionsVisible.opacity} buttons=${actionsVisible.btns.length} all>=${TOUCH_MIN}: ${!tooSmall.length}, rows fit: ${!rows.length}`);
  await page.screenshot({ path: path.join(OUT, `${d.name}-actions.png`) });

  /* ---- 8. reorder works by tapping, not just dragging ----
     Regression: reorder relied on HTML5 drag-and-drop (no touch equivalent)
     and Alt+Arrow (no keyboard on a phone). */
  const reorder = await page.evaluate(async () => {
    const { getPages, getSetting } = await import('/assets/js/store.js');
    void getSetting;
    const names = () => [...document.querySelectorAll('.page-card__name')].map((n) => n.textContent);
    const before = names();
    /* move page 2 up via its own button */
    const btn = document.querySelectorAll('.page-card')[1].querySelector('[data-act="movel"]');
    if (!btn) return { error: 'no move-earlier button', before };
    if (btn.disabled) return { error: 'move-earlier disabled on page 2', before };
    btn.click();
    await new Promise((r) => setTimeout(r, 350));
    const after = names();
    /* move it back */
    const back = document.querySelectorAll('.page-card')[0].querySelector('[data-act="mover"]');
    back.click();
    await new Promise((r) => setTimeout(r, 350));
    return { before, after, restored: names(), moved: before[0] === after[1] && before[1] === after[0] };
  });
  ok(!reorder.error, `${d.name}: ${reorder.error}`);
  ok(reorder.moved, `${d.name}: tap-to-reorder did not swap pages (${JSON.stringify(reorder.before)} -> ${JSON.stringify(reorder.after)})`);
  ok(JSON.stringify(reorder.restored) === JSON.stringify(reorder.before), `${d.name}: reorder did not restore (${JSON.stringify(reorder.restored)})`);
  console.log(`  tap reorder: moved=${reorder.moved} restored=${JSON.stringify(reorder.restored) === JSON.stringify(reorder.before)}`);

  /* ---- 9. reorder buttons disable at the ends ---- */
  const endStates = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.page-card')];
    return {
      firstLeft: cards[0].querySelector('[data-act="movel"]').disabled,
      lastRight: cards[cards.length - 1].querySelector('[data-act="mover"]').disabled,
      midLeft: cards[1].querySelector('[data-act="movel"]').disabled,
    };
  });
  ok(endStates.firstLeft === true, `${d.name}: first page can be moved earlier`);
  ok(endStates.lastRight === true, `${d.name}: last page can be moved later`);
  ok(endStates.midLeft === false, `${d.name}: middle page cannot be moved earlier`);
  console.log(`  reorder bounds: firstLeft=${endStates.firstLeft} lastRight=${endStates.lastRight} midLeft=${endStates.midLeft}`);

  /* ---- 10. settings drawer fits on screen and locks background scroll ---- */
  await page.evaluate(() => document.getElementById('toggleSettings').click());
  await sleep(700);
  const rail = await page.evaluate(() => {
    const el = document.getElementById('settingsRail');
    const r = el.getBoundingClientRect();
    return {
      open: el.classList.contains('is-open'),
      right: Math.round(r.right), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
      clientW: document.documentElement.clientWidth, clientH: document.documentElement.clientHeight,
      bodyLocked: getComputedStyle(document.body).overflowY === 'hidden',
      scrim: !document.getElementById('railScrim').hidden,
      focusInside: el.contains(document.activeElement),
      closeBtn: Math.round(document.getElementById('closeSettings').getBoundingClientRect().width),
    };
  });
  ok(rail.open, `${d.name}: settings drawer did not open`);
  ok(rail.right <= rail.clientW + 1, `${d.name}: drawer overflows right edge (${rail.right} > ${rail.clientW})`);
  ok(rail.left >= -1, `${d.name}: drawer overflows left edge (${rail.left})`);
  ok(rail.h <= rail.clientH + 1, `${d.name}: drawer taller than viewport (${rail.h} > ${rail.clientH})`);
  ok(rail.scrim, `${d.name}: scrim not shown`);
  ok(rail.focusInside, `${d.name}: focus did not move into the drawer`);
  console.log(`  drawer: ${rail.w}x${rail.h} right=${rail.right}/${rail.clientW} locked=${rail.bodyLocked} scrim=${rail.scrim} focus=${rail.focusInside}`);
  await page.screenshot({ path: path.join(OUT, `${d.name}-drawer.png`) });

  /* ---- 11. every setting control is reachable and big enough ----
     Hit area is measured including the ::after expansion, since that is the
     area a finger actually lands on. getBoundingClientRect alone would
     report the 42x24 switch track and miss the grown target. */
  const railControls = await page.evaluate((min) => {
    const out = [];
    const rail = document.getElementById('settingsRail');
    for (const el of rail.querySelectorAll('button, input:not([type=checkbox]), select, [role=switch]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.pointerEvents === 'none') continue;

      /* laid-out size, so an open/close animation cannot skew the reading */
      let w = el.offsetWidth; let h = el.offsetHeight;
      if (!w || !h) continue;

      const after = getComputedStyle(el, '::after');
      if (after.content !== 'none' && after.position === 'absolute') {
        const grow = (v) => (v && v.endsWith('px') ? parseFloat(v) : 0);
        /* a negative inset grows the hit box outward */
        w += Math.abs(grow(after.left)) + Math.abs(grow(after.right));
        h += Math.abs(grow(after.top)) + Math.abs(grow(after.bottom));
      }
      if (w < min || h < min) {
        out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...(el.classList || [])].join('.')} "${(el.textContent || '').trim().slice(0, 16)}" ${Math.round(w)}x${Math.round(h)}`);
      }
    }
    return [...new Set(out)];
  }, TOUCH_MIN);
  ok(!railControls.length, `${d.name}: drawer controls under 44px: ${railControls.join('; ')}`);
  console.log(`  drawer controls >= ${TOUCH_MIN}px: ${railControls.length ? railControls.join('; ') : 'all ok'}`);

  /* ---- 12. Tab is trapped inside the drawer ---- */
  const trapped = await page.evaluate(async () => {
    const rail = document.getElementById('settingsRail');
    const focusables = [...rail.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
    focusables[focusables.length - 1].focus();
    return { count: focusables.length, focusedIsLast: document.activeElement === focusables[focusables.length - 1] };
  });
  ok(trapped.focusedIsLast, `${d.name}: could not focus last drawer control`);
  await page.keyboard.press('Tab');
  await sleep(150);
  const wrapped = await page.evaluate(() => document.getElementById('settingsRail').contains(document.activeElement));
  ok(wrapped, `${d.name}: Tab escaped the drawer (focus went to the page behind)`);
  console.log(`  focus trap: ${trapped.count} controls, Tab wrapped=${wrapped}`);

  /* ---- 13. Escape closes and returns focus to the trigger ---- */
  await page.keyboard.press('Escape');
  await sleep(600);
  const closed = await page.evaluate(() => ({
    open: document.getElementById('settingsRail').classList.contains('is-open'),
    scrim: !document.getElementById('railScrim').hidden,
    bodyLocked: getComputedStyle(document.body).overflowY === 'hidden',
    focusOnTrigger: document.activeElement === document.getElementById('toggleSettings'),
  }));
  ok(closed.open === false, `${d.name}: Escape did not close the drawer`);
  ok(closed.scrim === false, `${d.name}: scrim left visible after close`);
  ok(closed.bodyLocked === false, `${d.name}: background scroll stayed locked after close`);
  ok(closed.focusOnTrigger, `${d.name}: focus not returned to the settings trigger`);
  console.log(`  escape close: open=${closed.open} scrim=${closed.scrim} unlocked=${!closed.bodyLocked} focusReturned=${closed.focusOnTrigger}`);

  /* ---- 14. the page still scrolls after the drawer closes ----
     Scroll from the very top, since scrollIntoView earlier may have parked the
     viewport at the bottom of a short page where there is nothing left to move. */
  const scrollable = await page.evaluate(async () => {
    /* smooth scrolling means the jump is animated, so wait for it to settle
       rather than sampling mid-flight */
    scrollTo({ top: 0, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 300));
    const y0 = scrollY;
    scrollTo({ top: 600, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 300));
    return {
      moved: scrollY - y0,
      max: document.documentElement.scrollHeight - window.innerHeight,
      overflowY: getComputedStyle(document.body).overflowY,
    };
  });
  ok(scrollable.moved > 100, `${d.name}: page will not scroll after drawer use (moved ${scrollable.moved}px of ${scrollable.max}px, body overflow-y=${scrollable.overflowY})`);
  console.log(`  scrolls after drawer: ${scrollable.moved}px of ${scrollable.max}px available (overflow-y=${scrollable.overflowY})`);

  /* ---- 15. a full build works on the device ---- */
  await page.evaluate(() => document.getElementById('generate').click());
  const built = await page.waitForFunction(
    () => /^Finished/.test(document.getElementById('progressText')?.textContent || ''),
    { timeout: 120000, polling: 200 },
  ).then(() => true).catch(() => false);
  const buildMsg = built ? await page.$eval('#progressText', (e) => e.textContent) : 'TIMED OUT';
  ok(built, `${d.name}: PDF build did not finish on device`);
  console.log(`  build: ${buildMsg}`);
  await page.screenshot({ path: path.join(OUT, `${d.name}-built.png`) });

  await page.close();
}

/* ---- 16. desktop is not regressed by the touch changes ---- */
const desk = await browser.newPage();
desk.setCacheEnabled(false);
await desk.setViewport({ width: 1440, height: 1000, hasTouch: false, isMobile: false });
await desk.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'networkidle2' });
await desk.evaluate(() => document.getElementById('heroSample').click());
await desk.waitForFunction(() => document.querySelectorAll('.page-card').length > 0, { timeout: 30000 });
await sleep(1200);
const desktop = await desk.evaluate(() => {
  const overlay = document.querySelector('.page-card__actions');
  const btn = document.querySelector('.pcard-btn');
  return {
    overlayOpacity: getComputedStyle(overlay).opacity,
    btnW: Math.round(btn.getBoundingClientRect().width),
    scrollX: (() => { scrollTo(9999, 0); const x = scrollX; scrollTo(0, 0); return x; })(),
  };
});
ok(desktop.scrollX === 0, `desktop: scrolls sideways (${desktop.scrollX})`);
ok(desktop.btnW < 44, `desktop: page buttons forced to touch size (${desktop.btnW}px) — hover layout should stay compact`);
console.log(`\n${'='.repeat(60)}\ndesktop 1440x1000 (hover, no touch)`);
console.log(`  overlay hidden until hover: opacity=${desktop.overlayOpacity}`);
console.log(`  compact page buttons: ${desktop.btnW}px`);
console.log(`  no sideways scroll: ${desktop.scrollX === 0}`);
await desk.close();

await browser.close();

console.log(`\n${'='.repeat(60)}\n${problems.length ? `FAILED — ${problems.length} problem(s)` : 'ALL MOBILE CHECKS PASSED'}`);
for (const p of problems) console.log('  -', p);
fs.writeFileSync(path.join(OUT, 'problems.json'), JSON.stringify(problems, null, 2));
process.exit(problems.length ? 1 : 0);