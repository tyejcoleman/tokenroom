import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'tokenroom.mjs');

const run = (args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function makeTranscript(dir) {
  const lines = [
    { type: 'user', message: { content: 'build the auth flow on port 4731' } },
    { type: 'user', isMeta: true, message: { content: '<command-name>/compact</command-name>' } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'Error: ECONNREFUSED 127.0.0.1:4731 — exact stack here' }] }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } },
    'this line is not json',
    { type: 'user', message: { content: [{ type: 'text', text: 'no promo until June 16' }] } },
  ];
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}

test('T2.6: pre-compact extracts user messages + tool errors; injection carries pointers, not payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-t26-'));
  const env = { TOKENROOM_DIR: dir };
  const tp = makeTranscript(dir);

  run(['hook', 'pre-compact'], {
    input: JSON.stringify({ session_id: 's6', cwd: dir, trigger: 'manual', transcript_path: tp, custom_instructions: 'focus on auth' }),
    env,
  });

  const ex = JSON.parse(readFileSync(join(dir, 'handoffs', 's6.extracts.json'), 'utf8'));
  assert.equal(ex.user_messages.length, 2); // harness/meta messages excluded
  assert.match(ex.user_messages[0], /port 4731/);
  assert.match(ex.user_messages[1], /no promo until June 16/);
  assert.match(ex.tool_errors[0], /ECONNREFUSED/);

  const ctx = JSON.parse(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 's6', source: 'compact' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, new RegExp(esc(tp)));
  assert.match(ctx, /verbatim extracts/);
  assert.match(ctx, /focus on auth/);
  assert.match(ctx, /search the transcript/);
  assert.doesNotMatch(ctx, /ECONNREFUSED/); // ADR-11: pointer, never bulk content
});

test('T2.6: pre-compact survives a missing/garbage transcript path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-t26b-'));
  const env = { TOKENROOM_DIR: dir };
  const r = run(['hook', 'pre-compact'], {
    input: JSON.stringify({ session_id: 's6b', cwd: dir, transcript_path: join(dir, 'nope.jsonl') }),
    env,
  });
  assert.equal(r.status, 0);
  const snap = JSON.parse(readFileSync(join(dir, 'handoffs', 's6b.json'), 'utf8'));
  assert.equal(snap.extracts_path, null);
});

test('T2.7: pin lifecycle — add/list, verbatim re-injection only at compact, unpin, TTL expiry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-t27-'));
  const env = { TOKENROOM_DIR: dir };

  const out = run(['pin', 'no promo until June 16'], { env }).stdout;
  const id = out.match(/pinned (\w+)/)[1];
  assert.match(run(['pins'], { env }).stdout, /no promo until June 16/);

  const ctx = JSON.parse(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'p1', source: 'compact' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, /pinned facts/);
  assert.match(ctx, /no promo until June 16/);
  // pins are compaction-survival, not general boot context
  assert.equal(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'p1', source: 'startup' }), env }).stdout, '');

  assert.match(run(['unpin', id], { env }).stdout, /removed 1/);
  assert.match(run(['pins'], { env }).stdout, /no pins/);

  writeFileSync(join(dir, 'pins.json'), JSON.stringify([{ id: 'x', text: 'expired pin', created_at: 1, expires_at: 2 }]));
  assert.match(run(['pins'], { env }).stdout, /no pins/);
});

test('T2.9: silent context cliff → logged, disclosed once in next stamp, then quiet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-t29-'));
  const env = { TOKENROOM_DIR: dir };
  const now = Math.round(Date.now() / 1000);
  const payload = (used) =>
    JSON.stringify({
      session_id: 'd1',
      rate_limits: { five_hour: { used_percentage: 50, resets_at: now + 3600 } },
      context_window: { context_window_size: 200000, used_percentage: used },
    });

  run(['tap'], { input: payload(60), env });
  run(['tap'], { input: payload(20), env }); // 40-point cliff, nothing explains it
  assert.match(readFileSync(join(dir, 'events.jsonl'), 'utf8'), /context_drop/);

  const stamp = JSON.parse(run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'd1' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(stamp, /context shrank ~80k tokens/);
  const stamp2 = JSON.parse(run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'd1' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.doesNotMatch(stamp2, /context shrank/); // announce once
});

test('T2.9: a cliff right after a real compaction is explained, not flagged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-t29b-'));
  const env = { TOKENROOM_DIR: dir };
  const payload = (used) =>
    JSON.stringify({ session_id: 'd2', context_window: { context_window_size: 200000, used_percentage: used } });

  run(['tap'], { input: payload(60), env });
  run(['hook', 'pre-compact'], { input: JSON.stringify({ session_id: 'd2', cwd: dir }), env });
  run(['tap'], { input: payload(10), env });
  assert.doesNotMatch(readFileSync(join(dir, 'events.jsonl'), 'utf8'), /context_drop/);
  // post-compact hook logs too
  run(['hook', 'post-compact'], { input: JSON.stringify({ session_id: 'd2', trigger: 'auto' }), env });
  assert.match(readFileSync(join(dir, 'events.jsonl'), 'utf8'), /post_compact/);
});

test('T2.10: compact guard blocks auto near reset only — never manual, never far from reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-t210-'));
  const env = { TOKENROOM_DIR: dir };
  const now = Math.round(Date.now() / 1000);
  const state = (resetsIn) =>
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: now,
      windows: { five_hour: { used_pct: 80, resets_at: now + resetsIn } },
      context: null,
      burn: {},
      session: {},
    });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ compact_guard_min: 20 }));

  writeFileSync(join(dir, 'state.json'), state(600)); // reset in 10m
  const blocked = run(['hook', 'pre-compact'], { input: JSON.stringify({ session_id: 'g1', cwd: dir, trigger: 'auto' }), env });
  assert.match(blocked.stdout, /"decision":"block"/);
  assert.match(blocked.stdout, /compact guard/);
  assert.ok(!existsSync(join(dir, 'handoffs', 'g1.json'))); // blocked → no snapshot

  const manual = run(['hook', 'pre-compact'], { input: JSON.stringify({ session_id: 'g2', cwd: dir, trigger: 'manual' }), env });
  assert.doesNotMatch(manual.stdout, /block/);
  assert.ok(existsSync(join(dir, 'handoffs', 'g2.json')));

  writeFileSync(join(dir, 'state.json'), state(7200)); // reset in 2h
  const far = run(['hook', 'pre-compact'], { input: JSON.stringify({ session_id: 'g3', cwd: dir, trigger: 'auto' }), env });
  assert.doesNotMatch(far.stdout, /block/);
  assert.ok(existsSync(join(dir, 'handoffs', 'g3.json')));
});

test('T2.8: install adds removable Compact Instructions + PostCompact hook; uninstall restores', () => {
  const cfg = mkdtempSync(join(tmpdir(), 'hr-t28-'));
  writeFileSync(join(cfg, 'CLAUDE.md'), '# my stuff\n');

  run(['install', '--config-dir', cfg]);
  const md = readFileSync(join(cfg, 'CLAUDE.md'), 'utf8');
  assert.match(md, /# my stuff/);
  assert.match(md, /## Compact Instructions/);
  const settings = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.PostCompact);

  run(['install', '--config-dir', cfg]); // idempotent
  assert.equal((readFileSync(join(cfg, 'CLAUDE.md'), 'utf8').match(/## Compact Instructions/g) || []).length, 1);

  run(['uninstall', '--config-dir', cfg]);
  const md2 = readFileSync(join(cfg, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(md2, /Compact Instructions/);
  assert.match(md2, /# my stuff/);
  assert.ok(!JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8')).hooks);
});

test('T2.11: post-tool-use re-stamps on worsening band crossings only — throttled, improvements silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-t211-'));
  const env = { TOKENROOM_DIR: dir };
  const now = () => Math.round(Date.now() / 1000);
  const write = (usedPct) =>
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schema: 'resource-state/v0',
        updated_at: now(),
        session_id: 'm1',
        windows: { five_hour: { used_pct: usedPct, resets_at: now() + 3600 } },
        context: null,
        burn: {},
        session: {},
      })
    );
  const post = () => run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'm1' }), env }).stdout;

  write(70);
  assert.equal(post(), ''); // first sight: baseline only — the turn-start stamp covered it
  write(80);
  const out = post();
  assert.match(out, /mid-task update/);
  assert.match(out, /20% left/);
  assert.equal(post(), ''); // same band: silent
  write(92);
  const held = post(); // worse band inside the 120s throttle — band text held...
  assert.doesNotMatch(held, /5h window now/);
  assert.match(held, /receipt/); // ...but a 12-point single-call jump earns a receipt (own floor, no throttle)
  const bands = JSON.parse(readFileSync(join(dir, 'bands.json'), 'utf8'));
  bands.m1.at = 0; // age the throttle
  writeFileSync(join(dir, 'bands.json'), JSON.stringify(bands));
  assert.match(post(), /8% left.*full speed/); // ADR-19: 5–100% is full speed now
  write(60);
  assert.equal(post(), ''); // improvement: always silent
});

test('ADR-19 descent ladder: full speed >5%, mindful 1–5%, finishing-moves ≤1%', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-descent-'));
  const env = { TOKENROOM_DIR: dir };
  const now = () => Math.round(Date.now() / 1000);
  const write = (usedPct) =>
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schema: 'resource-state/v0',
        updated_at: now(),
        session_id: 'd1',
        windows: { five_hour: { used_pct: usedPct, resets_at: now() + 3600 } },
        context: null,
        burn: {},
        session: {},
      })
    );
  const post = () => run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'd1' }), env }).stdout;
  const age = () => {
    const b = JSON.parse(readFileSync(join(dir, 'bands.json'), 'utf8'));
    b.d1.at = 0;
    writeFileSync(join(dir, 'bands.json'), JSON.stringify(b));
  };

  write(50);
  post(); // baseline
  write(93);
  age();
  assert.match(post(), /7% left.*full speed/); // >5% → full speed, no caution
  write(96);
  age();
  assert.match(post(), /4% left.*be mindful of velocity.*checkpoint often/); // 1–5% → mindful + stranding guard
  write(99);
  age();
  assert.match(post(), /1% left.*finishing moves only/); // ≤1% floor
});

test('audit: renders the awareness timeline with steering-signal counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-audit-'));
  const env = { TOKENROOM_DIR: dir };
  const now = Math.round(Date.now() / 1000);
  const evs = [
    { at: now - 300, type: 'stamp', fh_left: 13, ctx_tokens: 600000 },
    { at: now - 240, type: 'mcp_call', tool: 'fit_check', verdict: 'defer' },
    { at: now - 230, type: 'mcp_call', tool: 'plan_resume', verdict: 'recorded' },
    { at: now - 120, type: 'band_change', emitted: true, fh_left: 9, exh: true },
    { at: now - 60, type: 'stamp_skipped', reason: 'stale_state' },
  ];
  writeFileSync(join(dir, 'events.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const out = run(['audit'], { env }).stdout;
  assert.match(out, /stamp {4}injected: 5h 13% left · ctx ~600k/);
  assert.match(out, /consult {2}fit_check → defer/);
  assert.match(out, /update injected \(5h 9% left, exhaustion projected\)/);
  assert.match(out, /skipped \(stale_state\)/);
  assert.match(out, /steering signals: 1 stamps · 1 mid-task updates · 2 consults \(fit_check defer\/tight\/fits: 1\/0\/0\) · 1 defers recorded · 0 pins/);
});

test('audit: stamps and MCP consults are logged automatically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-audit2-'));
  const env = { TOKENROOM_DIR: dir };
  const now = Math.round(Date.now() / 1000);
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: now,
      session_id: 'a1',
      windows: { five_hour: { used_pct: 40, resets_at: now + 3600 } },
      context: null,
      burn: {},
      session: {},
    })
  );
  run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'a1' }), env });
  const req = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  run(['mcp'], { input: req(1, 'tools/call', { name: 'fit_check', arguments: { est_tokens: 5000 } }), env });
  const out = run(['audit'], { env }).stdout;
  assert.match(out, /stamp {4}injected: 5h 60% left/);
  assert.match(out, /consult {2}fit_check → fits/);
});

test('pin_fact via the MCP server works without any ResourceState', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-mcp-pin-'));
  const env = { TOKENROOM_DIR: dir };
  const req = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  const out = run(['mcp'], {
    input:
      req(1, 'initialize', { protocolVersion: '2025-06-18' }) +
      req(2, 'tools/call', { name: 'pin_fact', arguments: { text: 'never run migrations on prod' } }),
    env,
  }).stdout;
  const resp = out
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((m) => m.id === 2);
  const body = JSON.parse(resp.result.content[0].text);
  assert.equal(body.pinned, true);
  assert.match(run(['pins'], { env }).stdout, /never run migrations on prod/);
});

test('T2.12: checkpoint lifecycle — save via MCP, re-inject after compact, staleness + wrong-session guards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-ck-'));
  const env = { TOKENROOM_DIR: dir };
  const req = (id, name, args) =>
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n';
  const out = run(['mcp'], {
    input: req(1, 'checkpoint', {
      task: 'migrate auth to RS256',
      state: 'token.js done, middleware half-rewritten',
      decisions: ['wrap HS256 not replace — rollout safety'],
      rejected: ['jsonwebtoken v8 upgrade — breaks node 18'],
      next_steps: ['finish middleware.js:88 verify()', 'run auth tests'],
      key_values: { port: 4731 },
    }),
    env,
  }).stdout;
  assert.match(out, /Checkpoint saved/);

  const ctx = JSON.parse(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'any', source: 'compact' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, /your own pre-compaction checkpoint/);
  assert.match(ctx, /already ruled out \(do NOT retry\): jsonwebtoken v8/);
  assert.match(ctx, /1\. finish middleware\.js:88/);
  assert.match(ctx, /port=4731/);

  // stale note → silent
  const p = join(dir, 'checkpoint.json');
  const note = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify({ ...note, at: note.at - 7 * 3600 }));
  assert.equal(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'any', source: 'compact' }), env }).stdout, '');

  // wrong-session note → silent
  writeFileSync(p, JSON.stringify({ ...note, session_id: 'other-session' }));
  assert.equal(run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'mine', source: 'compact' }), env }).stdout, '');
});

test('T2.13: receipt fires when one tool call visibly moves the budget; floors keep quiet otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-rcpt-'));
  const env = { TOKENROOM_DIR: dir };
  // a receipt is routine quota surfacing (ADR-26): silent above critical_pct. This test
  // asserts the receipt ECONOMICS wording, so hold the gate open (the suppression itself is
  // covered in critical.test.mjs).
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ critical_pct: 100 }));
  const now = () => Math.round(Date.now() / 1000);
  const write = (usedPct, cost) =>
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schema: 'resource-state/v0',
        updated_at: now(),
        session_id: 'r1',
        windows: { five_hour: { used_pct: usedPct, resets_at: now() + 3600 } },
        context: null,
        burn: {},
        session: { cost_usd: cost },
      })
    );
  const post = (tool) => run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'r1', tool_name: tool }), env }).stdout;

  write(40, 10.0);
  assert.equal(post('Bash'), ''); // baseline
  write(40, 10.2);
  assert.equal(post('Bash'), ''); // under both floors → silent
  write(45, 13.5);
  const out = post('Task'); // 5 points + $3.30 in one call
  assert.match(out, /receipt: that Task cost ≈5% of the 5h window \(\+\$3\.30\)/);
  assert.match(out, /55% left/);
  assert.match(readFileSync(join(dir, 'events.jsonl'), 'utf8'), /receipt/);
});

test('T2.14: launch gate denies expensive launches only when window says defer — opt-in, fail-open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-gate-'));
  const env = { TOKENROOM_DIR: dir };
  const now = Math.round(Date.now() / 1000);
  const state = (usedPct) =>
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: now,
      session_id: 'g1',
      windows: { five_hour: { used_pct: usedPct, resets_at: now + 3600 } },
      context: null,
      burn: {},
      session: {},
    });
  const pre = (tool) => run(['hook', 'pre-tool-use'], { input: JSON.stringify({ session_id: 'g1', tool_name: tool }), env }).stdout;

  // gate off (default) → always silent, even at 1% left
  writeFileSync(join(dir, 'state.json'), state(99));
  assert.equal(pre('Task'), '');

  writeFileSync(join(dir, 'config.json'), JSON.stringify({ launch_gate: true }));
  const denied = pre('Task');
  assert.match(denied, /"permissionDecision":"deny"/);
  assert.match(denied, /launch gate/);
  assert.match(denied, /plan_resume/);
  assert.equal(pre('Bash'), ''); // cheap tools never gated
  writeFileSync(join(dir, 'state.json'), state(96)); // 4% left: descent — indivisible launches denied
  assert.match(pre('Task'), /"permissionDecision":"deny"/);
  writeFileSync(join(dir, 'state.json'), state(50)); // healthy window
  assert.equal(pre('Task'), '');
  writeFileSync(join(dir, 'state.json'), 'garbage'); // broken state → fail open
  assert.equal(pre('Task'), '');
});

test('T2.4: governor mode shifts when tokenroom speaks — powersave early, performance late, no restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-gov-'));
  const env = { TOKENROOM_DIR: dir };
  const now = () => Math.round(Date.now() / 1000);
  const write = (usedPct) =>
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schema: 'resource-state/v0',
        updated_at: now(),
        session_id: 'gv1',
        windows: { five_hour: { used_pct: usedPct, resets_at: now() + 3600 } },
        context: null,
        burn: {},
        session: {},
      })
    );
  const post = () => run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'gv1' }), env }).stdout;
  const mode = (m) => writeFileSync(join(dir, 'config.json'), JSON.stringify({ mode: m }));

  // powersave: 35% left crosses the 40-band → speaks where ondemand would stay silent
  mode('powersave');
  write(55);
  assert.equal(post(), ''); // baseline
  write(65);
  assert.match(post(), /35% left/);

  // performance (config change only, no restart): 20% left is inside ondemand's 25-band
  // but outside performance's 10-band → silent
  mode('performance');
  write(70); // improvement first, resets stored bands
  post();
  write(74); // small steps stay under performance's 5%-receipt floor
  assert.equal(post(), '');
  write(78); // 22% left — inside ondemand's 25-band, outside performance's 10-band
  assert.equal(post(), '');
  // ...but 8% left crosses performance's 10-band; age the throttle (performance = 300s)
  const bands = JSON.parse(readFileSync(join(dir, 'bands.json'), 'utf8'));
  bands.gv1.at = 0;
  writeFileSync(join(dir, 'bands.json'), JSON.stringify(bands));
  write(92);
  assert.match(post(), /8% left.*full speed/); // ADR-19: 5–100% is full speed now
});

test('doctor: flags missing wiring in a sandbox, exits 1; clean after install', () => {
  const cfg = mkdtempSync(join(tmpdir(), 'hr-doc-'));
  const env = { TOKENROOM_DIR: mkdtempSync(join(tmpdir(), 'hr-docd-')) };
  const broken = run(['doctor', '--config-dir', cfg], { env });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /statusline tap not registered/);
  assert.match(broken.stdout, /problem\(s\) found/);

  run(['install', '--config-dir', cfg]);
  const after = run(['doctor', '--config-dir', cfg], { env });
  assert.match(after.stdout, /statusline tap registered/);
  assert.match(after.stdout, /skill installed and current/);
  assert.doesNotMatch(after.stdout, /hook \w+: not registered/);
});

test('stamp: quota tokens are labeled "of quota" — never a bare token pool next to a reset clock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-conf-'));
  const env = { TOKENROOM_DIR: dir };
  // asserts the "of quota" token labeling at a healthy 84% — hold the ADR-26 quiet gate open
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ critical_pct: 100 }));
  const now = Math.round(Date.now() / 1000);
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: now,
      session_id: 'c1',
      windows: { five_hour: { used_pct: 16, resets_at: now + 16200 } },
      context: null,
      burn: { est_tokens_left: 858000, tokens_per_pct: 10214 },
      session: {},
    })
  );
  const stamp = JSON.parse(run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'c1' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(stamp, /\(≈858k tokens of quota\)/);
  assert.doesNotMatch(stamp, /tokens\), resets/); // the confusable shape must not exist
});

test('release preflight: offline checks run and validate this repo coherently', { skip: !!process.env.TOKENROOM_PREFLIGHT }, () => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'release-preflight.mjs'), '--offline'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(r.stdout, /CHANGELOG has a dated section/);
  assert.match(r.stdout, /tarball scoped to bin\/src\/skill\/schema/);
  assert.match(r.stdout, /test suite green/);
  // tag v0.3.0 exists at some commit; preflight must classify it, never crash
  assert.match(r.stdout, /tag v\d+\.\d+\.\d+/);
});

test('stamp discloses concurrent sessions sharing the account window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-multi-'));
  const env = { TOKENROOM_DIR: dir };
  // asserts the shared-session disclosure at a healthy 50% — hold the ADR-26 quiet gate open
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ critical_pct: 100 }));
  const now = Math.round(Date.now() / 1000);
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: now,
      session_id: 'me',
      windows: { five_hour: { used_pct: 50, resets_at: now + 3600 } },
      context: null,
      burn: {},
      session: {},
    })
  );
  // two other sessions touched their band entries recently; one is ancient
  writeFileSync(
    join(dir, 'bands.json'),
    JSON.stringify({
      me: { fh: 0, ctx: 0, exh: false, at: 0, t: now },
      other1: { fh: 0, ctx: 0, exh: false, at: 0, t: now - 60 },
      other2: { fh: 1, ctx: 0, exh: false, at: 0, t: now - 600 },
      ghost: { fh: 0, ctx: 0, exh: false, at: 0, t: now - 7200 },
    })
  );
  const stamp = JSON.parse(run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'me' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(stamp, /3 sessions sharing this quota/);
});

test('reset crossing: dead-window data is reported as FRESH quota, never as dry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-reset-'));
  const env = { TOKENROOM_DIR: dir };
  const now = Math.round(Date.now() / 1000);
  // shape 2 (the worse one): state freshly written but resets_at already passed
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: now,
      session_id: 'rx',
      windows: { five_hour: { used_pct: 94, resets_at: now - 300 } },
      context: null,
      burn: { projected_exhaustion: now + 60 },
      session: {},
    })
  );
  const stamp = JSON.parse(run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'rx' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(stamp, /RESET at .*quota is FRESH/);
  assert.doesNotMatch(stamp, /6% left|94/);
  // mid-turn hook stays silent on dead-window data (no false receipts/bands)
  run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'rx' }), env });
  assert.equal(run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'rx' }), env }).stdout, '');
  // fit_check reports fresh, not defer
  process.env.TOKENROOM_DIR = dir;
  const { fitCheck } = await import('../src/fit.mjs');
  const fit = fitCheck(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), { est_tokens: 50000 });
  assert.equal(fit.window.verdict, 'fits');
  assert.equal(fit.window.basis, 'window-reset');
  delete process.env.TOKENROOM_DIR;
});

test('receipts: baseline from a previous window never produces a delta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-xwin-'));
  const env = { TOKENROOM_DIR: dir };
  const now = Math.round(Date.now() / 1000);
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: now,
      session_id: 'w1',
      windows: { five_hour: { used_pct: 76, resets_at: now + 4 * 3600 } }, // window started ~1h ago
      context: null,
      burn: {},
      session: { cost_usd: 50 },
    })
  );
  // baseline sampled 6h ago — a DIFFERENT window (u=12 then would read as +64 now)
  writeFileSync(
    join(dir, 'bands.json'),
    JSON.stringify({ w1: { fh: 0, ctx: 0, exh: false, at: 0, u: 12, c: 10, t: now - 6 * 3600 } })
  );
  const out = run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'w1' }), env }).stdout;
  assert.doesNotMatch(out, /receipt/); // rebaselined silently, no phantom 64% bill
});

test('weekly cruise: hot pace detected, allowance computed, cool pace stays quiet', async () => {
  const { enrichWeekly } = await import('../src/state.mjs');
  const now = 1800000000;
  const mk = (used, resetsInDays) => ({
    windows: { seven_day: { used_pct: used, resets_at: now + resetsInDays * 86400 } },
    burn: {},
  });
  // 5 days elapsed (resets in 2d), 90% used → pace 1.26, exhaustion well before reset
  const hot = enrichWeekly(mk(90, 2), now);
  assert.equal(hot.burn.weekly.hot, true);
  assert.equal(hot.burn.weekly.pace_ratio, 1.26);
  assert.equal(hot.burn.weekly.daily_allowance_pct, 5); // 10% over 2 days
  assert.ok(hot.burn.weekly.projected_exhaustion < now + 2 * 86400);
  // same elapsed, 50% used → pace 0.7, no exhaustion before reset → cool
  const cool = enrichWeekly(mk(50, 2), now);
  assert.equal(cool.burn.weekly.hot, false);
  assert.equal(cool.burn.weekly.projected_exhaustion, null);
});

test('weekly cruise: stamp coaches throttling when HOT; HUD flags it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-week-'));
  const env = { TOKENROOM_DIR: dir };
  const now = Math.round(Date.now() / 1000);
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: now,
      session_id: 'wk1',
      windows: {
        five_hour: { used_pct: 30, resets_at: now + 3600 },
        seven_day: { used_pct: 90, resets_at: now + 2 * 86400 },
      },
      context: null,
      burn: { weekly: { pace_ratio: 1.26, daily_allowance_pct: 5, projected_exhaustion: now + 86400, hot: true } },
      session: {},
    })
  );
  const stamp = JSON.parse(run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'wk1' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(stamp, /weekly pace is HOT \(1\.26x sustainable\)/);
  assert.match(stamp, /≈5%\/day sustains/);
  assert.match(stamp, /deferring bulk work/);
});

test('weekly: window is hidden from the LLM until <20% left (even when HOT)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-week-gate-'));
  const env = { TOKENROOM_DIR: dir };
  const now = Math.round(Date.now() / 1000);
  const writeState = (sevenUsed) =>
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        schema: 'resource-state/v0',
        updated_at: now,
        session_id: 'wkg',
        windows: {
          five_hour: { used_pct: 30, resets_at: now + 3600 },
          seven_day: { used_pct: sevenUsed, resets_at: now + 2 * 86400 },
        },
        context: null,
        // HOT pace present in state — the gate must suppress it anyway above the threshold
        burn: { weekly: { pace_ratio: 1.31, daily_allowance_pct: 12, projected_exhaustion: now + 86400, hot: true } },
        session: {},
      })
    );
  const stamp = () =>
    JSON.parse(run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'wkg' }), env }).stdout)
      .hookSpecificOutput.additionalContext;

  writeState(46); // 54% left, HOT in state → still hidden (the user's exact complaint)
  assert.doesNotMatch(stamp(), /7d:|weekly pace is HOT/);
  writeState(81); // 19% left → now disclosed
  assert.match(stamp(), /7d: 19% left/);
  assert.match(stamp(), /weekly pace is HOT/);
});

test('5h: exhaustion clause surfaces the runway (when + how long from now)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-runway-'));
  const env = { TOKENROOM_DIR: dir };
  const now = Math.round(Date.now() / 1000);
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: now,
      session_id: 'rw',
      // would run dry ~50m from now, well before the 2h reset → constant work DOES get stopped
      windows: { five_hour: { used_pct: 60, resets_at: now + 7200 } },
      context: null,
      burn: { exhaustion_band: [now + 3000, now + 4200] },
      session: {},
    })
  );
  const stamp = JSON.parse(run(['hook', 'user-prompt-submit'], { input: JSON.stringify({ session_id: 'rw' }), env }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(stamp, /at current pace, may run dry ~/);
  assert.match(stamp, /≈50m of work left at this pace/);
});

test('weekly cruise: full tap pipeline computes pace from a raw payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-week2-'));
  const now = Math.round(Date.now() / 1000);
  const out = run(['tap'], {
    input: JSON.stringify({
      session_id: 'wk2',
      rate_limits: {
        five_hour: { used_percentage: 30, resets_at: now + 3600 },
        seven_day: { used_percentage: 90, resets_at: now + 2 * 86400 },
      },
    }),
    env: { TOKENROOM_DIR: dir },
  }).stdout;
  assert.match(out, /week 10% left ⚠hot pace/);
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(st.burn.weekly.hot, true);
});
