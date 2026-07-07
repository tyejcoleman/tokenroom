import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ADR-26: quiet-until-it-matters. The recurring per-turn quota stamp and per-tool cost
// receipts are the "always conscious of budget" noise. They must be SILENT while the 5h
// window is healthy (above critical_pct) and only surface — escalating — at/below it, or
// when the burn model projects running dry before the reset. Non-budget output (the wall
// clock, context, deferred work) is never suppressed.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'tokenroom.mjs');
const now = () => Math.round(Date.now() / 1000);

const run = (args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });

// a fresh, single-account state at the given 5h %-left, optionally with config + burn
function setup(prefix, { fhLeft, config, burn = {}, context = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: now(),
      session_id: 's',
      windows: { five_hour: { used_pct: 100 - fhLeft, resets_at: now() + 3600 } },
      context,
      burn,
      session: { cost_usd: 10 },
    })
  );
  return dir;
}

const stamp = (dir) => {
  const out = run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 's' }), env: { TOKENROOM_DIR: dir } }).stdout;
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
};

test('ADR-26 default (critical_pct 25): a healthy window emits NO budget line — the model stays unburdened', () => {
  // 73% left ≈ the real budget at fix time: the exact "always conscious" case Tye flagged.
  const s73 = stamp(setup('tr-crit-73-', { fhLeft: 73 }));
  assert.match(s73, /^\[tokenroom\] now /, 'the wall clock (non-budget) still leads the stamp');
  assert.doesNotMatch(s73, /% left/, 'no quota "% left" line above critical_pct');
  assert.doesNotMatch(s73, /quota — 5h/, 'no quota segment at all above critical_pct');
  // right at the boundary, still above → silent
  const s26 = stamp(setup('tr-crit-26-', { fhLeft: 26 }));
  assert.doesNotMatch(s26, /% left/);
});

test('ADR-26: at/below critical_pct the quota line surfaces and escalates as it drops', () => {
  // exactly at the threshold → surfaces
  assert.match(stamp(setup('tr-crit-25-', { fhLeft: 25 })), /quota — 5h: 25% left/);
  // well below → surfaces, with the low-quota descent picked up downstream
  assert.match(stamp(setup('tr-crit-8-', { fhLeft: 8 })), /quota — 5h: 8% left/);
  // deep in the floor → surfaces (escalation wording lives in the descent ladder, tested elsewhere)
  assert.match(stamp(setup('tr-crit-1-', { fhLeft: 1 })), /quota — 5h: 1% left/);
});

test('ADR-26: a configurable critical_pct moves the silence threshold both ways', () => {
  // lower it → a window that WAS surfaced (20%) now stays silent
  assert.doesNotMatch(stamp(setup('tr-crit-lo-', { fhLeft: 20, config: { critical_pct: 10 } })), /% left/);
  assert.match(stamp(setup('tr-crit-lo2-', { fhLeft: 9, config: { critical_pct: 10 } })), /quota — 5h: 9% left/);
  // raise it → a healthy 60% now surfaces
  assert.match(stamp(setup('tr-crit-hi-', { fhLeft: 60, config: { critical_pct: 70 } })), /quota — 5h: 60% left/);
});

test('ADR-26: genuinely-critical override — projected to run dry BEFORE the reset surfaces even above critical_pct', () => {
  // 40% left, healthy by %, but burning hot enough to exhaust before the 1h reset → actionable
  const dir = setup('tr-crit-exh-', { fhLeft: 40, burn: { exhaustion_band: [now() + 1200, now() + 1800] } });
  const s = stamp(dir);
  assert.match(s, /quota — 5h: 40% left/, 'the before-reset exhaustion warning is preserved above critical_pct');
  assert.match(s, /may run dry ~/);
});

test('ADR-26: a bad critical_pct falls back to the default 25 (defensive, never-throw)', () => {
  for (const bad of [{ critical_pct: 'high' }, { critical_pct: -5 }, { critical_pct: 200 }, { critical_pct: null }, { critical_pct: true }]) {
    // 73% left with a garbage config must behave like the default: SILENT (not surfaced, not crashed)
    const s = stamp(setup('tr-crit-bad-', { fhLeft: 73, config: bad }));
    assert.match(s, /^\[tokenroom\] now /, `did not crash on ${JSON.stringify(bad)}`);
    assert.doesNotMatch(s, /% left/, `bad ${JSON.stringify(bad)} must default to 25 → silent at 73%`);
    // and below the default threshold it must surface
    assert.match(stamp(setup('tr-crit-bad2-', { fhLeft: 8, config: bad })), /quota — 5h: 8% left/);
  }
});

test('ADR-26: non-budget output is never suppressed — context + deferred work survive a healthy window', () => {
  // healthy 73% but context is filling → the context line (a DIFFERENT resource) must still show
  const dir = setup('tr-crit-ctx-', { fhLeft: 73, context: { used_pct: 60, compact_ceiling_pct: 80, tokens_to_ceiling: 40000 } });
  const s = stamp(dir);
  assert.doesNotMatch(s, /quota — 5h/, 'quota still silent');
  assert.match(s, /context — .*tokens before compaction/, 'context (non-budget) is unaffected by the quota gate');
});

test('ADR-26: cost receipts (PostToolUse) are silent above critical_pct, fire at/below', () => {
  const post = (dir, tool) => run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 's', tool_name: tool }), env: { TOKENROOM_DIR: dir } }).stdout;
  const write = (dir, fhLeft, cost) =>
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schema: 'resource-state/v0',
        updated_at: now(),
        session_id: 's',
        windows: { five_hour: { used_pct: 100 - fhLeft, resets_at: now() + 3600 } },
        context: null,
        burn: {},
        session: { cost_usd: cost },
      })
    );

  // healthy window (60% left): a visible-cost tool call earns NO receipt
  const hi = mkdtempSync(join(tmpdir(), 'tr-crit-rcpt-hi-'));
  write(hi, 60, 10);
  post(hi, 'Task'); // baseline
  write(hi, 55, 13.5); // 5% + $3.50 in one call — would receipt pre-ADR-26
  assert.equal(post(hi, 'Task'), '', 'no receipt while the window is healthy (above critical_pct)');

  // low window (15% left): the same visible move DOES earn a receipt
  const lo = mkdtempSync(join(tmpdir(), 'tr-crit-rcpt-lo-'));
  write(lo, 20, 10);
  post(lo, 'Task'); // baseline
  write(lo, 15, 13.5);
  assert.match(post(lo, 'Task'), /receipt: that Task cost/, 'the receipt surfaces once the window is actionable');
});
