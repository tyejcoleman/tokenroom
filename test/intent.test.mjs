import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setIntent, activeIntent, isFocused, clearIntent, normalizeQueue } from '../src/intent.mjs';
import { planResume, readResume, resumeReady } from '../src/resume.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'tokenroom.mjs');
const run = (args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });
const nowSec = () => Math.round(Date.now() / 1000);
const fresh = (p) => {
  const dir = mkdtempSync(join(tmpdir(), p));
  process.env.TOKENROOM_DIR = dir;
  return dir;
};

// ── intent.mjs unit ─────────────────────────────────────────────────────────

test('normalizeQueue: strings and objects, capped and trimmed', () => {
  const q = normalizeQueue(['do a', { task: 'do b', est_tokens: 5000 }, { task: '' }, 42, { nope: 1 }]);
  assert.deepEqual(q, [{ task: 'do a', est_tokens: null }, { task: 'do b', est_tokens: 5000 }]);
  assert.equal(normalizeQueue('nope').length, 0);
  assert.equal(normalizeQueue(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, 20); // ≤20 cap
});

test('setIntent / activeIntent: focused kinds, session guard, expiry', () => {
  fresh('tr-intent-');
  const it = setIntent({ kind: 'convergence', note: 'the big build', queue: ['phase 1', 'phase 2'] });
  assert.equal(it.kind, 'convergence');
  assert.equal(it.queue.length, 2);
  assert.ok(isFocused(it));
  assert.ok(isFocused(activeIntent(null))); // untagged read (no state → session_id null)

  // default is NOT focused
  assert.ok(!isFocused(setIntent({ kind: 'default' })));
  assert.ok(!isFocused(activeIntent(null)));

  // session guard: an intent tagged to one session is invisible to another
  writeFileSync(join(process.env.TOKENROOM_DIR, 'intent.json'), JSON.stringify({ kind: 'priority', session_id: 'owner', created_at: nowSec(), ttl_sec: 43200 }));
  assert.ok(isFocused(activeIntent('owner')));
  assert.equal(activeIntent('someone-else'), null);
  assert.ok(isFocused(activeIntent(null))); // untagged CALLER still sees it (human CLI)

  // expiry
  writeFileSync(join(process.env.TOKENROOM_DIR, 'intent.json'), JSON.stringify({ kind: 'convergence', session_id: null, created_at: nowSec() - 13 * 3600, ttl_sec: 12 * 3600 }));
  assert.equal(activeIntent(null), null);

  assert.ok(clearIntent());
  assert.equal(activeIntent(null), null);
});

test('setIntent: unknown kind defaults to convergence; created_at preserved across updates', () => {
  fresh('tr-intent2-');
  const a = setIntent({ kind: 'bogus' });
  assert.equal(a.kind, 'convergence');
  const b = setIntent({ kind: 'long_running', note: 'updated' });
  assert.equal(b.created_at, a.created_at); // TTL measures from the run's start
});

// ── resume.mjs unit ─────────────────────────────────────────────────────────

const state = (fhResets, sdResets) => ({
  windows: {
    five_hour: fhResets ? { used_pct: 98, resets_at: fhResets } : null,
    seven_day: sdResets ? { used_pct: 90, resets_at: sdResets } : null,
  },
});

test('planResume: queue-only synthesizes a summary; records both windows', () => {
  fresh('tr-resume-');
  const fh = nowSec() + 1800;
  const sd = nowSec() + 4 * 86400;
  const r = planResume({ queue: ['finish migration', 'run e2e'] }, state(fh, sd));
  assert.ok(r.recorded);
  const plan = readResume();
  assert.equal(plan.blocked_on, 'five_hour');
  assert.equal(plan.resume_at, fh);
  assert.deepEqual(plan.windows, { five_hour: fh, seven_day: sd });
  assert.match(plan.summary, /finish migration; run e2e/);
  assert.equal(plan.queue.length, 2);
});

test('planResume: blocked_on seven_day → readiness gates on the WEEKLY reset', () => {
  fresh('tr-resume2-');
  const fh = nowSec() + 1800; // 5h resets soon
  const sd = nowSec() + 3 * 86400; // but weekly is the binding window
  planResume({ summary: 'bulk refactor', blocked_on: 'seven_day', arm: true }, state(fh, sd));
  const plan = readResume();
  assert.equal(plan.blocked_on, 'seven_day');
  assert.equal(plan.resume_at, sd); // NOT the 5h reset
  assert.ok(plan.armed);
  assert.equal(resumeReady(plan), false); // weekly reset is days away
});

test('planResume: neither summary nor queue → error', () => {
  fresh('tr-resume3-');
  assert.ok(planResume({}, state(nowSec() + 60)).error);
});

test('readResume: a weekly-deferred plan is NOT expired before its reset', () => {
  fresh('tr-resume4-');
  const dir = process.env.TOKENROOM_DIR;
  const created = nowSec() - 30 * 3600; // created 30h ago (past the 24h window)
  const resume_at = nowSec() + 4 * 86400; // but its weekly reset is still in the future
  writeFileSync(join(dir, 'resume.json'), JSON.stringify({ summary: 'weekly work', created_at: created, resume_at, blocked_on: 'seven_day', queue: [], windows: {}, armed: true }));
  assert.ok(readResume(), 'plan must survive until 24h PAST its reset');

  // a plain plan with no future reset DOES expire after 24h
  writeFileSync(join(dir, 'resume.json'), JSON.stringify({ summary: 'old', created_at: created, resume_at: null, queue: [], windows: {}, armed: false }));
  assert.equal(readResume(), null);
});

// ── hook integration: intent-gated descent ──────────────────────────────────

test('intent-gated descent: focused run burns to the floor (no early-defer) and arms at 1%', () => {
  const dir = fresh('tr-descent-');
  const env = { TOKENROOM_DIR: dir };
  const write = (usedPct) =>
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ schema: 'resource-state/v0', updated_at: nowSec(), session_id: 'd9', windows: { five_hour: { used_pct: usedPct, resets_at: nowSec() + 3600 } }, context: null, burn: {}, session: {} })
    );
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({ kind: 'convergence', session_id: 'd9', created_at: nowSec(), ttl_sec: 43200 }));
  const post = () => run(['hook', 'post-tool-use'], { input: JSON.stringify({ session_id: 'd9' }), env }).stdout;
  const age = () => {
    const b = JSON.parse(readFileSync(join(dir, 'bands.json'), 'utf8'));
    b.d9.at = 0;
    writeFileSync(join(dir, 'bands.json'), JSON.stringify(b));
  };
  write(50);
  post(); // baseline
  write(96);
  age();
  const mindful = post();
  assert.match(mindful, /keep FULL SPEED to the 1% floor/); // 1–5% focused: no throttle
  assert.doesNotMatch(mindful, /be mindful of velocity/); // the cautious default wording is suppressed
  write(99);
  age();
  assert.match(post(), /1% floor.*arm in-session resume.*plan_resume the REMAINING QUEUE with arm:true/);
});

// ── hook integration: warn-and-arm launch gate ──────────────────────────────

test('launch gate: a focused run warns-and-arms instead of a bare block', () => {
  const dir = fresh('tr-launcharm-');
  const env = { TOKENROOM_DIR: dir };
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schema: 'resource-state/v0', updated_at: nowSec(), session_id: 'g1', windows: { five_hour: { used_pct: 97, resets_at: nowSec() + 900 } }, context: null, burn: {}, session: {} }));
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({ kind: 'convergence', session_id: 'g1', created_at: nowSec(), ttl_sec: 43200 }));
  const out = run(['hook', 'pre-tool-use'], { input: JSON.stringify({ session_id: 'g1', tool_name: 'Task' }), env }).stdout;
  const j = JSON.parse(out);
  assert.equal(j.hookSpecificOutput.permissionDecision, undefined); // warn, never STOP (field directive 2026-07-05)
  assert.match(j.hookSpecificOutput.additionalContext, /NOT a stop — keep going/);
  assert.match(j.hookSpecificOutput.additionalContext, /ARMED/);
  const plan = JSON.parse(readFileSync(join(dir, 'resume.json'), 'utf8'));
  assert.ok(plan.armed);
  assert.match(plan.queue[0].task, /Task launch deferred/);
});

test('launch gate: focused arming never clobbers a plan the agent already wrote', () => {
  const dir = fresh('tr-launchkeep-');
  const env = { TOKENROOM_DIR: dir };
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schema: 'resource-state/v0', updated_at: nowSec(), session_id: 'g2', windows: { five_hour: { used_pct: 97, resets_at: nowSec() + 900 } }, context: null, burn: {}, session: {} }));
  writeFileSync(join(dir, 'intent.json'), JSON.stringify({ kind: 'priority', session_id: 'g2', created_at: nowSec(), ttl_sec: 43200 }));
  writeFileSync(join(dir, 'resume.json'), JSON.stringify({ summary: 'my real plan', created_at: nowSec(), resume_at: nowSec() + 900, blocked_on: 'five_hour', queue: [{ task: 'my real task', est_tokens: null }], windows: {}, armed: true }));
  run(['hook', 'pre-tool-use'], { input: JSON.stringify({ session_id: 'g2', tool_name: 'Workflow' }), env });
  const plan = JSON.parse(readFileSync(join(dir, 'resume.json'), 'utf8'));
  assert.equal(plan.summary, 'my real plan'); // untouched
});

test('launch gate: plain launch_gate (no intent) still blocks without arming', () => {
  const dir = fresh('tr-launchplain-');
  const env = { TOKENROOM_DIR: dir };
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ launch_gate: true }));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schema: 'resource-state/v0', updated_at: nowSec(), session_id: 'g3', windows: { five_hour: { used_pct: 97, resets_at: nowSec() + 900 } }, context: null, burn: {}, session: {} }));
  const out = run(['hook', 'pre-tool-use'], { input: JSON.stringify({ session_id: 'g3', tool_name: 'Agent' }), env }).stdout;
  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /Record the work with plan_resume/);
  assert.ok(!existsSync(join(dir, 'resume.json'))); // nothing armed
});

// ── hook integration: Stop-hook in-session continuation ─────────────────────

function stopCase(dir, { intent = { kind: 'convergence', session_id: 's', created_at: nowSec(), ttl_sec: 43200 }, plan, stop_hook_active = false, session_id = 's' } = {}) {
  const env = { TOKENROOM_DIR: dir };
  // a FRESH 5h window (window reset → low used_pct, next reset in the future)
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schema: 'resource-state/v0', updated_at: nowSec(), session_id, windows: { five_hour: { used_pct: 3, resets_at: nowSec() + 5 * 3600 } }, context: null, burn: {}, session: {} }));
  if (intent) writeFileSync(join(dir, 'intent.json'), JSON.stringify(intent));
  if (plan) writeFileSync(join(dir, 'resume.json'), JSON.stringify(plan));
  return run(['hook', 'stop'], { input: JSON.stringify({ session_id, stop_hook_active }), env }).stdout;
}

const readyPlan = { summary: 'the run', created_at: nowSec() - 100, resume_at: nowSec() - 10, blocked_on: 'five_hour', queue: [{ task: 'run phase 2', est_tokens: null }, { task: 'run phase 3', est_tokens: null }], windows: {}, armed: true };

test('Stop hook: armed + ready + focused → blocks the stop and injects the next queued task', () => {
  const out = stopCase(fresh('tr-stop-go-'), { plan: readyPlan });
  const j = JSON.parse(out);
  assert.equal(j.decision, 'block');
  assert.match(j.reason, /deferred work is ready.*continue IN THIS SESSION/);
  assert.match(j.reason, /run phase 2/);
  assert.match(j.reason, /1 more queued/);
});

test('Stop hook: allows the stop when not armed / not ready / no intent / re-fired', () => {
  assert.equal(stopCase(fresh('tr-stop-noarm-'), { plan: { ...readyPlan, armed: false } }), ''); // not armed
  assert.equal(stopCase(fresh('tr-stop-early-'), { plan: { ...readyPlan, resume_at: nowSec() + 3600 } }), ''); // not ready
  assert.equal(stopCase(fresh('tr-stop-noint-'), { intent: null, plan: readyPlan }), ''); // no intent
  assert.equal(stopCase(fresh('tr-stop-default-'), { intent: { kind: 'default', session_id: 's', created_at: nowSec(), ttl_sec: 43200 }, plan: readyPlan }), ''); // default intent isn't focused
  assert.equal(stopCase(fresh('tr-stop-loop-'), { plan: readyPlan, stop_hook_active: true }), ''); // never loop
});
