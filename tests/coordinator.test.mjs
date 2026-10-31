import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP } from '../dist/js/sim.js';
import { PLAYS, RECEIVERS, COVERAGES } from '../dist/js/plays.js';
import { FAMILIES } from '../dist/js/sim/defense.js';

// The defensive coordinator (defense.js): what the defense calls, what it
// shows before the snap, how it rotates, how it reads the situation and the
// offense's tendencies; and the coverage rules every call relies on.
const depth = (s, d) => d.z - s.spot;
function make(seed, options = {}) {
  return new Simulation(seed, { offense: 'mesh', difficulty: 'allpro', mode: 'reps', ...options });
}
function run(s, until, each = () => {}, input = () => ({})) {
  while (s.time < until - 1e-9 && s.phase === 'live') { s.step(STEP, input(s)); each(s); }
  return s;
}
// Draw `n` calls in the current situation (callDefense only reads it).
function calls(s, n) {
  const out = [];
  for (let i = 0; i < n; i++) { s.callDefense(); out.push(s.call); }
  return out;
}
const share = (list, test) => list.filter(test).length / list.length;

test('every family is a coverage the app can label, and every call describes itself', () => {
  for (const family of FAMILIES) {
    assert.ok(COVERAGES[family]?.label, family);
    for (let seed = 1; seed <= 6; seed++) {
      const s = make(seed, { coverage: family });
      assert.equal(s.coverage, family);
      assert.ok(typeof s.call.description === 'string' && s.call.description.length > 10, s.call.description);
    }
  }
  for (const key of ['random', 'cover3', 'cover2', 'man', 'blitz']) assert.ok(COVERAGES[key]);
});

test('the pre-snap shell disguises the call: the same family shows different shells, and a shell hides different families', () => {
  const shells = fam => new Set(Array.from({ length: 40 }, (_, i) => make(i + 1, { coverage: fam }).call.shell));
  const three = shells('cover3'), two = shells('cover2');
  assert.ok(three.has('two-high') && three.has('one-high'), 'Cover 3 shows two-high and one-high: ' + [...three]);
  assert.ok(two.has('one-high') && two.has('two-high'), 'Cover 2 sometimes shows one-high: ' + [...two]);
  // Across random calls a shell is no tell: each common shell hides several families.
  const s = make(7, { coverage: 'random' }), byShell = {};
  for (const c of calls(s, 400)) (byShell[c.shell] ||= new Set()).add(c.coverage);
  for (const shell of ['two-high', 'one-high', 'mug']) assert.ok(byShell[shell]?.size >= 4, `${shell} hides ${[...(byShell[shell] || [])]}`);
  // The look is what the players show: two-high safeties deep and split,
  // one-high a deep middle safety and a strong safety by the box.
  for (let seed = 1; seed <= 40; seed++) {
    const t = make(seed, { coverage: 'cover3' }), fs = t.byId.FS, ss = t.byId.SS;
    if (t.call.shell === 'two-high') assert.ok(depth(t, fs) > 11 && depth(t, ss) > 11 && Math.abs(fs.x) > 7 && Math.abs(ss.x) > 7, `${seed}: two-high`);
    if (t.call.shell === 'one-high') assert.ok(depth(t, fs) > 12.5 && Math.abs(fs.x) < 3 && depth(t, ss) < 10, `${seed}: one-high`);
  }
});

test('a rotation is physically possible: the spinning safety reaches the deep middle within 1.5 s', () => {
  let checked = 0;
  for (let seed = 1; seed <= 60 && checked < 6; seed++) {
    const s = make(seed, { coverage: 'cover3', offense: 'verts' });
    if (s.call.shell !== 'two-high' || s.call.variant === 'cloud') continue;
    const fs = s.byId.FS;
    assert.ok(Math.abs(fs.x) > 7, 'he shows a half');
    s.snap();
    // In the middle third (the half of it nearer his seam: he leans to the
    // seam nobody else has) and deep.
    let reached = null;
    run(s, 3, () => { if (reached === null && Math.abs(fs.x - s.pocketX()) < 6 && depth(s, fs) > 10) reached = s.time - fs.rotate.at; });
    assert.ok(reached !== null && reached < 1.5, `${seed}: in the middle ${reached?.toFixed(2)} s after he starts (${s.call.timing})`);
    checked++;
  }
  assert.ok(checked >= 3, 'two-high Cover 3 reps ' + checked);
});

test('the call reads down and distance: 3rd and 8 brings pressure and deep shells, 2nd and 2 brings the box down', () => {
  const situation = (down, toGo) => {
    const s = make(11, { coverage: 'random', mode: 'drive' });
    s.down = down; s.toGo = toGo;
    const list = calls(s, 600);
    // The box: the defenders shown within 8 yd of the line and 6 yd of the ball.
    const box = [];
    for (let i = 0; i < 60; i++) { s.callDefense(); s.reset(); box.push(s.defense.filter(d => depth(s, d) < 8 && Math.abs(d.x) < 6).length); }
    return {
      pressure: share(list, c => c.rushers.length >= 5 || c.coverage === 'creeper' || c.coverage === 'firezone'),
      deep: share(list, c => ['cover2', 'tampa2', 'cover4', 'cover6', 'man'].includes(c.coverage)),
      box: box.reduce((a, b) => a + b, 0) / box.length,
    };
  };
  // `rushers` is filled in at the alignment; draw it from a fresh alignment.
  const long = situation(3, 8), short = situation(2, 2);
  assert.ok(long.pressure > short.pressure + 0.05, `pressure ${long.pressure.toFixed(2)} vs ${short.pressure.toFixed(2)}`);
  assert.ok(long.deep > short.deep + 0.1, `two deep ${long.deep.toFixed(2)} vs ${short.deep.toFixed(2)}`);
  assert.ok(short.box > long.box + 0.3, `box ${short.box.toFixed(1)} vs ${long.box.toFixed(1)}`);
});

test('in the red zone the shells compress and man coverage rises', () => {
  const field = spot => {
    const s = make(5, { coverage: 'random', spot });
    const list = calls(s, 400), safeties = [], deep = [];
    for (let i = 0; i < 40; i++) {
      s.callDefense(); s.reset();
      safeties.push(Math.max(depth(s, s.byId.FS), depth(s, s.byId.SS)));
      for (const d of s.defense) if (d.assign?.kind === 'deep') deep.push(Math.min(d.assign.depth, 118 - s.spot));
    }
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    return { man: share(list, c => ['cover1', 'man', 'blitz'].includes(c.coverage)), safety: mean(safeties), deep: mean(deep) };
  };
  const open = field(35), red = field(100);
  assert.ok(red.safety < open.safety - 2, `safeties ${red.safety.toFixed(1)} vs ${open.safety.toFixed(1)} yd`);
  assert.ok(red.deep < open.deep - 4, `deep zones ${red.deep.toFixed(1)} vs ${open.deep.toFixed(1)} yd`);
  assert.ok(red.man > open.man + 0.05, `man ${red.man.toFixed(2)} vs ${open.man.toFixed(2)}`);
  // Every defender still lines up in front of the end line.
  const s = make(5, { spot: 105 });
  for (const d of s.defense) assert.ok(d.z < 118, d.id);
});

test('the coordinator learns: after deep completions the share of two-high shells rises', () => {
  const s = make(21, { coverage: 'random', offense: 'verts' });
  const twoHigh = () => share(calls(s, 500), c => c.shell === 'two-high');
  // The same thing as odds: two-deep families and two-high looks.
  const odds = () => {
    s.callDefense();
    const fam = Object.entries(s.call.weights).filter(([f]) => ['cover2', 'tampa2', 'cover4', 'cover6', 'man'].includes(f)).reduce((a, [, w]) => a + w, 0);
    return { fam, look: s.call.looks['two-high'] ?? 0 };
  };
  const before = twoHigh(), was = odds();
  for (let i = 0; i < 20; i++) {
    s.callDefense(); s.reset(); s.snap();
    // A deep completion: the ball thrown 30 yd to the outside receiver and caught.
    s.threw = true; s.completed = true; s.call.rep.throwAt = 2.1;
    s.pass = { receiver: 'B', target: { x: 21, y: 1.6, z: s.spot + 30 }, elapsed: 1.5, duration: 1.5 };
    s.finish('Tackled', 32, 'tackle');
  }
  const after = twoHigh(), now = odds();
  assert.ok(after > before + 0.1, `two-high shells ${before.toFixed(2)} → ${after.toFixed(2)}`);
  assert.ok(now.fam > was.fam + 0.05, `two-deep families ${was.fam.toFixed(2)} → ${now.fam.toFixed(2)}`);
  // Rookie keeps no scouting report: the same odds after the same reps.
  const r = make(21, { coverage: 'random', offense: 'verts', difficulty: 'rookie' });
  r.callDefense();
  const base = r.call.weights;
  for (let i = 0; i < 20; i++) {
    r.callDefense(); r.reset(); r.snap();
    r.threw = true; r.completed = true; r.call.rep.throwAt = 2.1;
    r.pass = { receiver: 'B', target: { x: 21, y: 1.6, z: r.spot + 30 }, elapsed: 1.5, duration: 1.5 };
    r.finish('Tackled', 32, 'tackle');
  }
  r.callDefense();
  assert.deepEqual(r.call.weights, base, 'Rookie does not adjust');
});

test('over a long All-pro session every family is called, none over 30 % of the time', () => {
  // Cover 0 is the rarest (about 5 %, as in real football); the rest 7-15 %.
  const s = new Simulation(33, { difficulty: 'allpro' }), counts = {};
  let n = 0;
  for (let i = 0; i < 1500; i++) {
    counts[s.coverage] = (counts[s.coverage] || 0) + 1; n++;
    s.snap();
    // A plausible offense: gains of -1 to 11 yd, a touchdown at the goal line.
    const yards = Math.floor(s.random() * 13) - 1;
    if (s.spot + yards >= 110) s.finish('Touchdown', 110 - s.spot, 'touchdown');
    else s.finish('Tackled', yards, 'tackle');
    s.next();
  }
  for (const family of FAMILIES) {
    const p = (counts[family] || 0) / n;
    assert.ok(p > (family === 'blitz' ? 0.035 : 0.06) && p < 0.3, `${family} ${(100 * p).toFixed(1)} %`);
  }
});

test('every family gives every non-rusher a job, men on every receiver, and the right numbers', () => {
  for (const family of FAMILIES) for (const play of PLAYS.filter((p, i) => i % 3 === 0)) for (let seed = 1; seed <= 4; seed++) {
    const s = new Simulation(seed, { coverage: family, offense: play.id, difficulty: 'allpro', mode: 'reps' });
    const label = `${family}/${play.id}/${seed} (${s.call.description})`;
    const rushers = s.defense.filter(d => d.rushing || (d.rush && d.rush.at > 0));
    const cover = s.defense.filter(d => !rushers.includes(d));
    for (const d of cover) assert.ok(d.assign && d.assign.kind !== 'hold', `${label}: ${d.id} has a job`);
    const men = new Set(cover.filter(d => d.assign.kind === 'man').map(d => d.assign.id));
    const deep = cover.filter(d => d.assign.kind === 'deep' || d.assign.kind === 'quarter').length;
    const under = cover.filter(d => d.assign.kind === 'under').length;
    if (['cover1', 'man', 'blitz'].includes(family)) assert.deepEqual([...men].sort(), [...RECEIVERS].sort(), `${label}: every receiver has a man`);
    const expect = {
      cover3: [4, 3], cover2: [4, 2], tampa2: [4, 2], cover4: [4, 4], cover6: [4, 3], man: [4, 2],
      firezone: [5, 3, 3], creeper: [4, 3, 4], blitz: [6, 0],
    }[family];
    if (expect) {
      assert.equal(rushers.length, expect[0], `${label}: rushers`);
      assert.equal(deep, expect[1], `${label}: deep`);
      if (expect[2] !== undefined) assert.equal(under + cover.filter(d => d.assign.kind === 'spy').length, expect[2], `${label}: under`);
    }
    if (family === 'cover1') assert.ok(rushers.length === 4 || rushers.length === 5, label);
    // Pressure from a lineman dropping: he does not rush and has a zone.
    if (family === 'firezone' || family === 'creeper') {
      const dropped = s.defense.filter(d => d.role === 'dl' && !d.rushing);
      assert.equal(dropped.length, 1, `${label}: one lineman drops`);
      assert.ok(['under', 'spy'].includes(dropped[0].assign.kind), label);
    }
  }
});

test('a sim pressure can send its replacement rusher late, and he holds his look until then', () => {
  let delayed = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const s = make(seed, { coverage: 'creeper' }), d = s.defense.find(p => p.rush && p.rush.at > 0);
    if (!d) continue;
    delayed++;
    assert.ok(d.rush.at >= 0.3 && d.rush.at <= 0.8, 'at ' + d.rush.at);
    const start = { x: d.x, z: d.z };
    s.snap();
    run(s, d.rush.at - 0.02);
    assert.equal(d.rushing, false);
    assert.ok(Math.hypot(d.x - start.x, d.z - start.z) < 1.5, 'he holds where he showed');
    run(s, d.rush.at + 0.1);
    if (s.phase === 'live') assert.equal(d.rushing, true, 'then he comes');
  }
  assert.ok(delayed >= 5, 'delayed creepers ' + delayed);
});

test('the plaster rule: once the quarterback scrambles every zone defender takes a receiver and nobody leaves coverage for him', () => {
  let plastered = 0;
  for (let seed = 1; seed <= 10; seed++) for (const coverage of ['cover3', 'cover4', 'cover2']) {
    const s = make(seed, { coverage }), qb = s.byId.QB;
    s.snap();
    // From the step after he leaves the pocket (this step's plan saw him in it).
    let was = false;
    run(s, 3.4, () => {
      const now = s.plastering() && !s.crossedLine, go = now && was;
      was = now;
      if (!go) return;
      plastered++;
      for (const d of s.defense) {
        if (d.rushing || !d.job || d.assign?.kind === 'spy') continue;
        assert.notEqual(d.job.id, 'QB', d.id);
        // Nobody runs at the quarterback while he can still throw.
        const toQB = Math.hypot(qb.x - d.x, qb.z - d.z), speed = Math.hypot(d.vx, d.vz);
        if (speed > 3 && toQB < 12 && toQB > 2) assert.ok((d.vx * (qb.x - d.x) + d.vz * (qb.z - d.z)) / (speed * toQB) < 0.9, `${coverage}/${seed} ${s.time.toFixed(2)}: ${d.id} chases the quarterback`);
      }
      const matched = s.defense.filter(d => d.job?.kind === 'man' && d.job.tech === 'plaster');
      assert.ok(matched.length >= 4, `${coverage}/${seed}: ${matched.length} plastered`);
    }, s => (s.time > 1.2 ? { x: 1, z: -0.15 } : {}));
  }
  assert.ok(plastered > 100, 'plaster steps ' + plastered);
});

test('a spy mirrors the quarterback and attacks him once he leaves the pocket', () => {
  let spies = 0;
  for (let seed = 1; seed <= 60 && spies < 4; seed++) {
    const s = make(seed, { coverage: 'cover1' });
    const spy = s.defense.find(d => d.assign?.kind === 'spy');
    if (!spy) continue;
    spies++;
    const qb = s.byId.QB;
    s.snap();
    run(s, 1.2);
    assert.ok(Math.abs(spy.x - qb.x) < 3 && depth(s, spy) > 2 && depth(s, spy) < 8, `${seed}: mirrors at ${spy.x.toFixed(1)}, ${depth(s, spy).toFixed(1)}`);
    // Out of the pocket: from then on he closes on the quarterback.
    let out = null, gap = null;
    run(s, 4, () => {
      if (out === null && s.scrambling()) { out = s.time; gap = Math.hypot(spy.x - qb.x, spy.z - qb.z); }
    }, () => ({ x: 1, z: -0.1, sprint: true }));
    if (out !== null && s.time > out + 0.6 && !s.crossedLine) assert.ok(Math.hypot(spy.x - qb.x, spy.z - qb.z) < gap - 2, `${seed}: he attacks the scramble`);
  }
  assert.ok(spies >= 2, 'spy calls ' + spies);
});

test('a play fake holds the linebackers for a beat; Rookie bites longest', () => {
  const step = difficulty => {
    let total = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = make(seed, { offense: 'flood', coverage: 'cover3', difficulty }), lb = s.byId.LB2, z0 = lb.z;
      s.snap();
      let least = z0;
      run(s, 1.0, () => { least = Math.min(least, lb.z); });
      assert.ok(least < z0 - 0.3, `${difficulty}/${seed}: the Mike steps downhill`);
      total += lb.bite;
    }
    return total / 6;
  };
  const rookie = step('rookie'), allpro = step('allpro');
  assert.ok(rookie > allpro + 0.15, `bite ${rookie.toFixed(2)} vs ${allpro.toFixed(2)} s`);
});

test('the same seed makes the same calls and plays them the same way', () => {
  const session = () => {
    const s = new Simulation(77, { difficulty: 'allpro' }), log = [];
    for (let i = 0; i < 25; i++) {
      const { layout, rep, weights, ...call } = s.call;
      log.push(JSON.stringify(call), s.defense.map(d => [d.x, d.z]).join());
      s.snap();
      run(s, 2);
      log.push(s.defense.map(d => [d.x.toFixed(6), d.z.toFixed(6), d.job?.kind]).join());
      s.finish('Tackled', 3, 'tackle');
      s.next();
    }
    return log;
  };
  assert.deepEqual(session(), session());
});
