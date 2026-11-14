import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, STEP, seededRandom } from '../dist/js/sim.js';
import { PLAYS } from '../dist/js/plays.js';
import { CLOCK, HURRY, KICK, SCENARIO, fieldGoalOdds, kickDistance, makeScenario, needText } from '../dist/js/sim/comeback.js';
import { playWeights, profilePlay, readSituation } from '../dist/js/sim/offense.js';

// The fourth-quarter comeback (sim/comeback.js): the game around the downs.
// Plays are ended by hand (finish) where the play itself is not the subject.
function advance(s, seconds, input = {}) { for (let i = 0; i < Math.round(seconds / STEP); i++) s.step(STEP, input); }
function until(s, done, limit = 40) { let t = 0; while (!done() && t < limit) { s.step(STEP); t += STEP; } return t; }
function comeback(scenario = {}, seed = 3, options = {}) {
  return new Simulation(seed, { mode: 'comeback', difficulty: 'pro', offense: 'mesh', ...options,
    scenario: { deficit: 3, clock: 90, timeouts: 2, spot: 50, down: 1, toGo: 10, ...scenario } });
}
// One play: snapped, `seconds` long, ended as given. Only its first half
// second is simulated (nothing can end a play that early); the rest comes
// off the clock by hand, so no pass rush decides the test.
function play(s, label, yards, kind, seconds = 4) {
  assert.equal(s.snap(), true, 'snap');
  advance(s, Math.min(seconds, 0.5));
  if (s.game.running) s.game.clock = Math.max(0, s.game.clock - Math.max(0, seconds - 0.5));
  assert.equal(s.phase, 'live');
  s.finish(label, yards, kind);
}
const tackle = (s, yards, seconds) => play(s, 'Tackled', yards, 'tackle', seconds);
const incomplete = (s, seconds) => play(s, 'Incomplete', 0, 'incomplete', seconds);
const near = (a, b, eps = 0.02) => Math.abs(a - b) < eps;
// The lineup's own clock: seconds since the whistle.
function lineUp(s) { return until(s, () => !s.lining); }

test('scenarios: a seed makes the same one, every one is a drive that can still be won', () => {
  assert.deepEqual(makeScenario(seededRandom(9)), makeScenario(seededRandom(9)));
  const random = seededRandom(4), deficits = new Set(), timeouts = new Set();
  let midDrive = 0;
  for (let i = 0; i < 600; i++) {
    const s = makeScenario(random);
    deficits.add(s.deficit); timeouts.add(s.timeouts);
    assert.ok(s.deficit >= 1 && s.deficit <= 7 && s.us === s.them - s.deficit && s.us >= 0, JSON.stringify(s));
    assert.ok(s.clock >= SCENARIO.min && s.clock <= SCENARIO.max && Number.isInteger(s.clock));
    assert.ok(s.spot >= 28 && s.spot <= 75 && s.down >= 1 && s.down <= 4 && s.toGo >= 1 && s.toGo <= 10);
    if (s.down === 1) assert.equal(s.toGo, 10);
    if (s.down > 1 || s.spot > 50) midDrive++;
    // Never asked to cover the yards faster than a second a yard and a quarter-minute.
    const yards = (s.deficit <= 3 ? 110 - KICK.range : 110) - s.spot;
    assert.ok(s.clock + s.timeouts * SCENARIO.timeout >= SCENARIO.base + Math.max(SCENARIO.least, yards) * SCENARIO.pace[0] - 1 || s.clock === SCENARIO.max, JSON.stringify(s));
  }
  assert.deepEqual([...deficits].sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...timeouts].sort(), [0, 1, 2, 3]);
  assert.ok(midDrive > 100 && midDrive < 400, 'some pick the drive up in the middle: ' + midDrive);
  // The random draw takes the same eight numbers whatever it decides.
  const a = seededRandom(2), b = seededRandom(2);
  makeScenario(a); for (let i = 0; i < 8; i++) b();
  assert.equal(a(), b());
});

test('a comeback starts on its scenario, behind, with the clock stopped until the snap', () => {
  const s = comeback({ deficit: 6, clock: 75, timeouts: 1, spot: 42, down: 2, toGo: 7, them: 24 });
  const g = s.game;
  assert.equal(s.config.mode, 'comeback');
  assert.deepEqual([g.us, g.them, g.clock, g.timeouts, s.spot, s.down, s.toGo], [18, 24, 75, 1, 42, 2, 7]);
  assert.equal(g.running, false); assert.equal(g.stopped, 'start'); assert.equal(g.stage, 'drive'); assert.equal(g.over, null);
  assert.equal(s.ready, true);
  advance(s, 2);
  assert.equal(g.clock, 75, 'the clock waits for the snap');
  // A random scenario when none is given; practice has no game at all.
  const random = new Simulation(7, { mode: 'comeback' });
  assert.ok(random.game.scenario.deficit >= 1 && random.game.clock === random.game.scenario.clock);
  assert.equal(new Simulation(7).game, null);
  assert.equal(random.configure({ mode: 'drive' }), true);
  assert.equal(random.game, null); assert.equal(random.down, 1);
  assert.equal(random.configure({ mode: 'comeback', scenario: { deficit: 2, clock: 30, spot: 70 } }), true);
  assert.deepEqual([random.game.us - random.game.them, random.game.clock, random.spot], [-2, 30, 70]);
});

test('the clock runs through a play and on after a tackle in bounds, in real time', () => {
  const s = comeback();
  tackle(s, 6, 4);
  const g = s.game;
  assert.ok(near(g.clock, 86), 'four seconds of play: ' + g.clock);
  assert.equal(g.running, true); assert.equal(g.stopped, null); assert.equal(g.playClock, CLOCK.play);
  assert.deepEqual(g.next, { spot: 56, down: 2, toGo: 4 });
  advance(s, 3);
  assert.ok(near(g.clock, 83) && near(g.playClock, 37), 'three more with the ball dead');
  // A first down does not stop it; neither does a sack.
  const first = comeback();
  tackle(first, 14);
  assert.equal(first.game.running, true); assert.deepEqual(first.game.next, { spot: 64, down: 1, toGo: 10 });
  const sack = comeback();
  play(sack, 'Sacked', -7, 'sack');
  assert.equal(sack.game.running, true); assert.deepEqual(sack.game.next, { spot: 43, down: 2, toGo: 17 });
});

test('an incompletion, a throw-away and a runner out of bounds stop the clock until the snap', () => {
  for (const [label, kind] of [['Incomplete', 'incomplete'], ['Out of bounds', 'out']]) {
    const s = comeback();
    play(s, label, kind === 'out' ? 5 : 0, kind, 3);
    assert.equal(s.game.running, false); assert.equal(s.game.stopped, kind); assert.equal(s.game.playClock, null);
    const left = s.game.clock;
    advance(s, 5);
    assert.equal(s.game.clock, left, kind + ': stopped');
    assert.equal(s.next(), true);
    assert.equal(s.phase, 'presnap'); assert.equal(s.lining, null, 'no hurry: the offense is simply at the line');
    assert.equal(s.ready, true);
    advance(s, 5);
    assert.equal(s.game.clock, left);
    s.snap(); advance(s, 1);
    assert.ok(near(s.game.clock, left - 1), 'running again from the snap');
  }
  const away = comeback();
  away.snap(); advance(away, 1);
  assert.equal(away.throwAway(), true);
  assert.equal(away.game.stopped, 'incomplete'); assert.deepEqual(away.game.next, { spot: 50, down: 2, toGo: 10 });
});

test('no huddle: everybody runs to the line from where the play left him, and nobody snaps until all are set', () => {
  const s = comeback();
  s.snap();
  advance(s, 1.8);
  assert.equal(s.requestThrow('X', 'touch'), true);
  while (s.phase !== 'dead') s.step(STEP, { z: 1, sprint: true });
  assert.equal(s.result.kind, 'tackle');
  assert.equal(s.game.running, true);
  const whistle = s.game.clock, gain = s.result.yards;
  advance(s, 0.4);
  const before = new Map(s.players.map(p => [p.id, { x: p.x, z: p.z }]));
  assert.equal(s.hurry(), true);
  assert.equal(s.phase, 'presnap'); assert.ok(s.lining); assert.equal(s.ready, false);
  assert.equal(s.snap(), false, 'not set: no snap');
  assert.equal(s.spot, 50 + gain); assert.equal(s.down, gain >= 10 ? 1 : 2);
  // Everybody starts where he stood, not on his spot.
  for (const p of s.players) assert.ok(near(p.x, before.get(p.id).x, 1e-9) && near(p.z, before.get(p.id).z, 1e-9), p.id);
  assert.ok(s.players.filter(p => Math.hypot(p.x - p.start.x, p.z - p.start.z) > 1).length > 8);
  const snapshot = s.snapshot();
  assert.equal(snapshot.lining, true); assert.equal(snapshot.phase, 'presnap');
  assert.ok(snapshot.tackle && snapshot.deadTime > 0.39 && snapshot.time > 2, 'the dead ball carries on for the animation');
  // The man who was tackled stays down for a moment; the others are already moving.
  advance(s, 0.6);
  const carrier = s.byId[snapshot.tackle.carrier];
  assert.ok(near(carrier.x, before.get(carrier.id).x, 1e-9), 'the runner is still getting up');
  assert.ok(s.players.filter(p => Math.hypot(p.vx, p.vz) > 1).length > 8, 'the rest are on their way');
  for (const p of s.players) assert.ok(Math.hypot(p.vx, p.vz) <= p.top * 0.75, p.id + ' hustles, nobody sprints');
  const took = 1 + lineUp(s);
  assert.equal(s.ready, true);
  for (const p of s.players) {
    assert.ok(p.x === p.start.x && p.z === p.start.z && p.vx === 0 && p.vz === 0, p.id + ' on his spot');
    assert.equal(p.facing, p.team === 'offense' ? 0 : Math.PI);
  }
  // The ball is ready seven seconds after the whistle at the earliest.
  assert.ok(took >= HURRY.spot - 0.01 && took < 12, 'lined up after ' + took.toFixed(1) + ' s');
  assert.ok(near(s.game.clock, whistle - took, 0.05), 'the clock ran the whole time');
  assert.equal(s.snapshot().lining, false);
  assert.equal(s.recording.length, 1, 'the next replay starts from the stances');
  assert.equal(s.snap(), true);
  advance(s, 2);
  assert.ok(s.players.every(p => Number.isFinite(p.x) && Number.isFinite(p.z)));
});

test('a lineup after a long gain takes longer; a play called on the way changes where they go', () => {
  const short = comeback(), long = comeback();
  tackle(short, 5); tackle(long, 5);
  // The same dead ball, but the long one leaves the offense 30 yd behind the new spot.
  for (const p of long.offense) p.z -= 30;
  long.game.next.spot += 0;
  short.hurry(); long.hurry();
  const a = lineUp(short), b = lineUp(long);
  assert.ok(b > a + 2, `30 yd farther to run: ${a.toFixed(1)} s against ${b.toFixed(1)} s`);
  assert.ok(b < HURRY.most);
  // A new call in the middle of a lineup: the lineup goes on to the new formation.
  const s = comeback();
  tackle(s, 5);
  s.hurry();
  advance(s, 1);
  const at = { x: s.byId.Y.x, z: s.byId.Y.z }, serial = s.serial;
  assert.equal(s.setPlay('stick'), true);
  assert.equal(s.play.id, 'stick'); assert.ok(s.lining); assert.equal(s.serial, serial + 1);
  assert.ok(near(s.byId.Y.x, at.x, 1e-9) && near(s.byId.Y.z, at.z, 1e-9), 'nobody jumps');
  lineUp(s);
  assert.equal(s.byId.Y.x, s.byId.Y.start.x);
  assert.equal(s.ready, true);
});

test('the defense cannot substitute against a no-huddle offense', () => {
  // All-pro matches personnel every down: dime against empty out of a huddle.
  const s = comeback({ clock: 140 }, 5, { difficulty: 'allpro', offense: PLAYS.find(p => p.formationId === 'tight').id });
  const pkg = s.personnel;
  assert.equal(pkg, 'nickel', 'the two-minute defense moves up one against two wide');
  tackle(s, 4);
  s.setPlay(PLAYS.find(p => p.formationId === 'empty').id);
  assert.equal(s.hurry(), true);
  assert.equal(s.play.formationId, 'empty');
  assert.equal(s.personnel, pkg, 'the men on the field stay on it');
  lineUp(s);
  // After a huddle the same call is matched.
  incomplete(s);
  assert.equal(s.next(), true);
  assert.equal(s.personnel, 'dime');
});

test('a huddle has the offense back at the line 25 s after the whistle', () => {
  const s = comeback();
  tackle(s, 5);
  const whistle = s.game.clock;
  advance(s, 3);
  assert.equal(s.huddle(), true);
  assert.equal(s.phase, 'presnap'); assert.equal(s.lining, null); assert.equal(s.ready, true);
  assert.ok(near(s.game.clock, whistle - CLOCK.huddle) && near(s.game.playClock, CLOCK.play - CLOCK.huddle));
  assert.equal(s.game.running, true);
  advance(s, 2);
  assert.ok(near(s.game.clock, whistle - CLOCK.huddle - 2), 'still running at the line');
  // With the clock stopped there is nothing to pay; with too little time the game ends in the huddle.
  const stopped = comeback();
  incomplete(stopped);
  assert.equal(stopped.huddle(), false);
  const late = comeback({ clock: 20 });
  tackle(late, 5, 2);
  assert.equal(late.huddle(), true);
  assert.equal(late.game.over.result, 'loss'); assert.equal(late.game.over.reason, 'Time expired'); assert.equal(late.game.clock, 0);
});

test('a timeout stops the clock at once, between plays only, and there are only so many', () => {
  const s = comeback({ timeouts: 1 });
  assert.equal(s.timeout(), false, 'stopped already');
  s.snap(); advance(s, 1);
  assert.equal(s.timeout(), false, 'not during a play');
  s.finish('Tackled', 4, 'tackle');
  advance(s, 1.5);
  const left = s.game.clock;
  assert.equal(s.timeout(), true);
  assert.equal(s.game.timeouts, 0); assert.equal(s.game.running, false); assert.equal(s.game.stopped, 'timeout');
  advance(s, 4);
  assert.equal(s.game.clock, left);
  assert.equal(s.next(), true); assert.equal(s.lining, null);
  tackle(s, 3);
  assert.equal(s.timeout(), false, 'none left');
  assert.equal(s.game.running, true);
  // Called on the way to the line, it ends the hurry: everybody is set.
  const line = comeback();
  tackle(line, 3);
  line.hurry(); advance(line, 1);
  assert.equal(line.timeout(), true);
  assert.equal(line.lining, null); assert.equal(line.ready, true);
  assert.ok(line.players.every(p => p.x === p.start.x && p.z === p.start.z));
});

test('a spike lines up without a huddle, stops the clock and costs the down', () => {
  const s = comeback();
  tackle(s, 12);
  const attempts = s.stats.attempts;
  assert.equal(s.spikeBall(), true);
  assert.ok(s.lining); assert.equal(s.spikeCall, true);
  const took = until(s, () => s.phase === 'dead');
  assert.ok(took > HURRY.spot && took < HURRY.spot + 3, 'snapped as soon as they were set: ' + took.toFixed(1));
  assert.equal(s.result.label, 'Spiked'); assert.equal(s.result.kind, 'incomplete'); assert.equal(s.result.spike, true);
  assert.equal(s.game.running, false); assert.equal(s.game.stopped, 'spike');
  assert.deepEqual(s.game.next, { spot: 62, down: 2, toGo: 10 });
  assert.equal(s.stats.attempts, attempts + 1, 'an incomplete pass');
  assert.ok(s.result.time < 1, 'under a second off the clock');
  advance(s, 1);
  assert.ok(s.ball.y < 0.2, 'the ball is on the turf');
  // No spike with the clock stopped; on fourth down it turns the ball over.
  assert.equal(s.spikeBall(), false);
  const fourth = comeback({ down: 4, toGo: 3 });
  tackle(fourth, 5);
  fourth.spikeBall();
  until(fourth, () => fourth.phase === 'dead' || fourth.game.over);
  assert.equal(fourth.down, 1, 'that fourth down was converted');
  const last = comeback({ down: 3, toGo: 8 });
  tackle(last, 2);
  last.spikeBall();
  until(last, () => last.phase === 'dead');
  assert.equal(last.game.over.result, 'loss'); assert.equal(last.game.over.reason, 'Turned over on downs');
  // A play called before the snap takes the spike off.
  const change = comeback();
  tackle(change, 3);
  change.spikeBall();
  assert.equal(change.setPlay('slants'), true);
  lineUp(change);
  advance(change, 1);
  assert.equal(change.phase, 'presnap'); assert.equal(change.ready, true); assert.equal(change.play.id, 'slants');
});

test('the two-minute warning stops the clock once, at 2:00 or after the play that runs through it', () => {
  const s = comeback({ clock: 124 });
  assert.equal(s.game.warned, false);
  tackle(s, 5, 2);
  advance(s, 5);
  assert.equal(s.game.clock, CLOCK.warning); assert.equal(s.game.running, false); assert.equal(s.game.stopped, 'warning');
  assert.deepEqual(s.drainNotices(), ['Two-minute warning']);
  s.next();
  tackle(s, 5, 2);
  advance(s, 3);
  assert.equal(s.game.running, true, 'only once');
  const during = comeback({ clock: 122 });
  tackle(during, 5, 4);
  assert.ok(near(during.game.clock, 118)); assert.equal(during.game.stopped, 'warning');
  assert.equal(comeback({ clock: 90 }).game.warned, true);
});

test('the play clock: forty seconds from the whistle, then five yards for delay of game', () => {
  const s = comeback({ clock: 110, spot: 60 });
  tackle(s, 3);
  s.huddle();
  assert.equal(s.spot, 63);
  advance(s, CLOCK.play - CLOCK.huddle + 0.1);
  assert.equal(s.spot, 58); assert.equal(s.toGo, 12); assert.equal(s.down, 2);
  assert.equal(s.game.running, false); assert.equal(s.game.stopped, 'penalty'); assert.equal(s.game.playClock, null);
  assert.deepEqual(s.drainNotices(), ['Delay of game: 5 yards']);
  assert.equal(s.byId.C.start.z, 58 - 0.25, 'lined up again at the new spot');
  assert.equal(s.ready, true);
  // Standing over the dead ball, the flag moves the next spot.
  const idle = comeback({ clock: 110, spot: 60 });
  tackle(idle, 3);
  advance(idle, CLOCK.play + 0.1);
  assert.deepEqual(idle.game.next, { spot: 58, down: 2, toGo: 12 });
});

test('time runs out between plays, or the last play is played to its whistle', () => {
  const s = comeback({ clock: 9 });
  tackle(s, 5, 3);
  advance(s, 7);
  assert.equal(s.game.clock, 0); assert.equal(s.game.over.result, 'loss'); assert.equal(s.game.over.reason, 'Time expired');
  assert.equal(s.next(), false); assert.equal(s.hurry(), false); assert.equal(s.timeout(), false);
  // On the way to the line.
  const line = comeback({ clock: 8 });
  tackle(line, 5, 3);
  line.hurry();
  advance(line, 6);
  assert.equal(line.game.over.reason, 'Time expired'); assert.equal(line.ready, false); assert.equal(line.snap(), false);
  // The clock hits 0:00 during a play: the play goes on, and a touchdown on it counts.
  const last = comeback({ clock: 2, deficit: 4 });
  last.snap(); advance(last, 3.5);
  assert.equal(last.phase, 'live'); assert.equal(last.game.clock, 0); assert.equal(last.game.over, null);
  last.finish('Touchdown', 60, 'touchdown');
  assert.equal(last.game.over.result, 'win');
  const short = comeback({ clock: 2 });
  tackle(short, 30, 3);
  assert.equal(short.game.over.reason, 'Time expired');
});

test('kick odds fall with distance; a kick is the line of scrimmage plus seventeen yards', () => {
  assert.equal(kickDistance(75), 52); assert.equal(kickDistance(108), 19); assert.equal(kickDistance(95), 32);
  let last = 1;
  for (let d = 18; d <= 75; d++) {
    const p = fieldGoalOdds(d);
    assert.ok(p <= last && p >= 0 && p <= 0.99, d + ' yd');
    last = p;
  }
  assert.ok(fieldGoalOdds(25) > 0.97 && fieldGoalOdds(33) > 0.93, 'chip shots and the extra point');
  assert.ok(fieldGoalOdds(50) > 0.65 && fieldGoalOdds(50) < 0.8);
  assert.ok(fieldGoalOdds(60) < 0.45 && fieldGoalOdds(60) > 0.25);
  assert.equal(fieldGoalOdds(71), 0);
});

test('a field goal: the unit lines up, the ball goes through the posts or it does not', () => {
  let made = 0, missed = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const s = comeback({ deficit: 2, spot: 78, clock: 30 }, seed);   // a 49-yard kick
    incomplete(s, 2);
    const down = s.down, attempts = s.stats.attempts, reps = s.stats.reps;
    assert.equal(s.fieldGoal(), true);
    assert.equal(s.phase, 'presnap'); assert.equal(s.game.stage, 'kick'); assert.equal(s.kick.distance, 49);
    assert.equal(s.down, down + 1, 'kicked on the next down');
    assert.equal(s.snap(), false, 'the player does not snap it');
    assert.equal(s.fieldGoal(), false); assert.equal(s.timeout(), false); assert.equal(s.setPlay('mesh'), false);
    const took = until(s, () => !!s.game.over, 15);
    assert.ok(took > KICK.set + 2 && took < 9, 'unit, snap, kick and flight: ' + took.toFixed(1));
    const good = s.result.kind === 'fieldgoal';
    assert.equal(good, s.kick.good, 'the flight shows the draw');
    assert.equal(s.result.distance, 49);
    assert.ok(Math.abs(s.ball.z - 120) < 0.5 && (good ? Math.abs(s.ball.x) < KICK.upright && s.ball.y > KICK.bar : Math.abs(s.ball.x) > KICK.upright), 'at the posts');
    if (good) { made++; assert.deepEqual([s.game.us - s.game.them, s.game.over.result, s.result.label], [1, 'win', 'Field goal is good']); }
    else { missed++; assert.deepEqual([s.game.us - s.game.them, s.game.over.result, s.result.label], [-2, 'loss', 'No good']); }
    assert.deepEqual([s.stats.attempts, s.stats.reps], [attempts, reps], 'a kick is nobody\'s pass');
    advance(s, 5);
    assert.ok(s.ball.z > 120 && s.ball.y < 0.2, 'it comes down behind the end line');
  }
  assert.ok(made > 22 && missed > 3, `49 yd: ${made} of 40`);
});

test('a field goal ties when three behind, is refused when it is not enough or out of range', () => {
  const tie = comeback({ deficit: 3, spot: 100 });
  tie.kick = null;
  assert.equal(tie.fieldGoal(), true);
  tie.kick.good = true;
  until(tie, () => !!tie.game.over, 15);
  assert.deepEqual([tie.game.us, tie.game.them, tie.game.over.result], [tie.game.them, tie.game.them, 'tie']);
  assert.equal(comeback({ deficit: 4, spot: 100 }).fieldGoal(), false, 'four behind');
  assert.equal(comeback({ deficit: 1, spot: 50 }).fieldGoal(), false, 'a 77-yard kick');
  // A long one that is short comes down in front of the bar.
  const long = comeback({ deficit: 1, spot: 67 });
  assert.equal(long.fieldGoal(), true);
  Object.assign(long.kick, { good: false, where: 0.2 });
  until(long, () => !!long.game.over, 15);
  assert.equal(long.result.label, 'No good'); assert.equal(long.game.over.reason, 'Missed from 60 yards');
});

test('the field-goal unit needs time to get on while the clock runs', () => {
  const s = comeback({ deficit: 1, spot: 80, clock: 40 });
  tackle(s, 4, 3);
  advance(s, 2);
  const left = s.game.clock;
  assert.equal(s.fieldGoal(), true);
  assert.ok(near(s.game.clock, left - (CLOCK.unit - 2)), 'on and set fifteen seconds after the whistle');
  assert.equal(s.spot, 84); assert.equal(s.kick.distance, 43);
  // Too late: the clock runs out with the unit coming on.
  const late = comeback({ deficit: 1, spot: 80, clock: 12 });
  tackle(late, 4, 3);
  assert.equal(late.fieldGoal(), true);
  assert.equal(late.kick, null); assert.equal(late.game.over.reason, 'Time expired');
  // A timeout first, and three seconds are enough.
  const saved = comeback({ deficit: 1, spot: 80, clock: 6, timeouts: 1 });
  tackle(saved, 4, 3);
  saved.timeout();
  assert.equal(saved.fieldGoal(), true);
  saved.kick.good = true;
  until(saved, () => !!saved.game.over, 15);
  assert.equal(saved.game.over.result, 'win');
  assert.equal(saved.game.clock, 0, 'the kick took the rest of the clock');
});

test('a touchdown wins when it puts the offense ahead; the extra point is taken as kicked', () => {
  for (const deficit of [1, 3, 4, 5]) {
    const s = comeback({ deficit, them: 24 });
    play(s, 'Touchdown', 60, 'touchdown', 5);
    assert.equal(s.game.over.result, 'win', 'down ' + deficit);
    assert.equal(s.game.us, 24 - deficit + 7);
    assert.ok(near(s.game.over.clock, 85)); assert.equal(s.game.over.plays, 1); assert.equal(s.game.over.yards, 60);
    assert.deepEqual(s.record, { win: 1, loss: 0, tie: 0 });
    assert.equal(s.next(), false); assert.equal(s.tryTwo(), false);
  }
});

test('six behind: the touchdown ties it and the extra point wins it', () => {
  const s = comeback({ deficit: 6 });
  play(s, 'Touchdown', 60, 'touchdown');
  const g = s.game;
  assert.equal(g.over, null); assert.equal(g.stage, 'pat'); assert.equal(g.us, g.them); assert.equal(g.running, false);
  assert.equal(s.next(), false, 'a decision first'); assert.equal(s.fieldGoal(), false); assert.equal(s.ready, false);
  assert.equal(s.tryKick(), true);
  assert.equal(s.kick.kind, 'xp'); assert.equal(s.kick.distance, 32); assert.equal(s.spot, 95);
  const left = g.clock;
  s.kick.good = true;
  until(s, () => !!g.over, 15);
  assert.deepEqual([g.us - g.them, g.over.result, g.over.reason, s.result.label], [1, 'win', 'Extra point', 'Extra point is good']);
  assert.equal(g.clock, left, 'a try is untimed');
  const miss = comeback({ deficit: 6 });
  play(miss, 'Touchdown', 60, 'touchdown');
  miss.tryKick();
  Object.assign(miss.kick, { good: false, where: 0.9 });
  until(miss, () => !!miss.game.over, 15);
  assert.deepEqual([miss.game.over.result, miss.game.over.reason], ['tie', 'Extra point missed']);
});

test('seven behind: kick to tie, or go for two from the 2 to win or lose', () => {
  const kick = comeback({ deficit: 7 });
  play(kick, 'Touchdown', 60, 'touchdown');
  assert.equal(kick.game.stage, 'pat'); assert.equal(kick.game.us + 1, kick.game.them);
  kick.tryKick(); kick.kick.good = true;
  until(kick, () => !!kick.game.over, 15);
  assert.equal(kick.game.over.result, 'tie');

  for (const good of [true, false]) {
    const s = comeback({ deficit: 7 }, 3, { offense: 'random', difficulty: 'allpro' });
    play(s, 'Touchdown', 60, 'touchdown');
    const stats = { ...s.stats }, clock = s.game.clock;
    assert.equal(s.tryTwo(), true);
    assert.deepEqual([s.game.stage, s.spot, s.toGo, s.phase], ['try', 108, 2, 'presnap']);
    assert.ok(['goal', 'nickel'].includes(s.personnel), 'the goal-line defense comes on (the nickel against a spread set): ' + s.personnel);
    assert.ok(['run', 'quick', 'pa', 'mid'].includes(profilePlay(s.play).cls), 'a goal-line call: ' + s.play.id);
    assert.equal(s.setPlay('zone'), true);
    assert.equal(s.ready, true);
    s.snap(); advance(s, 0.5);
    assert.equal(s.game.clock, clock, 'untimed');
    if (good) s.finish('Touchdown', 2, 'touchdown'); else s.finish('Tackled', 1, 'tackle');
    assert.equal(s.result.conversion, good); assert.equal(s.result.label, good ? 'Conversion good' : 'Conversion failed');
    assert.equal(s.game.us - s.game.them, good ? 1 : -1);
    assert.deepEqual([s.game.over.result, s.game.over.reason], good ? ['win', 'Two-point conversion'] : ['loss', 'Two-point try failed']);
    assert.deepEqual(s.stats, stats, 'a try counts in nobody\'s totals');
  }
});

test('eight behind has to go for two, and that only ties', () => {
  const s = comeback({ deficit: 8 });
  play(s, 'Touchdown', 60, 'touchdown');
  assert.equal(s.game.stage, 'pat');
  assert.equal(s.tryKick(), false, 'one point is not enough');
  s.tryTwo(); s.snap(); advance(s, 1);
  s.finish('Touchdown', 2, 'touchdown');
  assert.equal(s.game.over.result, 'tie');
});

test('an interception, a safety and a failed fourth down end it', () => {
  const pick = comeback();
  play(pick, 'Intercepted', 0, 'interception');
  assert.deepEqual([pick.game.over.result, pick.game.over.reason], ['loss', 'Intercepted']);
  const safety = comeback({ them: 20 });
  play(safety, 'Safety', -45, 'safety');
  assert.deepEqual([safety.game.over.result, safety.game.them], ['loss', 22]);
  const downs = comeback({ down: 4, toGo: 6 });
  tackle(downs, 5);
  assert.deepEqual([downs.game.over.result, downs.game.over.reason], ['loss', 'Turned over on downs']);
  const made = comeback({ down: 4, toGo: 6 });
  tackle(made, 6);
  assert.equal(made.game.over, null); assert.deepEqual(made.game.next, { spot: 56, down: 1, toGo: 10 });
  assert.deepEqual(pick.record, { win: 0, loss: 1, tie: 0 });
});

test('the player calls the plays: the last call stands until another is made', () => {
  const s = comeback({}, 3, { offense: 'random' });
  const first = s.play.id;
  assert.ok(profilePlay(s.play).cls !== 'pa', 'the coordinator picks the first one');
  assert.equal(s.setPlay('verts'), true);
  assert.equal(s.play.id, 'verts'); assert.equal(s.config.offense, 'random', 'a call for the down, not a setting');
  const call = s.call;
  assert.equal(s.setPlay('stick'), true);
  assert.equal(s.call, call, 'the defense keeps its call when the offense changes its own at the line');
  incomplete(s);
  // With the ball dead a call is for the next down.
  assert.equal(s.setPlay('slants'), true);
  assert.equal(s.play.id, 'stick'); assert.equal(s.game.nextCall, 'slants');
  s.next();
  assert.equal(s.play.id, 'slants');
  for (let i = 0; i < 2; i++) { incomplete(s); s.next(); assert.equal(s.play.id, 'slants', 'the same play again'); }
  assert.equal(s.selectPlay('mesh'), true);
  assert.equal(s.play.id, 'mesh'); assert.equal(s.config.offense, 'random');
  assert.equal(s.setPlay('nonsense'), false);
  assert.equal(s.setPlay('random'), true, 'the coordinator, for this down');
  assert.ok(PLAYS.includes(s.play));
  assert.notEqual(first, undefined);
  // An audible and a hot route still work at the line.
  assert.equal(s.audible('mesh'), true); assert.equal(s.setHotRoute('X', 'streak'), true);
});

test('the two-minute offense: the coordinator all but stops running, and heaves it at the end', () => {
  const base = { down: 1, toGo: 10, spot: 40, mode: 'comeback' };
  const share = (situation, cls) => playWeights(situation).reduce((a, w, i) => a + (profilePlay(PLAYS[i]).cls === cls ? w : 0), 0);
  assert.equal(readSituation(base).tempo, null);
  assert.equal(readSituation({ ...base, hurry: { clock: 100, timeouts: 2, need: 35 } }).tempo, 'drill');
  assert.equal(readSituation({ ...base, hurry: { clock: 25, timeouts: 0, need: 35 } }).tempo, 'chase');
  assert.equal(readSituation({ ...base, hurry: { clock: 25, timeouts: 3, need: 35 } }).tempo, 'drill', 'timeouts are time');
  assert.equal(readSituation({ ...base, hurry: { clock: 6, timeouts: 0, need: 40 } }).tempo, 'heave');
  assert.equal(readSituation({ ...base, hurry: { clock: 6, timeouts: 0, need: 8 } }).tempo, 'drill', 'close enough for a real play');
  const normal = share(base, 'run'), drill = share({ ...base, hurry: { clock: 100, timeouts: 2, need: 35 } }, 'run');
  assert.ok(normal > 0.35 && drill < 0.15, `runs: ${normal.toFixed(2)} on 1st and 10, ${drill.toFixed(2)} in the drill`);
  const chase = { ...base, hurry: { clock: 25, timeouts: 0, need: 60 } };
  assert.ok(share(chase, 'shot') > 2 * share(base, 'shot') && share(chase, 'run') < 0.05);
  const heave = { ...base, hurry: { clock: 5, timeouts: 0, need: 50 } };
  assert.equal(share(heave, 'run'), 0); assert.equal(share(heave, 'pa'), 0);
  assert.ok(share(heave, 'shot') > 0.75, 'shots: ' + share(heave, 'shot').toFixed(2));
  for (const s of [base, chase, heave]) assert.ok(Math.abs(playWeights(s).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // The simulation hands him the clock, and the next down while the ball is dead.
  const s = comeback({ deficit: 5, clock: 30, timeouts: 0, spot: 40 });
  assert.deepEqual(s.situation().hurry, { clock: 30, timeouts: 0, need: 70 });
  assert.equal(comeback({ deficit: 2, spot: 40 }).situation().hurry.need, 35, 'three points are enough: to field-goal range');
  tackle(s, 8, 4);
  assert.deepEqual([s.situation(true).down, s.situation(true).spot, s.situation().spot], [2, 48, 40]);
});

test('the two-minute defense: one more defensive back, deep shells over pressure', () => {
  const families = (mode, scenario) => {
    const count = {}, packages = {};
    for (let seed = 1; seed <= 300; seed++) {
      const s = new Simulation(seed, { mode, difficulty: 'allpro', offense: 'mesh', scenario: { deficit: 4, clock: 100, timeouts: 1, spot: 45, ...scenario } });
      count[s.coverage] = (count[s.coverage] || 0) + 1; packages[s.personnel] = (packages[s.personnel] || 0) + 1;
    }
    return { count, packages };
  };
  const drive = families('drive'), late = families('comeback');
  const deep = c => (c.cover2 || 0) + (c.tampa2 || 0) + (c.cover4 || 0) + (c.cover6 || 0) + (c.man || 0);
  assert.equal(late.packages.dime, 300, 'dime against three wide: ' + JSON.stringify(late.packages));
  assert.equal(drive.packages.nickel, 300);
  assert.ok(deep(late.count) > deep(drive.count) + 20, `two-high calls: ${deep(drive.count)} then ${deep(late.count)} of 300`);
  const tight = c => (c.cover1 || 0) + (c.blitz || 0) + (c.firezone || 0);
  assert.ok(tight(late.count) < tight(drive.count) - 10, `man-free and five- and six-man pressure: ${tight(drive.count)} then ${tight(late.count)}`);
});

test('a comeback leaves the practice formats alone and replays from its seed', () => {
  const run = seed => {
    const s = comeback({ clock: 60 }, seed);
    s.snap(); advance(s, 1.8); s.requestThrow('A', 'bullet');
    while (s.phase !== 'dead') s.step(STEP, { z: 1 });
    if (s.game.running) { s.hurry(); advance(s, 9); }
    return { snapshot: s.snapshot(), game: { ...s.game }, play: s.play.id, coverage: s.coverage };
  };
  assert.deepEqual(run(21), run(21));
  // Practice: no clock, and the snap is never held up.
  const p = new Simulation(5, { mode: 'drive', offense: 'mesh' });
  assert.equal(p.ready, true); assert.equal(p.snapshot().lining, false);
  assert.equal(p.timeout(), false); assert.equal(p.hurry(), false); assert.equal(p.spikeBall(), false); assert.equal(p.fieldGoal(), false);
  assert.equal(p.huddle(), false); assert.equal(p.tryKick(), false); assert.equal(p.tryTwo(), false); assert.equal(p.setPlay('mesh'), false);
  p.snap(); advance(p, 1); p.finish('Tackled', 4, 'tackle');
  advance(p, 30);
  assert.equal(p.next(), true); assert.equal(p.down, 2);
  assert.deepEqual(p.drainNotices(), []);
  assert.equal(needText(3), 'A field goal ties it. A touchdown wins it.');
  for (let d = 1; d <= 8; d++) assert.ok(needText(d).length > 10);
});
