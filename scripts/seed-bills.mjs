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
  {id:910000,owner:"me",bank:"Maple Bank",name:"Everyday Rewards",mask:"1042",balance:128455,limit:500000,statement:110825,minimum:3500,due:7,currency:"USD"},
  {id:910001,owner:"sam",bank:"Harbor Credit Union",name:"Travel Card",mask:"6604",balance:68931,limit:60000,statement:54218,minimum:2500,due:14,currency:"CAD",covered:true},
  {id:910002,owner:"me",bank:"Northstar Bank",name:"Cashback Card",mask:"1005",balance:41290,limit:null,statement:null,minimum:null,due:null,currency:"USD",incomplete:true},
  {id:910003,owner:"sam",bank:"Willow Bank",name:"Weekend Card",mask:"8291",balance:82000,limit:200000,statement:75000,minimum:2000,due:-3,currency:"USD",incomplete:true,stale:true},
  {id:910004,owner:"me",bank:"Cedar Bank",name:"Newly Linked Card",mask:"3418",balance:-2500,limit:400000,currency:"USD",disabled:true},
];
let transactionId=910000;
for (const c of cards) {
  const cardObserved=c.stale ? new Date(now.getTime()-48*3600000).toISOString() : observed;
  insert("items", {id:c.id,owner:c.owner,plaid_account:c.owner+"_primary",plaid_item_id:"local-bills-"+c.id,access_token_enc:"not-a-real-token",institution_name:c.bank,status:"demo",
    updated_at:observed,txn_cursor:"local-fixture-complete",transactions_update_status:c.incomplete ? "INITIAL_UPDATE_COMPLETE" : "HISTORICAL_UPDATE_COMPLETE",
    transactions_history_requested_start_date:day(-730),transactions_history_start_date:c.incomplete ? null : day(-730)});
  insert("accounts",{id:c.id,owner:c.owner,item_id:c.id,plaid_account_id:"local-bills-card-"+c.id,name:c.name,mask:c.mask,type:"credit",subtype:"credit card",
    balance_current_cents:c.balance,balance_available_cents:c.limit==null ? null : c.limit-c.balance,credit_limit_cents:c.limit,currency:c.currency,updated_at:observed});
  if (c.disabled) continue;
  // No next_attempt_at: fixtures cannot accidentally make a Plaid request.
  insert("liability_sync", {item_id:c.id,status:"ready",enabled_at:observed,synced_at:cardObserved});
  insert("card_liabilities", {id:c.id,item_id:c.id,plaid_account_id:"local-bills-card-"+c.id,name:c.name,mask:c.mask,currency:c.currency,current_balance_cents:c.balance,credit_limit_cents:c.limit,
    statement_balance_cents:c.statement,statement_issue_date:c.statement == null ? null : day(-16),minimum_payment_cents:c.minimum,
    payment_due_date:c.due == null ? null : day(c.due),last_payment_cents:c.covered ? c.statement : 20000,last_payment_date:day(-4),purchase_apr:19.99,is_overdue:0,observed_at:cardObserved});
  if (c.statement != null) for (let i=0;i<4;i++) insert("card_statements", {account_id:c.id,issue_date:day(-16-i*30),balance_cents:c.statement+i*4500,
    minimum_payment_cents:c.minimum,payment_due_date:day(c.due-i*30),currency:c.currency,first_seen_at:cardObserved,last_seen_at:cardObserved});
  const payment=(name,amount,offset,detail,confidence,pending=0,category="TRANSFER_IN")=>insert("transactions",{
    id:transactionId++,owner:c.owner,account_id:c.id,plaid_txn_id:`local-bills-txn-${transactionId}`,amount_cents:amount,currency:c.currency,date:day(offset),name,category,
    category_detailed:detail,category_confidence:confidence,pending});
  if (c.statement!=null) {
    payment("Payment received — thank you",c.covered ? -c.statement : -20000,-4,"LOAN_PAYMENTS_CREDIT_CARD_PAYMENT","VERY_HIGH",0,"LOAN_PAYMENTS");
    if (!c.covered) payment("Online payment",-15000,-8,null,null);
    payment("Maple Outfitters refund",-4500,-6,"GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES","HIGH",0,"GENERAL_MERCHANDISE");
    payment("Automatic payment",-2500,0,"LOAN_PAYMENTS_CREDIT_CARD_PAYMENT","HIGH",1,"LOAN_PAYMENTS");
    payment("Corner Market",6725,-2,"FOOD_AND_DRINK_GROCERIES","HIGH",0,"FOOD_AND_DRINK");
    payment("Last month's card payment",-50000,-24,"LOAN_PAYMENTS_CREDIT_CARD_PAYMENT","HIGH",0,"LOAN_PAYMENTS");
  }
}
for (const [i,name,amount,due,owner,currency] of [[0,"Electric bill",8450,4,"me","USD"],[1,"Rent",180000,17,"me","USD"],[2,"Internet",6500,12,"sam","CAD"],[3,"Water bill",4275,-2,"me","USD"]]) {
  insert("manual_bills", {id:910000+i,owner,name,amount_cents:amount,currency,due_date:day(due),recurrence:"monthly",anchor_day:Number(day(due).slice(-2))});
}
console.log(sql.join('\n'));
