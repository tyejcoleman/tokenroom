# Architecture

One page; module-level truth. Decisions and their *why*s live in `DECISIONS.md` —
this doc is *what talks to what*.

## Data flow

```
Claude Code                      tokenroom                            consumers
───────────                      ────────                            ─────────
statusline render ──stdin──▶ tap ──▶ ~/.tokenroom/state.json ◀──read── MCP server (4 tools)
                              │      ~/.tokenroom/history.jsonl        UserPromptSubmit hook → stamp
                              └──▶ HUD line (stdout)                  SessionStart hook → re-inject
PreCompact event ──stdin──▶ pre-compact hook ──▶ ~/.tokenroom/handoffs/<session>.json
plan_resume (MCP) ────────────────────────────▶ ~/.tokenroom/resume.json (queue, armed)
set_intent (MCP) ─────────────────────────────▶ ~/.tokenroom/intent.json (focused run)
Stop event ──stdin──▶ stop hook ──reads intent+resume──▶ blocks stop → continues in-session
```

The **Stop hook** is the only surface that can *prevent* an agent from stopping: inside a
focused run (`set_intent`) with an *armed* resume plan whose window has reset, it re-injects
the next queued task so the same interactive session continues (ADR-25 — in-session only,
never headless, never crossing the ADR-22 boundary).

Everything is event-driven off official surfaces; there is no daemon, no polling, no
network (ADR-1). Each invocation is a fresh short-lived node process.

## Module map

| File | Responsibility | Key invariants |
|---|---|---|
| `bin/tokenroom.mjs` | CLI dispatch only — no logic | unknown commands print help, hooks exit silently |
| `src/tap.mjs` | statusline entry: parse → persist → HUD | never crashes, always prints (ADR-5); `--capture` appends raw payloads |
| `src/state.mjs` | payload → ResourceState; burn model; atomic state I/O | clamp/null bad fields; median-of-buckets burn ≥10min baseline (ADR-4/5) |
| `src/hud.mjs` | human one-liner | remaining-first (ADR-3); actionable signals only (ADR-4) |
| `src/hook.mjs` | UserPromptSubmit stamp · PostToolUse mid-turn re-stamp/cost receipts (intent-gated descent) · PreToolUse launch gate (warn-and-arm under intent) · **Stop** in-session auto-resume · PreCompact snapshot/guard · SessionStart re-inject · PostCompact log | session-scoping + per-account `show`-gate (ADR-7/21); age disclosure; silence > lying; guard/gate/Stop fail-open (ADR-13/25) |
| `src/accounts.mjs` | multi-account profiles: label/fold/config-dir, window snapshot, pair advice, echo honesty, `switch`/`run` CLIs | labels are identity, phase keys are isolation only (ADR-24/21); advice + launch-time config selection only — never a credential swap (ADR-1) |
| `src/handoff.mjs` | ground-truth snapshot capture/render + transcript extracts | facts not prose (ADR-8); 6h staleness guard; pointer not payload (ADR-11) |
| `src/pins.mjs` | must-survive-verbatim facts, re-injected after compaction | capped + TTL'd (ADR-12) |
| `src/events.mjs` | compaction event log + silent-cliff detection + `audit` renderer | best-effort only; never breaks tap/hooks (ADR-5) |
| `src/checkpoint.mjs` | model-authored survival note (save/take/render) | facts from hooks, judgment from models (ADR-15); capped, 6h staleness |
| `src/flow.mjs` | velocity engine: transcript flow sampling, calibration, burn enrichment | learned tokens-per-% labeled ≈; idle suppresses warnings; enrichment never breaks base state |
| `src/doctor.mjs` | install diagnosis | flags foreign hooks sharing events; exit 1 on problems |
| `src/resume.mjs` | deferred-work plan lifecycle: queue + both windows + `armed` | expiry survives a weekly deferral (ADR-25); single file |
| `src/intent.mjs` | session work-intent (focused run + task queue) | 5th MCP write surface; session-tag+guard like checkpoint; 12h TTL (ADR-25) |
| `src/fit.mjs` | fit_check + estimate_remaining verdict logic | context = real tokens; window = labeled heuristic |
| `src/mcp.mjs` | stdio MCP server (newline JSON-RPC) | read-only + one write surface (ADR-6); version from package.json (ADR-10) |
| `src/install.mjs` | settings.json merge, skill copy, MCP registration | idempotent; backup/restore; refuses npx cache; uninstall leaves no trace |
| `src/schema.mjs` + `schema/*.json` | ResourceState v0 validation | hand validator mirrors the JSON Schema |
| `skill/SKILL.md` | the behavioral policy installed into Claude Code | wording is eval-tested — change only with eval evidence (ADR-9) |
| `scripts/check-invariants.mjs` | the hard gates | cites ADR numbers; <100ms |

## Runtime files (`~/.tokenroom/`)

**Account-scoped (ADR-21):** every account gets its own subtree `accounts/<key>/` holding
`state.json`, `history.jsonl`, `calib.json`, `flow.jsonl`, `flow-cursors.json`, `bands.json`.
The key is the windows' reset PHASE (`resets_at mod window_length`), stable within an account
and distinct between accounts — so concurrent sessions on different accounts never clobber
each other. The tap also keeps a top-level `state.json` POINTER (latest account, for the human
CLIs) and a `sessions.json` map (`session_id → key`) so hooks, which never see `rate_limits`,
resolve their own account via `quotaScope`. api-key users (no windows) keep the legacy flat
layout. Dormant account subtrees are GC'd after 14 days.

**Global / session-scoped:** the top-level `state.json` pointer (ResourceState v0, atomic) ·
`sessions.json` (`session_id → account key` map for hooks) · `profiles.json` (multi-account
labels/identity: label → `{keys[], config_dir?, last_seen, last_windows_snapshot}`, ADR-24) ·
`handoffs/<session>.json` (pre-compaction snapshots) · `handoffs/<session>.extracts.json`
(verbatim transcript extracts, ADR-11) · `resume.json` (deferred-work plan) · `pins.json`
(must-survive facts, ADR-12) · `intent.json` (session work-intent + task queue, ADR-25) ·
`events.jsonl` (compaction lifecycle + context anomalies + account switch/rollover +
resume-continued, capped) · `config.json` (user config: `stamp_enabled`, `ceiling_pct`,
`mode`, `compact_guard_min`, `launch_gate`) · `raw-sample.jsonl` (only with `tap --capture`).

## Extension points

- **New provider adapter** (e.g. Codex): a collector that writes valid ResourceState with
  `provider: "openai"` — schema is the contract; see PLAN T3.2/T3.3.
- **New MCP tool:** add to `TOOLS` + dispatch in `src/mcp.mjs`; a write surface needs an ADR.
- **New hook:** handler in `src/hook.mjs`, dispatch in `bin/`, registration pair in
  `src/install.mjs` `HOOK_EVENTS` (uninstall handles any event automatically).
- **Skill/stamp wording:** behavioral claims require an eval round first (ADR-9) —
  harnesses in `eval/` are reusable (v0 cheap probes, v1 execution, v2 continuity).

## Testing strategy

Unit + spawn-based CLI tests (`test/`, node:test, no mocks — real processes, temp
`TOKENROOM_DIR`s, real git repos); a fixture corpus for every observed payload shape
(add one per new failure mode — see `/add-fixture`); invariant gates in the same suite;
behavioral eval harnesses in `eval/` for anything claiming to change model behavior.
