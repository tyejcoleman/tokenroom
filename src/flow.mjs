import { openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tokenroomDir, ensureDir, atomicWriteJSON, readJSON } from './util.mjs';

// Velocity engine (T2.1): two flows, cross-calibrated.
//   FAST  — real token flow from the transcript JSONL `usage` records (exact,
//           timestamped, continuous; sampled incrementally by the hooks, which receive
//           transcript_path on every event).
//   ANCHOR — the window's used_percentage from the tap (integer-quantized but
//           authoritative for the quota).
// tokens-per-percent = flow ÷ %-rate, learned empirically — the window's token
// denominator is undocumented, so we learn it instead of faking it. Single-session
// calibration assumption documented in PLAN T2.1; concurrent sessions widen the error.

// Paths are per-account: the caller passes the account directory (accountDir(key)); the
// default keeps the legacy global layout for api-key users and direct unit-test calls.
const cursorsPath = (dir = tokenroomDir()) => join(dir, 'flow-cursors.json');
const flowPath = (dir = tokenroomDir()) => join(dir, 'flow.jsonl');
const calibPath = (dir = tokenroomDir()) => join(dir, 'calib.json');
const FLOW_WINDOW_SEC = 90 * 60;
const FLOW_MAX_LINES = 2000;
const IDLE_OUT_TOKENS = 500; // fewer out-tokens than this in 10min = effectively idle
const CALIB_MAX_SAMPLES = 50;

/** Incrementally read NEW bytes of the transcript and append usage samples. Cheap:
 *  one stat + one read from the stored offset per call. Never throws. */
export function sampleFlow(transcriptPath, sessionId, nowSec = Date.now() / 1000, dir = tokenroomDir()) {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return;
    ensureDir(dir);
    const cursors = readJSON(cursorsPath(dir)) ?? {};
    const key = sessionId ?? transcriptPath;
    let offset = cursors[key]?.path === transcriptPath ? cursors[key].offset : 0;

    const fd = openSync(transcriptPath, 'r');
    let chunk;
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return;
      const len = Math.min(size - offset, 8 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      chunk = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    // only consume complete lines; leave a partial trailing line for next time
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) return;
    cursors[key] = { path: transcriptPath, offset: offset + Buffer.byteLength(chunk.slice(0, lastNl + 1)) };

    const samples = [];
    for (const line of chunk.slice(0, lastNl).split('\n')) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const u = o?.message?.usage;
      if (!u || o.type !== 'assistant') continue;
      const t = o.timestamp ? Math.round(Date.parse(o.timestamp) / 1000) : Math.round(nowSec);
      samples.push({ t, out: u.output_tokens ?? 0, inp: u.input_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0, s: sessionId ?? null });
    }
    atomicWriteJSON(cursorsPath(dir), cursors);
    if (!samples.length) return;
    appendFileSync(flowPath(dir), samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
    const lines = readFileSync(flowPath(dir), 'utf8').trim().split('\n');
    if (lines.length > FLOW_MAX_LINES) writeFileSync(flowPath(dir), lines.slice(-FLOW_MAX_LINES / 2).join('\n') + '\n');
  } catch {
    // flow sampling is best-effort; hooks must never fail because of it
  }
}

const readFlow = (nowSec, dir = tokenroomDir()) => {
  try {
    if (!existsSync(flowPath(dir))) return [];
    return readFileSync(flowPath(dir), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((s) => s && nowSec - s.t <= FLOW_WINDOW_SEC);
  } catch {
    return [];
  }
};

/** Flow over the recent window: out-tokens/min for the last 10 min and last 90 min. */
export function flowStats(nowSec = Date.now() / 1000, dir = tokenroomDir()) {
  const samples = readFlow(nowSec, dir);
  if (!samples.length) return null;
  const sum = (arr) => arr.reduce((a, s) => a + s.out, 0);
  const recent = samples.filter((s) => nowSec - s.t <= 10 * 60);
  const recentOut = sum(recent);
  const span = Math.max(60, nowSec - samples[0].t);
  return {
    out_10m: recentOut,
    out_per_min_10m: Math.round(recentOut / 10),
    out_per_min_90m: Math.round(sum(samples) / (span / 60)),
    idle: recentOut < IDLE_OUT_TOKENS,
  };
}

/**
 * Per-session burn over the last 10 min, for the multi-session disclosure. The flow
 * log aggregates every session's transcript, so this both gives the COMBINED rate and
 * lets us flag an anomalous burner. Sessions are identified by the `s` tag added at
 * sample time; pre-tag samples (no `s`) fold into "unknown" and degrade gracefully.
 * Anomaly = a session burning >= ANOMALY_RATIO x the median of the others, above a
 * floor (so two quiet sessions don't trip it). Returns null when there's nothing to say.
 * `mine` (burn-efficiency signal, tokenroom enhancement): the CALLING session's own
 * out-tokens/min over the same 10min window, independent of whether it happens to be
 * anomalous — the per-session rate `anomaly` only surfaces conditionally. Reuses this
 * same per-session aggregation rather than a second pass over the flow log.
 */
const ANOMALY_RATIO = 3;
const ANOMALY_FLOOR_PER_MIN = 200; // out-tokens/min below this is "not really burning"
export function sessionFlowStats(nowSec = Date.now() / 1000, mySession = null, dir = tokenroomDir()) {
  const recent = readFlow(nowSec, dir).filter((s) => nowSec - s.t <= 10 * 60);
  if (!recent.length) return null;
  const bySession = new Map();
  for (const s of recent) {
    const k = s.s ?? 'unknown';
    bySession.set(k, (bySession.get(k) ?? 0) + (s.out ?? 0));
  }
  const per = [...bySession.entries()]
    .map(([id, out]) => ({ id, perMin: Math.round(out / 10) }))
    .filter((p) => p.perMin > 0);
  const combinedPerMin = per.reduce((a, p) => a + p.perMin, 0);
  const burning = per.length;
  // anomaly: compare each session to the median of the OTHERS
  let anomaly = null;
  if (burning >= 2) {
    for (const p of per) {
      const others = per.filter((o) => o.id !== p.id).map((o) => o.perMin).sort((a, b) => a - b);
      const med = others.length % 2 ? others[others.length >> 1] : Math.round((others[(others.length >> 1) - 1] + others[others.length >> 1]) / 2);
      if (med > 0 && p.perMin >= ANOMALY_FLOOR_PER_MIN && p.perMin >= ANOMALY_RATIO * med) {
        anomaly = { isMine: mySession != null && p.id === mySession, ratio: Math.round((p.perMin / med) * 10) / 10, perMin: p.perMin };
        break;
      }
    }
  }
  const mine = mySession != null ? per.find((p) => p.id === mySession) ?? null : null;
  return { burning, combinedPerMin, anomaly, mine };
}

/**
 * Enrich a freshly-built ResourceState with flow-derived velocity:
 * - out_per_min_10m: instantaneous flow (reacts in seconds, not the %-median's ~20min)
 * - idle suppression: near-zero recent flow → clear projected exhaustion (a projection
 *   premised on a burn that stopped is a lie — field feedback 2026-06-10)
 * - est_tokens_left: (100 − used%) × learned tokens-per-percent, always labeled ≈
 * - exhaustion_band: [fast-rate estimate, slow-rate estimate] instead of a twitchy point
 */
export function enrichBurn(state, nowSec = Date.now() / 1000, dir = tokenroomDir()) {
  try {
    const stats = flowStats(nowSec, dir);
    const used = state.windows?.five_hour?.used_pct;
    const cal = calibrate(used, nowSec, dir);
    if (stats) {
      state.burn.out_per_min_10m = stats.out_per_min_10m;
      if (stats.idle) {
        state.burn.projected_exhaustion = null;
        state.burn.exhaustion_band = null;
        return state;
      }
    }
    if (cal && used != null) {
      state.burn.tokens_per_pct = cal.tokens_per_pct;
      state.burn.est_tokens_left = Math.round((100 - used) * cal.tokens_per_pct);
      if (stats) {
        const rates = [stats.out_per_min_10m, stats.out_per_min_90m].filter((r) => r > 0).map((r) => (r * 60) / cal.tokens_per_pct);
        if (rates.length === 2) {
          const hrs = rates.map((r) => (100 - used) / r).sort((a, b) => a - b);
          if (hrs[0] < 48) state.burn.exhaustion_band = [Math.round(nowSec + hrs[0] * 3600), Math.round(nowSec + hrs[1] * 3600)];
        }
      }
    }
  } catch {
    // velocity is enrichment; the base state must always survive
  }
  return state;
}

/**
 * Calibration: every time the tap sees the window % step up, divide the out-tokens that
 * flowed since the last step by the points moved → out-tokens-per-percent. Median of
 * samples is the learned denominator. A %-drop >5 means the window reset — re-anchor.
 */
export function calibrate(usedPct, nowSec = Date.now() / 1000, dir = tokenroomDir()) {
  try {
    if (usedPct == null) return null;
    const cal = readJSON(calibPath(dir)) ?? { anchor_u: null, anchor_t: null, samples: [] };
    const samples = readFlow(nowSec, dir);
    const outSince = (t0) => samples.filter((s) => s.t > t0).reduce((a, s) => a + s.out, 0);

    if (cal.anchor_u == null || usedPct < cal.anchor_u - 5) {
      Object.assign(cal, { anchor_u: usedPct, anchor_t: Math.round(nowSec) });
    } else if (usedPct >= cal.anchor_u + 1) {
      const tokens = outSince(cal.anchor_t);
      const pts = usedPct - cal.anchor_u;
      if (tokens > 0) {
        cal.samples.push(Math.round(tokens / pts));
        cal.samples = cal.samples.slice(-CALIB_MAX_SAMPLES);
      }
      Object.assign(cal, { anchor_u: usedPct, anchor_t: Math.round(nowSec) });
    }
    ensureDir(dir);
    atomicWriteJSON(calibPath(dir), cal);
    if (!cal.samples.length) return null;
    const s = [...cal.samples].sort((a, b) => a - b);
    const m = s.length >> 1;
    return { tokens_per_pct: s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2), n: cal.samples.length };
  } catch {
    return null;
  }
}
