# Set up Minty for your household

**New here? The one-page version is [GET-STARTED.md](GET-STARTED.md).** This page has the detail.

Minty puts your household's bank and card transactions on one private dashboard. You run your
**own copy**, on your own free accounts. Nobody else, including whoever shared this repo, can
see your data or your keys.

It takes about 30–45 minutes, and most of that is Plaid's sign-up. You don't need a server:
everything below is done in a web browser, apart from one command to make a key (step 4).

**What it costs:** $0. It uses the free plans of GitHub, Cloudflare (Workers, D1, Access) and
Plaid (Trial). Plaid's Trial covers **10 bank logins per Plaid account**.

You'll need:

- A GitHub account
- A Cloudflare account (free): https://dash.cloudflare.com/sign-up
- A Plaid account (free Trial, US/Canada banks): https://dashboard.plaid.com/signup
  Plaid asks you to verify your identity; approval is usually quick.

---

## 1. Copy the code (fork)

1. Open https://github.com/rg-code/minty and click **Fork** → **Create fork**.
   Keep the name `minty`.

Use a fork, not a download: it's how you get updates later (step 9). Then, in the fork's
**Actions** tab, click **I understand my workflows, go ahead and enable them**, so your copy
updates itself every week.

## 2. Deploy it to Cloudflare

1. In the Cloudflare dashboard: **Workers & Pages** → **Create** → **Import a repository**.
2. Connect GitHub and pick your fork `minty`.
3. Settings:
   - **Project name:** `minty` (it must match, or the build fails)
   - **Build command:** leave empty
   - **Deploy command:** replace the default `npx wrangler deploy` with `npm run deploy`. Note it's
     **npm**, not npx: `npx run deploy` fails.
   - **Non-production branch deploy command** (`npx wrangler preview`): leave it as it is.
   - There's no production-branch option on this screen. It uses your repo's default branch
     (`main`); you can check it later under **Settings → Builds → Branch control**.
4. Click **Deploy**. The first deploy creates the database (`minty`) and sets it up. That takes a
   minute or two, and the log ends with "Success! Build completed."
5. Open the Worker's `…workers.dev` address. You should see the dashboard page, with no data yet.
   (Preview URLs are switched off automatically on every deploy; Minty doesn't use them.)

Until step 3 is done, the page loads but every data request is refused. That's deliberate: Minty
refuses everything until the login is set up.

## 3. Lock it to your household (Cloudflare Access)

1. Open **Workers & Pages → minty → Access** (a tab along the top of the Worker) and enable
   Access for **All traffic**. (If asked, set up Zero Trust on the free plan. It's free for up
   to 50 people.)
2. **Authentication policy:** pick who may sign in. The list offers pre-configured policies:
   - **Cloudflare Account**: members of your Cloudflare account (you). Always safe.
   - **Specific emails** (recommended for anyone else): **Zero Trust → Access → Policies → Add →
     Include → Emails**, list each address, then attach it to the minty app.
   - **An email domain**: *anyone* with an address at that domain. Avoid it: every address
     there, now or later, could sign in. If you use one anyway, the domain must be yours and
     you the only one reading its mail.
   - **Never** choose "Everyone" or a public domain like gmail.com.

   Everyone you admit is fully trusted: they see every person's data and can link and
   reconnect banks (README, Security model). While you're in the Access app, a shorter
   **session duration** (e.g. 24 hours) limits what a stolen session is worth, and if your
   sign-in method supports it, require MFA.
3. Copy the **AUD tag** (a long hex string) that the Access tab shows. Then find your **team
   domain**: open your Minty address in a private window. The sign-in page's address starts
   with `https://<team>.cloudflareaccess.com`, and that host is the team domain.
4. **Settings → Variables and secrets** (the runtime section, *not* the build variables under
   Builds) → **Add**. Environment **Production**. For each row, put the name in **Key** and
   the value in **Value**, leave **Secret unchecked**, and use **+ Add** for the next row:
   - `ACCESS_TEAM_DOMAIN` = the team domain, e.g. `yourteam.cloudflareaccess.com`
   - `ACCESS_AUD` = the AUD tag
   - `ALLOWED_LOGINS` = the exact email address(es) you'll sign in with, comma-separated. It's
     optional but recommended: Minty itself refuses anyone else, even if an Access policy is
     broader than you meant. Each address must also pass the Access policy.

   Then **Deploy**.

Open your Minty address in a private window. You'll be asked for your email and sent a one-time
code, and then the dashboard loads.

## 4. Create the encryption key

Minty encrypts each bank connection's Plaid access token before storing it. In the same
**Variables and secrets** screen, add a variable named `TOKEN_ENC_KEY` with **Secret checked**.

Make a new key with one of these, and paste the result as the value:

- macOS / Linux / Git Bash: `openssl rand -base64 32 | tr '+/' '-_'`
- Windows PowerShell:
  `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).Replace('+','-').Replace('/','_')`

> **Store this key carefully, in a password manager. There is no recovery, by design.** Nobody
> has a copy: not Minty, not Cloudflare (a secret can't be read back once saved), not Plaid. If
> it's lost, the stored bank connections can't be decrypted, so Minty can't sync them, and every
> bank has to be linked again. Each new link uses another of Plaid's 10 Trial logins, and a
> removed or abandoned one doesn't give its login back. Transactions already saved stay.
> Don't just replace `TOKEN_ENC_KEY` once banks are linked, for the same reason. To change it,
> follow [Changing the encryption key](#changing-the-encryption-key): the old key keeps working
> until every connection is moved to the new one.

## 5. Get Plaid keys

1. In the Plaid dashboard: **Developers → Keys**. Copy the **client_id** and the **Production**
   secret. (The Sandbox secret works for testing with Plaid's fake banks.)
2. In **Variables and secrets**, add these, each with **Secret checked**:
   - `PLAID_CLIENT_ID_ME_PRIMARY` = client_id
   - `PLAID_SECRET_ME_PRIMARY` = secret
3. When you're using the Production secret, add a **Text** variable `PLAID_ENV` = `production`.
   Without it, Minty uses Plaid's Sandbox (test banks).

**Tried Sandbox first?** Test banks don't work once you switch to production, so delete them
before linking real ones. Go to **Storage & Databases → D1 → minty → Console**. Check what's there
with `SELECT id, institution_name, created_at FROM items;`, then run:

```sql
DELETE FROM transaction_tags;
DELETE FROM transactions;
DELETE FROM accounts;
DELETE FROM sync_pages;
DELETE FROM items;
```

This removes every linked bank and its transactions and tags, and nothing else. Only do it while
everything linked is a test bank.

**More than one Plaid account per person.** Each Plaid Trial allows 10 bank logins, where one
login covers every account at that bank, dormant ones included. Minty gives each person two
slots, `primary` then `backup`: add `PLAID_CLIENT_ID_ME_BACKUP` / `PLAID_SECRET_ME_BACKUP` (from a
second Plaid account), and new links move to backup automatically once primary is full. For
more, add a **Text** variable `PLAID_SLOTS` listing them in order, e.g.
`primary,backup,extra1`, plus that slot's two secrets (`…_ME_EXTRA1`).
- Slots without keys are skipped, so each person can have a different number.
- Keep a slot in the list once it has banks: they stay with the Plaid account they were linked
  under.
- Removing a bank doesn't give its Trial login back.

**Your name, or more people:** Minty starts with one person, "Me". To use your name, or to add
a partner or family members, open **+ Add user** on the dashboard. It generates the exact
`MINTY_USERS` value (e.g. `me:Alex,sam:Sam`) and the secret names to add. Each extra person
signs up for their own Plaid account (each Plaid Trial allows 10 bank logins) and gets their
own `PLAID_CLIENT_ID_<KEY>_PRIMARY` / `PLAID_SECRET_<KEY>_PRIMARY`. With two or more people, the
dashboard gets a person switch: **Combined** plus each name.

## 6. Check the setup

Open **+ Add user** on your dashboard. The **Setup checks** list shows what's working and what's
still missing, with the fix for each item. Every line should show ✓, apart from the expected
"Plaid: sandbox" while you're testing.

## 7. Connect your banks

Open **+ Add account**, choose whose account it is, and click **Connect with Plaid**. You sign in
to your bank inside Plaid's window; Minty never sees your bank password.

The first transactions arrive within a minute. On the free plan, the full history (up to 24
months) then fills in about a hundred transactions per hourly sync, so a busy account can
take a day or so. After that, each hourly sync is small. (On Workers Paid, $5/month, set the
variables `SYNC_MAX_BYTES_PER_RUN` = `20000000` and `SYNC_MAX_PAGES_PER_RUN` = `50`, and the
history arrives in an hour or two.) If a bank later needs you to sign in again, **+ Add account**
shows it with a **Reconnect** button.

## 8. Install it as an app (optional)

Minty installs to your phone's home screen or your computer's dock and opens full-screen,
like an app, with no app store.

- **Android:** use **Chrome**. The dashboard offers **Install** (or use Chrome's menu ⋮ →
  **Install app**). Samsung Internet and other phone makers' browsers build their own app
  package, which Google Play Protect blocks ("built for an older version of Android"). On those,
  Minty says so and offers **Open in Chrome** instead.
- **iPhone / iPad:** in Safari, tap **Share → Add to Home Screen**. The installed app keeps its
  own sign-in, separate from Safari, so you'll sign in once more there.
- **Computer:** in Chrome or Edge, use the install icon in the address bar, or the dashboard's
  **Install** button.

The app caches only Minty's pages and icons, never your transactions: data always comes from
your Cloudflare account. If a bank's sign-in (some use their own app or website) doesn't come
back to the installed app, link that bank from the browser instead.

## 9. Get updates

This customized fork's **Stay up to date** workflow merges upstream every Monday after it is
released to `main` and Actions are enabled. It preserves fork changes, tests the exact merge,
and pushes only after the checks pass. Cloudflare's existing integration redeploys from `main`.
The workflow is scoped to `robo-tools/minty`; it does not update the original repository.

- To check right away: **Actions → Stay up to date → Run workflow**, choosing `main`.
  Manual runs default to testing only. Check the publication option to push a passing merge.
- If a run fails, read its summary. Conflicts, changed workflows, and migration collisions
  stop for review. Do not use force-sync or discard this fork's custom features.
- GitHub pauses scheduled workflows in a repository with no activity for 60 days, and emails
  you. If that happens, re-enable it on the Actions tab, or sync by hand.
- Workflows not enabled? Enable Actions and review [Automatic fork updates](docs/fork-updates.md).

---

## Good to know

- **Privacy.** Your data lives only in your Cloudflare account's D1 database. Plaid keys and the
  encryption key are Cloudflare secrets: you can't read them back after saving, and they're
  never sent to the browser.
- **Never set `MINTY_DEV_NO_AUTH`.** It's a local development switch; Minty ignores it on a real
  address, but there's no reason to have it.
- **Sync** runs every hour (at :17 UTC). To get new data sooner, click the coin next to "minty" on the
  dashboard: it reloads at once and asks for a sync, which runs within 10 minutes.
- **Backups.** D1 keeps a point-in-time history (Time Travel) you can restore from:
  https://developers.cloudflare.com/d1/reference/time-travel/
- **Optional settings** (Text variables):
  - `ALLOWED_LOGINS`: extra allow-list of emails, on top of the Access policy.
  - `PLAID_REDIRECT_URI`: only needed for some banks when using Minty inside a phone app's
    built-in browser.
  - `TRIAL_ITEM_CAP`: defaults to 10.
  - `SYNC_MAX_BYTES_PER_RUN` / `SYNC_MAX_PAGES_PER_RUN`: how much each hourly sync does. The
    defaults (150000 / 10) fit the free plan's 10 ms CPU limit. On Workers Paid, raise them.
- **Something's wrong?** Check **+ Add user → Setup checks** first. Then look at
  **Workers & Pages → minty → Logs**, which show sync results by item number and never your
  data.

### Changing the encryption key

Do this if the key may have leaked, or just to change it now and then. Nothing has to be linked
again, and no Plaid Trial login is used.

1. Find the **current** key in your password manager (Cloudflare can't show it back to you).
2. In **Workers & Pages → minty → Settings → Variables and secrets**, add a **Secret** named
   `TOKEN_ENC_KEY_PREVIOUS` with the current key as its value. Do this first.
3. Make a new key (the same command as in [step 4](#4-create-the-encryption-key)), store it in
   your password manager, and set it as the new value of `TOKEN_ENC_KEY`.
4. Wait for the next hourly sync (:17 past the hour). Each bank connection is saved again under
   the new key. **+ Add user → Setup checks** counts the ones still on the old key, then says
   the old key isn't needed any more.
5. Delete `TOKEN_ENC_KEY_PREVIOUS`, and the old key from your password manager.

If you changed `TOKEN_ENC_KEY` without step 2, banks show "can't be decrypted with
TOKEN_ENC_KEY". Add the old key as `TOKEN_ENC_KEY_PREVIOUS` and they're picked up again at the
next hourly sync. If the old key is lost, those banks have to be linked again.

### If something leaks

- **The encryption key** (but not the database): [change it](#changing-the-encryption-key).
- **The database** (an export or a backup copy) but not the key: the bank connections in it
  are encrypted. Change the key anyway, so that copy stays unreadable even if the old key
  leaks later.
- **Both, or the Worker ran code you don't trust:** assume the Plaid access tokens are known.
  They only work together with your Plaid keys, so first make new Plaid secrets (Plaid dashboard
  → **Developers → Keys**) and update each `PLAID_SECRET_*` secret. Then change the encryption
  key. Also check your Cloudflare Access policy and Cloudflare API tokens.

### Using a terminal instead (optional)

From a clone of your fork, you can do the same with Wrangler:
`npx wrangler login`, then `npx wrangler secret put TOKEN_ENC_KEY` (and each Plaid secret), and
`npm run deploy`. Variables are easiest to set in the dashboard. `keep_vars` in `wrangler.jsonc`
makes sure deploys never overwrite them.

## Support Minty

All set? Minty is free and always will be. If it saves you time, you can support it on
[Ko-fi](https://ko-fi.com/mintyme). Entirely optional.
