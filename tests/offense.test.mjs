import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP } from '../dist/js/sim.js';
import { PLAYS, RECEIVERS } from '../dist/js/plays.js';

// The offense against the defense: receivers who read the coverage, the
// quarterback's drop and throw, and the scramble drill.
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const speedOf = p => Math.hypot(p.vx, p.vz);
function rep(offense, coverage, seed = 1, options = {}) {
  const s = new Simulation(seed, { offense, coverage, difficulty: 'pro', mode: 'reps', ...options });
  s.snap();
  return s;
}
// Step until `until` s (or the rep leaves `phase`), calling `each` after every step.
function run(s, until, each = () => {}, input = () => ({})) {
  while (s.time < until - 1e-9 && s.phase === 'live') { s.step(STEP, input(s)); each(s); }
  return s;
}

test('a curl settles against zone and keeps moving against man', () => {
  // Curl-flat: X and B run 12-yard curls back to 9. Against Cover 3 the deep
  // third corner bails over the top and the curl sits in the hole, facing the
  // quarterback; against man the corner is on him and he keeps running. (A
  // pressed receiver may be jammed, so each rep runs until he decides.)
  const tally = { cover3: { sit: 0, ran: 0 }, man: { sit: 0, ran: 0 } };
  const facingQB = (s, p) => { const to = Math.atan2(s.byId.QB.x - p.x, s.byId.QB.z - p.z); return Math.abs(Math.atan2(Math.sin(p.facing - to), Math.cos(p.facing - to))) < 0.6; };
  for (const coverage of ['cover3', 'man']) for (let seed = 1; seed <= 8; seed++) for (const id of ['X', 'B']) {
    const s = rep('curlflat', coverage, seed), p = s.byId[id];
    while (s.phase === 'live' && !p.mode && s.time < 3.6) s.step(STEP);
    if (s.phase !== 'live' || !p.mode) continue;
    const decided = s.time;
    if (p.mode === 'zone') {
      tally[coverage].sit++;
      assert.ok(p.sitting && gap({ x: p.sitX, z: p.sitZ }, p.route[p.route.length - 1]) < 3, `${coverage}/${seed} ${id} sits near his landmark`);
      run(s, decided + 1.2);
      if (s.phase === 'live') {
        assert.ok(speedOf(p) < 1.5, `${coverage}/${seed} ${id} settles: ${speedOf(p).toFixed(1)} yd/s`);
        assert.ok(facingQB(s, p), `${coverage}/${seed} ${id} shows his numbers`);
      }
    } else {
      tally[coverage].ran++;
      assert.ok(!p.sitting, `${coverage}/${seed} ${id} does not sit against a man on him`);
      run(s, decided + 0.6);
      if (s.phase === 'live') assert.ok(speedOf(p) > 3, `${coverage}/${seed} ${id} keeps running: ${speedOf(p).toFixed(1)} yd/s`);
    }
  }
  const share = c => tally[c].sit / Math.max(1, tally[c].sit + tally[c].ran);
  assert.ok(tally.cover3.sit >= 4, 'curls sit against Cover 3: ' + JSON.stringify(tally));
  assert.ok(tally.man.ran >= 6 && share('man') <= 0.15, 'curls keep running against man: ' + JSON.stringify(tally));
  assert.ok(share('cover3') > share('man') + 0.25, JSON.stringify(tally));
});

test('a seam bends away from a single-high safety into the void beside him', () => {
  // Four verticals with the coverage held in a Cover 3 shell: corners deep
  // outside, the free safety deep, shaded toward one seam or the other.
  const bend = fsX => {
    const s = rep('verts', 'cover3', 1), y = s.byId.Y, original = y.route[y.route.length - 1].x;
    const spots = { LB1: [-8, 5], LB2: [0, 5], LB3: [7, 5], CB1: [-19, 14], CB2: [19, 14], FS: [fsX, 22], SS: [12, 6] };
    const pin = () => { for (const [id, [x, z]] of Object.entries(spots)) Object.assign(s.byId[id], { x, z: s.spot + z, vx: 0, vz: 0 }); };
    pin();
    run(s, 2.2, pin);
    assert.ok(y.converted, 'the seam read the safeties');
    return y.route[y.route.length - 1].x - original;
  };
  const toward = bend(-4), away = bend(4);
  assert.ok(toward < -1, 'the safety shades to his side: he bends outside, ' + toward.toFixed(1));
  assert.ok(away > 1, 'the safety shades away: he bends inside toward the post, ' + away.toFixed(1));
});

test('a jammed receiver is delayed and released, a clean release barely', () => {
  // The coverage module calls jam(); here it is called by hand, with the
  // defense's own jams switched off so the reps differ only by this one.
  // When X gets 8 yd past the line.
  const release = draw => {
    const s = new Simulation(3, { offense: 'verts', coverage: 'man', difficulty: 'pro', mode: 'reps' });
    const jam = s.jam.bind(s);
    s.jam = () => false;
    s.snap();
    if (draw !== null) {
      const random = s.random;
      s.random = () => draw;
      assert.equal(jam('X', 'CB1', 0.5), true);
      s.random = random;
    }
    let at = null;
    run(s, 3, () => { if (at === null && s.byId.X.z - s.spot > 8) at = s.time; });
    return { at, s };
  };
  const free = release(null).at, beaten = release(0.99), clean = release(0.01).at;
  assert.ok(beaten.at - free > 0.3, `held up at the line: 8 yd at ${beaten.at.toFixed(2)} s, ${free.toFixed(2)} s free`);
  assert.ok(clean - free < (beaten.at - free) / 2, `a clean release costs less: ${clean.toFixed(2)} s`);
  assert.ok(beaten.s.phase !== 'live' || speedOf(beaten.s.byId.X) > 7, 'he gets back to speed once he is free');
});

test('predict() follows the live receiver through a route conversion', () => {
  // The ghost the throw aims at runs the same route logic: seams that bend
  // and a post that turns skinny after the prediction. (A rep with body
  // contact, which the ghost cannot foresee, is left out.)
  let checked = 0;
  for (const [offense, coverage, id, from, ahead] of [['verts', 'cover3', 'Y', 1.0, 1.5], ['verts', 'cover3', 'A', 1.0, 1.5], ['verts', 'cover2', 'Y', 1.0, 1.5], ['verts', 'cover2', 'A', 1.0, 1.5], ['mills', 'cover3', 'B', 1.4, 1.5]]) for (let seed = 1; seed <= 6; seed++) {
    const s = run(rep(offense, coverage, seed), from), p = s.byId[id];
    if (s.phase !== 'live' || p.converted || p.mode) continue;
    const before = p.route.slice(), ghost = s.predict(p, ahead), random = s.random();
    // The prediction left the rep exactly as it was.
    assert.deepEqual(p.route, before);
    const twin = run(rep(offense, coverage, seed), from);
    assert.equal(twin.random(), random, 'predict() draws no random numbers');
    // Body contact the ghost cannot foresee (a defender within 0.6 yd of him).
    let contact = false;
    run(s, from + ahead, () => { contact ||= s.defense.some(d => gap(d, p) < 0.6); });
    if (s.phase !== 'live' || !(p.converted || p.mode) || contact) continue;
    checked++;
    assert.ok(gap(p, ghost) < 0.5, `${offense}/${coverage}/${seed} ${id}: off by ${gap(p, ghost).toFixed(2)} yd`);
  }
  assert.ok(checked >= 6, 'conversions checked: ' + checked);
});

test('a throw on the run across the body is less accurate than one from a set base', () => {
  // Quick slants: throw to B (on the right) at 1.4 s, either set, running to
  // the right (toward the throw) or running left (back across his body).
  const spread = input => {
    let total = 0, n = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const s = rep('slants', 'cover2', seed);
      run(s, 1.4, () => {}, () => input);
      if (s.phase !== 'live' || !s.requestThrow('B', 'touch')) continue;
      for (let i = 0; i < 60 && s.phase === 'live'; i++) s.step(STEP, input);
      if (!s.pass?.error) continue;
      total += Math.hypot(s.pass.error.x, s.pass.error.z); n++;
    }
    assert.ok(n >= 20, 'throws ' + n);
    return total / n;
  };
  const set = spread({}), toward = spread({ x: 1 }), across = spread({ x: -1 });
  assert.ok(set < toward && toward < across, `set ${set.toFixed(2)} < toward ${toward.toFixed(2)} < across the body ${across.toFixed(2)} yd`);
  assert.ok(across > 2 * set, 'across the body is much worse');
});

test('the quarterback drops to a depth that fits the formation and the call', () => {
  const depth = s => s.spot - s.byId.QB.z;
  // Shotgun: three steps back to 7 yd; quick game: one step, to 6.
  for (const [offense, want] of [['mesh', 7], ['verts', 7], ['ycross', 7], ['snag', 6], ['spacing', 6]]) {
    const s = run(rep(offense, 'cover2', 2), 1.6);
    assert.ok(Math.abs(depth(s) - want) < 0.35, `${offense}: ${depth(s).toFixed(2)} yd`);
    assert.ok(Math.abs(s.byId.QB.facing) < 0.1, offense + ' faces downfield, set');
  }
  // Under centre: a five-step drop to 7 yd, opened to his throwing side.
  const centre = new Simulation(2, { offense: 'mesh', coverage: 'cover2', difficulty: 'pro', mode: 'reps' });
  centre.play = { ...centre.play, formationId: 'singleback' };
  centre.reset();
  centre.snap();
  run(centre, 0.6);
  assert.ok(centre.byId.QB.facing > 0.6, 'opened up on the drop: ' + centre.byId.QB.facing.toFixed(2));
  run(centre, 1.9);
  assert.ok(Math.abs(depth(centre) - 7) < 0.35, 'under centre: ' + depth(centre).toFixed(2));
  // Play action: he faces the back through the fake, then sets deeper; a
  // throw waits for the fake.
  const pa = rep('flood', 'cover2', 2), qb = pa.byId.QB, r = pa.byId.R;
  run(pa, 0.5);
  assert.ok(Math.abs(Math.atan2(Math.sin(qb.facing - Math.atan2(r.x - qb.x, r.z - qb.z)), Math.cos(qb.facing - Math.atan2(r.x - qb.x, r.z - qb.z)))) < 0.5, 'rides the fake facing the back');
  assert.equal(pa.requestThrow('X'), false);
  run(pa, 2);
  assert.ok(Math.abs(depth(pa) - 7.5) < 0.4, 'sets after the fake: ' + depth(pa).toFixed(2));
  // A boot rolls away from the fake, toward the flood.
  for (const flip of [false, true]) {
    const boot = rep('boot', 'cover3', 2, { flip });
    run(boot, 2.4);
    assert.ok(boot.byId.QB.x * (flip ? -1 : 1) > 5, `${flip ? 'flipped ' : ''}boot rolls out: x ${boot.byId.QB.x.toFixed(1)}`);
  }
  // Once the user has steered him, letting go sets his feet at once.
  const steered = rep('mesh', 'cover2', 2);
  run(steered, 1.35, () => {}, s => (s.time < 1 ? { x: 1 } : {}));
  assert.ok(speedOf(steered.byId.QB) < 0.5, 'stopped and set: ' + speedOf(steered.byId.QB).toFixed(2));
});

test('receivers break off their routes to the quarterback\'s side on a scramble', () => {
  let reps = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const s = rep('mesh', 'cover3', seed), qb = s.byId.QB;
    run(s, 4, () => {}, s => (s.time > 1 ? { x: 1, sprint: true } : {}));
    if (s.drillAt === null) continue;
    reps++;
    // At the start of the drill, and 1.2 s after it.
    const at = s.drillAt, runners = RECEIVERS.filter(id => !s.byId[id].pickup);
    const fresh = rep('mesh', 'cover3', seed);
    run(fresh, at + 0.3, () => {}, s => (s.time > 1 ? { x: 1, sprint: true } : {}));
    const start = Object.fromEntries(runners.map(id => [id, { x: fresh.byId[id].x, z: fresh.byId[id].z }]));
    run(fresh, at + 1.5, () => {}, s => (s.time > 1 ? { x: 1, sprint: true } : {}));
    if (fresh.phase !== 'live') continue;
    for (const id of runners) {
      const p = fresh.byId[id], was = start[id];
      assert.ok(p.x > was.x - 0.5 || p.x > fresh.byId.QB.x + 3, `${seed}: ${id} works to the right, ${was.x.toFixed(1)} -> ${p.x.toFixed(1)}`);
      if (was.z - fresh.spot < 10) assert.ok(p.z - fresh.spot > 1 && p.z - fresh.spot < 9, `${seed}: ${id} stays shallow in front of him`);
      else assert.ok(p.z >= was.z - 1, `${seed}: ${id} stays deep`);
    }
  }
  assert.ok(reps >= 4, 'scrambles ' + reps);
});

test('a ball carrier pushes a defender aside instead of running through him, and nobody tackles through a blocker', () => {
  const s = rep('zone', 'cover3', 2);
  run(s, 0.8, () => {}, () => ({ z: 1 }));
  const c = s.byId[s.carrier], d = s.byId.FS;
  assert.equal(s.phase, 'run');
  // Defender squarely in his path, a step ahead, and it is too early for a tackle try to settle it.
  Object.assign(d, { x: c.x, z: c.z + 0.3, vx: 0, vz: 0, action: 'stumble', actionTime: 0.5 });
  for (let i = 0; i < 12; i++) s.step(STEP, { z: 1 });
  assert.ok(gap(c, d) > 0.5, 'not on top of each other: ' + gap(c, d).toFixed(2));
  // A teammate between a defender and the runner screens him.
  const o = s.byId.LG, q = s.byId.SS;
  Object.assign(q, { x: c.x, z: c.z + 0.9 });
  Object.assign(o, { x: c.x, z: c.z + 0.45 });
  assert.equal(s.screened(q, c), true);
  Object.assign(o, { x: c.x + 2, z: c.z });
  assert.equal(s.screened(q, c), false);
});
