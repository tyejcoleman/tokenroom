import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loopActiveForSession, resolveSessionId, belayDir } from '../src/looprobe.mjs';

// ADR-27: loopActiveForSession is the ONLY signal the weekly-warning `auto` mode reads.
// It must be read-only, never throw, and default to false (no suppression) whenever
// belay is absent, its file is missing/corrupt, or the shape is unexpected.

function withBelay(loops) {
  const dir = mkdtempSync(join(tmpdir(), 'tr-belay-'));
  mkdirSync(dir, { recursive: true });
  if (loops !== undefined) writeFileSync(join(dir, 'loops.json'), JSON.stringify(loops));
  process.env.BELAY_DIR = dir;
  return dir;
}

test('resolveSessionId: prefers the explicit id, falls back to $CLAUDE_CODE_SESSION_ID, else null', () => {
  const savedEnv = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    assert.equal(resolveSessionId('s1'), 's1');
    assert.equal(resolveSessionId(null), null);
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session';
    assert.equal(resolveSessionId(null), 'env-session');
    assert.equal(resolveSessionId('explicit'), 'explicit', 'explicit id wins over the env fallback');
  } finally {
    if (savedEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedEnv;
  }
});

test('belayDir: honors BELAY_DIR override, else falls back to ~/.belay', () => {
  const saved = process.env.BELAY_DIR;
  try {
    process.env.BELAY_DIR = '/tmp/some-belay-dir';
    assert.equal(belayDir(), '/tmp/some-belay-dir');
    delete process.env.BELAY_DIR;
    assert.match(belayDir(), /\.belay$/);
  } finally {
    if (saved === undefined) delete process.env.BELAY_DIR;
    else process.env.BELAY_DIR = saved;
  }
});

test('loopActiveForSession: armed + not paused + matching session → true', () => {
  withBelay({ loops: { g1: { armed: true, paused: false, session_id: 's-match' } } });
  assert.equal(loopActiveForSession('s-match'), true);
});

test('loopActiveForSession: paused loop → false even if armed and session matches', () => {
  withBelay({ loops: { g1: { armed: true, paused: true, session_id: 's-match' } } });
  assert.equal(loopActiveForSession('s-match'), false);
});

test('loopActiveForSession: not armed → false', () => {
  withBelay({ loops: { g1: { armed: false, paused: false, session_id: 's-match' } } });
  assert.equal(loopActiveForSession('s-match'), false);
});

test('loopActiveForSession: different session id → false (never cross-session suppress)', () => {
  withBelay({ loops: { g1: { armed: true, paused: false, session_id: 'other-session' } } });
  assert.equal(loopActiveForSession('s-match'), false);
});

test('loopActiveForSession: global-scope loop (session_id null) never matches a real session id', () => {
  withBelay({ loops: { g1: { armed: true, paused: false, session_id: null, loop_scope: 'global' } } });
  assert.equal(loopActiveForSession('s-match'), false);
});

test('loopActiveForSession: no session id at all → false, never throws', () => {
  withBelay({ loops: { g1: { armed: true, paused: false, session_id: null } } });
  assert.equal(loopActiveForSession(null), false);
  assert.equal(loopActiveForSession(undefined), false);
  assert.equal(loopActiveForSession(''), false);
});

test('loopActiveForSession: missing ~/.belay entirely (belay not installed) → false', () => {
  process.env.BELAY_DIR = join(mkdtempSync(join(tmpdir(), 'tr-nobelay-')), 'does-not-exist');
  assert.equal(loopActiveForSession('s-match'), false);
});

test('loopActiveForSession: loops.json present but empty/no loops key → false', () => {
  withBelay({});
  assert.equal(loopActiveForSession('s-match'), false);
});

test('loopActiveForSession: corrupt/garbage JSON → false, never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-belay-garbage-'));
  writeFileSync(join(dir, 'loops.json'), '{not valid json at all');
  process.env.BELAY_DIR = dir;
  assert.doesNotThrow(() => loopActiveForSession('s-match'));
  assert.equal(loopActiveForSession('s-match'), false);
});

test('loopActiveForSession: malformed shapes (loops as array, entry as string) → false, never throws', () => {
  withBelay({ loops: ['not', 'an', 'object'] });
  assert.equal(loopActiveForSession('s-match'), false);

  withBelay({ loops: { g1: 'not-an-object' } });
  assert.equal(loopActiveForSession('s-match'), false);

  withBelay('totally the wrong top-level shape');
  assert.equal(loopActiveForSession('s-match'), false);
});

test('loopActiveForSession: picks the matching entry among several (mixed armed/paused/other-session)', () => {
  withBelay({
    loops: {
      g1: { armed: true, paused: false, session_id: 'other' },
      g2: { armed: false, paused: false, session_id: 's-match' },
      g3: { armed: true, paused: true, session_id: 's-match' },
      g4: { armed: true, paused: false, session_id: 's-match' }, // the one that should match
    },
  });
  assert.equal(loopActiveForSession('s-match'), true);
});
