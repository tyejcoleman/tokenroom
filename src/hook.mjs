import { join } from 'node:path';
import { readState } from './state.mjs';
import { readConfig, modeProfile, fmtClock, fmtTokens, fmtDelta, readJSON, atomicWriteJSON, ensureDir, crossedReset, quotaScope } from './util.mjs';
import { captureHandoff, takeHandoff, renderHandoff } from './handoff.mjs';
import { readResume, resumeReady, planResume } from './resume.mjs';
import { logEvent, recentEvents } from './events.mjs';
import { listPins, renderPins } from './pins.mjs';
import { takeCheckpoint, renderCheckpoint } from './checkpoint.mjs';
import { takeContinuity, renderContinuityInjection } from './continuity.mjs';
import { sampleFlow, sessionFlowStats } from './flow.mjs';
import { facilitatorNudge } from './facilitator.mjs';
import { pairAdvice, staleEcho, profileForKey } from './accounts.mjs';
import { activeIntent, isFocused } from './intent.mjs';
import { loopActiveForSession, resolveSessionId } from './looprobe.mjs';

const STALE_SEC = 30 * 60;
// Burn-efficiency signal (tokenroom enhancement): below this out-tokens/min a session
// reads as idle/trivial — a "~12 tok/min" line is noise, not a meaningful burn-rate figure.
const MEANINGFUL_BURN_PER_MIN = 50;

// Hooks never receive `rate_limits`, so they resolve their session's account via the map the
// tap maintains (ADR-21) with quotaScope(): it returns {dir, show, key}. On a machine with ≥2
// accounts an UNMAPPED session gets show:false — the top-level pointer may belong to a
// CONCURRENT session on a different account, so EVERY quota-consuming hook must honor `show`
// and withhold window-derived output rather than quote the wrong account.

async function readStdin() {
  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    // best-effort
  }
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
}

/** PreCompact: snapshot ground-truth repo state so it survives the compaction.
 *  With compact_guard_min set, may block AUTO compaction near a window reset (ADR-13). */
export async function hookPreCompact() {
  const p = await readStdin();
  try {
    // Only apply the window-derived compact guard when we can attribute this session's account
    // (ADR-21 show-gate); the handoff snapshot below is session-level and always runs.
    const { dir, show } = quotaScope(p.session_id);
    const guardMin = readConfig().compact_guard_min;
    if (show && typeof guardMin === 'number' && guardMin > 0 && p.trigger === 'auto') {
      const resets = readState(dir)?.windows?.five_hour?.resets_at;
      const left = resets ? resets - Date.now() / 1000 : null;
      if (left !== null && left > 0 && left <= guardMin * 60) {
        logEvent({ type: 'compact_blocked', session_id: p.session_id ?? null, minutes_to_reset: Math.round(left / 60) });
        process.stdout.write(
          JSON.stringify({
            decision: 'block',
            reason: `tokenroom compact guard: the 5h window resets in ${Math.round(left / 60)}m — after the reset, /clear gives fresh context AND a fresh window, which beats compacting now. Run /compact to compact anyway, or unset compact_guard_min in ~/.tokenroom/config.json.`,
          })
        );
        return;
      }
    }
    captureHandoff({
      session_id: p.session_id,
      cwd: p.cwd,
      trigger: p.trigger,
      transcript_path: p.transcript_path,
      custom_instructions: p.custom_instructions,
    });
    logEvent({ type: 'pre_compact', session_id: p.session_id ?? null, trigger: p.trigger ?? null });
  } catch {
    // a failed snapshot (or guard) must never break compaction itself — fail open
  }
}

// Mid-turn awareness (T2.11/ADR-14): stamps fire only at UserPromptSubmit, so a long
// autonomous turn burns blind while state.json stays fresh on disk. PostToolUse
// re-stamps ONLY when a budget crosses a WORSENING band — first sight silent (the
// turn-start stamp covered it), improvements silent, throttled between re-stamps.
// Band thresholds, receipt floors, and the throttle come from the governor profile
// (T2.4): the mode shifts when tokenroom speaks, never what it says.
const bandOf = (left, bands) => bands.filter((t) => left <= t).length;

export async function hookPostToolUse() {
  const p = await readStdin();
  try {
    const { dir, key: myKey, show } = quotaScope(p.session_id); // this session's account subtree (ADR-21)
    sampleFlow(p.transcript_path, p.session_id, Date.now() / 1000, dir); // velocity engine's FAST signal (T2.1)
    // ≥2 accounts and this session isn't mapped yet → the resolved dir is the top-level pointer,
    // i.e. ANOTHER account's numbers. Withhold every window-derived re-stamp (bands, receipts,
    // exhaustion, pair advice) rather than mis-attribute a concurrent account's burn (ADR-21).
    if (!show) return;
    const cfg = readConfig();
    if (process.env.TOKENROOM_DISABLE === '1' || !cfg.stamp_enabled) return;
    const prof = modeProfile(cfg.mode);
    const s = readState(dir);
    const now = Date.now() / 1000;
    if (!s || now - s.updated_at > 5 * 60) return;
    const mySession = p.session_id ?? 'unknown';
    // Work-intent (ADR-25): a focused run (convergence/long-running/priority) flips descent
    // from cautious early-defer to spend-to-the-floor, and its 1% floor arms the queue for
    // in-session resume instead of a plain stop. Absent/expired/foreign-session → null → today's
    // behavior unchanged, so the default-path eval results still hold.
    const intent = activeIntent(p.session_id, now);
    const focused = isFocused(intent);

    if (crossedReset(s, now)) return; // window data predates a passed reset — wrong-signed, not stale
    const fhLeft = s.windows?.five_hour?.used_pct != null ? 100 - s.windows.five_hour.used_pct : null;
    const fhBand = fhLeft != null ? bandOf(fhLeft, prof.fh_bands) : 0;
    // context is session-scoped (ADR-7): ignore another session's numbers
    const foreign = s.session_id && p.session_id && s.session_id !== p.session_id;
    const ctx = foreign ? null : s.context;
    const ctxLeft = ctx?.used_pct != null ? Math.max(0, (ctx.compact_ceiling_pct ?? 80) - ctx.used_pct) : null;
    const ctxBand = ctxLeft != null ? bandOf(ctxLeft, prof.ctx_bands) : 0;
    const exh = !!(s.burn?.projected_exhaustion && s.windows?.five_hour?.resets_at && s.burn.projected_exhaustion < s.windows.five_hour.resets_at);
    // Quiet-until-it-matters (ADR-26): a cost receipt is routine quota "% left" surfacing, so
    // it stays silent while the 5h window is healthy. It fires only when the window is genuinely
    // actionable — at/below critical_pct, OR projected to run dry before the reset (`exh`). The
    // band-crossing re-stamp below is already governed by the mode profile's fh_bands (default
    // ondemand's first band = 25 = the default critical_pct), so it is left to the governor.
    const quotaActionable = fhLeft != null && (fhLeft <= cfg.critical_pct || exh);

    const bandsPath = join(dir, 'bands.json');
    const all = readJSON(bandsPath) ?? {};
    for (const k of Object.keys(all)) if (now - (all[k].t ?? 0) > 24 * 3600) delete all[k];
    const prev = all[mySession];
    const fhUsed = s.windows?.five_hour?.used_pct ?? null;
    const ctxUsed = ctx?.used_pct ?? null;
    const cost = !foreign && typeof s.session?.cost_usd === 'number' ? s.session.cost_usd : null;
    const save = (entry) => {
      all[mySession] = { ...entry, u: fhUsed, c: cost, cu: ctxUsed, t: now };
      ensureDir(dir);
      atomicWriteJSON(bandsPath, all);
    };
    if (!prev) return save({ fh: fhBand, ctx: ctxBand, exh, sc: false, at: 0 });

    // Cost receipt (T2.13): a single tool call that visibly moved the budget gets a
    // one-line receipt — per-action unit economics, not just a balance. Floors keep it
    // rare; window % is account-level, so a concurrent session's burn can co-attribute
    // (acceptable at a ≥2-point floor; exact attribution lands with T2.1 flow).
    const receipts = [];
    // a baseline sampled in a PREVIOUS window makes deltas meaningless (field 2026-06-11:
    // a false "≈64%" receipt spanned the overnight reset) — rebaseline, no receipt
    const windowStart = s.windows?.five_hour?.resets_at ? s.windows.five_hour.resets_at - 5 * 3600 : null;
    const sameWindow = !(windowStart && (prev.t ?? 0) < windowStart);
    const du = sameWindow && fhUsed != null && prev.u != null ? fhUsed - prev.u : null;
    const dc = sameWindow && cost != null && prev.c != null ? cost - prev.c : null;
    if (quotaActionable && ((du != null && du >= prof.receipt_pct_floor) || (dc != null && dc >= prof.receipt_cost_floor))) {
      let r = `receipt: that ${p.tool_name ?? 'operation'} cost ≈`;
      r += du != null && du >= prof.receipt_pct_floor ? `${Math.round(du)}% of the 5h window` : `$${dc.toFixed(2)}`;
      if (du != null && du >= prof.receipt_pct_floor && dc != null && dc >= 0.01) r += ` (+$${dc.toFixed(2)})`;
      if (fhLeft != null) r += ` — ${Math.round(fhLeft)}% left`;
      receipts.push(r);
      logEvent({ type: 'receipt', session_id: p.session_id ?? null, tool: p.tool_name ?? null, dpct: du != null ? Math.round(du * 10) / 10 : null, dcost: dc != null ? Math.round(dc * 100) / 100 : null });
    }

    const emit = (lines) =>
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `[tokenroom] mid-task update: ${lines.join(' · ')}` },
        })
      );

    // Continuity-aware ctx triggers: don't nag for a handoff once you've already saved one
    // (kills the redundant 6%→3% re-saving), prompt at the NEXT task boundary, and fire ONE
    // velocity-timed "super close but safe" nudge so the final save lands just before the
    // ceiling — then the agent powers through to auto-compaction instead of stopping.
    const tok = ctx?.tokens_to_ceiling ?? null;
    const ceilingPct = ctx?.compact_ceiling_pct ?? 80;
    const superClose = tok != null && tok <= 12000; // room for one ~1-2k handoff, then ride it in
    let savedRecently = false;
    let savedNote = '';
    if (ctxLeft != null) {
      const savedAt = Math.max(takeCheckpoint(p.session_id)?.at ?? 0, takeContinuity(p.session_id, p.cwd)?.at ?? 0);
      const ago = savedAt ? now - savedAt : null;
      savedRecently = ago != null && ago < 150; // ~2.5 min: already captured, don't re-prompt
      savedNote = ago != null ? ` (handoff already saved ${ago < 90 ? 'moments' : `${Math.round(ago / 60)}m`} ago — don't re-save unless state changed)` : '';
    }
    // PostToolUse fires per tool call, so Δ(ctx used%) per call ≈ context burned per call →
    // a natural "tool calls until auto-compaction" estimate
    let callsLeft = null;
    if (prev.cu != null && ctxUsed != null && ctxUsed > prev.cu) {
      callsLeft = Math.max(1, Math.round((ceilingPct - ctxUsed) / (ctxUsed - prev.cu)));
    }
    const eta = callsLeft != null ? `, ≈${callsLeft} tool call${callsLeft === 1 ? '' : 's'} at this pace` : '';
    const scMsg =
      superClose && !prev.sc && !savedRecently
        ? `SUPER CLOSE to auto-compaction (~${fmtTokens(tok)} tokens before the ceiling${eta} — still safe to write once): make your handoff current NOW via the tokenroom \`handoff\` tool, then POWER THROUGH — keep issuing tool calls until it fires. MECHANISM (agents get this wrong): auto-compaction triggers at the START of your NEXT turn, and only if you take one — your next tool call IS the trigger. Ending your turn — even to announce "I'll let it compact" — goes idle and BLOCKS compaction until the user manually sends a message; that announce-and-stop is the stall, not the fix. So don't narrate waiting: if work remains, your next output is a tool call, not a sign-off.${savedNote}`
        : null;
    const scLatched = superClose ? prev.sc || scMsg != null : false;

    const worsened = fhBand > prev.fh || ctxBand > prev.ctx || (exh && !prev.exh);
    const throttled = now - (prev.at ?? 0) < prof.throttle_sec;
    if (throttled) {
      if (worsened) logEvent({ type: 'band_change', session_id: p.session_id ?? null, held: true, fh_left: fhLeft != null ? Math.round(fhLeft) : null });
      // record improvements so a later re-worsening re-triggers; hold worsenings for retry
      save({ fh: Math.min(prev.fh, fhBand), ctx: Math.min(prev.ctx, ctxBand), exh: prev.exh && exh, sc: scLatched, at: prev.at });
      const urgent = [...receipts, ...(scMsg ? [scMsg] : [])]; // both bypass the band throttle
      if (urgent.length) emit(urgent);
      return;
    }

    const parts = [];
    if (fhLeft != null && fhBand > prev.fh) {
      // advice keyed to the absolute level, not the band index — bands vary by mode
      // descent profile: work all the way down, but shrink work DIVISIBILITY with quota
      // Smart override: the real risk is running dry BEFORE the reset, not low %.
      // If the window resets soon — or velocity says you'll reset before you'd exhaust —
      // do NOT slow down; you refill before it matters. Deterministic from resets_at +
      // projected_exhaustion (the velocity engine's burn projection).
      const resetsAt = s.windows.five_hour.resets_at;
      const minsToReset = resetsAt ? (resetsAt - now) / 60 : null;
      // Optimism requires a POSITIVE signal: we KNOW the reset lands before we'd run dry.
      // Unknown burn → stay cautious (don't assume safety we can't prove).
      const resetBeatsExhaustion = !!(s.burn?.projected_exhaustion && resetsAt && s.burn.projected_exhaustion >= resetsAt);
      // Descent policy (ADR-19): use the window aggressively — full speed until 5% left,
      // then be velocity-mindful (but keep working) down to a 1% floor, where it's
      // finishing-moves only. The 1–5% band keeps a stranding guard: prefer divisible
      // steps + frequent checkpoints so a long task isn't lost at the reset.
      // PAIR-AWARE DESCENT (ADR-24): when another labeled profile has fresh headroom, the
      // descent applies to the PAIR — low active quota means land-and-switch, not throttle;
      // defer (plan_resume) only when BOTH profiles are thin.
      const pa = fhLeft <= 15 ? pairAdvice(myKey, fhLeft, now) : null;
      const kindLabel = focused ? (intent.kind === 'long_running' ? 'long-running' : intent.kind) : null;
      const advice =
        minsToReset != null && minsToReset > 0 && minsToReset <= 10
          ? `reset in ~${Math.max(1, Math.round(minsToReset))}m — quota refills imminently; do NOT slow down or defer, keep full speed (you refill well before you could run dry)`
          : resetBeatsExhaustion && fhLeft <= 15
            ? `${fhLeft <= 5 ? 'quota is low' : 'quota getting low'}, BUT at current burn you reset BEFORE you'd run dry — keep working at full speed; only defer a genuinely huge new task`
            : pa
              ? fhLeft <= 1
                ? `at the 1% floor — land and switch: commit in-flight work, checkpoint, then switch to profile '${pa.other.label}' (${pa.pct}) via /login or \`tokenroom switch\` — zero downtime, no defer needed`
                : `${fhLeft <= 5 ? 'quota is low' : 'quota getting low'}, but ${pa.text}`
              : fhLeft <= 1
                ? focused
                  ? `at the 1% floor — arm in-session resume: commit in-flight work, checkpoint, then plan_resume the REMAINING QUEUE with arm:true — tokenroom continues it in THIS session once the window resets${resetsAt ? ` (schedule a wakeup ~${fmtClock(resetsAt)} if you'll be idle until then)` : ''}; start no new INDIVISIBLE work, but nothing else stops`
                  : 'at the 1% floor — finishing moves only: commit in-flight work, checkpoint, plan_resume the rest, start nothing new'
                : fhLeft <= 5
                  ? focused
                    ? `${kindLabel} run — keep FULL SPEED to the 1% floor, do NOT defer or throttle here: just keep each step divisible and your handoff/queue current so nothing strands, and land-and-arm only AT the floor`
                    : 'be mindful of velocity — keep working, but prefer small divisible steps and checkpoint often so nothing is stranded at the reset; defer a genuinely huge or indivisible new task (plan_resume)'
                  : 'plenty remains — keep working at full speed; just check that big new tasks fit before the reset';
      const estTok = s.burn?.est_tokens_left != null ? ` (≈${fmtTokens(s.burn.est_tokens_left)} tokens of quota)` : '';
      parts.push(`5h window now ${Math.round(fhLeft)}% left${estTok}${s.windows.five_hour.resets_at ? `, resets ${fmtClock(s.windows.five_hour.resets_at)}` : ''} — ${advice}`);
    }
    if (exh && !prev.exh) {
      const est = s.burn?.est_tokens_left;
      parts.push(
        `at current burn may exhaust ~${fmtClock(s.burn.projected_exhaustion)}, before the reset — ` +
          (est != null && est > 100000
            ? `but ≈${fmtTokens(est)} tokens of quota remain (hours of normal work): keep working, right-size new tasks to fit before the reset, defer only what does not`
            : `right-size: finish in-flight work at a clean boundary; defer heavy new work (plan_resume)`)
      );
    }
    if (ctxLeft != null && ctxBand > prev.ctx && !savedRecently && !superClose) {
      parts.push(
        `context getting low (~${tok != null ? `${fmtTokens(tok)} tokens` : `${Math.round(ctxLeft)}%`} before auto-compaction${eta}) — BURN IT, don't conserve it. Low context is NEVER a reason to slow, stop, hand back control, wrap up, or get cautious — that only strands the task and blocks the auto-compaction that refreshes you. MECHANISM: compaction fires at the START of your next turn and ONLY if you take one, so ending your turn to "let it compact" goes idle and blocks it until the user nudges — your next tool call is what triggers it. The one thing it asks: keep your handoff current (refresh at your NEXT task boundary via the tokenroom \`handoff\` tool — no need to re-save before then), then keep working at full speed until auto-compaction fires; the session resumes seamlessly from your handoff. This is CONTEXT — quota/rate-limit is the OTHER budget: THAT one you stay wary of and pace/defer at the reset, never the reverse.${savedNote}`
      );
    }

    const emittedAny = parts.length > 0 || scMsg != null;
    save({ fh: fhBand, ctx: ctxBand, exh, sc: scLatched, at: emittedAny ? now : prev.at });
    if (fhBand !== prev.fh || ctxBand !== prev.ctx || exh !== prev.exh) {
      logEvent({
        type: 'band_change',
        session_id: p.session_id ?? null,
        emitted: emittedAny,
        fh_left: fhLeft != null ? Math.round(fhLeft) : null,
        exh,
      });
    }
    const lines = [...receipts, ...(scMsg ? [scMsg] : []), ...parts];
    if (lines.length) emit(lines);
  } catch {
    // mid-turn awareness is best-effort; never interfere with the tool loop
  }
}

/**
 * Launch gate (T2.14): an agent about to overspend won't audit itself — structurally
 * fit_check expensive launches (subagents/workflows) and intervene when the window verdict
 * is `defer` or in late descent (≤5%). Two activation paths: the opt-in `launch_gate`
 * config, OR an active FOCUSED intent (ADR-25) — declaring a long-running run opts you into
 * "warn me + auto-arm before a big indivisible launch dies in a thin window". Under a
 * focused intent the gate WARN-AND-ARMS: it records an armed resume plan so the launch
 * auto-continues in-session after the reset, rather than a bare block. Fail-open everywhere
 * (ADR-13 pattern): missing state, missing config, any error → allow.
 */
const EXPENSIVE_TOOLS = ['Task', 'Agent', 'Workflow'];

export async function hookPreToolUse() {
  const p = await readStdin();
  try {
    if (!EXPENSIVE_TOOLS.includes(p.tool_name)) return;
    const now = Date.now() / 1000;
    const focused = isFocused(activeIntent(p.session_id, now));
    if (!readConfig().launch_gate && !focused) return;
    // ≥2 accounts and this session unmapped → we can't attribute a window to it; deny using the
    // top-level pointer would gate on ANOTHER account's quota, so fail open (ADR-21 show-gate).
    const { dir, show } = quotaScope(p.session_id);
    if (!show) return;
    const s = readState(dir);
    if (!s || now - s.updated_at > STALE_SEC) return;
    const { fitCheck } = await import('./fit.mjs');
    const fit = fitCheck(s, { est_tokens: 40000 }); // conservative launch-sized estimate
    const fhLeft = s.windows?.five_hour?.used_pct != null ? 100 - s.windows.five_hour.used_pct : null;
    // deny at defer, and in late descent (≤5% left): an expensive launch is INDIVISIBLE —
    // it cannot be checkpointed mid-flight, so a dying window wastes the whole bet
    if (fit?.window?.verdict !== 'defer' && !(fhLeft != null && fhLeft <= 5)) return;
    const resets = s.windows?.five_hour?.resets_at;
    // Under a focused intent, don't just BLOCK — capture the launch as an ARMED resume plan
    // so it auto-continues in-session after the reset (warn-and-arm). Never clobber a richer
    // plan the agent already wrote: only auto-arm when no plan exists.
    let armed = false;
    if (focused) {
      const existing = readResume(now);
      if (!existing) {
        try {
          armed = !!planResume(
            { summary: `deferred ${p.tool_name} launch`, queue: [`${p.tool_name} launch deferred by the launch gate (thin 5h window) — re-issue it after the reset`], blocked_on: 'five_hour', arm: true, est_tokens: 40000 },
            s,
            now
          )?.armed;
        } catch {
          // arming is best-effort; still deny below so the launch doesn't die mid-flight
        }
      } else {
        armed = !!existing.armed;
      }
    }
    // Field directive 2026-07-05: during a declared (focused) run, WARN — never STOP. Tell the
    // agent it can keep going, resource-aware, with an armed fallback; a launch is a new-engagement
    // moment, which is the only place we speak up. Only the EXPLICIT launch_gate opt-in hard-denies.
    if (focused) {
      logEvent({ type: 'launch_warned', session_id: p.session_id ?? null, tool: p.tool_name, armed });
      const note = `[tokenroom] resource-aware heads-up (NOT a stop — keep going): the 5h window is nearly empty${resets ? ` (resets ${fmtClock(resets)})` : ''}, so this ${p.tool_name} launch may not finish before the reset.${armed ? ' A resume fallback is ARMED, so nothing is lost if it doesn\'t.' : ''} If the work is divisible/checkpointable, proceed; if it is big and indivisible, prefer a small piece first or schedule a wakeup at the reset. You do not need to stop.`;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } }));
      return;
    }
    logEvent({ type: 'launch_blocked', session_id: p.session_id ?? null, tool: p.tool_name, armed });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `tokenroom launch gate: the 5h window is nearly empty${resets ? ` (resets ${fmtClock(resets)})` : ''} — an expensive ${p.tool_name} launch now risks dying mid-work. Record the work with plan_resume and defer past the reset, or do a small piece inline. Disable: launch_gate in ~/.tokenroom/config.json.`,
        },
      })
    );
  } catch {
    // the gate must be impossible to blame for a wedged session — fail open
  }
}

/**
 * Stop hook (ADR-25): in-session auto-resume. When a FOCUSED run has ARMED a resume plan
 * and the blocked window has reset, the agent yielding control is exactly the moment to
 * CONTINUE — block the stop and inject the next queued task so THIS interactive session
 * keeps going (never headless; the ADR-22 boundary holds — this is the same session whose
 * quota the work was deferred from). Strictly opt-in and fail-open: no focused intent / not
 * armed / not yet ready / already re-fired this turn (stop_hook_active) → allow the stop,
 * always. It is the only hook that can PREVENT a stop, so every uncertainty allows.
 */
export async function hookStop() {
  const p = await readStdin();
  try {
    if (p.stop_hook_active) return; // we already forced a continue this turn — never loop
    const now = Date.now() / 1000;
    if (!isFocused(activeIntent(p.session_id, now))) return; // opt-in: only inside a focused run
    const plan = readResume(now);
    if (!plan || !plan.armed || !resumeReady(plan, now)) return; // nothing armed-and-ready to continue
    // Clock-passed is necessary but not sufficient: if this session's account state still
    // shows the blocked window dry, continuing would just hit 429s — fail open (allow stop).
    const { dir, show } = quotaScope(p.session_id);
    if (show) {
      const w = readState(dir)?.windows?.[plan.blocked_on];
      const left = w?.used_pct != null ? 100 - w.used_pct : null;
      if (left != null && left <= 2 && w?.resets_at && now < w.resets_at) return;
    }
    const next = plan.queue?.[0]?.task ?? plan.summary;
    const rest = Math.max(0, (plan.queue?.length ?? 0) - 1);
    logEvent({ type: 'resume_continued', session_id: p.session_id ?? null, queued: plan.queue?.length ?? 0, blocked_on: plan.blocked_on });
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: `[tokenroom] deferred work is ready — the ${plan.blocked_on === 'seven_day' ? '7d weekly' : '5h'} window has reset, so continue IN THIS SESSION rather than stopping. Next: ${next}${rest ? ` · then ${rest} more queued (\`tokenroom resume\` shows all)` : ''}. When the queue is genuinely finished, run \`tokenroom resume --clear\` and \`tokenroom intent clear\` so this stops firing.`,
      })
    );
  } catch {
    // the ONE hook that can prevent a stop must never trap a session — fail open (allow the stop)
  }
}

/** PostCompact: record that a compaction completed (observability, ADR-13/T2.9). */
export async function hookPostCompact() {
  const p = await readStdin();
  try {
    logEvent({ type: 'post_compact', session_id: p.session_id ?? null, trigger: p.trigger ?? null });
  } catch {
    // best-effort
  }
}

/** SessionStart: re-inject the handoff + pins after compaction; flag ready deferred work. */
export async function hookSessionStart() {
  const p = await readStdin();
  logEvent({ type: 'session_start', session_id: p.session_id ?? null, source: p.source ?? null });
  const parts = [];
  if (p.source === 'compact') {
    // facts first (hook-captured), then judgment (model-authored) — ADR-8 + ADR-15
    const snap = takeHandoff(p.session_id);
    if (snap) parts.push(renderHandoff(snap));
    const note = takeCheckpoint(p.session_id);
    if (note) parts.push(renderCheckpoint(note));
    // the rich, model-authored canonical handoff doc (ADR-18); project-scoped (ADR-28) so a
    // different project's doc can never surface here — pointer + digest, read on demand
    const doc = takeContinuity(p.session_id, p.cwd);
    if (doc) parts.push(renderContinuityInjection(doc));
    const pins = listPins();
    if (pins.length) parts.push(renderPins(pins));
  }
  const plan = readResume();
  if (resumeReady(plan)) {
    const win = plan.blocked_on === 'seven_day' ? '7d weekly' : '5h';
    const nq = plan.queue?.length ?? 0;
    parts.push(
      `[tokenroom] deferred work is now ready (the ${win} window has reset): "${String(plan.summary ?? '')}"${nq ? ` — ${nq} queued task${nq > 1 ? 's' : ''}` : ''}.${plan.armed ? ' It is ARMED to continue in-session — pick it up now and keep going.' : ''} Surface this to the user, and run \`tokenroom resume --clear\` once it is picked up.`
    );
  }
  if (!parts.length) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
    })
  );
}

/**
 * UserPromptSubmit hook: emit a tiny tokenroom stamp as additionalContext.
 * Wording rule (validated in eval v0/v1): always REMAINING-first, with absolute
 * tokens where known. Silent when disabled, missing, or stale — never inject a lie.
 */
export async function hookUserPromptSubmit() {
  const payload = await readStdin();
  const mySession = payload.session_id ?? null;
  // Resolve THIS session's account directory (ADR-21). showQuota is false only when ≥2
  // accounts exist and this session isn't mapped to one yet — then we withhold quota rather
  // than risk showing a concurrent account's numbers. Single-account/legacy users are
  // unaffected (showQuota stays true).
  const { dir, show: showQuota, key: myKey } = quotaScope(mySession);
  sampleFlow(payload.transcript_path, mySession, Date.now() / 1000, dir); // velocity engine's FAST signal (T2.1)

  const cfg = readConfig();
  if (process.env.TOKENROOM_DISABLE === '1' || !cfg.stamp_enabled) {
    logEvent({ type: 'stamp_skipped', session_id: mySession, reason: 'disabled' });
    return;
  }
  // Current local time + timezone — the agent otherwise has no reliable "now" for
  // time-of-day / scheduling / deadline decisions. Kept tiny here (every prompt); the
  // fuller "use it for decisions, not a budget figure" framing rides SessionStart once.
  const nowD = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const nowPart = `now ${nowD.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} ${tz}`;

  const s = readState(dir);
  if (!s || Date.now() / 1000 - s.updated_at > STALE_SEC) {
    logEvent({ type: 'stamp_skipped', session_id: mySession, reason: s ? 'stale_state' : 'no_state' });
    return;
  }

  // Rate-limit windows are account-level (true for every session). Context is
  // session-level: when state.json was last written by a DIFFERENT concurrent session,
  // its context would be a lie here — omit it.
  const foreign = mySession && s.session_id && mySession !== s.session_id;

  const parts = [];
  const fh = s.windows?.five_hour;
  const sd = s.windows?.seven_day;
  const ctx = foreign ? null : s.context;
  // Quiet-until-it-matters (ADR-26): the every-turn quota stamp is the loudest budget noise,
  // so it stays SILENT while the 5h window is healthy. It surfaces only when genuinely
  // actionable — at/below critical_pct, OR the burn model projects running dry BEFORE the
  // reset (the two deterministic "it matters now" cases). Above that, the recurring quota
  // line, its pair-aware advice, and the shared-session note are withheld so the model isn't
  // burdened. NON-budget output (wall clock, context, deferred work, drop note) and the rare
  // one-shot disclosures (window reset, account switch, pre-switch echo) are unaffected; the
  // weekly window keeps its own <20%-left gate.
  const fhLeft = fh?.used_pct != null ? 100 - fh.used_pct : null;
  const eBand = s.burn?.exhaustion_band;
  const eTime = s.burn?.projected_exhaustion;
  const exhaustsBeforeReset =
    !!(eBand && fh?.resets_at && eBand[0] < fh.resets_at) || !!(eTime && fh?.resets_at && eTime < fh.resets_at);
  const quotaActionable = fhLeft != null && (fhLeft <= cfg.critical_pct || exhaustsBeforeReset);
  // Two field-observed conflations (2026-06-10, twice) drove this format: agents read
  // quota tokens/reset clocks as CONTEXT that "comes back at HH:MM". It never does.
  // Explicit "quota —/context —" labels + the contrast clause, probe-validated
  // (eval/v3-wording results: both disambiguated cells cited the clause as decisive).
  // One-shot switch disclosure (ADR-24): the tap logged an `account_switch` when this
  // session's payload re-keyed to a different account (/login mid-session). Announce it
  // ONCE, with the NEW account's numbers, then return to normal stamps.
  let switched = null;
  const swEvents = recentEvents(15 * 60).filter((e) => e.type === 'account_switch' && (!mySession || e.session_id === mySession));
  const lastSw = swEvents[swEvents.length - 1];
  // ref carries the destination key too: two switches inside the same second (A→B→C)
  // must not let the first announcement swallow the second
  const swRef = lastSw ? `${lastSw.at}:${lastSw.to}` : null;
  if (lastSw && !recentEvents(15 * 60).some((e) => e.type === 'switch_announced' && e.ref === swRef)) switched = lastSw;

  const resetAt = crossedReset(s);
  if (showQuota && resetAt) {
    parts.push(
      `quota — the 5h window RESET at ${fmtClock(resetAt)}: quota is FRESH (effectively full). Earlier figures in this conversation and any "nearly dry" warnings predate the reset — disregard them; exact numbers arrive with the next statusline render`
    );
  } else if (showQuota && fh?.used_pct != null) {
    const echo = staleEcho(myKey, s);
    if (switched) {
      // the switch banner IS this stamp's quota segment — same numbers, one disclosure
      const label = profileForKey(myKey) ?? myKey ?? switched.to;
      let seg = `account switched — now on '${label}': 5h ${Math.round(100 - fh.used_pct)}% left`;
      if (fh.resets_at) seg += `, resets ${fmtClock(fh.resets_at)}`;
      parts.push(seg);
      logEvent({ type: 'switch_announced', ref: swRef });
    } else if (echo) {
      // ECHO HONESTY (ADR-24): a dry figure whose values haven't moved in minutes, while a
      // sibling account has values-newer data, is probably a pre-switch echo — say so
      // instead of asserting it as fresh. Never inject a lie (ADR-5 spirit).
      const sib = echo.sibling;
      const sibName = sib.label ? `profile '${sib.label}'` : `account ${sib.key}`;
      parts.push(
        `quota — 5h: ${Math.round(100 - fh.used_pct)}% left (UNCHANGED for ${echo.frozen_min}m — possibly a pre-switch echo; if you just ran /login, figures refresh on the next completed turn; ${sibName} last seen ${sib.fh_left != null ? `≈${Math.round(sib.fh_left)}% left` : 'with fresher data'})`
      );
    } else if (quotaActionable) {
      // The routine per-turn quota line — surfaced ONLY when the window is genuinely
      // actionable (ADR-26); above critical_pct with no before-reset exhaustion this whole
      // branch is skipped and the stamp says nothing about quota.
      let seg = `quota — 5h: ${Math.round(100 - fh.used_pct)}% left`;
      if (s.burn?.est_tokens_left != null) seg += ` (≈${fmtTokens(s.burn.est_tokens_left)} tokens of quota)`;
      if (fh.resets_at) seg += `, resets ${fmtClock(fh.resets_at)}`;
      const band = s.burn?.exhaustion_band;
      const exh = s.burn?.projected_exhaustion;
      const nowSec = Date.now() / 1000;
      // surface the runway: WHEN constant work at this velocity stops you, AND how long that
      // is from now (the conservative/earliest edge), so "when do I get cut off" reads instantly.
      if (band && fh.resets_at && band[0] < fh.resets_at) {
        const runway = band[0] > nowSec ? ` — ≈${fmtDelta(band[0] - nowSec)} of work left at this pace` : '';
        seg += ` (at current pace, may run dry ~${fmtClock(band[0])}–${fmtClock(band[1])}${runway})`;
      } else if (exh && fh.resets_at && exh < fh.resets_at) {
        const runway = exh > nowSec ? ` — ≈${fmtDelta(exh - nowSec)} of work left at this pace` : '';
        seg += ` (at current burn, may exhaust ~${fmtClock(exh)}${runway})`;
      }
      parts.push(seg);
    }
    // PAIR-AWARE DESCENT (ADR-24): active window low + the OTHER labeled profile fresh and
    // healthy → the move is power-through-then-switch, never throttle. Both-thin keeps
    // today's defer wording; healthy active says nothing here (noise discipline). Gated with
    // the quota line (ADR-26): a healthy window above critical_pct never raises the pair.
    if (quotaActionable) {
      const pa = pairAdvice(myKey, 100 - fh.used_pct);
      if (pa) parts.push(pa.text);
    }
  }
  // The weekly window is hidden from the LLM until it is actually a binding constraint:
  // surface it (and any HOT-pace coaching) ONLY once <20% remains (user directive
  // 2026-06-22). Above that, a healthy 7d window is noise that invites premature
  // throttling — so we don't even tell the model. The human-facing HUD/watch is unaffected.
  const WEEKLY_DISCLOSE_PCT = 20;
  // Weekly-warning control (ADR-27): gates ONLY this line, independent of the ADR-26
  // critical_pct gate on the 5h line above. 'on' (default) is a no-op here — the
  // short-circuit && below means loopActiveForSession is never even called, so 'on'
  // stays byte-identical to pre-ADR-27 behavior. 'off' always suppresses. 'auto' (opt-in)
  // suppresses only while a belay loop is armed-and-active for THIS session; absent/
  // corrupt belay data resolves to false (loopActiveForSession never throws), so 'auto'
  // with no belay installed behaves exactly like 'on'.
  const weeklySuppressed = cfg.weekly_warning === 'off' || (cfg.weekly_warning === 'auto' && loopActiveForSession(resolveSessionId(mySession)));
  if (!weeklySuppressed && showQuota && sd?.used_pct != null && 100 - sd.used_pct < WEEKLY_DISCLOSE_PCT) {
    let wkSeg = `7d: ${Math.round(100 - sd.used_pct)}% left`;
    const wk = s.burn?.weekly;
    if (wk?.hot && wk.projected_exhaustion && sd.resets_at) {
      wkSeg += ` — weekly pace is HOT (${wk.pace_ratio}x sustainable): on track to exhaust the WEEK in ~${fmtDelta(wk.projected_exhaustion - Date.now() / 1000)}, ${fmtDelta(sd.resets_at - wk.projected_exhaustion)} before its reset; ≈${wk.daily_allowance_pct}%/day sustains — prefer deferring bulk work and tighter batching until pace cools`;
    } else if (wk) {
      wkSeg += ` (cruising: ≈${wk.daily_allowance_pct}%/day sustains to the weekly reset)`;
    }
    parts.push(wkSeg);
  }
  // the 5h window is ACCOUNT-level: other open sessions burn it too. Sessions whose
  // hooks touched bands.json recently are live burners — disclose them (field 2026-06-10:
  // a 29-point single-call "receipt" was a concurrent session's burn, co-attributed).
  // This is meta-info ABOUT the quota figure, so it rides the same gate (ADR-26): when the
  // quota line is withheld above critical_pct, the shared-session note would be contextless.
  if (showQuota && quotaActionable) try {
    // bands.json is per-account, so this count and the combined burn are SAME-account
    // sessions only (ADR-20 refined by ADR-21) — a sibling on another account no longer
    // inflates "sessions sharing this quota".
    const bands = readJSON(join(dir, 'bands.json')) ?? {};
    const nowSec = Date.now() / 1000;
    const others = Object.entries(bands).filter(([k, v]) => k !== (mySession ?? 'unknown') && nowSec - (v.t ?? 0) < 30 * 60).length;
    if (others > 0) {
      let line = `${others + 1} sessions sharing this quota`;
      const sf = sessionFlowStats(nowSec, mySession, dir);
      if (sf && sf.combinedPerMin > 0) line += `, combined burn ≈${fmtTokens(sf.combinedPerMin)} tok/min across ${sf.burning} actively burning`;
      line += ` (their burn is already in these figures — do not re-discount; expect bursts, re-check often)`;
      if (sf?.anomaly) {
        line += sf.anomaly.isMine
          ? ` — ⚠ YOU are the hot burner (~${sf.anomaly.ratio}× the others, ≈${fmtTokens(sf.anomaly.perMin)} tok/min): ease off so you don't drain the shared window`
          : ` — ⚠ one other session is burning ~${sf.anomaly.ratio}× the rest (≈${fmtTokens(sf.anomaly.perMin)} tok/min): the shared window can drop fast, re-check often`;
      }
      parts.push(line);
    }
  } catch {
    // disclosure is best-effort
  }
  const hadWindow = parts.length > 0;
  if (ctx?.tokens_to_ceiling != null) {
    parts.push(`context — ~${fmtTokens(ctx.tokens_to_ceiling)} tokens before compaction${hadWindow ? ' (quota resets do NOT restore context)' : ''}`);
  } else if (ctx?.used_pct != null) {
    parts.push(`context — ${Math.max(0, Math.round((ctx.compact_ceiling_pct ?? 80) - ctx.used_pct))}% left before compaction${hadWindow ? ' (quota resets do NOT restore context)' : ''}`);
  }
  // Burn-efficiency signal + facilitator-cost nudge (tokenroom enhancement, Tye's
  // token-efficiency priority): a per-turn read on how fast THIS session is spending
  // tokens, plus — for a long-running driver/orchestrator ("facilitator") session — a
  // nudge to hand off once resending its own growing context every turn is itself the
  // biggest waste (a fresh session doing the same next step is far cheaper). Both ride
  // the single `facilitator_nudge_enabled` switch (default on): disabled, or below the
  // respective floor/threshold, leaves `parts` — and so the emitted stamp — untouched
  // (byte-identical to pre-enhancement output).
  if (cfg.facilitator_nudge_enabled) {
    try {
      // sessionFlowStats filters by the `s` session tag on each sample, so this is
      // THIS session's own real out-tokens/min regardless of account-dir attribution —
      // unlike the window %/cost figures above, no cross-account risk to gate on.
      const sf = sessionFlowStats(Date.now() / 1000, mySession, dir);
      if (sf?.mine && sf.mine.perMin >= MEANINGFUL_BURN_PER_MIN) {
        parts.push(`burn — ~${fmtTokens(sf.mine.perMin)} tok/min this session (10m)`);
      }
    } catch {
      // best-effort; a missing/corrupt flow log must never block the stamp
    }
    try {
      // Current context SIZE (not a delta) is what actually gets resent — and paid for
      // — on the NEXT turn, so it doubles as the real "cost per turn" figure.
      const ctxTokensUsed =
        typeof ctx?.window_size === 'number' && typeof ctx?.used_pct === 'number' ? Math.round((ctx.window_size * ctx.used_pct) / 100) : null;
      const nudge = ctxTokensUsed != null ? facilitatorNudge(mySession, ctxTokensUsed, cfg, Date.now() / 1000, dir) : null;
      if (nudge) parts.push(nudge);
    } catch {
      // best-effort; never block the stamp over the nudge
    }
  }

  const plan = readResume();
  if (resumeReady(plan)) {
    parts.push(`deferred work now ready: "${String(plan.summary ?? '').slice(0, 60)}"${plan.queue?.length ? ` (${plan.queue.length} queued${plan.armed ? ', armed — auto-continues in-session' : ''})` : ''}`);
  }

  // Microcompaction is silent (no hook fires) — if the tap saw an unexplained context
  // cliff for this session, disclose it once, with the recovery path.
  const drops = recentEvents(10 * 60).filter((e) => e.type === 'context_drop' && (!mySession || e.session_id === mySession));
  const drop = drops[drops.length - 1];
  if (drop && !recentEvents(10 * 60).some((e) => e.type === 'drop_announced' && e.ref === drop.at)) {
    let note = `note: context shrank ~${drop.dropped_tokens ? `${fmtTokens(drop.dropped_tokens)} tokens` : `${drop.dropped_pct}%`} without a compaction (upstream trimming of old tool results)`;
    if (typeof payload.transcript_path === 'string') note += `; exact history survives at ${payload.transcript_path}`;
    parts.push(note);
    logEvent({ type: 'drop_announced', ref: drop.at });
  }

  parts.unshift(nowPart); // lead with the wall clock so the agent always knows "now"

  // Fresh and 25-minutes-old look identical otherwise; disclose age once it's not "now".
  const ageSec = Date.now() / 1000 - s.updated_at;
  const ageMark = ageSec > 120 ? ` (${Math.round(ageSec / 60)}m old)` : '';

  logEvent({
    type: 'stamp',
    session_id: mySession,
    fh_left: fh?.used_pct != null ? Math.round(100 - fh.used_pct) : null,
    ctx_tokens: ctx?.tokens_to_ceiling ?? null,
  });

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `[tokenroom] ${parts.join(' · ')}${ageMark}`,
      },
    })
  );
}
