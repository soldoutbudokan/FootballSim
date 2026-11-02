// Pass protection and the pass rush (dist/js/sim/protection.js): the pocket
// is built around the launch point, not the live quarterback; a scramble
// makes rushers come off their blocks, the end on that side keeps contain;
// blitzers, drop-outs and twists are picked up or get home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP } from '../dist/js/sim.js';
import { speedCap } from '../dist/js/sim/common.js';

const rep = (seed, options = {}) => new Simulation(seed, { offense: 'mesh', coverage: 'cover3', difficulty: 'pro', mode: 'reps', stunt: 'none', ...options });
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const run = (s, t, input = () => ({})) => { while (s.phase === 'live' && s.time < t - 1e-9) s.step(STEP, input(s)); };
const quantile = (a, p) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(p * (v.length - 1))]; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const clampUnit = v => Math.max(-1, Math.min(1, v));
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

test('a quick slide inside the pocket is not a scramble: nobody comes off his block or carries his man with him', () => {
  // Full stick (keyboard input is digital, so every keyboard slide is one)
  // 2.5 yd sideways after he sets, then he stops, inside the box; the same
  // rep standing. Nobody reads a scramble or starts a shed (the contain end
  // included), and the pairs that stay locked end up where they would have.
  const shifts = [];
  let slides = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const a = fourMan(rep(seed)), b = fourMan(rep(seed)), qb = a.byId.QB;
    a.snap(); b.snap();
    run(a, 1.3); run(b, 1.3);
    if (a.phase !== 'live') continue;
    const x0 = qb.x, pairs = a.defense.filter(d => d.lock).map(d => [d.id, d.lock]);
    while (a.phase === 'live' && b.phase === 'live' && a.time < 2.4) {
      a.step(STEP, qb.x - x0 < 2.5 ? { x: 1 } : {}); b.step(STEP);
      assert.ok(Math.abs(qb.x - a.passRush.launch.x) < 4.4 && !a.scrambling(), `${seed}: he stayed inside the pocket`);
      for (const d of a.rushers()) assert.ok(!a.sawOut(d) && !d.disengage, `${seed}: ${d.id} read a scramble at ${a.time.toFixed(2)} s`);
    }
    if (a.phase !== 'live' || b.phase !== 'live') continue;
    slides++;
    for (const [id, by] of pairs) if (a.byId[id].lock === by && b.byId[id].lock === by) shifts.push(Math.abs(a.byId[id].x - b.byId[id].x), Math.abs(a.byId[by].x - b.byId[by].x));
  }
  assert.ok(slides >= 8 && shifts.length >= 16, `slides ${slides}, pairs ${shifts.length / 2}`);
  assert.ok(mean(shifts) < 0.25 && Math.max(...shifts) < 1, `rushers and blockers moved ${mean(shifts).toFixed(2)} yd on average, at most ${Math.max(...shifts).toFixed(2)}`);
});

test('a scramble makes the roll-side end contain while the backside end chases', () => {
  // Roll right from 1.2 s. Once free, the end on that side aims outside the
  // quarterback's path (or takes him on from outside or in front, within
  // reach); the end on the far side, once free, runs at him from behind.
  // A roll at this pace looks like a slide inside the pocket until he nears
  // its edge, so the end reads it only then and often cannot get back in
  // front of him: the rush closes on him in a good share of reps, not most.
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
  assert.ok(closed >= reps * 0.25, `the rush closed within 2 s of the scramble in ${closed}/${reps}`);
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

// Five rush from the snap: the four linemen and the middle linebacker, whom
// the line counted (he is in the box), through the B gap. A linebacker
// lined up outside the box, whom it did not count, comes on a count: `at` s
// after the snap, through the A gap. Until then he holds where he lined up
// (the coordinator's part of the contract, done here by hand).
function simPressure(seed, at) {
  const s = rep(seed), qb = s.byId.QB, x0 = s.pocketX();
  const backers = s.defense.filter(d => d.role === 'lb').sort((a, b) => Math.abs(a.x - x0) - Math.abs(b.x - x0));
  const [early, late] = backers, flip = s.config.flip ? -1 : 1;
  for (const d of s.defense) { d.rushing = d.role === 'dl' || d === early; if (d.role !== 'dl') d.rush = undefined; }
  early.rush = { lane: 'blitz', side: flip * (Math.sign(early.x - x0) || 1), gap: 'B', at: 0 };
  late.rush = { lane: 'blitz', side: flip * (Math.sign(late.x - x0) || -1), gap: 'A', at };
  return { s, qb, late, early };
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

test('the line takes the blitzer it counted; one it missed is the back\'s while he checks, and free once he has gone', () => {
  let picked = 0, unblocked = 0, home = 0, reps = 0, line = 0;
  for (let seed = 1; seed <= 8; seed++) {
    // On a 0.5 s count the back is still checking: he picks the late man up
    // (now and then a lineman does, or the back cannot get across in time).
    const a = simPressure(seed, 0.5);
    let blocked = false;
    playCount(a, 0.5, 2.2, () => { blocked ||= !!a.late.lock; });
    if (a.s.byId.R.blocked && blocked) picked++;
    // On a 1.5 s count the back has gone into his route and every lineman
    // has a man: the late blitzer is free at the quarterback. The counted
    // man was the line's.
    const b = simPressure(seed, 1.5);
    let reached = null, taken = false, back = false, early = null;
    playCount(b, 1.5, 3.5, s => {
      taken ||= !!b.late.lock;
      back ||= b.late.lock === 'R';
      early ||= b.early.lock;
      if (reached === null && s.time > 1.5 && s.rushers().some(d => !d.lock && gap(d, b.qb) < 1.5)) reached = s.time;
    });
    if (early && early !== 'R') line++;
    if (!b.s.byId.R.released) continue;
    reps++;
    assert.ok(!back, `${seed}: the released back does not come back for him`);
    if (!taken) unblocked++;
    if (reached !== null && reached < 1.5 + 2.1) home++;
  }
  assert.ok(picked >= 4, `picked up in ${picked}/8`);
  assert.ok(line >= 6, `the line took the man it counted in ${line}/8`);
  assert.ok(reps >= 6 && unblocked >= reps - 1, `the late blitzer came unblocked in ${unblocked}/${reps}`);
  assert.ok(home >= reps - 2, `a free rusher got home within 2.1 s of the count in ${home}/${reps}`);
});

test('the protection call: the count takes the line, the walked-up men and the box, and the line slides to the bigger side', () => {
  for (let seed = 1; seed <= 6; seed++) {
    for (const flip of [false, true]) {
      const s = new Simulation(seed, { offense: 'mesh', coverage: 'blitz', difficulty: 'pro', mode: 'reps', flip }), x0 = s.pocketX();
      s.snap();
      s.step(STEP); s.step(STEP); run(s, 0.1);
      const call = s.passRush.call;
      for (const d of s.defense) {
        const deep = d.start.z - s.spot, wide = Math.abs(d.start.x - x0);
        if (d.role === 'dl' || (deep < 2 && wide < 7)) assert.ok(call.count.has(d.id), `${seed}: ${d.id} on the line or walked up is counted`);
        if (deep > 7 || wide > 9) assert.ok(!call.count.has(d.id), `${seed}: ${d.id} deep or wide is not`);
      }
      const side = k => s.defense.filter(d => call.count.has(d.id) && Math.sign(d.start.x - x0) === k && Math.abs(d.start.x - x0) >= 0.5).length;
      if (side(1) !== side(-1)) assert.equal(call.slide, Math.sign(side(1) - side(-1)), `${seed}: slides to the side with more`);
    }
    // A mirrored formation gets the mirrored call.
    const [plain, mirror] = [false, true].map(flip => { const s = new Simulation(seed, { offense: 'mesh', coverage: 'cover3', difficulty: 'pro', mode: 'reps', flip }); s.snap(); run(s, 0.1); return s.passRush.call; });
    assert.deepEqual([...mirror.count].sort(), [...plain.count].sort(), `${seed}: the same men counted`);
    assert.equal(mirror.slide, -plain.slide, `${seed}: the mirrored slide`);
  }
});

test('a counted linebacker who drops frees his blocker only once the line sees him go', () => {
  let freed = 0, cases = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const s = fourMan(rep(seed)), x0 = s.pocketX();
    s.snap();
    run(s, 0.1);
    // A lineman set on a linebacker in the box (a maybe) and not on a rusher.
    const o = s.line.find(q => q.assignment && s.byId[q.assignment].role === 'lb');
    if (!o) continue;
    const d = s.byId[o.assignment];
    assert.ok(Math.abs(d.start.x - x0) < 6, `${seed}: ${d.id} was in the box`);
    let gone = null, kept = null;
    while (s.phase === 'live' && s.time < 1.5) {
      s.step(STEP);
      if (gone === null && s.passRush.call.dropped.has(d.id)) { gone = s.time; kept = o.assignment === d.id; }
    }
    // A spy or a man who stays in the box is never seen to go.
    if (d.z - d.start.z < 2) continue;
    cases++;
    assert.ok(gone !== null && gone > 0.4, `${seed}: ${d.id} seen dropping at ${gone}`);
    if (!kept && o.assignment !== d.id) freed++;
  }
  assert.ok(cases >= 4 && freed === cases, `freed ${freed}/${cases}`);
});

test('six rushers get home sooner than four, and a called blitzer times the snap', () => {
  // First rusher within 1.5 yd of a quarterback who holds the ball at Pro,
  // the coordinator's own Cover 0 calls against its four-man calls.
  const first = coverage => {
    const out = [];
    for (let seed = 1; seed <= 24; seed++) {
      const s = new Simulation(seed, { offense: 'mesh', coverage, difficulty: 'pro', mode: 'reps' }), qb = s.byId.QB;
      s.snap();
      let t = null;
      while (s.phase === 'live' && t === null && s.time < 6) { s.step(STEP); if (s.rushers().some(d => gap(d, qb) < 1.5)) t = s.time; }
      out.push(t ?? 6);
    }
    return quantile(out, 0.5);
  };
  const six = first('blitz'), four = first('cover3');
  assert.ok(six < four - 0.25 && six > 2, `six ${six.toFixed(2)} s, four ${four.toFixed(2)} s`);
  // A blitzer goes on the count at Pro and All-pro; at Rookie he reacts to
  // the ball like everyone else.
  const moving = (difficulty, at) => {
    const s = new Simulation(3, { offense: 'mesh', coverage: 'blitz', difficulty, mode: 'reps' });
    s.snap();
    run(s, at);
    return s.defense.filter(d => d.rushing && d.role !== 'dl').map(d => Math.hypot(d.vx, d.vz));
  };
  assert.ok(moving('pro', 0.26).every(v => v > 0.3) && moving('allpro', 0.16).every(v => v > 0.1), 'timed blitzers are moving');
  assert.ok(moving('rookie', 0.26).every(v => v === 0), 'a Rookie blitzer waits for the ball');
});

test('once the ball is thrown the rushers come off their blocks and run to it', () => {
  let reps = 0, turned = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const s = fourMan(rep(seed));
    s.snap();
    run(s, 1.8);
    if (s.phase !== 'live' || !s.rushers().some(d => d.lock) || !s.requestThrow('X', 'lob')) continue;
    while (s.phase === 'live') s.step(STEP);
    const t0 = s.time;
    while (s.phase === 'air' && s.time < t0 + 0.6) s.step(STEP);
    if (s.phase !== 'air') continue;
    reps++;
    // Off their blocks within their reaction time, every one of them heading
    // downfield after the ball instead of at the passer.
    assert.ok(s.rushers().every(d => !d.lock && !d.engaged), `${seed}: nobody still blocked ${s.pass.elapsed.toFixed(2)} s after the throw`);
    if (s.rushers().every(d => d.want.z > 2)) turned++;
  }
  assert.ok(reps >= 6 && turned >= reps - 1, `the rush turned to the ball in ${turned}/${reps}`);
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

// First rusher within 1.5 yd of a quarterback who holds the ball, four man
// rush, 32 seeds. Nobody blocked at all gets there in about 2.1-2.3 s (the
// linemen's bodies), so every level stays above that floor.
function firstPressure(difficulty) {
  const first = [];
  for (let seed = 1; seed <= 32; seed++) {
    const s = fourMan(rep(seed, { stunt: undefined, difficulty })), qb = s.byId.QB;
    s.snap();
    let t = null;
    while (s.phase === 'live' && t === null && s.time < 6) {
      s.step(STEP);
      if (s.rushers().some(d => gap(d, qb) < 1.5)) t = s.time;
    }
    first.push(t ?? 6);
  }
  return { med: quantile(first, 0.5), lo: quantile(first, 0.1), hi: quantile(first, 0.9) };
}

test('against four rushers the pocket holds about 3.2 s at Rookie, 2.6 at Pro and 2.4 at All-pro, with a real spread', () => {
  // The rush plan (DISCIPLINE.plan) and finishing (bend) change by level;
  // the bodies do not.
  const rookie = firstPressure('rookie'), pro = firstPressure('pro'), allpro = firstPressure('allpro');
  const f = r => `${r.med.toFixed(2)} [${r.lo.toFixed(2)}-${r.hi.toFixed(2)}]`;
  assert.ok(rookie.med > 2.9 && rookie.med < 3.6, 'Rookie ' + f(rookie));
  assert.ok(pro.med > 2.45 && pro.med < 2.9, 'Pro ' + f(pro));
  assert.ok(allpro.med > 2.25 && allpro.med < 2.65, 'All-pro ' + f(allpro));
  assert.ok(rookie.med > pro.med + 0.35 && pro.med > allpro.med + 0.1, `ordered: ${f(rookie)}, ${f(pro)}, ${f(allpro)}`);
  for (const r of [rookie, pro, allpro]) assert.ok(r.lo > 1.8 && r.hi - r.lo > 0.6, 'spread ' + f(r));
  const tops = level => rep(1, { difficulty: level }).defense.map(d => d.top).join();
  assert.equal(tops('rookie'), tops('allpro'), 'the same bodies at every level');
});

test('a rusher who beats his man bends at the quarterback; a Rookie bends only part way', () => {
  // A locked end well upfield of the quarterback wins with a speed rush (the
  // win forced at 1.2 s). His rip heads at the quarterback, slipped outside
  // by the move's slip (about 19 degrees) at All-pro; at Rookie it bends only
  // half way from his arc (DISCIPLINE bend 0.5), wider of him.
  const rips = difficulty => {
    const out = [];
    for (let seed = 1; seed <= 12; seed++) {
      const s = fourMan(rep(seed, { difficulty })), qb = s.byId.QB;
      s.snap();
      run(s, 1.2);
      const d = s.rushers().find(q => q.lock && s.laneOf(q).edge && q.z > qb.z + 2.5);
      if (!d || s.phase !== 'live') continue;
      d.rushMove = 'speed'; d.winSide = s.laneOf(d).side; d.have = d.need;
      s.step(STEP);
      if (d.wonAt !== s.time || !d.juke) continue;
      const v = d.juke.to, to = gap(d, qb), speed = Math.hypot(v.x, v.z);
      out.push(Math.acos(clampUnit((v.x * (qb.x - d.x) + v.z * (qb.z - d.z)) / (speed * to))) * 180 / Math.PI);
    }
    assert.ok(out.length >= 6, `${difficulty}: forced wins ${out.length}`);
    return mean(out);
  };
  const rookie = rips('rookie'), allpro = rips('allpro');
  assert.ok(allpro < 22, `All-pro winners rip within ${allpro.toFixed(0)} degrees of him`);
  assert.ok(rookie > allpro + 10, `Rookie ${rookie.toFixed(0)} vs All-pro ${allpro.toFixed(0)} degrees`);
});

test('a rusher nobody blocks takes the straight lane, skirting the blocks; a winner bursts flat out', () => {
  // The six-man blitz: a man no blocker has aims at the launch point (or
  // the quarterback once he has moved), or 1.2 yd beside the first block in
  // the way, outside it for an edge rusher. A man who beats his blocker
  // runs at the quarterback at his full speed.
  let free = 0, skirted = 0, bursts = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const s = new Simulation(seed, { offense: 'mesh', coverage: 'blitz', difficulty: 'pro', mode: 'reps' }), qb = s.byId.QB;
    s.snap();
    while (s.phase === 'live' && s.time < 3) {
      s.step(STEP);
      for (const d of s.rushers()) {
        if (d.wonAt > 0 && s.time - d.wonAt > 0.3 && s.time - d.wonAt < 0.5 && !d.lock && !s.sawOut(d) && !s.sawThrow(d)) {
          bursts++;
          assert.ok(Math.hypot(d.want.x, d.want.z) > 0.99 * speedCap(d, 1), `${seed} ${d.id}: the winner runs flat out`);
        }
        if (!d.aim || s.time < 0.4 || !s.unblocked(d) || d.wonAt > 0 || gap(d, qb) < 3.2 || s.sawOut(d) || s.sawThrow(d) || s.readsRun(d) || s.twistAim(d, s.laneOf(d))) continue;
        free++;
        const ref = s.freeRef(d), lane = s.laneOf(d);
        if (gap(d.aim, ref) < 1e-9) continue;
        // (The bodies have moved one step since he took his aim.)
        const bodies = s.players.filter(o => (o.role === 'ol' || (o.team === 'defense' && o.lock)) && Math.abs(gap(o, d.aim) - 1.2) < 0.1);
        assert.ok(bodies.length, `${seed} ${d.id}: aims at the launch point or beside a block`);
        if (lane.edge && Math.abs(ref.z - d.z) > 0.3 * gap(ref, d)) assert.ok(bodies.some(o => Math.sign(d.aim.x - o.x) === lane.side), `${seed} ${d.id}: an edge rusher passes outside`);
        skirted++;
      }
    }
  }
  assert.ok(free > 200 && skirted > 20 && bursts > 20, `free steps ${free}, skirting ${skirted}, bursts ${bursts}`);
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

test('a flipped play gets the mirrored protection and the mirrored twist', () => {
  // The same rep plain and flipped: every blocker has the same man (the
  // defense mirrors too), and one man each on a four-man rush.
  for (let seed = 1; seed <= 6; seed++) {
    const [plain, flip] = [false, true].map(f => { const s = fourMan(rep(seed, { flip: f })); s.snap(); run(s, 0.1); return s; });
    for (const o of plain.line) assert.equal(flip.byId[o.id].assignment, o.assignment, `${seed}: ${o.id}`);
    assert.equal(new Set(flip.line.map(o => o.assignment).filter(Boolean)).size, 5, `${seed}: one man each`);
  }
  // A twist, forced or drawn, goes to the play's own side: the same two men
  // on the mirrored side of the field.
  let twists = 0;
  for (let seed = 1; seed <= 30; seed++) {
    for (const stunt of [{ kind: 'TE', side: 1, picked: true }, undefined]) {
      const [plain, flip] = [false, true].map(f => { const s = fourMan(rep(seed, { flip: f, stunt, difficulty: 'allpro' })); s.snap(); s.step(STEP); return s.passRush.stunt; });
      if (!plain && !flip) continue;
      twists++;
      assert.ok(plain && flip, `${seed}: a twist on both or neither`);
      assert.deepEqual([flip.kind, flip.pen, flip.loop, flip.side], [plain.kind, plain.pen, plain.loop, -plain.side], `${seed}: the mirrored twist`);
    }
  }
  assert.ok(twists >= 32, 'twists ' + twists);
});

test('an end-tackle twist is never handed outward', () => {
  // In an E-T game the end crashes inside: the blocker on him may hand him
  // in to the next man, never out to the man outside him.
  const order = ['LT', 'LG', 'C', 'RG', 'RT'], centre = 2;
  for (const side of [1, -1]) for (let seed = 1; seed <= 12; seed++) {
    const s = fourMan(rep(seed, { stunt: { kind: 'ET', side, picked: true } }));
    s.snap(); s.step(STEP);
    const st = s.passRush.stunt;
    if (!st) continue;
    let by = null;
    while (s.phase === 'live' && s.time < 2.2) {
      s.step(STEP);
      const now = s.byId[st.pen].lock, handed = s.drainEvents().includes('pass-off');
      if (handed) assert.ok(Math.abs(order.indexOf(now) - centre) < Math.abs(order.indexOf(by) - centre), `${seed}: ${by} handed the end out to ${now}`);
      if (now) by = now;
    }
  }
});

test('play action: the launch point waits for the drop, and the line reads only the fake it sees', () => {
  // He sets at his play-action depth after the fake, not at the mesh, and
  // the point is where he then stands.
  for (let seed = 1; seed <= 4; seed++) {
    const s = fourMan(rep(seed, { offense: 'flood' })), qb = s.byId.QB;
    s.snap();
    while (s.phase === 'live' && !s.passRush?.set) {
      s.step(STEP);
      if (!s.passRush?.set) continue;
      assert.ok(!s.faking(), `${seed}: set during the fake at ${s.time.toFixed(2)} s`);
      assert.ok(s.spot - s.passRush.launch.z > 6.5, `${seed}: set ${(s.spot - s.passRush.launch.z).toFixed(1)} yd deep`);
    }
    run(s, 2.4);
    if (s.phase === 'live') assert.ok(Math.abs(s.passRush.launch.z - qb.z) < 0.5, `${seed}: he stands ${(s.passRush.launch.z - qb.z).toFixed(1)} yd from the launch point`);
  }
  // A quarterback who backs straight out of the fake from the snap gives the
  // linemen nothing to read: they read pass after their reaction latency.
  // One who runs the fake holds them for the difficulty's `pa`.
  const linemen = steer => {
    const s = fourMan(rep(1, { offense: 'flood' }));
    s.snap();
    run(s, 0.45, x => (steer && x.byId.QB.z > x.spot - 7.5 ? { z: -1 } : {}));
    return s.rushers().filter(d => s.readsRun(d)).length;
  };
  assert.equal(linemen(true), 0, 'no run read without a fake');
  assert.equal(linemen(false), 4, 'the fake holds all four');
});

test('a counted man who neither rushes nor drops stays a maybe', () => {
  // A linebacker in the box who sits (a spy): the line counts him but is
  // never sure he comes, however long he sits there.
  const s = fourMan(rep(1)), x0 = s.pocketX();
  s.snap();
  run(s, 0.1);
  const lb = s.defense.find(d => d.role === 'lb' && s.passRush.call.count.has(d.id));
  assert.ok(lb, 'a counted linebacker');
  while (s.phase === 'live' && s.time < 1.2) {
    Object.assign(lb, { x: lb.start.x, z: lb.start.z, vx: 0, vz: 0 });
    s.step(STEP);
    assert.equal(s.declared(lb), false, `${lb.id} declared at ${s.time.toFixed(2)} s`);
  }
  assert.ok(Math.abs(lb.start.x - x0) < 6);
});
