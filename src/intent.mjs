import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { tokenroomDir, ensureDir, atomicWriteJSON, readJSON, fmtClock } from './util.mjs';
import { readState } from './state.mjs';

// Work-intent (ADR-25): the model declares the SHAPE of the current run so tokenroom's
// pacing matches it. A one-off task keeps the cautious descent; a long-running /
// convergence / priority run is told to BURN to the 1% floor (not throttle at 5%) and to
// ARM its remaining queue for in-session resume past the reset. This is the ONLY thing
// that flips descent out of its cautious early-defer stance into spend-to-the-floor — it
// exists so the agent can reason about flow instead of stalling a healthy budget.
//
// Session scoping caveat (same as checkpoint/continuity, ADR-15): MCP calls carry no
// session id, so the intent is tagged with the most recent tap session and readers accept
// a match or an untagged intent. Single-session use is exact; concurrent sessions can
// mislabel — the reader guards (hooks pass their real session id).

const intentPath = () => join(tokenroomDir(), 'intent.json');
const MAX_AGE_SEC = 12 * 3600; // a long run spans hours; expire well after a plausible session
const FOCUSED = new Set(['convergence', 'long_running', 'priority']);
const KINDS = new Set([...FOCUSED, 'default']);
const CAP = { note: 300, task: 200, queue: 20 };

const trim = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null);

/** Normalize a queue arg: accepts ["do X", ...] or [{task, est_tokens}, ...]. */
export function normalizeQueue(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const task = trim(typeof x === 'string' ? x : x?.task, CAP.task);
      if (!task) return null;
      const est = typeof x?.est_tokens === 'number' && Number.isFinite(x.est_tokens) ? x.est_tokens : null;
      return { task, est_tokens: est };
    })
    .filter(Boolean)
    .slice(0, CAP.queue);
}

export function setIntent(args = {}, nowSec = Date.now() / 1000) {
  const kind = KINDS.has(args.kind) ? args.kind : 'convergence';
  const intent = {
    kind,
    note: trim(args.note, CAP.note),
    queue: normalizeQueue(args.queue),
    session_id: readState()?.session_id ?? null,
    created_at: Math.round(nowSec),
    updated_at: Math.round(nowSec),
    ttl_sec: MAX_AGE_SEC,
  };
  // preserve created_at across updates so TTL measures from the run's START, not last touch
  const prev = readJSON(intentPath());
  if (prev && typeof prev.created_at === 'number') intent.created_at = prev.created_at;
  ensureDir(tokenroomDir());
  atomicWriteJSON(intentPath(), intent);
  return intent;
}

export function isFocused(intent) {
  return !!intent && FOCUSED.has(intent.kind);
}

/** The current intent if fresh AND attributable to this session (or untagged). Returns the
 *  raw object regardless of kind; callers use isFocused() to branch. Null when absent,
 *  expired, or tagged to a different session. */
export function activeIntent(sessionId, nowSec = Date.now() / 1000) {
  const intent = readJSON(intentPath());
  if (!intent || typeof intent.created_at !== 'number' || !KINDS.has(intent.kind)) return null;
  if (nowSec - intent.created_at > (intent.ttl_sec ?? MAX_AGE_SEC)) return null;
  if (intent.session_id && sessionId && intent.session_id !== sessionId) return null;
  return intent;
}

export function clearIntent() {
  try {
    rmSync(intentPath());
    return true;
  } catch {
    return false;
  }
}

export function renderIntent(intent) {
  if (!intent) return 'no active work-intent';
  const lines = [`intent: ${intent.kind}${isFocused(intent) ? ' (burn to the 1% floor; queue arms for in-session resume)' : ''} — set ${fmtClock(intent.created_at)}`];
  if (intent.note) lines.push(`  note: ${intent.note}`);
  if (intent.queue?.length) lines.push(`  queue (${intent.queue.length}): ${intent.queue.map((q) => q.task).join(' · ')}`);
  return lines.join('\n');
}
