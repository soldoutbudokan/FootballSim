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

test('a deep ball goes away from the man on the receiver, the miss folded the same way', () => {
  // Verts against man: every deep receiver has a defender on him. The catch
  // point moves square to the throw or back toward the quarterback (never
  // beyond the receiver), the ball comes in at the far shoulder, a miss
  // toward the defender folds back, and a lob drops in high.
  let placed = 0, full = 0;
  for (let seed = 1; seed <= 12; seed++) for (const id of ['X', 'B']) for (const style of ['touch', 'lob']) {
    const s = new Simulation(seed, { offense: 'verts', coverage: 'man', difficulty: 'pro', mode: 'reps', stunt: 'none' });
    s.snap();
    run(s, 2.0);
    if (s.phase !== 'live' || !s.requestThrow(id, style)) continue;
    const qb = { x: s.byId.QB.x, z: s.byId.QB.z };
    for (let i = 0; i < 60 && s.phase === 'live'; i++) s.step(STEP);
    const pass = s.pass;
    if (!pass || pass.distance < 25) continue;
    assert.equal(pass.target.y, style === 'lob' ? 1.8 : 1.65, 'catch height by style');
    const { ux, uz, k } = pass.place;
    if (k < 0.5) continue;
    placed++;
    const dx = pass.target.x - qb.x, dz = pass.target.z - qb.z, len = Math.hypot(dx, dz);
    assert.ok((ux * dx + uz * dz) / len < 0.2, `${seed} ${id} ${style}: never beyond the receiver`);
    // The flight ends at the far shoulder: `hands` off the catch point that way.
    const b = s.ball, t = pass.duration - pass.elapsed, end = { x: b.x + b.vx * t, z: b.z + b.vz * t };
    const off = (end.x - pass.target.x) * ux + (end.z - pass.target.z) * uz;
    assert.ok(off > 0.3 * k && Math.hypot(end.x - pass.target.x, end.z - pass.target.z) < 0.5, `${seed} ${id} ${style}: the ball comes in ${off.toFixed(2)} yd to his far side`);
    if (k > 0.999) { full++; assert.ok(pass.error.x * ux + pass.error.z * uz > -1e-9, `${seed} ${id} ${style}: the miss leans away from the defender`); }
  }
  assert.ok(placed >= 12 && full >= 6, `placed ${placed}, fully ${full}`);
});

// Throw to `id` at `at` s with `lead`; the pass, the receiver's run at the
// release and whether he caught it, and where.
function led(seed, offense, id, at, lead) {
  const s = rep(seed, offense);
  s.snap();
  run(s, at);
  const p = s.byId[id];
  if (s.phase !== 'live' || !s.requestThrow(id, 'touch', lead)) return null;
  for (let i = 0; i < 28 && s.phase === 'live'; i++) s.step(STEP);
  if (s.phase !== 'air') return null;
  const speed = Math.hypot(p.vx, p.vz), run0 = { x: p.vx / speed, z: p.vz / speed, speed }, pass = s.pass;
  while (s.phase === 'air') s.step(STEP);
  return { run: run0, pass, caught: s.completed && s.carrier === id, at: { x: p.x, z: p.z } };
}

test('a led ball goes in front of the receiver along his run, or behind him, and he still gets to it', () => {
  // The same throw three ways: no lead, up (in front of him along his run)
  // and down (behind him, the back shoulder). The lead is as long as he can
  // reach: more on a long throw than on a quick slant.
  const along = (r, u) => r.pass.lead.x * u.x + r.pass.lead.z * u.z;
  const size = { verts: [], slants: [] }, gain = [];
  let n = 0, plainCaught = 0, upCaught = 0;
  for (let seed = 1; seed <= 5; seed++) for (const [offense, id, at] of [['verts', 'X', 1.2], ['verts', 'B', 1.2], ['slants', 'X', 0.9], ['slants', 'B', 0.9], ['drive', 'Y', 1.3]]) {
    const plain = led(seed, offense, id, at, { x: 0, z: 0 }), up = led(seed, offense, id, at, { x: 0, z: 1 }), down = led(seed, offense, id, at, { x: 0, z: -1 });
    if (!plain || !up || !down || plain.run.speed < 6) continue;
    n++;
    const u = plain.run;
    assert.equal(Math.hypot(plain.pass.lead.x, plain.pass.lead.z), 0);
    assert.ok(along(up, u) > 0.2, `${seed} ${offense} ${id}: up leads him ${along(up, u).toFixed(2)} yd along his run`);
    assert.ok(along(down, u) < -0.5, `${seed} ${offense} ${id}: down puts it ${along(down, u).toFixed(2)} yd behind him`);
    if (size[offense]) size[offense].push(along(up, u));
    plainCaught += plain.caught; upCaught += up.caught;
    if (plain.caught && up.caught) gain.push((up.at.x - plain.at.x) * u.x + (up.at.z - plain.at.z) * u.z);
  }
  assert.ok(n >= 20, 'throws ' + n);
  // He runs onto it: caught as often, farther along his run.
  assert.ok(upCaught >= plainCaught - 1 && upCaught >= 0.6 * n, `caught ${upCaught} led, ${plainCaught} not, of ${n}`);
  assert.ok(gain.length >= 10 && mean(gain) > 0.15, `caught ${mean(gain).toFixed(2)} yd farther along his run`);
  assert.ok(mean(size.verts) > mean(size.slants) + 0.15, `a longer lead on a go (${mean(size.verts).toFixed(2)} yd) than on a quick slant (${mean(size.slants).toFixed(2)} yd)`);
});

test('left and right lead toward that sideline, never out of bounds', () => {
  // Verts: X runs up the left side, B up the right.
  let n = 0, inside = 0;
  for (let seed = 1; seed <= 4; seed++) for (const id of ['X', 'B']) for (const x of [-1, 1]) {
    const r = led(seed, 'verts', id, 1.2, { x, z: 0 });
    if (!r) continue;
    n++;
    const { lead, place } = r.pass, spot = r.pass.target.x - r.pass.error.x - place.ux * place.k;
    assert.ok(lead.x * x > 0 && Math.abs(lead.z) < Math.abs(lead.x), `${seed} ${id} ${x}: lead ${lead.x.toFixed(2)}, ${lead.z.toFixed(2)}`);
    assert.ok(Math.abs(spot) < 26.67 - 0.9, `${seed} ${id} ${x}: in bounds at ${spot.toFixed(2)}`);
    if (Math.sign(spot) !== x) inside += Math.abs(lead.x) > 0.5;
  }
  assert.ok(n >= 12 && inside >= n / 2 - 2, `throws ${n}, led inside ${inside}`);
});
