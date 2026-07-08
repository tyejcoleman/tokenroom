import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { facilitatorNudge } from '../src/facilitator.mjs';
import { readConfig } from '../src/util.mjs';

// ADR-29 (burn-efficiency signal + facilitator-cost nudge): a per-turn tok/min read on
// THIS session's own burn, plus — because a long-running driver/orchestrator session
// resends its whole context every turn — a hand-off nudge once that context size crosses
// a configurable threshold. Both ride the single `facilitator_nudge_enabled` switch
// (default on) so disabling it reproduces pre-enhancement, byte-identical output.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'tokenroom.mjs');
const now = () => Math.round(Date.now() / 1000);

const run = (args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });

// ── unit tests: facilitatorNudge (src/facilitator.mjs) ──────────────────────────────

test('facilitatorNudge: fires on first sight above threshold, wording matches spec', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-unit-'));
  const cfg = { facilitator_nudge_enabled: true, facilitator_context_threshold_tokens: 1000, facilitator_nudge_cooldown_turns: 3 };
  const msg = facilitatorNudge('s1', 5000, cfg, now(), dir);
  assert.equal(msg, 'facilitator context ~5k/turn — consider handing off to a fresh session to reset context cost');
});

test('facilitatorNudge: silent below threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-unit-'));
  const cfg = { facilitator_nudge_enabled: true, facilitator_context_threshold_tokens: 50000, facilitator_nudge_cooldown_turns: 1 };
  assert.equal(facilitatorNudge('s1', 49999, cfg, now(), dir), null);
  assert.equal(facilitatorNudge('s1', 0, cfg, now(), dir), null);
});

test('facilitatorNudge: rate-limited across turns — fires, then holds for cooldown_turns, then fires again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-unit-'));
  const cfg = { facilitator_nudge_enabled: true, facilitator_context_threshold_tokens: 1000, facilitator_nudge_cooldown_turns: 3 };
  const t0 = now();
  const fired = [];
  for (let i = 0; i < 6; i++) fired.push(facilitatorNudge('s1', 5000, cfg, t0 + i, dir) !== null);
  assert.deepEqual(fired, [true, false, false, true, false, false], 'fires turn 1, then every 3rd turn thereafter');
});

test('facilitatorNudge: cooldown counters are per-session — a second session is unaffected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-unit-'));
  const cfg = { facilitator_nudge_enabled: true, facilitator_context_threshold_tokens: 1000, facilitator_nudge_cooldown_turns: 5 };
  const t0 = now();
  assert.ok(facilitatorNudge('sA', 5000, cfg, t0, dir) !== null);
  assert.equal(facilitatorNudge('sA', 5000, cfg, t0 + 1, dir), null, 'sA is on cooldown');
  assert.ok(facilitatorNudge('sB', 5000, cfg, t0 + 1, dir) !== null, 'sB has never fired — unaffected by sA cooldown');
});

test('facilitatorNudge: disabled config → always null, regardless of context size or call count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-unit-'));
  const cfg = { facilitator_nudge_enabled: false, facilitator_context_threshold_tokens: 10, facilitator_nudge_cooldown_turns: 1 };
  for (let i = 0; i < 3; i++) assert.equal(facilitatorNudge('s1', 999999, cfg, now() + i, dir), null);
});

test('facilitatorNudge: never crashes on missing/garbage context tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-unit-'));
  const cfg = { facilitator_nudge_enabled: true, facilitator_context_threshold_tokens: 100, facilitator_nudge_cooldown_turns: 1 };
  for (const bad of [null, undefined, NaN, 'a lot', -5, 0, {}, [], Infinity, -Infinity]) {
    assert.doesNotThrow(() => facilitatorNudge('s1', bad, cfg, now(), dir));
    assert.equal(facilitatorNudge('s1', bad, cfg, now(), dir), null);
  }
});

test('facilitatorNudge: never crashes on missing/garbage config or session id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-unit-'));
  for (const badCfg of [null, undefined, {}, 'nope', 42]) {
    assert.doesNotThrow(() => facilitatorNudge('s1', 999999, badCfg, now(), dir));
  }
  const cfg = { facilitator_nudge_enabled: true, facilitator_context_threshold_tokens: 100, facilitator_nudge_cooldown_turns: 1 };
  assert.doesNotThrow(() => facilitatorNudge(undefined, 999999, cfg, now(), dir));
  assert.doesNotThrow(() => facilitatorNudge(null, 999999, cfg, now(), dir));
});

test('facilitatorNudge: a corrupt facilitator.json on disk never crashes — degrades to a clean first-sight read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-unit-'));
  writeFileSync(join(dir, 'facilitator.json'), '{ this is not json');
  const cfg = { facilitator_nudge_enabled: true, facilitator_context_threshold_tokens: 100, facilitator_nudge_cooldown_turns: 1 };
  // corrupt on-disk state is discarded (readJSON → null → treated as no history), so this
  // reads as first-sight for the session: above threshold still fires; it just never throws.
  let msg;
  assert.doesNotThrow(() => { msg = facilitatorNudge('s1', 999999, cfg, now(), dir); });
  assert.match(msg, /^facilitator context ~1000k\/turn/);
  // and the corrupt file was safely overwritten with valid JSON — a subsequent call still never throws
  assert.doesNotThrow(() => facilitatorNudge('s1', 999999, cfg, now(), dir));
});

// ── unit tests: readConfig defaults + sanitization (src/util.mjs) ───────────────────

test('readConfig: facilitator_* keys default, and sanitize bad hand-edited values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-cfg-'));
  const saved = process.env.TOKENROOM_DIR;
  process.env.TOKENROOM_DIR = dir;
  try {
    let cfg = readConfig();
    assert.equal(cfg.facilitator_nudge_enabled, true);
    assert.equal(cfg.facilitator_context_threshold_tokens, 50000);
    assert.equal(cfg.facilitator_nudge_cooldown_turns, 10);

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ facilitator_nudge_enabled: 'nope', facilitator_context_threshold_tokens: -5, facilitator_nudge_cooldown_turns: 0 }));
    cfg = readConfig();
    assert.equal(cfg.facilitator_nudge_enabled, true, 'bad type falls back to the safer default (on)');
    assert.equal(cfg.facilitator_context_threshold_tokens, 50000, 'a non-positive threshold falls back to default');
    assert.equal(cfg.facilitator_nudge_cooldown_turns, 10, 'a cooldown < 1 falls back to default');

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ facilitator_nudge_enabled: false, facilitator_context_threshold_tokens: 12345.6, facilitator_nudge_cooldown_turns: 2.9 }));
    cfg = readConfig();
    assert.equal(cfg.facilitator_nudge_enabled, false, 'a real boolean is honored');
    assert.equal(cfg.facilitator_context_threshold_tokens, 12345.6, 'any finite positive number is accepted verbatim');
    assert.equal(cfg.facilitator_nudge_cooldown_turns, 3, 'cooldown turns is rounded to an integer');

    for (const bad of [NaN, Infinity, -Infinity, null, 'x', [], {}]) {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ facilitator_context_threshold_tokens: bad }));
      assert.equal(readConfig().facilitator_context_threshold_tokens, 50000, `bad threshold ${JSON.stringify(bad)} falls back`);
    }
  } finally {
    if (saved === undefined) delete process.env.TOKENROOM_DIR;
    else process.env.TOKENROOM_DIR = saved;
  }
});

// ── integration tests: the UserPromptSubmit stamp (bin hook CLI) ────────────────────

function setupDir({ config, context = null, fhLeft = 90, session = 'fsess' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-int-'));
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const t = now();
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: t,
      session_id: session,
      windows: { five_hour: { used_pct: 100 - fhLeft, resets_at: t + 3600 } }, // healthy by default — quota stays silent (ADR-26), isolating the new lines
      context,
      burn: {},
      session: {},
    })
  );
  return dir;
}

const writeFlow = (dir, rows) => writeFileSync(join(dir, 'flow.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const stamp = (dir, session = 'fsess') => {
  const out = run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: session }), env: { TOKENROOM_DIR: dir } }).stdout;
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
};

test('integration: facilitator nudge fires when context size crosses the configured threshold', () => {
  const dir = setupDir({
    config: { facilitator_context_threshold_tokens: 40000, facilitator_nudge_cooldown_turns: 10 },
    context: { window_size: 200000, used_pct: 30, compact_ceiling_pct: 80 }, // 60000 tokens used ≥ 40000
  });
  const s = stamp(dir);
  assert.match(s, /facilitator context ~60k\/turn — consider handing off to a fresh session to reset context cost/);
});

test('integration: facilitator nudge stays silent below the configured threshold', () => {
  const dir = setupDir({
    config: { facilitator_context_threshold_tokens: 100000 },
    context: { window_size: 200000, used_pct: 30, compact_ceiling_pct: 80 }, // 60000 tokens < 100000
  });
  assert.doesNotMatch(stamp(dir), /facilitator context/);
});

test('integration: facilitator nudge is rate-limited across turns (cooldown)', () => {
  const dir = setupDir({
    config: { facilitator_context_threshold_tokens: 10000, facilitator_nudge_cooldown_turns: 3 },
    context: { window_size: 200000, used_pct: 30, compact_ceiling_pct: 80 }, // 60000 tokens, well above threshold every turn
  });
  const fired = [];
  for (let i = 0; i < 6; i++) fired.push(/facilitator context/.test(stamp(dir)));
  assert.deepEqual(fired, [true, false, false, true, false, false]);
});

test('integration: disabled → both the nudge and the burn-rate line are silent, rest of the stamp unaffected', () => {
  const dir = setupDir({
    config: { facilitator_nudge_enabled: false },
    context: { window_size: 200000, used_pct: 80, compact_ceiling_pct: 90 }, // would otherwise cross any sane threshold
  });
  writeFlow(dir, [{ t: now() - 100, out: 20000, s: 'fsess' }]); // would otherwise show a hot burn-rate line
  const s = stamp(dir);
  assert.doesNotMatch(s, /facilitator context/);
  assert.doesNotMatch(s, /burn — /);
  assert.match(s, /^\[tokenroom\] now /);
  assert.match(s, /context — /, 'the pre-existing context line is untouched by the new switch');
});

test('integration: never crashes when context/session/burn data is missing entirely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fac-int-'));
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ schema: 'resource-state/v0', updated_at: now(), session_id: 'fsess2', windows: { five_hour: { used_pct: 10, resets_at: now() + 3600 } } })
  );
  const result = run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'fsess2' }), env: { TOKENROOM_DIR: dir } });
  assert.equal(result.status, 0);
  const s = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(s, /facilitator context/);
  assert.doesNotMatch(s, /burn — /);
  assert.match(s, /^\[tokenroom\] now /);
});

test('integration: a corrupt facilitator.json on disk never crashes the hook', () => {
  const dir = setupDir({ context: { window_size: 200000, used_pct: 50, compact_ceiling_pct: 80 } });
  writeFileSync(join(dir, 'facilitator.json'), '{ not json');
  const result = run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'fsess' }), env: { TOKENROOM_DIR: dir } });
  assert.equal(result.status, 0);
});

test('integration: burn-rate segment surfaces this session\'s tok/min when flow data is meaningful', () => {
  const dir = setupDir();
  writeFlow(dir, [
    { t: now() - 300, out: 15000, s: 'fsess' },
    { t: now() - 100, out: 15000, s: 'fsess' },
  ]); // 30000 out-tokens / 10min = 3000/min
  assert.match(stamp(dir), /burn — ~3k tok\/min this session \(10m\)/);
});

test('integration: burn-rate segment stays silent below the meaningful floor', () => {
  const dir = setupDir();
  writeFlow(dir, [{ t: now() - 100, out: 200, s: 'fsess' }]); // 20/min — well under the floor
  assert.doesNotMatch(stamp(dir), /burn — /);
});

test('integration: burn-rate segment stays silent (not crashed) with no flow log at all', () => {
  const dir = setupDir();
  assert.doesNotMatch(stamp(dir), /burn — /);
});

test('integration: burn-rate segment only reflects THIS session — a concurrent hot burner is not co-attributed', () => {
  const dir = setupDir();
  writeFlow(dir, [
    { t: now() - 100, out: 60000, s: 'other-session' }, // 6000/min, not mine
    { t: now() - 100, out: 1500, s: 'fsess' }, // 150/min, mine
  ]);
  const s = stamp(dir);
  assert.match(s, /burn — ~150 tok\/min this session \(10m\)/);
  assert.doesNotMatch(s, /~6k tok\/min this session/);
});

test('integration: burn-rate segment and facilitator nudge can both appear in one stamp', () => {
  const dir = setupDir({ config: { facilitator_context_threshold_tokens: 40000 }, context: { window_size: 200000, used_pct: 30, compact_ceiling_pct: 80 } });
  writeFlow(dir, [{ t: now() - 100, out: 20000, s: 'fsess' }]); // 2000/min
  const s = stamp(dir);
  assert.match(s, /burn — ~2k tok\/min this session \(10m\)/);
  assert.match(s, /facilitator context ~60k\/turn — consider handing off to a fresh session to reset context cost/);
});
