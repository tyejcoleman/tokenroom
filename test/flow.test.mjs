import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hr-flow-'));
process.env.TOKENROOM_DIR = dir;
const { sampleFlow, flowStats, calibrate, enrichBurn, sessionFlowStats } = await import('../src/flow.mjs');

const NOW = Math.round(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString();
const usageLine = (t, out) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(t), message: { usage: { output_tokens: out, input_tokens: 10, cache_read_input_tokens: 50000, cache_creation_input_tokens: 200 } } });

test('sampleFlow: incremental cursor — no duplicates, partial lines deferred', () => {
  const tp = join(dir, 'transcript.jsonl');
  writeFileSync(tp, usageLine(NOW - 300, 5000) + '\n' + usageLine(NOW - 200, 7000) + '\n');
  sampleFlow(tp, 'f1', NOW);
  assert.equal(readFileSync(join(dir, 'flow.jsonl'), 'utf8').trim().split('\n').length, 2);

  appendFileSync(tp, usageLine(NOW - 100, 3000) + '\n' + '{"partial');
  sampleFlow(tp, 'f1', NOW);
  const lines = readFileSync(join(dir, 'flow.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3); // one new sample, no re-reads, partial line ignored
  assert.equal(JSON.parse(lines[2]).out, 3000);
});

test('flowStats: recent flow and idle detection', () => {
  const stats = flowStats(NOW);
  assert.equal(stats.out_10m, 15000); // 5000 + 7000 + 3000, all within the last 10min
  assert.equal(stats.idle, false);
  const later = flowStats(NOW + 30 * 60); // half an hour of silence
  assert.equal(later.idle, true);
});

test('sessionFlowStats: combined rate, active count, anomaly + isMine', () => {
  const write = (rows) => writeFileSync(join(dir, 'flow.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // s1 hot (60k out → 6000/min), s2 cool (6k → 600/min), all in the last 10min
  write([
    { t: NOW - 300, out: 30000, s: 's1' },
    { t: NOW - 100, out: 30000, s: 's1' },
    { t: NOW - 200, out: 6000, s: 's2' },
  ]);
  const sf = sessionFlowStats(NOW);
  assert.equal(sf.burning, 2);
  assert.equal(sf.combinedPerMin, 6600); // (60000 + 6000) / 10
  assert.equal(sf.anomaly.ratio, 10); // 6000 vs median-of-others 600
  assert.equal(sf.anomaly.isMine, false);
  assert.equal(sessionFlowStats(NOW, 's1').anomaly.isMine, true); // it's me
  // `mine` (burn-efficiency signal, tokenroom enhancement): the CALLER's own rate,
  // independent of anomaly status — no caller session → null.
  assert.equal(sf.mine, null);
  assert.deepEqual(sessionFlowStats(NOW, 's1').mine, { id: 's1', perMin: 6000 });
  assert.deepEqual(sessionFlowStats(NOW, 's2').mine, { id: 's2', perMin: 600 });
  assert.equal(sessionFlowStats(NOW, 'nonexistent-session').mine, null);

  // balanced burners → no anomaly
  write([
    { t: NOW - 100, out: 10000, s: 'a' },
    { t: NOW - 100, out: 9000, s: 'b' },
  ]);
  assert.equal(sessionFlowStats(NOW).anomaly, null);

  // restore the shared flow log so later tests' expectations hold
  write([
    { t: NOW - 300, out: 5000, s: 'f1' },
    { t: NOW - 200, out: 7000, s: 'f1' },
    { t: NOW - 100, out: 3000, s: 'f1' },
  ]);
});

test('calibrate: learns tokens-per-percent from a %-step, re-anchors on reset', () => {
  assert.equal(calibrate(50, NOW - 400), null); // first sight: anchor only
  // the 15000 out-tokens in flow.jsonl all happened after NOW-400
  const cal = calibrate(53, NOW); // +3 points
  assert.equal(cal.tokens_per_pct, 5000); // 15000 / 3
  // window reset (big drop) re-anchors without a bogus sample
  const afterReset = calibrate(2, NOW + 10);
  assert.equal(afterReset.tokens_per_pct, 5000); // estimate retained, no new sample
});

test('enrichBurn: tokens-left estimate, exhaustion band, idle suppression', () => {
  const state = (exh) => ({
    windows: { five_hour: { used_pct: 53, resets_at: NOW + 7200 } },
    burn: { pct_per_hour: 9, projected_exhaustion: exh },
  });
  const s = enrichBurn(state(NOW + 3600), NOW);
  assert.equal(s.burn.est_tokens_left, 235000); // (100-53) × 5000
  assert.ok(Array.isArray(s.burn.exhaustion_band));
  assert.ok(s.burn.exhaustion_band[0] <= s.burn.exhaustion_band[1]);

  // idle: flow went quiet → the projection's premise is false → suppressed
  const idle = enrichBurn(state(NOW + 3600), NOW + 30 * 60);
  assert.equal(idle.burn.projected_exhaustion, null);
  assert.equal(idle.burn.exhaustion_band, null);
});
