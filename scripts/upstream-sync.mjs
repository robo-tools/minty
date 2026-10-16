#!/usr/bin/env node
// Trusted workflow helper. It never runs candidate code in a job with a write token.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IDENTITY = 'robo-tools <318782861+robo-tools@users.noreply.github.com>';
const REPOSITORY = 'robo-tools/minty';
const UPSTREAM_URL = 'https://github.com/rg-code/minty.git';
const CANDIDATE_REF = 'refs/heads/minty-upstream-candidate';
const SHA = /^[0-9a-f]{40}$/;
const identityEnv = {
  GIT_AUTHOR_NAME: 'robo-tools', GIT_COMMITTER_NAME: 'robo-tools',
  GIT_AUTHOR_EMAIL: '318782861+robo-tools@users.noreply.github.com',
  GIT_COMMITTER_EMAIL: '318782861+robo-tools@users.noreply.github.com',
};

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit(value) {
  if (!SHA.test(value || '')) throw new Error('Expected a full commit ID.');
  return value;
}
const files = (cwd, rev, path) => git(cwd, ['ls-tree', '-r', '--name-only', '-z', rev, '--', path]).split('\0').filter(Boolean);
const blob = (cwd, rev, path) => git(cwd, ['rev-parse', `${rev}:${path}`]);
const protectedPath = path => path.startsWith('.github/workflows/') || /^scripts\/upstream-sync(?:\.test)?\.mjs$/.test(path);

/** Inspect upstream too: a workflow edit cannot slip through because a merge kept ours. */
export function checkUpdateBoundaries(cwd, base, upstream, candidate) {
  [base, upstream, candidate].forEach(commit);
  const ancestor = git(cwd, ['merge-base', base, upstream]);
  for (const [from, to] of [[ancestor, upstream], [base, candidate]]) {
    const changed = git(cwd, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(Boolean);
    if (changed.some(protectedPath)) throw new Error('Upstream changes workflow or updater files. Review this update manually.');
  }
  const oldFiles = files(cwd, base, 'd1/migrations').filter(p => p.endsWith('.sql'));
  const newFiles = files(cwd, candidate, 'd1/migrations').filter(p => p.endsWith('.sql'));
  for (const path of oldFiles) {
    if (!newFiles.includes(path) || blob(cwd, base, path) !== blob(cwd, candidate, path))
      throw new Error('An existing database migration was changed or removed. Review the upgrade manually.');
  }
  const prefixes = new Map();
  let oldMax = -1;
  for (const path of oldFiles) {
    const match = /\/(\d{4})_[^/]+\.sql$/.exec(path);
    if (match) oldMax = Math.max(oldMax, Number(match[1]));
  }
  for (const path of newFiles) {
    const match = /^d1\/migrations\/(\d{4})_[^/]+\.sql$/.exec(path);
    if (!match) throw new Error('An unexpected migration filename needs manual review.');
    const number = Number(match[1]);
    if (prefixes.has(number)) throw new Error('Database migration numbers overlap between the fork and upstream. Review manually; do not rename applied migrations.');
    prefixes.set(number, path);
    if (!oldFiles.includes(path) && number <= oldMax)
      throw new Error('An upstream migration precedes already applied fork migrations. Review the upgrade order manually.');
  }
}

export function inspectCandidate(cwd, base, upstream, candidate) {
  [base, upstream, candidate].forEach(commit);
  if (git(cwd, ['show', '-s', '--format=%P', candidate]) !== `${base} ${upstream}`)
    throw new Error('Candidate is not the expected two-parent merge.');
  const identities = git(cwd, ['show', '-s', '--format=%an <%ae>%n%cn <%ce>', candidate]);
  if (identities !== `${IDENTITY}\n${IDENTITY}`) throw new Error('Merge author and committer must both be robo-tools.');
  checkUpdateBoundaries(cwd, base, upstream, candidate);
}

export function mergeCandidate(cwd, base, upstream) {
  [base, upstream].forEach(commit);
  git(cwd, ['checkout', '--detach', base]);
  // No force, squash, rebase, or automatic ours/theirs conflict resolution.
  try {
    git(cwd, ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m',
      `Merge upstream rg-code/minty at ${upstream.slice(0, 12)}`, upstream], identityEnv);
  } catch {
    const conflicts = git(cwd, ['diff', '--name-only', '--diff-filter=U']);
    git(cwd, ['merge', '--abort']);
    throw new Error(conflicts ? `Upstream conflicts with this fork; review these files manually:\n${conflicts}` : 'Could not create an upstream merge.');
  }
  const candidate = git(cwd, ['rev-parse', 'HEAD']);
  inspectCandidate(cwd, base, upstream, candidate);
  return candidate;
}

export function bundleHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function importCandidate(cwd, directory, expected) {
  const { base, upstream, candidate, sha256 } = expected;
  [base, upstream, candidate].forEach(commit);
  const path = resolve(directory, 'candidate.bundle');
  if (!/^[0-9a-f]{64}$/.test(sha256 || '') || bundleHash(path) !== sha256)
    throw new Error('Candidate bundle does not match the immutable prepared artifact.');
  git(cwd, ['bundle', 'verify', path]);
  if (git(cwd, ['bundle', 'list-heads', path]) !== `${candidate} ${CANDIDATE_REF}`)
    throw new Error('Unexpected bundle reference.');
  git(cwd, ['fetch', '--no-tags', path, CANDIDATE_REF]);
  inspectCandidate(cwd, base, upstream, candidate);
  return candidate;
}

/** Ordinary push also rejects a non-fast-forward race after the remote-base check. */
export function publishCandidate(cwd, base, upstream, candidate, authEnv = {}) {
  inspectCandidate(cwd, base, upstream, candidate);
  const remote = git(cwd, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], authEnv).split(/\s+/)[0];
  if (remote !== base) throw new Error('Main changed while tests ran. Run the updater again against the new main.');
  git(cwd, ['push', 'origin', `${candidate}:refs/heads/main`], authEnv);
}

function output(values) {
  for (const [key, value] of Object.entries(values)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== 'refs/heads/main')
    throw new Error('This helper runs only in this fork’s main-branch GitHub workflow.');
  const cwd = process.cwd(), [command, directory] = process.argv.slice(2);
  if (!directory) throw new Error('An artifact directory is required.');
  const remote = git(cwd, ['remote', 'get-url', 'origin']);
  if (![`https://github.com/${REPOSITORY}`, `https://github.com/${REPOSITORY}.git`].includes(remote))
    throw new Error('Origin is not the expected fork.');
  if (command === 'prepare') {
    if (git(cwd, ['status', '--porcelain'])) throw new Error('Preparation needs a clean checkout.');
    git(cwd, ['fetch', '--no-tags', 'origin', 'refs/heads/main']);
    const base = git(cwd, ['rev-parse', 'FETCH_HEAD']);
    if (base !== git(cwd, ['rev-parse', 'HEAD'])) throw new Error('Main moved after checkout; rerun the updater.');
    git(cwd, ['fetch', '--no-tags', UPSTREAM_URL, 'refs/heads/main']);
    const upstream = git(cwd, ['rev-parse', 'FETCH_HEAD']);
    if (git(cwd, ['merge-base', base, upstream]) === upstream) {
      output({ changed: 'false', base, upstream });
      summary('This fork already contains upstream main. No update or deployment was triggered.');
      return;
    }
    const candidate = mergeCandidate(cwd, base, upstream);
    mkdirSync(directory, { recursive: true });
    git(cwd, ['update-ref', CANDIDATE_REF, candidate]);
    const path = resolve(directory, 'candidate.bundle');
    git(cwd, ['bundle', 'create', path, CANDIDATE_REF, `^${base}`]);
    output({ changed: 'true', base, upstream, candidate, sha256: bundleHash(path) });
    summary(`Prepared merge \`${candidate}\` from fork \`${base}\` and upstream \`${upstream}\`. Main is unchanged until validation succeeds.`);
    return;
  }
  if (!['restore', 'publish'].includes(command)) throw new Error('Unknown updater command.');
  const expected = { base: process.env.BASE, upstream: process.env.UPSTREAM, candidate: process.env.CANDIDATE, sha256: process.env.BUNDLE_SHA256 };
  if (git(cwd, ['rev-parse', 'HEAD']) !== commit(expected.base)) throw new Error('Trusted checkout differs from the prepared base.');
  importCandidate(cwd, directory, expected);
  if (command === 'restore') {
    git(cwd, ['checkout', '--detach', expected.candidate]);
    return;
  }
  if (!process.env.GH_TOKEN) throw new Error('Publishing requires the workflow token.');
  const authEnv = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64')}`,
  };
  publishCandidate(cwd, expected.base, expected.upstream, expected.candidate, authEnv);
  summary(`Published tested merge \`${expected.candidate}\` to main. The existing Cloudflare integration handles deployment.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    // No raw environment, credentials, or git stderr is emitted by this helper.
    const message = error.status != null ? 'Git rejected the operation. Check branch rules and repository access; main was not force-pushed.' : error.message;
    console.error(message);
    summary(`Update stopped: ${message}`);
    process.exitCode = 1;
  }
}
