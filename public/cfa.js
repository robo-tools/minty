// CFA, the Complete financial audit (docs/cfa.md), in a popup on the dashboard, opened from the ⋯
// menu (or /?audit): cash flow and the savings rate, spending by category, recurring charges,
// fees and debt, net worth, and the household's corrections. Each chart has its findings under
// it, in plain words. The numbers come from GET /audit (totals the hourly cron prepared); the
// charts are public/charts.js. Educational, not financial advice. A native <dialog> in ABC's frame.
(function () {
  const dialog = document.getElementById("cfa");
  if (!dialog) return;
  const main = document.getElementById("cfaMain");
  const C = () => window.MintyCharts;

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const money = c => (c < 0 ? "−" : "") + "$" + Math.round(Math.abs(c) / 100).toLocaleString("en-US");
  const short = c => { const d = Math.abs(c) / 100, s = c < 0 ? "−" : ""; return d >= 1e6 ? `${s}$${(d / 1e6).toFixed(1)}M` : d >= 1e3 ? `${s}$${(d / 1e3).toFixed(d >= 1e4 ? 0 : 1)}k` : `${s}$${Math.round(d)}`; };
  const pct = x => `${Math.round(x * 100)}%`;
  const monLabel = m => `${MON[Number(m.slice(5, 7)) - 1]}${m.endsWith("-01") ? ` ’${m.slice(2, 4)}` : ""}`;
  const dayLabel = d => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  const dayYear = d => `${dayLabel(d)}, ${d.slice(0, 4)}`;
  const CAT = { FOOD_AND_DRINK: "Food & drink", GENERAL_MERCHANDISE: "Shopping", RENT_AND_UTILITIES: "Rent & utilities", TRANSPORTATION: "Transportation",
                TRAVEL: "Travel", ENTERTAINMENT: "Entertainment", MEDICAL: "Medical", PERSONAL_CARE: "Personal care", GENERAL_SERVICES: "Services",
                HOME_IMPROVEMENT: "Home", GOVERNMENT_AND_NON_PROFIT: "Government & giving", BANK_FEES: "Fees", INTEREST: "Interest charged", CREDITS: "Card credits",
                TRANSFER_OUT: "Transfers out (not matched)", LOAN_PAYMENTS: "Loan payments", INCOME: "Income", TRANSFER_IN: "Money in", OTHER: "Other" };
  const catName = c => CAT[c] ?? c.toLowerCase().replace(/_and_/g, " & ").replace(/_/g, " ").replace(/^./, x => x.toUpperCase());
  const BUCKETS = [["spend", "Spending"], ["saving", "Saving"], ["transfer", "A transfer (ignore)"], ["debt", "A debt payment"], ["income", "Income"]];
  const EVERY = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 };
  const DAYS = { weekly: 7, monthly: 30.4, quarterly: 91, yearly: 365 };

  let users = [], data = null, advice = null, months = 12, owner = "";

  async function load() {
    try {
      const q = new URLSearchParams({ months: String(months), ...(owner ? { owner } : {}) });
      const [u, r, a] = await Promise.all([users.length ? null : fetch("/users"), fetch(`/audit?${q}`), fetch(`/audit/advice${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`)]);
      if (u?.ok) users = await u.json();
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
      data = await r.json();
      advice = a.ok ? await a.json() : null;                   // the page still works without it
    } catch (e) {
      main.innerHTML = `<div class="abc-msg abc-err">Couldn't load the audit: ${esc(e.message)}</div>`;
      return;
    }
    render();
  }

  /** Per month: income (positive), spending, saving, debt payments, fees, and spending by category. */
  function monthly() {
    const by = new Map(data.months.map(m => [m, { income: 0, spend: 0, saving: 0, debt: 0, fees: 0, cats: {} }]));
    for (const t of data.totals) {
      const m = by.get(t.month);
      if (!m) continue;
      if (t.bucket === "income") m.income -= t.cents;
      else if (t.bucket === "spend") { m.spend += t.cents; m.cats[t.category] = (m.cats[t.category] ?? 0) + t.cents; if (t.category === "BANK_FEES" || t.category === "INTEREST") m.fees += t.cents; }
      else if (t.bucket === "saving") m.saving += t.cents;
      else if (t.bucket === "debt") m.debt += t.cents;
    }
    return by;
  }

  const width = () => Math.max(260, Math.min(main.clientWidth || 640, 940) - 2);

  function render() {
    const by = monthly();
    const thisMonth = data.today.slice(0, 7);
    // Where the history really starts: the first month with at least 40% of the busiest month's
    // transactions (and 5), as the advice judges (src/audit/rules.ts). An account linked with a longer
    // history (a card's annual fee from last January), or a first month partly before the bank was
    // linked, would dilute every average.
    const count = new Map(data.months.map(m => [m, 0]));
    for (const t of data.totals) if (count.has(t.month)) count.set(t.month, count.get(t.month) + t.n);
    const most = Math.max(0, ...count.values());
    const firstData = data.months.find(m => most && count.get(m) >= Math.max(5, most * 0.4)) ?? null;
    const all = firstData ? data.months.filter(m => m >= firstData) : data.months;    // the charts start there too
    const full = all.filter(m => m !== thisMonth);                                    // whole months, for averages
    const sum = (ms, k) => ms.reduce((s, m) => s + by.get(m)[k], 0);
    let html = `<div class="cfa-top">
      ${users.length > 1 ? `<select id="cfaOwner" aria-label="Person"><option value="">Everyone</option>${users.map(u => `<option value="${esc(u.key)}"${u.key === owner ? " selected" : ""}>${esc(u.label)}</option>`).join("")}</select>` : ""}
      <div class="bill-ranges cfa-ranges" role="group" aria-label="How far back">${[12, 24].map(n => `<button type="button" data-months="${n}" aria-pressed="${n === months}">${n} months</button>`).join("")}</div>
      <button type="button" class="pill cfa-print" data-act="print" title="Print, or save as a PDF, a dated copy of this audit">Print the audit</button>
      <span class="cfa-when">${data.refreshed_at ? `Totals as of ${esc(new Date(data.refreshed_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}` : ""}${data.pending_rebuild ? " · a correction is being applied (within about 10 minutes)" : ""}</span>
    </div>`;
    if (!firstData) {
      main.innerHTML = html + `<p class="abc-msg">The audit fills in after the next hourly sync: it adds up your transactions by month, then shows them here.</p>`;
      return;
    }

    html += `<p class="cfa-printed">Complete financial audit${owner ? ` · ${esc(users.find(u => u.key === owner)?.label ?? owner)}` : ""} · ${esc(dayYear(data.today))}</p>`;
    html += adviceHtml();

    // 1. Cash flow
    const inc = sum(full, "income"), sp = sum(full, "spend"), sv = sum(full, "saving"), dt = sum(full, "debt");
    const kept = inc - sp - dt, rate = inc > 0 ? kept / inc : null;
    const rates = all.map(m => { const x = by.get(m); return m === thisMonth || m < firstData || x.income <= 0 ? null : Math.round(((x.income - x.spend - x.debt) / x.income) * 1000) / 10; });
    const recent = rates.slice(-4, -1).filter(v => v !== null), before = rates.slice(0, -4).filter(v => v !== null);
    const avg = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    const flow = [{ name: "Money in", cls: "income", values: all.map(m => by.get(m).income) },
                  { name: "Spending", cls: "spend", values: all.map(m => by.get(m).spend) },
                  { name: "Saving & investing", cls: "saving", values: all.map(m => by.get(m).saving) }];
    const rateChart = rates.filter(v => v !== null).length >= 2
      ? `<h4>Savings rate by month</h4>${C().lines({ labels: all, series: [{ name: "Savings rate", cls: "rate", values: rates }], width: width(), height: 150, fmt: v => `${v}%`, short: monLabel, dots: true })}` : "";
    html += section("Cash flow", C().legend(flow) + C().bars({ labels: all, series: flow, width: width(), fmt: short, short: monLabel }) + rateChart,
      [`Over ${full.length} full month${full.length === 1 ? "" : "s"}: ${money(inc)} came in, ${money(sp)} went to spending${dt ? `, ${money(dt)} to loan payments` : ""}, and ${money(sv)} moved to savings and investments.`,
       rate === null ? "No money in seen for this view, so no savings rate." :
       rate < -1 ? `More went out than came in: ${money(-kept)} over ${full.length} months.${users.length > 1 && owner ? " If this person's income arrives in someone else's account, look at Everyone." : ""}` :
         `You kept <b>${pct(rate)}</b> of what came in (the savings rate: money in, less spending and loan payments). ${rate >= 0.2 ? "That's at or above the 15–20% planners usually suggest." : rate >= 0.1 ? "Planners usually suggest 15–20%." : `Planners usually suggest 15–20%; reaching 15% would mean keeping about ${money(Math.max(0, 0.15 * inc - kept) / Math.max(1, full.length))} more a month.`}`,
       recent.length && before.length ? `Lately (the last ${recent.length} months) it's ${Math.round(avg(recent))}%, ${avg(recent) >= avg(before) ? "up" : "down"} from ${Math.round(avg(before))}% before.` : null]);

    // 2. Spending by category: each one's last 3 full months against its own average.
    const last3 = full.slice(-3);
    const cats = [...new Set(full.flatMap(m => Object.keys(by.get(m).cats)))].map(c => {
      const a = full.reduce((s, m) => s + (by.get(m).cats[c] ?? 0), 0) / full.length;
      const l = last3.reduce((s, m) => s + (by.get(m).cats[c] ?? 0), 0) / (last3.length || 1);
      return { c, a, l, up: full.length >= 6 && l >= a * 1.2 && l - a >= 5000 };
    }).filter(x => Math.abs(x.a) >= 100).sort((x, y) => y.a - x.a);
    const top = Math.max(...cats.map(x => Math.max(x.a, x.l)), 1);
    const rising = cats.filter(x => x.up);
    html += section("Spending by category", `<div class="cfa-cats">${cats.map(x => `<div class="cfa-cat${x.up ? " up" : ""}">
        <span class="cfa-cat-name">${esc(catName(x.c))}</span>
        <span class="cfa-cat-bar"><i style="width:${Math.max(0, (x.a / top) * 100).toFixed(1)}%"></i><b style="left:${Math.max(0, Math.min(100, (x.l / top) * 100)).toFixed(1)}%" title="Last 3 months: ${esc(money(x.l))} a month"></b></span>
        <span class="cfa-cat-num">${money(x.a)}<small>/mo</small>${x.up ? `<em>▲ ${pct(x.l / x.a - 1)}</em>` : ""}</span></div>`).join("")}</div>
      <p class="cfa-key"><i></i> average a month over ${full.length} months <b></b> the last ${last3.length}</p>`,
      [rising.length ? rising.map(x => `<b>${esc(catName(x.c))}</b> is up ${pct(x.l / x.a - 1)} lately: ${money(x.l)} a month against ${money(x.a)} on average (${money(x.l - x.a)} a month more).`).join(" ")
        : full.length >= 6 ? "No category is running well above its own average lately." : "Rising categories are flagged once there are 6 full months to compare with.",
       cats.find(x => x.c === "CREDITS") ? `Card credits gave back ${money(-cats.find(x => x.c === "CREDITS").a)} a month on average.` : null]);

    // 3. Recurring charges
    const rec = data.recurring.map(r => {
      const amount = r.distinct_amounts <= 2 ? r.last_cents : r.avg_cents;
      const ended = (Date.parse(data.today) - Date.parse(r.last_date)) / 864e5 > DAYS[r.cadence] * 1.6;
      const rise = r.distinct_amounts <= 3 && r.prev_cents && r.last_cents > r.prev_cents * 1.03;
      return { ...r, amount, yearly: amount * EVERY[r.cadence], ended, rise };
    }).sort((a, b) => (a.ended - b.ended) || b.yearly - a.yearly);
    const live = rec.filter(r => !r.ended && (r.corrected ?? "spend") === "spend");
    const isBill = r => r.category === "RENT_AND_UTILITIES" || r.category === "LOAN_PAYMENTS";
    const bills = live.filter(isBill), subs = live.filter(r => !isBill(r));
    const yearOf = rs => rs.reduce((s, r) => s + r.yearly, 0);
    html += section("Recurring charges", rec.length ? `<table class="cfa-rec"><thead><tr><th>Charge</th><th>How often</th><th>Usually</th><th>A year</th><th>Last</th><th>Counts as</th></tr></thead><tbody>` +
      rec.map(r => `<tr class="${r.ended ? "ended" : ""}">
        <td>${esc(r.name || r.merchant)}${users.length > 1 && !owner ? `<small>${esc(users.find(u => u.key === r.owner)?.label ?? r.owner)}</small>` : ""}${r.rise ? `<small class="rise">Went up from ${money(r.prev_cents)} to ${money(r.last_cents)}</small>` : ""}${r.ended ? "<small>No charge lately: maybe ended</small>" : ""}</td>
        <td data-l="How often">${r.cadence}</td><td data-l="Usually">${money(r.amount)}</td><td data-l="A year">${r.ended ? "—" : money(r.yearly)}</td><td data-l="Last">${dayLabel(r.last_date)}</td>
        <td><select data-merchant="${esc(r.merchant)}" aria-label="What ${esc(r.name || r.merchant)} counts as">${BUCKETS.map(([b, l]) => `<option value="${b}"${(r.corrected ?? "spend") === b ? " selected" : ""}>${l}</option>`).join("")}</select></td>
      </tr>`).join("") + `</tbody></table>` : `<p class="cfa-muted">None found yet: a charge needs to repeat (3 times monthly, or twice a year apart) to show here.</p>`,
      [bills.length ? `Rent and utilities: ${bills.length} bill${bills.length === 1 ? "" : "s"}, about ${money(yearOf(bills))} a year.` : null,
       subs.length ? `Subscriptions and memberships: ${subs.length}, about <b>${money(yearOf(subs))} a year</b>. Worth a look once a year: which do you still use?` : null,
       rec.filter(r => r.rise && !r.ended).map(r => `${esc(r.name || r.merchant)} went up ${pct(r.last_cents / r.prev_cents - 1)}.`).join(" ") || null,
       "A deposit to an account Minty doesn't see (a brokerage, a 401(k)) shows here as spending: set it to Saving, and the audit counts it as saving."]);

    // 4. Fees, interest and debt
    const fees = sum(full, "fees"), debtSeries = [{ name: "Fees & interest", cls: "fees", values: all.map(m => by.get(m).fees) },
                                                 { name: "Loan payments", cls: "debt", values: all.map(m => by.get(m).debt) }];
    const owed = data.cards.reduce((s, c) => s + Math.max(0, c.balance ?? 0), 0);
    const anyDebt = debtSeries.some(s => s.values.some(v => v));
    html += section("Fees, interest and debt", (anyDebt ? C().legend(debtSeries) + C().bars({ labels: all, series: debtSeries, width: width(), height: 160, fmt: short, short: monLabel }) : "") +
      (data.cards.length ? `<div class="cfa-cards">${data.cards.filter(c => (c.balance ?? 0) > 0).sort((a, b) => b.balance - a.balance).map(c => `<span>${esc(c.name || "Card")}${c.mask ? ` ••${esc(c.mask)}` : ""} <b>${money(c.balance)}</b></span>`).join("")}</div>` : ""),
      [fees > 0 ? `You paid <b>${money(fees)}</b> in fees and interest over ${full.length} months (annual fees included). Card interest is usually the one worth ending first: paying off the highest-rate balance first saves the most.` : "No fees or interest charged in this period.",
       owed ? `Cards owe ${money(owed)} today. Paid in full by each due date, that costs nothing.` : null]);

    // 5. Net worth
    const nw = data.net_worth;
    if (nw.length >= 2) {
      const ds = nw.map(r => r.date), series = [{ name: "Net worth", cls: "net", values: nw.map(r => r.assets - r.debts) },
                                                { name: "Accounts hold", cls: "assets", values: nw.map(r => r.assets) },
                                                { name: "Owed", cls: "debts", values: nw.map(r => r.debts) }];
      const ch = series[0].values.at(-1) - series[0].values[0];
      html += section("Net worth", C().legend(series) + C().lines({ labels: ds, series, width: width(), fmt: short, short: dayLabel, gap: 72 }),
        [`Net worth is <b>${money(series[0].values.at(-1))}</b>, ${ch >= 0 ? "up" : "down"} ${money(Math.abs(ch))} since ${dayYear(ds[0])}.`,
         "It counts bank and investment accounts Minty sees, less what cards and loans owe; homes, cars and accounts not linked aren't in it."]);
    } else {
      const now = nw[0];
      html += section("Net worth", `<p class="cfa-big">${now ? money(now.assets - now.debts) : "—"}</p>`,
        [now ? `History starts ${dayYear(now.date)}: the line fills in day by day from here.` : "It starts with the next hourly sync."]);
    }

    html += checklistHtml();

    // 6. Corrections, and the fine print
    html += `<section class="cfa-sec"><h3>Your corrections</h3>
      ${data.corrections.length ? `<ul class="cfa-corr">${data.corrections.map(c => `<li><b>${esc(c.merchant)}</b> counts as ${esc(BUCKETS.find(([b]) => b === c.bucket)?.[1] ?? c.bucket)} <button type="button" class="abc-link" data-uncorrect="${esc(c.merchant)}">Undo</button></li>`).join("")}</ul>` : `<p class="cfa-muted">None yet. Minty sorts each transaction itself; correct a merchant here when it guessed wrong.</p>`}
      <form class="cfa-addcorr"><input name="merchant" maxlength="80" placeholder="Merchant, as on the dashboard" required aria-label="Merchant"><select name="bucket" aria-label="Counts as">${BUCKETS.map(([b, l]) => `<option value="${b}">${l}</option>`).join("")}</select><button type="submit" class="pill">Save</button><span class="cfa-err" role="status"></span></form>
    </section>
    <p class="bill-fine">Educational, not financial advice: Minty isn't a CFP, CFA or registered advisor. The suggestions above are rules of thumb with the arithmetic shown; you decide. How it sorts: money in is income; a move between your own accounts is ignored, or counts as saving when it goes into savings or investments; card payments are ignored, because the purchases already count. Retirement accounts come with EGG.</p>`;
    main.innerHTML = html;
  }

  const AREA = { saving: "Saving", spending: "Spending", debt: "Debt", retirement: "Retirement", investing: "Investing" };
  /** What to do: the rules' findings (src/audit/rules.ts), most urgent first, then by dollars a year. */
  function adviceHtml() {
    if (!advice) return "";
    const f = advice.findings;
    const todo = f.filter(x => x.level !== "good"), good = f.filter(x => x.level === "good");
    const sum = todo.reduce((s, x) => s + (x.yearly_cents ?? 0), 0);
    return `<section class="cfa-sec cfa-advice"><h3>What to do</h3>
      ${todo.length ? `<p class="cfa-muted">${todo.length} thing${todo.length === 1 ? "" : "s"} worth a look${sum ? `, about <b>${money(sum)} a year</b> where there's a number for it` : ""}. Each one shows what it was worked out from.</p>` : `<p class="cfa-muted">Nothing that needs doing stands out.</p>`}
      ${todo.map(x => `<div class="cfa-rec-item ${esc(x.level)}">
        <div class="cfa-rec-head"><span class="cfa-tag">${esc(AREA[x.area] ?? x.area)}</span><b>${esc(x.title)}</b>${x.yearly_cents ? `<span class="cfa-yearly">${money(x.yearly_cents)} a year</span>` : ""}</div>
        <p>${esc(x.why)} <b>${esc(x.action)}</b></p>
        ${x.numbers.length || x.basis ? `<details><summary>How this was worked out</summary><ul>${x.numbers.map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join("")}</ul>${x.basis ? `<p class="cfa-muted">${esc(x.basis)}</p>` : ""}</details>` : ""}
      </div>`).join("")}
      ${good.map(x => `<p class="cfa-good">✓ ${esc(x.title)}: ${esc(x.why)}</p>`).join("")}
    </section>`;
  }

  function checklistHtml() {
    if (!advice) return "";
    const items = advice.checklist, due = items.filter(i => i.due).length;
    return `<section class="cfa-sec cfa-check"><h3>A planner's checklist</h3>
      <p class="cfa-muted">What the numbers can't show. ${due ? `${due} of ${items.length} to look at` : "All looked at"}; each comes back a year after you tick it.</p>
      ${items.map(i => `<label class="cfa-check-item${i.due ? "" : " done"}"><input type="checkbox" data-check="${esc(i.id)}"${i.due ? "" : " checked"}>
        <span><b>${esc(i.title)}</b>${i.link ? ` <a href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">how</a>` : ""}<small>${esc(i.why)}${i.checked_on ? ` Last checked ${esc(dayYear(i.checked_on))}.` : ""}</small></span></label>`).join("")}
    </section>`;
  }

  function section(title, body, findings) {
    const f = findings.filter(Boolean);
    return `<section class="cfa-sec"><h3>${title}</h3>${body}${f.length ? `<div class="cfa-find">${f.map(x => `<p>${x}</p>`).join("")}</div>` : ""}</section>`;
  }

  async function correct(merchant, bucket) {
    const r = await fetch("/audit/buckets", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ merchant, bucket }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
  }

  main.addEventListener("click", async e => {
    const m = e.target.closest("[data-months]");
    if (m) { months = Number(m.dataset.months); return load(); }
    if (e.target.closest('[data-act="print"]')) return window.print();
    const u = e.target.closest("[data-uncorrect]");
    if (u) { try { await correct(u.dataset.uncorrect, null); } catch (err) { alert(err.message); } return load(); }
  });
  main.addEventListener("change", async e => {
    if (e.target.id === "cfaOwner") { owner = e.target.value; return load(); }
    const ck = e.target.closest("input[data-check]");
    if (ck) {
      const r = await fetch("/audit/checklist", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: ck.dataset.check, checked: ck.checked }) });
      if (!r.ok) alert((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      return load();
    }
    const s = e.target.closest("select[data-merchant]");
    if (s) { try { await correct(s.dataset.merchant, s.value === "spend" ? null : s.value); } catch (err) { alert(err.message); } return load(); }
  });
  main.addEventListener("submit", async e => {
    const form = e.target.closest("form.cfa-addcorr");
    if (!form) return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try { await correct(f.merchant, f.bucket); load(); } catch (err) { form.querySelector(".cfa-err").textContent = err.message; }
  });

  let resizing = 0;
  window.addEventListener("resize", () => { clearTimeout(resizing); resizing = setTimeout(() => { if (dialog.open && data) render(); }, 150); });

  function open() {
    if (!dialog.open) dialog.showModal();
    load();
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-open-cfa]")) { e.preventDefault(); open(); }
  });
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });   // a click on the backdrop
  if (new URLSearchParams(location.search).has("audit")) open();
})();
