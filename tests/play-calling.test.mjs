import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, seededRandom } from '../dist/js/sim.js';
import { PLAYS } from '../dist/js/plays.js';
import { CLASSES, callPlay, playWeights, profilePlay, readSituation, routesThere } from '../dist/js/sim/offense.js';

// The offensive coordinator (offense.js): what "Coordinator's call" calls
// for the down, the distance and the field.
const situ = (down, toGo, spot = 35, mode = 'drive') => ({ down, toGo, spot, mode });
function draws(situation, n, seed = 1) {
  const random = seededRandom(seed), out = [];
  for (let i = 0; i < n; i++) out.push(callPlay(situation, random()));
  return out;
}
const share = (list, test) => list.filter(test).length / list.length;
const cls = p => profilePlay(p).cls;
// A concept with nothing past `d` yd: every route settles short of it.
const short = (p, d) => p.type !== 'run' && routesThere(p, d) === 0;

test('every play has a class, and the weights are a distribution over the book', () => {
  for (const p of PLAYS) assert.ok(CLASSES.includes(cls(p)), p.id);
  for (const c of CLASSES) assert.ok(PLAYS.some(p => cls(p) === c), 'a play in class ' + c);
  for (const s of [situ(1, 10), situ(3, 1), situ(3, 12), situ(4, 21), situ(1, 3, 107), situ(2, 8, 15), situ(1, 10, 100, 'reps')]) {
    const w = playWeights(s);
    assert.equal(w.length, PLAYS.length);
    assert.ok(w.every(v => v >= 0 && Number.isFinite(v)));
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9, JSON.stringify(s));
  }
});

test('1st and 10 is balanced and calls the whole book; 2nd and long leans pass', () => {
  const w = playWeights(situ(1, 10));
  assert.ok(w.every(v => v >= 0.004), 'every play is in the call on 1st and 10');
  const first = draws(situ(1, 10), 3000), second = draws(situ(2, 10), 3000, 2);
  const runs = share(first, p => p.type === 'run');
  assert.ok(runs > 0.33 && runs < 0.55, 'runs on 1st and 10: ' + runs.toFixed(2));
  assert.equal(new Set(first.map(p => p.id)).size, PLAYS.length);
  assert.ok(share(second, p => p.type === 'run') < runs - 0.1, 'fewer runs on 2nd and 10');
});

test('no designed run on 3rd or 4th and long, ever', () => {
  for (const [down, toGo] of [[4, 21], [3, 12], [3, 7], [4, 9], [3, 30]]) {
    for (const p of draws(situ(down, toGo), 1500, down * 100 + toGo)) assert.notEqual(p.type, 'run', `${down} and ${toGo}: ${p.id}`);
  }
});

test('3rd and 12 never calls a concept that cannot reach the sticks', () => {
  const w = playWeights(situ(3, 12));
  PLAYS.forEach((p, i) => {
    if (p.type === 'run' || short(p, 12)) assert.equal(w[i], 0, p.id);
  });
  for (const id of ['spacing', 'hank', 'curlflat', 'slants']) assert.equal(w[PLAYS.findIndex(p => p.id === id)], 0, id);
  const calls = draws(situ(3, 12), 2000, 7);
  assert.ok(calls.every(p => p.type !== 'run' && routesThere(p, 12) > 0));
  assert.ok(share(calls, p => cls(p) === 'mid' || cls(p) === 'shot') > 0.8, 'intermediate and deep concepts');
  // On 4th and 21 mostly shots.
  assert.ok(share(draws(situ(4, 21), 2000, 8), p => cls(p) === 'shot') > 0.5);
});

test('3rd and 1 calls runs and the quick game most of the time, inside runs first', () => {
  const calls = draws(situ(3, 1), 3000, 3);
  assert.ok(share(calls, p => cls(p) === 'run' || cls(p) === 'quick') > 0.6, 'runs and quick game');
  assert.ok(share(calls, p => cls(p) === 'run' || cls(p) === 'quick' || cls(p) === 'pa') > 0.75, 'with play action');
  const w = playWeights(situ(3, 1)), of = id => w[PLAYS.findIndex(p => p.id === id)];
  assert.ok(of('zone') > of('widezone') && of('duo') > of('sweep'), 'downhill over wide');
});

test('3rd and medium favours routes that break past the sticks', () => {
  const calls = draws(situ(3, 5), 3000, 4);
  assert.ok(share(calls, p => cls(p) === 'mid' || cls(p) === 'quick') > 0.6);
  assert.ok(share(calls, p => p.type === 'run') < 0.2);
  assert.ok(share(calls, p => p.type !== 'run' && routesThere(p, 5) >= 2) > 0.7);
});

test('the goal line favours runs and compressed routes', () => {
  const goal = draws(situ(1, 3, 107), 3000, 5), open = draws(situ(1, 10), 3000, 5);
  assert.ok(share(goal, p => cls(p) === 'shot') < 0.03, 'almost no shots inside the 5');
  assert.ok(share(goal, p => cls(p) === 'run' || cls(p) === 'quick') > 0.6);
  const depth = list => { const passes = list.filter(p => p.type !== 'run'); return passes.reduce((a, p) => a + profilePlay(p).depth, 0) / passes.length; };
  assert.ok(depth(goal) < depth(open) - 1, `first-read depth ${depth(goal).toFixed(1)} vs ${depth(open).toFixed(1)}`);
  // Passes whose first reads break 10 yd or deeper, past the back of the end zone from the 3.
  const deepReads = list => share(list.filter(p => p.type !== 'run'), p => profilePlay(p).depth >= 10);
  assert.ok(deepReads(goal) < deepReads(open) / 2, `deep reads ${deepReads(goal).toFixed(2)} vs ${deepReads(open).toFixed(2)}`);
  // In the red zone fewer shots than between the 20s.
  assert.ok(share(draws(situ(1, 10, 92), 3000, 6), p => cls(p) === 'shot') < share(open, p => cls(p) === 'shot'));
});

test('backed up, he stays safe: fewer fakes and shots', () => {
  const backed = draws(situ(1, 10, 14), 3000, 9), open = draws(situ(1, 10), 3000, 9);
  const risky = p => cls(p) === 'pa' || cls(p) === 'shot';
  assert.ok(share(backed, risky) < share(open, risky) - 0.04);
});

test('repeat-the-spot reps call 1st and 10 unless the spot is in the red zone', () => {
  assert.deepEqual(playWeights(situ(3, 15, 35, 'reps')), playWeights(situ(1, 10)));
  assert.deepEqual(playWeights(situ(1, 10, 14, 'reps')), playWeights(situ(1, 10)), 'no backed-up call in reps');
  assert.equal(readSituation(situ(1, 10, 100, 'reps')).field, 'red');
  assert.notDeepEqual(playWeights(situ(1, 10, 100, 'reps')), playWeights(situ(1, 10)));
});

test('every play is callable somewhere', () => {
  const grid = [];
  for (const down of [1, 2, 3, 4]) for (const toGo of [1, 2, 4, 6, 8, 10, 14, 21]) for (const spot of [14, 35, 60, 92, 105, 108]) {
    if (toGo <= 110 - spot) grid.push(playWeights(situ(down, toGo, spot)));
  }
  PLAYS.forEach((p, i) => assert.ok(Math.max(...grid.map(w => w[i])) > 0.02, p.id));
});

test('the call takes exactly one draw, so a seed makes the same calls', () => {
  const count = offense => {
    const s = new Simulation(5, { offense, mode: 'drive' });
    let n = 0;
    const random = s.random;
    s.random = () => { n++; return random(); };
    s.reset(true);
    return n;
  };
  assert.equal(count('random'), count('mesh') + 1);
  const session = () => {
    const s = new Simulation(31, { mode: 'drive' }), log = [];
    for (let i = 0; i < 30; i++) { log.push(s.play.id); s.snap(); s.finish('Tackled', 3, 'tackle'); s.next(); }
    return log;
  };
  assert.deepEqual(session(), session());
});

test('Coordinator’s call in drive mode makes sensible calls across a drive', () => {
  const fourthShort = [];
  for (let seed = 1; seed <= 80; seed++) {
    const s = new Simulation(seed, { offense: 'random', mode: 'drive', difficulty: 'pro' });
    // 1st and 10, sacked for 6: 2nd and 16; incomplete: 3rd and 16.
    s.snap(); s.finish('Sacked', -6, 'sack'); s.next();
    assert.equal(s.down, 2); assert.equal(s.toGo, 16);
    s.snap(); s.finish('Incomplete', 0, 'incomplete'); s.next();
    assert.equal(s.down, 3); assert.equal(s.toGo, 16);
    assert.notEqual(s.play.type, 'run', `seed ${seed}: 3rd and 16 ${s.play.id}`);
    assert.ok(routesThere(s.play, 16) > 0, `seed ${seed}: 3rd and 16 ${s.play.id} reaches the sticks`);
    // Gain 15: 4th and 1.
    s.snap(); s.finish('Tackled', 15, 'tackle'); s.next();
    assert.equal(s.down, 4); assert.equal(s.toGo, 1);
    fourthShort.push(s.play);
  }
  assert.ok(share(fourthShort, p => cls(p) === 'run' || cls(p) === 'quick' || cls(p) === 'pa') > 0.65);
});
