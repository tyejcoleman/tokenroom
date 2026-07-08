import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState } from './state.mjs';
import { accountDir, activeAccountKeys } from './util.mjs';
import { fitCheck, estimateRemaining } from './fit.mjs';
import { planResume } from './resume.mjs';
import { setIntent } from './intent.mjs';
import { addPin } from './pins.mjs';
import { saveCheckpoint } from './checkpoint.mjs';
import { saveContinuity } from './continuity.mjs';
import { logEvent } from './events.mjs';

// package.json is the single source of truth for the version (see /release procedure)
const pkg = JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8'));

// Minimal stdio MCP server (newline-delimited JSON-RPC 2.0). No network, no
// dependencies. Read-only over ~/.tokenroom/state.json, with one deliberate write
// surface: plan_resume records a deferred-work plan to ~/.tokenroom/resume.json.

const TOOLS = [
  {
    name: 'resource_state',
    description:
      'Full current ResourceState: rate-limit windows (5h/7d remaining, reset times), context headroom (tokens before the compaction ceiling), burn rate, session cost. Use to ground planning in actual budgets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'estimate_remaining',
    description:
      'Projections from the burn model: % left and minutes to reset per window, projected exhaustion time, context tokens left before compaction.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fit_check',
    description:
      'Check whether work estimated at est_tokens (optionally est_calls) fits current budgets. Returns fits | tight | exceeds | defer per budget, plus advice. Call before starting sizable tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        est_tokens: { type: 'number', description: 'estimated tokens the work will consume (read+write)' },
        est_calls: { type: 'number', description: 'estimated tool calls (optional)' },
      },
      required: ['est_tokens'],
    },
  },
  {
    name: 'plan_resume',
    description:
      'Record a resume plan for work deferred past a rate-limit reset (use after fit_check says defer, or at the 1% floor). Pass a `queue` of the remaining tasks so a long-running process keeps its full work list across the reset, and `blocked_on` to say WHICH window gates it (five_hour or seven_day) so readiness fires at the right reset. With `arm:true` inside a focused run (see set_intent), tokenroom CONTINUES the queue in THIS session automatically once the window resets — no manual restart. Tokenroom shows a countdown in the HUD and flags readiness in prompt stamps.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'what to resume and where to pick it up (one or two sentences); optional if queue is given' },
        queue: { type: 'array', items: { type: 'string' }, description: 'the remaining tasks to run after the reset, in order (each a short imperative)' },
        blocked_on: { type: 'string', enum: ['five_hour', 'seven_day'], description: 'which window must reset before this is runnable (default five_hour; use seven_day when the weekly window is the binding constraint)' },
        arm: { type: 'boolean', description: 'true → auto-continue this queue in-session once the window resets (only takes effect inside a focused run; default false)' },
        est_tokens: { type: 'number', description: 'estimated tokens the deferred work needs (optional)' },
      },
    },
  },
  {
    name: 'set_intent',
    description:
      'Declare the SHAPE of the current run so tokenroom paces to match it. kind=convergence|long_running|priority marks a FOCUSED run: tokenroom then keeps you at FULL SPEED down to the 1% quota floor (no cautious early-defer throttling at 5%), warns-and-arms before a big indivisible launch would die in a thin window, and at the floor arms your remaining queue to auto-resume IN THIS SESSION after the reset instead of stopping. Pass the task `queue` so a long-running process keeps its work list. kind=default restores the normal one-off descent. Call this at the START of a big multi-step build, migration, or convergence loop; clear it (kind=default) when the run ends.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['convergence', 'long_running', 'priority', 'default'], description: 'run shape; the first three are focused (burn to the floor + arm resume), default = normal cautious descent' },
        note: { type: 'string', description: 'one line on what this run is (optional)' },
        queue: { type: 'array', items: { type: 'string' }, description: 'the task list to keep running across resets (optional; each a short imperative)' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'checkpoint',
    description:
      'Save YOUR OWN survival note before context compaction: what you are doing, where you are, decisions made (with why), approaches already ruled out, exact next steps, key values. Re-injected to you after compaction. Call when a [tokenroom] update says context is running low, or before starting work that will not fit. Latest call wins.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'what you are working on, one sentence' },
        state: { type: 'string', description: 'where you are right now — what is done, what is in flight' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'decisions made, each with its why' },
        rejected: { type: 'array', items: { type: 'string' }, description: 'approaches already ruled out, each with why-not (prevents retrying dead ends)' },
        next_steps: { type: 'array', items: { type: 'string' }, description: 'exact next steps, file:line specific' },
        key_values: { type: 'object', description: 'exact values that must not be garbled (ports, ids, paths, budgets)' },
      },
      required: ['task', 'next_steps'],
    },
  },
  {
    name: 'handoff',
    description:
      "Update YOUR canonical handoff document — the living markdown working-doc a fresh instance of you would read to resume this work fully. Richer and more durable than `checkpoint`: write it AS YOU WORK and ALWAYS refresh it when context runs low, then keep working at full speed. When context is filling up, this is what you do INSTEAD of slowing down or stopping — tokenroom re-injects the doc's path + a digest to you after compaction so a long-running task continues seamlessly across as many auto-compactions as it takes. Latest call wins (pass the full current picture each time).",
    inputSchema: {
      type: 'object',
      properties: {
        mission: { type: 'string', description: 'the overarching goal of this work, one or two sentences' },
        state: { type: 'string', description: 'where things stand right now — what is done, what is in flight' },
        progress: { type: 'array', items: { type: 'string' }, description: 'what has been accomplished so far' },
        next_steps: { type: 'array', items: { type: 'string' }, description: 'exact next steps, file:line specific — what a fresh you should do FIRST' },
        references: { type: 'array', items: { type: 'string' }, description: 'key files/paths/docs/URLs to read to be up to speed' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'decisions made, each with its why' },
        rejected: { type: 'array', items: { type: 'string' }, description: 'approaches already ruled out, each with why-not (prevents retrying dead ends)' },
        user_directives: { type: 'array', items: { type: 'string' }, description: "the user's own instructions, constraints, and corrections this session — in their words where wording matters" },
        improvements: { type: 'array', items: { type: 'string' }, description: 'system/process improvements or insights discovered while working' },
        open_questions: { type: 'array', items: { type: 'string' }, description: 'unresolved questions or risks to flag' },
      },
      required: ['mission', 'next_steps'],
    },
  },
  {
    name: 'pin_fact',
    description:
      'Pin a fact that must survive context compaction VERBATIM — hard user constraints, deadlines, exact values ("no deploys before June 16", a port, an invariant). Re-injected word-for-word after every compaction until it expires (default 7 days) or is unpinned. Pin sparingly: only sentences whose exact wording matters.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the fact, in one sentence, exactly as it must be re-injected' },
        ttl_hours: { type: 'number', description: 'hours until the pin expires (default 168 = 7 days)' },
      },
      required: ['text'],
    },
  },
];

// Which account's quota does an MCP call see? MCP calls carry no session id, so the
// server cannot attribute quota the way hooks do (ADR-21). Resolution (ADR-24): the
// sessions map the tap maintains tells us which accounts were ACTIVE in the last ~10 min.
// Exactly one → that account's state (not the top-level pointer, which a concurrent
// account may have overwritten). None → the top-level pointer (single-account/legacy).
// Two or more → attribution is genuinely ambiguous, so quota is WITHHELD: windows/burn
// are stripped and an explicit `attribution` flag says why — returning the wrong
// account's numbers is the bug this exists to prevent; the per-session prompt stamps
// still carry correctly-attributed figures.
const AMBIGUOUS =
  'ambiguous — quota withheld (2 or more accounts were active in the last 10 minutes and MCP calls carry no session id; the [tokenroom] prompt stamps still show this session\'s correctly-attributed quota)';
const QUOTA_TOOLS = new Set(['resource_state', 'estimate_remaining', 'fit_check', 'plan_resume']);

function resolveMcpState(nowSec = Date.now() / 1000) {
  try {
    const active = activeAccountKeys(10 * 60, nowSec);
    if (active.length >= 2) {
      const s = readState();
      if (!s) return { state: null };
      return { state: { ...s, windows: {}, burn: { pct_per_hour: null, projected_exhaustion: null } }, attribution: AMBIGUOUS };
    }
    if (active.length === 1) {
      const s = readState(accountDir(active[0]));
      if (s) return { state: s };
    }
  } catch {
    // resolution is best-effort; fall through to the top-level pointer
  }
  return { state: readState() };
}

export function mcpServe() {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;

    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'tokenroom', version: pkg.version },
        },
      });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!TOOLS.some((t) => t.name === name)) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } });
        return;
      }
      const { state, attribution } = resolveMcpState(); // per-account routing + withhold rule (ADR-21/ADR-24)
      let result;
      if (name === 'checkpoint') {
        // works without state — saving judgment must never depend on the tap being live
        const note = saveCheckpoint(args);
        result = note
          ? { saved: true, note: 'Checkpoint saved — it will be re-injected to you after compaction. Update it as the task evolves (latest wins).' }
          : { saved: false, error: 'task and next_steps are required' };
      } else if (name === 'handoff') {
        // works without state — the canonical handoff doc must never depend on the tap being live
        const res = saveContinuity({ ...args, cwd: process.cwd() });
        result = res
          ? {
              saved: true,
              path: res.path,
              note: "Handoff doc updated at the path above — its path + a digest are re-injected to you after compaction. Refresh it as the work evolves (latest wins), and keep working: context running low is a reason to handoff, not to stop.",
            }
          : { saved: false, error: 'mission and next_steps are required' };
      } else if (name === 'pin_fact') {
        // works without state — pinning must never depend on the tap being live
        const pin = addPin(args.text, { ttl_hours: args.ttl_hours });
        result = pin
          ? { pinned: true, id: pin.id, text: pin.text, expires_at: pin.expires_at }
          : { pinned: false, error: 'text (non-empty string) is required' };
      } else if (name === 'set_intent') {
        // works without state — declaring the run shape must never depend on the tap being live
        const it = setIntent(args);
        const focused = ['convergence', 'long_running', 'priority'].includes(it.kind);
        result = {
          set: true,
          kind: it.kind,
          focused,
          queued: it.queue.length,
          note: focused
            ? `Focused run (${it.kind}): tokenroom keeps you at full speed to the 1% floor (no early-defer throttling), warns-and-arms before a big launch would die thin, and at the floor arms your queue to auto-resume IN THIS SESSION after the reset. Pass a queue here or via plan_resume(arm:true).`
            : 'Intent cleared to default — normal cautious descent restored.',
        };
      } else if (!state) {
        result = { error: 'no ResourceState collected yet — install the statusline tap (tokenroom install) and use Claude Code once' };
      } else if (name === 'resource_state') {
        result = { ...state, age_seconds: Math.max(0, Math.round(Date.now() / 1000 - state.updated_at)) };
      } else if (name === 'estimate_remaining') {
        result = estimateRemaining(state);
      } else if (name === 'plan_resume') {
        result = planResume(args, state);
      } else {
        result = fitCheck(state, args);
      }
      if (attribution && QUOTA_TOOLS.has(name) && result && typeof result === 'object') result.attribution = attribution;
      // every consult is a steering signal — audit it (tokenroom audit)
      logEvent({
        type: 'mcp_call',
        tool: name,
        verdict:
          result?.overall ??
          (result?.recorded != null ? 'recorded' : null) ??
          (result?.pinned != null ? 'pinned' : null) ??
          (result?.saved != null ? 'saved' : null) ??
          (result?.set != null ? `intent:${result.kind}` : null),
      });
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] } });
    } else if (id !== undefined && method) {
      send({ jsonrpc: '2.0', id, result: {} }); // ping & friends
    }
    // notifications (no id) are ignored
  });
}
