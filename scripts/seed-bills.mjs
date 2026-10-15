// Fictitious local-only Bills fixtures. Prints SQL; never connects to Plaid or Cloudflare.
// Apply after local migrations. Reserved ids 910000–910099 are replaced on reruns.
const q = v => v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
const now = new Date(), observed = now.toISOString();
const day = offset => new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()+offset)).toISOString().slice(0,10);
const sql = [
  "DELETE FROM items WHERE plaid_item_id LIKE 'local-bills-%';",
  "DELETE FROM manual_bills WHERE id BETWEEN 910000 AND 910099;",
];
const insert = (table, row) => sql.push(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(q).join(',')});`);
const cards = [
  {id:910000, owner:"me", bank:"Maple Bank", name:"Everyday Rewards", mask:"1042", balance:128455, statement:110825, minimum:3500, due:7},
  {id:910001, owner:"sam", bank:"Harbor Credit Union", name:"Travel Card", mask:"6604", balance:68931, statement:54218, minimum:2500, due:19},
  {id:910002, owner:"me", bank:"Northstar Bank", name:"Cashback Card", mask:"1005", balance:41290, statement:null, minimum:null, due:null},
];
for (const c of cards) {
  insert("items", {id:c.id, owner:c.owner, plaid_account:c.owner+"_primary", plaid_item_id:"local-bills-"+c.id, access_token_enc:"not-a-real-token", institution_name:c.bank, status:"demo"});
  // No next_attempt_at: fixtures cannot accidentally make a Plaid request.
  insert("liability_sync", {item_id:c.id, status:"ready", enabled_at:observed, synced_at:observed});
  insert("card_liabilities", {id:c.id,item_id:c.id,plaid_account_id:"local-bills-card-"+c.id,name:c.name,mask:c.mask,currency:"USD",current_balance_cents:c.balance,
    statement_balance_cents:c.statement,statement_issue_date:c.statement == null ? null : day(-16), minimum_payment_cents:c.minimum,
    payment_due_date:c.due == null ? null : day(c.due), last_payment_cents:50000,last_payment_date:day(-24),purchase_apr:19.99,is_overdue:0,observed_at:observed});
  if (c.statement != null) for (let i=0;i<4;i++) insert("card_statements", {account_id:c.id,issue_date:day(-16-i*30),balance_cents:c.statement+i*4500,
    minimum_payment_cents:c.minimum,payment_due_date:day(c.due-i*30),currency:"USD",first_seen_at:observed,last_seen_at:observed});
}
for (const [i,name,amount,due,owner] of [[0,"Electric bill",8450,4,"me"],[1,"Rent",180000,17,"me"],[2,"Internet",6500,12,"sam"]]) {
  insert("manual_bills", {id:910000+i,owner,name,amount_cents:amount,currency:"USD",due_date:day(due),recurrence:"monthly",anchor_day:Number(day(due).slice(-2))});
}
console.log(sql.join('\n'));
