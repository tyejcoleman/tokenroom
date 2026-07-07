import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey } from '../src/util.mjs';
import { bestOther, pairAdvice } from '../src/accounts.mjs';

// Multi-account profiles + instant switch awareness (ADR-24). The scenarios here replay
// the 2026-07-01 field capture: two real subscription accounts toggled via /login, the
// session's stamp quoting the OLD (dry) account for ~20 minutes while the new one sat at
// 98% — and the phase-bucket drift that spread 2 accounts over 4+ keys.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'tokenroom.mjs');

const run = (args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });

const now = () => Math.round(Date.now() / 1000);

// Two synthetic accounts with distinct reset PHASES (that is what accountKey hashes).
const winA = () => ({ five_hour: { used_percentage: 100, resets_at: now() + 900 }, seven_day: { used_percentage: 50, resets_at: now() + 2 * 86400 } });
const winB = () => ({ five_hour: { used_percentage: 2, resets_at: now() + 9000 }, seven_day: { used_percentage: 10, resets_at: now() + 5 * 86400 } });
const payload = (sessionId, rateLimits) => JSON.stringify({ session_id: sessionId, rate_limits: rateLimits });
const toKey = (rl) => accountKey({ five_hour: { resets_at: rl.five_hour.resets_at }, seven_day: { resets_at: rl.seven_day.resets_at } });

const stamp = (sid, env) => {
  const out = run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: sid }), env }).stdout;
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
};

test('field capture 2026-07-01: /login switch remaps in the SAME tap invocation; one-shot switch banner shows the NEW numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-switch-'));
  const env = { TOKENROOM_DIR: dir };
  // this test exercises quota RENDERING + switch/attribution, not the ADR-26 quiet gate —
  // hold that gate open (critical_pct 100 = always surface) so the render assertions stand
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ critical_pct: 100 }));
  const A = winA(); // the dry pre-switch account (0% left)
  const B = winB(); // the fresh post-switch account (98% left)

  run(['tap'], { input: payload('live', A), env });
  assert.equal(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).live.key, toKey(A));

  // the /login switch: the SAME session renders a payload keyed to account B
  run(['tap'], { input: payload('live', B), env });
  assert.equal(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).live.key, toKey(B), 'payload wins: remapped in that same tap invocation');
  const ev = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  assert.match(ev, /account_switch/);
  assert.match(ev, new RegExp(`"from":"${toKey(A)}","to":"${toKey(B)}"`));

  // next stamp: one-shot switch disclosure carrying B's numbers — never A's dry echo
  const s1 = stamp('live', env);
  assert.match(s1, new RegExp(`account switched — now on '${toKey(B)}': 5h 98% left, resets \\d\\d:\\d\\d`));
  assert.doesNotMatch(s1, /0% left/);

  // then normal stamps again (disclosure is one-shot)
  const s2 = stamp('live', env);
  assert.doesNotMatch(s2, /account switched/);
  assert.match(s2, /quota — 5h: 98% left/);

  // a SECOND switch — even inside the same second as the first announcement — must get
  // its own banner (the announce ref carries the destination key, not just a timestamp)
  const C = { five_hour: { used_percentage: 30, resets_at: now() + 5000 }, seven_day: { used_percentage: 20, resets_at: now() + 6 * 86400 } };
  run(['tap'], { input: payload('live', C), env });
  const s3 = stamp('live', env);
  assert.match(s3, new RegExp(`account switched — now on '${toKey(C)}': 5h 70% left`));
  assert.doesNotMatch(stamp('live', env), /account switched/);
});

test('echo honesty: a frozen dry figure with a values-fresher sibling is disclosed as a possible pre-switch echo, then recovers on the real switch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-echo-'));
  const env = { TOKENROOM_DIR: dir };
  // exercises echo/switch RENDERING, not the ADR-26 quiet gate — hold the gate open
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ critical_pct: 100 }));
  const A = winA();
  const B = winB();
  const keyA = toKey(A);
  const keyB = toKey(B);

  run(['tap'], { input: payload('live', A), env });
  // age the VALUES clock: the payload has been echoing these exact figures for 10 minutes
  const aPath = join(dir, 'accounts', keyA, 'state.json');
  const aState = JSON.parse(readFileSync(aPath, 'utf8'));
  aState.values_changed_at = now() - 600;
  writeFileSync(aPath, JSON.stringify(aState));

  // a sibling account produces values-newer data, and gets a profile label
  run(['tap'], { input: payload('other', B), env });
  run(['account', 'fold', keyB, 'fresh'], { env });

  // identical re-render for the live session: values unchanged → values_changed_at survives the tap
  run(['tap'], { input: payload('live', A), env });
  assert.equal(JSON.parse(readFileSync(aPath, 'utf8')).values_changed_at, aState.values_changed_at, 'unchanged values keep the old values_changed_at');

  const s1 = stamp('live', env);
  assert.match(s1, /5h: 0% left \(UNCHANGED for 10m — possibly a pre-switch echo/);
  assert.match(s1, /figures refresh on the next completed turn/);
  assert.match(s1, /profile 'fresh' last seen ≈98% left/);

  // the real switch lands: payload re-keys to B → remap + banner + confident figures
  run(['tap'], { input: payload('live', B), env });
  const s2 = stamp('live', env);
  assert.match(s2, /account switched — now on 'fresh': 5h 98% left/);
  assert.doesNotMatch(s2, /pre-switch echo/);
  const s3 = stamp('live', env);
  assert.match(s3, /quota — 5h: 98% left/);
  assert.doesNotMatch(s3, /UNCHANGED/);
});

test('profiles CLI: label current, fold, list, config-dir, switch table, run --dry-run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-prof-'));
  const env = { TOKENROOM_DIR: dir };
  const A = winA();
  const B = winB();
  const keyA = toKey(A);
  const keyB = toKey(B);

  run(['tap'], { input: payload('sessA', A), env });
  run(['tap'], { input: payload('sessB', B), env });

  // label = the most recent active account (top-level pointer): B
  assert.match(run(['account', 'label', 'fresh'], { env }).stdout, new RegExp(`labeled the current account ${keyB} as 'fresh'`));
  assert.match(run(['account', 'fold', keyA, 'dry'], { env }).stdout, new RegExp(`folded bucket ${keyA} into profile 'dry'`));

  const list = run(['account', 'list'], { env }).stdout;
  assert.match(list, /fresh\s+5h 98% left ↻\d\d:\d\d · 7d 90% left/);
  assert.match(list, /dry\s+5h 0% left ↻\d\d:\d\d/);
  assert.match(list, /as of moments ago/);
  assert.doesNotMatch(list, /unlabeled buckets/); // everything is folded

  run(['account', 'config-dir', 'fresh', '/tmp/claude-fresh'], { env });
  assert.match(run(['account', 'list'], { env }).stdout, /config-dir \/tmp\/claude-fresh/);

  // make 'dry' the active profile, then ask for the move
  run(['tap'], { input: payload('sessA', A), env });
  const sw = run(['switch'], { env }).stdout;
  assert.match(sw, /profile decision table/);
  assert.match(sw, /dry.*← active/);
  assert.match(sw, /recommended: switch to 'fresh' \(≈98% left, vs 'dry' active\)/);
  assert.match(sw, /run \/login inside Claude Code/);
  assert.match(sw, /CLAUDE_CONFIG_DIR=\/tmp\/claude-fresh claude/);

  // run: explicit profile, and max-headroom auto-pick, both dry-run (no real launch)
  assert.equal(run(['run', '--profile', 'fresh', '--dry-run'], { env }).stdout.trim(), 'CLAUDE_CONFIG_DIR=/tmp/claude-fresh claude');
  assert.equal(run(['run', '--dry-run'], { env }).stdout.trim(), 'CLAUDE_CONFIG_DIR=/tmp/claude-fresh claude');
  // a profile without a config dir explains itself instead of launching
  const r = run(['run', '--profile', 'dry', '--dry-run'], { env });
  assert.match(r.stdout, /has no config dir — set one: tokenroom account config-dir dry/);
});

test('pair-aware stamps: low active + fresh other → land-and-switch advice; both thin → defer wording stands; healthy → HUD-only alt line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-pair-'));
  const env = { TOKENROOM_DIR: dir };
  const A = winA();
  A.five_hour.used_percentage = 90; // 10% left — low, inside the pair-advice gate
  const B = winB(); // 98% left — the healthy other
  const keyA = toKey(A);
  const keyB = toKey(B);

  run(['tap'], { input: payload('sessA', A), env });
  run(['tap'], { input: payload('sessB', B), env });
  run(['account', 'fold', keyA, 'main'], { env });
  run(['account', 'fold', keyB, 'spare'], { env });

  // (a) active low, other fresh+healthy → power through, then switch — never throttle
  const low = stamp('sessA', env);
  assert.match(low, /profile 'spare' has ≈98% left \(as of moments ago\) — finish this unit at full speed, then switch \(\/login or `tokenroom switch`\) for zero downtime; defer only if BOTH profiles are thin/);

  // (c) healthy active → nothing about the pair in the MODEL stamp…
  const healthy = stamp('sessB', env);
  assert.doesNotMatch(healthy, /finish this unit/);
  assert.doesNotMatch(healthy, /profile 'main'/);
  // …but the human HUD carries the terse alt figure (switch-ready only when it's the move)
  const hudLow = run(['tap'], { input: payload('sessA', A), env }).stdout;
  assert.match(hudLow, /alt 'spare' ≈98% ⇄ switch-ready/);
  const hudHealthy = run(['tap'], { input: payload('sessB', B), env }).stdout;
  assert.match(hudHealthy, /alt 'main' ≈10%/);
  assert.doesNotMatch(hudHealthy, /switch-ready/);

  // (b) BOTH thin → the pair line disappears; today's defer/plan_resume wording stands
  const bPath = join(dir, 'accounts', keyB, 'state.json');
  const bState = JSON.parse(readFileSync(bPath, 'utf8'));
  bState.windows.five_hour.used_pct = 80; // 20% left < the 40% bar
  bState.updated_at = now() + 5;
  writeFileSync(bPath, JSON.stringify(bState));
  const bothThin = stamp('sessA', env);
  assert.doesNotMatch(bothThin, /finish this unit/);
  assert.match(bothThin, /quota — 5h: 10% left/);
});

test('pair-aware descent (mid-turn): low bands say switch instead of plan_resume; the 1% floor becomes land-and-switch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-descent-'));
  const env = { TOKENROOM_DIR: dir };
  const A = winA();
  A.five_hour.used_percentage = 50;
  A.five_hour.resets_at = now() + 3600; // far enough that the near-reset optimism stays out
  const B = winB();
  const keyA = toKey(A);
  const keyB = toKey(B);

  run(['tap'], { input: payload('sessA', A), env });
  run(['tap'], { input: payload('sessB', B), env });
  run(['account', 'fold', keyA, 'main'], { env });
  run(['account', 'fold', keyB, 'spare'], { env });

  const aPath = join(dir, 'accounts', keyA, 'state.json');
  const write = (usedPct) => {
    const s = JSON.parse(readFileSync(aPath, 'utf8'));
    s.windows.five_hour.used_pct = usedPct;
    s.updated_at = now();
    s.burn = {};
    writeFileSync(aPath, JSON.stringify(s));
  };
  const post = () => run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'sessA' }), env }).stdout;
  const age = () => {
    const bandsPath = join(dir, 'accounts', keyA, 'bands.json');
    const b = JSON.parse(readFileSync(bandsPath, 'utf8'));
    b.sessA.at = 0;
    b.sessA.u = null; // no receipt noise in the assertion
    writeFileSync(bandsPath, JSON.stringify(b));
  };

  post(); // baseline at 50% used
  write(96); // 4% left
  age();
  const mindful = post();
  assert.match(mindful, /4% left/);
  assert.match(mindful, /quota is low, but profile 'spare' has ≈98% left .* finish this unit at full speed, then switch/);
  assert.doesNotMatch(mindful, /plan_resume/);

  write(99.5); // ≤1% floor
  age();
  const floor = post();
  assert.match(floor, /land and switch: commit in-flight work, checkpoint, then switch to profile 'spare'/);
  assert.match(floor, /zero downtime, no defer needed/);
  assert.doesNotMatch(floor, /finishing moves only/);
});

test("fold heuristic: a new bucket right after a labeled profile's window expired is suggested — and never mistaken for a switch target", () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fold-'));
  const env = { TOKENROOM_DIR: dir };

  // labeled profile 'work' whose only bucket's 5h window expired 5 minutes ago
  const oldKey = 'a0ldbucket0';
  mkdirSync(join(dir, 'accounts', oldKey), { recursive: true });
  writeFileSync(
    join(dir, 'accounts', oldKey, 'state.json'),
    JSON.stringify({ updated_at: now() - 900, windows: { five_hour: { used_pct: 95, resets_at: now() - 300 } } })
  );
  run(['account', 'fold', oldKey, 'work'], { env });

  // the same physical account comes back under a NEW phase bucket, running low
  const N = { five_hour: { used_percentage: 90, resets_at: now() + 4000 }, seven_day: { used_percentage: 30, resets_at: now() + 4 * 86400 } };
  run(['tap'], { input: payload('sessN', N), env });
  const newKey = toKey(N);

  const list = run(['account', 'list'], { env }).stdout;
  assert.match(list, new RegExp(`hint: new bucket ${newKey} is probably 'work' — fold with: tokenroom account fold ${newKey} work`));

  // the pair advisor must NOT tell this session to "switch" to what is probably itself,
  // even though 'work' looks reset-fresh and the active window is low (10% left)
  const s = stamp('sessN', env);
  assert.doesNotMatch(s, /finish this unit/);
  assert.match(s, /quota — 5h: 10% left/);

  // doctor surfaces the same assist
  assert.match(run(['doctor', '--config-dir', join(dir, 'nocfg')], { env }).stdout, new RegExp(`new bucket ${newKey} is probably 'work'`));
});

test('same-account 5h rollover after an idle gap is NOT a /login switch: no banner, label follows the account (ADR-24)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-rollover-'));
  const env = { TOKENROOM_DIR: dir };
  const t = now();
  // account 'main' first seen with a 5h window that has ALREADY reset (idle account)
  const A1 = { five_hour: { used_percentage: 80, resets_at: t - 300 }, seven_day: { used_percentage: 40, resets_at: t + 3 * 86400 } };
  run(['tap'], { input: payload('live', A1), env });
  const key1 = toKey(A1);
  run(['account', 'fold', key1, 'main'], { env });

  // the SAME physical account comes back on a NEW 5h phase (new key) — SAME weekly phase
  const A2 = { five_hour: { used_percentage: 3, resets_at: t + 9000 }, seven_day: { used_percentage: 41, resets_at: t + 3 * 86400 } };
  run(['tap'], { input: payload('live', A2), env });
  const key2 = toKey(A2);
  assert.notEqual(key1, key2, 'idle re-phasing mints a new bucket key');

  const ev = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(ev, /account_switch/, 'a same-account rollover must not log account_switch');
  assert.match(ev, /account_rollover/);

  // the label followed the account across the phase change (auto-fold), so identity sticks
  const profiles = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8')).profiles;
  assert.ok(profiles.main.keys.includes(key2), 'the new bucket auto-folds into the same profile');

  // and the next stamp does NOT announce a bogus "account switched"
  assert.doesNotMatch(stamp('live', env), /account switched/);

  // CONTROL: a real /login to a live account (old window not yet reset) still fires the switch
  const dir2 = mkdtempSync(join(tmpdir(), 'tr-realswitch-'));
  const env2 = { TOKENROOM_DIR: dir2 };
  const L = { five_hour: { used_percentage: 100, resets_at: t + 1200 }, seven_day: { used_percentage: 50, resets_at: t + 2 * 86400 } }; // window still live
  const M = { five_hour: { used_percentage: 2, resets_at: t + 9000 }, seven_day: { used_percentage: 10, resets_at: t + 5 * 86400 } };
  run(['tap'], { input: payload('live', L), env: env2 });
  run(['tap'], { input: payload('live', M), env: env2 });
  assert.match(readFileSync(join(dir2, 'events.jsonl'), 'utf8'), /account_switch/, 'a genuine /login (old window live) still fires the switch');
});

test('bestOther never recommends the reset-inferred profile the unlabeled active key may BE — even while another profile is active (ADR-24)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-bestother-'));
  process.env.TOKENROOM_DIR = dir;
  const t = now();
  const state = (key, obj) => {
    mkdirSync(join(dir, 'accounts', key), { recursive: true });
    writeFileSync(join(dir, 'accounts', key, 'state.json'), JSON.stringify(obj));
  };

  // profile 'A': its only bucket's 5h window reset 2h ago — "freshness" is reset-INFERRED
  const keyA = 'aAAAAAAAAA';
  state(keyA, { updated_at: t - 2 * 3600, windows: { five_hour: { used_pct: 88, resets_at: t - 2 * 3600 }, seven_day: { used_pct: 30, resets_at: t + 3 * 86400 } } });
  // profile 'B': active (last_seen fresh) with LIVE data (no reset inference), 50% left
  const keyB = 'aBBBBBBBBB';
  state(keyB, { updated_at: t - 30, windows: { five_hour: { used_pct: 50, resets_at: t + 4000 }, seven_day: { used_pct: 20, resets_at: t + 5 * 86400 } } });
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ profiles: {
    A: { keys: [keyA], last_seen: t - 2 * 3600 },
    B: { keys: [keyB], last_seen: t - 30 }, // active in the last 10 min → old code's suggestFold went silent → no self-exclusion
  } }));

  // the re-login to physical A lands on a NEW unlabeled bucket K at 12% left
  const keyK = 'aKKKKKKKKK';
  state(keyK, { updated_at: t, windows: { five_hour: { used_pct: 88, resets_at: t + 8000 }, seven_day: { used_pct: 30, resets_at: t + 3 * 86400 } } });

  const best = bestOther(keyK, t);
  assert.equal(best?.label, 'B', 'recommends the live-data profile, not the reset-inferred one the session may already be on');
  const pa = pairAdvice(keyK, 12, t);
  assert.ok(pa && pa.other.label === 'B', 'pair advice points at B');
  assert.notEqual(pa.other.label, 'A', 'must never advise switching to the profile the unlabeled active key probably is');
});
