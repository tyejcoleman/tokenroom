import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJSON } from './util.mjs';

// Read-only probe into belay's loop-lifecycle file (~/.belay/loops.json). Used ONLY to
// drive the opt-in `auto` mode of the weekly-warning config (ADR-27): when a belay loop
// is actively armed for THIS session, the weekly (7d) warning line stays quiet on the
// theory that an autonomous loop is already tracking its own pace.
//
// Deliberately shallow: this reads belay's on-disk JSON directly and does NOT import
// belay's package or any of its code — tokenroom has no dependency on belay being
// installed, running, or even present. Missing/corrupt/garbled data always resolves to
// "no active loop" (false), never an error — a machine with no belay installed is a
// perfectly normal, common case, not a fault (ADR-5 never-throw discipline).

/** Mirrors belay's own dir-resolution convention (BELAY_DIR env override, else ~/.belay)
 *  so a relocated install is still found. */
export const belayDir = () => process.env.BELAY_DIR || join(homedir(), '.belay');

/** The session id to check loop-activity against: prefer the explicit id passed in (the
 *  hook stdin's `session_id`), else fall back to $CLAUDE_CODE_SESSION_ID. Returns null
 *  when neither is available — callers must then treat "loop active" as unknowable (false). */
export function resolveSessionId(explicitId) {
  return explicitId || process.env.CLAUDE_CODE_SESSION_ID || null;
}

/** True when belay's loops.json has an entry for `sessionId` that is armed and not
 *  paused. Read-only, never throws: an absent ~/.belay, a missing/malformed loops.json,
 *  or any unexpected shape all resolve to false (caller then falls back to its own
 *  default behavior — for tokenroom's weekly warning, that means it still shows). We do
 *  not additionally probe goal status here — it lives in a separate file (keyoku's
 *  goals.json) belay itself reads, and this helper is deliberately limited to the one
 *  file the task calls for; armed+not-paused is a cheap, sufficient proxy for "a loop is
 *  actively driving this session right now". */
export function loopActiveForSession(sessionId) {
  if (!sessionId) return false;
  try {
    const data = readJSON(join(belayDir(), 'loops.json'));
    const loops = data && typeof data === 'object' && data.loops && typeof data.loops === 'object' && !Array.isArray(data.loops) ? data.loops : null;
    if (!loops) return false;
    for (const entry of Object.values(loops)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.session_id !== sessionId) continue;
      if (!entry.armed) continue;
      if (entry.paused) continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
