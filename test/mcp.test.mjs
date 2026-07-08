import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'tokenroom.mjs');

// newline-delimited JSON-RPC client harness for one spawned `tokenroom mcp` server
function mcpClient(env) {
  const child = spawn(process.execPath, [bin, 'mcp'], { env: { ...process.env, ...env } });
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
  return { child, next, send };
}

test('mcp: initialize → tools/list → fit_check round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-mcp-'));
  spawnSync(process.execPath, [bin, 'tap'], {
    input: readFileSync(join(root, 'test', 'fixtures', 'statusline-full.json'), 'utf8'),
    env: { ...process.env, TOKENROOM_DIR: dir },
  });

  const child = spawn(process.execPath, [bin, 'mcp'], { env: { ...process.env, TOKENROOM_DIR: dir } });
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
    const init = await next();
    assert.equal(init.result.serverInfo.name, 'tokenroom');

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await next();
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['checkpoint', 'estimate_remaining', 'fit_check', 'handoff', 'pin_fact', 'plan_resume', 'resource_state', 'set_intent', 'tokenroom_weekly_warning']);

    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fit_check', arguments: { est_tokens: 5000 } } });
    const fit = await next();
    const result = JSON.parse(fit.result.content[0].text);
    assert.equal(result.overall, 'fits');
    assert.equal(result.window.pct_left, 57.5);

    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'resource_state', arguments: {} } });
    const state = await next();
    assert.equal(JSON.parse(state.result.content[0].text).schema, 'resource-state/v0');

    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'plan_resume', arguments: { summary: 'resume the big refactor', est_tokens: 30000 } } });
    const planned = JSON.parse((await next()).result.content[0].text);
    assert.equal(planned.recorded, true);
    assert.equal(typeof planned.resume_at_clock, 'string');

    send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'handoff', arguments: { mission: 'ship continuity handoff', next_steps: ['run the suite'], references: ['src/continuity.mjs'] } },
    });
    const handoff = JSON.parse((await next()).result.content[0].text);
    assert.equal(handoff.saved, true);
    assert.ok(handoff.path && readFileSync(handoff.path, 'utf8').includes('ship continuity handoff'));
  } finally {
    child.kill();
  }
});

test('mcp: per-account resolution — one active account routes to IT (not the pointer); two active → quota withheld with explicit attribution (ADR-21/ADR-24)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenroom-mcp-acct-'));
  const now = Math.round(Date.now() / 1000);
  const state = (usedPct) => ({
    schema: 'resource-state/v0',
    updated_at: now,
    provider: 'anthropic',
    session_id: null,
    windows: { five_hour: { used_pct: usedPct, resets_at: now + 3600 } },
    context: null,
    burn: { pct_per_hour: null, projected_exhaustion: null },
    session: {},
  });
  mkdirSync(join(dir, 'accounts', 'aone'), { recursive: true });
  mkdirSync(join(dir, 'accounts', 'atwo'), { recursive: true });
  writeFileSync(join(dir, 'accounts', 'aone', 'state.json'), JSON.stringify(state(10)));
  writeFileSync(join(dir, 'accounts', 'atwo', 'state.json'), JSON.stringify(state(90)));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state(90))); // pointer = the OTHER account
  // account "aone" active now; "atwo" last seen 20 min ago (outside the ambiguity window)
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ s1: { key: 'aone', at: now }, s2: { key: 'atwo', at: now - 1200 } }));

  const { child, next, send } = mcpClient({ TOKENROOM_DIR: dir });
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    await next();

    // exactly one recently-active account → its numbers, NOT the top-level pointer's
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'resource_state', arguments: {} } });
    const single = JSON.parse((await next()).result.content[0].text);
    assert.equal(single.windows.five_hour.used_pct, 10, "routes to the active account, not the last-writer pointer");
    assert.equal(single.attribution, undefined);

    // two accounts active in the last 10 min → ambiguous: withhold quota, say so explicitly
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ s1: { key: 'aone', at: now }, s2: { key: 'atwo', at: now } }));
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'resource_state', arguments: {} } });
    const ambiguous = JSON.parse((await next()).result.content[0].text);
    assert.match(ambiguous.attribution, /^ambiguous — quota withheld/);
    assert.deepEqual(ambiguous.windows, {});
    assert.equal(ambiguous.burn.pct_per_hour, null);

    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'estimate_remaining', arguments: {} } });
    const est = JSON.parse((await next()).result.content[0].text);
    assert.match(est.attribution, /^ambiguous — quota withheld/);
    assert.equal(est.five_hour, null);

    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fit_check', arguments: { est_tokens: 5000 } } });
    const fit = JSON.parse((await next()).result.content[0].text);
    assert.match(fit.attribution, /^ambiguous — quota withheld/);
    assert.equal(fit.window, null); // no wrong-account verdict, ever
  } finally {
    child.kill();
  }
});
