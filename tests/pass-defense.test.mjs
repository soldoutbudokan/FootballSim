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
  for (const coverage of ['man', 'blitz']) {
    const s = new Simulation(8, { offense: 'mesh', coverage });
    const defender = coverage === 'man' ? 'LB1' : 'LB3';
    const before = s.byId[defender].x - s.byId.Y.x;
    s.audible('stick');
    assert.equal(s.coverage, coverage);
    assert.ok(Math.abs((s.byId[defender].x - s.byId.Y.x) - before) < 0.01);
  }
});
