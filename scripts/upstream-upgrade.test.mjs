import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const directory = new URL('../d1/migrations/', import.meta.url);
const files = readdirSync(directory).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
const sql = file => readFileSync(new URL(file, directory), 'utf8');
const bridge = '0014_upstream_features.sql';
const old = files.filter(f => f < bridge);

test('upstream bridge preserves every existing row and foreign key', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const file of old) db.exec(sql(file));
    db.exec(`
      INSERT INTO items(id,owner,plaid_account,plaid_item_id,access_token_enc,txn_cursor,
        transactions_verified_start_date,transactions_verified_end_date,transactions_verified_at)
        VALUES(7,'me','me_primary','fixture-item','encrypted-fixture','saved-cursor','2026-08-01','2026-10-16','verified');
      INSERT INTO accounts(id,owner,item_id,plaid_account_id,name,type,credit_limit_cents)
        VALUES(31,'me',7,'fixture-account','Fixture Card','credit',500000);
      INSERT INTO transactions(id,owner,account_id,plaid_txn_id,amount_cents,date,name,category_detailed,category_confidence)
        VALUES(53,'me',31,'fixture-payment',-12000,'2026-10-09','Payment','LOAN_PAYMENTS_CREDIT_CARD_PAYMENT','VERY_HIGH');
      INSERT INTO transaction_tags(transaction_id,tag,position) VALUES(53,'Fixture tag',0);
      INSERT INTO liability_sync(item_id,status,enabled_at) VALUES(7,'ready','enabled');
      INSERT INTO card_liabilities(id,item_id,plaid_account_id,name,statement_balance_cents,statement_issue_date,observed_at)
        VALUES(91,7,'fixture-account','Fixture Card',12000,'2026-10-01','observed');
      INSERT INTO card_statements(id,account_id,issue_date,balance_cents,payment_due_date,first_seen_at,last_seen_at)
        VALUES(101,91,'2026-10-01',12000,'2026-10-25','first','last');
      INSERT INTO card_display_preferences(item_id,plaid_account_id,nickname,display_mask)
        VALUES(7,'fixture-account','Biz Plat','12345');
      INSERT INTO manual_bills(id,owner,name,amount_cents,currency,due_date,recurrence,anchor_day)
        VALUES(13,'me','Rent',50000,'USD','2026-11-01','monthly',1);
      INSERT INTO manual_bill_payments(bill_id,due_date,amount_cents,currency,marked_at)
        VALUES(13,'2026-10-01',50000,'USD','marked');
      INSERT INTO history_verifications(item_id,run_id,from_date,to_date,captured_cursor,captured_updated_at,
        captured_accounts,created_at,expires_at,status) VALUES(7,'run','2026-08-01','2026-10-16','saved-cursor','before','[]',1,999,'complete');
      INSERT INTO history_verification_seen(item_id,run_id,plaid_txn_id) VALUES(7,'run','fixture-payment');
    `);
    const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const before=tables.map(({name})=>{
      const columns=db.prepare(`PRAGMA table_info("${name}")`).all().map(c=>`"${c.name}"`).join(',');
      return {name,columns,rows:db.prepare(`SELECT ${columns} FROM "${name}"`).all()};
    });
    db.exec('BEGIN'); db.exec(sql(bridge)); db.exec('COMMIT');
    for(const {name,columns,rows} of before) assert.deepEqual(db.prepare(`SELECT ${columns} FROM "${name}"`).all(),rows,name);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('SELECT products FROM items WHERE id=7').get().products,'transactions');
    assert.equal(db.prepare('SELECT view FROM accounts WHERE id=31').get().view,null);
    assert.equal(db.prepare('SELECT account_id FROM card_statements WHERE id=101').get().account_id,91);
    for(const table of ['point_balances','monthly_totals','net_worth','investment_sync','holdings','investment_txns'])
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
  } finally { db.close(); }
});

test('fresh installation has one statement schema and all independent upstream tables', () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for(const file of files) db.exec(sql(file));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='statement_sync'").get().n,0);
    const foreign=db.prepare('PRAGMA foreign_key_list(card_statements)').all();
    assert.equal(foreign[0].table,'card_liabilities');
  } finally { db.close(); }
});
