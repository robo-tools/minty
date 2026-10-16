# Upstream integration

The October 2026 integration retains this fork's Bills & statements page, payment
classification, coverage verification, calendar, card names and separate statement cron.
Upstream's alternative Bills popup, statement schema and payment rules are not enabled.
The existing `/bills` URL remains an HTML page and its APIs remain under `/liabilities`
and `/manual-bills`.

Independent upstream improvements include points balances (BAM), the financial audit
(CFA), retirement accounts (EGG), enforced content security policy and encryption-key
rotation. Investment access remains opt-in; merging code does not grant Plaid consent.
The key-rotation helper also opens tokens used by the fork's statement fetching,
statement consent and history verification.

## Database upgrade

Applied migrations `0001` through `0013` are unchanged. Upstream introduced incompatible
tables under overlapping migration names, including a different `card_statements`
foreign key. Those files must not replace the fork's applied migrations.

`0014_upstream_features.sql` imports the independent schema changes from upstream
commit `72bfcd99e80320001f9eecd227926c7cd6ab0def`, in this order:

- `0012_point_balances.sql`
- `0013_audit.sql`
- `0014_audit_views.sql`
- `0015_investments.sql`

The fork's tables provide Bills functionality; upstream's redundant `0010` and `0011`
Bills changes are intentionally omitted. Each imported block is identified in the bridge.
The new tables start empty, and all existing Items default to transaction sync.
Existing cursors, tokens, transaction classifications, tags, statements, preferences,
manual payments and history verification stay in their original tables.

`node --test scripts/upstream-upgrade.test.mjs` checks both an existing database upgrade
and a fresh installation. The Worker suite checks routes, consent boundaries, key rotation,
and query budgets. These checks run before automatic upstream publication too.

## Later updates

The reviewed merge records upstream ancestry, so future updates start from this point.
Unchanged upstream migration files omitted here do not get reapplied by a normal merge.
Any future migration collision, edit to an applied migration, or change to competing Bills
code still needs review. Never use an automatic ours/theirs policy or force-sync to bypass it.
Use the upstream update workflow described in [fork-updates.md](fork-updates.md).
