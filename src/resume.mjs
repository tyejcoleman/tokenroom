import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tokenroomDir, ensureDir, atomicWriteJSON, readJSON, fmtClock } from './util.mjs';
import { normalizeQueue } from './intent.mjs';

// Reset scheduler: when work is deferred past a window reset (fit_check → defer), the
// model records a resume plan. The HUD shows a countdown; once the reset passes, the
// stamp and SessionStart flag the work as ready until the plan is cleared. Two upgrades
// (ADR-25): the plan carries a task QUEUE (not just a one-line summary) so a long-running
// process keeps its work list across the gap, and it tracks BOTH windows so weekly-blocked
// work becomes ready at the 7d reset, not the 5h one. When `armed`, the Stop hook
// continues the queue IN-SESSION once the blocked window resets (never headless — ADR-22).

const planPath = () => join(tokenroomDir(), 'resume.json');
const MAX_AGE_SEC = 24 * 3600;
const BLOCKED = new Set(['five_hour', 'seven_day']);

export function planResume({ summary, est_tokens, queue, blocked_on, arm } = {}, state, nowSec = Date.now() / 1000) {
  const q = normalizeQueue(queue);
  // summary OR a non-empty queue is enough; synthesize a summary from the queue if omitted
  if ((!summary || typeof summary !== 'string') && !q.length) return { error: 'summary (string) or queue (non-empty array) is required' };
  const sum = (typeof summary === 'string' && summary.trim() ? summary : q.map((x) => x.task).join('; ')).slice(0, 500);
  const blocked = BLOCKED.has(blocked_on) ? blocked_on : 'five_hour';
  const windows = {
    five_hour: state?.windows?.five_hour?.resets_at ?? null,
    seven_day: state?.windows?.seven_day?.resets_at ?? null,
  };
  const resumeAt = windows[blocked]; // ready when THIS window's reset passes (5h or 7d)
  const plan = {
    summary: sum,
    est_tokens: typeof est_tokens === 'number' ? est_tokens : null,
    queue: q,
    blocked_on: blocked,
    windows,
    armed: !!arm,
    created_at: Math.round(nowSec),
    resume_at: resumeAt,
  };
  ensureDir(tokenroomDir());
  atomicWriteJSON(planPath(), plan);
  const win = blocked === 'seven_day' ? '7d weekly' : '5h';
  return {
    recorded: true,
    resume_at: resumeAt,
    resume_at_clock: resumeAt ? fmtClock(resumeAt) : null,
    armed: plan.armed,
    queued: q.length,
    note: resumeAt
      ? `Deferred until the ${win} window resets at ${fmtClock(resumeAt)}. ${plan.armed ? 'ARMED: tokenroom will continue this queue in THIS session once the window resets (Stop-hook continuation — no headless spend). ' : 'Tokenroom flags readiness in the HUD and prompt stamps. '}Finish at a clean boundary now${plan.armed ? ', and schedule a wakeup at the reset if you will be idle until then' : ''}.`
      : 'No reset time known; plan recorded without a schedule.',
  };
}

export function readResume(nowSec = Date.now() / 1000) {
  const plan = readJSON(planPath());
  // Validate shape at the SOURCE. A plan missing a string summary or a numeric created_at is
  // corrupt: `nowSec - undefined` is NaN so the 24h expiry NEVER fires (the file would then
  // silence every stamp forever), and consumers reading plan.summary would throw. Reject it
  // here so both failure modes close at once (ADR-5: degrade, never let one bad file cascade).
  if (!plan || typeof plan.summary !== 'string' || typeof plan.created_at !== 'number') return null;
  // Expiry must not kill a plan BEFORE its reset — a weekly deferral resumes up to 7 days
  // out, so keep it alive until 24h PAST the later of (created_at, resume_at).
  const anchor = typeof plan.resume_at === 'number' && plan.resume_at > plan.created_at ? plan.resume_at : plan.created_at;
  if (nowSec - anchor > MAX_AGE_SEC) return null;
  return plan;
}

/** True when a plan's blocked window has reset — the moment its work is runnable again. */
export function resumeReady(plan, nowSec = Date.now() / 1000) {
  return !!(plan && typeof plan.resume_at === 'number' && nowSec >= plan.resume_at);
}

export function clearResume() {
  try {
    rmSync(planPath());
    return true;
  } catch {
    return false;
  }
}
