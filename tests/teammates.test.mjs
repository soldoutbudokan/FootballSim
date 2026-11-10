// The ten teammates without the ball (dist/js/sim/support.js, sim/run.js):
// the puller's pull, the most dangerous man for a free blocker, receivers
// blocking downfield after a catch, for a quarterback who runs and once the
// ball is in the air to somebody else. The same at every difficulty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP } from '../dist/js/sim.js';
import { meetTime, SUPPORT } from '../dist/js/sim/support.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rep = (seed, offense, options = {}) => new Simulation(seed, { offense, coverage: 'cover3', difficulty: 'pro', mode: 'reps', personnel: 'base', ...options });
const steps = (s, seconds, input = () => ({})) => { for (let i = 0; i < Math.round(seconds / STEP) && s.phase !== 'dead'; i++) s.step(STEP, input(s)); };
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
// The ball carrier runs at the play's hole, then straight upfield.
const hole = s => {
  const side = Math.sign(s.play.lane) * s.playSide(), r = s.byId.R;
  return s.handoff ? { x: r.z < s.spot ? clamp(side * Math.abs(s.play.lane) - r.x, -1, 1) * 0.6 : 0, z: 1, sprint: true } : {};
};
// Everybody on defense out of the play, 45 yd downfield on the sidelines.
const park = s => { for (const d of s.defense) { d.x = d.x < 0 ? -26 : 26; d.z = s.spot + 45; d.vx = d.vz = 0; } };
const put = (p, x, z, vx = 0, vz = 0) => Object.assign(p, { x, z, vx, vz });

test('the pulling guard opens at the snap, is at the hole in time and blocks somebody there', () => {
  let blocked = 0, n = 0;
  for (const play of ['power', 'counter', 'sweep']) for (let seed = 1; seed <= 12; seed++) {
    const s = rep(seed, play, { flip: seed % 2 === 0 }); s.snap();
    const g = s.byId[s.play.pullingGuard], side = Math.sign(s.play.lane) * s.playSide();
    steps(s, 0.45, hole);
    // (He used to stand in his stance for 0.65 s and reach the hole after the back.)
    // Unless a free man was already in his way: then he is on him at once.
    assert.ok(g.pullStage >= 2 || (side * (g.x - g.start.x) > 0.25 && g.z < g.start.z), `${play}/${seed}: pulling by 0.45 s (${(g.x - g.start.x).toFixed(2)} yd across)`);
    let hit = false, done = null;
    for (let i = 0; i < Math.round(3.2 / STEP) && s.phase !== 'dead'; i++) {
      s.step(STEP, hole(s));
      if (g.engaged) hit = true;
      if (done === null && g.pullStage >= 2) done = s.time;
    }
    assert.ok(done !== null || s.phase === 'dead', `${play}/${seed}: the pull ends`);
    if (done !== null) assert.ok(done <= (play === 'sweep' ? 2.61 : 1.9), `${play}/${seed}: at the hole, or on a man, by ${done.toFixed(2)} s`);
    n++; if (hit) blocked++;
  }
  assert.ok(blocked >= n * 0.5, `the puller blocked somebody on ${blocked} of ${n} pulls`);
});

test('meetTime: when a pursuer meets a moving runner, and that some never do', () => {
  assert.ok(Math.abs(meetTime(10, 0, 0, 0, 5) - 2) < 1e-9, 'a standing target 10 yd away at 5 yd/s');
  assert.ok(Math.abs(meetTime(0, 18, 0, -9, 9) - 1) < 1e-9, 'head on, 18 yd apart at 9 yd/s each');
  assert.equal(meetTime(0, 5, 0, 9, 8), Infinity, 'a faster runner going away is never met');
  const t = meetTime(6, 8, 0, 8, 9);   // the runner 6 yd across and 8 yd ahead, running straight on
  assert.ok(t > 1 && t < 10 && Math.abs(Math.hypot(6, 8 + 8 * t) - 9 * t) < 1e-6, 'a chase at an angle: both are at the same spot after ' + t);
});

test('a free blocker takes the most dangerous man he can cut off: not the nearest, not one behind the runner, not one who is not coming', () => {
  const s = rep(3, 'zone'); s.snap(); steps(s, 1.0, hole);
  assert.equal(s.carrier, 'R');
  park(s);
  const r = s.byId.R, o = s.byId.Y, near = s.byId.CB1, danger = s.byId.SS, behind = s.byId.LB1, z0 = s.spot;
  put(r, 0, z0 + 2, 0, 8);
  put(o, -4, z0 + 6);
  put(near, -6, z0 + 7, -2, 1);        // 2.2 yd from the blocker, backing off with his receiver
  put(danger, -7, z0 + 12, 7, -3);     // 6.7 yd from the blocker, running at the runner
  put(behind, 1, z0 - 1.5, 0, 8);      // right behind the runner: a block in the back
  const plan = (taken = new Set()) => { s.supportPlan = null; o.support = null; s.planSupport([o], taken, null, null); return o.support; };
  assert.ok(gap(o, near) < gap(o, danger) - 3, 'the fixture: the dangerous man is not the nearest');
  let pick = plan();
  assert.equal(pick && pick.id, 'SS', 'he takes the man who gets to the runner first');
  // Where: on that man's line to the runner, and reachable before he is.
  const ref = s.supportRef(), th = s.threatOf(danger, ref);
  assert.ok(th.T > 0.3 && th.T < 2, 'the safety meets the runner in ' + th.T);
  const along = ((pick.x - danger.x) * (th.mx - danger.x) + (pick.z - danger.z) * (th.mz - danger.z)) / Math.hypot(th.mx - danger.x, th.mz - danger.z) ** 2;
  assert.ok(along > 0 && along < 1, 'the block point is between the safety and the runner, ' + along);
  // Once that man is somebody else's there is nobody for him: the corner is
  // not coming, and the linebacker is behind the runner.
  pick = plan(new Set(['SS']));
  assert.equal(pick, null, 'nobody else is a threat he may block');
  assert.equal(s.coming(near, ref), false); assert.equal(s.coming(danger, ref), true);
  // The corner turns and runs at the ball: now he is a threat, and in reach.
  put(near, -6, z0 + 7, 6, -2);
  pick = plan(new Set(['SS']));
  assert.equal(pick && pick.id, 'CB1');
  // A man already past the blocker cannot be cut off any more.
  put(danger, 1.2, z0 + 5, 0, -8);
  put(o, -9, z0 + 12);
  assert.equal(s.cutOff(o, s.threatOf(danger, s.supportRef())), null);
});

test('on a run a lineman whose man is gone goes to the most dangerous free man instead of standing or chasing', () => {
  // Over a few seeds: a free lineman (his own man shed, down or out of
  // reach) has a man from the danger rule most of the time there is one.
  let free = 0, working = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const s = rep(seed, seed % 2 ? 'zone' : 'stretch'); s.snap();
    for (let i = 0; i < Math.round(3 / STEP) && s.phase !== 'dead' && s.phase !== 'tackle'; i++) {
      s.step(STEP, hole(s));
      if (s.time < 1 || i % 12) continue;
      for (const o of s.line) {
        if (!o.freed || o.engaged) continue;
        free++;
        if (o.support) {
          working++;
          const d = s.byId[o.support.id], c = s.byId.R;
          assert.equal(d.team, 'defense');
          assert.ok(d.z > c.z - SUPPORT.behind - 0.8, `${seed}: ${o.id} never takes a man behind the runner`);
        }
      }
    }
  }
  assert.ok(free >= 15, 'free linemen were seen: ' + free);
  assert.ok(working > free * 0.2, `a free lineman had a man ${working} of ${free} looks`);
});

// A caught pass, set up by hand: `id` has the ball `depth` yd downfield.
function caught(seed, id = 'X', depth = 10) {
  const s = rep(seed, 'verts'); s.snap(); steps(s, 1.0);
  park(s);
  for (const o of s.offense) if (o.role !== 'ol' && o.id !== 'QB') put(o, o.x < 0 ? -24 : 24, s.spot + 2);
  const c = s.byId[id];
  Object.assign(s, { completed: true, threw: true, carrier: id, selected: id, phase: 'run', catchAt: s.time, possessionAt: s.time - 1, pass: null });
  put(c, 0, s.spot + depth);
  return s;
}

test('after a catch a receiver cuts off the man coming for the runner, however late in the down, and lets him go after 1.3 s', () => {
  const s = caught(5), c = s.byId.X, o = s.byId.Y, d = s.byId.FS, z0 = s.spot;
  put(o, 1.5, z0 + 16);
  put(d, 3, z0 + 26, 0, -8); d.turned = true;
  // His shed clock ran out long ago: blocks used to be impossible from then on.
  d.shed = 0;
  let from = null, until = null, tackled = null;
  for (let i = 0; i < Math.round(4 / STEP) && s.phase !== 'dead'; i++) {
    s.step(STEP, {});
    if (o.engaged === 'FS' && from === null) from = s.time;
    if (from !== null && until === null && o.engaged !== 'FS') until = s.time;
    if (tackled === null && s.phase === 'tackle') tackled = s.time;
  }
  assert.ok(from !== null, 'the receiver got to him and locked on');
  assert.ok(until !== null && until - from > 0.9 && until - from < 1.36, `held ${(until - from).toFixed(2)} s`);
  assert.ok(tackled !== null && tackled > until, 'the safety makes the tackle only once he is let go');
  assert.equal(c.id, s.carrier);
});

test('a receiver with nobody to block gets in front of the ball instead of finishing his route or standing', () => {
  const s = caught(6, 'X', 6), c = s.byId.X, ahead = s.byId.B, back = s.byId.Y, z0 = s.spot;
  // No defender in front of the runner: nobody to block.
  for (const d of s.defense) d.z = z0 - 15;
  put(ahead, 14, z0 + 20, 0, 8);   // still running his vertical, 14 yd across
  put(back, -10, z0 + 1);          // behind the play
  const far0 = gap(ahead, c), behind0 = gap(back, c);
  steps(s, 1.5, () => ({ z: 1, sprint: true }));
  assert.equal(s.phase, 'run');
  assert.ok(ahead.z > c.z && gap(ahead, c) < far0 - 4, `the man ahead closed on the runner: ${far0.toFixed(1)} to ${gap(ahead, c).toFixed(1)} yd`);
  assert.ok(Math.abs(ahead.x - c.x) < 10, 'and came across to his side of the field');
  assert.ok(Math.hypot(back.vx, back.vz) > 3 && back.vz > 2, 'the man behind follows the play');
});

test('receivers block for a quarterback who runs past the line instead of running their routes', () => {
  let helped = 0, n = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const s = rep(seed, 'verts'); s.snap(); steps(s, 1.5);
    const qb = s.byId.QB;
    put(qb, 9, s.spot - 0.5, 0, 6);
    let picks = 0;
    for (let i = 0; i < Math.round(1.2 / STEP) && s.phase !== 'dead' && s.phase !== 'tackle'; i++) {
      s.step(STEP, { z: 1, sprint: true });
      if (s.crossedLine) for (const id of ['X', 'Y', 'A', 'B', 'R']) if (s.byId[id].support || s.byId[id].engaged) picks++;
    }
    if (!s.crossedLine) continue;
    n++; if (picks) helped++;
    // Nobody is still running away from him down the field.
    if (s.phase === 'live') for (const id of ['X', 'Y', 'A', 'B']) {
      const p = s.byId[id];
      if (!p.support && !p.engaged && p.z > qb.z + 8) assert.ok(p.vz < 4, `${seed}: ${id} has turned back to the ball (vz ${p.vz.toFixed(1)})`);
    }
  }
  assert.ok(n >= 6, 'the quarterback got past the line ' + n + ' times');
  assert.ok(helped >= n - 2, `somebody picked up a block for him on ${helped} of ${n} scrambles`);
});

test('with the ball in the air to somebody else the others go to their men, but only once they have seen it and without touching anybody before the catch', () => {
  let went = 0, n = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const s = rep(seed, 'verts'); s.snap(); steps(s, 1.6);
    if (!s.requestThrow('B', 'lob')) continue;
    while (s.phase === 'live') s.step(STEP, {});
    if (s.phase !== 'air') continue;
    n++;
    let picked = false;
    while (s.phase === 'air') {
      s.step(STEP, {});
      if (s.phase !== 'air') break;
      for (const id of ['X', 'Y', 'A', 'R']) {
        const p = s.byId[id];
        if (p.support) {
          picked = true;
          assert.ok(s.pass.elapsed >= SUPPORT.see - 1e-9, `${seed}: ${id} reacts ${s.pass.elapsed.toFixed(2)} s into the flight`);
          assert.ok(!p.engaged, `${seed}: ${id} blocks nobody while the ball is in the air`);
        }
      }
      assert.equal(s.byId.B.support ?? null, null, 'the man the ball is thrown to plays the ball');
    }
    if (picked) went++;
  }
  assert.ok(n >= 6, 'throws: ' + n);
  assert.ok(went >= 2, `a receiver went to a block on ${went} of ${n} throws`);
});
