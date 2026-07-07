# Changelog

## Unreleased

### Changed
- **Quiet until it matters (ADR-26).** The routine per-turn quota stamp
  (`quota — 5h: X% left …`), the PostToolUse cost receipt, and the shared-session note are
  now **silent while the 5h window is healthy** and surface only when it is genuinely
  actionable — at/below the new `critical_pct` config (default **25**), or when the burn
  model projects running dry *before* the reset. Above threshold the model is no longer made
  "always conscious" of a budget that needs no attention, cutting per-turn/per-tool token
  waste. Non-budget output (wall clock, context, deferred work, pins, intent, checkpoints)
  and the one-shot disclosures (window reset, account switch, pre-switch echo) are unchanged;
  the PostToolUse band re-stamp keeps its governor gate (default `ondemand`'s first band = 25
  = the default `critical_pct`, so out-of-the-box behavior aligns). A bad `critical_pct`
  falls back to the default (defensive, never-throw). Local hook edit → live immediately;
  `npm publish` still needed to update other installs. Proven both directions in the field
  (silent at 65% left; surfaces at 15%). New `test/critical.test.mjs` (7 tests); full suite
  green (103 tests).

## 0.6.0 — 2026-07-02

The first stable release under the new name (0.6.0-rc.1 claimed `tokenroom` on npm
2026-07-01). Gated on — and released with — the **batched ADR-9 wording eval for every
post-0.3 wording item (ADR-19/20/22/23/24): PASSED**, all equipped assertions green on
the Sonnet tier with clean naive-harm baselines for the ADR-24 items
(`eval/v3-wording/results/2026-07-02-batched-post-0.3-wording.md`).

### Fixed (since 0.6.0-rc.1)
- **Account-switch banner no longer false-fires on a same-account window rollover**, and
  the pair advisor will never recommend switching to the profile you are already on
  (ADR-24 hardening).
- **Hooks never mislead:** every quota-consuming hook honors the per-account show-gate
  (ADR-21), and a malformed `resume.json` suppresses the readiness stamp instead of
  garbling it (ADR-5).
- Eval harness: `eval/v3-wording/` gained the seven batched post-0.3 scenarios
  (S-R/S-G/S-B/S-Q/S-W/S-E/S-K) + rubric.

### Added
- **Multi-account profiles + smart switch advice (ADR-24).** For users toggling two
  subscription accounts via `/login`:
  - **Instant switch detection** — the payload is ground truth: a statusline render whose
    account key differs from the session's mapping remaps in that same tap invocation
    (payload wins, always), logs an `account_switch` event, and the next stamp announces
    the switch once with the NEW account's numbers. Fixes the field capture 2026-07-01
    where a session stamped "0% left" for ~20 minutes after switching to an account at 98%.
  - **Echo honesty** — the tap tracks when window VALUES last moved
    (`values_changed_at`); a critical figure frozen >5 min while a sibling account has
    values-newer data is stamped as a possible pre-switch echo ("figures refresh on the
    next completed turn"), never asserted as fresh.
  - **Named profiles are identity** (ADR-21's phase keys give isolation, not identity):
    `tokenroom account label <name>` / `list` / `fold <key> <name>` /
    `config-dir <name> <path>`, stored in `~/.tokenroom/profiles.json`. Heuristic folding
    only ever HINTS (doctor + `account list`); zero profiles → behavior unchanged.
  - **Pair-aware descent** — low active window + a fresh other profile → stamps and
    mid-turn bands say "finish this unit at full speed, then switch (/login or
    `tokenroom switch`) for zero downtime; defer only if BOTH profiles are thin"; the 1%
    floor becomes land-and-switch. Healthy active → HUD-only terse `alt '<label>' ≈X%`.
  - **`tokenroom switch`** (profile decision table + recommended move) and
    **`tokenroom run [--profile X]`** (launch `claude` under the best/named profile's
    config dir via the official `CLAUDE_CONFIG_DIR` env var — launch-time selection only;
    auth files are never read or written, nothing is swapped mid-session).
  - New stamp/advice wording joins the batched ADR-9 eval before the npm release.

### Fixed
- **MCP tools no longer report whichever account rendered last (ADR-21 gap).** The server
  now resolves quota via the tap's session map: one recently-active account → that
  account's state; two or more active in the last 10 minutes → quota is withheld with an
  explicit `attribution: "ambiguous — quota withheld …"` on
  `resource_state`/`estimate_remaining`/`fit_check`/`plan_resume` instead of ever
  returning the wrong account's numbers.

### Changed
- **Renamed: headroom → tokenroom (ADR-23).** The practical owner of the name "headroom"
  is headroomlabs-ai/headroom (55k★, whose CLI binary is literally `headroom` — a direct
  bin conflict), with a commercial extraheadroom.com in the same niche; `tokenroom` was
  verified free on npm 2026-07-01. Everything user-visible renames with it: package
  `tokenroom`, bin `tokenroom`, state dir `~/.tokenroom` (installer COPIES `~/.headroom`
  across once, never moves/deletes it), env `TOKENROOM_DIR`/`TOKENROOM_DISABLE` (clean
  break), `[tokenroom]` stamp prefix (mechanical branding; ADR-9 eval batched to the
  harden round), MCP server `tokenroom`, skill `tokenroom`, repo
  `github.com/tyejcoleman/tokenroom`. Install now REPLACES any pre-rename headroom
  statusline/hooks/skill/MCP/CLAUDE.md-block artifacts in place — never duplicates them —
  and uninstall removes both namings; `doctor` hints while a stale `~/.headroom` remains.
  Historical records (past CHANGELOG entries, prior ADR bodies, eval results/fixtures)
  keep the old name.

### Removed
- **ARM mode (armed resume, the autonomous headless executor) — removed entirely
  (ADR-22, supersedes ADR-16).** `src/arm.mjs`, the launchd plist machinery, headless
  `claude -p` invocation, `headroom resume --arm`/`--disarm`, the `resume-run` entry
  point, the `auto_arm` config flag, and their tests are gone. The 2026-06-15 platform
  change moved programmatic use (`claude -p`, SDK) to a separate monthly API-priced
  credit pool, so an armed resume no longer salvages expiring subscription quota — it
  spends new metered credits. Autonomous continuation moves to the separate Conductor
  package on official in-session surfaces (Stop hook + scheduled wakeups + cron
  routines), carrying ADR-16's consent principle with it. The awareness half stays
  untouched: `plan_resume`, the resume-plan file, the HUD reset countdown /
  `✓ deferred work ready`, readiness stamps, and `headroom resume [--clear]`.

## 0.5.2 — 2026-06-22

### Added
- **5h exhaustion clause now states the runway in relative time.** The "when will constant
  work stop me" projection used to give only wall-clock times (`may run dry ~20:40–21:05`);
  it now appends `— ≈Xm of work left at this pace` (the conservative/earliest edge of the
  band, from now), so the answer reads instantly without mental math. Shows only when
  projected exhaustion lands before the window reset (i.e., when constant work would
  actually get cut off); silent when cruising. `src/hook.mjs`, locked by a new test.

### Changed
- **The 7-day window is now hidden from the LLM until <20% remains** (user directive). The
  prompt stamp used to disclose `7d: NN% left` every turn — and the "weekly pace is HOT"
  coaching even at 54% left — which read as noise and invited premature throttling on a
  budget that wasn't yet binding. `src/hook.mjs` now gates the entire weekly segment
  (figure *and* HOT/cruising coaching) behind `100 − seven_day.used_pct < 20`; above that
  the model is told nothing about the weekly window. The human-facing HUD/`watch`/`line`
  are unchanged. `skill/SKILL.md` "Weekly cruise control" now notes that the absence of a
  7d figure means "plenty left," not "unknown," so the model won't infer pressure from
  silence. New boundary test locks it (hidden at 54% even when HOT in state; shown at 19%).

### Fixed
- **Agent no longer stalls at the context ceiling waiting for the user to trigger
  compaction.** The skill and the mid-turn context nudges framed auto-compaction as
  something that "fires on its own" / "automatically" — which the model misread as
  *passive*: it would write its handoff, announce "I'm at the ceiling, so I'll let it
  compact," and then END ITS TURN, going idle. But auto-compaction fires only at the
  **start of the agent's next turn**, and only if it takes one — so ending the turn blocks
  compaction until the *user* manually sends a message (the inefficient ~9%-left hang the
  user reported). All three surfaces now state the mechanism literally: your next tool call
  IS the trigger; "let it auto-compact" means keep issuing tool calls, never "stop and
  wait"; announcing the stall while ending the turn is the bug, not the fix.
  - `skill/SKILL.md` "Near the context ceiling" — new mechanism paragraph ("read this
    twice") replacing the misleading "let auto-compaction fire on its own," plus a reworded
    point 3 (no more "it fires on its own once context is full enough").
  - `src/hook.mjs` SUPER-CLOSE nudge and the context-low band message — each now carries
    the "next turn is the trigger; ending your turn blocks compaction until the user nudges"
    correction. SUPER-CLOSE keeps its `SUPER CLOSE to auto-compaction` prefix (continuity
    test unchanged); 61/61 tests green.
- **Switching accounts (or running two accounts at once) no longer shows the wrong
  account's quota.** The statusline payload carries no account id, so concurrent Claude Code
  sessions logged into different accounts were all clobbering one global
  `~/.headroom/state.json` (last-writer-wins) — and the `[headroom]` stamp showed whichever
  account rendered last. Field capture 2026-06-25 caught two accounts flip-flopping the 7-day
  figure between 2% and 93% used on the same machine. Headroom now isolates every
  account-scoped store under `~/.headroom/accounts/<key>/` (state, burn history, calibration,
  flow, bands), keyed on the windows' reset phase (stable within an account, distinct between
  accounts). Each session reads only its OWN account's windows; multi-session disclosure
  ("N sessions sharing this quota" + combined burn) now counts same-account sessions only;
  and when ≥2 accounts are active but a session can't yet be attributed, quota is withheld
  rather than guessed. Single-account and api-key users are unaffected. New ADR-21 (amends
  ADR-7); unit + end-to-end isolation tests; 67/67 green. `src/util.mjs`, `src/state.mjs`,
  `src/flow.mjs`, `src/tap.mjs`, `src/hook.mjs`.

## 0.5.1 — 2026-06-20

### Fixed
- **Weekly "HOT pace" no longer false-fires right after the reset.** `enrichWeekly`
  flagged `hot` whenever the extrapolated pace exceeded 1.15× sustainable, even when only
  a sliver of the week had elapsed — so a short burst in the first hours (e.g. 4% used in
  ~4h) projected "you'll exhaust the week" with 96% left, which isn't actionable. HOT now
  additionally requires that a material share of the weekly budget is actually used
  (`seven_day.used_pct >= 15`, ≈ one day's sustainable allowance); below that the stamp
  shows the calm "cruising" form. Deliberately a usage floor (not an elapsed-time floor),
  so a genuine heavy early burn still surfaces.

## 0.5.0 — 2026-06-19

### Changed
- **Aggressive descent on the rate-limit window (ADR-19).** The agent now works at FULL
  SPEED until 5% remains (was: "descend, small atomic steps" from 10%), is told to be
  velocity-mindful but keeps working from 5% down to a **1% floor**, and only does
  finishing-moves at ≤1% (was: "start nothing new" at 5%). The 1–5% band keeps a stranding
  guard (prefer small divisible steps, checkpoint often, defer huge/indivisible new tasks),
  and the velocity-aware overrides still keep full speed when the window resets before it
  would exhaust. Adds a `1`-band to every governor profile so the floor message fires.

### Added
- **Multi-session burn awareness (ADR-20).** The stamp now discloses the **combined burn
  rate** across all sessions (≈tok/min) and how many are actively burning, and flags an
  **anomalous burner** — a session burning ≥3× the median of the others — naming whether
  it's *this* session (ease off) or another (the shared window can drop fast; re-check
  often). Flow samples are tagged by `session_id` to attribute per-session burn.

## 0.4.2 — 2026-06-18

### Changed
- **Two resources, two opposite postures — made unmistakable.** Context is a *burn-through*
  resource; quota (rate-limit) is a *wary, paced* one. The mid-turn "context getting low"
  nudge now leads with **"BURN IT, don't conserve it"** and states outright that low context
  is **never** a reason to slow, stop, hand back control, wrap up, or get cautious — the only
  thing it asks is that you keep the handoff current, then keep working at full speed until
  auto-compaction fires and refreshes you. It closes by contrasting the two budgets so the
  agent never applies quota-caution to context (or context-fearlessness to quota). The
  intelligent, reset-aware **quota** guidance (descend/defer unless the window resets before
  you'd run dry) is unchanged — that resource stays wary.
- **Default context nudge held to the core (~4% left).** `ctx_bands` default lowered from
  `[8, 4]` to `[4]`, so the handoff nudge fires once near the ceiling instead of at 8% —
  the agent uses nearly all its context before prepping a handoff. The token-floored
  "super close to auto-compaction" message remains the final safety net; `powersave` keeps
  its earlier 10% heads-up for thrift.

## 0.4.1 — 2026-06-18

### Changed
- **Power through to auto-compaction — stop getting "scared" near the context ceiling.**
  Field report: agents were stopping/handing back control as context filled, which prevents
  the very auto-compaction that would refresh them and continue the task. The skill now
  states it outright: stopping near the ceiling **strands the task**; keep producing work
  until Claude Code auto-compacts, then resume from the handoff. Removed "context at the
  compaction floor" from the legitimate stop-conditions list — **only quota (rate-limit)
  ever justifies stopping; context never does.**
- **Non-redundant handoff cadence (throughput).** The mid-turn ctx logic no longer nags for
  a handoff once one was saved recently (kills the redundant 6%→3% re-saving). Cadence is
  now: refresh at **task boundaries**, plus **one** velocity-timed "super close to
  auto-compaction" nudge (fires once, bypasses the throttle, suppressed if already saved).
  Updates surface "handoff already saved Nm ago" and a "≈N tool calls at this pace" estimate
  (from per-tool-call context growth) so the agent knows it's captured and how close it is.
- **Context handoff-nudge held later — utilize context to the core.** `ctx_bands` lowered so the
  "context getting low" nudge fires near the ceiling (~4–8% left) instead of at 25%/40%. The
  handoff is one cheap call that only needs to land before compaction, and the velocity-timed
  "super close" message remains the final safety net — so the agent uses nearly all its context
  before prepping a handoff, rather than slowing down early.

### Added
- **Current time + timezone awareness.** Every prompt stamp now leads with the user's local wall
  clock (e.g. `now Thu, Jun 18, 17:53 America/Los_Angeles`) so the agent can reason about
  time-of-day, scheduling, and deadlines. Labelled distinctly from quota to avoid the
  clock-time/budget conflation the stamp already guards against.
- **Reset-aware quota guidance.** Mid-task advice no longer says "descend / slow down" when the
  5h window will RESET before the velocity engine projects exhaustion (or a reset is ≤10 min
  away) — the real risk is running dry *before* the reset, not a low %. Deterministic from
  `resets_at` + `projected_exhaustion`; optimism requires a positive signal, so unknown burn
  stays cautious.

## 0.4.0 — 2026-06-17

### Added
- **Continuity handoff doc — the agent's living, canonical working-doc (T2.29, ADR-18).**
  A new `handoff` MCP tool (the fourth write surface) lets the agent maintain an *evolving
  markdown* document a fresh instance reads to resume fully: mission, current state,
  progress, exact next steps, key references, decisions + why, **the user's own
  directives/corrections**, system/process improvements discovered, and open questions.
  Stored at `~/.headroom/continuity/<session>.md`, latest-wins, capped per section, session-
  guarded, pruned after 7 days. Re-injected at SessionStart(source=compact) as a **pointer +
  digest** (ADR-11 style — the doc lives on disk, so point, don't dump). Richer and more
  durable than the terse `checkpoint`. `headroom handoff [--path]` prints the current doc.

### Changed
- **Skill: context-pressure is a *write-the-handoff* signal, not a stop sign.** Field report:
  agents were getting "tired"/cautious as compaction approached and slowing down or stopping.
  The "near the context ceiling" section is rewritten into a handoff ritual — keep a living
  handoff doc, refresh it when context runs low, then **keep working at full speed**; let the
  window burn to the floor because compaction is automatic and your doc + ground truth are
  re-injected right after it. The mid-turn ctx band update now says the same. (Wording
  eval-gated per ADR-9; validating in soak.)

## 0.3.3 — 2026-06-13

### Changed
- **Skill: "a clean boundary is a checkpoint, not a stop."** Agents were treating natural
  pause points (tests green, a commit landed) as stopping points even with healthy budget
  and work remaining. The skill now says to continue through, and to stop ONLY when:
  nothing valuable is left, a genuine blocker needs the user, or budget is truly dry
  (≲2%). The worth-it test brakes both ways — no premature stop, no runaway. Completes the
  anti-timidity / descent-profile arc. (Wording eval-gated per ADR-9; validating in soak.)

### Docs
- Product-boundary docs: the self-evolving harness is Keyoku's, not headroom's
  (`EVOLVING-HARNESS.md`); headroom is the awareness/sensor layer and friction feed. The
  `suggest` miner was prototyped and deferred (design kept in `SUGGEST.md`) — thinness
  applied to ourselves.

## 0.3.2 — 2026-06-12

### Added
- **Weekly cruise control:** the 7d window is paced, not just measured — pace ratio
  (used-fraction vs elapsed-fraction), sustainable %/day allowance, and projected weekly
  exhaustion, surfaced in stamps ("weekly pace is HOT… ≈5%/day sustains"), HUD
  (`week 26% left ⚠hot pace`), `fit_check` advice, and `burn.weekly` in the state schema.
  Agents throttle bulk work when hot and cruise the week to its reset without going dark.

## 0.3.1 — 2026-06-11

### Added
- **Descent profile:** work divisibility shrinks with quota — atomic steps in descent
  (5–10%), finishing moves on approach (2–5%), land at ≤2%; the opt-in launch gate now
  denies indivisible subagent/workflow launches in late descent (≤5%).
- **Concurrency disclosure:** stamps report "N sessions sharing this quota" with the
  correct mental model (account-level figures already include everyone's burn).
- **Reset-crossing detection:** dead-window data (any `resets_at` in the past) reports
  "window RESET — quota FRESH, disregard earlier figures" across stamp, mid-turn, HUD,
  and fit_check — never a stale "nearly dry".
- Release preflight (`scripts/release-preflight.mjs`) + fully agent-executable /release.

### Fixed
- Budget conflation (two wild sightings): stamps relabeled `quota —`/`context —` with
  the probe-validated "(quota resets do NOT restore context)" clause; low-context
  coaching now says checkpoint-then-KEEP-WORKING (compaction is automatic + survivable).
- Timidity: token-proportional advice (pausing at 15–30% with 100k+ tokens is named a
  failure mode); concurrency margin double-count corrected.
- Receipts: cross-window baselines rebaseline silently (no phantom "≈64%" bills).

### Changed
- README rewritten around the harness-awareness narrative + descent profile.

## 0.3.0 — 2026-06-10

### Added
- **Transcript anchor (T2.6, ADR-11):** the post-compaction injection now points at the
  full pre-compaction transcript JSONL plus a sidecar of deterministic verbatim extracts
  (every user message, recent failed tool calls) — search, don't reconstruct. `/compact
  <focus>` custom instructions are captured and echoed back after compaction.
- **Pins (T2.7, ADR-12):** `pin_fact` MCP tool and `headroom pin|pins|unpin` — facts
  re-injected word-for-word after every compaction until unpinned or expired (7d default).
- **Compact Instructions (T2.8):** the installer appends a marked, removable block to
  `~/.claude/CLAUDE.md` shaping what compaction preserves (exact paths, failing commands
  with error text, user wording verbatim, remaining-first budgets).
- **Compaction observability (T2.9):** PostCompact hook + `~/.headroom/events.jsonl`;
  silent context cliffs (microcompaction fires no hooks) are detected by the tap and
  disclosed once in the next stamp, with the transcript path as the recovery route.
- **Compact guard (T2.10, ADR-13, opt-in):** `compact_guard_min` blocks auto-compaction
  when the 5h reset is ≤N minutes away; never blocks manual `/compact`; fail-open.
- `docs/COMPACTION.md`: compaction research — algorithm layers, OSS survey, gap analysis.
- **Audit log (`headroom audit [--since N]`):** the awareness loop as a timeline — every
  stamp injected (or why skipped), band changes even when silent by design, every MCP
  consult with its verdict (fit_check/plan_resume/pin_fact), compaction lifecycle —
  closing with steering-signal counts. Shows what the agent was told and what it
  consulted; behavioral change measurement stays the eval's job.
- **Mid-turn re-stamps (T2.11, ADR-14):** PostToolUse hook injects a budget update when
  a window/context band worsens mid-turn (25/10/5% left), throttled to one per 2 minutes
  — long autonomous turns no longer burn blind.

- **Governor modes (T2.4):** `mode: performance | ondemand | powersave` in config —
  shifts band thresholds, receipt floors, and the re-stamp throttle (when headroom
  speaks, never what it says). Applies without restart.
- **Velocity engine (T2.1):** hooks sample exact token flow from the transcript usage
  records (incremental cursor, cheap); the tap cross-calibrates flow against %-steps to
  LEARN tokens-per-percent. Unlocks: `≈230k` tokens-left on the quota (HUD + stamp,
  always ≈), exhaustion as a confidence band (`⚠ empty ~00:40–01:30`) instead of a
  twitchy point, and idle suppression — no burn in 10 min clears the warning.
- **Cost receipts (T2.13):** a single tool call that visibly moves the budget gets a
  one-line receipt (`receipt: that Task cost ≈5% of the 5h window (+$3.30) — 55% left`)
  — per-action unit economics; floors (≥2 points or ≥$1) keep receipts rare.
- **Launch gate (T2.14, opt-in `launch_gate`):** PreToolUse denies expensive
  Task/Agent/Workflow launches when the window verdict is defer, with an actionable
  reason; cheap tools never gated; fail-open on any error.
- **Model-authored checkpoint (T2.12, ADR-15):** the `checkpoint` MCP tool — the agent
  saves its own survival note (task, state, decisions+why, ruled-out approaches, exact
  next steps, key values) when a ctx update warns the ceiling is near; re-injected after
  compaction AFTER the fact snapshot. Facts from hooks, judgment from models.
- **Armed resume (T2.15, ADR-16):** `headroom resume --arm` schedules the deferred plan
  at the reset via launchd + official `claude -p` headless mode — guard-railed
  (max-turns, pinned cwd, reviewable log), self-disarming after one run, `--disarm`
  anytime. `auto_arm` config flag = standing consent: every plan_resume self-schedules
  (truly autonomous defer→wake→resume loop). Headroom never arms without consent.

### Changed
- **HUD redesigned around "only what changes your next decision"** (field feedback):
  `5h 10% left ↻03:30` (explicit "left", ↻ for reset); healthy 7d window hidden (shown
  only under 30% left); context shows tokens (`ctx 580k`), the actionable unit; burn
  warning rephrased `⚠ empty by ~00:34` — a clock time that can no longer be misread as
  a duration; deferred-work segment compressed to `⏲ queued` → `✓ deferred work ready`
  (the duplicate reset clock is gone).
- HUD v3 (same session, second field pass): primary quota unlabeled (`58% left ↻03:30`
  — leading position + reset clock say what it is); weekly shown as `week N% left` only
  when binding; ctx shows both views `ctx 57% (570k)`; a WAITING deferred plan is hidden
  entirely (not actionable — `headroom resume` shows it), only `✓ deferred work ready`
  surfaces. Quota tokens-left deliberately absent: the payload has no token denominator
  — estimation lands with T2.1 burn priors rather than fake precision.

- `headroom audit` (awareness-loop timeline) and `headroom doctor` (install diagnosis,
  incl. flagging other hooks sharing events — errors aren't attributed per-hook).
- T2.5 reproducible eval report: `npm run eval` regenerates `eval/REPORT.md` and fails
  if any number's evidence file is missing.
- `docs/RESOURCE-STATE.md`: the provider-neutral adapter contract (T3.3).

### Notes
- ADR-9 eval gate for the new skill/stamp wording: **PASSED 2026-06-10**
  (`eval/v3-wording/results/`); confounds documented in the results.
- npm publish is deliberately held to land with the public launch.

## 0.2.0 — 2026-06-09

### Added
- **Compaction survival:** PreCompact hook snapshots ground truth (branch, uncommitted
  files, recent commits, budgets); SessionStart re-injects it after compaction, with
  wrong-session and staleness guards.
- **Reset scheduler:** `plan_resume` MCP tool records deferred work; HUD countdown
  (`⏲ resume 22:30` → `✓ deferred ready`); stamps and session starts flag readiness;
  `headroom resume [--clear]`.
- Stamp and `resource_state` disclose data age (`(5m old)` past 2 minutes, `age_seconds`).
- G2-sim continuity eval harness and published results (`eval/v2-continuity/`).

### Changed
- Installer registers all three hooks; uninstall generalized across every hook event.
- MCP server version read from package.json (single version source).

## 0.1.1 — 2026-06-09

### Fixed
- Burn-rate hallucination from poisoned/interleaved samples — estimator is now
  median-of-buckets over a ≥10-minute baseline (field-reported: "183.2%/h").
- Raw `%/h` removed from HUD/stamp; burn surfaces only as a pre-reset exhaustion warning.
- Multi-session correctness: stamps omit another session's context/cost; `$0.00` hidden.

## 0.1.0 — 2026-06-09

Initial release: statusline tap → ResourceState v0 (`~/.headroom/state.json`) + HUD;
UserPromptSubmit budget stamp; stdio MCP server (`resource_state`, `estimate_remaining`,
`fit_check`); headroom skill; idempotent installer/uninstaller; fixture-corpus defensive
parsing; zero dependencies.
