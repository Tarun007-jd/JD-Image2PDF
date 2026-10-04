/* =====================================================================
   JD Image2PDF — PDF rendering engine
   Pure geometry + canvas encoding, handed to jsPDF. Runs entirely
   on-device; no network calls are made from here.
   ===================================================================== */

const PDF = () => (globalThis.jspdf && globalThis.jspdf.jsPDF) || globalThis.jsPDF;

/** millimetre -> PostScript point */
export const MM = 72 / 25.4;
const PX_TO_PT = 72 / 96; // assume CSS/reference 96 dpi for "match image" pages

/** paper sizes as [short, long] in millimetres */
export const PAGE_SIZES = {
  a4: [210, 297],
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
  a3: [297, 420],
  a5: [148, 210],
  b5: [176, 250],
  tabloid: [279.4, 431.8],
  square: [210, 210],
};

export const SIZE_LABELS = {
  auto: 'Match image',
  a4: 'A4', letter: 'Letter', legal: 'Legal', a3: 'A3',
  a5: 'A5', b5: 'B5', tabloid: 'Tabloid', square: 'Square',
};

/** jsPDF permission bit names (see jsPDF security: print/modify/copy/annot-forms) */
const PERMISSION_TOKENS = { print: 'print', copy: 'copy', modify: 'modify', annotate: 'annot-forms' };

/* ------------------------------------------------------------------ */
/* decoding                                                            */
/* ------------------------------------------------------------------ */

export async function decode(file) {
  const name = (file && file.name) || 'image';
  if (globalThis.createImageBitmap) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, w: bmp.width, h: bmp.height, release: () => bmp.close?.() };
    } catch { /* fall through to <img> */ }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error(`Could not decode "${name}"`));
    img.src = url;
  });
  return { source: img, w: img.naturalWidth, h: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

/**
 * Inspects a downscaled copy of the image to decide how it should be
 * encoded: transparent pixels must stay PNG, and flat artwork with few
 * colours survives PNG far better than a JPEG.
 */
function analyse(decoded) {
  const long = Math.max(decoded.w, decoded.h);
  const scale = Math.min(1, 96 / long);
  const cw = Math.max(1, Math.round(decoded.w * scale));
  const ch = Math.max(1, Math.round(decoded.h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(decoded.source, 0, 0, cw, ch);

  let alpha = false;
  let data;
  try { data = ctx.getImageData(0, 0, cw, ch).data; } catch { return { alpha: false, colors: Infinity }; }

  const seen = new Set();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) { alpha = true; break; }
  }
  if (!alpha) {
    for (let i = 0; i < data.length; i += 4) {
      seen.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
      if (seen.size > 2048) break;
    }
  }
  return { alpha, colors: seen.size };
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

const norm = (deg) => (((deg % 360) + 360) % 360);

/**
 * Works out the page box and the image placement rectangle, in points.
 * Pure math — no pixels involved — so it can run before any decoding.
 */
export function planPage(page, settings) {
  const rotation = norm(page.rotation);
  const swapped = rotation === 90 || rotation === 270;
  const srcW = page.w;            // unrotated pixel dimensions
  const srcH = page.h;
  const effW = swapped ? srcH : srcW;
  const effH = swapped ? srcW : srcH;

  const size = page.sizeTouched ? page.size : settings.size;
  const orientation = page.orientationTouched ? page.orientation : settings.orientation;
  const fit = page.fitTouched ? page.fit : settings.fit;
  const margin = Math.max(0, settings.margin) * MM;

  let pageW; let pageH;
  if (size === 'auto' || !PAGE_SIZES[size]) {
    pageW = effW * PX_TO_PT;
    pageH = effH * PX_TO_PT;
  } else {
    const [shortSide, longSide] = PAGE_SIZES[size];
    const landscape = orientation === 'landscape' || (orientation === 'auto' && effW > effH);
    pageW = (landscape ? longSide : shortSide) * MM;
    pageH = (landscape ? shortSide : longSide) * MM;
  }
  pageW = Math.max(pageW, 10);
  pageH = Math.max(pageH, 10);

  const boxW = Math.max(1, pageW - margin * 2);
  const boxH = Math.max(1, pageH - margin * 2);

  let scale;
  if (fit === 'stretch') scale = null;
  else if (fit === 'cover') scale = Math.max(boxW / effW, boxH / effH);
  else scale = Math.min(boxW / effW, boxH / effH);

  const drawW = scale === null ? boxW : effW * scale;
  const drawH = scale === null ? boxH : effH * scale;

  return {
    rotation,
    swapped,
    srcW, srcH, effW, effH,
    pageW, pageH, margin, fit, size,
    drawW, drawH,
    drawX: margin + (boxW - drawW) / 2,
    drawY: margin + (boxH - drawH) / 2,
  };
}

/** Target pixel dimensions after applying the DPI cap. Never upscales. */
function targetPixels(plan, dpi) {
  if (!dpi) return { w: plan.effW, h: plan.effH };
  const inchesWide = plan.drawW / 72;
  const w = Math.max(1, Math.min(plan.effW, Math.round(inchesWide * dpi)));
  const h = Math.max(1, Math.min(plan.effH, Math.round((plan.drawH / 72) * dpi)));
  return { w, h };
}

/* ------------------------------------------------------------------ */
/* encoding                                                            */
/* ------------------------------------------------------------------ */

/**
 * Paints the image into a canvas at the target resolution, applying the
 * page rotation here rather than via a PDF transform. Canvas rotation is
 * exact and keeps the page content stream free of matrix maths.
 */
function encode(decoded, plan, dpi, quality) {
  const target = targetPixels(plan, dpi); // already in the rotated frame
  const canvasW = Math.max(1, Math.round(target.w));
  const canvasH = Math.max(1, Math.round(target.h));

  /* unrotated pixel dimensions that still fill the rotated canvas */
  const drawW = plan.swapped ? canvasH : canvasW;
  const drawH = plan.swapped ? canvasW : canvasH;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // JPEG has no alpha channel; paint a white ground so nothing goes black.
  if (plan.format !== 'PNG') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasW, canvasH);
  }

  if (plan.rotation) {
    ctx.save();
    ctx.translate(canvasW / 2, canvasH / 2);
    ctx.rotate((plan.rotation * Math.PI) / 180);
    ctx.drawImage(decoded.source, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  } else {
    ctx.drawImage(decoded.source, 0, 0, drawW, drawH);
  }

  const png = plan.format === 'PNG';
  const dataUrl = png
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', Math.min(1, Math.max(0.05, quality / 100)));

  canvas.width = 0; canvas.height = 0; // release the backing store early
  return { dataUrl, format: png ? 'PNG' : 'JPEG' };
}

/* ------------------------------------------------------------------ */
/* document                                                            */
/* ------------------------------------------------------------------ */

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

export function buildEncryption(settings) {
  if (!settings.lockOn) return undefined;
  const userPermissions = Object.entries(settings.perms)
    .filter(([, on]) => on)
    .map(([key]) => PERMISSION_TOKENS[key])
    .filter(Boolean);
  return {
    userPassword: settings.password || '',
    ownerPassword: settings.password ? settings.password + '-owner' : '',
    userPermissions,
  };
}

export function outputName(settings) {
  const raw = (settings.filename || 'document').trim();
  const safe = raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 90).trim() || 'document';
  return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
}

/**
 * Rough output size, in bytes, derived from the pixel count actually written
 * rather than the size of the source files. Calibrated against typical
 * photographic JPEG data; deliberately approximate.
 */
export function estimateBytes(pages, settings) {
  const dpi = Number(settings.resolution) || 0;
  const q = Math.min(1, Math.max(0.05, (Number(settings.quality) || 88) / 100));
  const perPixel = 0.05 + 0.34 * q;

  let total = 0;
  for (const page of pages) {
    const target = targetPixels(planPage(page, settings), dpi);
    total += Math.max(1, target.w) * Math.max(1, target.h) * perPixel;
  }
  return Math.round(total + pages.length * 1200);
}

/**
 * Renders the whole document.
 * @param {Array} pages    page models from the store
 * @param {Object} settings resolved document settings
 * @param {(done:number,total:number,label:string)=>void} onProgress
 */
export async function buildPdf(pages, settings, onProgress = () => {}) {
  const JsPDF = PDF();
  if (!JsPDF) throw new Error('The PDF engine failed to load. Reload the page to try again.');

  const total = pages.length;
  const plans = pages.map((p) => planPage(p, settings));
  const quality = settings.quality;
  const dpi = Number(settings.resolution) || 0;
  const margin = plans[0] ? plans[0].margin : 0;
  const footerOn = !!settings.footerOn;
  const footerText = (settings.footerText || '').trim();
  const numberMode = settings.pageNumbers;
  const hasFooter = footerOn && (footerText || numberMode !== 'off');

  let doc = null;
  const encoded = [];

  onProgress(0, total, 'Decoding images');

  for (let i = 0; i < total; i++) {
    const page = pages[i];
    const plan = plans[i];
    onProgress(i, total, `Rendering page ${i + 1} of ${total} — ${page.name}`);

    let decoded;
    try {
      decoded = await decode(page.file);
    } catch (err) {
      throw new Error(`Page ${i + 1} (${page.name}): ${err.message}`);
    }

    // Trust the model's dimensions unless the decode disagrees.
    if (decoded.w && decoded.h && (decoded.w !== page.w || decoded.h !== page.h)) {
      page.w = decoded.w;
      page.h = decoded.h;
      const refreshed = planPage(page, settings);
      Object.assign(plan, refreshed);
    }

    const looks = analyse(decoded);
    plan.format = looks.alpha || looks.colors <= 2048 ? 'PNG' : 'JPEG';

    const image = encode(decoded, plan, dpi, quality);
    decoded.release();
    encoded.push(image);

    if (!doc) {
      doc = new JsPDF({
        orientation: plan.pageW >= plan.pageH ? 'landscape' : 'portrait',
        unit: 'pt',
        format: [plan.pageW, plan.pageH],
        compress: true,
        precision: 4,
        encryption: buildEncryption(settings),
      });
    } else {
      doc.addPage([plan.pageW, plan.pageH], plan.pageW >= plan.pageH ? 'landscape' : 'portrait');
    }

    drawPage(doc, plan, image);
    if (hasFooter) drawFooter(doc, plan, i, total, settings, margin);

    await nextFrame();
  }

  const meta = {
    title: settings.title || outputName(settings).replace(/\.pdf$/i, ''),
    author: settings.author || 'JD Image2PDF',
    subject: settings.subject || 'Images converted to PDF',
    keywords: settings.keywords || 'image to pdf, jd image2pdf',
    creator: 'JD Image2PDF',
  };
  doc.setProperties(meta);

  onProgress(total, total, 'Writing file');

  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);

  doc = null;
  encoded.length = 0;

  return { blob, url, pages: total, size: blob.size, name: outputName(settings) };
}

/* ------------------------------------------------------------------ */
/* drawing                                                             */
/* ------------------------------------------------------------------ */

function drawPage(doc, plan, image) {
  /* the bitmap already carries the rotation, so this is a plain blit */
  const compression = image.format === 'JPEG' ? 'FAST' : undefined;
  doc.addImage(image.dataUrl, image.format, plan.drawX, plan.drawY, plan.drawW, plan.drawH, undefined, compression);
}

function drawFooter(doc, plan, index, total, settings, margin) {
  const text = (settings.footerText || '').trim();
  let number = '';
  if (settings.pageNumbers === 'n-of-t') number = `${index + 1} of ${total}`;
  else if (settings.pageNumbers === 'n') number = `${index + 1}`;
  else if (settings.pageNumbers === 'page-n') number = `Page ${index + 1}`;

  const align = settings.footerAlign || 'right';
  const band = Math.min(Math.max(margin, 10), 22);
  const y = plan.pageH - band / 2 - 3;
  const left = plan.margin;
  const right = plan.pageW - plan.margin;

  doc.setFontSize(8);
  doc.setTextColor(128, 128, 128);

  if (text && number) {
    /* classic two-part footer: label hugs one edge, the number the other */
    doc.text(text, align === 'left' ? left : align === 'center' ? plan.pageW / 2 : left, y, { align: 'left' });
    doc.text(number, align === 'left' ? right : align === 'center' ? plan.pageW / 2 : right, y, { align: 'right' });
  } else {
    const value = text || number;
    const x = align === 'left' ? left : align === 'center' ? plan.pageW / 2 : right;
    const how = align === 'center' ? 'center' : align;
    doc.text(value, x, y, { align: how });
  }
}