// BAM, Balance of Award Miles & points (docs/bam.md), in a popup on the dashboard, opened from the
// BAM button (or /?bam): every miles and points balance in the household, grouped by currency,
// with the number and when it was last updated. Balances are typed in, or read from statement PDFs
// on the device (public/pdf-read.js and points-parse.js; the folder is shared with Bills). Each
// update is a new reading, so a balance keeps its history. Under each currency: its expiry rule
// and the linked cards that likely earn it. A native <dialog> in ABC's frame. Data: GET /points.
(function () {
  const dialog = document.getElementById("bam");
  if (!dialog) return;
  const main = document.getElementById("bamMain");

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => Number(n).toLocaleString("en-US");
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayYear = d => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;
  const KINDS = [["bank", "Bank and card points"], ["airline", "Airlines"], ["hotel", "Hotels"], ["other", "Other"]];
  const STALE_DAYS = 90;                           // older readings are greyed, with "update?"

  let users = [], data = null;
  let adding = false, updating = null, editing = null;   // the add form (true or a program id); a balance's key; a reading's id
  const openHistory = new Set();
  let review = null;                               // balances read from PDFs, waiting to be saved
  let folder = null;                               // the remembered folder (shared with Bills)
  const SOON_DAYS = 90;                            // points expiring within this get flagged

  // Reading PDFs and the remembered folder: public/pdf-read.js, loaded on demand.
  const canRemember = typeof window.showDirectoryPicker === "function";
  let pdfRead = null;
  const lib = () => (pdfRead ??= import(new URL("pdf-read.js", document.baseURI).href));

  async function load() {
    try {
      const [u, r] = await Promise.all([fetch("/users"), fetch("/points")]);
      if (u.ok) users = await u.json();
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
      data = await r.json();
    } catch (e) {
      main.innerHTML = `<div class="abc-msg abc-err">Couldn't load balances: ${esc(e.message)}</div>`;
      return;
    }
    render();
  }

  const days = d => Math.round((Date.parse(data.today) - Date.parse(d)) / 864e5);
  function ago(d) {
    const n = days(d);
    if (n <= 0) return "today";
    if (n === 1) return "yesterday";
    if (n < 60) return `${n} days ago`;
    const m = Math.round(n / 30.4);
    return m < 24 ? `${m} months ago` : `${Math.round(n / 365)} years ago`;
  }
  const keyOf = b => `${b.owner}|${b.program}|${b.account_hint ?? ""}`;
  const who = b => [users.length > 1 ? esc(users.find(u => u.key === b.owner)?.label ?? b.owner) : "", b.account_hint ? `••${esc(b.account_hint)}` : ""].filter(Boolean).join(" · ");

  function render() {
    const list = data.balances;
    let html = `<div class="bam-top">
      <div class="bam-sum">${list.length ? `${list.length} balance${list.length === 1 ? "" : "s"} in ${new Set(list.map(b => b.program)).size} currenc${new Set(list.map(b => b.program)).size === 1 ? "y" : "ies"} · last update ${ago(list.reduce((a, b) => (b.as_of > a ? b.as_of : a), "0000-00-00"))}` : "No balances yet."}</div>
      <div class="bam-actions-top">
        <button type="button" class="pill solid" data-act="add">+ Add a balance</button>
        <button type="button" class="pill" data-act="pdf">Add from PDFs</button>
        <button type="button" class="pill bam-folder" data-act="folder">${folder ? "Change folder" : "Add a folder"}</button>
      </div>
    </div>${folderHtml()}`;
    if (review) html += reviewHtml();
    if (adding) html += formHtml(null, "new", typeof adding === "string" ? adding : null);
    if (!list.length && !adding && !data.cards.length) {
      html += `<p class="abc-msg">Add your first balance: pick the program and type the number from its site or your statement, or add your statement PDFs. BAM keeps each balance here with its date.</p>`;
    }
    for (const [kind, label] of KINDS) {
      // Currencies with a balance, and ones a linked card likely earns that have none yet.
      const programs = [...new Set([...list.filter(b => (b.kind ?? "other") === kind).map(b => b.program),
                                    ...data.cards.map(c => c.program).filter(p => (prog(p)?.kind ?? "other") === kind)])]
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      if (!programs.length) continue;
      html += `<h3>${label}</h3>`;
      for (const p of programs) {
        const rows = list.filter(b => b.program === p);
        const total = rows.reduce((s, b) => s + b.balance, 0);
        const unit = rows[0]?.unit ?? prog(p)?.unit ?? "points";
        html += `<section class="bam-cur" aria-label="${esc(nameOf(p))}">
          <div class="bam-cur-head"><span class="bam-name">${esc(nameOf(p))}</span>${rows.length > 1 ? `<span class="bam-total">${num(total)} <small>${esc(unit)} in all</small></span>` : ""}</div>
          ${curNotes(p, unit)}` +
          (rows.length ? rows.map(rowHtml).join("") : `<div class="bam-row bam-none">No balance yet. <button type="button" class="bam-link" data-add-program="${esc(p)}">Add it</button></div>`) +
          `</section>`;
      }
    }
    html += `<p class="bam-fine">BAM never signs in to a loyalty program and stores no logins: these are the balances you added, with the date each was correct. Statement PDFs are read on this device and never uploaded. Programs, expiry rules and which cards earn what are as on the programs' own sites, checked ${esc(data.checked)}; "likely earned by" is a guess from each card's name.</p>`;
    html += `<input type="file" id="bamPdfs" accept="application/pdf,.pdf" multiple hidden><input type="file" id="bamFolder" webkitdirectory multiple hidden>`;
    main.innerHTML = html;
  }

  const prog = id => data.programs.find(p => p.id === id);
  const nameOf = id => prog(id)?.name ?? id;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  /** Under a currency's name: its expiry rule, when it has a simple one, and the cards that likely earn it. */
  function curNotes(p, unit) {
    const e = prog(p)?.expiry, notes = [];
    if (e?.kind === "never") notes.push(`${cap(unit)} don't expire.`);
    if (e?.kind === "while_open") notes.push(`${cap(unit)} don't expire while a card that earns them is open.`);
    if (e?.kind === "inactivity") notes.push(`${cap(unit)} expire after ${e.months} months without earning or redeeming.`);
    const cards = data.cards.filter(c => c.program === p);
    if (cards.length) notes.push(`Likely earned by ${cards.map(c => `${esc(c.name || "a card")}${c.mask ? ` ••${esc(c.mask)}` : ""}${users.length > 1 ? ` (${esc(users.find(u => u.key === c.owner)?.label ?? c.owner)})` : ""}`).join(", ")}.`);
    return notes.length ? `<div class="bam-notes">${notes.join(" ")}</div>` : "";
  }

  /** For a program that expires after inactivity: the last change BAM saw in this balance (activity),
   * and when the points would expire without more. BAM only knows activity from changes between readings. */
  function expiryHtml(b) {
    const e = prog(b.program)?.expiry;
    if (e?.kind !== "inactivity") return "";
    const readings = [b, ...b.history];
    const i = readings.findIndex((r, j) => readings[j + 1] && r.balance !== readings[j + 1].balance);
    if (i < 0) return `<div class="bam-exp">BAM sees activity when this balance changes between updates.</div>`;
    const seen = readings[i].as_of, d = new Date(seen + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + e.months);
    const until = d.toISOString().slice(0, 10), left = -days(until);
    return `<div class="bam-exp${left <= SOON_DAYS ? " soon" : ""}">Last change seen ${dayYear(seen)}: without more activity, these expire around ${dayYear(until)}${left < 0 ? " (already past: check the program's site)" : left <= SOON_DAYS ? ` (in ${left} days)` : ""}.</div>`;
  }

  function folderHtml() {
    if (!folder) return "";
    const name = `<b>${esc(folder.name)}</b>`;
    const line = folder.state === "granted"
      ? `Your statements folder ${name}: ${esc(folder.note || "")} <button type="button" data-act="rescan">Check now</button>`
      : folder.state === "prompt"
        ? `Your statements folder ${name}. <button type="button" data-act="allow">Check for new statements</button> <span class="bam-tip">(choose “Allow on every visit” and Minty checks it each time)</span>`
        : `Minty can no longer read your statements folder ${name}. <button type="button" data-act="folder">Pick it again</button>`;
    return `<div class="bam-folderline">${line} <button type="button" data-act="forget">Forget this folder</button> <span class="bam-tip">(Bills uses it too)</span></div>`;
  }

  function reviewHtml() {
    const rows = review.rows, n = rows.filter(r => r.on).length;
    const opts = sel => data.programs.map(p => `<option value="${esc(p.id)}"${p.id === sel ? " selected" : ""}>${esc(p.name)}</option>`).join("");
    return `<section class="bam-review" aria-label="Balances read from PDFs"><h3>From your PDFs</h3>
      <p class="bam-tip">Check each one, then save. The PDFs stay on this device; only these fields are saved.</p>
      <table><thead><tr><th></th><th>File</th><th>Program</th><th>Balance</th><th>As of</th><th>Last 4</th>${users.length > 1 ? "<th>Person</th>" : ""}</tr></thead><tbody>` +
      rows.map((r, i) => `<tr class="${r.known ? "known" : ""}${r.error ? " err" : ""}" data-row="${i}">
        <td><input type="checkbox" name="on" ${r.on ? "checked" : ""} ${r.known || r.error ? "disabled" : ""} aria-label="Save ${esc(r.file)}"></td>
        <td class="file">${esc(r.file)}${r.reading ? "<small>Reading…</small>" : r.known ? "<small>Already added</small>" : r.error ? `<small>${esc(r.error)}</small>` : ""}</td>
        <td><select name="program">${opts(r.program)}</select></td>
        <td><input name="balance" inputmode="numeric" size="9" value="${r.balance == null ? "" : num(r.balance)}"></td>
        <td><input name="as_of" type="date" value="${esc(r.as_of ?? "")}" max="${esc(data.today)}"></td>
        <td><input name="account_hint" inputmode="numeric" maxlength="4" size="4" value="${esc(r.account_hint ?? "")}"></td>
        ${users.length > 1 ? `<td><select name="owner">${users.map(u => `<option value="${esc(u.key)}"${u.key === r.owner ? " selected" : ""}>${esc(u.label)}</option>`).join("")}</select></td>` : ""}
      </tr>`).join("") + `</tbody></table>
      <p class="bam-err" role="status"></p>
      <div class="bam-form-actions"><button type="button" class="pill solid" data-act="save-review">Save ${n || ""} balance${n === 1 ? "" : "s"}</button><button type="button" class="pill" data-act="cancel-review">Cancel</button></div>
    </section>`;
  }

  function rowHtml(b) {
    const k = keyOf(b), stale = days(b.as_of) > STALE_DAYS;
    let html = `<div class="bam-row${stale ? " stale" : ""}">
      <div class="bam-main">
        <div class="bam-bal">${num(b.balance)} <small>${esc(b.unit)}</small></div>
        <div class="bam-meta">${who(b) ? `${who(b)} · ` : ""}as of ${dayYear(b.as_of)} · ${ago(b.as_of)}${b.history[0] && b.history[0].balance !== b.balance ? ` · <span class="${b.balance < b.history[0].balance ? "down" : "up"}">${b.balance > b.history[0].balance ? "+" : "−"}${num(Math.abs(b.balance - b.history[0].balance))}</span> since ${dayYear(b.history[0].as_of)}` : ""}${stale ? ` · <button type="button" class="bam-link" data-update="${esc(k)}">update?</button>` : ""}</div>
        ${expiryHtml(b)}
        <div class="bam-actions">
          <button type="button" data-update="${esc(k)}">Update</button>
          <button type="button" data-edit="${b.id}">Fix this one</button>
          ${b.history.length ? `<button type="button" data-hist="${esc(k)}" aria-expanded="${openHistory.has(k)}">History (${b.history.length})</button>` : ""}
          <button type="button" data-del="${b.id}">Delete</button>
        </div>
      </div>
    </div>`;
    if (updating === k) html += formHtml(b, "update");
    if (editing === b.id) html += formHtml(b, "edit");
    if (openHistory.has(k) && b.history.length) {
      html += `<table class="bam-history"><thead><tr><th>As of</th><th>Balance</th><th>Change</th><th></th></tr></thead><tbody>` +
        b.history.map((h, i) => {
          const older = b.history[i + 1], d = older ? h.balance - older.balance : null;   // since the reading before it
          const change = d === null ? "" : d === 0 ? "no change" : `${d > 0 ? "+" : "−"}${num(Math.abs(d))}`;
          return `<tr><td>${dayYear(h.as_of)}</td><td>${num(h.balance)}</td><td class="${d < 0 ? "down" : d > 0 ? "up" : ""}">${change}</td><td><button type="button" class="bam-link" data-del="${h.id}">Delete</button></td></tr>`;
        }).join("") + `</tbody></table>`;
    }
    return html;
  }

  /** The add form ("new"), a new reading of a balance ("update"), or a correction of one ("edit"). */
  function formHtml(b, mode, program = null) {
    const opts = KINDS.filter(([k]) => k !== "other").map(([k, label]) =>
      `<optgroup label="${label}">${data.programs.filter(p => p.kind === k).map(p => `<option value="${esc(p.id)}"${p.id === program ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>`).join("");
    const title = mode === "new" ? "Add a balance" : mode === "update" ? `Update ${esc(b.name)}` : `Fix this reading of ${esc(b.name)}`;
    const date = mode === "edit" ? b.as_of : data.today;
    const fixed = mode === "update";                // an update keeps the balance's program, person and account
    return `<form class="bam-form" data-form="${mode}"${b ? ` data-id="${b.id}"` : ""}>
      <h4>${title}</h4>
      ${fixed ? "" : `<label class="wide">Program<select name="program" required>${opts}<option value="__other">Another program (type its name)…</option></select></label>
      <label class="wide bam-other" hidden>Program name<input name="other" maxlength="40" placeholder="e.g. Alaska Mileage Plan"></label>`}
      ${!fixed && users.length > 1 ? `<label>Person<select name="owner">${users.map(u => `<option value="${esc(u.key)}">${esc(u.label)}</option>`).join("")}</select></label>` : ""}
      ${fixed ? "" : `<label>Last 4 digits <small>(optional)</small><input name="account_hint" inputmode="numeric" pattern="\\d{4}" maxlength="4" value="${esc(b?.account_hint ?? "")}"></label>`}
      <label>Balance<input name="balance" inputmode="numeric" required value="${mode === "edit" ? b.balance : ""}" placeholder="e.g. 65,536"></label>
      <label>As of<input name="as_of" type="date" required value="${esc(date)}" max="${esc(data.today)}"></label>
      <p class="bam-err" role="status"></p>
      <div class="bam-form-actions"><button type="submit" class="pill solid">Save</button><button type="button" class="pill" data-act="cancel">Cancel</button></div>
    </form>`;
  }

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    return r.json();
  }
  const whole = s => { const t = String(s).replace(/[,\s_]/g, ""); return /^\d+$/.test(t) ? Number(t) : null; };

  /** Reads balances from PDFs into the review: only the ones BAM doesn't have yet are read.
   * `fromFolder`: a check of the shared folder, which shows only new PDFs with a balance in them;
   * the others (bills, statements without points) are set aside for BAM, so they aren't read again.
   * Returns how many are new. */
  async function readPdfs(files, fromFolder = false) {
    const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!pdfs.length) { if (!fromFolder) alert("No PDFs there."); return 0; }
    if (!fromFolder) {
      review = { rows: pdfs.slice(0, 50).map(f => ({ file: f.name, on: false, program: null, balance: null, as_of: null, account_hint: null, reading: true })) };
      render();
    }
    const [pr, { parsePoints }] = await Promise.all([lib(), import(new URL("points-parse.js", document.baseURI).href)]);
    let { rows } = await pr.readPdfs(pdfs, { view: "points", fromFolder, parse: parsePoints,
                                             known: async sha256 => (await api("POST", "/points/known", { sha256 })).known });
    const none = rows.filter(r => !r.known && !r.error && !r.program);
    if (fromFolder) {
      await pr.skip("points", none.map(r => r.sha));
      rows = rows.filter(r => !none.includes(r));
    } else {
      for (const r of none) Object.assign(r, { error: "No miles or points balance found in it", on: false });
    }
    for (const r of rows) {
      if (r.on && r.balance == null) r.on = false;   // nothing to save until a number is typed
      // A statement whose last 4 matches no balance joins the only balance in its program that has
      // no last 4 (one typed in before), rather than starting a second balance for the same points.
      if (r.program && r.account_hint && !data.balances.some(b => b.program === r.program && b.account_hint === r.account_hint)) {
        const bare = data.balances.filter(b => b.program === r.program && !b.account_hint);
        if (bare.length === 1) Object.assign(r, { account_hint: null, owner: bare[0].owner });
      }
    }
    if (fromFolder && !rows.length) return 0;
    review = { rows, fromFolder };
    render();
    return rows.length;
  }

  async function scanFolder() {
    if (!folder || folder.state !== "granted" || review) { if (data) render(); return; }
    folder.note = "checking for new statements…";
    render();
    try {
      const n = await readPdfs(await (await lib()).folderPdfs(folder.handle), true);
      folder.note = n ? `${n} new balance${n === 1 ? "" : "s"} below.` : "no new balances.";
    } catch {
      folder.state = "denied";                     // moved, deleted, or access taken back
    }
    render();
  }

  async function saveReview() {
    const box = main.querySelector(".bam-review .bam-err");
    const rows = review.rows.filter(r => r.on);
    const bad = rows.find(r => !r.program || r.balance == null || !r.as_of);
    if (bad) { box.textContent = `${bad.file}: fill in the program, balance and date (or untick it).`; return; }
    let saved = 0;
    for (const r of rows) {
      try {
        await api("POST", "/points", { program: r.program, balance: r.balance, as_of: r.as_of, account_hint: r.account_hint || null,
                                       source: "pdf", file_sha256: r.sha, ...(r.owner ? { owner: r.owner } : {}) });
        saved++; r.on = false; r.known = true;
      } catch (err) { box.textContent = `${r.file}: ${err.message}`; render(); return; }
    }
    if (review.fromFolder) { await (await lib()).skip("points", review.rows.filter(r => !r.known).map(r => r.sha)); if (folder) folder.note = "up to date."; }
    review = null;
    await load();
    main.querySelector(".bam-sum")?.insertAdjacentHTML("beforeend", ` · <b>${saved} balance${saved === 1 ? "" : "s"} saved</b>`);
  }

  main.addEventListener("click", async e => {
    const t = e.target;
    const act = t.closest("[data-act]")?.dataset.act;
    if (act === "add") { adding = true; updating = editing = null; render(); main.querySelector('.bam-form select[name="program"]')?.focus(); return; }
    const ap = t.closest("[data-add-program]");
    if (ap) { adding = ap.dataset.addProgram; updating = editing = null; render(); main.querySelector('.bam-form input[name="balance"]')?.focus(); return; }
    if (act === "pdf") { main.querySelector("#bamPdfs").click(); return; }
    if (act === "folder") {
      if (!canRemember) { main.querySelector("#bamFolder").click(); return; }
      const picked = await (await lib()).pickFolder();
      if (picked) { folder = picked; review = null; scanFolder(); }
      return;
    }
    if (act === "rescan") { review = null; scanFolder(); return; }
    if (act === "allow") { folder.state = await (await lib()).askAgain(folder); scanFolder(); return; }
    if (act === "forget") {
      if (!confirm("Forget this folder? Bills uses it too.")) return;
      await (await lib()).forgetFolder(); folder = null; render(); return;
    }
    if (act === "cancel-review") {
      if (review.fromFolder) { await (await lib()).skip("points", review.rows.filter(r => !r.known).map(r => r.sha)); if (folder) folder.note = "nothing new to add."; }
      review = null; render(); return;
    }
    if (act === "save-review") return saveReview();
    if (act === "cancel") { adding = false; updating = editing = null; render(); return; }
    const up = t.closest("[data-update]");
    if (up) { updating = up.dataset.update; adding = false; editing = null; render(); main.querySelector('.bam-form input[name="balance"]')?.focus(); return; }
    const ed = t.closest("[data-edit]");
    if (ed) { editing = Number(ed.dataset.edit); adding = false; updating = null; render(); return; }
    const h = t.closest("[data-hist]");
    if (h) { const k = h.dataset.hist; openHistory.has(k) ? openHistory.delete(k) : openHistory.add(k); render(); return; }
    const del = t.closest("[data-del]");
    if (del && confirm("Delete this reading?")) { try { await api("DELETE", `/points/${del.dataset.del}`); } catch (err) { alert(err.message); } return load(); }
  });

  main.addEventListener("change", e => {
    if (e.target.id === "bamPdfs" || e.target.id === "bamFolder") { readPdfs(e.target.files); e.target.value = ""; return; }
    const row = e.target.closest("tr[data-row]");
    if (row && review) {
      const r = review.rows[Number(row.dataset.row)], f = e.target;
      if (f.name === "on") { r.on = f.checked; render(); }
      else if (f.name === "balance") r.balance = whole(f.value);
      else r[f.name] = f.value;
      return;
    }
    if (e.target.name === "program" && e.target.form) {
      const other = e.target.form.querySelector(".bam-other");
      other.hidden = e.target.value !== "__other";
      other.querySelector("input").required = !other.hidden;
    }
  });

  main.addEventListener("submit", async e => {
    const form = e.target.closest("form.bam-form");
    if (!form) return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const box = form.querySelector(".bam-err");
    const balance = whole(f.balance);
    if (balance === null) { box.textContent = "Type the balance as a whole number, like 65,536."; return; }
    const mode = form.dataset.form;
    const b = data.balances.find(x => keyOf(x) === updating) ?? data.balances.find(x => x.id === editing);
    const body = { balance, as_of: f.as_of };
    if (mode === "update") Object.assign(body, { program: b.program, owner: b.owner, account_hint: b.account_hint });
    else Object.assign(body, { program: f.program === "__other" ? f.other : f.program, account_hint: f.account_hint || null, ...(f.owner ? { owner: f.owner } : {}) });
    try {
      if (mode === "edit") await api("PUT", `/points/${form.dataset.id}`, body);
      else await api("POST", "/points", body);
      adding = false; updating = editing = null;
      load();
    } catch (err) { box.textContent = err.message; }
  });

  async function open() {
    if (!dialog.open) dialog.showModal();
    const [, f] = await Promise.all([load(), canRemember ? lib().then(m => m.rememberedFolder()).catch(() => null) : null]);
    folder = f;
    if (data) scanFolder();
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-open-bam]")) { e.preventDefault(); open(); }
  });
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });   // a click on the backdrop
  if (new URLSearchParams(location.search).has("bam")) open();
})();
