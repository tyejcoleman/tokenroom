# Tokenroom

[![CI](https://github.com/tyejcoleman/tokenroom/actions/workflows/ci.yml/badge.svg)](https://github.com/tyejcoleman/tokenroom/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Make your coding agent aware of the harness it runs in.** An agent can't see its rate
limits, its context ceiling, its own costs, or the compaction that's about to eat its
working memory — so it plans as if all of them were infinite, and pays for it: work dies
at 429 walls, tasks lose their thread mid-compaction, and whole windows of paid capacity
expire unused. Tokenroom feeds the harness's reality *to the agent itself*, live — and an
agent that knows where it is behaves differently: it sizes work to fit, spends the window
to the bottom in safe atomic pieces, checkpoints before the cliff, defers past resets
with a plan, and resumes from ground truth instead of a lossy summary.

> **Status: 0.5.x (unreleased) — renamed from *headroom* to **tokenroom** (ADR-23).**
> Working end-to-end and dogfooded hard by its author (including surviving its own
> compactions and its own account switches); every behavioral claim eval-tested (below);
> 79 tests green on node 18/20/22 CI; macOS/Linux; Windows untested. The ARM headless
> executor was removed (ADR-22) — autonomous continuation moves to a separate package;
> all awareness surfaces stay. npm publish under the new name is pending — install from
> source today. [Report sharp edges](.github/ISSUE_TEMPLATE).

## The problem

Claude Code retries 429s silently and compacts context mid-task; the model plans as if
both budgets were infinite. Subscription windows are use-it-or-lose-it, and compaction
breaks task continuity. Every existing tool (ccusage, dashboards, menu-bar apps) is
**human-facing and retrospective** — nothing feeds either budget *to the agent*. Tokenroom
is **model-facing, real-time, planning-oriented**: the model plans differently because it
knows.

The same blindness has a dozen faces, and they're all the same fix. An unaware agent
stops "to be safe" at 24% — abandoning a quarter of a window (~280k tokens) it paid for.
It waits for a rate-limit reset expecting its *memory* back (resets refill quota, never
context). It launches a 40-minute subagent into a dying window and loses the whole bet.
It re-tries the approach it already ruled out before compaction ate the verdict. Aware,
it does none of these — not because it's smarter, but because it can finally see.

## How it works

```
collectors                state                      awareness connector → Claude Code
----------                -----                      ---------------------------------
statusline tap  ──▶  ~/.tokenroom/state.json  ──▶  push   prompt stamps + MID-TURN updates (band
 (rate_limits +       + velocity engine                    crossings, cost receipts) + post-compaction
  context_window)       (learned tokens/%,                 re-injection (facts → checkpoint → pins)
                         flow, burn bands)         pull   MCP: resource_state · estimate_remaining ·
PreCompact hook ──▶  ground-truth snapshot                fit_check · plan_resume · checkpoint · pin_fact
 + transcript anchor      + verbatim extracts     policy  skill: scope-to-fit rules · governor modes ·
hooks (every event) ─▶  token-flow samples                 opt-in compact guard + launch gate
                         + audit log              human   statusline HUD · watch · line · audit · doctor
```

Zero dependencies. No network, ever. Official extension points only (statusline, hooks,
MCP). Event-driven — no daemon, no polling. Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Install

```bash
npm i -g tokenroom && tokenroom install   # publish pending under the new name; until then, from source:
git clone https://github.com/tyejcoleman/tokenroom && cd tokenroom
node bin/tokenroom.mjs install        # --dry-run to preview · uninstall to remove cleanly
```

One idempotent command wires up (and `uninstall` reverts, restoring any statusline you had):

1. **Statusline tap** — collects `rate_limits` + `context_window` from the payload Claude
   Code already pipes to statuslines; atomically maintains `~/.tokenroom/state.json`.
2. **Prompt stamp** — ~30 tokens of live budget context with each prompt:
   `[tokenroom] now Tue, Jul 1, 09:12 Asia/Tokyo · quota — 5h: 58% left, resets 14:00 · context — ~38k tokens before compaction`.
   Leads with the wall clock; the weekly (7d) window stays hidden until it's binding (<20%
   left); age-disclosed when stale; silent rather than wrong; `TOKENROOM_DISABLE=1` to mute.
3. **MCP tools** — `resource_state`, `estimate_remaining`, `fit_check({est_tokens})` →
   `fits | tight | exceeds | defer`, `plan_resume` for deferred work, `checkpoint` (the
   agent's own pre-compaction survival note), and `pin_fact` (facts that must survive
   compaction verbatim).
4. **Skill** — the eval-tested planning policy (size-to-fit, cheap-first under pressure,
   checkpoint before the ceiling, never defer out of caution).
5. **Compaction hooks** — PreCompact snapshot + SessionStart re-injection (below).

Requires Claude Code ≥ 2.1.92 with a Pro/Max subscription for rate-limit data; on API-key
auth Tokenroom degrades gracefully to context-only awareness.

### Reading the HUD

`⛶ 60% left (≈310k) ↻22:30 · ctx 56% (560k) · $26.03`

| Segment | Appears | Meaning |
|---|---|---|
| `60% left (≈310k) ↻22:30` | always | your quota: remaining %, **learned** ≈tokens-left (after calibration), reset clock |
| `week 22% left` | only when the weekly window is the binding constraint (<30%) |
| `ctx 56% (560k)` | always | room before auto-compaction (`⚠compact soon` under 10%) |
| `⚠ empty ~18:40–19:55` | only when the burn band lands **before** the reset | confidence band, not a twitchy point; suppressed entirely while idle |
| `✓ deferred work ready` | only when actionable | a waiting plan is hidden (see `tokenroom resume`) |
| `$26.03` | when ≥ $0.01 | this session at API prices |

A segment's *appearance* is itself the signal — healthy sessions stay terse.

Every percentage is **remaining**, never used. The statusline re-renders on session
activity (that's Claude Code's schedule), so it shows absolute clock times that never go
stale. For a truly **live** view, open a second pane:

```bash
tokenroom watch        # 1-second ticks: live countdowns, live data age, instant updates
```

```
TOKENROOM · live · 22:52 · data 0s old

5h window   ███████████████████████░   95% left   resets 03:30 (in 4h 38m)
7d window   ██████████████████████░░   91% left   resets in 1d 6h
context     ██████████████░░░░░░░░░░   47% left   ≈470k tokens before compaction
burn        7.3%/h · no exhaustion risk before reset
```

### Live everywhere else: `tokenroom line`

`tokenroom line` prints one compact line with **countdowns computed at call time** —
poll it every second and the display is genuinely live, anywhere:

```
5h 64% ↻3h 58m · 7d 84% · ctx 45% · $51.63
```

**tmux status bar** (live in the same window as Claude Code):

```tmux
set -g status-interval 1
set -g status-right '#(tokenroom line) '
set -g status-right-length 80
```

**macOS menu bar** via [SwiftBar](https://swiftbar.app)/xbar: copy
[`integrations/xbar/tokenroom.1s.sh`](integrations/xbar/tokenroom.1s.sh) into your plugin
folder — budgets in the menu bar, refreshed every second, with a detail dropdown.
Linux bars (waybar, polybar) work the same way: exec `tokenroom line` on an interval.

## Your agent's work survives compaction

Compaction summarizes the conversation — and garbles exactly the facts an in-flight task
depends on. Tokenroom's **PreCompact** hook snapshots ground truth the instant before
compaction (branch, uncommitted files, recent commits, budget state), and the
**SessionStart** hook re-injects it right after:

```
[tokenroom] post-compaction ground truth (snapshot taken 20:41, just before compaction):
- branch: main
- uncommitted changes (2):  M src/auth/middleware.js,  M test/auth.test.js
- recent commits: e508784 baseline · 1f201d4 migrate token.js
Trust this snapshot for repository state: check the uncommitted files first…
```

Hard facts, not summaries — the model resumes from what *is*, not what the compactor
remembered. And the snapshot **anchors back to disk**: it carries the path to the full
pre-compaction transcript plus a sidecar of verbatim extracts (every user message, recent
failed commands), so the model *searches* instead of reconstructing from memory.

Three more layers ride the same loop:

- **`checkpoint`** — when a mid-turn update warns context is low, the *agent* saves its
  own survival note (task, decisions + why, ruled-out approaches, exact next steps);
  re-injected after compaction. Facts from hooks, judgment from models.
- **`pin_fact` / `tokenroom pin`** — constraints whose exact wording must never be
  paraphrased away ("no deploys before June 16") are re-injected verbatim after every
  compaction until unpinned or expired.
- **Silent-trim detection** — Claude Code's microcompaction clears old tool results with
  *no hook and no UI signal*; tokenroom's tap notices the context cliff and the next stamp
  discloses it once, with the transcript path as the recovery route.

Continuity eval results (including the honest nulls): [`eval/REPORT.md`](eval/REPORT.md).

## Defer now, resume when the window resets

When `fit_check` says work won't fit the current window, the model records a plan with
`plan_resume`. The moment the window resets, prompt stamps, new sessions, and the HUD
(`✓ deferred work ready`) announce it. Capacity that used to expire silently now has a
queue (`tokenroom resume` to inspect, `--clear` when picked up).

## Two accounts? It knows which one you're on

Toggle subscription accounts with `/login` and tokenroom keeps up: each account's
windows live in their own store (never cross-contaminated), a mid-session switch is
detected on the very next statusline render (the stamp announces "account switched — now
on '\<profile\>'" with the new numbers), and a pre-switch *echo* — the old account's dry
figure frozen in the payload — is disclosed instead of asserted. Name your accounts
(`tokenroom account label work`) and the pair becomes a planning unit: when the active
window runs low but the other profile is fresh, the agent is told to *finish the unit at
full speed, then switch — zero downtime* instead of deferring past a reset.
`tokenroom switch` prints the decision table; `tokenroom run` launches `claude` on the
profile with the most headroom (per-profile `CLAUDE_CONFIG_DIR` — launch-time selection
only; tokenroom never touches auth files or swaps anything mid-session).

## It flies the window like a descent profile — never wasting the tail, never crashing

The wow is in the endgame. **Percent is not the unit of caution — divisibility is.**
What changes as quota thins isn't *whether* the agent works; it's the size of the bets:

| Quota left | Regime | Behavior |
|---|---|---|
| >10% | cruise | normal, right-sized work |
| 5–10% | descend | no new subagents or long indivisible tasks; small atomic steps, committed as they land |
| 2–5% | approach | finishing moves: complete, test, commit, `plan_resume` the rest |
| ≤2% | land | start nothing; checkpoint + defer note |

An atomic step is salvage-proof — committed before any wall. A subagent launch is an
indivisible bet that dies whole if the window dies first (the opt-in launch gate makes
that structural: expensive launches are *denied* in late descent, with the reason).
Net effect: the agent uses the window **to the bottom** — the tail of every window used
to expire unused; now it's spent in pieces nothing can take back. And the skill is
blunt about the failure mode this replaces: *pausing at 15–30% with 100k+ tokens left
isn't prudence, it's waste.*

**And the same control loop runs at week scale.** The 7-day window is paced like a
flight plan: tokenroom compares the fraction of the week elapsed against the fraction of
budget used. Running **hot** (on track to exhaust the week early — the worst failure,
because every session goes dark until the weekly reset), the stamp says so with the
numbers that matter: *"weekly pace is HOT (1.3x sustainable): on track to exhaust the
WEEK in ~1d 4h, 22h before its reset; ≈5%/day sustains — prefer deferring bulk work."*
Agents throttle the big-batch work, keep the normal work flowing, and the week lands at
its reset with nothing wasted and nothing dark. Cruise, don't crash — at both timescales.

## The agent sees costs while it works — not just balances

- **Mid-turn updates:** stamps arrive with your prompts, but long autonomous turns used
  to burn blind. A PostToolUse hook now re-stamps the model the moment a budget crosses a
  worsening band (25/10/5% left), throttled, never chatty.
- **Cost receipts:** a tool call that visibly moves the budget gets a one-line receipt —
  `receipt: that Task cost ≈5% of the 5h window (+$3.30) — 55% left` — so agents learn
  unit economics instead of pricing by vibes.
- **Velocity engine:** hooks sample exact token flow from the transcript and calibrate it
  against the window's %-steps, *learning* your account's tokens-per-percent. That's how
  the HUD earns `≈tokens left`, exhaustion becomes a confidence band, and the warning
  disappears entirely while you're idle.
- **Quiet until it matters:** `critical_pct` (default **25**) is the 5h-quota %-left at/below
  which the routine budget lines — the per-turn `quota — 5h: X% left` stamp, cost receipts,
  and the shared-session note — turn on. *Above* it the model gets nothing for them and stays
  unburdened; at/below it they surface and escalate (and a window projected to run dry *before*
  its reset always surfaces, healthy % or not). Non-budget output (clock, context, deferred
  work, pins, intent) is never gated. A bad value falls back to the default (ADR-26).
- **Weekly-warning control:** `weekly_warning: on | off | auto` (default **on**) is a
  separate switch just for the `7d: X% left — weekly pace is HOT …` line (the 5h line above
  has its own `critical_pct` gate). `off` silences it permanently; `auto` (opt-in) shows it
  normally but suppresses it while a `belay` autonomous loop is actively armed for the
  session — the loop is already pacing its own weekly spend. Change it anytime
  with the `tokenroom_weekly_warning` MCP tool (persists to `config.json`; ADR-27) — note that
  a *newly added* MCP tool needs `/mcp reload` (or a fresh session) before it's callable, even
  though the underlying hook behavior is live immediately on every hook call.
- **Governor modes:** `mode: performance | ondemand | powersave` shifts *when* tokenroom
  speaks (bands, receipt floors, throttle) — never what it says. Applies without restart.
- **Opt-in guards:** `compact_guard_min` blocks *auto*-compaction minutes before a reset
  (a post-reset `/clear` beats compacting into a dying window — never blocks your manual
  `/compact`); `launch_gate` denies expensive subagent/workflow launches when the window
  verdict is defer. Both fail open, always.

## Audit the loop: `tokenroom audit` · diagnose it: `tokenroom doctor`

`tokenroom audit` renders the awareness loop as a timeline — every stamp injected (and why
skipped), band crossings even when silent by design, every MCP consult with its verdict,
the compaction lifecycle — closing with steering-signal counts. You can *see* whether
your agent actually consulted its budgets.

`tokenroom doctor` answers "why isn't it working?" before you file an issue: wiring,
stale paths, data freshness, calibration state — and it flags *other* hooks sharing your
events, because Claude Code doesn't attribute hook errors per-hook and their failures
will look like tokenroom's.

## Does it actually change behavior? We tested it.

Before building the connector, we ran agents through [simulated-budget evals](eval/):
real repo, real tools, a live budget burning down behind a `fit_check` CLI, graded from
artifacts (commits, test suites, journals — never self-reports). Across haiku and sonnet:

- **Naive agents** plowed through ~33k estimated tokens of work the window couldn't
  cover — work that dies at exhaustion, including a mid-flight atomic migration.
- **Equipped agents** shipped exactly what fit, stopped on the DEFER verdict, and wrote
  reset-aware resume plans — while spending ~40% fewer tokens.
- On healthy budgets, equipped agents completed everything with no false caution.

The full comparison table — regenerated by `npm run eval`, which fails if any number's
evidence file is missing — lives in [`eval/REPORT.md`](eval/REPORT.md), honest nulls
included. Methodology rules in [ADR-9](docs/DECISIONS.md).

And one more kind of evidence: **tokenroom was built under its own supervision.** Every
feature shipped with the tool running live on its own author — receipts billed the
commits that created receipts, mid-task updates called the clean boundaries during its
own development, and
three wrong agent mental-models were caught in the field, probed within hours, and fixed
evidence-sized (the escalation criteria were pre-registered in the eval results *before*
the recurrence). The repo history is the field journal.

## This repo is an agent harness

Tokenroom is built to be maintained **by coding agents, consistently** — the repo itself
carries the discipline:

- **Context:** [`CLAUDE.md`](CLAUDE.md)/[`AGENTS.md`](AGENTS.md) route any agent through
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (what talks to what) and
  [`docs/DECISIONS.md`](docs/DECISIONS.md) (every standing decision *with its why*).
- **Procedures:** repo slash-commands — `/release`, `/add-fixture`, `/run-evals` — encode
  the recurring jobs as runbooks.
- **Hard gates:** [`scripts/check-invariants.mjs`](scripts/check-invariants.mjs) runs
  after every agent edit (repo PostToolUse hook) and in CI: new dependency, network
  surface, compliance tripwire, or crash-prone entry point → blocked on the spot, with
  the ADR that explains why.

Point your agent at the repo and tell it what to change; the harness does the rest.
Details in [`CONTRIBUTING.md`](CONTRIBUTING.md). Most wanted: payload samples from other
plans/models/OSes (`tokenroom tap --capture` → [donate a fixture](.github/ISSUE_TEMPLATE)),
Windows testing, the Codex adapter.

## The spec

`ResourceState v0` is deliberately provider-neutral — an adapter for any harness (Codex
CLI next) can be written from [`docs/RESOURCE-STATE.md`](docs/RESOURCE-STATE.md) alone;
everything downstream (HUD, stamps, MCP, audit) works unchanged.

## Compliance posture

Tokenroom uses only surfaces vendors expose on purpose: statusline stdin JSON, hooks, MCP,
and your own local files. It **never** reuses subscription OAuth tokens outside official
clients, calls undocumented endpoints, spoofs harness identity, makes network requests,
or burns interactive quota headlessly — enforced by automated gates, not just policy.
See [`SECURITY.md`](SECURITY.md) and ADR-1.

## Project layout

```
bin/ src/        the CLI: tap · hook · mcp · install · watch · line · resume · pin · audit · doctor (zero-dep ESM)
skill/           the behavioral policy installed into Claude Code
schema/          ResourceState v0 JSON Schema
scripts/         invariant gates (the hard-gate layer)
test/            node:test suites + the payload fixture corpus
eval/            behavioral eval harnesses + published results (v0 · v1 · v2-continuity)
docs/            ONE-PAGER · PLAN · VALIDATION · ARCHITECTURE · DECISIONS
.claude/         repo agent harness: gates hook + procedure commands
```

## Teams & orgs

Running coding agents against shared seat quota or org API keys? A team/org layer
(fleet visibility, org budgets fed to every agent, policy push) is being explored —
see [docs/PRO.md](docs/PRO.md). If that's you, [open an issue](../../issues) tagged
`org` and describe your setup; design partners shape what gets built.

## License

[Apache-2.0](LICENSE).
