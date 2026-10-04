/* =====================================================================
   JD Image2PDF — application state
   Tiny observable store. Topics: "pages" | "settings" | "output".
   ===================================================================== */

let seq = 0;
const uid = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

const defaults = () => ({
  /* document defaults */
  size: 'auto',
  orientation: 'auto',
  margin: 12,
  fit: 'contain',

  /* image quality */
  resolution: 0,
  quality: 88,

  /* branding */
  footerOn: false,
  footerText: '',
  pageNumbers: 'off',
  footerAlign: 'right',

  /* metadata */
  title: '',
  author: '',
  subject: '',
  keywords: '',

  /* security */
  lockOn: false,
  password: '',
  perms: { print: true, copy: false, modify: false, annotate: false },

  /* output */
  filename: 'document',
});

const state = {
  pages: [],
  settings: defaults(),
  output: null, // { blob, url, name, size, pages, ms }
};

const subs = new Map();

export function on(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic).delete(fn);
}

export function emit(topic, payload) {
  const set = subs.get(topic);
  if (set) for (const fn of [...set]) fn(payload);
}

/* ------------------------------ pages ------------------------------ */

export function makePage(file, dims) {
  const d = defaults();
  return {
    id: uid(),
    name: file.name || 'image',
    /* `bytes` is the source file weight; `size` below is the paper size */
    bytes: file.size || 0,
    type: file.type || '',
    url: URL.createObjectURL(file),
    file,
    w: dims.w,
    h: dims.h,
    rotation: 0,
    /* per-page overrides; "touched" means it diverges from the document default */
    sizeTouched: false,
    orientationTouched: false,
    fitTouched: false,
    size: d.size,
    orientation: d.orientation,
    fit: d.fit,
  };
}

export function getPages() { return state.pages; }
export function pageCount() { return state.pages.length; }

export function addPages(newPages) {
  if (!newPages.length) return;
  state.pages.push(...newPages);
  emit('pages', { reason: 'add', count: newPages.length });
}

export function removePage(id) {
  const i = state.pages.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [gone] = state.pages.splice(i, 1);
  URL.revokeObjectURL(gone.url);
  emit('pages', { reason: 'remove', id });
}

export function clearPages() {
  for (const p of state.pages) URL.revokeObjectURL(p.url);
  state.pages = [];
  clearOutput();
  emit('pages', { reason: 'clear' });
}

export function duplicatePage(id) {
  const i = state.pages.findIndex((p) => p.id === id);
  if (i < 0) return;
  const src = state.pages[i];
  const copy = {
    ...src,
    id: uid(),
    name: src.name.replace(/(\.[^.]+)?$/, ' copy$1'),
    /* a fresh object URL: both cards must survive either one being removed */
    url: URL.createObjectURL(src.file),
  };
  state.pages.splice(i + 1, 0, copy);
  emit('pages', { reason: 'duplicate', id });
}

export function rotatePage(id, delta = 90) {
  const p = state.pages.find((x) => x.id === id);
  if (!p) return;
  p.rotation = (((p.rotation + delta) % 360) + 360) % 360;
  emit('pages', { reason: 'rotate', id });
}

export function rotateAll() {
  for (const p of state.pages) p.rotation = (p.rotation + 90) % 360;
  emit('pages', { reason: 'rotate-all' });
}

export function setPageProp(id, patch) {
  const p = state.pages.find((x) => x.id === id);
  if (!p) return;
  Object.assign(p, patch);
  emit('pages', { reason: 'patch', id });
}

export function resetPageProp(id) {
  setPageProp(id, { sizeTouched: false, orientationTouched: false, fitTouched: false });
}

/** Natural (numeric-aware) sort by file name. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function sortByName() {
  state.pages.sort((a, b) => collator.compare(a.name, b.name));
  emit('pages', { reason: 'sort' });
}

/** Move the page at `from` to index `to`. */
export function movePage(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.pages.length) return;
  const [item] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, item);
  emit('pages', { reason: 'move', from, to });
}

/** Resolve the effective value of a per-page setting. */
export function eff(page, key) {
  return page[`${key}Touched`] ? page[key] : state.settings[key];
}

/** True when a page diverges from the document defaults. */
export function isOverridden(page) {
  return page.sizeTouched || page.orientationTouched || page.fitTouched;
}

/* ----------------------------- settings ---------------------------- */

export function getSettings() { return state.settings; }

export function setSetting(key, value) {
  if (key === 'perms') state.settings.perms = { ...state.settings.perms, ...value };
  else state.settings[key] = value;
  clearOutput();
  emit('settings', { key, value });
}

/* ------------------------------ output ----------------------------- */

export function setOutput(out) {
  clearOutput();
  state.output = out;
  emit('output', out);
}

export function getOutput() { return state.output; }

export function clearOutput() {
  if (!state.output) return;
  if (state.output.url) URL.revokeObjectURL(state.output.url);
  state.output = null;
  emit('output', null);
}