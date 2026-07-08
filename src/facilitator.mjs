import { join } from 'node:path';
import { tokenroomDir, ensureDir, atomicWriteJSON, readJSON, fmtTokens } from './util.mjs';

// Facilitator-cost hand-off nudge (tokenroom enhancement, Tye's token-efficiency priority):
// a long autonomous run's driver/orchestrator ("facilitator") session resends its ENTIRE
// context on every turn, so the marginal cost of the NEXT turn tracks context SIZE, not a
// delta — a session sitting on 80k tokens of context pays ~80k tokens just to take one more
// step, every step, while a fresh session doing the identical next task pays a fraction of
// that. Left unmanaged, burn keeps climbing turn over turn even though the actual work per
// turn hasn't grown. The nudge: once THIS session's context size crosses a configurable
// threshold, suggest handing off to a fresh session to reset that cost — rate-limited (at
// most once per `facilitator_nudge_cooldown_turns` UserPromptSubmit turns) so it isn't
// spammy on a long run that stays above the threshold.

const TTL_SEC = 24 * 3600; // self-pruning, mirrors bands.json in src/hook.mjs
const pathFor = (dir) => join(dir, 'facilitator.json');

/**
 * Call once per UserPromptSubmit turn with this session's current context-tokens-used
 * (or null/NaN when unknown). Returns the nudge string when it should fire this turn, else
 * null. Best-effort / never-throw: any I/O or state hiccup degrades to "don't nudge", never
 * to a crash or a stale/duplicate message.
 *
 * Turn-counting: a per-session counter increments on every valid call (so cooldown counts
 * real turns, not just turns spent above threshold) and resets to 0 the turn it fires.
 * First sight for a session is always eligible if already above threshold (no cold-start
 * silence).
 */
export function facilitatorNudge(sessionId, ctxTokens, cfg, nowSec = Date.now() / 1000, dir = tokenroomDir()) {
  try {
    if (!cfg?.facilitator_nudge_enabled) return null;
    if (typeof ctxTokens !== 'number' || !Number.isFinite(ctxTokens) || ctxTokens <= 0) return null;
    const threshold = cfg.facilitator_context_threshold_tokens;
    const cooldown = cfg.facilitator_nudge_cooldown_turns;
    const key = sessionId ?? 'unknown';

    const all = readJSON(pathFor(dir)) ?? {};
    for (const k of Object.keys(all)) if (nowSec - (all[k]?.t ?? 0) > TTL_SEC) delete all[k];
    const prevSince = all[key]?.since;
    const turnsSince = (typeof prevSince === 'number' ? prevSince : Infinity) + 1;

    const fire = ctxTokens >= threshold && turnsSince >= cooldown;
    all[key] = { since: fire ? 0 : turnsSince, t: nowSec };
    ensureDir(dir);
    atomicWriteJSON(pathFor(dir), all);

    if (!fire) return null;
    return `facilitator context ~${fmtTokens(ctxTokens)}/turn — consider handing off to a fresh session to reset context cost`;
  } catch {
    return null; // never let the nudge break the stamp it rides in on
  }
}
