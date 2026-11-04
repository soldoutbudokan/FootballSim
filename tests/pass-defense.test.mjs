import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP, seededRandom } from '../dist/js/sim.js';

// Isolate a single, physically reachable pass from the rest of the rep. This
// fixture tests possession rules separately from how coverage earns position.
function opportunity(difficulty = 'pro') {
  const s = new Simulation(7, { offense: 'mesh', coverage: 'cover3', difficulty });
  s.phase = 'air'; s.carrier = null; s.threw = true; s.time = 1;
  for (const p of s.players) { p.x = 20; p.z = 100; p.vx = p.vz = 0; }
  const d = s.byId.FS;
  Object.assign(d, { x: 0, z: 50, facing: Math.PI, ballAware: true });
  s.ball = { x: 0, y: 1.5, z: 49.8, vx: 0, vy: 0, vz: 24 };
  s.pass = { receiver: 'X', target: { x: 0, y: 1.6, z: 50 }, duration: 1, elapsed: 0.5, style: 'touch', distance: 20 };
  return { s, d };
}

test('an unprepared, blocked or stumbling defender does not receive automatic possession', () => {
  for (const status of ['unaware', 'engaged', 'stumble', 'turned away']) {
    const { s, d } = opportunity();
    if (status === 'unaware') d.ballAware = false;
    if (status === 'engaged') d.engaged = 'LT';
    if (status === 'stumble') d.action = 'stumble';
    if (status === 'turned away') d.facing = 0;
    s.random = () => 0; // Even the best hands roll cannot override eligibility.
    s.flyBall(STEP);
    assert.equal(s.phase, 'air', status);
    assert.equal(s.stats.ints, 0, status);
    assert.equal(s.pass.attempted.size, 0, status);
  }
});

test('a defender can intercept, break up, or miss the same reachable pass', () => {
  for (const [roll, result, event] of [[0, 'interception', 'interception'], [0.65, 'incomplete', 'deflection'], [0.999, null, null]]) {
    const { s } = opportunity(); s.random = () => roll; s.flyBall(STEP);
    assert.equal(s.result?.kind || null, result);
    if (event) assert.ok(s.events.includes(event));
    assert.equal(s.stats.ints, result === 'interception' ? 1 : 0);
    assert.notEqual(s.selected, 'FS');
    if (event === 'deflection') assert.equal(s.holder, null);
  }
});

test('a failed ball play is not rerolled during later frames in reach', () => {
  const { s, d } = opportunity();
  s.ball.z = d.z; s.ball.vz = 0;
  let rolls = 0; s.random = () => { rolls++; return 0.999; };
  for (let i = 0; i < 30; i++) s.flyBall(STEP);
  assert.equal(rolls, 1);
  assert.equal(s.pass.attempted.has(d.id), true);
  assert.equal(s.stats.ints, 0);
});

test('the earliest swept contact wins before another player farther along the flight', () => {
  const { s, d } = opportunity();
  Object.assign(s.byId.X, { x: 0, z: 51, facing: 0 });
  d.z = 55;
  s.ball.z = 49; s.ball.vz = 100;
  s.random = () => 0.5;
  s.flyBall(0.08);
  assert.equal(s.carrier, 'X');
  assert.equal(s.stats.completions, 1);
  assert.equal(s.stats.ints, 0);
});

test('a receiver can track a pass over his shoulder while running downfield', () => {
  const { s, d } = opportunity();
  d.x = 20;
  Object.assign(s.byId.X, { x: 0, z: 50, facing: 0, vz: 8 });
  s.random = () => 0.5; s.flyBall(STEP);
  assert.equal(s.carrier, 'X');
  assert.equal(s.phase, 'run');
});

test('harder difficulty improves reads without increasing physical speed or hands', () => {
  const outcomes = [], reads = [], bodies = [];
  for (const difficulty of ['rookie', 'pro', 'allpro']) {
    const { s, d } = opportunity(difficulty);
    bodies.push(s.defense.map(p => [p.id, p.top, p.a0, p.agility, p.brake]));
    d.ballAware = false;
    let elapsed = 0;
    while (!d.ballAware && elapsed < 1) { s.readPass(d, STEP); elapsed += STEP; }
    reads.push(elapsed);
    const random = seededRandom(723);
    const counts = { pick: 0, breakup: 0, miss: 0 };
    for (let n = 0; n < 240; n++) {
      const { s: rep } = opportunity(difficulty); rep.random = random; rep.flyBall(STEP);
      counts[rep.stats.ints ? 'pick' : rep.result ? 'breakup' : 'miss']++;
    }
    outcomes.push(counts);
  }
  assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(bodies[1], bodies[2]);
  assert.ok(reads[0] > reads[1] && reads[1] > reads[2]);
  assert.deepEqual(outcomes[0], outcomes[1]); assert.deepEqual(outcomes[1], outcomes[2]);
  assert.ok(outcomes[0].pick > 0 && outcomes[0].breakup > 0 && outcomes[0].pick < 240 * 0.7 && outcomes[0].miss > 0);
});

test('the defense estimates the visible flight without reading the chosen pass target', () => {
  const { s, d } = opportunity();
  const first = s.readFlight(d);
  s.pass.target = { x: 200, y: 30, z: 400 };
  assert.deepEqual(s.readFlight(d), first);
});

test('changing to a trips formation moves man assignments without changing their coverage', () => {
  // Whoever has a receiver in man lines up over him (unless he shows a deep
  // shell), before and after the offense changes formation; the family and
  // the look stay.
  const covered = s => {
    const men = s.defense.filter(d => d.assign?.kind === 'man');
    for (const d of men) {
      const r = s.byId[d.assign.id];
      if (r.z > s.spot - 3 && d.z < s.spot + 8) assert.ok(Math.abs(d.x - r.x) < 3, `${s.coverage}: ${d.id} lines up over ${r.id} (${d.x.toFixed(1)} vs ${r.x.toFixed(1)})`);
    }
    return new Set(men.map(d => d.assign.id));
  };
  for (const coverage of ['man', 'blitz', 'cover1']) for (const seed of [8, 9, 10]) {
    const s = new Simulation(seed, { offense: 'mesh', coverage });
    const shell = s.call.shell, before = covered(s), y = s.defense.find(d => d.assign?.id === 'Y');
    s.audible('stick');
    assert.equal(s.coverage, coverage);
    assert.equal(s.call.shell, shell);
    assert.deepEqual(covered(s), before, 'every receiver still has his man');
    // Y moved from the left slot to the trips side: his man moved with him
    // (unless he shows a deep shell and comes down at the snap).
    const after = s.defense.find(d => d.assign?.id === 'Y');
    if (after.z < s.spot + 8 && y.z < s.spot + 8) assert.ok(Math.sign(after.x) === Math.sign(s.byId.Y.x) && Math.sign(y.x) !== Math.sign(after.x), `${coverage}/${seed}: Y's man follows him across`);
  }
});

// A throw in flight from the quarterback at (0, 35) to (0, 55), as the
// defense would read it, with nobody else near it.
function flight(difficulty = 'allpro') {
  const s = new Simulation(7, { offense: 'mesh', coverage: 'cover3', difficulty });
  s.snap();
  s.phase = 'air'; s.carrier = null; s.threw = true; s.time = 2;
  for (const p of s.players) { p.x = -25; p.z = 20; p.vx = p.vz = 0; }
  s.ball = { x: 0, y: 1.9, z: 36, vx: 0, vy: 2.5, vz: 20 };
  s.pass = { receiver: 'X', target: { x: 0, y: 1.6, z: 56 }, duration: 1, elapsed: 0.05, style: 'touch', distance: 20 };
  return s;
}

test('a zone defender running deep still sees the throw over his shoulder; a man defender with his back turned does not', () => {
  for (const [kind, sees] of [['deep', true], ['man', false]]) {
    const s = flight(), d = s.byId.FS;
    Object.assign(d, { x: 3, z: 52, facing: 0.9, turned: true, assign: kind === 'man' ? { kind: 'man', id: 'Y' } : { kind: 'deep', x: 0, depth: 26, lo: -12, hi: 12 } });
    for (let i = 0; i < 60; i++) s.readPass(d, STEP);
    assert.equal(d.ballAware, sees, kind);
  }
});

test('breaking on the ball: a man near the flight gets to it ahead of the catch, a far one rallies, one out of range stays in coverage', () => {
  const s = flight(), d = s.byId.FS;
  // Beside the line of the ball, short of where it comes down: he goes to a
  // point on its line before the catch point, not to the catch point.
  Object.assign(d, { x: 2, z: 52, vx: 0, vz: 0 });
  const want = s.breakOnBall(d, s.readFlight(d));
  assert.ok(want && want.x < 0, 'drives across to the ball');
  // Too far to get there with the ball: he still runs to where it is caught.
  Object.assign(d, { x: 18, z: 56 });
  const rally = s.breakOnBall(d, s.readFlight(d));
  assert.ok(rally && rally.x < 0 && Math.hypot(rally.x, rally.z) > 0.9 * d.top, 'rallies at full speed');
  // Forty yards away the throw is not his.
  Object.assign(d, { x: -26, z: 90 });
  assert.equal(s.breakOnBall(d, s.readFlight(d)), null);
});

test('a defender misreads a flipped pass as the mirror image', () => {
  const [plain, flipped] = [false, true].map(flip => {
    const s = new Simulation(7, { offense: 'mesh', coverage: 'cover3', difficulty: 'rookie', flip });
    s.phase = 'air'; s.carrier = null; s.threw = true; s.time = 1;
    s.ball = { x: (flip ? -1 : 1) * 4, y: 2.2, z: 50, vx: (flip ? -1 : 1) * 3, vy: 4, vz: 18 };
    s.pass = { receiver: 'X', target: { x: 0, y: 1.6, z: 70 }, duration: 1, elapsed: 0.2, style: 'touch', distance: 20 };
    return s;
  });
  for (const id of ['CB1', 'CB2', 'FS', 'SS', 'LB2']) {
    const a = plain.readFlight(plain.byId[id]), b = flipped.readFlight(flipped.byId[id]);
    assert.ok(Math.abs(a.target.x + b.target.x) < 1e-9 && Math.abs(a.target.z - b.target.z) < 1e-9, `${id}: ${a.target.x.toFixed(2)} vs ${b.target.x.toFixed(2)}`);
  }
});

// A ball arriving at X, with CB1 placed by `setup` around him.
function window(setup, random) {
  const { s, d } = opportunity();
  d.x = 20;
  const x = s.byId.X, cb = s.byId.CB1;
  Object.assign(x, { x: 0, z: 50, facing: Math.PI, vx: 0, vz: 0 });
  Object.assign(cb, { facing: Math.PI, ballAware: true });
  setup(cb);
  s.random = random;
  s.ball.z = 48.5;
  for (let i = 0; i < 20 && s.phase === 'air'; i++) s.flyBall(STEP);
  return s;
}

test('a ball thrown into a defender\'s path or into a tight window is picked some of the time, never every time', () => {
  const random = seededRandom(91);
  const tally = (setup, n = 400) => {
    const counts = { pick: 0, breakup: 0, catch: 0 };
    for (let i = 0; i < n; i++) {
      const s = window(setup, random);
      counts[s.stats.ints ? 'pick' : s.completed ? 'catch' : 'breakup']++;
    }
    return counts;
  };
  // In the path: a corner a yard in front of the receiver, on the ball's line.
  const path = tally(cb => Object.assign(cb, { x: 0.2, z: 49.4 }));
  assert.ok(path.pick > 400 * 0.1 && path.pick < 400 * 0.5, `in the path: ${JSON.stringify(path)}`);
  // A tight window: a corner beside the receiver, out of the ball's line but
  // close enough to get a hand in at the catch. In front (between him and
  // the ball) he picks it more often than trailing.
  const front = tally(cb => Object.assign(cb, { x: 0.9, z: 49.6 }));
  const trail = tally(cb => Object.assign(cb, { x: 0.9, z: 50.4 }));
  assert.ok(front.pick > 0 && front.pick < front.breakup && front.catch > front.pick, `in front: ${JSON.stringify(front)}`);
  assert.ok(trail.pick > 0 && trail.pick < front.pick, `trailing: ${JSON.stringify(trail)}`);
  // He cannot catch a ball he has not seen, though he can knock it loose.
  const blind = tally(cb => Object.assign(cb, { x: 0.9, z: 49.6, ballAware: false }));
  const away = tally(cb => Object.assign(cb, { x: 0.9, z: 49.6, facing: 0 }));
  for (const [name, c] of [['unaware', blind], ['facing away', away]]) assert.ok(c.pick === 0 && c.breakup > 0, `${name}: ${JSON.stringify(c)}`);
});
