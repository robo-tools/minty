# Automatic updates for this fork

This fork keeps its Bills features while merging updates from `rg-code/minty`.
The **Stay up to date** workflow checks upstream every Monday at 06:37 UTC.
Compatible updates pass through automatically; conflicts and failed checks stop the update.

## What happens

1. Read the current fork `main` and upstream `main`.
2. If upstream is already included, finish without a new commit or deployment.
3. Create a normal merge commit, retaining both histories and the fork's features.
   Both author and committer use the fork's `robo-tools` identity.
4. Check for workflow/updater changes, changes to existing database migrations,
   overlapping migration numbers, or migrations that would run out of order.
5. Save the exact candidate as an immutable Git bundle. In a separate read-only job,
   run the auth-template check, updater tests, TypeScript check, full Worker suite,
   and demo build. No Plaid credentials, live database, or Cloudflare token is supplied.
6. In a fresh publishing job, check the bundle hash, merge parents, identity, protected
   files, and migrations again. Publish only if fork `main` is still the tested base.
   The publisher executes only the original fork helper, never candidate code.
7. Push the tested merge to `main` with an ordinary fast-forward push. The existing
   Cloudflare Workers Builds integration handles deployment from that branch.

The workflow uses GitHub's short-lived built-in token. No personal access token or
additional cloud credentials are needed. Only the final job has repository write
permission. Checkout never leaves Git credentials available to candidate scripts.
GitHub does not start another push-triggered Actions run for this token's push, so
the updater runs the complete required checks itself before publication.

## Activation and testing

This workflow replaces the old `gh repo sync` updater. It becomes active only after
the workflow **and helper/tests** are merged into this fork's `main`, with Actions
enabled. Keep the pending Bills changes on the feature branch/private preview until
their release review is complete. An updater on `main` cannot preserve features that
have not yet been merged there.

On GitHub, open **Actions → Stay up to date → Run workflow**, choose `main`, and leave
**Push the tested update to main** unchecked for a validation-only run. A successful
test-only run does not change the branch or deploy anything. Checking that box permits
publication after all checks pass. Scheduled runs publish automatically.

Activation can therefore lead to automatic production deployments on later Mondays.
Do it as part of the approved release, not while the feature is still under private review.
The workflow does not create or mark any feature PR ready, merge the pending Bills PR,
apply remote migrations itself, or change Cloudflare settings.

## When an update needs attention

- A merge conflict: resolve the specific conflict while keeping the fork's behavior.
- Failed tests, typecheck, or demo build: fix the incompatibility before merging.
- Workflow or updater changes: review these manually. The default GitHub token also
  cannot freely update workflow files. Do not add a broadly privileged token just to
  bypass this review.
- Migration collisions or ordering changes: review the upgrade path for an existing
  database, not only a fresh installation. Never casually rename or edit an already
  applied migration to make the updater pass.
- `main` moved during testing: rerun against its new contents. Nothing is force-pushed.
- A branch rule rejects the push: retain the rule and use a reviewed update PR, or
  deliberately redesign the updater around the rule. Do not disable protections as a retry.

The Actions run summary explains where it stopped. Enable GitHub Actions failure
notifications for this repository if email is wanted; the workflow does not configure
notifications or send its own messages. Tests reduce regression risk but cannot prove
every future upstream change is compatible with real bank behavior.

## Local checks

```sh
node --test scripts/upstream-sync.test.mjs
npm run typecheck
npm test
npm run build:demo
```

Updater tests use disposable local Git repositories and local remotes with fictitious
files. They cover preserving divergent fork changes, merge identity, conflicts, bundle
tampering, concurrent pushes, protected files, and migration collisions/order.
