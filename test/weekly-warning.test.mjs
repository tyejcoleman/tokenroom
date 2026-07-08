import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ADR-27: `weekly_warning` ('on' default | 'off' | 'auto') gates ONLY the 7d/weekly line
// in the UserPromptSubmit stamp. 'on' must be byte-identical to pre-ADR-27 behavior;
// 'off' must never show it; 'auto' (opt-in) suppresses it while a belay loop is
// armed-and-active for the current session, otherwise behaves like 'on'.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'tokenroom.mjs');
const now = () => Math.round(Date.now() / 1000);

const run = (args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });

function setupDir({ config } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tr-weekwarn-'));
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const t = now();
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: t,
      session_id: 'wksess',
      windows: {
        five_hour: { used_pct: 30, resets_at: t + 3600 }, // 70% left, below critical_pct: silent
        seven_day: { used_pct: 92, resets_at: t + 2 * 86400 }, // 8% left — well under the 20% disclose gate
      },
      context: null,
      burn: { weekly: { pace_ratio: 1.4, daily_allowance_pct: 3, projected_exhaustion: t + 86400, hot: true } },
      session: {},
    })
  );
  return dir;
}

// isolate belay lookups from the real machine's ~/.belay in every test here
function isolatedBelayEnv(loops) {
  const bdir = mkdtempSync(join(tmpdir(), 'tr-weekwarn-belay-'));
  mkdirSync(bdir, { recursive: true });
  if (loops !== undefined) writeFileSync(join(bdir, 'loops.json'), JSON.stringify(loops));
  return { BELAY_DIR: bdir };
}

const stamp = (dir, env = {}) => {
  const out = run(['hook', 'user-prompt-submit'], {
    input: JSON.stringify({ session_id: 'wksess' }),
    env: { TOKENROOM_DIR: dir, ...isolatedBelayEnv(undefined), ...env },
  }).stdout;
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
};

test('config: weekly_warning defaults to "on" when config.json is absent', () => {
  const dir = setupDir();
  const s = stamp(dir);
  assert.match(s, /7d: 8% left/, 'default mode shows the weekly line exactly like pre-ADR-27');
  assert.match(s, /weekly pace is HOT/);
});

test('config: a bad/missing weekly_warning value sanitizes to "on" (never silently swallowed)', () => {
  for (const bad of ['nope', 42, null, {}, ['on'], '']) {
    const dir = setupDir({ config: { weekly_warning: bad } });
    assert.match(stamp(dir), /7d: 8% left/, `bad value ${JSON.stringify(bad)} must fall back to 'on'`);
  }
});

test('mode "on": byte-identical to pre-ADR-27 weekly-line text (explicit on == default on)', () => {
  const dirDefault = setupDir();
  const dirExplicit = setupDir({ config: { weekly_warning: 'on' } });
  assert.equal(stamp(dirDefault), stamp(dirExplicit));
  assert.match(stamp(dirExplicit), /7d: 8% left — weekly pace is HOT \(1\.4x sustainable\)/);
});

test('mode "off": weekly line never emitted, even when HOT and well under the 20% disclose gate', () => {
  const dir = setupDir({ config: { weekly_warning: 'off' } });
  const s = stamp(dir);
  assert.doesNotMatch(s, /7d:|weekly pace is HOT/);
  // everything else (wall clock) still present — off is scoped to the weekly line only
  assert.match(s, /^\[tokenroom\] now /);
});

test('mode "auto" + loop ARMED and ACTIVE for this session → weekly suppressed', () => {
  const dir = setupDir({ config: { weekly_warning: 'auto' } });
  const s = stamp(dir, isolatedBelayEnvWithLoop());
  assert.doesNotMatch(s, /7d:|weekly pace is HOT/);

  function isolatedBelayEnvWithLoop() {
    const bdir = mkdtempSync(join(tmpdir(), 'tr-weekwarn-belay-active-'));
    writeFileSync(join(bdir, 'loops.json'), JSON.stringify({ loops: { g1: { armed: true, paused: false, session_id: 'wksess' } } }));
    return { BELAY_DIR: bdir };
  }
});

test('mode "auto" + no belay loop at all → weekly shown (behaves like "on")', () => {
  const dir = setupDir({ config: { weekly_warning: 'auto' } });
  const s = stamp(dir); // isolatedBelayEnv(undefined) → no loops.json written at all
  assert.match(s, /7d: 8% left/);
  assert.match(s, /weekly pace is HOT/);
});

test('mode "auto" + a loop exists for this session but is PAUSED → weekly still shown', () => {
  const dir = setupDir({ config: { weekly_warning: 'auto' } });
  const bdir = mkdtempSync(join(tmpdir(), 'tr-weekwarn-belay-paused-'));
  writeFileSync(join(bdir, 'loops.json'), JSON.stringify({ loops: { g1: { armed: true, paused: true, session_id: 'wksess' } } }));
  const s = stamp(dir, { BELAY_DIR: bdir });
  assert.match(s, /7d: 8% left/);
});

test('mode "auto" + a loop is active but for a DIFFERENT session → weekly still shown (never cross-session)', () => {
  const dir = setupDir({ config: { weekly_warning: 'auto' } });
  const bdir = mkdtempSync(join(tmpdir(), 'tr-weekwarn-belay-other-'));
  writeFileSync(join(bdir, 'loops.json'), JSON.stringify({ loops: { g1: { armed: true, paused: false, session_id: 'a-totally-different-session' } } }));
  const s = stamp(dir, { BELAY_DIR: bdir });
  assert.match(s, /7d: 8% left/);
});

test('mode "auto" + garbled ~/.belay/loops.json (corrupt JSON) → never crashes, weekly still shown', () => {
  const dir = setupDir({ config: { weekly_warning: 'auto' } });
  const bdir = mkdtempSync(join(tmpdir(), 'tr-weekwarn-belay-garbage-'));
  writeFileSync(join(bdir, 'loops.json'), '{ this is not json');
  const result = run(['hook', 'user-prompt-submit'], {
    input: JSON.stringify({ session_id: 'wksess' }),
    env: { TOKENROOM_DIR: dir, BELAY_DIR: bdir },
  });
  assert.equal(result.status, 0, 'hook exits 0 even with a garbled belay install');
  const s = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(s, /7d: 8% left/);
});

test('mode "auto" + BELAY_DIR pointing at a nonexistent path (belay not installed) → never crashes, weekly shown', () => {
  const dir = setupDir({ config: { weekly_warning: 'auto' } });
  const result = run(['hook', 'user-prompt-submit'], {
    input: JSON.stringify({ session_id: 'wksess' }),
    env: { TOKENROOM_DIR: dir, BELAY_DIR: '/tmp/tr-weekwarn-does-not-exist-xyz' },
  });
  assert.equal(result.status, 0);
  const s = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(s, /7d: 8% left/);
});

test('the 5h/quota line (ADR-26) is untouched by weekly_warning: "off" only silences the weekly line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-weekwarn-5h-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ weekly_warning: 'off' }));
  const t = now();
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: t,
      session_id: 'wksess',
      windows: { five_hour: { used_pct: 92, resets_at: t + 3600 }, seven_day: { used_pct: 92, resets_at: t + 2 * 86400 } }, // 8% left both
      context: null,
      burn: {},
      session: {},
    })
  );
  const s = stamp(dir);
  assert.match(s, /quota — 5h: 8% left/, 'the separate 5h line is unaffected by weekly_warning');
  assert.doesNotMatch(s, /7d:/, 'the weekly line stays off');
});

test('MCP tool tokenroom_weekly_warning: sets and persists each mode, returned in tools/list', async () => {
  const { createInterface } = await import('node:readline');
  const dir = mkdtempSync(join(tmpdir(), 'tr-weekwarn-mcp-'));
  const child = (await import('node:child_process')).spawn(process.execPath, [bin, 'mcp'], { env: { ...process.env, TOKENROOM_DIR: dir } });
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  const waiters = [];
  lines.on('line', (l) => {
    const w = waiters.shift();
    if (w) w(JSON.parse(l));
    else pending.push(JSON.parse(l));
  });
  const next = () =>
    new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('mcp response timeout')), 5000);
      const done = (v) => { clearTimeout(t); res(v); };
      if (pending.length) done(pending.shift());
      else waiters.push(done);
    });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    await next();

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await next();
    const tool = list.result.tools.find((t) => t.name === 'tokenroom_weekly_warning');
    assert.ok(tool, 'tokenroom_weekly_warning is registered');
    assert.deepEqual(tool.inputSchema.properties.mode.enum.sort(), ['auto', 'off', 'on']);

    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tokenroom_weekly_warning', arguments: { mode: 'auto' } } });
    const r1 = JSON.parse((await next()).result.content[0].text);
    assert.equal(r1.set, true);
    assert.equal(r1.mode, 'auto');
    assert.equal(typeof r1.summary, 'string');
    assert.ok(r1.summary.length > 0);

    // persisted to config.json on disk
    const cfgOnDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(cfgOnDisk.weekly_warning, 'auto');

    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tokenroom_weekly_warning', arguments: { mode: 'off' } } });
    const r2 = JSON.parse((await next()).result.content[0].text);
    assert.equal(r2.mode, 'off');
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).weekly_warning, 'off');

    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'tokenroom_weekly_warning', arguments: { mode: 'on' } } });
    const r3 = JSON.parse((await next()).result.content[0].text);
    assert.equal(r3.mode, 'on');
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).weekly_warning, 'on');

    // invalid mode → rejected, does not overwrite the persisted value
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'tokenroom_weekly_warning', arguments: { mode: 'bogus' } } });
    const r4 = JSON.parse((await next()).result.content[0].text);
    assert.equal(r4.set, false);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).weekly_warning, 'on', 'unchanged by the rejected call');
  } finally {
    child.kill();
  }
});
