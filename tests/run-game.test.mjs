// The run game (dist/js/sim/run.js): every run block is a matchup with its
// own life, double teams climb, the lane opens on some reps and not others,
// and the defense's difficulty is in its run fits, not in its bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP } from '../dist/js/sim.js';
import { DIFFICULTY } from '../dist/js/sim/defense.js';

const rep = (seed, offense = 'zone', options = {}) => new Simulation(seed, { offense, coverage: 'cover3', difficulty: 'pro', mode: 'reps', ...options });
const steps = (s, seconds, input = () => ({})) => { for (let i = 0; i < Math.round(seconds / STEP) && s.phase !== 'dead'; i++) s.step(STEP, input(s)); };
const quantile = (a, p) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(p * (v.length - 1))]; };
// The ball carrier runs at the play's hole, then straight upfield.
const hole = s => {
  const side = Math.sign(s.play.lane) * s.playSide(), r = s.byId.R;
  return s.handoff ? { x: r.z < s.spot ? clamp(side * Math.abs(s.play.lane) - r.x, -1, 1) * 0.6 : 0, z: 1, sprint: true } : {};
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Every block of a rep: when it formed and ended, its margin, its blockers.
function blocks(s, seconds, input = hole) {
  const seen = new Map();
  for (let i = 0; i < Math.round(seconds / STEP) && s.phase !== 'dead'; i++) {
    s.step(STEP, input(s));
    const st = s.runGame;
    if (!st) continue;
    for (const [id, b] of st.blocks) {
      const k = id + '@' + b.at.toFixed(3), e = seen.get(k) || { id, at: b.at, end: null, margin: s.blockMargin(st, b), most: b.blockers.length };
      e.most = Math.max(e.most, b.blockers.length); e.last = s.time;
      seen.set(k, e);
    }
  }
  return [...seen.values()].map(e => ({ ...e, life: e.last - e.at }));
}

test('run blocks differ: margins and lives vary across reps and matchups', () => {
  const all = [];
  for (let seed = 1; seed <= 16; seed++) {
    const s = rep(seed, seed % 2 ? 'zone' : 'power'); s.snap();
    all.push(...blocks(s, 3).filter(b => s.byId[b.id].role === 'dl'));
  }
  const margins = all.map(b => b.margin), lives = all.map(b => b.life);
  assert.ok(all.length >= 40, 'blocks ' + all.length);
  assert.ok(Math.min(...margins) < -0.6 && Math.max(...margins) > 0.9, `margins ${Math.min(...margins).toFixed(2)} to ${Math.max(...margins).toFixed(2)}`);
  assert.ok(quantile(lives, 0.1) < 0.6 && quantile(lives, 0.9) > 1.3, `lives 10% ${quantile(lives, 0.1).toFixed(2)} s, 90% ${quantile(lives, 0.9).toFixed(2)} s`);
  // The same seed plays the same blocks.
  const again = rep(1, 'zone'); again.snap();
  const first = rep(1, 'zone'); first.snap();
  assert.deepEqual(blocks(again, 2).map(b => [b.id, b.at, b.life]), blocks(first, 2).map(b => [b.id, b.at, b.life]));
});

test('inside zone doubles a lineman and the second man climbs to a linebacker; the double team is the stronger block', () => {
  let combos = 0, climbed = 0, stronger = 0;
  const adds = [];
  for (let seed = 1; seed <= 12; seed++) {
    const s = rep(seed, 'zone'); s.snap();
    steps(s, 0.1);
    const mates = s.line.filter(o => o.combo && o.climbTo);
    if (!mates.length) continue;
    combos++;
    const o = mates[0], lb = o.climbTo;
    let doubled = null;
    for (let i = 0; i < 180 && s.phase !== 'dead'; i++) {
      s.step(STEP, hole(s));
      const b = s.runGame.blocks.get(o.combo || '');
      if (b && b.blockers.length === 2 && doubled === null) {
        const single = { ...b, blockers: b.blockers.slice(0, 1) };
        doubled = s.blockMargin(s.runGame, b) - s.blockMargin(s.runGame, single);
      }
      if (o.runMan === lb) { climbed++; break; }
    }
    if (doubled !== null) { adds.push(doubled); if (doubled > 0.2) stronger++; }
  }
  assert.ok(combos >= 8, 'reps with a double team ' + combos);
  assert.ok(climbed >= combos - 2, `climbed in ${climbed}/${combos}`);
  assert.ok(adds.length >= combos * 0.6 && stronger === adds.length && adds.reduce((a, b) => a + b, 0) / adds.length > 0.7, `the double team adds to the margin in ${stronger}/${adds.length} (${combos} planned): ${adds.map(v => v.toFixed(2)).join(" ")}`);
});

test('the man the runner comes at sheds first; a sealed man he runs past stays on his block', () => {
  let at = 0, sealed = 0, n = 0;
  for (let seed = 1; seed <= 14; seed++) {
    const make = () => { const s = rep(seed, 'zone'); s.snap(); steps(s, 1, hole); return s; };
    const a = make(), d0 = a.defense.find(q => q.role === 'dl' && a.runGame.blocks.get(q.id)?.blockers.length === 1);
    if (!d0 || a.phase !== 'run') continue;
    n++;
    // At him: from 2 yd in front of his blocker, at full speed.
    {
      const d = a.byId[d0.id], o = a.byId[a.runGame.blocks.get(d.id).blockers[0]], r = a.byId.R;
      const u = { x: (o.x - d.x) / Math.hypot(o.x - d.x, o.z - d.z), z: (o.z - d.z) / Math.hypot(o.x - d.x, o.z - d.z) };
      r.x = d.x + u.x * 2.2 + 0.6; r.z = d.z + u.z * 2.2; r.vx = (d.x - r.x) * 2.5; r.vz = (d.z - r.z) * 2.5;
      let off = false;
      for (let i = 0; i < 60 && !off; i++) { a.step(STEP, { x: d.x - r.x, z: d.z - r.z, sprint: true }); off = !a.runGame.blocks.has(d.id); }
      if (off) at++;
    }
    // Past him: on the far side of his blocker, running along the line.
    {
      const b = make(), d = b.byId[d0.id], blk = b.runGame.blocks.get(d.id);
      if (!blk) continue;
      const o = b.byId[blk.blockers[0]], r = b.byId.R, ux = (o.x - d.x) / Math.hypot(o.x - d.x, o.z - d.z), uz = (o.z - d.z) / Math.hypot(o.x - d.x, o.z - d.z);
      r.x = o.x + ux * 0.9 - 1.5; r.z = o.z + uz * 0.9; r.vx = 6; r.vz = 0;
      let off = false;
      for (let i = 0; i < 42 && !off; i++) { b.step(STEP, { x: 1, z: 0, sprint: true }); off = !b.runGame.blocks.has(d.id); }
      if (!off) sealed++;
    }
  }
  assert.ok(n >= 8, 'reps ' + n);
  assert.ok(at >= n * 0.55 && at > n - sealed + 2, `ran at: shed within 0.5 s in ${at}/${n}; ran past a seal: shed within 0.35 s in ${n - sealed}/${n}`);
});

test('the lane opens on some reps and closes at once on others', () => {
  // As the back reaches the line: the room to the nearest defender in front
  // of him who is not blocked (nor on the ground).
  const room = [], yards = [];
  for (let seed = 1; seed <= 40; seed++) {
    const s = rep(seed, ['zone', 'power', 'stretch', 'counter'][seed % 4], { coverage: 'random' }), r = s.byId.R;
    s.snap();
    let at = null;
    for (let i = 0; i < 1440 && s.phase !== 'dead'; i++) {
      s.step(STEP, hole(s));
      if (at === null && s.handoff && r.z > s.spot - 1) {
        const free = s.defense.filter(d => !d.engaged && d.action !== 'stumble' && d.z > r.z - 0.5);
        at = Math.min(...free.map(d => Math.hypot(d.x - r.x, d.z - r.z)));
      }
    }
    room.push(at ?? 0); yards.push(s.result?.yards ?? 0);
  }
  const shut = room.filter(v => v < 1.5).length, wide = room.filter(v => v > 4).length;
  assert.ok(shut >= 4 && wide >= 4, `room at the line: under 1.5 yd on ${shut}/40, over 4 yd on ${wide}/40 (${room.map(v => v.toFixed(1)).join(' ')})`);
  assert.ok(yards.filter(y => y <= 0).length >= 3 && Math.max(...yards) >= 6, `yards ${yards.join(' ')}`);
});

test('run fits: All-pro owns every gap and rarely busts; a Rookie defense busts more and leaves the back side', () => {
  const count = difficulty => {
    let busts = 0, men = 0, home = 0, back = 0, owned = 0, reps = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = rep(seed, 'zone', { difficulty, coverage: 'random' });
      for (const d of s.defense) { if (d.role === 'cb') continue; men++; if (d.runBust) busts++; back++; if (d.runHome) home++; }
      s.snap(); steps(s, 0.6);
      s.fitOf(s.defense[0]);
      const gaps = new Set([...s.runGame.fits.values()].map(f => f.gap));
      reps++; if (gaps.size === 8) owned++;
    }
    return { busts: busts / men, home: home / back, owned: owned / reps };
  };
  const rookie = count('rookie'), allpro = count('allpro');
  assert.ok(allpro.busts < 0.08 && rookie.busts > allpro.busts + 0.1, `busts: Rookie ${rookie.busts.toFixed(2)}, All-pro ${allpro.busts.toFixed(2)}`);
  assert.ok(allpro.home > rookie.home + 0.25, `back side stays home: Rookie ${rookie.home.toFixed(2)}, All-pro ${allpro.home.toFixed(2)}`);
  assert.ok(allpro.owned >= rookie.owned && allpro.owned > 0.8, `every gap owned: Rookie ${rookie.owned.toFixed(2)}, All-pro ${allpro.owned.toFixed(2)}`);
});

test('difficulty never changes a body, and nothing slows the ball carrier by level', () => {
  const body = p => [p.id, p.top, p.a0, p.agility, p.brake, p.mass].join();
  // Pinned to the base package: the coordinator matches personnel more often at higher levels.
  const sims = ['rookie', 'pro', 'allpro'].map(difficulty => rep(3, 'zone', { difficulty, personnel: 'base' }));
  for (const s of sims.slice(1)) assert.deepEqual(s.players.map(body), sims[0].players.map(body));
  // The same back, alone in the open field, runs the same 4 s at every level.
  const runs = sims.map(s => {
    s.snap(); steps(s, 0.8, () => ({ z: 1 }));
    for (const d of s.defense) { d.x = d.x < 0 ? -26 : 26; d.z = s.spot + 60; d.vx = d.vz = 0; }
    steps(s, 4, () => ({ z: 1, x: 0.1, sprint: true }));
    const r = s.byId.R;
    return [r.x.toFixed(6), r.z.toFixed(6), r.stamina.toFixed(6)].join();
  });
  assert.equal(runs[1], runs[0]); assert.equal(runs[2], runs[0]);
  // The run-fit and run-block knobs are reads and calls, listed per level.
  for (const k of ['runRead', 'bust', 'home', 'fill', 'blockRead']) for (const level of Object.values(DIFFICULTY)) assert.equal(typeof level[k], 'number', k);
});
