import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP } from '../dist/js/sim.js';
import { PLAYS, RECEIVERS } from '../dist/js/plays.js';
import { SHELLS } from '../dist/js/sim/defense.js';

// Pattern-matching zone coverage (planCoverage): deep men own every vertical
// in their zone, underneath men carry verticals until a deep man has them,
// free men help on the open receiver, and difficulty changes how far.
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const passPlays = PLAYS.filter(p => p.type !== 'run');
// `honest`: show the family's natural shell and rotate at the snap, for the
// tests about how a coverage is played rather than how it is disguised;
// `call` overrides more of the call (press).
function rep(offense, coverage, difficulty, seed = 1, honest = false, call = {}) {
  const s = new Simulation(seed, { offense, coverage, difficulty, mode: 'reps' });
  if (honest) {
    Object.assign(s.call, { shell: SHELLS[s.call.variant === 'cloud' ? 'cloud' : s.coverage][0], disguised: false, timing: 'snap' }, call);
    s.reset();
  }
  s.snap();
  return s;
}
// Step an idle rep until `until` seconds, calling `each` after every step.
function run(s, until, each = () => {}) {
  while (s.time < until - 1e-9 && s.phase === 'live') { s.step(STEP); each(s); }
  return s;
}
const coverDefenders = s => s.defense.filter(d => d.job);

test('a second vertical into a deep zone is not left uncovered', () => {
  let splits = 0;
  for (const coverage of ['cover3', 'cover2']) for (const seed of [1, 2, 3]) {
    run(rep('verts', coverage, 'allpro', seed), 3.2, s => {
      if (s.time < 1.6) return;
      for (const deep of coverDefenders(s).filter(d => d.job.threats)) {
        for (const id of deep.job.threats) {
          // Every vertical in a deep zone is the deep man's own, or someone
          // underneath still has him.
          const carried = s.defense.some(d => d.match === id);
          assert.ok(deep.job.primary === id || carried, `${coverage}/${seed} ${s.time.toFixed(2)}: ${id} in ${deep.id}'s zone is nobody's`);
        }
        if (deep.job.kind !== 'split') continue;
        // Two verticals: he plays between them.
        splits++;
        const xs = [s.byId[deep.job.a].x, s.byId[deep.job.b].x];
        assert.ok(deep.x > Math.min(...xs) - 3 && deep.x < Math.max(...xs) + 3, `${deep.id} between ${deep.job.a} and ${deep.job.b}`);
      }
    });
  }
  assert.ok(splits > 100, 'the deep middle splits the seams: ' + splits);
});

test('an underneath defender carries a seam until the deep middle takes it at All-pro, and releases earlier at Rookie', () => {
  const released = { rookie: [], pro: [] };
  for (const difficulty of ['rookie', 'pro', 'allpro']) for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    // The base 4-3 at every level (personnel changes with the difficulty).
    const s = rep('verts', 'cover3', difficulty, seed, true, { package: 'base' }), carrying = new Map();
    let carried = false, deepBefore = false;
    run(s, 3.6, () => {
      const y = s.byId.Y;
      // Where a carrier gives the seam up to nobody: no other carrier, and no
      // deep man had it before he let go (a deep man takes a handed-off seam
      // on the same step).
      for (const d of s.defense) {
        const now = d.carrying && d.match === 'Y';
        carried ||= now;
        const others = s.defense.some(q => q !== d && q.carrying && q.match === 'Y');
        if (carrying.get(d.id) && !now && !deepBefore && !others && released[difficulty]) released[difficulty].push(y.z - s.spot);
        carrying.set(d.id, now);
      }
      deepBefore = s.defense.some(q => q.job?.primary === 'Y');
      // All-pro: nobody releases him to nobody.
      if (difficulty === 'allpro' && y.z > s.spot + 9) assert.ok(s.defense.some(d => d.match === 'Y' || d.job?.primary === 'Y'), `${seed} ${s.time.toFixed(2)}: the seam is nobody's`);
    });
    assert.ok(carried, `${difficulty}/${seed}: a hook or curl defender carries the seam`);
  }
  // Rookie gives the seam up at his carry depth unless the deep middle is
  // already over it (it is on most seeds: the post safety reads a fast
  // inside release from 3 yd); All-pro never gives it up.
  assert.ok(released.rookie.length >= 1, 'Rookie releases ' + released.rookie.length + '/8');
  for (const depth of released.rookie) assert.ok(depth > 14 && depth < 18, 'Rookie releases at ' + depth.toFixed(1));
  for (const depth of released.pro) assert.ok(depth > 19 && depth < 23, 'Pro releases at ' + depth.toFixed(1));
});

test('a defender with nobody to match leans toward the most open receiver', () => {
  let closer = 0, cases = 0, total = 0;
  for (const coverage of ['cover3', 'cover2']) for (const play of passPlays) {
    const go = help => {
      // Corners off: All-pro presses more often now, and a pressed corner is already on his man.
      const s = rep(play.id, coverage, 'allpro', 1, true, { press: false });
      if (help !== undefined) s.skill = { ...s.skill, help };
      const leans = new Map();
      run(s, 1.8, () => {
        for (const d of coverDefenders(s)) {
          // A defender with a man in his zone never leaves him to help.
          if (d.job.kind === 'lean') assert.equal(d.match, null, d.id + ' leans while he has a man');
          if (d.job.kind === 'lean' && d.job.w === s.skill.help) leans.set(d.id + '>' + d.job.id, (leans.get(d.id + '>' + d.job.id) || 0) + 1);
        }
      });
      return { s, leans };
    };
    const helped = go(), alone = go(0);
    for (const [key, steps] of helped.leans) {
      if (steps < 60) continue;
      const [d, r] = key.split('>'), a = gap(helped.s.byId[d], helped.s.byId[r]), b = gap(alone.s.byId[d], alone.s.byId[r]);
      cases++; total += b - a;
      if (a < b) closer++;
    }
  }
  assert.ok(cases > 20, 'cases ' + cases);
  assert.ok(closer >= cases * 0.8, `closer with help in ${closer}/${cases}`);
  // A deep man keeps his depth over a receiver still in his stem whatever
  // his help, so help moves him mostly across: about 0.7 yd for the deep
  // men, 1.5 to 4 underneath.
  assert.ok(total / cases > 1, 'on average ' + (total / cases).toFixed(1) + ' yd closer');
});

test('zone assignments hold instead of flipping every step', () => {
  let changes = 0, defenders = 0;
  for (const coverage of ['cover3', 'cover2']) for (const play of passPlays) {
    const s = rep(play.id, coverage, 'allpro'), seen = new Map();
    run(s, 3, () => {
      for (const d of coverDefenders(s)) {
        const h = seen.get(d.id) || [];
        if (!h.length || h[h.length - 1].match !== d.match) h.push({ match: d.match, t: s.time });
        seen.set(d.id, h);
      }
    });
    for (const [id, h] of seen) {
      defenders++; changes += h.length - 1;
      // No A, B, A within a quarter second: nobody ping-pongs between two men.
      for (let i = 2; i < h.length; i++) assert.ok(!(h[i].match === h[i - 2].match && h[i].t - h[i - 2].t < 0.25), `${coverage}/${play.id}: ${id} flips ${h[i - 2].match} ${h[i - 1].match} ${h[i].match}`);
      assert.ok(h.length < 9, `${coverage}/${play.id}: ${id} changed his man ${h.length - 1} times`);
    }
  }
  assert.ok(changes / defenders < 2.5, 'mean changes ' + (changes / defenders).toFixed(2));
});

// Share of receivers more than 4 yd past the line with no defender within
// 4 yd, sampled at 1.5, 2, 2.5 and 3 s (the metrics script's openness).
function openness(coverage, difficulty, seeds = [1, 2]) {
  let open = 0, total = 0;
  for (const play of passPlays) for (const seed of seeds) {
    const s = rep(play.id, coverage, difficulty, seed, true);
    for (const t of [1.5, 2, 2.5, 3]) {
      run(s, t);
      if (s.phase !== 'live') break;
      for (const id of RECEIVERS) {
        const r = s.byId[id];
        if (r.z < s.spot + 4) continue;
        total++;
        if (Math.min(...s.defense.filter(d => !d.engaged && d.z > s.spot - 1).map(d => gap(d, r))) > 4) open++;
      }
    }
  }
  return open / total;
}

test('zone coverage tightens with difficulty: Rookie leaves more open men than Pro, Pro more than All-pro', () => {
  // Cover 2's levels sit closer together (about 10 %, 7 % and 6 % open over
  // seeds 1-6 since Rookie reads receivers at 0.30 s instead of 0.40), so it
  // samples more seeds against a smaller margin. Cover 3 spreads about 9-10
  // points (its hooks now pass flat releases on and wall #1 at every level).
  for (const [coverage, seeds, margin] of [['cover3', [1, 2], 0.08], ['cover2', [1, 2, 3, 4, 5, 6], 0.035]]) {
    const [rookie, pro, allpro] = ['rookie', 'pro', 'allpro'].map(k => openness(coverage, k, seeds));
    const shares = [rookie, pro, allpro].map(v => (100 * v).toFixed(1) + '%').join(' > ');
    assert.ok(rookie > pro && pro > allpro, coverage + ': ' + shares);
    assert.ok(rookie - allpro > margin, coverage + ' difficulty matters: ' + shares);
    if (coverage === 'cover3') assert.ok(allpro < 0.3, 'All-pro Cover 3 leaves under 30 % open: ' + shares);
  }
});

test('a flipped play is covered as the mirror image: every defender has the same job', () => {
  // createPlayer mirrors every player's own spot and the call is the same, so
  // each defender is his own mirror; his job must name the same receivers.
  // The rush is taken out (the linemen stand aside), so only coverage is
  // compared.
  const job = d => [d.job?.kind, d.job?.id, d.job?.a, d.job?.b, (d.job?.threats || []).join()].join('/');
  for (const coverage of ['cover3', 'cover4', 'cover1']) for (const offense of ['verts', 'snag', 'scissors']) for (const seed of [1, 2]) {
    const [plain, flipped] = [false, true].map(flip => {
      const s = new Simulation(seed, { offense, coverage, difficulty: 'allpro', mode: 'reps', flip });
      for (const d of s.defense.filter(q => q.rushing || q.role === 'dl')) Object.assign(d, { rushing: false, rush: undefined, assign: null, x: Math.sign(d.x) * 27, z: s.spot + 40 });
      s.snap();
      return s;
    });
    assert.equal(flipped.call.description, plain.call.description);
    for (const t of [1.5, 2.5]) {
      run(plain, t); run(flipped, t);
      for (const d of plain.defense) if (!d.rushing) assert.equal(job(flipped.byId[d.id]), job(d), `${coverage}/${offense}/${seed} ${t} s: ${d.id}`);
    }
  }
});

test('a Cover 2 corner sinks with an outside go route when his flat is empty', () => {
  for (const seed of [1, 2, 3]) {
    const s = run(rep('verts', 'cover2', 'allpro', seed), 2.2);
    const cb = s.byId.CB1, x = s.byId.X;
    assert.equal(cb.job.kind, 'man', seed + ': the corner carries the go route');
    assert.equal(cb.job.id, 'X');
    assert.ok(gap(cb, x) < 4, seed + ': with him at ' + gap(cb, x).toFixed(1));
  }
});

test('in Cover 0 the man whose back stays in to block robs the shallow middle', () => {
  let robbed = 0;
  for (const seed of [1, 2, 3, 4]) {
    const s = rep('mesh', 'blitz', 'pro', seed), d = s.defense.find(q => q.assign?.kind === 'man' && q.assign.id === 'R');
    assert.ok(d, seed + ': somebody has the back');
    run(s, 2.2);
    if (!s.byId.R.pickup) continue;
    robbed++;
    assert.notEqual(d.job.kind, 'man', `${seed}: ${d.id} is free`);
    assert.ok(d.z - s.spot > 2 && d.z - s.spot < 13 && Math.abs(d.x) < 15, `${seed}: ${d.id} robbing at ${d.x.toFixed(1)}, ${(d.z - s.spot).toFixed(1)}`);
  }
  assert.ok(robbed >= 3, 'the back stayed in ' + robbed + '/4');
});

test('a robber never picks up a receiver past his hand-off depth, so he does not ping-pong between two', () => {
  let rats = 0;
  for (const difficulty of ['rookie', 'pro']) for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const s = rep('slants', 'cover1', difficulty, seed), d = s.defense.find(q => q.assign?.kind === 'rat');
    if (!d) continue;
    rats++;
    const h = [];
    let flips = 0;
    run(s, 4, () => {
      h.push(d.job?.id || '-');
      const L = h.length;
      if (L >= 3 && h[L - 1] !== '-' && h[L - 2] !== '-' && h[L - 1] === h[L - 3] && h[L - 1] !== h[L - 2]) flips++;
    });
    assert.ok(flips <= 2, `${difficulty}/${seed}: ${d.id} flips between two men ${flips} times`);
  }
  assert.ok(rats >= 2, 'robber calls ' + rats);
});

test('a two-deep half or an empty deep middle leaning toward a vertical keeps his depth', () => {
  // The underneath man's "sink under the vertical" is not a deep man's: the
  // middle of the field keeps its landmark depth (an outside man stays on
  // top of the receiver).
  let leans = 0;
  for (const coverage of ['cover2', 'cover3']) for (const play of ['verts', 'mesh', 'flood', 'curlflat']) for (const seed of [1, 2]) {
    run(rep(play, coverage, 'allpro', seed, true), 2.2, s => {
      for (const d of s.defense) {
        const j = d.job;
        if (d.assign?.kind !== 'deep' || j?.kind !== 'lean') continue;
        assert.ok(j.floor, `${coverage}/${play}/${seed}: ${d.id}'s lean has a floor`);
        const r = s.coverSeen[j.id];
        if (!j.keep || !(r.z > s.spot + 7 && r.vz > 2)) continue;
        leans++;
        assert.ok(d.want.z > -2.5, `${coverage}/${play}/${seed} ${s.time.toFixed(2)}: ${d.id} comes downhill (${d.want.z.toFixed(1)} yd/s) under ${j.id}`);
      }
    });
  }
  assert.ok(leans > 50, 'deep leans on a vertical ' + leans);
});

test('the Tampa 2 pole runner runs the middle instead of leaning on a checkdown', () => {
  let poles = 0;
  for (const play of passPlays) for (const seed of [1, 2]) {
    const s = rep(play.id, 'tampa2', 'allpro', seed, true), d = s.defense.find(q => q.assign?.role === 'pole');
    if (!d) continue;
    poles++;
    run(s, 2.5, () => {
      const j = d.job, r = j?.id && s.coverSeen[j.id];
      if (j?.kind === 'lean') assert.ok(r.z > s.spot + 7, `${play.id}/${seed} ${s.time.toFixed(2)}: ${d.id} leans on ${j.id} at ${(r.z - s.spot).toFixed(1)} yd`);
    });
    assert.ok(d.z - s.spot > 9, `${play.id}/${seed}: the pole runner ends at ${(d.z - s.spot).toFixed(1)} yd`);
  }
  assert.ok(poles >= 10, 'pole runners ' + poles);
});

test('once the quarterback has scrambled the plaster rule holds even when he steps back inside the pocket box', () => {
  let back = 0;
  for (const seed of [1, 2, 3]) {
    const s = new Simulation(seed, { offense: 'verts', coverage: 'cover3', difficulty: 'allpro', mode: 'reps' });
    for (const d of s.defense.filter(q => q.rushing || q.role === 'dl')) Object.assign(d, { rushing: false, rush: undefined, assign: null, x: Math.sign(d.x) * 27, z: s.spot + 40 });
    s.snap();
    let dir = 1;
    while (s.time < 3.4 && s.phase === 'live') {
      const qb = s.byId.QB, off = qb.x - s.rushState().launch.x;
      if (off > 4.8) dir = -1;
      if (off < 3) dir = 1;
      s.step(STEP, s.time > 0.3 ? { x: dir, z: 0 } : {});
      if (s.phase !== 'live' || s.crossedLine || !s.call.rep.scrambled) continue;
      if (!s.scrambling()) back++;
      assert.ok(s.plastering(), `${seed} ${s.time.toFixed(2)}: plastering after the scramble`);
    }
  }
  assert.ok(back > 20, 'steps back inside the box ' + back);
});

test('a quarters safety with no #1 on his side does not crash', () => {
  const s = rep('mesh', 'cover4', 'allpro', 1);
  s.call.layout.nums[1] = [];
  assert.doesNotThrow(() => run(s, 1.5));
});

test('a delayed rusher shows a drop before his count instead of standing still', () => {
  let shown = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const s = rep('mesh', 'creeper', 'allpro', seed), d = s.defense.find(p => p.rush && p.rush.at >= 0.5);
    if (!d) continue;
    shown++;
    const start = { x: d.x, z: d.z };
    run(s, d.rush.at - 0.02);
    assert.equal(d.rushing, false);
    const moved = Math.hypot(d.x - start.x, d.z - start.z);
    assert.ok(moved > 0.15 && moved < 1.5 && d.z > start.z, `${seed}: ${d.id} moved ${moved.toFixed(2)} yd`);
  }
  assert.ok(shown >= 3, 'delayed rushers ' + shown);
});

test('a deep man reads the throwing motion only after his reaction time', () => {
  let reads = 0;
  for (const coverage of ['cover3', 'cover1']) for (const seed of [1, 2, 3]) {
    const s = run(rep('verts', coverage, 'allpro', seed), 1.8), z = s.defense.find(d => d.job?.kind === 'split');
    if (!z || !s.requestThrow(z.job.a)) continue;
    const t0 = s.time;
    let at = null;
    run(s, t0 + 0.3, () => { if (at === null && z.eyesOn) at = s.time - t0; });
    if (at === null) continue;
    reads++;
    assert.ok(at >= z.latency - 1e-6, `${coverage}/${seed}: eyes on ${at.toFixed(3)} s after the wind-up, latency ${z.latency}`);
  }
  assert.ok(reads >= 2, 'eyes reads ' + reads);
});

test('a deep or quarters job does not flip and back on consecutive steps on a noisy read', () => {
  // The half widening with #1, a half keeping a vertical, a quarters safety
  // reading #2: once in, each holds while the receiver keeps coming.
  let flips = 0, reps = 0;
  for (const coverage of ['cover2', 'cover4', 'cover6']) for (const play of passPlays) for (const seed of [2]) {
    const s = rep(play.id, coverage, 'allpro', seed), hist = new Map();
    reps++;
    run(s, 3, () => {
      for (const d of s.defense) {
        if (!d.job || !['deep', 'quarter'].includes(d.assign?.kind)) continue;
        const h = hist.get(d.id) || [], key = d.job.kind + '>' + (d.job.id || '');
        h.push(key); hist.set(d.id, h);
        const L = h.length;
        if (L >= 3 && h[L - 1] === h[L - 3] && h[L - 1] !== h[L - 2]) flips++;
      }
    });
  }
  assert.ok(flips <= reps * 0.15, `${flips} one-step flips in ${reps} reps`);
});
