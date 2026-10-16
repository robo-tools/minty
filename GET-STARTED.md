# Get started with Minty

**No subscription. No ads. No tracking.**

Your central, private home for all your bank and card data. Only you can see or change it: it
lives in your own Cloudflare account, encrypted at rest, and your bank connections are encrypted
again with a key only you hold.

**About 10 minutes, all in a web browser, $0.**

More detail on any step: [SETUP.md](SETUP.md).

## 1. Make three free accounts

| Account | Sign up | What | Why |
|---|---|---|---|
| GitHub | https://github.com/signup | Only a repository for Minty's code. Your transactions, accounts and other information never touch GitHub | Holds your copy of Minty's code |
| Cloudflare | https://dash.cloudflare.com/sign-up | Your bank probably already uses it to serve you data | Runs Minty and stores your data |
| Plaid | https://dashboard.plaid.com/signup | You probably already use it: it handles the handshake between your banks and Minty | Connects to your banks (US/Canada). It checks your identity, usually quickly |

## 2. Copy Minty

1. Signed in to GitHub, open https://github.com/rg-code/minty/fork and click **Create fork**.
2. In your new fork, open the **Actions** tab and click **I understand my workflows, go ahead and
   enable them**. This lets your copy update itself every week (step 7).

## 3. Put it on Cloudflare

1. Open https://dash.cloudflare.com and go to **Workers & Pages → Create → Import a repository**.
2. Connect GitHub and pick **minty**.
3. Set **Deploy command** to `npm run deploy`. Leave everything else as it is.
4. Click **Deploy**, and wait for "Success" (a minute or two).

## 4. Lock it to you

1. Open **Workers & Pages → minty → Access**, turn Access on for **All traffic**, and choose the
   **Cloudflare Account** policy.
2. Copy the **AUD tag** it shows. Then open your Minty address (`…workers.dev`) in a private
   window: the sign-in page's address starts with `https://<team>.cloudflareaccess.com`. That
   host is your team domain.
3. Open **minty → Settings → Variables and secrets → Add** and add these three:

   | Name | Value | Type |
   |---|---|---|
   | `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` | Text |
   | `ACCESS_AUD` | the AUD tag | Text |
   | `ALLOWED_LOGINS` | your email address | Text |

## 5. Add your keys

1. **Encryption key.** Make one on your computer.

   > **Store this key carefully, in a password manager. There is no recovery, by design.**
   > Nobody (not Minty, Cloudflare or Plaid) has a copy, and Cloudflare won't show it again
   > after you save it. Lose it and Minty can't use your bank connections any more: you'd have
   > to link every bank again, which uses up more of Plaid's 10 free bank logins. Your saved
   > transactions stay.

   - Mac: open Terminal and run `openssl rand -base64 32 | tr '+/' '-_'`
   - Windows: open PowerShell and run
     `$b=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b);[Convert]::ToBase64String($b).Replace('+','-').Replace('/','_')`
2. **Plaid keys:** open https://dashboard.plaid.com/developers/keys and copy the **client_id**
   and the **Production** secret.
3. Add them in **Variables and secrets**, then click **Deploy**:

   | Name | Value | Type |
   |---|---|---|
   | `TOKEN_ENC_KEY` | the encryption key | Secret |
   | `PLAID_CLIENT_ID_ME_PRIMARY` | Plaid client_id | Secret |
   | `PLAID_SECRET_ME_PRIMARY` | Plaid Production secret | Secret |
   | `PLAID_ENV` | `production` | Text |

## 6. Connect your banks

1. Open your Minty address and sign in with your email (you'll get a one-time code). On a phone,
   Minty then offers to lock itself with Face ID or your fingerprint.
2. Click **+ Add user**: every line under **Setup checks** should show ✓. Each one that doesn't
   says how to fix it.
3. Click **+ Add account → Connect with Plaid**, and sign in to your bank in Plaid's window.
   Transactions start arriving within a minute.

## 7. Keep it up to date (optional)

This customized fork checks upstream **every Monday** once the updater is released to `main`
and Actions are enabled. Compatible updates are merged only after the tests, typecheck, and
demo build pass; Cloudflare then redeploys from `main`.

- **Want to check now?** **Actions → Stay up to date → Run workflow**, choosing `main`.
  Leave publication unchecked for a test-only run; check it to publish after validation.
- **Update stopped?** Read the failing run's summary. Conflicts, workflow changes, and database
  migration collisions need review. Do not force-sync away this fork's features.
- **Actions disabled?** Enable the workflow on GitHub. It is scoped to `robo-tools/minty`.

See [Automatic fork updates](docs/fork-updates.md) for the release and maintenance details.

## Later

- **Your name, or more people:** **+ Add user**.
- **Stuck?** Check **+ Add user → Setup checks**, then [SETUP.md](SETUP.md).
- **License:** use Minty unmodified, for personal or household use only: no changes, no
  redistribution, no commercial use. See [LICENSE](LICENSE).

---

**Have a home server and don't want Cloudflare?** There's an older, *untested* build of Minty
that runs in Docker (FastAPI + Postgres) and is reached privately over Tailscale:
[the `tailscale-selfhosted` branch](https://github.com/rg-code/minty/tree/tailscale-selfhosted)
(setup is in its README). It doesn't get updates, and the steps above don't apply to it.
