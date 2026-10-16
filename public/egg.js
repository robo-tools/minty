// EGG, the retirement view (docs/cfa.md §3), in a popup on the dashboard, opened from the EGG
// button (or /?egg). Less is more: the trend (what you put in, apart from what it earned), a
// forecast in today's dollars, this year's contributions against the IRS limits, the mix and the
// cash in it, and the accounts with their "show on the dashboard too" switch. Data: GET
// /retirement; charts: public/charts.js. Educational, not financial advice.
(function () {
  const dialog = document.getElementById("egg");
  if (!dialog) return;
  const main = document.getElementById("eggMain");
  const C = () => window.MintyCharts;

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const money = c => (c < 0 ? "−" : "") + "$" + Math.round(Math.abs(c) / 100).toLocaleString("en-US");
  const short = c => { const d = Math.abs(c) / 100, s = c < 0 ? "−" : ""; return d >= 1e6 ? `${s}$${(d / 1e6).toFixed(d >= 1e7 ? 0 : 1)}M` : d >= 1e3 ? `${s}$${Math.round(d / 1e3)}k` : `${s}$${Math.round(d)}`; };
  const pct = x => `${Math.round(x * 100)}%`;
  const dayLabel = d => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  const dayYear = d => `${dayLabel(d)}, ${d.slice(0, 4)}`;
  const RATES = [["cautious", 0.03], ["middle", 0.05], ["hopeful", 0.07]];   // real returns, after inflation
  const RANGES = [[365, "1 year"], [1826, "5 years"], [null, "All"]];
  const MIX = [["stocks", "Stocks"], ["blend", "Target-date & balanced"], ["bonds", "Bonds"], ["cash", "Cash"], ["other", "Other"]];
  const KIND = { workplace: "401(k), 403(b), 457(b)", ira: "IRA (traditional and Roth together)", simple: "SIMPLE IRA", hsa: "HSA" };

  let users = [], data = null, owner = "", range = 365, editing = false;

  async function load() {
    try {
      const q = owner ? `?owner=${encodeURIComponent(owner)}` : "";
      const [u, r] = await Promise.all([users.length ? null : fetch("/users"), fetch(`/retirement${q}`)]);
      if (u?.ok) users = await u.json();
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
      data = await r.json();
    } catch (e) {
      main.innerHTML = `<div class="abc-msg abc-err">Couldn't load EGG: ${esc(e.message)}</div>`;
      return;
    }
    render();
  }

  const width = () => Math.max(260, Math.min(main.clientWidth || 640, 940) - 2);
  const label = k => users.find(u => u.key === k)?.label ?? k;
  /** Whose forecast and limits: the person picked, or the only person. */
  const person = () => owner || (users.length === 1 ? users[0].key : null);
  const profileOf = k => (k && data.profiles[k]) || {};

  /** The total of the retirement accounts per day: each account's newest snapshot on or before it. */
  function series() {
    const mine = new Set(data.accounts.filter(a => a.in_retirement).map(a => a.id));
    const rows = data.snapshots.filter(s => mine.has(s.account_id)).sort((a, b) => (a.date < b.date ? -1 : 1));
    const dates = [...new Set(rows.map(r => r.date))];
    const last = new Map(), out = [];
    let i = 0;
    for (const d of dates) {
      while (i < rows.length && rows[i].date <= d) { last.set(rows[i].account_id, rows[i].cents ?? 0); i++; }
      out.push({ date: d, cents: [...last.values()].reduce((s, v) => s + v, 0) });
    }
    return out;
  }

  function render() {
    const ret = data.accounts.filter(a => a.in_retirement), others = data.accounts.filter(a => !a.in_retirement);
    const total = ret.reduce((s, a) => s + (a.balance ?? 0), 0);
    const fetching = data.banks.filter(b => b.status === "pending" && !b.synced_at);
    let html = `<div class="cfa-top">
      ${users.length > 1 ? `<select id="eggOwner" aria-label="Person"><option value="">Everyone</option>${users.map(u => `<option value="${esc(u.key)}"${u.key === owner ? " selected" : ""}>${esc(u.label)}</option>`).join("")}</select>` : ""}
      <span class="egg-total">${money(total)} <small>in ${ret.length} retirement account${ret.length === 1 ? "" : "s"}</small></span>
    </div>`;
    if (fetching.length) html += `<p class="cfa-muted">${fetching.map(b => esc(b.bank || "A bank")).join(", ")}: fetching the investment accounts (within about ten minutes).</p>`;
    if (!ret.length) {
      html += `<p class="abc-msg">No retirement accounts yet. <a href="/connect#investments">Link one</a>: a 401(k), IRA or HSA login (Schwab, Fidelity…), or add the investment accounts of a bank you've linked already.${others.length ? " Or move one of the accounts below into EGG." : ""}</p>`;
      html += accountsHtml(ret, others);
      main.innerHTML = html;
      return;
    }

    // 1. Trend, and what was put in apart from what it earned
    const all = series(), cut = range ? new Date(Date.parse(data.today) - range * 864e5).toISOString().slice(0, 10) : "0000";
    const shown = all.filter(p => p.date >= cut);
    const put12 = data.contributions.reduce((s, c) => s + (c.last_12m ?? 0), 0);
    const fees = data.fees.reduce((s, f) => s + f.cents, 0);
    const finds = [];
    if (shown.length >= 2) {
      const first = shown[0], lastP = shown.at(-1);
      const days = (Date.parse(lastP.date) - Date.parse(first.date)) / 864e5;
      const put = data.contributions.reduce((s, c) => s + (days >= 360 ? (c.last_12m ?? 0) : 0), 0);
      finds.push(`${money(lastP.cents)} today, ${lastP.cents >= first.cents ? "up" : "down"} ${money(Math.abs(lastP.cents - first.cents))} since ${dayYear(first.date)}.`);
      if (days >= 360) finds.push(`Over the last 12 months you put in <b>${money(put)}</b>, and the investments ${lastP.cents - first.cents - put >= 0 ? "earned" : "lost"} <b>${money(Math.abs(lastP.cents - first.cents - put))}</b>.`);
    } else {
      finds.push(`The balance history starts ${all[0] ? dayYear(all[0].date) : "today"}: the line fills in day by day.`);
    }
    if (put12 > 0) finds.push(`Contributions Minty saw in the last 12 months: ${money(put12)}.`);
    if (fees > 0) finds.push(`Fees charged inside the accounts this year: ${money(fees)}.`);
    html += section("Trend", `<div class="bill-ranges cfa-ranges" role="group" aria-label="How far back">${RANGES.map(([n, l]) => `<button type="button" data-range="${n}" aria-pressed="${n === range}">${l}</button>`).join("")}</div>` +
      (shown.length >= 2 ? C().lines({ labels: shown.map(p => p.date), series: [{ name: "Retirement accounts", cls: "net", values: shown.map(p => p.cents) }], width: width(), fmt: short, short: dayLabel }) : `<p class="cfa-big">${money(total)}</p>`), finds);

    // 2. Forecast, in today's dollars
    const k = person(), prof = profileOf(k);
    const year = Number(data.today.slice(0, 4));
    const age = prof.birth_year ? year - prof.birth_year : null;
    const retireAge = prof.retire_age ?? 65;
    const years = age !== null ? Math.max(0, retireAge - age) : 20;
    const mineTotal = k ? ret.filter(a => a.owner === k).reduce((s, a) => s + (a.balance ?? 0), 0) : total;
    const yearly = data.contributions.filter(c => !k || c.owner === k).reduce((s, c) => s + (c.last_12m ?? 0), 0);
    const fv = (r, n) => mineTotal * (1 + r) ** n + (r ? yearly * (((1 + r) ** n - 1) / r) : yearly * n);
    if (years > 0) {
      const labels = Array.from({ length: years + 1 }, (_, i) => (age !== null ? String(age + i) : `+${i}`));
      const lines = RATES.map(([name, r]) => ({ name: `${name} (${pct(r)})`, cls: `f-${name}`, values: labels.map((_, i) => fv(r, i)) }));
      const at = RATES.map(([name, r]) => [name, fv(r, years)]);
      const mid = at[1][1];
      const notes = [
        `${age !== null ? `At ${retireAge}` : `In ${years} years`}: about <b>${money(mid)}</b> in today's dollars (${money(at[0][1])} cautious, ${money(at[2][1])} hopeful), from ${money(mineTotal)} now and ${money(yearly)} a year going in.`,
        `At a 4% withdrawal rate, ${money(mid)} supports about <b>${money(mid * 0.04)} a year</b> (${money(mid * 0.04 / 12)} a month).`,
      ];
      if (prof.target_cents) {
        const n = prof.target_age && age !== null ? Math.max(0, prof.target_age - age) : years, r = 0.05;
        const grow = mineTotal * (1 + r) ** n, need = n ? Math.max(0, (prof.target_cents - grow) * r / ((1 + r) ** n - 1)) : 0;
        notes.push(fv(r, n) >= prof.target_cents ? `On track for your target of ${money(prof.target_cents)} (middle case).`
          : `Behind your target of ${money(prof.target_cents)}: about <b>${money(Math.max(0, need - yearly) / 12)} a month more</b> would reach it in the middle case.`);
      }
      if (age === null) notes.push(`Add a birth year below for a forecast to your retirement age.`);
      html += section(k ? `Forecast for ${esc(label(k))}` : "Forecast for everyone", C().legend(lines) + C().lines({ labels, series: lines, width: width(), fmt: short, short: x => x }), notes);
    } else if (k) {
      html += section(`Forecast for ${esc(label(k))}`, `<p class="cfa-muted">At or past the retirement age in the profile (${retireAge}).</p>`, []);
    }

    // 3. This year's contributions against the limits
    const L = data.limits;
    if (L) {
      const people = k ? [k] : [...new Set(ret.map(a => a.owner))];
      const day = (Date.parse(data.today) - Date.parse(`${year}-01-01`)) / 864e5 + 1;
      let rows = "", notes = [];
      for (const p of people) {
        const pAge = profileOf(p).birth_year ? year - profileOf(p).birth_year : null;
        for (const kind of ["workplace", "ira", "simple", "hsa"]) {
          if (!ret.some(a => a.owner === p && a.kind === kind)) continue;
          const ytd = data.contributions.filter(c => c.owner === p && c.kind === kind && c.year === String(year)).reduce((s, c) => s + c.cents, 0);
          let limit = { workplace: L.workplace, ira: L.ira, simple: L.simple, hsa: profileOf(p).hsa_coverage === "family" ? L.hsaFamily : L.hsaSelf }[kind];
          const catchUp = pAge === null ? 0 : kind === "workplace" ? (pAge >= 60 && pAge <= 63 ? L.workplaceCatchUp60to63 : pAge >= 50 ? L.workplaceCatchUp50 : 0)
            : kind === "ira" ? (pAge >= 50 ? L.iraCatchUp50 : 0) : kind === "simple" ? (pAge >= 50 ? L.simpleCatchUp50 : 0) : kind === "hsa" ? (pAge >= 55 ? L.hsaCatchUp55 : 0) : 0;
          limit += catchUp;
          const pace = limit * day / 365, left = Math.max(0, limit - ytd), monthsLeft = Math.max(1, 12 - Number(data.today.slice(5, 7)) + 1);
          rows += `<div class="egg-lim"><div><b>${esc(KIND[kind])}</b>${people.length > 1 || users.length > 1 ? ` · ${esc(label(p))}` : ""}<small>${money(ytd)} of ${money(limit)}${catchUp ? ` (with the ${money(catchUp)} catch-up)` : ""}</small></div>
            <span class="egg-bar"><i style="width:${Math.min(100, (ytd / limit) * 100).toFixed(1)}%"></i><b style="left:${Math.min(100, (pace / limit) * 100).toFixed(1)}%" title="Where an even pace would be today"></b></span></div>`;
          if (ytd < pace * 0.9 && left > 0) notes.push(`${esc(KIND[kind])}${users.length > 1 ? ` (${esc(label(p))})` : ""}: behind an even pace; about ${money(left / monthsLeft)} a month would reach the ${year} limit by December 31${kind === "ira" || kind === "hsa" ? ` (or by the April ${year + 1} deadline)` : ""}.`);
        }
        const match = profileOf(p).match_pct;
        if (match && ret.some(a => a.owner === p && a.kind === "workplace")) notes.push(`${users.length > 1 ? `${esc(label(p))}: ` : ""}your employer matches up to ${match}% of pay: contributing at least ${match}% collects all of it, which is the first money worth putting in.`);
      }
      if (rows) {
        notes.push(`Employer contributions don't count toward the 401(k) limit (they do for an HSA). Plaid doesn't always tell them apart, so treat these as a guide. Limits: IRS, checked ${esc(L.checked)}.`);
        html += section(`${year} contributions`, rows + `<p class="cfa-key"><i></i> so far <b></b> an even pace</p>`, notes);
      }
    }

    // 4. Mix and cash
    const mixTotal = data.mix.reduce((s, m) => s + m.cents, 0);
    if (mixTotal > 0) {
      const part = c => (data.mix.find(m => m.class === c)?.cents ?? 0) / mixTotal;
      const cash = part("cash");
      html += section("Mix", `<div class="egg-mix">${MIX.filter(([c]) => part(c) > 0).map(([c, l]) => `<span class="m-${c}" style="width:${(part(c) * 100).toFixed(1)}%" title="${esc(l)}: ${pct(part(c))}"></span>`).join("")}</div>
        <div class="ch-legend">${MIX.filter(([c]) => part(c) > 0).map(([c, l]) => `<span><i class="m-${c}"></i>${esc(l)} ${pct(part(c))}</span>`).join("")}</div>`,
        [cash > 0.1 && (age === null || age < 55) ? `<b>${pct(cash)} is cash</b> (${money(cash * mixTotal)}): money that isn't invested grows slowly over a long horizon. Check it's invested the way you intend, for example after a rollover or a contribution that didn't buy anything.` : null,
         "From what the accounts hold, sorted by fund names (a bond fund from a stock fund): a guide, not an analysis."]);
    }

    html += accountsHtml(ret, others) + profileHtml(k);
    html += `<p class="bill-fine">Educational, not financial advice: Minty isn't a CFP, CFA or registered advisor. The forecast is arithmetic, not a prediction: it assumes steady real returns (after inflation) of 3, 5 and 7% a year and the contributions of the last 12 months, in today's dollars, before taxes. The 4% rule is a rule of thumb for how much a retirement fund can pay out a year.</p>`;
    main.innerHTML = html;
  }

  function accountsHtml(ret, others) {
    const row = (a, inEgg) => `<div class="egg-acct"><span><b>${esc(a.name || "Account")}</b>${a.mask ? ` ••${esc(a.mask)}` : ""}<small>${esc(a.bank || "")}${users.length > 1 ? ` · ${esc(label(a.owner))}` : ""} · ${esc(a.subtype || a.type)}</small></span>
      <span class="egg-bal">${money(a.balance ?? 0)}</span>
      <label class="egg-switch"><input type="checkbox" data-view="${a.id}" data-in="${inEgg ? 1 : 0}" ${inEgg ? "" : "checked"}> ${inEgg ? "Show on the dashboard too" : "On the dashboard"}</label></div>`;
    return `<section class="cfa-sec"><h3>Accounts</h3>${ret.map(a => row(a, true)).join("") || `<p class="cfa-muted">None in EGG.</p>`}
      ${others.length ? `<h4>Other investment accounts, on the dashboard</h4>${others.map(a => row(a, false)).join("")}<p class="cfa-muted">Untick one to keep it in EGG instead.</p>` : ""}</section>`;
  }

  function profileHtml(k) {
    if (!k) return users.length > 1 ? `<p class="cfa-muted">Pick a person above to see their forecast and set their profile.</p>` : "";
    const p = profileOf(k);
    if (!editing) {
      const bits = [p.birth_year ? `born ${p.birth_year}` : null, `retiring at ${p.retire_age ?? 65}${p.retire_age ? "" : " (default)"}`,
        p.target_cents ? `target ${money(p.target_cents)}${p.target_age ? ` by ${p.target_age}` : ""}` : null, p.match_pct ? `employer match ${p.match_pct}%` : null,
        p.hsa_coverage ? `HSA: ${p.hsa_coverage} coverage` : null].filter(Boolean);
      return `<section class="cfa-sec"><h3>${esc(label(k))}'s profile</h3><p class="cfa-muted">${bits.join(" · ")}. <button type="button" class="abc-link" data-act="edit">Change</button></p>
        <p class="egg-ben">${p.beneficiaries_checked_on ? `✓ Beneficiaries checked on every account (${dayYear(p.beneficiaries_checked_on)}).` : `Have you named a beneficiary on every retirement account? It decides who inherits them, whatever a will says.`}
        <button type="button" class="abc-link" data-act="ben">${p.beneficiaries_checked_on ? "Checked again today" : "Yes, I've checked"}</button></p></section>`;
    }
    return `<section class="cfa-sec"><h3>${esc(label(k))}'s profile</h3><form class="egg-form">
      <label>Birth year<input name="birth_year" inputmode="numeric" value="${esc(p.birth_year ?? "")}" placeholder="e.g. 1988"></label>
      <label>Retirement age<input name="retire_age" inputmode="numeric" value="${esc(p.retire_age ?? "")}" placeholder="65"></label>
      <label>Target ($, optional)<input name="target" inputmode="numeric" value="${p.target_cents ? Math.round(p.target_cents / 100) : ""}" placeholder="e.g. 1,500,000"></label>
      <label>…by age<input name="target_age" inputmode="numeric" value="${esc(p.target_age ?? "")}" placeholder="retirement age"></label>
      <label>Employer match (% of pay)<input name="match_pct" inputmode="decimal" value="${esc(p.match_pct ?? "")}" placeholder="e.g. 4"></label>
      <label>HSA coverage<select name="hsa_coverage"><option value="">—</option><option value="self"${p.hsa_coverage === "self" ? " selected" : ""}>Self only</option><option value="family"${p.hsa_coverage === "family" ? " selected" : ""}>Family</option></select></label>
      <p class="cfa-err" role="status"></p>
      <div class="bam-form-actions"><button type="submit" class="pill solid">Save</button><button type="button" class="pill" data-act="cancel">Cancel</button></div>
    </form><p class="cfa-muted">All optional, kept in your Minty database. Without them the forecast uses age 65 and your contributions.</p></section>`;
  }

  function section(title, body, findings) {
    const f = findings.filter(Boolean);
    return `<section class="cfa-sec"><h3>${title}</h3>${body}${f.length ? `<div class="cfa-find">${f.map(x => `<p>${x}</p>`).join("")}</div>` : ""}</section>`;
  }

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    return r.json();
  }
  const whole = s => { const t = String(s ?? "").replace(/[,\s$_]/g, ""); return t === "" ? null : /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN; };

  main.addEventListener("click", async e => {
    const r = e.target.closest("[data-range]");
    if (r) { range = r.dataset.range === "null" ? null : Number(r.dataset.range); return render(); }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "edit") { editing = true; return render(); }
    if (act === "cancel") { editing = false; return render(); }
    if (act === "ben") {
      try { await api("PUT", "/retirement/profile", { ...profileOf(person()), owner: person(), beneficiaries_checked_on: data.today }); } catch (err) { alert(err.message); }
      return load();
    }
  });
  main.addEventListener("change", async e => {
    if (e.target.id === "eggOwner") { owner = e.target.value; editing = false; return load(); }
    const v = e.target.closest("input[data-view]");
    if (v) {
      // ticked = on the dashboard; unticked = in EGG. Back to the default when that's what the type says.
      const toDashboard = v.checked;
      try { await api("PUT", `/accounts/${v.dataset.view}/view`, { view: toDashboard ? "dashboard" : "retirement" }); } catch (err) { alert(err.message); }
      return load();
    }
  });
  main.addEventListener("submit", async e => {
    const form = e.target.closest("form.egg-form");
    if (!form) return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form)), box = form.querySelector(".cfa-err");
    const nums = { birth_year: whole(f.birth_year), retire_age: whole(f.retire_age), target: whole(f.target), target_age: whole(f.target_age), match_pct: whole(f.match_pct) };
    if (Object.values(nums).some(n => Number.isNaN(n))) { box.textContent = "Numbers only, please."; return; }
    try {
      await api("PUT", "/retirement/profile", { owner: person(), birth_year: nums.birth_year, retire_age: nums.retire_age,
        target_cents: nums.target === null ? null : Math.round(nums.target * 100), target_age: nums.target_age, match_pct: nums.match_pct,
        hsa_coverage: f.hsa_coverage || null, beneficiaries_checked_on: profileOf(person()).beneficiaries_checked_on ?? null });
      editing = false;
      load();
    } catch (err) { box.textContent = err.message; }
  });

  let resizing = 0;
  window.addEventListener("resize", () => { clearTimeout(resizing); resizing = setTimeout(() => { if (dialog.open && data) render(); }, 150); });

  function open() {
    if (!dialog.open) dialog.showModal();
    load();
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-open-egg]")) { e.preventDefault(); open(); }
  });
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });   // a click on the backdrop
  if (new URLSearchParams(location.search).has("egg")) open();
})();
