import { mkdirSync, chmodSync, writeFileSync, renameSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

export const tokenroomDir = () => process.env.TOKENROOM_DIR || join(homedir(), '.tokenroom');

// State may hold verbatim user messages (extracts, continuity) — owner-only, always.
// chmod converges dirs created before this hardening; best-effort (never crash a tap/hook).
export const ensureDir = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* exotic FS without chmod — the mkdir mode already covered the created case */
  }
};

export function atomicWrite(path, text) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function atomicWriteJSON(path, obj) {
  atomicWrite(path, JSON.stringify(obj, null, 2));
}

export function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Percentages must be 0–100; anything else (including epoch-leak values) becomes null. */
export function clampPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return null;
  return v;
}

/** Epoch timestamps, tolerant of milliseconds sneaking in. */
export function epochSec(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
}

export function fmtClock(sec) {
  if (!sec) return '?';
  const d = new Date(sec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtTokens(n) {
  if (n == null) return '?';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function fmtDelta(sec) {
  if (sec <= 0) return 'now';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Governor profiles (T2.4): the mode shifts WHEN tokenroom speaks up, never what it says.
 * powersave = early and often (thrift); performance = only when nearly too late
 * (minimal interruptions); ondemand = the shipped defaults. Read per-event from config,
 * so a mode change applies without restarting anything.
 */
export function modeProfile(mode) {
  switch (mode) {
    // ctx_bands fire the context handoff-nudge as context fills. Context is a BURN-THROUGH
    // resource, NOT a conserved one: held LATE on purpose so the agent uses it to the core.
    // The handoff is one cheap tool call that only needs to land before compaction, so the
    // default/performance modes nudge ONCE near the ceiling (~4% left) — never early; the
    // token-floored "super close" message is the final safety net. (Quota is the opposite —
    // a wary, paced resource; that's fh_bands, which stay multi-step.) Only powersave (thrift)
    // keeps an earlier 10% context heads-up.
    case 'performance':
      return { fh_bands: [10, 5, 1], ctx_bands: [4], receipt_pct_floor: 5, receipt_cost_floor: 3, throttle_sec: 300 };
    case 'powersave':
      return { fh_bands: [40, 25, 10, 5, 1], ctx_bands: [10, 4], receipt_pct_floor: 1, receipt_cost_floor: 0.5, throttle_sec: 60 };
    default:
      return { fh_bands: [25, 10, 5, 1], ctx_bands: [4], receipt_pct_floor: 2, receipt_cost_floor: 1, throttle_sec: 120 };
  }
}

/** True (returning the reset clock) when window data was written BEFORE a reset that
 *  has since passed — the figures are not stale, they are WRONG-SIGNED (a "7% left"
 *  written at 21:05 is a lie at 21:15 if the window reset at 21:10). Field 2026-06-10:
 *  an agent planned an entire turn around "nearly dry" minutes after a reset to 96%. */
export function crossedReset(state, nowSec = Date.now() / 1000) {
  const r = state?.windows?.five_hour?.resets_at;
  // ANY resets_at in the past = dead-window data: real post-reset payloads always carry
  // the NEXT reset clock. Covers both shapes: state.json written before the reset, AND
  // state.json freshly overwritten by an idle session re-rendering stale payload data
  // (field 2026-06-10: a "≈85% receipt / 6% left, resets 21:10" fired at 21:4x while the
  // true window was 95% — shape 2, caught live minutes after shape 1 was fixed).
  if (r && nowSec >= r) return r;
  return null;
}

// ── Per-account isolation (ADR-21, amends ADR-7) ─────────────────────────────
// The statusline payload carries NO account identifier, so when concurrent sessions are
// logged into DIFFERENT accounts they would otherwise clobber one global state.json
// (last-writer-wins) and the agent-facing stamp would show whichever account rendered
// last. We give each account its own subtree under ~/.tokenroom/accounts/<key>/ so a
// session always reads back ITS OWN account's windows/burn. The account key is derived
// from the windows' reset PHASE (resets_at mod window length): within an account the phase
// is invariant across resets, but it differs between accounts. Returns null when there are
// no windows (api-key / absent data) — those keep using the global dir.
const FIVE_HOUR_SEC = 5 * 3600;
const SEVEN_DAY_SEC = 7 * 86400;

export function accountKey(windows) {
  const fh = windows?.five_hour?.resets_at;
  const sd = windows?.seven_day?.resets_at;
  if (fh == null && sd == null) return null;
  const phase = `${fh != null ? fh % FIVE_HOUR_SEC : '-'}:${sd != null ? sd % SEVEN_DAY_SEC : '-'}`;
  return 'a' + createHash('sha1').update(phase).digest('hex').slice(0, 10);
}

/** True when two 5h buckets share the same WEEKLY reset phase (`resets_at % 7d`). The
 *  weekly phase is invariant within one physical account (a reset advances resets_at by
 *  exactly one window), so it survives the idle 5h re-phasing that mints a NEW account key
 *  for the SAME account (ADR-24). Used to tell a same-account window rollover from a real
 *  /login switch. Null on either side → not a confident match (treat as a switch). */
export function sameSevenDayPhase(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return a % SEVEN_DAY_SEC === b % SEVEN_DAY_SEC;
}

export const accountsRoot = () => join(tokenroomDir(), 'accounts');
/** Directory holding one account's state/history/calib/flow/bands. Null key → global dir
 *  (api-key users and pre-account fallbacks share the legacy top-level layout). */
export const accountDir = (key) => (key ? join(accountsRoot(), key) : tokenroomDir());

const sessionsPath = () => join(tokenroomDir(), 'sessions.json');
const SESSION_TTL = 30 * 60;

/** Record which account a session is currently on, so hooks — which never receive
 *  `rate_limits` — can resolve their own account's directory. Best-effort; self-prunes. */
export function recordSessionAccount(sessionId, key, nowSec = Date.now() / 1000) {
  if (!sessionId || !key) return;
  try {
    const m = readJSON(sessionsPath()) ?? {};
    for (const k of Object.keys(m)) if (nowSec - (m[k]?.at ?? 0) > SESSION_TTL) delete m[k];
    m[sessionId] = { key, at: nowSec };
    ensureDir(tokenroomDir());
    atomicWriteJSON(sessionsPath(), m);
  } catch {
    // the map is a convenience cache; never block on it
  }
}

/** The account a session was last seen on, or null if unknown/stale (then the caller must
 *  NOT present account-level quota — it can't attribute it). */
export function accountForSession(sessionId, nowSec = Date.now() / 1000) {
  if (!sessionId) return null;
  const e = (readJSON(sessionsPath()) ?? {})[sessionId];
  if (!e || nowSec - (e.at ?? 0) > SESSION_TTL) return null;
  return e.key ?? null;
}

const ACCOUNT_TTL = 14 * 86400;
/** Drop account subtrees untouched for two weeks (a logged-out account never returns). */
export function gcAccounts(nowSec = Date.now() / 1000) {
  try {
    for (const name of readdirSync(accountsRoot())) {
      const st = readJSON(join(accountsRoot(), name, 'state.json'));
      if (nowSec - (st?.updated_at ?? 0) > ACCOUNT_TTL) rmSync(join(accountsRoot(), name), { recursive: true, force: true });
    }
  } catch {
    // missing root or unreadable entry → nothing to collect
  }
}

export function listAccountKeys() {
  try {
    return readdirSync(accountsRoot()).filter((n) => n.startsWith('a'));
  } catch {
    return [];
  }
}

/** Resolve which account directory a session should read, and whether its quota is safe to
 *  present. Mapped → that account. Unmapped but exactly ONE account exists → that one (a
 *  single-account user keeps the stamp even before the map is written). No accounts yet →
 *  the legacy global layout. ≥2 accounts and unmapped → the global dir but DON'T show quota:
 *  we cannot tell which account is this session's, and showing the wrong one is the bug.
 *  `key` is the resolved account key (null in the legacy/withheld cases) — profile-aware
 *  consumers (pair advice, switch banner) need the identity, not just the directory. */
export function quotaScope(sessionId, nowSec = Date.now() / 1000) {
  const mapped = accountForSession(sessionId, nowSec);
  if (mapped) return { dir: accountDir(mapped), show: true, key: mapped };
  const keys = listAccountKeys();
  if (keys.length === 1) return { dir: accountDir(keys[0]), show: true, key: keys[0] };
  if (keys.length === 0) return { dir: tokenroomDir(), show: true, key: null };
  return { dir: tokenroomDir(), show: false, key: null };
}

/** Distinct account keys with a session seen in the last `windowSec` — the MCP server
 *  (which has no session id) uses this to decide whether quota attribution is ambiguous. */
export function activeAccountKeys(windowSec = 10 * 60, nowSec = Date.now() / 1000) {
  try {
    const m = readJSON(sessionsPath()) ?? {};
    const keys = new Set();
    for (const e of Object.values(m)) if (e?.key && nowSec - (e.at ?? 0) <= windowSec) keys.add(e.key);
    return [...keys];
  } catch {
    return [];
  }
}

export function readConfig() {
  const cfg = {
    stamp_enabled: true,
    ceiling_pct: 80,
    mode: 'ondemand',
    compact_guard_min: null, // minutes-to-reset under which AUTO compaction is blocked (ADR-13); null = off
    launch_gate: false, // deny expensive Task/Agent/Workflow launches when the window verdict is defer (T2.14); default OFF
    // Quiet-until-it-matters (ADR-26): the 5h-quota %-left at/below which routine budget
    // surfacing turns ON. ABOVE it the model gets NOTHING for the recurring quota lines
    // (per-turn stamp, cost receipts, shared-session note) — it stays unburdened. AT/BELOW
    // it they surface and escalate. Default 25.
    critical_pct: 25,
    // Weekly-warning control (ADR-27): gates ONLY the 7d/weekly line in the UserPromptSubmit
    // stamp (the `critical_pct` gate above is the separate 5h/quota line). Default 'on' —
    // matches today's behavior (shown once <20% of the week remains). 'off' silences it
    // entirely; 'auto' (opt-in) additionally suppresses it while a belay loop is armed for
    // this session, on the theory that an active autonomous loop is already pacing itself.
    weekly_warning: 'on',
    // Facilitator burn-efficiency signal (tokenroom enhancement): master switch for BOTH
    // the per-turn burn-rate segment (tok/min, this session) and the facilitator-cost
    // hand-off nudge in the UserPromptSubmit stamp. Default ON — the nudge only fires
    // once this session's context genuinely crosses the threshold below, so it stays
    // quiet-until-it-matters (ADR-26 spirit) without requiring opt-in.
    facilitator_nudge_enabled: true,
    // Context tokens (the current context SIZE, i.e. what gets resent every turn) at/above
    // which the facilitator-cost nudge fires. Deliberately well below the compaction
    // ceiling (~160k at the 80% default) — this is a distinct, earlier COST signal, not a
    // duplicate of the existing near-ceiling "context getting low" line.
    facilitator_context_threshold_tokens: 50000,
    // Minimum UserPromptSubmit turns between nudge firings for one session — keeps it
    // non-spammy on a long run that stays above the threshold.
    facilitator_nudge_cooldown_turns: 10,
    // Premium-model weekly cap (user directive 2026-07-17): Fable-class usage exhausts at
    // a FRACTION of the weekly window — Anthropic enforces a separate, smaller premium
    // budget the statusline payload does not (yet) expose as its own window. Modeled as a
    // derived ceiling over seven_day.used_pct, active only when the session's model id
    // matches premium_model_regex. If a real per-tier window ever appears in rate_limits,
    // the generic parser captures it and that ground truth should supersede this estimate.
    premium_cap_pct: 50,
    premium_model_regex: 'fable',
    // Points-of-weekly-budget remaining under the cap at/below which the stamp starts
    // disclosing (quiet-until-it-matters, ADR-26 spirit). Once the cap is exceeded the
    // line always shows.
    premium_disclose_pts: 20,
    ...(readJSON(join(tokenroomDir(), 'config.json')) ?? {}),
  };
  // Defensive (never-throw discipline, ADR-5): a hand-edited critical_pct that isn't a real
  // 0–100 number (NaN, string, bool, null, out of range) falls back to the default rather
  // than silencing the genuinely-critical case or spamming a healthy window.
  const cp = cfg.critical_pct;
  cfg.critical_pct = typeof cp === 'number' && Number.isFinite(cp) && cp >= 0 && cp <= 100 ? cp : 25;
  // Same discipline for weekly_warning: anything other than the three valid modes
  // (missing, hand-typo'd, wrong type) falls back to 'on' — the safer default is to WARN,
  // never to silently swallow a genuinely binding weekly constraint.
  cfg.weekly_warning = ['on', 'off', 'auto'].includes(cfg.weekly_warning) ? cfg.weekly_warning : 'on';
  // Premium-cap fields: same defensive discipline — invalid values fall back to defaults
  // (cap must be a real 1–100 number; regex must compile; disclose_pts a real 0–100 number).
  const pc = cfg.premium_cap_pct;
  cfg.premium_cap_pct = typeof pc === 'number' && Number.isFinite(pc) && pc > 0 && pc <= 100 ? pc : 50;
  try {
    new RegExp(cfg.premium_model_regex, 'i');
  } catch {
    cfg.premium_model_regex = 'fable';
  }
  const pd = cfg.premium_disclose_pts;
  cfg.premium_disclose_pts = typeof pd === 'number' && Number.isFinite(pd) && pd >= 0 && pd <= 100 ? pd : 20;
  // Same defensive discipline for the facilitator signal: a hand-edited bad value never
  // crashes and never silently produces nonsense (e.g. a negative or non-numeric
  // threshold that would fire on every turn, or a cooldown of 0 that defeats rate-limiting).
  cfg.facilitator_nudge_enabled = typeof cfg.facilitator_nudge_enabled === 'boolean' ? cfg.facilitator_nudge_enabled : true;
  const fct = cfg.facilitator_context_threshold_tokens;
  cfg.facilitator_context_threshold_tokens = typeof fct === 'number' && Number.isFinite(fct) && fct > 0 ? fct : 50000;
  const fcd = cfg.facilitator_nudge_cooldown_turns;
  cfg.facilitator_nudge_cooldown_turns = typeof fcd === 'number' && Number.isFinite(fcd) && fcd >= 1 ? Math.round(fcd) : 10;
  return cfg;
}

/** Persist a partial config patch to ~/.tokenroom/config.json, merged with whatever is
 *  already on disk (NOT the in-memory defaults) — so hand-edited/unrelated keys survive
 *  untouched and the file only ever grows the keys something actually set. Returns the
 *  fresh sanitized config (via readConfig) so the caller reports back the real effective
 *  state, not just the raw patch. This is a deliberate, narrow write surface — see ADR-6/27. */
export function writeConfig(patch) {
  const dir = tokenroomDir();
  ensureDir(dir);
  const path = join(dir, 'config.json');
  const onDisk = readJSON(path) ?? {};
  atomicWriteJSON(path, { ...onDisk, ...patch });
  return readConfig();
}
