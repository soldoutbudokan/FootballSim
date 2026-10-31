// Pass protection and the pass rush (dist/js/sim/protection.js): the pocket
// is built around the launch point, not the live quarterback; a scramble
// makes rushers come off their blocks, the end on that side keeps contain;
// blitzers, drop-outs and twists are picked up or get home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP } from '../dist/js/sim.js';

const rep = (seed, options = {}) => new Simulation(seed, { offense: 'mesh', coverage: 'cover3', difficulty: 'pro', mode: 'reps', stunt: 'none', ...options });
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const run = (s, t, input = () => ({})) => { while (s.phase === 'live' && s.time < t - 1e-9) s.step(STEP, input(s)); };
const quantile = (a, p) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(p * (v.length - 1))]; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
// The four linemen rush and nobody else, whatever the coordinator called.
function fourMan(s) {
  for (const d of s.defense) { d.rushing = d.role === 'dl'; if (d.role !== 'dl') d.rush = undefined; }
  return s;
}
const roll = s => (s.time > 1.2 ? { x: 1, z: -0.15 } : {});

test('the line does not slide with a quarterback moving inside the pocket', () => {
  // The same rep twice: once the quarterback slides 3 yd sideways inside the
  // box after he sets, once he stands. Locked pairs end up where they would
  // have been anyway (the old pocket moved them about 2.5 yd with him).
  const shifts = [];
  let slides = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const a = fourMan(rep(seed)), b = fourMan(rep(seed)), qb = a.byId.QB;
    a.snap(); b.snap();
    run(a, 1.3); run(b, 1.3);
    if (a.phase !== 'live') continue;
    const x0 = qb.x, pairs = a.defense.filter(d => d.lock).map(d => [d.id, d.lock]);
    while (a.phase === 'live' && qb.x - x0 < 3) { a.step(STEP, { x: 0.45 }); b.step(STEP); }
    if (a.phase !== 'live') continue;
    slides++;
    assert.ok(Math.abs(qb.x - a.passRush.launch.x) < 4.4, `${seed}: he stayed inside the pocket`);
    assert.equal(a.scrambling(), false);
    for (const [id, by] of pairs) if (a.byId[id].lock === by && b.byId[id].lock === by) shifts.push(Math.abs(a.byId[id].x - b.byId[id].x));
  }
  assert.ok(slides >= 5 && shifts.length >= 6, `slides ${slides}, pairs ${shifts.length}`);
  assert.ok(mean(shifts) < 0.25 && Math.max(...shifts) < 1, `pairs moved ${mean(shifts).toFixed(2)} yd on average, at most ${Math.max(...shifts).toFixed(2)}`);
});

test('a scramble makes the roll-side end contain while the backside end chases', () => {
  // Roll right from 1.2 s. Once free, the end on that side aims outside the
  // quarterback's path (or takes him on from outside or in front, within
  // reach); the end on the far side, once free, runs at him from behind.
  let containSteps = 0, outsideAims = 0, running = 0, chasing = 0, reps = 0, closed = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const s = fourMan(rep(seed)), qb = s.byId.QB;
    s.snap();
    let out = null, edge = null, back = null, near = false;
    for (let i = 0; i < 900 && s.phase === 'live' && (out === null || s.time - out < 2); i++) {
      s.step(STEP, roll(s));
      if (out === null && s.scrambling()) { out = s.time; edge = s.byId[s.passRush.containR]; back = s.byId[s.passRush.containL]; }
      if (out === null) continue;
      near ||= s.defense.some(d => d.rushing && gap(d, qb) < 1.5);
      if (edge && !edge.lock && gap(edge, qb) > 2.5 && edge.aim) { containSteps++; if (edge.aim.x > qb.x) outsideAims++; }
      const speed = back ? Math.hypot(back.vx, back.vz) : 0, to = back ? gap(back, qb) : 0;
      if (back && !back.lock && !back.juke && speed > 3 && to > 2) {
        running++;
        if ((back.vx * (qb.x - back.x) + back.vz * (qb.z - back.z)) / (speed * to) > 0.6) chasing++;
      }
    }
    if (out === null) continue;
    reps++;
    if (near || s.phase !== 'live') closed++;
  }
  assert.ok(reps >= 16, 'scrambles ' + reps);
  assert.ok(containSteps > 100 && outsideAims / containSteps > 0.95, `the contain end aimed outside him in ${outsideAims}/${containSteps} steps`);
  assert.ok(running > 60 && chasing / running > 0.85, `the backside end ran at him in ${chasing}/${running} steps`);
  assert.ok(closed >= reps * 0.5, `the rush closed within 2 s of the scramble in ${closed}/${reps}`);
});

test('a locked rusher needs a shed to leave his blocker when the quarterback scrambles', () => {
  // Every rusher locked when the quarterback leaves the pocket stays on his
  // blocker for longer than his reaction latency (the contain man reads the
  // roll itself and may start earlier), and a shed takes 0.3 s or more
  // unless the quarterback runs right past him.
  const latency = rep(1).skill.latency, apart = [];
  let sheds = 0, locked = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const s = fourMan(rep(seed)), qb = s.byId.QB;
    s.snap();
    let out = null, held = null;
    const started = new Map();
    for (let i = 0; i < 900 && s.phase === 'live' && (out === null || s.time - out < 2.5); i++) {
      s.step(STEP, roll(s));
      for (const d of s.rushers()) if (d.disengage && !started.has(d.id)) started.set(d.id, s.time);
      if (out === null && s.scrambling()) {
        out = s.time;
        held = new Map(s.rushers().filter(d => d.lock && d.id !== s.passRush.containR).map(d => [d.id, d.lock]));
        locked += held.size;
      }
      if (out === null) continue;
      for (const [id, by] of held) {
        const d = s.byId[id];
        if (!by || d.lock === by) continue;
        held.set(id, null);
        // A block won on the rush itself (the quarterback ran right by him)
        // is not a release.
        if (d.wonAt !== s.time || d.shedFrom !== by) continue;
        apart.push(s.time - out);
        sheds++;
        assert.ok(started.has(id) && (s.time - started.get(id) > 0.29 || gap(d, qb) < 1.3), `${seed}: ${id} shed in ${(s.time - (started.get(id) ?? s.time)).toFixed(2)} s`);
      }
    }
  }
  assert.ok(locked >= 15 && sheds >= 8, `locked ${locked}, sheds ${sheds}`);
  assert.ok(Math.min(...apart) > latency, `earliest separation ${Math.min(...apart).toFixed(2)} s after he left`);
  assert.ok(quantile(apart, 0.5) > latency + 0.15, `median ${quantile(apart, 0.5).toFixed(2)} s`);
});

test('a lineman who drops out of the rush frees his blocker, who does not follow him', () => {
  let dropped = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const s = fourMan(rep(seed)), qb = s.byId.QB;
    s.snap();
    run(s, 1.0);
    const d = s.rushers().find(q => q.lock && s.byId[q.lock].role === 'ol');
    if (!d || s.phase !== 'live') continue;
    dropped++;
    const o = s.byId[d.lock], set = s.setPoint(o);
    d.rushing = false;
    s.step(STEP);
    assert.equal(o.lock, null, `${seed}: ${o.id} let go of ${d.id}`);
    assert.notEqual(o.assignment, d.id);
    assert.equal(d.engaged, null);
    while (s.phase === 'live' && s.time < 1.6) {
      s.step(STEP);
      assert.notEqual(o.lock, d.id, `${seed}: ${o.id} does not chase the man who dropped`);
      assert.ok(Math.abs(o.x - set.x) < 3 && o.z < s.spot, `${seed}: ${o.id} stays home (${(o.x - set.x).toFixed(1)}, ${(o.z - s.spot).toFixed(1)})`);
    }
    assert.ok(gap(o, qb) < gap(d, qb) + 3, `${seed}: ${o.id} stays between the rush and the quarterback`);
  }
  assert.ok(dropped >= 4, 'drops ' + dropped);
});

// Five rush from the snap (the four linemen and a linebacker) and a second
// linebacker comes on a count: `at` s after the snap, through the A gap.
// Until then he holds where he lined up (the coordinator's part of the
// contract, done here by hand).
function simPressure(seed, at) {
  const s = rep(seed), qb = s.byId.QB, x0 = s.pocketX();
  const backers = s.defense.filter(d => d.role === 'lb').sort((a, b) => Math.abs(a.x - x0) - Math.abs(b.x - x0));
  const [late, early] = backers, flip = s.config.flip ? -1 : 1;
  for (const d of s.defense) { d.rushing = d.role === 'dl' || d === early; if (d.role !== 'dl') d.rush = undefined; }
  early.rush = { lane: 'blitz', side: flip * (Math.sign(early.x - x0) || 1), gap: 'B', at: 0 };
  late.rush = { lane: 'blitz', side: flip * (Math.sign(late.x - x0) || -1), gap: 'A', at };
  return { s, qb, late };
}

function playCount(b, at, end, each = () => {}) {
  b.s.snap();
  while (b.s.phase === 'live' && b.s.time < end) {
    if (b.s.time < at) Object.assign(b.late, { x: b.late.start.x, z: b.late.start.z, vx: 0, vz: 0 });
    else b.late.rushing = true;
    b.s.step(STEP);
    each(b.s);
  }
}

test('a delayed blitzer is picked up by the back while he checks, and gets home once the back has released', () => {
  let picked = 0, unblocked = 0, home = 0, reps = 0;
  for (let seed = 1; seed <= 8; seed++) {
    // On a 0.5 s count the back is still checking: he (or the line, sliding
    // to the blitz) picks him up.
    const a = simPressure(seed, 0.5);
    let blocked = false;
    playCount(a, 0.5, 2.2, () => { blocked ||= !!a.late.lock; });
    if (a.s.byId.R.blocked && blocked) picked++;
    // On a 1.5 s count the back has gone into his route and every lineman
    // has a man: the blitzer, or whoever the line leaves to take him, is
    // free at the quarterback.
    const b = simPressure(seed, 1.5);
    let reached = null, taken = false, back = false;
    playCount(b, 1.5, 3.5, s => {
      taken ||= !!b.late.lock;
      back ||= b.late.lock === 'R';
      if (reached === null && s.time > 1.5 && s.rushers().some(d => !d.lock && gap(d, b.qb) < 1.5)) reached = s.time;
    });
    if (!b.s.byId.R.released) continue;
    reps++;
    assert.ok(!back, `${seed}: the released back does not come back for him`);
    if (!taken) unblocked++;
    if (reached !== null && reached < 1.5 + 2.1) home++;
  }
  assert.ok(picked >= 6, `picked up in ${picked}/8`);
  assert.ok(reps >= 6 && unblocked >= reps - 2, `the late blitzer came unblocked in ${unblocked}/${reps}`);
  assert.ok(home >= reps - 2, `a free rusher got home within 2.1 s of the count in ${home}/${reps}`);
});

test('a twist crosses the line and the protection exchanges men', () => {
  // T-E on the right: the tackle goes first into the C gap, the end loops
  // inside. The man on the penetrator hands him to the next man out and is
  // free for the looper (the guard to the tackle, or the centre to the
  // guard when the tackle lined up over the ball).
  let twists = 0, exchanged = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const s = fourMan(rep(seed, { stunt: { kind: 'TE', side: 1, picked: true } }));
    s.snap();
    s.step(STEP);
    const st = s.passRush.stunt;
    if (!st) continue;
    twists++;
    const by = { [st.pen]: [], [st.loop]: [] };
    let passOff = false;
    while (s.phase === 'live' && s.time < 2.2) {
      s.step(STEP);
      passOff ||= s.drainEvents().includes('pass-off');
      for (const id of [st.pen, st.loop]) { const o = s.byId[id].lock; if (o && !by[id].includes(o)) by[id].push(o); }
    }
    const [first, next] = by[st.pen], loop = by[st.loop];
    const order = ['LT', 'LG', 'C', 'RG', 'RT'];
    if (passOff && next && order.indexOf(next) > order.indexOf(first) && loop.length && !loop.includes(next)) exchanged++;
  }
  assert.ok(twists >= 6, 'twists ' + twists);
  assert.ok(exchanged >= twists * 0.6, `exchanged in ${exchanged}/${twists}`);
});

test('against four rushers at Pro the pocket holds about 2.5-3 s, with a real spread', () => {
  const first = [];
  for (let seed = 1; seed <= 32; seed++) {
    const s = fourMan(rep(seed, { stunt: undefined })), qb = s.byId.QB;
    s.snap();
    let t = null;
    while (s.phase === 'live' && t === null && s.time < 6) {
      s.step(STEP);
      if (s.rushers().some(d => gap(d, qb) < 1.5)) t = s.time;
    }
    first.push(t ?? 6);
  }
  const med = quantile(first, 0.5), lo = quantile(first, 0.1), hi = quantile(first, 0.9);
  assert.ok(med > 2.5 && med < 3.3, `median first pressure ${med.toFixed(2)} s`);
  assert.ok(lo > 1.8 && hi - lo > 0.8, `p10 ${lo.toFixed(2)} s, p90 ${hi.toFixed(2)} s`);
});

test('play action holds the defensive line for a beat', () => {
  // The linemen read run first: nobody wins a block or gets near the
  // quarterback before the fake is over, and the pressure comes later than
  // on a straight dropback from the same alignment.
  for (let seed = 1; seed <= 6; seed++) {
    const s = fourMan(rep(seed, { offense: 'flood' })), qb = s.byId.QB;
    s.snap();
    while (s.phase === 'live' && s.time < 1.1) {
      s.step(STEP);
      assert.ok(!s.drainEvents().includes('block-win'), `${seed}: a block win at ${s.time.toFixed(2)} s`);
      assert.ok(s.rushers().every(d => gap(d, qb) > 3), `${seed}: a rusher near the quarterback at ${s.time.toFixed(2)} s`);
    }
  }
});
