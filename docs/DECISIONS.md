# Decision log (ADRs)

Numbered, append-only. Each records a decision, its *why*, and what enforces it.
Agents and humans: **do not silently violate these** — if one blocks you, open an issue
or add a new ADR superseding it. The invariant gates (`scripts/check-invariants.mjs`)
cite these numbers in their failure messages.

## ADR-1 — Official surfaces only; never the network
Headroom reads statusline stdin JSON, hook payloads, and the user's own local files; it
writes only under `~/.headroom/` and the user's Claude Code settings (via the installer).
It NEVER: reuses subscription OAuth tokens outside official clients, calls undocumented
endpoints, spoofs harness identity, makes any network request, or burns interactive quota
headlessly. *Why:* the project's credibility — and its users' accounts — depend on it.
**Enforced by:** gates G3/G4; review.

## ADR-2 — Zero-dependency single package
Plain ESM, `node:` builtins only, no build step, one npm package (`headroom-harness`). *Why:*
a tool that wires into people's harness must be auditable in one sitting and npx-able;
supply-chain surface stays zero. The original TS/pnpm monorepo plan was deliberately
dropped (2026-06-09). **Enforced by:** gates G1/G2.

## ADR-3 — Remaining-first wording, everywhere
Stamps, HUD, tools always say what's LEFT ("58% left", "≈6k tokens"), never what's used.
*Why:* eval v0 caught a model reading "18% used" as 18% remaining; humans make the same
mistake. **Enforced by:** tests asserting stamp/HUD text; review.

## ADR-4 — Display only actionable signals
No raw burn rates or vanity metrics in human/model surfaces. Burn appears only as an
exhaustion warning when projected to hit BEFORE the reset; cost hidden when ~$0; data age
disclosed past 2 minutes, silence past 30. *Why:* field-tested 2026-06-09 — a technically
true "183%/h" (from a poisoned sample) destroyed trust instantly. **Enforced by:** tests.

## ADR-5 — Degrade, never crash; atomic writes
Statusline/hook entry points must always exit 0 and print something sensible; every
external field may be absent, malformed, or buggy (clamp 0–100, epoch-leak → null,
ms-timestamps tolerated); state writes are temp-file + rename. *Why:* a broken statusline
is worse than no statusline. **Enforced by:** gate G5, fixture-corpus tests.

## ADR-6 — MCP server: read-only plus exactly one write surface
The MCP server reads `state.json` and writes nothing — except `plan_resume`, which writes
the resume plan to `~/.headroom/resume.json`. Any new write surface needs its own ADR.
*Why:* a budget reporter that mutates state is a trust problem. **Enforced by:** review +
this log.

## ADR-7 — Account-scoped vs session-scoped data are different things
Rate-limit windows are true for every session OF THE SAME ACCOUNT; context and cost belong to
ONE session. `state.json` is last-writer-wins across concurrent sessions, so consumers must
check `session_id` before presenting session-scoped fields (the stamp omits foreign context).
*Why:* field bug 2026-06-09 — a fresh session's $0.00 displayed in another session.
**Enforced by:** tests. **Amended by ADR-21:** "account-level" only holds within one account;
when concurrent sessions span DIFFERENT accounts the windows are isolated per account, because
the payload carries no account id to disambiguate them.

## ADR-8 — Handoffs carry ground truth, not prose
Hooks have no model, so the PreCompact handoff records facts (branch, dirty files, recent
commits, budgets) rather than summaries, and SessionStart re-injects them verbatim with
wrong-session and staleness guards. `customInstructions` injection into the compactor is
NOT an official surface — dropped from the original plan. *Why:* facts survive; prose
written without a model is noise. **Enforced by:** tests; ADR-1.

## ADR-9 — Validate behavior before building machinery
Features that claim to change model behavior get an eval first (see `eval/`,
`docs/VALIDATION.md`). Eval prompts must not offer the desired behavior as a labeled slot
(demand characteristics), graders use artifacts over self-reports, and results are
published honestly — including weak ones (see the G2-sim writeup). *Why:* the v0→v1 eval
cycle caught timidity, stamp misreading, and overclaiming before they shipped.

## ADR-10 — package.json is the single version source
`src/mcp.mjs` reads its version from package.json at runtime; nothing else hardcodes it.
*Why:* the 0.1.1→0.2.0 bump required synchronized edits in two files; that class of bug
is eliminated structurally. **Enforced by:** code structure.

## ADR-11 — Transcript anchor: pointer, not payload
The PreCompact handoff records the transcript path and writes deterministic verbatim
extracts (every user message, recent failed tool calls) to a sidecar file
(`handoffs/<session>.extracts.json`); the post-compaction injection includes the *paths*,
never the contents. *Why:* compaction just freed the context — refilling it with bulk
history defeats the purpose, and the #1 field complaint about compaction is "the data is
still on disk but the model guesses instead of reading it". A pointer lets the model
fetch exactly what it needs. **Enforced by:** test asserting injected context contains
paths but not extract contents.

## ADR-12 — Pins are the MCP server's second write surface (amends ADR-6)
`pin_fact` (and `headroom pin`) writes `~/.headroom/pins.json`: facts re-injected
VERBATIM at SessionStart(source=compact). Constrained hard: text ≤500 chars, ≤50 pins,
default TTL 7 days, ≤20 re-injected. *Why:* paraphrase drift of user constraints is a
top compaction failure mode (2026 field survey), and only the model can identify which
sentences must not be reworded — that requires a tool, which requires a write. Pins are
not general memory; the caps enforce that. **Enforced by:** caps in `src/pins.mjs`, tests.

## ADR-13 — Compact guard is opt-in, auto-only, fail-open
Blocking compaction (official PreCompact capability since Claude Code v2.1.105) is OFF
by default. When enabled (`compact_guard_min` in `~/.headroom/config.json`) it blocks
only `trigger: "auto"` — never a user's manual `/compact` — and only when the 5h reset
is ≤N minutes away (a post-reset `/clear` beats compacting); any error in the guard path
falls through to allowing compaction. *Why:* a wrongly-blocked compaction can wedge a
full-context session; the guard must be impossible to blame for one. **Enforced by:**
tests covering all three guards (auto-only, near-reset-only, fail-open default-off).

## ADR-14 — Mid-turn awareness is push-on-worsening, throttled
Stamps fire only at UserPromptSubmit, so a long autonomous turn burns blind while
state.json stays fresh (field-observed 2026-06-10: 5h went 39%→13% across one turn and
the agent never re-saw a number). The PostToolUse hook re-stamps ONLY when a budget
crosses a WORSENING band (5h: 25/10/5% left; context: 25/10 points to ceiling;
exhaustion-before-reset flipping true), at most every 120s; first sight and improvements
are silent. *Why:* per-tool-call stamps would drown the context and train the model to
ignore them — band crossings are the only mid-turn news that changes decisions.
**Enforced by:** tests; new wording joins the ADR-9 eval queue before publish.

## ADR-16 — Armed resume: the user schedules the spend (amends the headless rule) — SUPERSEDED by ADR-22
The hard rule "never burn interactive subscription quota headlessly" exists to stop
TOOLS from spending quota the user didn't choose to spend. Armed resume does not cross
it — it inverts it: the USER schedules the spend, either per-plan (`headroom resume
--arm`, which prints exactly what command runs, when, and where the output goes) or via
the standing-consent config flag `auto_arm` (every plan_resume also arms). Constraints
that keep this honest: official `claude -p` headless mode only; guardrails embedded in
the armed command (`--max-turns`, constrained tools, pinned cwd); output to a reviewable
log; `--disarm` removes everything; the firing entry point self-disarms after one run;
headroom NEVER arms without one of the two consents. *Why:* deferred work that resumes
itself at the reset is the product's whole point — done with consent it's a feature,
done without it's malware. **Enforced by:** consent checks in code, dry-run output,
audit-log `armed`/`resume_run` events, this ADR. **Superseded by ADR-22 (2026-07-01):**
the execution half (the ARM executor) is removed; the consent principle carries over to
the Conductor package. The headless-rule amendment is withdrawn — the plain rule stands.

## ADR-15 — Facts from hooks, judgment from models (amends ADR-8)
ADR-8 holds: hooks have no model, so hook-captured handoffs carry only facts. The
`checkpoint` MCP tool (third write surface) adds the other half: the AGENT saves its own
survival note — task, state, decisions with why, ruled-out approaches, exact next steps,
key values — triggered by the ctx band-crossing mid-task update, re-injected at
SessionStart(source=compact) AFTER the fact snapshot (facts anchor, judgment annotates).
Caps (300-600 chars/field, 8 items/list, latest-wins, 6h staleness) keep it a
distillation, not a context dump. Known limitation: MCP calls carry no session id, so
the note is tagged with the latest tap session and the injection guard accepts a match
or an untagged note — exact for single-session use, documented race for concurrent
sessions. *Why:* native compaction summarizes generically at the last second; the agent
knows what THIS task needs, and "already ruled out" is the single most expensive thing
compaction loses. **Enforced by:** caps in `src/checkpoint.mjs`, lifecycle tests; new
wording joins the eval queue (ADR-9).

## ADR-17 — `suggest` is propose-only; evolution is versioned and reversible
The self-evolving harness (docs/EVOLVING-HARNESS.md) is built in exactly one safe
direction. `headroom suggest` and its synthesis step are **read-only**: they find and rank
friction and draft proposals, but never mutate the harness. Every proposal must cite the
events that motivated it (no vibes). Applying an evolution (v3+) is a separate, explicit,
versioned, one-command-reversible step under `~/.headroom/evolution/`, and any
behavior-changing evolution is eval-gated (ADR-9). Autonomy (auto-apply) is gated on a
proven auto-evaluation capability that does not yet exist; until then the system is
propose-only, forever if necessary. *Why:* a harness that silently rewrites itself is the
highest-risk pattern in the field (drift, injection-persistence, bloat); propose-only
captures the value with none of the danger. **Enforced by:** suggest does no writes;
this log; ADR-9 for adoption.

## ADR-18 — Continuity handoff doc: the model's living markdown working-doc (amends ADR-6, extends ADR-15)
ADR-15 added `checkpoint` for the model's TERSE last-second survival note. The continuity
handoff doc is its richer sibling: a model-authored, EVOLVING **markdown** working-document
— mission, current state, progress, exact next steps, key references, decisions + why, the
**user's own directives**, system/process improvements discovered, open questions — written
throughout a long-running task, not just at the ceiling. It is the **fourth MCP write
surface** (after plan_resume, pin_fact, checkpoint; ADR-6 enumerated the write surfaces and
is amended again here). Stored as markdown under `~/.headroom/continuity/<session>.md`
(+ `.meta.json` for the digest), session-scoped with the same tag-and-guard rule as
checkpoint (MCP carries no session id → tag with the latest tap session; injection guard
accepts a match or an untagged doc), capped per section, latest-wins, 24h staleness, pruned
after 7 days. Re-injected at SessionStart(source=compact) as a **pointer + digest**
(ADR-11: the doc lives on disk; compaction just freed the context, so point — don't dump).
*Why:* native compaction summarizes generically, and a terse checkpoint captures the resume
pointer but not the accumulated working knowledge (references, the user's exact directives,
improvements found) that lets a long-running process survive REPEATED auto-compactions at
full velocity. It reframes context-pressure from a stop-signal into a write-the-handoff
ritual — the field report that motivated it was an agent getting "tired"/cautious near
compaction instead of handing off and continuing. **Enforced by:** caps + session guards in
`src/continuity.mjs`, lifecycle tests; skill + ctx-band wording joins the eval queue (ADR-9).

## ADR-19 — Aggressive descent: full speed to 5%, mindful to a 1% floor
The 5h/7d rate-limit windows are spent down AGGRESSIVELY. The agent works at FULL SPEED
until 5% remains; from 5% down to a 1% floor it is told to be velocity-mindful (but keeps
working); at ≤1% it does finishing-moves only (commit in-flight work, checkpoint,
plan_resume, start nothing new). Quota left unspent before a reset is wasted, so the goal is
to use the window right down to the floor — never to stop early "to be safe". The 1–5% band
keeps ONE guard so aggression doesn't cause loss: prefer small divisible steps, checkpoint
often, and defer a genuinely huge/indivisible new task (plan_resume). The velocity-aware
optimism overrides still win — if the window resets before the burn would exhaust it, stay
full speed even under 5%. *Why:* the prior ladder cautioned at 10% and stopped new work at
5%, leaving usable capacity unspent every reset; the field directive was to burn to the
floor while keeping a stranding guard for indivisible work. **Enforced by:** the advice
ladder in `src/hook.mjs`, a `1`-band in every `modeProfile` (`src/util.mjs`) so the floor
message fires, the launch gate's ≤5% indivisible-launch block, and the descent-ladder test
in `test/compaction2.test.mjs`; stamp wording joins the eval queue (ADR-9).

## ADR-20 — Multi-session disclosure: combined burn rate + anomalous-burner flag
The 5h/7d windows are ACCOUNT-level, so concurrent sessions share them. Beyond the existing
"N sessions sharing" count, the stamp now discloses the COMBINED burn rate (the flow log
already aggregates every session's transcript, so `out_per_min` over it IS the combined
rate) and flags an ANOMALOUS burner — a session burning ≥3× the median of the others, above
a floor — naming whether it's THIS session (ease off) or another (the shared window can drop
fast; re-check often). To attribute per-session, flow samples are tagged with their
`session_id` at sample time (the only new data; pre-tag samples fold into "unknown" and
degrade gracefully). *Why:* on shared-quota nights a single runaway session can drain the
window for everyone; the agent should see the combined velocity and know if it — or a
sibling — is the one burning hot. Stays within official extension points (transcript
`usage` + hook stdin); no per-session identity beyond the harness's own session id. **Enforced
by:** `sessionFlowStats` in `src/flow.mjs`, the disclosure line in `src/hook.mjs`, and the
anomaly test in `test/flow.test.mjs`; wording joins the eval queue (ADR-9).

## ADR-21 — Per-account isolation of all account-scoped state (amends ADR-7)
The statusline payload carries NO account identifier (only `session_id`, `workspace` dirs,
`rate_limits`, `context_window`, `cost`). ADR-7 assumed the rate-limit windows are
account-level and "safe to show anywhere" — but that breaks when concurrent sessions are
logged into DIFFERENT accounts: they all write one global `~/.headroom/state.json`
(last-writer-wins), so the agent-facing stamp shows whichever account rendered the statusline
last. Field evidence 2026-06-25 (live `--capture`): two accounts writing the same `state.json`,
the 7d figure flip-flopping 2%↔93% between renders — a session on the 98%-weekly-left account
was being told it had 7% left.

Fix: every account-SCOPED store gets its own subtree `~/.headroom/accounts/<key>/` —
`state.json`, `history.jsonl`, `calib.json`, `flow.jsonl`, `flow-cursors.json`, `bands.json`.
The account key is derived from the windows' reset PHASE (`resets_at mod window_length`),
which is invariant across resets within an account but differs between accounts. The tap
(which sees `rate_limits`) routes all reads/writes to `accountDir(key)`, records a
`session_id → key` map in `sessions.json`, and mirrors the latest account's `state.json` to
the top-level path as a POINTER for the human CLIs (`watch`/`line`/`doctor`/`mcp`) that have
no session context. Hooks never receive `rate_limits`, so they resolve their account via
`quotaScope(session_id)`: the mapped account, or — to avoid regressing single-account users —
the sole account when only one exists, or the legacy global layout when none exist. Only when
≥2 accounts exist AND the session is unmapped is quota WITHHELD (we can't attribute it; showing
the wrong account is the bug). Multi-session disclosure (ADR-20) now reads per-account
bands/flow, so "N sessions sharing this quota" and the combined-burn figure count SAME-account
sessions only — a sibling on another account no longer inflates them.

Key stability assumes a roughly fixed reset cadence (the same assumption ADR-7's reset
handling already makes). If the phase ever drifts, the worst case is a same account splitting
into a new bucket (history/calib rebuild in ~10 min) — never cross-account contamination, the
only failure mode that matters. api-key users (no windows → null key) keep the legacy global
layout unchanged. *Why:* a resource-awareness tool that reports another account's quota is
worse than silent. **Enforced by:** `accountKey`/`accountDir`/`recordSessionAccount`/
`accountForSession`/`quotaScope`/`gcAccounts` in `src/util.mjs`; per-account `dir` routing in
`src/state.mjs`, `src/flow.mjs`, `src/tap.mjs`, `src/hook.mjs`; unit + end-to-end isolation
tests in `test/state.test.mjs` and `test/cli.test.mjs`. Stays within official extension points
(statusline stdin only); introduces no new identity source. Stamp WORDING is unchanged (the
quota line text is identical; isolation only changes WHICH account's numbers fill it, and
withholding is an omission per "never inject a lie") — so ADR-9's eval gate is not triggered.

## ADR-22 — ARM mode removed (supersedes ADR-16)
The autonomous headless resume executor — `src/arm.mjs`, the launchd plist machinery,
headless `claude -p` invocation, `headroom resume --arm/--disarm`, `resume-run`, and the
`auto_arm` standing-consent flag — is removed entirely. Three reasons, in order:
(a) The 2026-06-15 platform change split programmatic use (`claude -p`, the Agent SDK)
into a separate monthly API-priced credit pool, distinct from the interactive
subscription windows. ARM's entire economic premise was "use quota that would otherwise
expire at the reset"; a headless run no longer draws from that expiring pool, so an armed
resume now spends NEW metered money instead of salvaging sunk quota. The feature's why is
gone. (b) Autonomous continuation moves to a separate **Conductor** package built on
official in-session surfaces — Stop-hook continuation, scheduled wakeups past resets, and
official cron routines — where the work runs inside the interactive session whose quota
it was deferred from. (c) ADR-16 is superseded for execution, but its consent principle
(the USER schedules/authorizes autonomous spend; the tool never arms itself; transparent,
guard-railed, disarmable) carries over to Conductor as a design requirement. The
awareness half of deferral is untouched and stays: `plan_resume` (the MCP write surface,
ADR-6), `resume.json`, the HUD reset countdown / `✓ deferred work ready`, the
"deferred work is now ready" stamps, and `headroom resume [--clear]`. The headless-rule
amendment ADR-16 made to CLAUDE.md is withdrawn: the plain rule "never burn interactive
subscription quota headlessly" stands without a carve-out. Note: the small subtractive
wording edits this removal forced in `skill/SKILL.md` (dropping the "armed resume
continues after the reset" clause) have NOT yet re-run the ADR-9 wording eval — that pass
is deferred to the harden round of the current build. *(Ran 2026-07-02 in the batched
round, S-Q: PASSED — no cell claimed deferred work would run itself;
`eval/v3-wording/results/2026-07-02-batched-post-0.3-wording.md`.)* *Why:* a scheduler whose economics
inverted from "salvage expiring capacity" to "spend new metered credits unattended" is
the exact pattern this project exists to refuse. **Enforced by:** the code no longer
exists; grep gate in the removal commit; this ADR.

## ADR-23 — Rename: headroom → tokenroom
The package, bin, state dir, env vars, stamp prefix, MCP server, skill, and repo are
renamed **tokenroom** (package `tokenroom`, bin `tokenroom`, `~/.tokenroom`,
`TOKENROOM_DIR`/`TOKENROOM_DISABLE`, `[tokenroom]` stamps,
`github.com/tyejcoleman/tokenroom`). *Why:* the name "headroom" is owned in practice by
headroomlabs-ai/headroom (55k★ — and its CLI binary is literally `headroom`, a direct bin
conflict on any machine with both installed), plus a commercial extraheadroom.com operates
in the same niche; `tokenroom` was verified free on npm 2026-07-01. Semantics of the
rename: (a) **state migrates by COPY, never move** — on install, if `~/.tokenroom` does
not exist and `~/.headroom` does, the installer copies it recursively (skipping in-flight
`*.tmp` atomic-write files); the old dir is left in place because other live sessions'
hooks keep writing it until their next event picks up the rewritten settings, and `doctor`
hints while the stale dir remains. (b) **Install replaces, never duplicates, pre-rename
artifacts** — old `headroom.mjs` statusline/hook commands, the `headroom` MCP
registration, `~/.claude/skills/headroom`, and the installer-managed CLAUDE.md block are
detected and replaced in place (nothing outside the managed block is touched); uninstall
removes both old- and new-named artifacts symmetrically. (c) The `[headroom]` →
`[tokenroom]` stamp-prefix change is mechanical branding, not a wording change — the
ADR-9 eval for it is batched with the other pending wording items into the current
build's harden round. *(Ran 2026-07-02, S-R: PASSED — prefix A/B behaviorally
indistinguishable; `eval/v3-wording/results/2026-07-02-batched-post-0.3-wording.md`.)* (d) Append-only history keeps the old name: past CHANGELOG entries,
prior ADR bodies (including still-standing ones — read their `headroom`/`~/.headroom`
references under this rename), and eval fixtures/results are unmodified; the `eval/`
simulation rig keeps its on-disk `headroom` fixture naming for reproducibility.
**Enforced by:** `migrateStateDir` + old-artifact replacement in `src/install.mjs`, the
stale-dir hint in `src/doctor.mjs`, replace-not-duplicate and migration tests in
`test/cli.test.mjs`, and the rename-commit grep gate (`grep -rni headroom src bin test
schema` → only justified survivors, all referring to pre-rename artifacts).

## ADR-24 — Multi-account profiles: labels are identity, the payload wins, descent is pair-aware (amends ADR-21, ADR-19)
ADR-21's phase-derived account keys give ISOLATION but not stable IDENTITY: an idle
account starts its next 5h window at a new phase, so one physical account spreads across
several key buckets (field 2026-07-01: 2 real accounts → 4+ buckets). And a `/login`
switch mid-session left the stamp quoting the OLD account for ~20 minutes (field capture
2026-07-01 21:10–21:30: "0% left" asserted as fresh while the switched-to account sat at
98%). Five decisions, one boundary:

(a) **Payload wins, instantly.** The statusline payload is ground truth for which account
a session is on NOW. A render whose computed key differs from `sessions.json`'s mapping
remaps in that same tap invocation, appends an `account_switch` event, and the next
prompt stamp discloses the switch ONCE with the new account's numbers.
(b) **Echo honesty.** After `/login` the payload keeps echoing `rate_limits` cached from
the old account's last completed turn, and every re-render re-stamps the echo as 0m-fresh
— the tap now records `values_changed_at` (when the window VALUES last moved), and a
critical (<15% left) figure frozen >5 min while a sibling account holds values-newer data
is disclosed as a possible pre-switch echo instead of being asserted as fresh ("never
inject a lie", ADR-5 spirit).
(c) **Named profiles are the identity layer** (`~/.tokenroom/profiles.json`: label →
{keys[], config_dir?, last_seen, last_windows_snapshot}); `tokenroom account
label/list/fold/config-dir`. Heuristic folding only ASSISTS — a new unlabeled bucket
appearing right after a labeled profile's window expired, with no other profile active,
yields a fold HINT in doctor/`account list`; tokenroom never auto-merges buckets. Zero
profiles → every surface behaves exactly as pre-ADR-24.
(d) **Pair-aware descent.** With a second fresh-enough profile known (snapshot age <6h —
beyond a reset clock the data is history; age always disclosed), ADR-19's descent applies
to the PAIR: active low (<15%) + other healthy (≥40% or a passed reset) → "finish this
unit at full speed, then switch (/login or `tokenroom switch`) for zero downtime; defer
only if BOTH profiles are thin" — the 1% floor becomes land-and-switch instead of
plan_resume. Both thin → today's defer wording stands unchanged. Healthy active → at most
a terse `alt '<label>' ≈X%` in the human HUD, NOTHING in the model stamp (the same noise
discipline as the 7d <20% gate). The advisor tells the human/agent; the HUMAN switches.
(e) **Compliance boundary — awareness + advice + launch-time selection only.** `tokenroom
run [--profile X]` / `tokenroom switch` launch or recommend an interactive `claude` under
a per-profile config dir via the official `CLAUDE_CONFIG_DIR` env var, chosen when the
USER starts a session. Hard NO, unchanged from ADR-1: no reading/writing auth or
credential files, no mid-session account hot-swap, no rotation daemon to defeat rate
limits — the session's sign-in is bound at start and stays untouched.

*Why:* a resource-awareness tool on a two-account machine must (1) never report the
account you just left, and (2) stop an agent from throttling/deferring when a fresh
window is one `/login` away — unspent-and-switchable quota is the same waste ADR-19
exists to prevent. **Enforced by:** switch detection + `values_changed_at` in
`src/tap.mjs`; profiles/advisor/echo logic in `src/accounts.mjs`; the pair-aware ladder
in `src/hook.mjs`; the field-capture fixture suite in `test/accounts.test.mjs`; MCP
ambiguity withholding in `src/mcp.mjs` + `test/mcp.test.mjs`. NOTE: the new stamp/advice
WORDING (switch banner, echo honesty, pair advice) has not yet run the ADR-9 wording
eval — it is batched with the other pending items into the harden round and gates the
npm release. *(Ran 2026-07-02, S-W/S-E/S-K: PASSED on both tiers with clean naive-harm
baselines; `eval/v3-wording/results/2026-07-02-batched-post-0.3-wording.md`.)*

## ADR-25 — Work-intent + in-session auto-resume (amends ADR-6/ADR-19, extends ADR-22)
Field complaint (2026-07-05): on long autonomous runs tokenroom "keeps stopping" — it
throttles at 5% and defers, and after a reset nothing brings the work back, so a human
must restart every window. The cause is structural: descent is a pure function of the 5h
`%`-left with NO way for the agent to say "this is a long convergence run — burn to the
floor," and `plan_resume` was passive (a one-line summary + a readiness flag; nothing
continues the work). Three coupled decisions fix it, behind ONE opt-in signal:

(a) **Work-intent is the FIFTH MCP write surface** (amends ADR-6, which enumerated four:
plan_resume, pin_fact, checkpoint, handoff/continuity). `set_intent` (and `tokenroom
intent`) writes `~/.tokenroom/intent.json`: `kind` ∈ {convergence, long_running,
priority} = a FOCUSED run, or `default` = normal. It carries an optional task `queue` and
is session-tagged with the same MCP-has-no-session-id caveat and match-or-untagged guard
as checkpoint (ADR-15); 12h TTL measured from the run's start; latest-wins. Absent /
expired / foreign-session → null → every surface behaves exactly as before, so the
default-path eval results still hold.

(b) **A focused intent flips descent** (amends ADR-19). ADR-19's ladder is unchanged for
one-off work: full speed to 5%, mindful 1–5%, finishing-moves ≤1%. Inside a focused run
the 1–5% band stops saying "prefer small steps / defer a huge new task" and instead says
"keep FULL SPEED to the 1% floor, do not defer here" — the agent burns the window down
because it declared the run worth it. The stranding guard doesn't vanish, it moves to the
floor: at ≤1% the message becomes "arm in-session resume" (below). The launch gate also
activates under a focused intent even when `launch_gate` config is off, and WARN-AND-ARMS:
it records an armed resume plan for the deferred launch (never clobbering a plan the agent
already wrote) and injects a resource-aware heads-up, but it does NOT stop the agent —
field directive 2026-07-05, "warn during a declared run, never make Claude stop; keep going
but be resource-aware." Only the explicit `launch_gate` opt-in hard-denies. That is the "if
I start something big, warn me and set up the resume — but don't stop me" behavior. This is NEW agent-facing WORDING → it joins the ADR-9 eval
queue and gates the release; the default (non-focused) wording is byte-identical to the
shipped, already-eval'd text, so only the focused branch is under test.

(c) **Armed resume continues IN-SESSION** — this is where ADR-22 draws its line, so read
it carefully. ADR-22 removed the HEADLESS executor (`claude -p`) because a headless run no
longer draws from the expiring interactive pool, so it spent NEW metered money unattended
— "a scheduler whose economics inverted." It explicitly reassigned autonomous continuation
to "official IN-SESSION surfaces — Stop-hook continuation, scheduled wakeups past resets."
This ADR builds exactly that, and ONLY that. `plan_resume` gains a `queue`, a `blocked_on`
∈ {five_hour, seven_day} (so weekly-blocked work becomes ready at the 7d reset, not the 5h
one — the user asked for both windows), and an `armed` flag. A new **Stop hook**
(`hookStop`) is the enforcer: when a focused run has an armed plan AND the blocked window
has actually reset, the agent yielding control is blocked and the next queued task is
re-injected, so THE SAME interactive session continues — the quota it spends is the
interactive quota the work was deferred from, never a new metered headless pool. It is
strictly opt-in and fail-open: no focused intent / not armed / not yet ready / already
re-fired this turn (`stop_hook_active`) / this session's window still shows dry → allow the
stop, always. It is the only hook that can PREVENT a stop, so every uncertainty allows, and
the exit is explicit (`tokenroom resume --clear`). The multi-hour idle gap (sleep until the
reset, then wake) is bridged by the harness's own in-session `ScheduleWakeup`, which the
agent invokes at the floor — tokenroom arms and enforces continuation; it does not itself
schedule the OS-level wake, and it still writes NOTHING headless. ADR-16's withdrawn
headless-rule amendment stays withdrawn; the plain rule "never burn interactive
subscription quota headlessly" is untouched because nothing here runs headless.

*Why:* unspent-then-unresumed quota on a long build is the same waste ADR-19 exists to
prevent, one level up — the window resets and the work just sits there. Making the agent
declare intent keeps the aggression OPT-IN (a one-off task is never surprised into burning
to 1% or into a session that won't stop), and confining continuation to the Stop hook keeps
it inside ADR-22's in-session boundary. **Enforced by:** `src/intent.mjs`
(set/active/isFocused/clear + queue caps); `armed`/`queue`/`blocked_on`/`resumeReady` +
weekly-safe expiry in `src/resume.mjs`; the focused descent branch, warn-and-arm launch
gate, and `hookStop` in `src/hook.mjs`; the `set_intent` tool + `plan_resume` schema in
`src/mcp.mjs`; Stop-hook registration in `src/install.mjs`; the unit + hook-integration
matrix in `test/intent.test.mjs` (13 tests). The focused-branch WORDING is NOT yet
ADR-9-eval'd — it batches into the harden round with the other pending items and gates the
next npm release.

## ADR-26 — Quiet until it matters: the routine quota stamp is silent above `critical_pct` (amends ADR-19/T2.13)

The recurring budget surfacing — the every-turn UserPromptSubmit quota stamp
(`quota — 5h: X% left …`), the PostToolUse cost receipt (`receipt: that Bash cost ≈… — Y%
left`), and the shared-session note — fired on essentially every turn/tool regardless of
level. That made the model *always conscious* of a budget that, while healthy, needs no
attention: attention it doesn't need is context it shouldn't be paying for. **Decision:** a
new `critical_pct` config (default **25**) gates the routine quota lines. When the 5h window
is **above** `critical_pct` the model gets **NOTHING** for them (silent); **at/below** it —
or whenever the burn model deterministically projects running dry **before the reset** (the
genuinely-actionable case, preserved above threshold) — they surface and escalate exactly as
before via the existing descent ladder (ADR-19). This mirrors the weekly window's own
`<20%`-left gate (already shipped): a healthy window is noise that invites premature
throttling, so we don't even tell the model.

Scope is deliberately narrow — *only* the routine `% left` noise is suppressed. Untouched:
the wall clock, the context line (a different resource, deliberately burn-through), deferred-
work readiness, the microcompaction drop note, pinned facts / checkpoints / session intent,
and the rare one-shot disclosures (window-reset "fresh", account-switch banner, pre-switch
echo). The PostToolUse **band** re-stamp keeps its governor gate (`fh_bands`): the default
`ondemand` profile's first band is 25 — equal to the default `critical_pct` — so out of the
box they align, and a power user who opts into `powersave` still gets its early bands. A bad
`critical_pct` (non-number, NaN, out of 0–100) falls back to 25 (defensive, never-throw).

*Why a threshold and not a mode:* modes shift *when* tokenroom speaks about a worsening
crossing; `critical_pct` answers the prior question "is this budget worth the model's
attention *at all* right now?" — and for a healthy window the answer is no. **Enforced by:**
`critical_pct` default + sanitization in `readConfig` (`src/util.mjs`); the `quotaActionable`
gate on the normal quota line, pair advice, and shared-session note in `hookUserPromptSubmit`
and on the receipt in `hookPostToolUse` (`src/hook.mjs`); the above/below/override/defensive
matrix in `test/critical.test.mjs` (7 tests). WORDING is unchanged from the ADR-9-eval'd
lines — this ADR only changes *whether* they fire, not what they say.

## ADR-27 — Weekly-warning control: `weekly_warning` on/off/auto, opt-in loop-aware suppression (amends ADR-6)

The weekly (7d) line — `7d: X% left — weekly pace is HOT …`, already gated to <20%-left by
the 2026-06-22 user directive (untouched by this ADR) — had no way to turn off. A user
running an autonomous belay loop wants it silenced automatically while the loop is driving
(the loop is already pacing itself); everyone else wants it on, as today. **Decision:** a new
`weekly_warning` config (`'on'` default | `'off'` | `'auto'`) gates *only* this line, entirely
independent of `critical_pct` (ADR-26), which gates the separate 5h line. `'on'` is a no-op —
byte-identical to pre-ADR-27 output, including that the loop-probe below is never even called
(short-circuited), so there is zero behavior or I/O change for the default/unconfigured case.
`'off'` always suppresses the weekly line. `'auto'` (opt-in) additionally suppresses it exactly
while a belay loop is armed-and-not-paused for *this* session — otherwise it behaves like
`'on'`. A bad/missing value (wrong type, typo, out of the three modes) falls back to `'on'`,
the same "the safer default is to warn" defensive posture as `critical_pct` (ADR-5/26).

**Loop detection** (`src/looprobe.mjs`, new file) reads `~/.belay/loops.json` — read-only,
zero import of belay's package or code, mirroring belay's own `BELAY_DIR`-env-override /
`~/.belay`-fallback dir resolution. It returns true only for an entry whose `session_id`
matches the current session (from the hook stdin's `session_id`, falling back to
`$CLAUDE_CODE_SESSION_ID`) with `armed` truthy and `paused` falsy. Absent belay, a missing or
corrupt `loops.json`, or any unexpected shape (array where an object is expected, a string
entry, etc.) all resolve to `false` — never throws, never blocks the hook (ADR-5 discipline);
`'auto'` then behaves exactly like `'on'`. Global-scope loop entries (`session_id: null`) never
match a real session id, so they cannot accidentally suppress an unrelated session's warning.

**New write surface** (amends ADR-6, which is otherwise stale — several write surfaces already
exist by ADR-25/T2.x; this entry is the record for *this* one): the `tokenroom_weekly_warning`
MCP tool (`{ mode: 'on'|'off'|'auto' }`) persists to `~/.tokenroom/config.json` via a new
`writeConfig()` helper in `src/util.mjs` that merges the patch onto whatever is already on
disk (not the in-memory defaults), so unrelated hand-edited keys are never clobbered. It
returns the resolved mode plus a one-line human summary. **Caveat:** hook behavior (the
gate above) is live immediately — `settings.json` hooks spawn a fresh `bin/tokenroom.mjs`
process per event, so an edited config or a changed belay loop state takes effect on the very
next hook call. The MCP *tool*, by contrast, runs inside a long-lived MCP server process
already loaded into the current Claude Code session; a NEWLY ADDED tool is not callable until
that server connection is refreshed — run `/mcp reload` (or start a fresh session) before
invoking `tokenroom_weekly_warning` for the first time after upgrading.

*Why opt-in, not automatic:* the user was explicit — "usually it should be ON" — so any
loop-awareness must be something the user turns on (`auto`), never a silent default behavior
change; `'on'` stays the shipped default and is provably byte-identical to today's output.
**Enforced by:** `weekly_warning` default + sanitization in `readConfig`, `writeConfig` in
`src/util.mjs`; the `weeklySuppressed` gate in `hookUserPromptSubmit` (`src/hook.mjs`);
`loopActiveForSession`/`resolveSessionId`/`belayDir` in `src/looprobe.mjs`; the
`tokenroom_weekly_warning` tool + dispatch in `src/mcp.mjs`; `test/looprobe.test.mjs` (13
tests: armed/paused/session-mismatch/global-scope/missing-belay/corrupt-JSON/malformed-shape
matrix) and `test/weekly-warning.test.mjs` (12 tests: default/sanitize/on-byte-identical/
off/auto×{active,none,paused,other-session,garbled,absent}/5h-line-untouched/MCP round-trip).

## ADR-28 — Continuity docs are keyed by (session, project), not session alone (amends ADR-18)

**Bug (observed live):** a Claude Code session working in project *openkakushin*
(`session_id` `1fdf3400-…`) had its SessionStart(compact) `additionalContext` injected with a
*different project's* handoff doc — a Nomos-project doc (mission "Build Nomos…") — and
openkakushin's own doc appeared to have been overwritten. State from one project leaked into
an unrelated one.

**Root cause:** `~/.tokenroom` is a *single global directory* shared by every project on the
machine, and the continuity doc scheme (`src/continuity.mjs`) keyed docs by session id
*alone* — `continuity/<session>.md` — with no project dimension anywhere. Worse, the `handoff`
MCP tool carries no session id from the caller (documented in the file header), so
`saveContinuity` tags the doc with whatever `readState().session_id` happens to be — the most
recently *tapped* session, which can be null (fresh account, no tap yet) or, on a machine
running several concurrent Claude Code sessions across different projects, simply the wrong
one. An untagged write (`session_id: null`) fell through to the single shared bucket
`continuity/session.{md,meta.json}` — the SAME file for every project on the box. Two
compounding effects followed: (1) **latest-wins overwrite** — a `handoff` call from ANY
project with an unresolved session id clobbered that one global file, explaining "my own
handoff appears to have been overwritten"; (2) **blind fallback on read** — `takeContinuity`'s
guard, `if (meta.session_id && session_id && meta.session_id !== session_id) continue`, is a
no-op whenever *either* side is null, so an untagged doc (from any project) satisfied *any*
session's lookup, explaining "a Nomos doc reached an openkakushin session." Project was never
part of the key or the match — session-id ambiguity alone was enough to cross projects.

**Fix:** every continuity doc is now keyed by the composite **(session, project)**, where
`project` = the writer's cwd's git repo root (`git -C <cwd> rev-parse --show-toplevel`),
falling back to the raw cwd for non-git directories, and to "no project" (pre-ADR-28 bare
key) only when cwd itself is unresolvable — never-throw throughout (`projectFor`/
`projectKeyFor` in `src/continuity.mjs`). `saveContinuity` writes to
`continuity/<session-or-'session'>__<project-fingerprint>.{md,meta.json}` and stamps the
resolved `project` into the meta sidecar. `takeContinuity(session_id, cwd)` builds its lookup
candidates **only from its own resolved project**: `(session, project)` exact match, then
`(untagged-session, SAME project)`, then — solely when *this* call itself has no project to
scope by — the pre-ADR-28 bare `<session>` / bare `session` keys, for backward compatibility
with docs written before this fix. Because every project-scoped candidate is built from the
reading call's *own* `cwd`, there is no code path left that can construct a candidate
belonging to a *different* project — the blind "any untagged doc matches" fallback that
caused the collision is only reachable when neither side of the exchange resolves a project
at all, which real hook/MCP traffic never hits (both `PreCompact`/`SessionStart` hook stdin
and the MCP `handoff` tool's `cwd: process.cwd()` always supply one). `hookSessionStart` and
the `savedRecently` check in `hookPostToolUse` now pass the hook payload's `cwd` through
(`src/hook.mjs`). The interactive `tokenroom handoff` CLI (`latestContinuity`, `bin/
tokenroom.mjs`) got the same treatment for consistency: it now prefers docs tagged to the
CLI's own project, falling back to the global most-recent only when nothing here matches —
byte-identical to pre-ADR-28 behavior when called with no cwd.

**Additive/backward-compatible, never-throw:** a doc written under project A is structurally
unreachable from a session whose cwd is project B (proven by construction, not just by
matching logic); same-project resume — same or different session id — is unchanged; a legacy
pre-ADR-28 doc (no `project` field, bare filename) still resolves for its own tagged session
id and is never cross-served to a different one; a missing doc is a clean no-op, exactly as
before. **Enforced by:** `projectFor`/`projectKeyFor`/`compositeKey` and the rewritten
`saveContinuity`/`takeContinuity`/`latestContinuity` in `src/continuity.mjs`; the `cwd`
threading in `src/hook.mjs` (`hookSessionStart`, `hookPostToolUse`) and `bin/tokenroom.mjs`;
3 new tests in `test/continuity.test.mjs` covering cross-project isolation (symmetric, both
directions), exact-match + legacy-doc resolution, and the missing-doc no-op — full suite
(131 tests) green.

## ADR-29 — Burn-efficiency signal + facilitator-cost hand-off nudge (Tye's token-efficiency priority)

tokenroom's existing budget lines are all *quota*-oriented (%-of-cap, "X% left"). Tye cares
more about burning tokens *efficiently* than about the weekly cap — and named the single
biggest waste in a long autonomous run: a driver/orchestrator ("facilitator") session's
context grows every turn, and because the **entire context is resent on every turn**, the
marginal cost of the *next* turn tracks that ever-growing context size, not a fixed
per-step cost — turn N always costs more than turn 1, even when the actual work per turn
hasn't changed. A **fresh** session doing the identical next step is far cheaper. **Decision:**
add two small, additive lines to the existing UserPromptSubmit stamp, both gated by one new
switch, `facilitator_nudge_enabled` (default **true**):

1. **Burn-rate segment** — `burn — ~{X} tok/min this session (10m)`, sourced from the
   existing FAST velocity engine (T2.1, `src/flow.mjs`). `sessionFlowStats` already computed
   a combined-across-sessions rate and an anomaly check; it now also returns `mine` — the
   *calling* session's own out-tokens/min over the same real 10-minute window, independent of
   whether it happens to be anomalous. Surfaced only when "meaningful" (`≥50` tok/min —
   `MEANINGFUL_BURN_PER_MIN` in `src/hook.mjs`); idle/no-flow-data sessions stay silent. No
   fabricated numbers: this is the same transcript-derived `output_tokens` flow already
   sampled by every hook (`sampleFlow`), scoped to the caller's own session tag.

2. **Facilitator-cost nudge** — `facilitator context ~{X}/turn — consider handing off to a
   fresh session to reset context cost`, firing when THIS session's current context **size**
   (tokens, not a delta) crosses `facilitator_context_threshold_tokens` (default **50000**,
   well below the existing ~160k compaction-ceiling warning — a deliberately earlier, distinct
   COST signal, not a duplicate of the near-ceiling "context getting low" line). Context size
   is computed directly from the already-tracked `context.window_size × context.used_pct`
   (`src/state.mjs`'s `parsePayload`) — the real figure the model is about to resend, so
   "~Xk/turn" is not an estimate. Rate-limited to at most once per
   `facilitator_nudge_cooldown_turns` UserPromptSubmit turns (default **10**) via a small
   self-pruning per-session counter (`facilitator.json`, 24h TTL, new file `src/facilitator.mjs`)
   — first sight above threshold fires immediately (no cold-start silence), then holds for the
   cooldown window before firing again.

Both new lines share the one enable switch on purpose (a single, simple on/off for "the new
facilitator-cost feature," rather than two independent flags to reason about) — disabling it,
or staying below both floors, reproduces byte-identical pre-ADR-29 output. Bad hand-edited
values (non-boolean enable, non-positive/non-finite threshold, cooldown < 1) fall back to the
defaults (never-throw discipline, ADR-5). Never-crash: `facilitatorNudge` is fully
self-contained try/catch (a corrupt `facilitator.json` degrades to a clean first-sight read,
never blocks the stamp); missing/garbage `context`, `burn`, or flow data anywhere in the path
resolves to "say nothing" rather than a stack trace or a fabricated figure.

**Enforced by:** `facilitator_nudge_enabled`/`facilitator_context_threshold_tokens`/
`facilitator_nudge_cooldown_turns` defaults + sanitization in `readConfig` (`src/util.mjs`);
`facilitatorNudge` in the new `src/facilitator.mjs`; the `mine` field on `sessionFlowStats`
(`src/flow.mjs`); the two new segments in `hookUserPromptSubmit` (`src/hook.mjs`), placed
after the existing context line so they never affect the pre-existing `hadWindow` framing.
20 new tests in `test/facilitator.test.mjs` (unit-level `facilitatorNudge` + `readConfig`
sanitization, and CLI-integration coverage: fires above threshold, silent below, rate-limited
across turns, disabled → silent for *both* lines, never-crash on missing context/burn/session
data and on a corrupt `facilitator.json`, per-session cooldown isolation, no cross-session
co-attribution on the burn line) plus 5 assertions added to `test/flow.test.mjs` for the new
`mine` field. One pre-existing test (`test/cli.test.mjs`'s canonical-stamp-shape check) legitimately
crossed the new default threshold with its 122k-token fixture context — it now opts out via
`facilitator_nudge_enabled: false`, which doubles as a regression proof that disabled really is
byte-identical. Full suite: **151 tests green** (131 pre-existing + 20 new).
