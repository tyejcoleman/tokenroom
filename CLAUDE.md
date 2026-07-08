# Tokenroom — agent working context

Tokenroom is a **resource-aware layer for coding agents**. It makes the agent aware of
its two scarcest resources — account **rate-limit headroom** (5h / 7d windows) and
session **context headroom** (tokens before compaction) — so it can plan work to fit,
spend efficiently, and use capacity that would otherwise expire.

## Read this before any work

1. `docs/ARCHITECTURE.md` — what talks to what: data flow, module map, extension points.
2. `docs/DECISIONS.md` — the ADR log: every standing decision with its why. **Do not
   silently violate an ADR**; propose a new one instead.
3. `docs/PLAN.md` — the phased plan; every task has acceptance criteria (AC).
4. Background when needed: `docs/ONE-PAGER.md` (original design), `docs/VALIDATION.md`
   (assumption gates + eval methodology).

## Hard gates (enforced, not advisory)

`scripts/check-invariants.mjs` runs after every Edit/Write you make (repo PostToolUse
hook) and inside `npm test`/CI. It blocks: new dependencies or non-builtin imports
(ADR-2), any network surface (ADR-1/G3), compliance tripwires (ADR-1/G4), and
catch-free tap/hook entry points (ADR-5). If a gate blocks you and you believe you're
right, stop and propose an ADR change — never work around a gate.

## Procedures (repo slash-commands)

`/release` (version → CHANGELOG → tag → publish checklist) · `/add-fixture` (new payload
shape → sanitized fixture + tests) · `/run-evals` (required for any stamp/skill/verdict
wording change, per ADR-9).

## Hard rules (compliance — non-negotiable)

These are the project's reason to exist responsibly. Any change that touches them is wrong:

- **Official extension points only:** statusline stdin JSON, hooks (`UserPromptSubmit`,
  `SessionStart`, `PreCompact`, `PreToolUse`), MCP, OTel, and the user's own
  `~/.claude` / `~/.codex` files.
- **Never** reuse a subscription OAuth token outside the official client, call
  undocumented endpoints (e.g. `api/oauth/usage`), spoof harness identity headers, read
  `.credentials.json` to make API calls, or burn interactive subscription quota headlessly.
  (The ADR-16 carve-out that once allowed user-armed headless spend is withdrawn — ADR-22
  removed the ARM executor; autonomous continuation belongs to the separate Conductor
  package on in-session surfaces.)
- **Defensive parsing always:** every field we read may be absent, malformed, or buggy
  (e.g. epoch values leaking into `used_percentage`). Degrade gracefully, clamp to valid
  ranges, never crash the statusline.

If a task seems to require crossing one of these lines, stop and surface it — don't route around it.

## Execution process (for `/goal` and agents)

- **Validation gate:** Do not begin Phase 0 proper until Spike **S0** in `docs/VALIDATION.md`
  confirms the statusline payload actually carries `rate_limits` + `context_window` on a
  real account. If S0 fails, the plan changes — see the kill/pivot criteria there.
- **Pick the next task:** the lowest-numbered unchecked task in the current phase whose
  dependencies are met. Honor its AC literally — AC is the definition of done.
- **Check off** tasks in `docs/PLAN.md` (`[ ]` → `[x]`) as you complete them.
- **Test with each task.** Schema-validate tap output; unit-test defensive parsing against
  the fixture corpus (subscription / API-key / absent-field / epoch-leak).
- Keep the core open-source-clean: no secrets, no machine-specific paths in committed code,
  Apache-2.0 headers where appropriate.

## Stack

Single **zero-dependency** npm package (`tokenroom`): plain ESM under `bin/` + `src/`,
`node:test` suites, skill in `skill/`, JSON Schema in `schema/`. No build step — this is
deliberate (auditability + npx-ability); don't add dependencies without strong cause.
State lives at `~/.tokenroom/state.json` (atomic temp-file + rename writes only).

## Current status

**0.6.0 — renamed headroom → tokenroom (ADR-23), published to npm (`tokenroom`,
`latest`; 0.6.0-rc.1 claimed the name 2026-07-01).**
Phases 0–2 complete plus the post-0.3 field-driven layers. 83 tests green on node
18/20/22 CI. ARM (the autonomous headless resume executor) was REMOVED per ADR-22 — its
economics inverted when programmatic use moved to a separate metered pool; autonomous
continuation belongs to the separate Conductor package, while every awareness surface
(plan_resume, HUD countdown, readiness stamps) stays. Both load-bearing assumptions
validated on a live Max account; ADR-9 wording gate passed for the 0.3 wording AND the
batched post-0.3 round (ADR-19/20/22/23/24 items, 2026-07-02) —
`eval/v3-wording/results/`.

Shipped surface (all dogfooding live on the author's machine): tap → ResourceState +
velocity engine (learned tokens-per-%, exhaustion bands, idle suppression) · prompt
stamps + mid-turn band updates + cost receipts · compaction survival (fact snapshot +
transcript anchor + model-authored `checkpoint` + `handoff` continuity doc + verbatim
`pin_fact` pins + silent-trim detection) · reset scheduler (plan_resume + HUD countdown +
readiness stamps) · per-account isolation (ADR-21) + multi-account profiles, instant
switch detection, echo honesty, pair-aware descent, `tokenroom account/switch/run`
(ADR-24) · aggressive descent to a 1% floor (ADR-19) · multi-session burn disclosure
(ADR-20) · governor modes · opt-in compact guard + launch gate ·
work-intent + in-session auto-resume (ADR-25: `set_intent`/`tokenroom intent` focused runs
burn to the 1% floor, warn-and-arm launch gate, armed `plan_resume` queue tracking BOTH
windows, Stop-hook in-session continuation — never headless, holds the ADR-22 boundary) ·
`tokenroom watch/line/audit/doctor` · ADR log · eval report generator.

**Remaining, in order:** rotate the npm token (USER — the 0.6.0 release still rode the
old token) → launch announcement per `launch/` kit (publish ≠ promotion; needs explicit
user green light) → post-launch: T3.1 credit meter and T3.2 Codex adapter
(both data-gated), Pro only per `docs/PRO.md` gates (V1 demand kill-criteria — no
payments before two paying pilots). Follow-up from the 2026-07-02 eval: ADR-20's
"ease off" phrasing is not acted on by small models (B-1 Haiku miss) — candidate tighten.
**ADR-25 wording is NOT yet eval'd** (the focused-descent, warn-and-arm, and Stop-hook
continuation text) — it must run `/run-evals` in the next harden round and gates the next
release; the default (non-focused) path is byte-identical to shipped, already-eval'd text.
The build (2026-07-05) is code-complete + 96 tests green; not yet `tokenroom install`ed on
this machine, so the live hooks are still 0.6.0 until the user reinstalls.
