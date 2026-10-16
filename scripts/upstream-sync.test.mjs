import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { IDENTITY, mergeCandidate, inspectCandidate, publishCandidate, importCandidate, bundleHash } from './upstream-sync.mjs';

// Real local Git repositories exercise ancestry, conflicts, artifacts, and push races.
// No network, household data, or credentials are used. Git's global identity is ignored.
const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'robo-tools', GIT_COMMITTER_NAME: 'robo-tools',
  GIT_AUTHOR_EMAIL: '318782861+robo-tools@users.noreply.github.com',
  GIT_COMMITTER_EMAIL: '318782861+robo-tools@users.noreply.github.com' };
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
}
function put(cwd, path, contents) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), contents);
}
function commit(cwd, name) {
  git(cwd, 'add', '.'); git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', name);
  return git(cwd, 'rev-parse', 'HEAD');
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'minty-upstream-test-'));
  const repo = join(root, 'repo'), remote = join(root, 'origin.git');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'robo-tools');
  git(repo, 'config', 'user.email', '318782861+robo-tools@users.noreply.github.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'commit.gpgsign', 'false');
  put(repo, 'shared.txt', 'original\n');
  put(repo, '.github/workflows/test.yml', 'name: original\n');
  put(repo, 'd1/migrations/0001_initial.sql', 'CREATE TABLE original (id INTEGER);\n');
  const ancestor = commit(repo, 'Initial fixture');
  git(repo, 'branch', 'upstream');
  put(repo, 'bills.txt', 'Keep the fork feature\n');
  const base = commit(repo, 'Fork feature');
  git(root, 'init', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', 'origin', 'main');
  git(repo, 'checkout', 'upstream');
  return { root, repo, remote, ancestor, base };
}
function upstreamChange(f, path = 'upstream.txt', content = 'New upstream feature\n') {
  put(f.repo, path, content);
  return commit(f.repo, 'Upstream update');
}
function createBundle(f, upstream, candidate) {
  const dir = join(f.root, 'artifact'); mkdirSync(dir);
  const path = join(dir, 'candidate.bundle');
  git(f.repo, 'update-ref', 'refs/heads/minty-upstream-candidate', candidate);
  git(f.repo, 'bundle', 'create', path, 'refs/heads/minty-upstream-candidate', `^${f.base}`);
  return { dir, path, expected: { base:f.base, upstream, candidate, sha256:bundleHash(path) } };
}

test('merges divergent histories and publishes only the exact candidate with robo-tools identity', () => {
  const f = fixture(), upstream = upstreamChange(f);
  const candidate = mergeCandidate(f.repo, f.base, upstream);
  assert.equal(readFileSync(join(f.repo, 'bills.txt'), 'utf8'), 'Keep the fork feature\n');
  assert.equal(readFileSync(join(f.repo, 'upstream.txt'), 'utf8'), 'New upstream feature\n');
  assert.equal(git(f.repo, 'show', '-s', '--format=%an <%ae>%n%cn <%ce>', candidate), `${IDENTITY}\n${IDENTITY}`);
  assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], f.base);
  publishCandidate(f.repo, f.base, upstream, candidate);
  assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], candidate);
});

test('imports the immutable bundle into a separate clean checkout', () => {
  const f = fixture(), upstream = upstreamChange(f), candidate = mergeCandidate(f.repo, f.base, upstream);
  const artifact = createBundle(f, upstream, candidate), verify = join(f.root, 'verify');
  git(f.root, 'clone', '--branch', 'main', f.remote, verify);
  assert.equal(importCandidate(verify, artifact.dir, artifact.expected), candidate);
  // Import does not execute or check out any candidate code in the publisher.
  assert.equal(git(verify, 'rev-parse', 'HEAD'), f.base);
  appendFileSync(artifact.path, 'tampered');
  assert.throws(() => importCandidate(verify, artifact.dir, artifact.expected), /immutable/);
});

test('stops on content conflicts and leaves remote main untouched', () => {
  const f = fixture();
  git(f.repo, 'checkout', 'main');
  put(f.repo, 'shared.txt', 'Fork change\n');
  const base = commit(f.repo, 'Fork change');
  git(f.repo, 'push', 'origin', 'main');
  git(f.repo, 'checkout', 'upstream');
  const upstream = upstreamChange(f, 'shared.txt', 'Incompatible upstream change\n');
  assert.throws(() => mergeCandidate(f.repo, base, upstream), /conflicts.*\nshared.txt/);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), base);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], base);
});

test('a concurrent main update prevents publication', () => {
  const f = fixture(), upstream = upstreamChange(f), candidate = mergeCandidate(f.repo, f.base, upstream);
  git(f.repo, 'checkout', 'main');
  put(f.repo, 'new-fork-change.txt', 'Another change landed\n');
  const newer = commit(f.repo, 'Concurrent change'); git(f.repo, 'push', 'origin', 'main');
  assert.throws(() => publishCandidate(f.repo, f.base, upstream, candidate), /Main changed/);
  assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], newer);
});

test('rejects a candidate with the wrong parents or committer', () => {
  const f = fixture(), upstream = upstreamChange(f), candidate = mergeCandidate(f.repo, f.base, upstream);
  assert.throws(() => inspectCandidate(f.repo, f.ancestor, upstream, candidate), /two-parent/);
  // Synthetic identity only. No machine-level personal identity enters this fixture.
  execFileSync('git', ['-c','commit.gpgsign=false','commit','--amend','--no-edit'], {
    cwd:f.repo, env:{...env,GIT_COMMITTER_NAME:'Wrong Fixture',GIT_COMMITTER_EMAIL:'wrong@example.invalid'}, stdio:'pipe',
  });
  assert.throws(() => inspectCandidate(f.repo, f.base, upstream, git(f.repo,'rev-parse','HEAD')), /author and committer/);
});

for (const mode of ['edit', 'rename', 'delete']) {
  test(`workflow ${mode} requires review even when Git can merge it`, () => {
    const f = fixture();
    if (mode === 'edit') put(f.repo, '.github/workflows/test.yml', 'name: changed\n');
    if (mode === 'rename') git(f.repo, 'mv', '.github/workflows/test.yml', 'moved.yml');
    if (mode === 'delete') unlinkSync(join(f.repo, '.github/workflows/test.yml'));
    const upstream = commit(f.repo, `Workflow ${mode}`);
    assert.throws(() => mergeCandidate(f.repo, f.base, upstream), /workflow or updater/);
  });
}

test('updater code changes require review', () => {
  const f = fixture(), upstream = upstreamChange(f, 'scripts/upstream-sync.mjs', 'throw Error("changed");\n');
  assert.throws(() => mergeCandidate(f.repo, f.base, upstream), /workflow or updater/);
});

for (const mode of ['edit', 'delete']) {
  test(`existing migration ${mode} requires review`, () => {
    const f = fixture();
    if (mode === 'edit') put(f.repo, 'd1/migrations/0001_initial.sql', 'CREATE TABLE changed (id INTEGER);\n');
    else unlinkSync(join(f.repo, 'd1/migrations/0001_initial.sql'));
    const upstream = commit(f.repo, `Migration ${mode}`);
    assert.throws(() => mergeCandidate(f.repo, f.base, upstream), /migration was changed or removed/);
  });
}

test('different migration filenames with overlapping numbers require review', () => {
  const f = fixture(); git(f.repo, 'checkout', 'main');
  put(f.repo, 'd1/migrations/0002_bills.sql', 'CREATE TABLE bills (id INTEGER);\n');
  const base = commit(f.repo, 'Fork migration'); git(f.repo, 'checkout', 'upstream');
  const upstream = upstreamChange(f, 'd1/migrations/0002_upstream.sql', 'CREATE TABLE upstream (id INTEGER);\n');
  assert.throws(() => mergeCandidate(f.repo, base, upstream), /overlap|upgrade order/);
});

test('new migration before the fork maximum requires upgrade-order review', () => {
  const f = fixture(); git(f.repo, 'checkout', 'main');
  put(f.repo, 'd1/migrations/0003_bills.sql', 'CREATE TABLE bills (id INTEGER);\n');
  const base = commit(f.repo, 'Fork migration'); git(f.repo, 'checkout', 'upstream');
  const upstream = upstreamChange(f, 'd1/migrations/0002_upstream.sql', 'CREATE TABLE upstream (id INTEGER);\n');
  assert.throws(() => mergeCandidate(f.repo, base, upstream), /upgrade order/);
});

test('a new migration after existing migrations can pass to the full suite', () => {
  const f = fixture(), upstream = upstreamChange(f, 'd1/migrations/0002_new.sql', 'CREATE TABLE new_table (id INTEGER);\n');
  const candidate = mergeCandidate(f.repo, f.base, upstream);
  assert.doesNotThrow(() => inspectCandidate(f.repo, f.base, upstream, candidate));
});
