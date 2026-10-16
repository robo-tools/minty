// Reading statement PDFs on the device, shared by Bills (bills.js, docs/bills.md) and BAM (bam.js,
// docs/bam.md). The PDFs never leave the device: each is fingerprinted (SHA-256), and only the
// new ones are read with pdf.js (public/vendor/pdfjs, never a CDN) and handed to the view's own
// parser. Loaded on demand with import(), so pages that never read a PDF never load it.
//
// One remembered folder (the File System Access API: Chrome and Edge, not phones) serves both
// views: each checks it for PDFs it doesn't have yet, so the same card statement can give a bill
// and a points balance. The folder's handle, and each view's list of PDFs skipped from it, are
// kept in this browser's IndexedDB; Minty's database never sees either. Any IndexedDB failure
// means no remembered folder, not an error.

export const canRemember = typeof window.showDirectoryPicker === "function";
const MAX_SKIPPED = 500;
const SKIPPED = { bills: "skipped", points: "skipped:points" };   // Bills' key predates BAM

function kv(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("minty-bills", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction("kv", mode), r = fn(tx.objectStore("kv"));
      tx.oncomplete = () => { db.close(); resolve(r.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
const kvGet = k => kv("readonly", s => s.get(k)).catch(() => undefined);
const kvSet = (k, v) => kv("readwrite", s => v === undefined ? s.delete(k) : s.put(v, k)).catch(() => {});

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

let pdfjsReady = null;
function pdfjs() {
  pdfjsReady ??= import(new URL("vendor/pdfjs/pdf.min.mjs", document.baseURI).href).then(lib => {
    lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.mjs", document.baseURI).href;
    return lib;
  });
  return pdfjsReady;
}

/** The text of a PDF's first pages, as pdf.js gives it. */
async function pdfText(buf, pages = 3) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let text = "";
  for (let p = 1; p <= Math.min(doc.numPages, pages); p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    text += content.items.map(i => i.str + (i.hasEOL ? "\n" : " ")).join("") + "\n";
  }
  return text;
}

/** Reads `files` for one view. Each PDF is fingerprinted first (the same PDF twice is one row),
 * `known(shas)` says which the view already has, and only the others are read and given to
 * `parse(text, fileName)`, whose fields are merged into the row with `on: true`.
 * `fromFolder`: a check of the remembered folder, which returns only new PDFs, leaving out the
 * ones this view skipped before. Rows: { file, sha, known?, error?, on, ...fields }. */
export async function readPdfs(files, { view, known, parse, fromFolder = false, max = 50 }) {
  const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf")
    .sort((a, b) => b.lastModified - a.lastModified).slice(0, fromFolder ? 200 : max);   // the /known routes take 200
  let rows = [];
  for (const f of pdfs) {
    try {
      const buf = await f.arrayBuffer();
      rows.push({ file: f.name, sha: hex(await crypto.subtle.digest("SHA-256", buf)), buf });
    } catch { rows.push({ file: f.name, error: "Couldn't read this PDF", on: false }); }
  }
  const seen = new Set();
  rows = rows.filter(r => !r.sha || (!seen.has(r.sha) && seen.add(r.sha)));
  let have = [];
  try { have = await known(rows.filter(r => r.sha).map(r => r.sha)); } catch {}
  for (const r of rows) if (have.includes(r.sha)) { r.known = true; r.on = false; }
  if (fromFolder) {
    const skipped = new Set(await kvGet(SKIPPED[view]) ?? []);
    rows = rows.filter(r => r.sha && !r.known && !skipped.has(r.sha));
  }
  for (const r of rows.filter(r => r.buf && !r.known)) {
    try { Object.assign(r, parse(await pdfText(r.buf), r.file), { on: true }); }
    catch { Object.assign(r, { error: "Couldn't read this PDF", on: false }); }
  }
  for (const r of rows) delete r.buf;
  return { rows, count: pdfs.length };
}

/** Every PDF in a folder, and in its folders two levels down (a folder a year). */
export async function folderPdfs(dir, depth = 0, out = []) {
  for await (const entry of dir.values()) {
    if (entry.kind === "file" && /\.pdf$/i.test(entry.name)) out.push(await entry.getFile());
    else if (entry.kind === "directory" && depth < 2 && !entry.name.startsWith(".")) await folderPdfs(entry, depth + 1, out);
  }
  return out;
}

/** The remembered folder, if any, and whether Minty may read it now ("granted"), after a click
 * ("prompt": Chrome asks again each visit unless "Allow on every visit" was chosen), or not at all. */
export async function rememberedFolder() {
  if (!canRemember) return null;
  const handle = await kvGet("folder");
  if (!handle) return null;
  let state = "denied";
  try { state = await handle.queryPermission({ mode: "read" }); } catch {}
  return { handle, name: handle.name, state, note: "" };
}

/** Picks a folder and remembers it (for both views). Null if cancelled. */
export async function pickFolder() {
  let handle;
  try { handle = await window.showDirectoryPicker({ id: "minty-bills", mode: "read" }); } catch { return null; }
  await kvSet("folder", handle);
  return { handle, name: handle.name, state: "granted", note: "" };
}

/** Asks again for access (needs a click). */
export async function askAgain(folder) {
  try { return await folder.handle.requestPermission({ mode: "read" }); } catch { return "denied"; }
}

/** PDFs from a folder check that this view didn't save aren't offered to it again (on this device). */
export async function skip(view, shas) {
  shas = shas.filter(Boolean);
  if (!shas.length) return;
  const list = [...new Set([...(await kvGet(SKIPPED[view]) ?? []), ...shas])].slice(-MAX_SKIPPED);
  await kvSet(SKIPPED[view], list);
}

/** Forgets the folder, and every view's skipped list with it. */
export async function forgetFolder() {
  await kvSet("folder");
  for (const k of Object.values(SKIPPED)) await kvSet(k);
}
