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
  let checked = 0, close = 0;
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
    // A defender who steps into his path late is contact the ghost cannot
    // foresee either, so a rare miss up to a yard is allowed.
    const off = gap(p, ghost);
    assert.ok(off < 1.0, `${offense}/${coverage}/${seed} ${id}: off by ${off.toFixed(2)} yd`);
    if (off < 0.5) close++;
  }
  assert.ok(checked >= 6, 'conversions checked: ' + checked);
  assert.ok(close >= checked * 0.8, `within half a yard: ${close}/${checked}`);
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

test('a throw on the run toward the receiver is caught most of the time, the run held as a lead too', () => {
  // He rolls out from 0.8 s, sprinting to one side and a little upfield, and
  // throws at 1.7 s to the nearest receiver on that side 8-20 yd away; the
  // same reps from a set base. Holding the run's arrow as he throws (a lead
  // toward that sideline) must not throw the ball away from him.
  const rate = (mode, lead) => {
    let n = 0, caught = 0;
    for (let seed = 1; seed <= 6; seed++) for (const offense of ['slants', 'mesh', 'curlflat', 'stick']) for (const side of [1, -1]) {
      const s = rep(offense, 'cover3', seed), qb = s.byId.QB;
      const input = () => (mode === 'set' || s.time < 0.8 ? {} : { x: side, z: 0.3, sprint: true });
      run(s, 1.7, () => {}, input);
      if (s.phase !== 'live') continue;
      let id = null, best = Infinity;
      for (const r of RECEIVERS) {
        const p = s.byId[r], d = gap(p, qb);
        if ((p.x - qb.x) * side > 1 && p.z > s.spot + 4 && d > 8 && d < 20 && d < best) { best = d; id = r; }
      }
      if (!id || !s.requestThrow(id, 'touch', { x: lead ? side : 0, z: 0 })) continue;
      for (let i = 0; i < 2400 && s.phase !== 'dead' && !s.completed; i++) s.step(STEP, input());
      if (!s.pass) continue;
      n++; caught += s.completed;
    }
    assert.ok(n >= 20, `${mode} throws ${n}`);
    return caught / n;
  };
  const set = rate('set', false), moving = rate('run', false), held = rate('run', true);
  assert.ok(moving >= 0.55 && moving <= set, `on the run ${(100 * moving).toFixed(0)} %, set ${(100 * set).toFixed(0)} %`);
  assert.ok(held >= 0.55, `on the run with the arrow held ${(100 * held).toFixed(0)} %`);
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

test('a throw that comes due past the line is pulled down, and a called run cannot be thrown away', () => {
  // The quarterback steps up at a sprint and asks for the throw a yard
  // short of the line; the stick stays forward through the wind-up.
  let asked = 0, pulled = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const s = rep('mesh', 'cover3', seed), qb = s.byId.QB;
    let pending = false;
    while (s.phase === 'live' && s.time < 4) {
      if (!pending && !s.threw && qb.z > s.spot - 1 && qb.vz > 4) pending = s.requestThrow('A', 'bullet');
      s.step(STEP, { z: 1, sprint: true });
      if (s.phase === 'air') assert.ok(!s.crossedLine && qb.z <= s.spot + 0.3, `${seed}: released from past the line`);
      if (pending && !s.throwIntent && !s.threw && s.phase === 'live') { pulled++; pending = false; assert.equal(qb.action, 'carry'); }
    }
    if (pending || pulled) asked++;
  }
  assert.ok(pulled >= 3, `pulled down ${pulled} of ${asked}`);
  const s = rep('power', 'cover3', 1);
  run(s, 0.32);
  assert.equal(s.handoff, false);
  assert.equal(s.throwAway(), false);
  assert.equal(s.stats.attempts, 0);
});

test('a jam holds a receiver the ball is thrown to', () => {
  // A hard jam on X at the snap holds him to about 1.1 s; a throw to him at
  // 0.3 s must not let him run out of it toward the catch point.
  const top = thrown => {
    const s = new Simulation(3, { offense: 'slants', coverage: 'man', difficulty: 'pro', mode: 'reps' });
    const jam = s.jam.bind(s), x = s.byId.X;
    s.jam = () => false;
    s.snap();
    const random = s.random;
    s.random = () => 0.99;
    jam('X', 'CB1', 0.5);
    s.random = random;
    let most = 0;
    while (s.phase !== 'dead' && s.time < x.jamUntil - 0.05) {
      if (thrown && s.time >= 0.3 && !s.threw && !s.throwIntent) s.requestThrow('X', 'bullet');
      s.step(STEP, {});
      if (s.time > 0.6) most = Math.max(most, speedOf(x));
    }
    assert.ok(x.jamUntil > 1, 'held to ' + x.jamUntil.toFixed(2));
    return { most, threw: s.threw };
  };
  const free = top(false), held = top(true);
  assert.ok(held.threw);
  assert.ok(held.most < free.most + 0.2, `thrown to, ${held.most.toFixed(1)} yd/s in the jam against ${free.most.toFixed(1)}`);
});

test('a quarterback stepping up slides off his own line and off a rusher in a block', () => {
  const s = run(rep('mesh', 'cover3', 1), 0.6), qb = s.byId.QB, c = s.byId.C, d = s.byId.DT1;
  assert.equal(s.carrier, 'QB');
  for (const p of s.players) if (p !== qb) Object.assign(p, { x: p.x + 40 });
  Object.assign(c, { x: 0, z: s.spot - 1 });
  Object.assign(qb, { x: 0.1, z: s.spot - 1.5 });
  s.separate();
  assert.deepEqual([c.x, c.z], [0, s.spot - 1], 'the centre holds his ground');
  assert.ok(gap(qb, c) > 0.51, 'the quarterback is moved off him');
  Object.assign(d, { x: 3, z: s.spot - 2, lock: 'LG' });
  Object.assign(qb, { x: 3.2, z: s.spot - 2.4 });
  s.separate();
  assert.deepEqual([d.x, d.z], [3, s.spot - 2], 'the locked rusher holds his ground');
});

test('a steered play-action quarterback is not faking', () => {
  const ridden = rep('flood', 'cover3', 1);
  run(ridden, 0.3);
  assert.equal(ridden.fakeShown(), true);
  assert.equal(ridden.requestThrow('X'), false, 'no throw while riding the fake');
  const steered = rep('flood', 'cover3', 1);
  run(steered, 0.3, () => {}, () => ({ z: -1 }));
  assert.equal(steered.fakeShown(), false);
  assert.equal(steered.requestThrow('X'), true, 'he made no fake, so he can throw');
});

test('exact ties break by the play side, so a flipped rep mirrors the same seed', () => {
  const pair = (offense, coverage, seed) => [false, true].map(flip => rep(offense, coverage, seed, { flip }));
  // Pursuit leverage and the pull-up fan, also for a man lined up over the ball.
  const [a, b] = pair('power', 'cover3', 2);
  for (const d of a.defense) {
    const e = b.byId[d.id];
    assert.equal(d.leverage, -e.leverage, d.id + ' leverage');
    assert.equal(d.pullUp.fan, -e.pullUp.fan, d.id + ' fan');
  }
  // A play-action quarterback turning to a back straight behind him.
  const [c, f] = pair('boot', 'cover3', 2);
  c.step(STEP, {}); f.step(STEP, {});
  assert.ok(Math.abs(c.byId.QB.facing + f.byId.QB.facing) < 1e-12 && c.byId.QB.facing !== 0, `QB turns ${c.byId.QB.facing.toFixed(3)} / ${f.byId.QB.facing.toFixed(3)}`);
  // A receiver on a go with a defender head-up steps outside on both sides,
  // and a back sitting over the ball slides to mirrored sides.
  const sides = [false, true].map(flip => {
    const s = rep('verts', 'cover3', 2, { flip }), m = flip ? -1 : 1, spot = s.spot, p = s.byId.B, r = s.byId.R;
    run(s, 0.25);
    for (const d of s.defense) Object.assign(d, { x: 0, z: spot + 40, vx: 0, vz: 0 });
    Object.assign(p, { x: 21 * m, z: spot + 10, vx: 0, vz: 8, route: [{ x: 21 * m, z: spot + 30 }], routeIndex: 0, start: { x: 21 * m, z: spot }, avoidId: null, avoidSide: 0 });
    Object.assign(s.byId.CB2, { x: 21 * m, z: spot + 11, action: 'run' });
    const want = s.avoidWant(p, { x: 0, z: 8 }, s.time);
    Object.assign(r, { sitting: true, sitX: 0, sitZ: spot + 3, slideAt: -9, route: [{ x: 0, z: spot + 3 }] });
    s.seenDefense = [{ id: 'LB2', cover: true, x: 0.1 * m, z: spot + 4, vx: 0, vz: 0 }];
    s.slide(r, s.time);
    return { out: Math.sign(want.x) * m, sitX: r.sitX };
  });
  assert.deepEqual(sides.map(q => q.out), [1, 1], 'steps outside');
  assert.equal(sides[0].sitX, -sides[1].sitX);
  assert.notEqual(sides[0].sitX, 0);
});
