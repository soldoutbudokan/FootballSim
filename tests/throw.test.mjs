// The throw (release in dist/js/sim.js): accuracy falls off with the length
// of the throw, a ball put up with air under it (touch, lob) is harder to
// place than a bullet, and short throws stay on the hands. Pressure and
// throwing on the move are covered in offense.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP } from '../dist/js/sim.js';

const rep = (seed, offense) => new Simulation(seed, { offense, coverage: 'cover3', difficulty: 'pro', mode: 'reps', stunt: 'none' });
const run = (s, t) => { while (s.phase === 'live' && s.time < t - 1e-9) s.step(STEP); };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

// Throw to `id` with `style` at `at` s from a set quarterback; the pass as
// released, or null when the rep had ended or he was under pressure.
function throwAt(seed, offense, id, style, at) {
  const s = rep(seed, offense);
  s.snap();
  run(s, at);
  if (s.phase !== 'live' || !s.requestThrow(id, style)) return null;
  for (let i = 0; i < 60 && s.phase === 'live'; i++) s.step(STEP);
  const qb = s.byId.QB;
  return s.pass && s.pass.pressure === 0 && Math.hypot(qb.vx, qb.vz) < 0.5 ? s.pass : null;
}

test('a set throw spreads with its length and its style, and short throws stay crisp', () => {
  const deep = { bullet: [], lob: [] }, misses = [], short = [];
  for (let seed = 1; seed <= 16; seed++) {
    for (const style of ['bullet', 'lob']) {
      const pass = throwAt(seed, 'verts', 'X', style, 2.0);
      if (!pass || pass.distance < 30) continue;
      deep[style].push(pass.spread / pass.distance);
      if (style === 'lob') misses.push(Math.hypot(pass.error.x, pass.error.z));
      assert.ok(Math.abs(pass.error.x) <= pass.spread && Math.abs(pass.error.z) <= pass.spread, `${seed}: the miss stays inside the spread`);
    }
    // Mesh: the tight end's shallow cross, about 12 yd from the quarterback.
    const quick = throwAt(seed, 'mesh', 'A', 'bullet', 1.3);
    if (quick && quick.distance < 14) short.push(quick.spread);
  }
  assert.ok(deep.bullet.length >= 10 && deep.lob.length >= 10 && short.length >= 10, `throws ${deep.bullet.length}, ${deep.lob.length}, ${short.length}`);
  // About 3-4 % of the length for a deep bullet, 5 % or more for a lob.
  const bullet = mean(deep.bullet), lob = mean(deep.lob);
  assert.ok(bullet > 0.025 && bullet < 0.045, `a deep bullet spreads ${(100 * bullet).toFixed(1)} % of its length`);
  assert.ok(lob > 0.045 && lob > 1.3 * bullet, `a deep lob spreads ${(100 * lob).toFixed(1)} %`);
  assert.ok(mean(misses) > 0.35, `a deep lob misses its spot by ${mean(misses).toFixed(2)} yd on average`);
  assert.ok(Math.max(...short) < 0.5, `a shallow cross spreads ${Math.max(...short).toFixed(2)} yd at most`);
});
