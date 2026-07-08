import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'tokenroom.mjs');
const fixture = (n) => readFileSync(join(root, 'test', 'fixtures', n), 'utf8');

const run = (args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });

test('tap: full payload → HUD + valid state.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-tap-'));
  const r = run(['tap'], { input: fixture('statusline-full.json'), env: { TOKENROOM_DIR: dir } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /⛶ 58% left ↻/); // remaining-first, unlabeled primary, reset clock attached
  assert.doesNotMatch(r.stdout, /week/); // healthy weekly window is hidden — not a binding constraint
  assert.match(r.stdout, /ctx 19% \(38k\)/); // both views: points to ceiling + tokens
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const { validateResourceState } = await import('../src/schema.mjs');
  assert.deepEqual(validateResourceState(state), []);
});

test('tap: garbage and empty stdin never crash, still print a line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-tap-'));
  for (const input of ['not json', '']) {
    const r = run(['tap'], { input, env: { TOKENROOM_DIR: dir } });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.length > 0);
  }
});

test('hook: fresh state → stamp; stale → silent; disabled → silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-hook-'));
  // this test asserts the canonical stamp SHAPE at a healthy 58% — hold the ADR-26 quiet gate
  // open (critical_pct 100) so quota always renders; the gate's own behavior is in critical.test.mjs.
  // The fixture's 122k-token context legitimately crosses the facilitator-nudge default
  // threshold (ADR-29) — opt this shape test out of that unrelated feature so it stays a
  // clean canonical-shape check; the nudge itself is covered in test/facilitator.test.mjs.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ critical_pct: 100, facilitator_nudge_enabled: false }));
  run(['tap'], { input: fixture('statusline-full.json'), env: { TOKENROOM_DIR: dir } });

  const r = run(['hook', 'user-prompt-submit'], { input: '{}', env: { TOKENROOM_DIR: dir } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  const stamp = out.hookSpecificOutput.additionalContext;
  assert.match(stamp, /^\[tokenroom\] now .+ · quota — 5h: 58% left/); // leads with the wall clock, then quota
  assert.doesNotMatch(stamp, /7d:/); // healthy weekly (85% left) is hidden from the LLM until <20% remains
  assert.match(stamp, /tokens before compaction/);
  assert.ok(stamp.length < 260, `stamp too long: ${stamp.length}`);

  // The hook reads THIS session's account subtree (ADR-21), not the top-level pointer, so
  // mutations below target the per-account state file the tap created.
  const accts = join(dir, 'accounts');
  const statePath = existsSync(accts) ? join(accts, readdirSync(accts)[0], 'state.json') : join(dir, 'state.json');

  // stale state → no output
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.updated_at -= 3600;
  writeFileSync(statePath, JSON.stringify(state));
  assert.equal(run(['hook', 'user-prompt-submit'], { input: '{}', env: { TOKENROOM_DIR: dir } }).stdout, '');

  // disabled → no output (fresh state again)
  run(['tap'], { input: fixture('statusline-full.json'), env: { TOKENROOM_DIR: dir } });
  assert.equal(run(['hook', 'user-prompt-submit'], { input: '{}', env: { TOKENROOM_DIR: dir, TOKENROOM_DISABLE: '1' } }).stdout, '');

  // state written by a DIFFERENT session → account-level windows kept, session-level ctx omitted
  const r2 = run(['hook', 'user-prompt-submit'], { input: '{"session_id":"some-other-session"}', env: { TOKENROOM_DIR: dir } });
  const stamp2 = JSON.parse(r2.stdout).hookSpecificOutput.additionalContext;
  assert.match(stamp2, /5h: 58% left/);
  assert.doesNotMatch(stamp2, /context/); // foreign session: context omitted entirely

  // fresh stamp has no age marker; aging (but not stale) state discloses its age
  assert.doesNotMatch(stamp2, /m old\)/);
  const aging = JSON.parse(readFileSync(statePath, 'utf8'));
  aging.updated_at = Math.round(Date.now() / 1000) - 300;
  writeFileSync(statePath, JSON.stringify(aging));
  const r3 = run(['hook', 'user-prompt-submit'], { input: '{}', env: { TOKENROOM_DIR: dir } });
  assert.match(JSON.parse(r3.stdout).hookSpecificOutput.additionalContext, /\(5m old\)$/);
});

test('two accounts, two sessions: each session sees ITS OWN weekly, never the other (ADR-21)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-multi-'));
  // asserts per-account quota rendering at 58%/30% — hold the ADR-26 quiet gate open
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ critical_pct: 100 }));
  const base = JSON.parse(fixture('statusline-full.json'));
  // Account A: 5h 58% left, 7d 15% left.  Account B: 5h 30% left, 7d 7% left.
  const A = { ...base, session_id: 'sessA',
    rate_limits: { five_hour: { used_percentage: 42, resets_at: 4102444800 }, seven_day: { used_percentage: 85, resets_at: 4103049600 } } };
  const B = { ...base, session_id: 'sessB',
    rate_limits: { five_hour: { used_percentage: 70, resets_at: 4102444800 + 137 * 60 }, seven_day: { used_percentage: 93, resets_at: 4103049600 - 3 * 86400 } } };

  // Both sessions render their statuslines into the SHARED ~/.tokenroom (B writes last).
  run(['tap'], { input: JSON.stringify(A), env: { TOKENROOM_DIR: dir } });
  run(['tap'], { input: JSON.stringify(B), env: { TOKENROOM_DIR: dir } });

  const stamp = (sid) =>
    JSON.parse(run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: sid }), env: { TOKENROOM_DIR: dir } }).stdout)
      .hookSpecificOutput.additionalContext;

  const a = stamp('sessA');
  assert.match(a, /5h: 58% left/);
  assert.match(a, /7d: 15% left/);
  assert.doesNotMatch(a, /7d: 7% left/); // B's weekly must NOT bleed into A's stamp

  const b = stamp('sessB');
  assert.match(b, /5h: 30% left/);
  assert.match(b, /7d: 7% left/);
  assert.doesNotMatch(b, /7d: 15% left/); // A's weekly must NOT bleed into B's stamp

  // an unmapped session on this 2-account machine can't be attributed → quota withheld
  const z = stamp('sessZ');
  assert.doesNotMatch(z, /5h:/);
  assert.doesNotMatch(z, /7d:/);
});

test('unmapped session on a 2-account machine: PostToolUse, PreToolUse, PreCompact all withhold the other account (ADR-21)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-scope-'));
  const env = { TOKENROOM_DIR: dir };
  const nowS = Math.round(Date.now() / 1000);
  mkdirSync(dir, { recursive: true });
  // both quota-consuming gates armed
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ launch_gate: true, compact_guard_min: 60 }));

  const mk = (sid, fhReset, sdReset, fhUsed) => JSON.stringify({
    session_id: sid,
    rate_limits: { five_hour: { used_percentage: fhUsed, resets_at: fhReset }, seven_day: { used_percentage: 50, resets_at: sdReset } },
  });
  // Account A, then Account B written LAST → B is the top-level pointer. B is nearly dry with
  // an IMMINENT reset: exactly the numbers that would leak to an unmapped session via the
  // global pointer (a false receipt/band nudge, a bogus launch-deny, a bogus compact-block).
  run(['tap'], { input: mk('sessA', nowS + 8000, nowS + 3 * 86400, 40), env });
  run(['tap'], { input: mk('sessB', nowS + 1500, nowS + 5 * 86400, 99), env });

  // seed a PostToolUse baseline for the unmapped session in the GLOBAL dir at a healthy band,
  // so the OLD (buggy) code would compute a worsening band + big receipt off B's dry numbers.
  writeFileSync(join(dir, 'bands.json'), JSON.stringify({ sessZ: { fh: 0, ctx: 0, exh: false, sc: false, u: 40, c: null, cu: null, t: nowS - 300, at: 0 } }));

  const ups = run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'sessZ', tool_name: 'Read' }), env });
  assert.equal(ups.stdout, '', 'PostToolUse emits nothing for an unmapped session — no foreign-account receipt/band leak');

  const gate = run(['hook', 'pre-tool-use'], { input: JSON.stringify({ session_id: 'sessZ', tool_name: 'Task' }), env });
  assert.doesNotMatch(gate.stdout, /deny/, "launch gate must not deny using another account's dry window");

  const guard = run(['hook', 'pre-compact'], { input: JSON.stringify({ session_id: 'sessZ', trigger: 'auto' }), env });
  assert.doesNotMatch(guard.stdout, /block/, "compact guard must not block using another account's imminent reset");

  // CONTROL: a MAPPED session still gets its own gate — the show-gate withholds, it doesn't disable.
  const gateA = run(['hook', 'pre-tool-use'], { input: JSON.stringify({ session_id: 'sessB', tool_name: 'Task' }), env });
  assert.match(gateA.stdout, /deny/, 'the mapped dry account (B) is still gated — the fix withholds only unattributable quota');
});

test('install: idempotent into sandbox config dir; uninstall leaves no trace', () => {
  const home = mkdtempSync(join(tmpdir(), 'tokenroom-inst-'));
  const cfg = join(home, '.claude');

  run(['install', '--config-dir', cfg, '--no-mcp']);
  run(['install', '--config-dir', cfg, '--no-mcp']); // second run must not duplicate
  const settings = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'));
  assert.match(settings.statusLine.command, /tokenroom\.mjs" tap/);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.ok(existsSync(join(cfg, 'skills', 'tokenroom', 'SKILL.md')));

  run(['uninstall', '--config-dir', cfg]);
  const after = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'));
  assert.equal(after.statusLine, undefined);
  assert.equal(after.hooks, undefined);
  assert.ok(!existsSync(join(cfg, 'skills', 'tokenroom')));
});

test('install: preserves an existing foreign statusline in backup and restores it on uninstall', () => {
  const home = mkdtempSync(join(tmpdir(), 'tokenroom-inst2-'));
  const cfg = join(home, '.claude');
  const settingsPath = join(cfg, 'settings.json');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'ccusage statusline' } }));

  run(['install', '--config-dir', cfg, '--no-mcp']);
  assert.match(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine.command, /tokenroom\.mjs/);

  run(['uninstall', '--config-dir', cfg]);
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine.command, 'ccusage statusline');
});

test('install: replaces pre-rename headroom artifacts — never doubles hooks, stamps, or skills (ADR-23)', () => {
  const home = mkdtempSync(join(tmpdir(), 'tokenroom-inst3-'));
  const cfg = join(home, '.claude');
  mkdirSync(join(cfg, 'skills', 'headroom'), { recursive: true });
  writeFileSync(join(cfg, 'skills', 'headroom', 'SKILL.md'), 'old skill');
  const oldCmd = (sub) => `"/usr/local/bin/node" "/old/path/headroom/bin/headroom.mjs" ${sub}`;
  writeFileSync(
    join(cfg, 'settings.json'),
    JSON.stringify({
      statusLine: { type: 'command', command: oldCmd('tap') },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: oldCmd('hook user-prompt-submit'), timeout: 10 }] }] },
    })
  );
  writeFileSync(
    join(cfg, 'CLAUDE.md'),
    'user text stays\n\n<!-- headroom:compact-instructions:start -->\nold block `[headroom]`\n<!-- headroom:compact-instructions:end -->\n'
  );

  run(['install', '--config-dir', cfg, '--no-mcp']);

  const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(s), /headroom\.mjs/); // no old-named command survives anywhere
  assert.match(s.statusLine.command, /tokenroom\.mjs" tap/);
  assert.equal(s.hooks.UserPromptSubmit.length, 1); // replaced, not doubled
  assert.ok(!existsSync(join(cfg, 'skills', 'headroom')));
  assert.ok(existsSync(join(cfg, 'skills', 'tokenroom', 'SKILL.md')));
  const md = readFileSync(join(cfg, 'CLAUDE.md'), 'utf8');
  assert.match(md, /user text stays/); // nothing outside the managed block was touched
  assert.match(md, /tokenroom:compact-instructions:start/);
  assert.doesNotMatch(md, /headroom:compact-instructions/);
  assert.equal(md.match(/## Compact Instructions/g).length, 1); // exactly one managed block

  run(['uninstall', '--config-dir', cfg]);
  const after = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'));
  assert.equal(after.statusLine, undefined);
  assert.equal(after.hooks, undefined);
  assert.doesNotMatch(readFileSync(join(cfg, 'CLAUDE.md'), 'utf8'), /compact-instructions/);
});

test('migrateStateDir: copies old state dir once, skips atomic-write temp files, never deletes the source', async () => {
  const { migrateStateDir } = await import('../src/install.mjs');
  const base = mkdtempSync(join(tmpdir(), 'tokenroom-mig-'));
  const oldDir = join(base, '.headroom');
  const newDir = join(base, '.tokenroom');
  mkdirSync(join(oldDir, 'accounts', 'a1'), { recursive: true });
  writeFileSync(join(oldDir, 'state.json'), '{"ok":true}');
  writeFileSync(join(oldDir, 'accounts', 'a1', 'state.json'), '{"acct":1}');
  writeFileSync(join(oldDir, 'state.json.ab12cd34.tmp'), 'half-written');

  assert.ok(migrateStateDir(oldDir, newDir)); // reports the copy
  assert.equal(readFileSync(join(newDir, 'state.json'), 'utf8'), '{"ok":true}');
  assert.equal(readFileSync(join(newDir, 'accounts', 'a1', 'state.json'), 'utf8'), '{"acct":1}');
  assert.ok(!existsSync(join(newDir, 'state.json.ab12cd34.tmp'))); // in-flight temp never copied
  assert.ok(existsSync(join(oldDir, 'state.json'))); // COPY, not move — live old sessions keep writing it
  assert.equal(migrateStateDir(oldDir, newDir), null); // second run is a no-op
  assert.equal(migrateStateDir(join(base, 'nope'), join(base, 'also-nope')), null); // nothing to migrate
});
