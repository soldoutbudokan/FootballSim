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
// tests about how a coverage is played rather than how it is disguised.
function rep(offense, coverage, difficulty, seed = 1, honest = false) {
  const s = new Simulation(seed, { offense, coverage, difficulty, mode: 'reps' });
  if (honest) {
    Object.assign(s.call, { shell: SHELLS[s.call.variant === 'cloud' ? 'cloud' : s.coverage][0], disguised: false, timing: 'snap' });
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
  for (const difficulty of ['rookie', 'pro', 'allpro']) for (const seed of [1, 2, 3]) {
    const s = rep('verts', 'cover3', difficulty, seed, true), carrying = new Map();
    let carried = false;
    run(s, 3.6, () => {
      const y = s.byId.Y;
      // Where a carrier gives the seam up to nobody: no other carrier and
      // no deep man on it.
      const nobody = !s.defense.some(q => q.job?.primary === 'Y' || (q.carrying && q.match === 'Y'));
      for (const d of s.defense) {
        const now = d.carrying && d.match === 'Y';
        carried ||= now;
        if (carrying.get(d.id) && !now && nobody && released[difficulty]) released[difficulty].push(y.z - s.spot);
        carrying.set(d.id, now);
      }
      // All-pro: nobody releases him to nobody.
      if (difficulty === 'allpro' && y.z > s.spot + 9) assert.ok(s.defense.some(d => d.match === 'Y' || d.job?.primary === 'Y'), `${seed} ${s.time.toFixed(2)}: the seam is nobody's`);
    });
    assert.ok(carried, `${difficulty}/${seed}: a hook or curl defender carries the seam`);
  }
  // Rookie gives the seam up at his carry depth unless the deep middle is
  // already over it (it is on some seeds); All-pro never gives it up.
  assert.ok(released.rookie.length >= 2, 'Rookie releases ' + released.rookie.length + '/3');
  for (const depth of released.rookie) assert.ok(depth > 14 && depth < 18, 'Rookie releases at ' + depth.toFixed(1));
  for (const depth of released.pro) assert.ok(depth > 19 && depth < 23, 'Pro releases at ' + depth.toFixed(1));
});

test('a defender with nobody to match leans toward the most open receiver', () => {
  let closer = 0, cases = 0, total = 0;
  for (const coverage of ['cover3', 'cover2']) for (const play of passPlays) {
    const go = help => {
      const s = rep(play.id, coverage, 'allpro', 1, true);
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
  assert.ok(total / cases > 1.5, 'on average ' + (total / cases).toFixed(1) + ' yd closer');
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
  // Cover 2's levels sit closer together (about 18 %, 14 % and 10 % open over
  // seeds 1-6, a pair of seeds giving a 6 to 10 point spread), so it samples
  // more seeds against a smaller margin. Cover 3 spreads about 18 points.
  for (const [coverage, seeds, margin] of [['cover3', [1, 2], 0.1], ['cover2', [1, 2, 3, 4, 5, 6], 0.05]]) {
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
