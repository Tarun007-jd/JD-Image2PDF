/* =====================================================================
   JD Image2PDF — interface controller
   ===================================================================== */

import {
  on, makePage, addPages, removePage, clearPages, duplicatePage,
  rotatePage, rotateAll, setPageProp, resetPageProp, sortByName, movePage,
  setSetting, getSettings, setOutput, getOutput, getPages, isOverridden,
} from './store.js';

import { buildPdf, decode, estimateBytes } from './pdf-engine.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------------ */
/* theme                                                               */
/* ------------------------------------------------------------------ */

const themeToggle = $('#themeToggle');
const THEME_KEY = 'jd-image2pdf:theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  $('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#070A14' : '#F7F3EB');
}

applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

/* ------------------------------------------------------------------ */
/* toasts                                                              */
/* ------------------------------------------------------------------ */

const toastHost = $('#toasts');
const liveEl = $('#live');
const TOAST_ICON = { ok: '#i-check', warn: '#i-sparkle', err: '#i-close', info: '#i-sparkle' };

function announce(message) { liveEl.textContent = message; }

function toast(message, kind = 'ok', ms = 3600) {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.innerHTML = `<svg class="icon" aria-hidden="true"><use href="${TOAST_ICON[kind] || TOAST_ICON.info}" /></svg><span></span>`;
  $('span', el).textContent = message;
  toastHost.append(el);
  while (toastHost.children.length > 3) toastHost.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('is-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms);
  announce(message);
}

/* ------------------------------------------------------------------ */
/* element refs                                                        */
/* ------------------------------------------------------------------ */

const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const folderInput = $('#folderInput');
const pagesEl = $('#pages');
const toolbar = $('#toolbar');
const canvasHint = $('#canvasHint');
const pageCount = $('#pageCount');
const pageCountLabel = $('#pageCountLabel');
const generateBtn = $('#generate');
const generateLabel = $('#generateLabel');
const downloadAgain = $('#downloadAgain');
const estimateEl = $('#estimate');
const estimateText = $('#estimateText');
const progressEl = $('#progress');
const progressFill = $('#progressFill');
const progressText = $('#progressText');
const rail = $('#settingsRail');
const railScrim = $('#railScrim');
const toggleSettings = $('#toggleSettings');

$('#year').textContent = String(new Date().getFullYear());

/* ------------------------------------------------------------------ */
/* ingest                                                              */
/* ------------------------------------------------------------------ */

const MAX_FILES = 300;
const SKIP_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|tar|mp4|mov|avi|webm|mp3|wav|json|xml|html?|css|js|exe|dmg|iso|fig|sketch|psd|ai)$/i;

/** Reads a file's pixel dimensions so the page can be planned before export. */
async function toPage(file) {
  if (!file) return null;
  if (file.type && !file.type.startsWith('image/') && SKIP_EXT.test(file.name)) return null;
  if (!file.type && SKIP_EXT.test(file.name)) return null;
  try {
    const d = await decode(file);
    const page = makePage(file, { w: d.w, h: d.h });
    d.release();
    return page;
  } catch {
    return null;
  }
}

async function ingest(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  const room = MAX_FILES - getPages().length;
  if (room <= 0) {
    toast(`Limit reached — ${MAX_FILES} pages per document.`, 'warn');
    return;
  }

  const accepted = files.slice(0, room);
  const overflow = files.length - accepted.length;
  const pages = (await Promise.all(accepted.map(toPage))).filter(Boolean);

  if (!pages.length) {
    toast('None of those files could be read as images.', 'err');
    return;
  }

  addPages(pages);
  const total = getPages().length;

  const skipped = accepted.length - pages.length;
  if (skipped || overflow) {
    const bits = [];
    if (skipped) bits.push(`${skipped} unsupported file${skipped > 1 ? 's' : ''} skipped`);
    if (overflow) bits.push(`${overflow} over the ${MAX_FILES}-page limit`);
    toast(bits.join(' · '), 'warn');
  } else {
    toast(`${pages.length} image${pages.length > 1 ? 's' : ''} ready — ${total} page${total > 1 ? 's' : ''} total.`, 'ok');
  }
}

fileInput.addEventListener('change', (e) => { ingest(e.target.files); fileInput.value = ''; });
folderInput.addEventListener('change', (e) => { ingest(e.target.files); folderInput.value = ''; });

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
$$('.link', dropzone)[0].addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
$$('.link', dropzone)[1].addEventListener('click', (e) => { e.stopPropagation(); folderInput.click(); });

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropzone.classList.remove('is-over'); // hidden once pages exist; still allow the drop
  document.body.classList.add('is-file-drag');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('is-file-drag');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-file-drag');
  if (e.dataTransfer.files?.length) ingest(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); ingest(files); }
});

$('#addMore').addEventListener('click', () => fileInput.click());
$('#sortByName').addEventListener('click', () => { sortByName(); toast('Sorted by file name.'); });
$('#rotateAll').addEventListener('click', () => { rotateAll(); toast('Every page rotated 90°.'); });
$('#clearAll').addEventListener('click', () => {
  const n = getPages().length;
  if (!n) return;
  clearPages();
  toast(`${n} page${n > 1 ? 's' : ''} cleared.`, 'ok');
});

/* ------------------------------------------------------------------ */
/* page cards                                                          */
/* ------------------------------------------------------------------ */

const options = (pairs) => pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

const SIZE_OPTIONS = options([
  ['auto', 'Match image'], ['a4', 'A4'], ['letter', 'Letter'], ['legal', 'Legal'],
  ['a3', 'A3'], ['a5', 'A5'], ['b5', 'B5'], ['tabloid', 'Tabloid'], ['square', 'Square'],
]);
const ORIENT_OPTIONS = options([['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']]);
const FIT_OPTIONS = options([['contain', 'Fit inside'], ['cover', 'Fill page'], ['stretch', 'Stretch']]);

function bytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const action = (id, act, icon, label) =>
  `<button class="pcard-btn${act === 'del' ? ' pcard-btn--danger' : ''}" type="button" data-act="${act}" data-id="${id}" title="${label}" aria-label="${label}"><svg class="icon" aria-hidden="true"><use href="#${icon}" /></svg></button>`;

/**
 * Styles the thumbnail so a rotated page previews rotated and stays fully
 * inside the card. The <img> element box is sized to match the image's own
 * aspect ratio exactly (so `object-fit: fill` never distorts), then rotated
 * about its centre.
 */
function thumbStyle(page) {
  const rot = ((page.rotation || 0) % 360 + 360) % 360;
  const iw = page.w || 4;
  const ih = page.h || 5;
  const swapped = rot === 90 || rot === 270;
  const visualRatio = swapped ? ih / iw : iw / ih;

  const BOX_W = 100;                    // must match .page-card__thumb aspect-ratio
  const BOX_H = BOX_W / (4 / 5);

  const vw = Math.min(BOX_W, BOX_H * visualRatio); // post-rotation footprint
  const vh = vw / visualRatio;

  const width = swapped ? vh : vw;
  const height = swapped ? vw : vh;
  const style = `width:${((width / BOX_W) * 100).toFixed(3)}%;height:${((height / BOX_H) * 100).toFixed(3)}%`;
  return rot ? `${style};transform:rotate(${rot}deg)` : style;
}

function cardHtml(page, i, total = Infinity) {
  const over = isOverridden(page);
  const dims = page.w ? `${page.w}×${page.h}` : '—';
  const n = i + 1;
  return `
    <li class="page-card${over ? ' is-overridden' : ''}" data-id="${page.id}" draggable="true" tabindex="0" aria-label="Page ${n}, ${escapeHtml(page.name)}">
      <div class="page-card__thumb">
        <span class="page-card__idx">${n}</span>
        ${over ? '<span class="page-card__badge" title="Uses per-page settings"></span>' : ''}
        <img src="${page.url}" alt="" decoding="async" style="${thumbStyle(page)}" />
        ${page.rotation ? `<span class="page-card__rot">${page.rotation}°</span>` : ''}
        <div class="page-card__actions">
          <!-- Three buttons per row, never four: at 44px each a 4-up row needs
               203px and overflows a 162px-wide phone card. Touch devices have no
               hover, so drag-and-drop cannot reorder either, hence the arrows. -->
          <div class="page-card__actions-row">
            ${action(page.id, 'rotl', 'i-rotate-left', `Rotate page ${n} left`)}
            ${action(page.id, 'rotr', 'i-rotate-right', `Rotate page ${n} right`)}
            ${action(page.id, 'dup', 'i-copy', `Duplicate page ${n}`)}
          </div>
          <div class="page-card__actions-row page-card__actions-row--move">
            <button class="pcard-btn" type="button" data-act="movel" data-id="${page.id}"
              aria-label="Move page ${n} earlier"${i === 0 ? ' disabled' : ''}>
              <svg class="icon" aria-hidden="true"><use href="#i-arrow-left" /></svg>
            </button>
            <button class="pcard-btn" type="button" data-act="mover" data-id="${page.id}"
              aria-label="Move page ${n} later"${i === total - 1 ? ' disabled' : ''}>
              <svg class="icon" aria-hidden="true"><use href="#i-arrow-right" /></svg>
            </button>
            ${action(page.id, 'del', 'i-trash', `Remove page ${n}`)}
          </div>
        </div>
      </div>
      <div class="page-card__grip">
        <svg class="icon" aria-hidden="true"><use href="#i-grip" /></svg>
        <span class="page-card__name">${escapeHtml(page.name)}</span>
        <span class="page-card__dims">${dims}</span>
      </div>
      <div class="page-card__opts"${over ? '' : ' hidden'}>
        <label class="mini-select"><span class="sr-only">Paper size for page ${n}</span>
          <select data-page-prop="size">${SIZE_OPTIONS}</select></label>
        <label class="mini-select"><span class="sr-only">Orientation for page ${n}</span>
          <select data-page-prop="orientation">${ORIENT_OPTIONS}</select></label>
        <label class="mini-select"><span class="sr-only">Fit for page ${n}</span>
          <select data-page-prop="fit">${FIT_OPTIONS}</select></label>
        <button class="page-card__reset" type="button" data-act="reset" data-id="${page.id}">Use document default</button>
      </div>
    </li>`;
}

let dragFrom = null;

function renderPages() {
  const pages = getPages();
  const n = pages.length;

  document.body.classList.toggle('has-pages', n > 0);
  toolbar.hidden = n === 0;
  canvasHint.hidden = n === 0;
  dropzone.hidden = n > 0;
  generateBtn.disabled = n === 0 || busy;
  pageCount.textContent = String(n);
  pageCountLabel.textContent = n === 1 ? 'page' : 'pages';

  const focusId = document.activeElement?.closest?.('.page-card')?.dataset.id;
  /* pass the total so the reorder buttons can disable themselves at the ends */
  pagesEl.innerHTML = pages.map((p, i) => cardHtml(p, i, n)).join('');

  for (const card of $$('.page-card', pagesEl)) {
    const page = pages.find((p) => p.id === card.dataset.id);
    if (!page) continue;
    $('[data-page-prop="size"]', card).value = page.size;
    $('[data-page-prop="orientation"]', card).value = page.orientation;
    $('[data-page-prop="fit"]', card).value = page.fit;
  }

  if (focusId) $(`.page-card[data-id="${focusId}"]`, pagesEl)?.focus({ preventScroll: true });
  updateEstimate();
}

on('pages', renderPages);

/* card actions */
pagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'rotl') rotatePage(id, -90);
  else if (act === 'rotr') rotatePage(id, 90);
  else if (act === 'dup') duplicatePage(id);
  else if (act === 'del') removePage(id);
  else if (act === 'reset') resetPageProp(id);
  else if (act === 'movel' || act === 'mover') {
    const pages = getPages();
    const from = pages.findIndex((p) => p.id === id);
    const to = act === 'movel' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= pages.length) return;
    movePage(from, to);
    announce(`Page ${from + 1} moved to position ${to + 1} of ${pages.length}.`);
    /* re-render replaces the button, so refocus the equivalent control */
    requestAnimationFrame(() => {
      $(`.page-card[data-id="${id}"] [data-act="${act}"]`, pagesEl)?.focus({ preventScroll: true });
    });
  }
});

pagesEl.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-page-prop]');
  if (!sel) return;
  const key = sel.dataset.pageProp;
  setPageProp(sel.closest('.page-card').dataset.id, { [key]: sel.value, [`${key}Touched`]: true });
});

/* drag to reorder */
pagesEl.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.page-card');
  if (!card) return;
  dragFrom = getPages().findIndex((p) => p.id === card.dataset.id);
  card.classList.add('is-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.dataset.id);
});
pagesEl.addEventListener('dragover', (e) => {
  if (dragFrom === null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  $$('.page-card.is-target', pagesEl).forEach((c) => c.classList.remove('is-target'));
  const card = e.target.closest('.page-card');
  if (card && getPages()[dragFrom]?.id !== card.dataset.id) card.classList.add('is-target');
});
pagesEl.addEventListener('drop', (e) => {
  if (dragFrom === null) return;
  e.preventDefault();
  const card = e.target.closest('.page-card');
  const from = dragFrom;
  dragFrom = null;
  const to = card ? getPages().findIndex((p) => p.id === card.dataset.id) : getPages().length - 1;
  if (from !== to && to >= 0) {
    movePage(from, to);
    announce(`Moved to position ${to + 1} of ${getPages().length}.`);
  }
});
pagesEl.addEventListener('dragend', () => {
  dragFrom = null;
  $$('.page-card.is-dragging, .page-card.is-target', pagesEl)
    .forEach((c) => c.classList.remove('is-dragging', 'is-target'));
});

/* Alt + Arrow reorders without a mouse */
pagesEl.addEventListener('keydown', (e) => {
  if (!e.altKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const card = e.target.closest('.page-card');
  if (!card) return;
  e.preventDefault();
  const pages = getPages();
  const i = pages.findIndex((p) => p.id === card.dataset.id);
  const to = e.key === 'ArrowLeft' ? i - 1 : i + 1;
  if (to < 0 || to >= pages.length) return;
  movePage(i, to);
  requestAnimationFrame(() => $(`.page-card[data-id="${card.dataset.id}"]`, pagesEl)?.focus({ preventScroll: true }));
});

/* ------------------------------------------------------------------ */
/* settings rail                                                       */
/* ------------------------------------------------------------------ */

const FITS = {
  contain: 'Keeps the whole image visible with even margins.',
  cover: 'Fills the page edge to edge and crops the overflow.',
  stretch: 'Ignores the aspect ratio — only use this deliberately.',
};

const fillRange = (input) => {
  const { min, max, value } = input;
  input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
};

/** Never overwrite the field the user is typing in. */
const setVal = (sel, value) => {
  const el = $(sel);
  if (el && el !== document.activeElement) el.value = value;
};

function syncSettingsUI() {
  const s = getSettings();

  setVal('#pageSize', s.size);
  setVal('#margin', s.margin);
  setVal('#resolution', String(s.resolution));
  setVal('#quality', s.quality);
  fillRange($('#margin'));
  fillRange($('#quality'));
  $('#marginOut').textContent = `${s.margin} mm`;
  $('#qualityOut').textContent = `${s.quality}%`;
  $('#fitNote').textContent = FITS[s.fit];

  $('#footerOn').setAttribute('aria-checked', String(s.footerOn));
  $('#footerFields').hidden = !s.footerOn;
  setVal('#footerText', s.footerText);
  setVal('#pageNumbers', s.pageNumbers);
  setVal('#footerAlign', s.footerAlign);

  setVal('#mTitle', s.title);
  setVal('#mAuthor', s.author);
  setVal('#mSubject', s.subject);
  setVal('#mKeywords', s.keywords);

  $('#lockOn').setAttribute('aria-checked', String(s.lockOn));
  $('#lockFields').hidden = !s.lockOn;
  setVal('#password', s.password);
  $('#permPrint').checked = s.perms.print;
  $('#permCopy').checked = s.perms.copy;
  $('#permModify').checked = s.perms.modify;
  $('#permAnnotate').checked = s.perms.annotate;

  setVal('#filename', s.filename);

  $$('.segmented button').forEach((b) => b.setAttribute('aria-checked', String(s[b.dataset.seg] === b.dataset.value)));

  if (!busy) {
    progressEl.hidden = true;
    progressFill.style.width = '0%';
  }
  updateEstimate();
}

on('settings', syncSettingsUI);

const bind = (sel, key, event = 'change', read = (el) => el.value) => {
  $(sel).addEventListener(event, (e) => setSetting(key, read(e.target)));
};

bind('#pageSize', 'size');
bind('#margin', 'margin', 'input', (el) => Number(el.value));
bind('#resolution', 'resolution', 'change', (el) => Number(el.value));
bind('#quality', 'quality', 'input', (el) => Number(el.value));
bind('#footerText', 'footerText', 'input', (el) => el.value);
bind('#pageNumbers', 'pageNumbers');
bind('#footerAlign', 'footerAlign');
bind('#mTitle', 'title', 'input', (el) => el.value);
bind('#mAuthor', 'author', 'input', (el) => el.value);
bind('#mSubject', 'subject', 'input', (el) => el.value);
bind('#mKeywords', 'keywords', 'input', (el) => el.value);
bind('#filename', 'filename', 'input', (el) => el.value);
bind('#password', 'password', 'input', (el) => el.value);
bind('#permPrint', 'perms', 'change', (el) => ({ print: el.checked }));
bind('#permCopy', 'perms', 'change', (el) => ({ copy: el.checked }));
bind('#permModify', 'perms', 'change', (el) => ({ modify: el.checked }));
bind('#permAnnotate', 'perms', 'change', (el) => ({ annotate: el.checked }));

/* live read-outs while dragging the sliders */
$('#margin').addEventListener('input', (e) => { $('#marginOut').textContent = `${e.target.value} mm`; });
$('#quality').addEventListener('input', (e) => { $('#qualityOut').textContent = `${e.target.value}%`; });

/* segmented controls */
$$('.segmented').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    setSetting(btn.dataset.seg, btn.dataset.value);
  });
  group.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const btns = $$('button', group);
    const i = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    e.preventDefault();
    const next = btns[(i + step + btns.length) % btns.length];
    next.focus();
    next.click();
  });
});

/* switches */
for (const [sel, key, fields] of [['#footerOn', 'footerOn', '#footerFields'], ['#lockOn', 'lockOn', '#lockFields']]) {
  $(sel).addEventListener('click', () => {
    const next = $(sel).getAttribute('aria-checked') !== 'true';
    setSetting(key, next);
  });
  $(fields).hidden = $(sel).getAttribute('aria-checked') !== 'true';
}

/* mobile drawer: the rail is display:none while parked, so closing needs a
   short-lived class to play the exit animation before it stops rendering */
let railTimer = 0;
const openRail = (open) => {
  clearTimeout(railTimer);
  toggleSettings.setAttribute('aria-expanded', String(open));
  railScrim.hidden = !open;

  /* On a phone the rail is a full-height overlay, so the page behind it must
     not scroll or rubber-band while it is open. `overflow: clip` on <html>
     already exists; locking the body keeps touch scrolling inside the rail. */
  document.body.classList.toggle('rail-open', open);
  document.body.style.overflowY = open ? 'hidden' : '';

  if (open) {
    rail.classList.remove('is-closing');
    rail.classList.add('is-open');
    $('#closeSettings').focus({ preventScroll: true });
    return;
  }

  if (rail.classList.contains('is-open')) {
    rail.classList.remove('is-open');
    rail.classList.add('is-closing');
    railTimer = setTimeout(() => rail.classList.remove('is-closing'), 320);
    toggleSettings.focus({ preventScroll: true });
  }
};
toggleSettings.addEventListener('click', () => openRail(!rail.classList.contains('is-open')));
$('#closeSettings').addEventListener('click', () => openRail(false));
railScrim.addEventListener('click', () => openRail(false));

/* Escape closes, and Tab is trapped inside the drawer while it is open so
   focus cannot wander behind the overlay on a phone. */
addEventListener('keydown', (e) => {
  const open = rail.classList.contains('is-open');
  if (!open) return;
  if (e.key === 'Escape') { openRail(false); return; }
  if (e.key !== 'Tab') return;

  const focusable = [...rail.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ------------------------------------------------------------------ */
/* size estimate                                                       */
/* ------------------------------------------------------------------ */

function updateEstimate() {
  const pages = getPages();
  if (!pages.length) { estimateEl.hidden = true; return; }

  const done = getOutput();
  if (done) {
    estimateEl.hidden = false;
    estimateText.textContent = `${done.pages} page${done.pages > 1 ? 's' : ''} · ${bytes(done.size)} · built in ${done.ms}s`;
    return;
  }

  const s = getSettings();
  const guess = estimateBytes(pages, s);
  const safe = Number.isFinite(guess) ? Math.max(0, Math.round(guess)) : 0;

  estimateEl.hidden = false;
  estimateText.textContent = `${pages.length} page${pages.length > 1 ? 's' : ''} · roughly ${bytes(safe)}`;
}

/* ------------------------------------------------------------------ */
/* generate                                                            */
/* ------------------------------------------------------------------ */

let busy = false;
let buildSeq = 0;

generateBtn.addEventListener('click', async () => {
  const pages = getPages();
  if (!pages.length || busy) return;

  const s = getSettings();
  if (s.lockOn && !s.password.trim()) {
    toast('Set an open password, or turn encryption off.', 'warn');
    openRail(true);
    $('#password').focus();
    return;
  }

  busy = true;
  buildSeq++;
  progressText.dataset.build = String(buildSeq);
  generateBtn.disabled = true;
  generateLabel.textContent = 'Building…';
  progressEl.hidden = false;
  progressFill.style.width = '0%';
  progressText.textContent = 'Starting…';

  const started = performance.now();

  try {
    const out = await buildPdf(pages, getSettings(), (doneCount, total, label) => {
      progressFill.style.width = `${total ? Math.round((doneCount / total) * 96) : 0}%`;
      progressText.textContent = label;
    });

    progressFill.style.width = '100%';
    progressText.textContent = `Finished — ${bytes(out.size)} in ${((performance.now() - started) / 1000).toFixed(1)}s`;

    setOutput({ ...out, ms: (performance.now() - started) / 1000 });
    triggerDownload(getOutput());

    toast(`${out.pages} page${out.pages > 1 ? 's' : ''} · ${bytes(out.size)} · ${s.lockOn ? 'encrypted · ' : ''}ready`, 'ok', 5000);
  } catch (err) {
    console.error(err);
    progressEl.hidden = true;
    progressFill.style.width = '0%';
    toast(err.message || 'Something went wrong while building the PDF.', 'err', 6000);
  } finally {
    busy = false;
    generateBtn.disabled = getPages().length === 0;
    generateLabel.textContent = 'Generate PDF';
  }
});

function triggerDownload(out) {
  const a = document.createElement('a');
  a.href = out.url;
  a.download = out.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

downloadAgain.addEventListener('click', () => {
  const out = getOutput();
  if (out) triggerDownload(out);
  else toast('Generate the PDF again to download it.', 'warn');
});

on('output', (out) => {
  downloadAgain.hidden = !out;
  updateEstimate();
});

/* ------------------------------------------------------------------ */
/* sample images                                                       */
/* ------------------------------------------------------------------ */

function sampleCanvas(w, h, label, sub, hue) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, `hsl(${hue} 68% 21%)`);
  bg.addColorStop(1, `hsl(${(hue + 52) % 360} 62% 10%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.globalAlpha = 0.17;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(w * (0.16 + i * 0.19), h * (0.22 + (i % 3) * 0.27), Math.min(w, h) * (0.1 + i * 0.034), 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? '#F3D18A' : '#7C5CFF';
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = 'rgba(255,246,226,.28)';
  ctx.lineWidth = Math.max(2, w / 320);
  ctx.strokeRect(w * 0.09, h * 0.09, w * 0.82, h * 0.82);

  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFF6E2';
  ctx.font = `600 ${Math.round(w * 0.082)}px Georgia, "Times New Roman", serif`;
  ctx.fillText(label, w * 0.14, h * 0.44);
  ctx.fillStyle = 'rgba(255,246,226,.60)';
  ctx.font = `400 ${Math.round(w * 0.034)}px system-ui, sans-serif`;
  ctx.fillText(sub, w * 0.14, h * 0.535);
  ctx.fillStyle = '#D3A154';
  ctx.font = `700 ${Math.round(w * 0.028)}px system-ui, sans-serif`;
  ctx.fillText('JD IMAGE2PDF', w * 0.14, h * 0.655);

  return canvas;
}

const canvasToFile = (canvas, name) => new Promise((resolve) => {
  canvas.toBlob((blob) => resolve({ file: new File([blob], name, { type: 'image/png' }), w: canvas.width, h: canvas.height }), 'image/png');
});

async function addSamples() {
  if (getPages().length >= MAX_FILES) { toast('Page limit reached.', 'warn'); return; }
  const specs = [
    ['Cover sheet', '1000 × 1414 · title page', 34, 'jd-01-cover.png'],
    ['Invoice 01', 'A4 portrait · itemised', 206, 'jd-02-invoice.png'],
    ['Site photo A', '1600 × 1067 · landscape', 262, 'jd-03-photo-a.png'],
    ['Site photo B', '1600 × 1067 · landscape', 292, 'jd-04-photo-b.png'],
  ];
  const files = await Promise.all(specs.map(([label, sub, hue, name]) => {
    const landscape = label.startsWith('Site');
    const canvas = sampleCanvas(landscape ? 1600 : 1000, landscape ? 1067 : 1414, label, sub, hue);
    return canvasToFile(canvas, name);
  }));
  addPages(files.map(({ file, w, h }) => makePage(file, { w, h })));
  toast('Four sample pages added — try the settings on the right.', 'ok');
}

$('#heroSample').addEventListener('click', () => {
  addSamples();
  $('#workbench').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ------------------------------------------------------------------ */
/* chrome                                                              */
/* ------------------------------------------------------------------ */

const header = $('.site-header');
const toTop = $('#toTop');
const navToggle = $('#navToggle');
const nav = $('.nav');

const onScroll = () => {
  header.classList.toggle('is-stuck', scrollY > 12);
  toTop.classList.toggle('is-visible', scrollY > 700);
};
addEventListener('scroll', onScroll, { passive: true });
onScroll();

toTop.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));

navToggle.addEventListener('click', () => {
  const open = !nav.classList.contains('is-open');
  nav.classList.toggle('is-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
});
nav.addEventListener('click', (e) => {
  if (e.target.tagName !== 'A') return;
  nav.classList.remove('is-open');
  navToggle.setAttribute('aria-expanded', 'false');
});

if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
  $$('[data-reveal]').forEach((el) => el.classList.add('is-in'));
} else {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
  $$('[data-reveal]').forEach((el) => io.observe(el));
}

const navLinks = new Map($$('.nav a').map((a) => [a.getAttribute('href').slice(1), a]));
if ('IntersectionObserver' in window) {
  const spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      navLinks.forEach((l) => l.classList.remove('is-active'));
      navLinks.get(entry.target.id)?.classList.add('is-active');
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  for (const id of ['workbench', 'features', 'how', 'faq']) {
    const section = document.getElementById(id);
    if (section) spy.observe(section);
  }
}

addEventListener('resize', () => {
  if (innerWidth > 900) openRail(false);
  if (innerWidth > 620) dropzone.hidden = getPages().length > 0;
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

syncSettingsUI();
renderPages();

addEventListener('error', (e) => console.error('[JD Image2PDF]', e.error || e.message));
addEventListener('unhandledrejection', (e) => console.error('[JD Image2PDF]', e.reason));