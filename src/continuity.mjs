import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tokenroomDir, ensureDir, atomicWrite, atomicWriteJSON, readJSON, fmtClock } from './util.mjs';
import { readState } from './state.mjs';

// Continuity handoff document (T2.29 / ADR-18). `checkpoint` (ADR-15) is the model's
// TERSE last-second survival ping; this is its richer sibling — a model-authored,
// EVOLVING markdown working-doc that a fresh instance reads to resume the work fully:
// mission, current state, progress, exact next steps, key references, decisions + why,
// the USER's own directives/corrections, system/process improvements discovered, and
// open questions. Written throughout a long-running task (not only at the ceiling) so a
// process can survive REPEATED auto-compactions at full velocity — context-pressure
// becomes a write-the-handoff ritual, not a stop sign.
//
// Stored as real markdown under ~/.tokenroom/continuity/<session>.md (+ .meta.json for the
// re-injection digest). Session-scoped with the same tag-and-guard rule as checkpoint
// (MCP carries no session id, so we tag with the latest tap session and the injection
// guard accepts a match or an untagged doc). Latest-wins, capped per section, stale after
// 24h, pruned after 7 days. Re-injected at SessionStart(source=compact) as a POINTER +
// digest (ADR-11: the doc lives on disk; compaction just freed the context — point, don't
// dump).

const contDir = () => join(tokenroomDir(), 'continuity');
const docPathFor = (key) => join(contDir(), `${key}.md`);
const metaPathFor = (key) => join(contDir(), `${key}.meta.json`);
// filesystem-safe key from a session id; anything odd collapses to a single shared doc
const keyFor = (sid) => (typeof sid === 'string' && /^[\w.-]{1,128}$/.test(sid) ? sid : 'session');

// ── Project scoping (ADR-28) ────────────────────────────────────────────────
// ~/.tokenroom is ONE global directory shared by every project on the machine, but a
// continuity doc only means something to the project it was written in. `project` is the
// cwd's git repo root (stable across subdirectories of one checkout; a session's cwd can
// move around inside a repo without losing its doc), falling back to the raw cwd for
// non-git working dirs. Never throws — an unresolvable project just means this call can't
// scope by project, which downgrades to the pre-ADR-28 session-only lookup (still safe: see
// `takeContinuity`, where the un-scoped legacy fallback is only ever reachable when NEITHER
// side of the exchange can resolve a project — real hook/MCP traffic always supplies a cwd).
const projectFor = (cwd) => {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (root) return root;
  } catch {
    // not a git repo (or git unavailable) — the cwd itself is still a valid project boundary
  }
  return cwd;
};
// short filesystem-safe fingerprint of a resolved project path (paths contain '/', which a
// bare doc key cannot)
const projectKeyFor = (cwd) => {
  const p = projectFor(cwd);
  return p ? 'p' + createHash('sha1').update(p).digest('hex').slice(0, 12) : null;
};
// composite (session, project) doc key. No resolvable project (cwd absent/invalid) → the
// bare pre-ADR-28 session key, so call sites that genuinely have no cwd keep working exactly
// as before.
const compositeKey = (session_id, cwd) => {
  const pk = projectKeyFor(cwd);
  return pk ? `${keyFor(session_id)}__${pk}` : keyFor(session_id);
};

const MAX_AGE_SEC = 24 * 3600; // a handoff doc untouched for a day is probably a stale task
const PRUNE_SEC = 7 * 24 * 3600;
const CAP = { mission: 600, state: 800, item: 400, list: 14, refs: 24, cwd: 300 };

const trim = (v, n) => {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, n);
  return t || null;
};
const trimList = (v, n) =>
  Array.isArray(v) ? v.map((x) => trim(String(x), CAP.item)).filter(Boolean).slice(0, n) : [];
const mdList = (items, ordered) => items.map((s, i) => `${ordered ? `${i + 1}.` : '-'} ${s}`).join('\n');

function renderDoc(d) {
  const title = d.mission ? d.mission.split('\n')[0].slice(0, 80) : 'session';
  const L = [
    `# Tokenroom handoff — ${title}`,
    '',
    `_Canonical working-doc, updated ${fmtClock(d.at)}${d.session_id ? ` (session ${d.session_id})` : ''}. A fresh instance of you reads this to resume fully — trust it over the compacted summary, and continue without slowing down._`,
  ];
  if (d.cwd) L.push(`_Working dir: ${d.cwd}_`);
  const section = (h, body) => {
    if (body) {
      L.push('', `## ${h}`, body);
    }
  };
  section('Mission', d.mission);
  section('Current state', d.state);
  section('Progress so far', d.progress.length ? mdList(d.progress) : null);
  section('Next steps (do these first)', d.next_steps.length ? mdList(d.next_steps, true) : null);
  section('Key references', d.references.length ? mdList(d.references) : null);
  section('Decisions (and why)', d.decisions.length ? mdList(d.decisions) : null);
  section('Ruled out (do NOT retry)', d.rejected.length ? mdList(d.rejected) : null);
  section('User directives & corrections', d.user_directives.length ? mdList(d.user_directives) : null);
  section('System / process improvements discovered', d.improvements.length ? mdList(d.improvements) : null);
  section('Open questions', d.open_questions.length ? mdList(d.open_questions) : null);
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Write/refresh the canonical handoff doc (latest call wins). Returns {path, key} or
 *  null when there is nothing worth saving. Works without live state (saving judgment must
 *  never depend on the tap being live). */
export function saveContinuity(args, nowSec = Date.now() / 1000) {
  const session_id = readState()?.session_id ?? null;
  const d = {
    session_id,
    at: Math.round(nowSec),
    cwd: trim(args.cwd, CAP.cwd),
    mission: trim(args.mission, CAP.mission),
    state: trim(args.state, CAP.state),
    progress: trimList(args.progress, CAP.list),
    next_steps: trimList(args.next_steps, CAP.list),
    references: trimList(args.references, CAP.refs),
    decisions: trimList(args.decisions, CAP.list),
    rejected: trimList(args.rejected, CAP.list),
    user_directives: trimList(args.user_directives, CAP.list),
    improvements: trimList(args.improvements, CAP.list),
    open_questions: trimList(args.open_questions, CAP.list),
  };
  if (!d.mission && !d.next_steps.length) return null;
  const project = projectFor(args.cwd);
  const key = compositeKey(session_id, args.cwd);
  ensureDir(contDir());
  const path = docPathFor(key);
  atomicWrite(path, renderDoc(d));
  atomicWriteJSON(metaPathFor(key), {
    session_id,
    project,
    at: d.at,
    cwd: d.cwd,
    title: d.mission ? d.mission.split('\n')[0].slice(0, 100) : null,
    digest: { mission: d.mission ? d.mission.slice(0, 220) : null, next: d.next_steps[0] ?? null },
  });
  pruneOld(nowSec);
  return { path, key };
}

/** Fetch the handoff doc for a compacting session: prefer the (session, project)-tagged
 *  doc, then an untagged-session doc scoped to THIS project, then legacy pre-ADR-28 bare
 *  keys as a last resort (only reachable when this call itself has no project to scope by).
 *  `cwd` is the CURRENT session's own working dir (from the hook payload) — it is what
 *  proves a candidate belongs to THIS project; a doc written under a different project can
 *  never match here, because every project-scoped candidate is built from THIS call's own
 *  pk, never another project's. Defensive throughout — a bad read must never break
 *  SessionStart re-injection. */
export function takeContinuity(session_id, cwd, nowSec = Date.now() / 1000) {
  try {
    const pk = projectKeyFor(cwd);
    const sk = keyFor(session_id);
    const candidates = [];
    if (pk) {
      candidates.push(`${sk}__${pk}`); // this session, this project
      candidates.push(`session__${pk}`); // untagged-session doc, still scoped to THIS project
    }
    candidates.push(sk); // legacy pre-ADR-28 doc, no project tag — matched by session id below
    // The fully-untagged legacy fallback (no session tag either) is the one path that used
    // to cross projects (a Nomos doc reaching an unrelated openkakushin session). It stays
    // reachable ONLY when this call has no project to scope by at all — real hook/MCP
    // traffic always supplies a cwd, so in production this branch is dead and the collision
    // it used to cause cannot happen.
    if (!pk) candidates.push('session');
    const seen = new Set();
    for (const key of candidates) {
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = readJSON(metaPathFor(key));
      if (!meta) continue;
      if (nowSec - (meta.at ?? 0) > MAX_AGE_SEC) continue;
      if (meta.session_id && session_id && meta.session_id !== session_id) continue;
      const path = docPathFor(key);
      if (!existsSync(path)) continue;
      return { ...meta, path };
    }
    return null;
  } catch {
    return null;
  }
}

export function renderContinuityInjection(m) {
  const L = [
    `[tokenroom] your canonical handoff doc (you wrote this; updated ${fmtClock(m.at)}) survived compaction — READ IT FIRST to resume at full speed:`,
    `  ${m.path}`,
  ];
  if (m.digest?.mission) L.push(`- mission: ${m.digest.mission}`);
  if (m.digest?.next) L.push(`- resume at: ${m.digest.next}`);
  L.push(
    "It holds the mission, current state, exact next steps, key references, decisions, the user's directives, and improvements found this session. Trust it over the compacted summary, do not redo work it shows as done, and continue without slowing down."
  );
  return L.join('\n');
}

/** Most recently updated handoff doc, for the interactive `tokenroom handoff` CLI. With a
 *  `cwd`, prefers docs tagged to THAT project (ADR-28) — so running it from project B never
 *  shows project A's doc merely because it's newer. Falls back to the global most-recent
 *  when no doc is tagged to this project (no cwd given, or nothing here matches yet) — the
 *  original cross-session behavior, unchanged when cwd is omitted. */
export function latestContinuity(cwd) {
  try {
    const metas = readdirSync(contDir())
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => ({ key: f.replace(/\.meta\.json$/, ''), meta: readJSON(join(contDir(), f)) }))
      .filter((x) => x.meta);
    if (!metas.length) return null;
    const project = projectFor(cwd);
    const scoped = project ? metas.filter((x) => x.meta.project === project) : [];
    const pool = scoped.length ? scoped : metas;
    pool.sort((a, b) => (b.meta.at ?? 0) - (a.meta.at ?? 0));
    const { key, meta } = pool[0];
    const path = docPathFor(key);
    return { meta, path, markdown: existsSync(path) ? readFileSync(path, 'utf8') : null };
  } catch {
    return null;
  }
}

function pruneOld(nowSec) {
  try {
    for (const f of readdirSync(contDir())) {
      if (!f.endsWith('.meta.json')) continue;
      const m = readJSON(join(contDir(), f));
      if (m && nowSec - (m.at ?? 0) > PRUNE_SEC) {
        const key = f.replace(/\.meta\.json$/, '');
        try {
          rmSync(docPathFor(key));
        } catch {
          // best-effort
        }
        try {
          rmSync(join(contDir(), f));
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // pruning is best-effort
  }
}
