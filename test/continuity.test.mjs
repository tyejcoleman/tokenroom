import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'tokenroom.mjs');
const fixture = (n) => readFileSync(join(root, 'test', 'fixtures', n), 'utf8');

const run = (args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });

const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });

const contMod = JSON.stringify(join(root, 'src', 'continuity.mjs'));
const saveDoc = (args, env) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', `const { saveContinuity } = await import(${contMod}); console.log(JSON.stringify(saveContinuity(${JSON.stringify(args)})));`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input: '',
  }).stdout.trim();

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'tokenroom-repo-'));
  sh(repo, 'git', ['init', '-q']);
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first commit']);
  writeFileSync(join(repo, 'a.txt'), 'hello dirty\n'); // uncommitted change
  return repo;
}

test('pre-compact snapshots git ground truth; session-start(compact) re-injects it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-cont-'));
  const repo = makeGitRepo();
  const env = { TOKENROOM_DIR: dir };

  const pre = run(['hook', 'pre-compact'], {
    input: JSON.stringify({ session_id: 'sess-1', cwd: repo, trigger: 'auto' }),
    env,
  });
  assert.equal(pre.status, 0);
  const snap = JSON.parse(readFileSync(join(dir, 'handoffs', 'sess-1.json'), 'utf8'));
  assert.match(snap.git.dirty[0], /a\.txt/);
  assert.match(snap.git.last_edited, /a\.txt/); // the most-recently-edited file is captured
  assert.match(snap.git.recent_commits[0], /first commit/);

  const start = run(['hook', 'session-start'], {
    input: JSON.stringify({ session_id: 'sess-1', source: 'compact' }),
    env,
  });
  const ctx = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /post-compaction ground truth/);
  assert.match(ctx, /a\.txt/);
  assert.match(ctx, /most recently editing/); // restart directive: open the last-edited file first
  assert.match(ctx, /first commit/);
  assert.match(ctx, /Trust this snapshot/);
});

test('session-start: silent for normal startup, wrong session, or stale snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-cont2-'));
  const repo = makeGitRepo();
  const env = { TOKENROOM_DIR: dir };
  run(['hook', 'pre-compact'], { input: JSON.stringify({ session_id: 'sess-1', cwd: repo }), env });

  // normal startup → nothing
  assert.equal(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'sess-1', source: 'startup' }), env }).stdout, '');
  // different session compacting → nothing
  assert.equal(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'other', source: 'compact' }), env }).stdout, '');
  // stale snapshot → nothing
  const p = join(dir, 'handoffs', 'sess-1.json');
  const snap = JSON.parse(readFileSync(p, 'utf8'));
  snap.at -= 7 * 3600;
  writeFileSync(p, JSON.stringify(snap));
  assert.equal(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'sess-1', source: 'compact' }), env }).stdout, '');
});

test('pre-compact never crashes on garbage input or non-git cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-cont3-'));
  const env = { TOKENROOM_DIR: dir };
  assert.equal(run(['hook', 'pre-compact'], { input: 'not json', env }).status, 0);
  const plain = mkdtempSync(join(tmpdir(), 'tokenroom-plain-'));
  assert.equal(run(['hook', 'pre-compact'], { input: JSON.stringify({ session_id: 's', cwd: plain }), env }).status, 0);
  const snap = JSON.parse(readFileSync(join(dir, 'handoffs', 's.json'), 'utf8'));
  assert.equal(snap.git, null);
});

test('handoff doc: saveContinuity writes a canonical markdown doc; missing fields rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-h1-'));
  const env = { TOKENROOM_DIR: dir };

  assert.equal(saveDoc({ state: 'no mission, no next steps' }, env), 'null');

  const out = JSON.parse(
    saveDoc(
      {
        mission: 'ship the continuity handoff feature',
        next_steps: ['wire the MCP tool', 'add tests'],
        references: ['src/continuity.mjs'],
        user_directives: ['let it burn to the ground'],
        improvements: ['reframe context-pressure as a handoff signal'],
      },
      env
    )
  );
  assert.ok(out.path);
  const md = readFileSync(out.path, 'utf8');
  assert.match(md, /# Tokenroom handoff/);
  assert.match(md, /ship the continuity handoff feature/);
  assert.match(md, /wire the MCP tool/);
  assert.match(md, /let it burn to the ground/);
  assert.match(md, /reframe context-pressure/);
});

test('handoff doc: session-start(compact) re-injects pointer+digest; startup is silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-h2-'));
  const env = { TOKENROOM_DIR: dir };
  saveDoc({ mission: 'long-running migration', next_steps: ['resume at step 4'] }, env);

  const ctx = JSON.parse(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'sess-1', source: 'compact' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, /canonical handoff doc/);
  assert.match(ctx, /READ IT FIRST/);
  assert.match(ctx, /resume at: resume at step 4/);

  // a normal (non-compact) startup must stay silent — does not break existing behavior
  assert.equal(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'sess-1', source: 'startup' }), env }).stdout, '');
});

test('handoff doc: stale doc and wrong-session doc are not re-injected', () => {
  // stale
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-h3-'));
  const env = { TOKENROOM_DIR: dir };
  saveDoc({ mission: 'x', next_steps: ['y'] }, env);
  const metaP = join(dir, 'continuity', 'session.meta.json');
  const m = JSON.parse(readFileSync(metaP, 'utf8'));
  m.at -= 25 * 3600;
  writeFileSync(metaP, JSON.stringify(m));
  assert.equal(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'sess-1', source: 'compact' }), env }).stdout, '');

  // wrong session: a doc tagged sess-A must not surface for sess-B
  const dir2 = mkdtempSync(join(tmpdir(), 'tokenroom-h4-'));
  const env2 = { TOKENROOM_DIR: dir2 };
  const now = Math.round(Date.now() / 1000);
  mkdirSync(join(dir2, 'continuity'), { recursive: true });
  writeFileSync(join(dir2, 'continuity', 'sess-A.meta.json'), JSON.stringify({ session_id: 'sess-A', at: now, digest: { mission: 'x', next: 'y' } }));
  writeFileSync(join(dir2, 'continuity', 'sess-A.md'), '# doc\n');
  assert.equal(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'sess-B', source: 'compact' }), env: env2 }).stdout, '');
});

// ADR-28: continuity docs are keyed by (session, project) — a doc written under one
// project's cwd must never be re-injected into a session whose cwd is a DIFFERENT project,
// even when neither side can resolve a session id (the exact shape of the live bug: a
// Nomos-project doc served into an unrelated openkakushin session).
test('ADR-28: continuity docs are scoped by (session, project) — no cross-project collision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-proj-'));
  const env = { TOKENROOM_DIR: dir };
  const projA = mkdtempSync(join(tmpdir(), 'tokenroom-projA-')); // stands in for "Nomos"
  const projB = mkdtempSync(join(tmpdir(), 'tokenroom-projB-')); // stands in for "openkakushin"

  // Project A writes a handoff doc with no resolvable session id (the MCP-call-carries-no-
  // session-id case that produced the untagged doc in the field) — pre-fix this landed in
  // the single global `continuity/session.md` shared by every project on the machine.
  saveDoc({ mission: 'Build Nomos: the mission statement', next_steps: ['keep going'], cwd: projA }, env);

  // A session whose cwd is project B, resuming after compaction, must NOT see project A's
  // doc — clean no-op, not a cross-project leak.
  const crossed = run(['hook', 'session-start'], {
    input: JSON.stringify({ session_id: 'ok-session', source: 'compact', cwd: projB }),
    env,
  });
  assert.equal(crossed.stdout, '');

  // The SAME project (A), even with a different/unresolved session id on the read side,
  // still gets its own doc back — same-project resume is preserved.
  const same = JSON.parse(
    run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'ok-session', source: 'compact', cwd: projA }), env }).stdout
  ).hookSpecificOutput.additionalContext;
  assert.match(same, /Build Nomos: the mission statement/);

  // Project B writes its OWN doc; project A must not see it either (collision is symmetric).
  saveDoc({ mission: 'openkakushin: lift the next function', next_steps: ['recomp'], cwd: projB }, env);
  const aSeesOwn = JSON.parse(
    run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'x', source: 'compact', cwd: projA }), env }).stdout
  ).hookSpecificOutput.additionalContext;
  assert.match(aSeesOwn, /Build Nomos/);
  assert.doesNotMatch(aSeesOwn, /openkakushin/);
  const bSeesOwn = JSON.parse(
    run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'y', source: 'compact', cwd: projB }), env }).stdout
  ).hookSpecificOutput.additionalContext;
  assert.match(bSeesOwn, /openkakushin/);
  assert.doesNotMatch(bSeesOwn, /Build Nomos/);
});

test('ADR-28: exact (session, project) match resolves first; legacy undated doc still resolves for its own session, and is not cross-served', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-proj2-'));
  const env = { TOKENROOM_DIR: dir };
  const proj = mkdtempSync(join(tmpdir(), 'tokenroom-projC-'));
  const now = Math.round(Date.now() / 1000);

  // Give this account a resolvable session id (as a real tapped session would), then save —
  // this exercises the precise (session, project) composite key, not the untagged fallback.
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ schema: 'resource-state/v0', updated_at: now, session_id: 'sess-exact', windows: {}, burn: {}, session: {} })
  );
  saveDoc({ mission: 'exact session+project handoff', next_steps: ['finish it'], cwd: proj }, env);
  const exact = JSON.parse(
    run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'sess-exact', source: 'compact', cwd: proj }), env }).stdout
  ).hookSpecificOutput.additionalContext;
  assert.match(exact, /exact session\+project handoff/);

  // A pre-ADR-28 legacy doc: bare session key, no `project` field at all, written directly
  // (as old code would have). It still resolves for a SessionStart call that matches its own
  // session id...
  const dir2 = mkdtempSync(join(tmpdir(), 'tokenroom-proj3-'));
  const env2 = { TOKENROOM_DIR: dir2 };
  mkdirSync(join(dir2, 'continuity'), { recursive: true });
  writeFileSync(
    join(dir2, 'continuity', 'sess-legacy.meta.json'),
    JSON.stringify({ session_id: 'sess-legacy', at: now, digest: { mission: 'pre-fix doc', next: 'y' } })
  );
  writeFileSync(join(dir2, 'continuity', 'sess-legacy.md'), '# legacy doc\n');
  const legacyOwn = JSON.parse(
    run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'sess-legacy', source: 'compact' }), env: env2 }).stdout
  ).hookSpecificOutput.additionalContext;
  assert.match(legacyOwn, /pre-fix doc/);
  // ...but is NOT cross-served to a different session (with or without a cwd).
  assert.equal(
    run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'someone-else', source: 'compact' }), env: env2 }).stdout,
    ''
  );
  assert.equal(
    run(['hook', 'session-start'], {
      input: JSON.stringify({ session_id: 'someone-else', source: 'compact', cwd: mkdtempSync(join(tmpdir(), 'tokenroom-projD-')) }),
      env: env2,
    }).stdout,
    ''
  );
});

test('ADR-28: missing doc is a clean no-op even when cwd/project is known', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-proj4-'));
  const env = { TOKENROOM_DIR: dir };
  const proj = mkdtempSync(join(tmpdir(), 'tokenroom-projE-'));
  assert.equal(
    run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'nobody', source: 'compact', cwd: proj }), env }).stdout,
    ''
  );
});

test('ctx mid-turn: super-close fires exactly once (velocity-timed, not redundant)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-sc-'));
  const env = { TOKENROOM_DIR: dir };
  const now = () => Math.round(Date.now() / 1000);
  const writeState = (tok) =>
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schema: 'resource-state/v0',
        updated_at: now(),
        session_id: 'cx1',
        windows: { five_hour: { used_pct: 30, resets_at: now() + 3600 } },
        context: { used_pct: 78, compact_ceiling_pct: 80, tokens_to_ceiling: tok },
        burn: {},
        session: {},
      })
    );
  const post = () => run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'cx1' }), env }).stdout;

  writeState(40000);
  assert.equal(post(), ''); // first sight: baseline, not super-close
  writeState(8000);
  assert.match(post(), /SUPER CLOSE to auto-compaction/); // the one velocity-timed nudge
  assert.equal(post(), ''); // fires only ONCE — no redundant re-nag
});

test('ctx mid-turn: a recent handoff suppresses the super-close nag (no redundant re-save)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-sc2-'));
  const env = { TOKENROOM_DIR: dir };
  const now = () => Math.round(Date.now() / 1000);
  const writeState = (tok) =>
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schema: 'resource-state/v0',
        updated_at: now(),
        session_id: 'cx2',
        windows: { five_hour: { used_pct: 30, resets_at: now() + 3600 } },
        context: { used_pct: 78, compact_ceiling_pct: 80, tokens_to_ceiling: tok },
        burn: {},
        session: {},
      })
    );
  const post = () => run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'cx2' }), env }).stdout;

  writeState(40000);
  post(); // baseline, records the ctx sample
  saveDoc({ mission: 'already captured', next_steps: ['continue'] }, env); // fresh handoff for cx2
  writeState(8000); // now super-close
  assert.equal(post(), ''); // suppressed: handoff was just saved — don't re-nag
});

test('resume lifecycle: plan via MCP-layer fn → HUD countdown → ready in stamp/session-start → clear', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-res-'));
  const env = { TOKENROOM_DIR: dir };
  run(['tap'], { input: fixture('statusline-full.json'), env }); // resets_at = 4102444800 (far future)

  // record a plan through the same code path the MCP tool uses
  const script = `
    const { planResume } = await import(${JSON.stringify(join(root, 'src', 'resume.mjs'))});
    const { readState } = await import(${JSON.stringify(join(root, 'src', 'state.mjs'))});
    console.log(JSON.stringify(planResume({ summary: 'finish auth migration in middleware + tests', est_tokens: 25000 }, readState())));
  `;
  const planOut = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input: '',
  });
  const rec = JSON.parse(planOut.stdout);
  assert.equal(rec.recorded, true);
  assert.equal(rec.resume_at, 4102444800);

  // a waiting plan is deliberately absent from the HUD (not actionable yet)
  const hud = run(['tap'], { input: fixture('statusline-full.json'), env }).stdout;
  assert.doesNotMatch(hud, /⏲|deferred/);

  // flip the plan to "ready" and check stamp + session-start + HUD
  const planPath = join(dir, 'resume.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  plan.resume_at = Math.round(Date.now() / 1000) - 60;
  writeFileSync(planPath, JSON.stringify(plan));

  const stamp = JSON.parse(run(['hook', 'user-prompt-submit'], { input: '{}', env }).stdout).hookSpecificOutput.additionalContext;
  assert.match(stamp, /deferred work now ready: "finish auth migration/);
  const startCtx = JSON.parse(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'x', source: 'startup' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(startCtx, /deferred work is now ready/);
  assert.match(run(['tap'], { input: fixture('statusline-full.json'), env }).stdout, /✓ deferred work ready/);

  // clear
  assert.match(run(['resume', '--clear'], { env }).stdout, /cleared/);
  assert.ok(!existsSync(planPath));
  assert.doesNotMatch(
    JSON.parse(run(['hook', 'user-prompt-submit'], { input: '{}', env }).stdout).hookSpecificOutput.additionalContext,
    /deferred/
  );
});
