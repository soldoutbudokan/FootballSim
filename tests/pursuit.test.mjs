// Pursuit decisions (dist/js/sim/pursuit.js) and zone eyes (sim/coverage.js):
// coming to balance, the underneath man who comes up for a running
// quarterback and the free zone defender who reads the quarterback's
// shoulders. Bodies and tackle odds are the same at every
// level; the level is how many defenders make the decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP } from '../dist/js/sim.js';
import { DIFFICULTY } from '../dist/js/sim/defense.js';
import { GATHER } from '../dist/js/sim/pursuit.js';

const LEVELS = ['rookie', 'pro', 'allpro'];
const advance = (s, seconds, input = {}) => { for (let i = 0; i < Math.round(seconds / STEP) && s.phase !== 'dead'; i++) s.step(STEP, input); };
const put = (p, x, z, vx = 0, vz = 0) => Object.assign(p, { x, z, vx, vz });
// The back in the open field 2 s into an inside zone, every defender parked
// 45 yd downfield on the sidelines and his teammates out of the way.
function openField(seed = 1, difficulty = 'pro') {
  const s = new Simulation(seed, { offense: 'zone', coverage: 'cover3', difficulty, mode: 'reps', personnel: 'base' });
  s.snap(); advance(s, 0.8, { z: 1 });
  for (const d of s.defense) put(d, d.x < 0 ? -26 : 26, s.spot + 45);
  advance(s, 1.2, { z: 1, sprint: true });
  for (const o of s.offense) if (o.id !== 'R') put(o, o.x < 0 ? -24 : 24, s.spot - 15);
  return s;
}
// The share of defenders, over some reps, who make a per-rep choice.
function share(difficulty, flag) {
  let yes = 0, n = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const s = new Simulation(seed, { offense: 'zone', coverage: 'cover3', difficulty, mode: 'reps', personnel: 'base' });
    for (const d of s.defense) { n++; if (d[flag]) yes++; }
  }
  return yes / n;
}

test('a tackler under control rides out most of a juke; flat out he is beaten by it; without a move it makes no difference', () => {
  const s = openField(2), r = s.byId.R, d = s.byId.LB2;
  d.turned = true;
  const chance = (share, moved) => {
    put(d, r.x, r.z + 0.8, 0, -share * d.top);
    r.lastMoveAt = moved ? s.time : -9;
    return s.tackleChance(d, r);
  };
  const hot = chance(1, true), set = chance(0.5, true), still = chance(0, true);
  assert.ok(hot < 0.56, 'a man running flat out is shaken: ' + hot);
  assert.ok(set > hot + 0.12 && set < 0.8, 'a man under control rides part of it out: ' + set);
  assert.equal(still, set, 'standing or at half speed: both under control');
  assert.ok(Math.abs(s.balance(d) - GATHER.hold) < 1e-9);
  // No move, no difference worth the name: the odds are the body's, at any speed.
  assert.ok(Math.abs(chance(1, false) - chance(0.5, false)) < 0.06);
  // The same at every level: it is the tackler's speed, not his difficulty.
  for (const level of LEVELS) {
    const t = openField(2, level), q = t.byId.R, e = t.byId.LB2;
    e.turned = true; put(e, q.x, q.z + 0.8, 0, -0.5 * e.top); q.lastMoveAt = t.time;
    assert.ok(Math.abs(t.tackleChance(e, q) - set) < 0.03, level + ' ' + t.tackleChance(e, q));
  }
});

test('a pursuer in front of the runner comes to balance just before contact; one chasing him, or a man who never does, runs flat out', () => {
  const s = openField(3), r = s.byId.R, d = s.byId.LB2;
  d.turned = true; d.gathers = true;
  const plan = (dx, dz, vx, vz) => { put(d, r.x + dx, r.z + dz, vx, vz); return s.closing(d, s.perceive('R', d.latency)).gather; };
  assert.equal(plan(0, 3, 0, -8), GATHER.speed, 'head on, 3 yd out');
  assert.equal(plan(0, 9, 0, -8), 0, 'still 9 yd away: he keeps sprinting');
  assert.equal(plan(0.3, -3, 0, 9), 0, 'chasing from behind');
  assert.equal(plan(3, 0.2, -8, 0), 0, 'from the side');
  d.gathers = false;
  assert.equal(plan(0, 3, 0, -8), 0, 'a man who does not gather');
  // In the rep: he arrives slower than his top speed and makes the tackle.
  d.gathers = true; put(d, r.x, r.z + 14, 0, -8);
  let slowest = Infinity, tackled = false;
  s.random = () => 0;
  for (let i = 0; i < 240 && s.phase !== 'dead'; i++) {
    s.step(STEP, { z: 1, sprint: true });
    const g = Math.hypot(d.x - r.x, d.z - r.z);
    if (s.phase === 'run' && g < 2.5) slowest = Math.min(slowest, Math.hypot(d.vx, d.vz) / d.top);
    if (s.phase === 'tackle') { tackled = s.tackle.tackler === 'LB2'; break; }
  }
  assert.ok(tackled, 'he makes the tackle');
  assert.ok(slowest < 0.93, 'he shortened his stride into contact: ' + slowest);
  // Who does it is the difficulty.
  const shares = LEVELS.map(level => share(level, 'gathers'));
  assert.ok(shares[0] < shares[1] - 0.2 && shares[1] < shares[2] - 0.15, 'gather shares ' + shares.map(v => v.toFixed(2)));
  LEVELS.forEach((level, i) => assert.ok(Math.abs(shares[i] - DIFFICULTY[level].gather) < 0.12, `${level}: ${shares[i].toFixed(2)} of defenders gather`));
});

test('an underneath zone defender comes up for a quarterback who runs at the line: at Pro and All-pro before he is over it, at Rookie not', () => {
  const run = difficulty => {
    let came = 0, n = 0, closed = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const s = new Simulation(seed, { offense: 'verts', coverage: 'cover3', difficulty, mode: 'reps', personnel: 'base' });
      s.snap(); advance(s, 1.6);
      if (s.phase !== 'live') continue;
      const qb = s.byId.QB;
      // Out of the pocket, eight yards outside the ball, and off he goes.
      put(qb, s.pocketX() + 8, s.spot - 6, 0, 3);
      let who = null, first = 0;
      for (let i = 0; i < 240 && s.phase === 'live' && !s.crossedLine; i++) {
        s.step(STEP, { z: 1, sprint: true });
        if (!who && s.call.rep.trigger) { who = s.byId[s.call.rep.trigger]; first = Math.hypot(who.x - qb.x, who.z - qb.z); }
      }
      if (s.phase !== 'live') continue;
      n++;
      if (who) {
        came++;
        assert.ok(['under', 'rat'].includes(who.assign.kind), `${difficulty}/${seed}: ${who.id} is an underneath zone man`);
        assert.ok(!who.rushing);
        if (Math.hypot(who.x - qb.x, who.z - qb.z) < first - 1) closed++;
      }
    }
    return { came, n, closed };
  };
  const rookie = run('rookie'), pro = run('pro'), allpro = run('allpro');
  assert.ok(rookie.n >= 5 && allpro.n >= 5, 'scrambles played out');
  assert.equal(rookie.came, 0, 'a Rookie defense waits until he is over the line');
  assert.ok(pro.came >= pro.n - 1, `Pro: somebody came up on ${pro.came} of ${pro.n}`);
  assert.ok(allpro.came >= allpro.n - 1 && allpro.closed >= allpro.came - 1, `All-pro: somebody came up on ${allpro.came} of ${allpro.n} and closed on ${allpro.closed}`);
  assert.ok(DIFFICULTY.rookie.trigger === 0 && DIFFICULTY.pro.trigger < DIFFICULTY.allpro.trigger);
});

test('nobody comes up for a quarterback who is only moving in the pocket or winding up to throw', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const s = new Simulation(seed, { offense: 'verts', coverage: 'cover3', difficulty: 'allpro', mode: 'reps', personnel: 'base' });
    s.snap(); advance(s, 1.4);
    // Climbing the pocket, still 4 yd behind the line.
    for (let i = 0; i < 40 && s.phase === 'live' && s.byId.QB.z < s.spot - 4; i++) s.step(STEP, { z: 1 });
    assert.equal(s.call.rep.trigger ?? null, null, seed + ': stepping up in the pocket');
  }
});

test('a free underneath zone defender breaks on the quarterback\'s shoulders: not at Rookie, half the way at Pro, all the way at All-pro', () => {
  const moved = LEVELS.map(difficulty => {
    const s = new Simulation(4, { offense: 'verts', coverage: 'cover3', difficulty, mode: 'reps', personnel: 'base' });
    s.snap(); advance(s, 1.5);
    const d = s.defense.find(p => p.assign && p.assign.kind === 'under' && !p.rushing), z = s.spot + 8, qb = s.byId.QB;
    assert.equal(s.zoneEyes(d, 0, z), 0, difficulty + ': no throwing motion, no break');
    // The quarterback has been winding up, turned to his right, for longer
    // than anybody's reaction time.
    s.throwIntent = { id: 'B', style: 'bullet', lead: { x: 0, z: 0 }, at: s.time + 9 };
    s.call.rep.windupAt = s.time - 1;
    s.qbFacingSeen = () => 0.5;
    const seen = s.perceive('QB', d.latency), line = seen.x + Math.tan(0.5) * (z - seen.z);
    assert.ok(line > 6, 'his shoulders point more than 6 yd outside the defender: ' + line);
    const x = s.zoneEyes(d, 0, z);
    // Facing back upfield (handing off, looking away) is no read at all.
    s.qbFacingSeen = () => 2.6;
    assert.equal(s.zoneEyes(d, 0, z), 0);
    return x;
  });
  assert.equal(moved[0], 0, 'Rookie holds his landmark');
  assert.ok(Math.abs(moved[1] - 3) < 1e-9, 'Pro breaks half of the 6 yd: ' + moved[1]);
  assert.ok(Math.abs(moved[2] - 6) < 1e-9, 'All-pro breaks all 6 yd: ' + moved[2]);
});
