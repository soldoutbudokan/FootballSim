// The fourth-quarter comeback (config.mode 'comeback'): one last drive with a
// score, a game clock, timeouts and a result. The offense still plays every
// down through the ordinary simulation; this module is the game around the
// downs: the situation (makeScenario), the clock and what stops it, the
// choices between plays (no huddle, huddle, timeout, spike, field goal), the
// hurry-up lineup that everybody runs in real time, the kicks and the tries
// after a touchdown, and how it ends. Units are yards and seconds.
//
// The state lives in `sim.game` (null in the practice modes):
//   us, them        the score; the offense is behind
//   clock           seconds left in the fourth quarter
//   running         the clock is running (during a play and, after a play
//                   that does not stop it, between plays in real time)
//   stopped         why it is stopped: 'start', 'incomplete', 'out', 'spike',
//                   'timeout', 'warning', 'penalty' or 'score'
//   playClock       seconds to snap while the clock runs between plays
//   timeouts        the offense's timeouts
//   stage           'drive', 'pat' (touchdown scored: kick or go for two),
//                   'try' (the two-point play), 'kick' or 'over'
//   next            the spot, down and distance of the next play, from the
//                   whistle until the offense goes to the line
//   over            the result once it is decided: { result: 'win' | 'tie'
//                   | 'loss', reason, ... }
import { PLAYS, FORMATIONS } from '../plays.js';
import { clamp, dist, wrapAngle, ZERO, scaled, seekWant, speedCap } from './common.js';
import { callPlay } from './offense.js';

const GOAL = 110, END_LINE = 120;

// The clock. It runs from the snap to the whistle. An incomplete pass (a
// spike and a throw-away are incomplete passes), a runner out of bounds, a
// timeout, a score and the two-minute warning stop it until the next snap; a
// tackle in bounds and a sack leave it running, first down or not. The
// two-minute warning stops it at 2:00 between plays, or at the end of the
// play that runs through 2:00. While it runs between plays the offense has
// `play` s from the whistle to snap, or it is a delay of game: `delay` yd
// (half the distance near its own goal line) and the clock stops. A huddle
// has the offense back at the line `huddle` s after the whistle. The
// field-goal unit needs `unit` s from the whistle to get on and set, and
// never less than `unitCall` s from the moment it is sent on.
export const CLOCK = { warning: 120, play: 40, huddle: 25, unit: 15, unitCall: 8, delay: 5 };

// The hurry-up lineup. Nobody in the tackle moves until he is back on his
// feet (`up`: seconds after the hit for the runner, the tackler and a second
// man in). Everybody else heads for his spot at once: linemen at `effort.ol`
// of top speed, the other offensive players at `effort.offense`, defenders at
// `effort.defense`. A man within `turn` yd of his spot squares up to the
// line as he arrives, and is set within `near` yd of it at under `slow`
// yd/s. The ball is ready `spot` s after the whistle at the earliest (the
// officials spot it), and everybody is set for `set` s before the snap. A
// lineup that has not come to rest after `most` s is set where it should be.
// A substitute comes on from the sideline `sideline` yd from the middle.
export const HURRY = {
  up: { carrier: 3.6, tackler: 2.7, helper: 2.0 },
  effort: { ol: 0.55, offense: 0.66, defense: 0.72 },
  turn: 2, near: 0.15, slow: 0.6, spot: 7, set: 1, most: 20, sideline: 26, rate: 9,
};

// Kicks are not played out by the player: the offense's job is to get in
// range. A kick from the line of scrimmage at `spot` travels the distance to
// the goal line plus the end zone (10 yd) plus the `hold` behind the line.
// `odds` is the chance by distance, [yards, chance] pairs joined by straight
// lines (about the league's rates: automatic inside 30, three in four from
// 50, a coin from the high 50s, nothing past 70). The extra point is kicked
// from the `xp` yd line. `range` is the yard line the coordinator treats as
// field-goal range when the offense only needs three. The unit shows for
// `set` s, the holder has the ball down `snap` s after the snap and the
// kicker, off at `go` s, strikes it within `reach` yd of the spot (at `late`
// s whatever happens). The ball takes hang[0] + distance / hang[1] s to the
// posts: over the bar by `clear` yd and no more than `inside` yd off centre
// when it is good, `wide` yd or more outside an upright when it is not, or,
// from `short` yd and beyond, short of the bar half the time.
export const KICK = {
  hold: 7, xp: 15, range: 35,
  odds: [[20, 0.99], [30, 0.97], [40, 0.9], [45, 0.84], [50, 0.73], [55, 0.58], [60, 0.38], [65, 0.17], [68, 0.06], [71, 0]],
  set: 1.6, snap: 0.35, go: 0.4, reach: 0.5, late: 1.7, effort: 0.55,
  hang: [1.1, 30], clear: 3, inside: 2.2, wide: 1, short: 55,
  bar: 3.3333, upright: 3.0833,
};

// The spike: the quarterback takes the snap, winds up at `wind` s and puts
// the ball in the turf at `release` s, which is the whistle.
export const SPIKE = { wind: 0.4, release: 0.63 };

// A scenario. `deficit`: how far behind, by weight (three and seven are the
// common margins). `timeouts` likewise. `fresh` of the scenarios start a new
// drive, 1st and 10 between the offense's own `own` yard lines; the rest
// pick the drive up between the `mid` yard lines (own 35 to the opponent's
// 35) on any down. The clock fits the job: `base` s plus between pace[0] and
// pace[1] s for each yard to go (to field-goal range when three points are
// enough, else to the goal line; never fewer than `least` yd), less `timeout`
// s for each timeout, held to `min`..`max` s. `scores` are the leader's
// points.
export const SCENARIO = {
  deficit: { 1: 1, 2: 1.2, 3: 2.4, 4: 2, 5: 1, 6: 1.6, 7: 2 },
  timeouts: { 0: 0.25, 1: 0.3, 2: 0.3, 3: 0.15 },
  fresh: 0.65, own: [18, 40], mid: [35, 65],
  downs: { 1: 0.4, 2: 0.3, 3: 0.2, 4: 0.1 },
  base: 14, pace: [1.2, 1.9], least: 12, timeout: 8, min: 14, max: 150,
  scores: [13, 16, 17, 20, 20, 21, 23, 24, 24, 27, 28, 31],
};

// The field-goal formation: the line, the tight end and a receiver beside
// the tackles, two wings, the quarterback holding and the back kicking.
const KICK_FORMATION = FORMATIONS.tight.players.map(p => ({ ...p, ...({
  QB: { x: 0.7, z: -KICK.hold - 0.2 }, R: { x: -1.5, z: -KICK.hold - 2.6 },
  A: { x: 4.7, z: -0.35 }, Y: { x: -4.7, z: -0.35 }, X: { x: -5.9, z: -1.2 }, B: { x: 5.9, z: -1.2 },
}[p.id] || {}) }));

function choose(table, u) {
  const keys = Object.keys(table), sum = keys.reduce((a, k) => a + table[k], 0);
  let acc = 0;
  for (const k of keys) { acc += table[k] / sum; if (u < acc) return k; }
  return keys[keys.length - 1];
}

// How far a field goal from this line of scrimmage has to go.
export function kickDistance(spot) { return Math.round(GOAL - spot) + 10 + KICK.hold; }

// The chance a kick of `distance` yd is good (KICK.odds).
export function fieldGoalOdds(distance) {
  const t = KICK.odds;
  if (distance <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (distance <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (distance - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
  }
  return 0;
}

// What the offense needs, for a deficit of 1 to 8 points.
export function needText(deficit) {
  if (deficit <= 2) return 'A field goal wins it.';
  if (deficit === 3) return 'A field goal ties it. A touchdown wins it.';
  if (deficit <= 5) return 'You need a touchdown.';
  if (deficit === 6) return 'A touchdown ties it. The extra point wins it.';
  if (deficit === 7) return 'A touchdown and the extra point tie it. A two-point conversion wins it.';
  return 'A touchdown and a two-point conversion tie it.';
}

// A random situation from eight draws of `random` (always eight, so a seed
// makes the same scenario and leaves the stream in the same place).
export function makeScenario(random) {
  const u = Array.from({ length: 8 }, () => random()), S = SCENARIO;
  const deficit = Number(choose(S.deficit, u[0])), timeouts = Number(choose(S.timeouts, u[1]));
  const fresh = u[2] < S.fresh, [lo, hi] = fresh ? S.own : S.mid;
  const spot = 10 + Math.round(lo + (hi - lo) * u[3]);
  const down = fresh ? 1 : Number(choose(S.downs, u[4]));
  const toGo = down === 1 ? 10 : clamp(Math.round(1 + u[5] * (down === 4 ? 4 : 9)), 1, GOAL - spot);
  const need = Math.max(S.least, (deficit <= 3 ? GOAL - KICK.range : GOAL) - spot);
  const pace = S.pace[0] + (S.pace[1] - S.pace[0]) * u[7];
  const clock = clamp(Math.round(S.base + need * pace - timeouts * S.timeout), S.min, S.max);
  const them = S.scores[Math.floor(u[6] * S.scores.length)];
  return { deficit, us: them - deficit, them, clock, timeouts, spot, down, toGo };
}

// A scenario given by hand (tests, a retry): every field checked and held to
// what the mode can play.
function cleanScenario(s) {
  const spot = clamp(Math.round(Number(s.spot) || 35), 11, 109), down = clamp(Math.round(Number(s.down) || 1), 1, 4);
  const them = Math.max(1, Math.round(Number(s.them) || 20)), deficit = clamp(Math.round(Number(s.deficit ?? them - (s.us ?? them - 3)) || 3), 1, 8);
  return {
    deficit, us: them - deficit, them, clock: clamp(Number(s.clock) || 60, 1, 900), timeouts: clamp(Math.round(Number(s.timeouts ?? 3)), 0, 3),
    spot, down, toGo: clamp(Math.round(Number(s.toGo) || 10), 1, GOAL - spot),
  };
}

export const comeback = {
  // Starts a comeback: the given scenario, or a random one.
  startComeback(scenario = null) {
    const s = scenario ? cleanScenario(scenario) : makeScenario(this.random);
    this.config.mode = 'comeback';
    this.spot = s.spot; this.down = s.down; this.toGo = s.toGo;
    this.game = {
      scenario: s, us: s.us, them: s.them, clock: s.clock, timeouts: s.timeouts,
      running: false, stopped: 'start', playClock: null, warned: s.clock <= CLOCK.warning,
      stage: 'drive', next: null, over: null, sinceWhistle: 0, plays: 0, yards: 0,
      called: false, nextCall: null, noSub: false, before: null,
    };
    this.lining = null; this.kick = null; this.spike = null; this.spikeCall = false; this.notices = [];
    this.reset(true);
    return s;
  },

  // Back to practice: no game around the downs.
  endComeback() {
    this.game = null; this.lining = null; this.kick = null; this.spike = null; this.spikeCall = false;
  },

  // The situation the offensive coordinator reads (offense.js): this down,
  // or the next one while the ball is dead (`upcoming`), with the clock.
  situation(upcoming = false) {
    const g = this.game, at = (upcoming && g?.next) || this;
    const s = { down: at.down, toGo: at.toGo, spot: at.spot, mode: this.config.mode };
    if (g && g.stage === 'drive') s.hurry = { clock: g.clock, timeouts: g.timeouts, need: Math.max(0, (g.us + 3 >= g.them ? GOAL - KICK.range : GOAL) - at.spot) };
    return s;
  },

  // The offense's call for a new down. The player calls the plays: a play
  // called while the ball was dead, else the play just run; the coordinator
  // picks only the first play of the drive and of a two-point try.
  comebackCall() {
    const g = this.game, queued = g.nextCall && PLAYS.find(p => p.id === g.nextCall);
    g.nextCall = null;
    if (queued) { g.called = true; return queued; }
    if (g.called) return this.play;
    return (g.stage === 'drive' && PLAYS.find(p => p.id === this.config.offense)) || callPlay(this.situation(), this.random());
  },

  // Calls a play: at the line it replaces the call (the defense keeps its
  // own), with the ball dead it is the call for the next down. 'random' asks
  // the coordinator.
  setPlay(id) {
    const g = this.game;
    if (!g || g.over || g.stage === 'pat' || this.kick || !['presnap', 'dead'].includes(this.phase)) return false;
    const play = id === 'random' ? callPlay(this.situation(this.phase === 'dead'), this.random()) : PLAYS.find(p => p.id === id);
    if (!play) return false;
    this.spikeCall = false;
    if (this.phase === 'dead') { g.nextCall = play.id; return true; }
    this.play = play; g.called = true; this.hotRoutes = {}; this.audibled = false;
    this.reset();
    return true;
  },

  // A message for the player (the two-minute warning, a flag).
  notice(text) { (this.notices ||= []).push(text); },
  drainNotices() { return (this.notices || []).splice(0); },

  stopClock(reason) {
    const g = this.game;
    g.running = false; g.stopped = reason; g.playClock = null;
    // Nobody hurries with the clock stopped: the lineup is over.
    if (this.lining) this.endLineup();
  },

  // Every step: the clock, the lineup, and the snaps nobody presses a key
  // for (a kick, a spike once everybody is set).
  tickGame(dt) {
    const g = this.game;
    if (g.over) return;
    const between = this.phase === 'presnap' || this.phase === 'dead';
    if (g.running) {
      if (between) this.runOff(dt);
      else g.clock = Math.max(0, g.clock - dt);
    }
    if (g.over || this.phase !== 'presnap') return;
    if (this.lining) this.stepLineup(dt);
    else if (this.kick) { this.kick.wait -= dt; if (this.kick.wait <= 0) this.startKick(); }
    else if (this.spikeCall && g.running) this.snap();
  },

  // Takes `s` seconds off a clock running between plays: it stops at the
  // two-minute warning, the play clock goes with it and the game ends at
  // 0:00. False when it ended.
  runOff(s) {
    const g = this.game;
    if (!g.running || s <= 0) return true;
    if (!g.warned && g.clock - s <= CLOCK.warning) {
      g.sinceWhistle += g.clock - CLOCK.warning; g.clock = CLOCK.warning;
      this.twoMinuteWarning();
      return true;
    }
    g.clock = Math.max(0, g.clock - s); g.sinceWhistle += s; g.playClock = (g.playClock ?? CLOCK.play) - s;
    if (g.clock <= 0) { this.endGame('loss', 'Time expired'); return false; }
    if (g.playClock <= 0) this.delayOfGame();
    return true;
  },

  twoMinuteWarning() {
    this.game.warned = true;
    this.stopClock('warning');
    this.notice('Two-minute warning');
  },

  delayOfGame() {
    const g = this.game, at = g.next || this, yards = Math.min(CLOCK.delay, Math.floor((at.spot - 10) / 2));
    at.spot -= yards; at.toGo += yards;
    this.spikeCall = false;
    this.stopClock('penalty');
    this.notice(`Delay of game: ${yards} yards`);
    if (this.phase === 'presnap' && !this.kick) this.reset();
  },

  // The snap in a comeback: the clock starts (a try is untimed) and the
  // defense may substitute again before the next one.
  comebackSnap() {
    const g = this.game;
    g.playClock = null; g.stopped = null; g.called = true; g.noSub = false;
    if (g.stage === 'try') { g.running = false; g.before = { ...this.stats }; return; }
    g.running = true; g.plays++;
    if (this.spikeCall) this.spike = { wound: false };
    this.spikeCall = false;
  },

  // The whistle: the score, the end of the game or the next down, and what
  // the clock does (CLOCK).
  afterPlay(r) {
    const g = this.game;
    if (g.over) return;
    g.sinceWhistle = 0;
    if (this.kick) { this.afterKick(r); return; }
    if (g.stage === 'try') {
      // A try is not a play in anybody's totals.
      Object.assign(this.stats, g.before);
      r.conversion = r.kind === 'touchdown'; r.label = r.conversion ? 'Conversion good' : 'Conversion failed';
      if (r.conversion) g.us += 2;
      this.settle(r.conversion ? 'Two-point conversion' : 'Two-point try failed');
      return;
    }
    if (this.spike) r.spike = true;
    g.yards += r.yards;
    if (r.kind === 'touchdown') {
      g.us += 6;
      this.stopClock('score');
      const margin = g.us - g.them;
      // Ahead, the extra point changes nothing: it is taken as kicked.
      if (margin > 0) { g.us += 1; this.endGame('win', 'Touchdown'); }
      else if (margin < -2) this.endGame('loss', 'Still behind');
      else g.stage = 'pat';
      return;
    }
    if (r.kind === 'interception') { this.endGame('loss', 'Intercepted'); return; }
    if (r.kind === 'safety') { g.them += 2; this.endGame('loss', 'Safety'); return; }
    if (this.down === 4 && !r.firstDown) { this.endGame('loss', 'Turned over on downs'); return; }
    const spot = clamp(this.spot + r.yards, 11, 109);
    g.next = r.firstDown ? { spot, down: 1, toGo: Math.min(10, GOAL - spot) } : { spot, down: this.down + 1, toGo: Math.min(GOAL - spot, this.toGo - r.yards) };
    if (g.clock <= 0) { this.endGame('loss', 'Time expired'); return; }
    if (r.kind === 'incomplete' || r.kind === 'out') this.stopClock(r.spike ? 'spike' : r.kind);
    else { g.running = true; g.stopped = null; g.playClock = CLOCK.play; }
    if (!g.warned && g.clock <= CLOCK.warning) this.twoMinuteWarning();
  },

  // Decided by the score.
  settle(reason) {
    const margin = this.game.us - this.game.them;
    this.endGame(margin > 0 ? 'win' : margin === 0 ? 'tie' : 'loss', reason);
  },

  endGame(result, reason) {
    const g = this.game;
    g.over = { result, reason, clock: g.clock, us: g.us, them: g.them, plays: g.plays, yards: g.yards, timeouts: g.timeouts };
    g.stage = 'over'; g.running = false; g.playClock = null; g.next = null;
    this.spikeCall = false;
    if (this.lining) this.endLineup();
    (this.record ||= { win: 0, loss: 0, tie: 0 })[result]++;
    this.events.push('final');
  },

  // --- between plays -------------------------------------------------------

  // On to the next down: with the clock running that is the hurry-up; with
  // it stopped the offense is simply at the line.
  nextDown() {
    const g = this.game;
    if (g.over || g.stage !== 'drive' || this.phase !== 'dead') return false;
    return g.running ? this.hurry() : this.advance();
  },

  advance(carry = null) {
    const g = this.game;
    if (g.next) { this.spot = g.next.spot; this.down = g.next.down; this.toGo = g.next.toGo; g.next = null; }
    this.reset(true, carry);
    return true;
  },

  // No huddle: everybody goes to the line from where the play left him
  // (HURRY), the clock running, and the defense plays the next down with
  // the men it has on the field.
  hurry() {
    const g = this.game;
    if (!g || g.over || g.stage !== 'drive' || this.phase !== 'dead' || !g.running) return false;
    const carry = this.bodies();
    this.lining = { time: this.time, deadTime: this.deadTime, elapsed: 0, setAt: null, tackle: this.snapshot().tackle, misses: this.misses.slice() };
    g.noSub = true;
    return this.advance(carry);
  },

  // A huddle: the offense is back at the line CLOCK.huddle s after the
  // whistle, the clock still running.
  huddle() {
    const g = this.game;
    if (!g || g.over || g.stage !== 'drive' || this.phase !== 'dead' || !g.running) return false;
    if (!this.runOff(Math.max(0, CLOCK.huddle - g.sinceWhistle))) return true;
    return this.advance();
  },

  timeout() {
    const g = this.game;
    if (!g || g.over || g.stage !== 'drive' || !g.running || g.timeouts < 1 || this.kick || !['presnap', 'dead'].includes(this.phase)) return false;
    g.timeouts--;
    this.spikeCall = false;
    this.stopClock('timeout');
    return true;
  },

  // Clock it: line up without a huddle and spike the ball as soon as
  // everybody is set. It costs the down.
  spikeBall() {
    const g = this.game;
    if (!g || g.over || g.stage !== 'drive' || !g.running || this.kick) return false;
    if (this.phase === 'dead') { if (!this.hurry()) return false; } else if (this.phase !== 'presnap') return false;
    this.spikeCall = true;
    return true;
  },

  // Sends the field-goal unit on. With the clock running it needs
  // CLOCK.unit s to get there, and time can run out first.
  fieldGoal() {
    const g = this.game;
    if (!g || g.over || g.stage !== 'drive' || this.kick || g.us + 3 < g.them || !['presnap', 'dead'].includes(this.phase)) return false;
    // Out of range from here: nobody sends the unit on.
    if (fieldGoalOdds(kickDistance((g.next || this).spot)) <= 0) return false;
    if (g.next) { this.spot = g.next.spot; this.down = g.next.down; this.toGo = g.next.toGo; g.next = null; }
    if (g.running && !this.runOff(Math.max(CLOCK.unitCall, CLOCK.unit - g.sinceWhistle))) return true;
    this.setKick('fg');
    return true;
  },

  // After a touchdown that leaves the offense level or behind: kick the
  // extra point, or go for two from the 2.
  tryKick() {
    const g = this.game;
    if (!g || g.stage !== 'pat' || g.us + 1 < g.them) return false;
    this.setKick('xp');
    return true;
  },

  tryTwo() {
    const g = this.game;
    if (!g || g.stage !== 'pat') return false;
    g.stage = 'try'; g.called = false; g.nextCall = null;
    this.spot = GOAL - 2; this.down = 1; this.toGo = 2;
    this.reset(true);
    return true;
  },

  // --- the hurry-up lineup -------------------------------------------------

  // Where everybody is now, and when each man may move (the clock is the
  // play's time plus the time since the whistle).
  bodies() {
    const dead = this.phase === 'dead', t = dead ? this.tackle : null;
    const wait = p => (!dead ? p.wait ?? -Infinity : !t ? -Infinity
      : t.at + (p.id === this.carrier ? HURRY.up.carrier : p.id === t.tackler ? HURRY.up.tackler : t.helpers.has(p.id) ? HURRY.up.helper : -Infinity));
    return new Map(this.players.map(p => [p.id, { x: p.x, z: p.z, vx: p.vx, vz: p.vz, facing: p.facing, phase: p.phase, team: p.team, role: p.role, wait: wait(p) }]));
  },

  // Puts the new down's players where the last one left them. A man who was
  // not on the field takes the place of one who went off (the same position
  // first), or comes on from the sideline.
  placeBodies(carry) {
    const off = [...carry].filter(([id]) => !this.byId[id]).map(([, b]) => b);
    for (const p of this.players) {
      let b = carry.get(p.id);
      if (!b) {
        let i = off.findIndex(o => o.team === p.team && o.role === p.role);
        if (i < 0) i = off.findIndex(o => o.team === p.team);
        b = i >= 0 ? off.splice(i, 1)[0] : { x: (Math.sign(p.start.x) || 1) * HURRY.sideline, z: p.start.z, vx: 0, vz: 0, facing: p.facing, phase: 0, wait: -Infinity };
      }
      Object.assign(p, { x: b.x, z: b.z, vx: b.vx, vz: b.vz, facing: b.facing, phase: b.phase, wait: b.wait, set: false, action: 'run' });
    }
    if (this.lining) this.lining.setAt = null;
  },

  stepLineup(dt) {
    const L = this.lining, clock = L.time + L.deadTime;
    L.deadTime += dt; L.elapsed += dt;
    let moving = 0;
    for (const p of this.players) {
      p.want = ZERO; p.sprinting = false; p.ease = 1;
      if (p.set) continue;
      moving++;
      if (clock < p.wait) continue;
      const gap = dist(p, p.start), speed = Math.hypot(p.vx, p.vz);
      if (gap < HURRY.near && speed < HURRY.slow) { this.setPlayer(p); moving--; continue; }
      const effort = p.role === 'ol' ? HURRY.effort.ol : HURRY.effort[p.team];
      p.want = seekWant(p, p.start, speedCap(p, effort));
    }
    this.moveAll(dt);
    const rate = HURRY.rate * dt;
    for (const p of this.players) {
      if (p.set) continue;
      const speed = Math.hypot(p.vx, p.vz), home = p.team === 'offense' ? 0 : Math.PI;
      const target = clock < p.wait ? p.facing : dist(p, p.start) > HURRY.turn && speed > 1 ? Math.atan2(p.vx, p.vz) : home;
      p.facing = wrapAngle(p.facing + clamp(wrapAngle(target - p.facing), -rate, rate));
      p.backpedal = speed > 0.8 && (p.vx * Math.sin(p.facing) + p.vz * Math.cos(p.facing)) / speed < -0.5;
      p.lean += (clamp(p.latAccel / p.agility, -1, 1) - p.lean) * (1 - Math.exp(-dt / 0.08));
      if (p.action === 'cut' && (p.actionTime -= dt) <= 0) p.action = 'run';
    }
    if (moving) L.setAt = null; else L.setAt ??= L.elapsed;
    if (L.elapsed >= HURRY.most || (L.setAt !== null && L.elapsed - L.setAt >= HURRY.set && L.deadTime >= HURRY.spot)) this.endLineup();
  },

  // In his stance on his spot, exactly as a huddle would have left him.
  setPlayer(p) {
    Object.assign(p, {
      x: p.start.x, z: p.start.z, vx: 0, vz: 0, facing: p.team === 'offense' ? 0 : Math.PI, set: true, action: 'ready', actionTime: 0,
      lean: 0, latAccel: 0, backpedal: false, cutting: false, sinceCut: 9, lastMoveAt: -9, juke: null, want: ZERO,
    });
  },

  endLineup() {
    for (const p of this.players) this.setPlayer(p);
    this.lining = null;
    // The replay of the next play starts from the stances.
    this.recording = []; this.recordClock = 0;
    this.saveFrame();
  },

  // --- kicks and the spike -------------------------------------------------

  formation() { return this.kick ? KICK_FORMATION : null; },

  // Lines up for a field goal ('fg') or an extra point ('xp'). The result is
  // drawn here (two numbers); the flight only shows it.
  setKick(kind) {
    const g = this.game;
    if (kind === 'xp') { this.spot = GOAL - KICK.xp; this.down = 1; this.toGo = KICK.xp; }
    if (this.lining) this.endLineup();
    this.spikeCall = false; g.next = null; g.stage = 'kick';
    const distance = kickDistance(this.spot), odds = fieldGoalOdds(distance);
    this.kick = { kind, distance, odds, good: this.random() < odds, where: this.random(), wait: KICK.set, struck: false, at: null };
    this.reset();
  },

  startKick() {
    const g = this.game, k = this.kick;
    this.phase = 'live';
    this.events.push('snap');
    g.running = k.kind === 'fg' && g.clock > 0; g.stopped = null; g.playClock = null;
    k.at = { x: this.pocketX(), z: this.spot - KICK.hold };
  },

  // A spike or a kick in progress: nobody blocks, rushes or covers.
  stepScripted(dt) {
    this.tickActions(dt);
    if (this.kick) this.planKick();
    this.moveAll(dt);
    this.updateBodies(dt);
    this.recordTrails();
    if (this.kick) this.flyKick(dt); else this.stepSpike();
  },

  planKick() {
    const k = this.kick, kicker = this.byId.R;
    if (this.time < KICK.go || this.phase !== 'live') return;
    kicker.want = scaled(k.at.x - kicker.x, k.at.z + 0.4 - kicker.z, speedCap(kicker, KICK.effort));
  },

  flyKick(dt) {
    const k = this.kick, kicker = this.byId.R;
    if (!k.struck) {
      if (this.time < KICK.snap) { this.holdBall(this.byId.QB); return; }
      this.carrier = null;
      this.restBall(k.at.x, k.at.z);
      if (this.time < KICK.late && dist(kicker, k.at) > KICK.reach) return;
      // To the posts (KICK): through them, wide of an upright or short.
      const D = END_LINE - k.at.z, time = KICK.hang[0] + D / KICK.hang[1], side = k.where < 0.5 ? -1 : 1, spread = Math.abs(k.where * 2 - 1);
      const short = !k.good && k.distance >= KICK.short && Math.floor(k.where * 1e4) % 2 === 0;
      const to = k.good ? { x: side * spread * KICK.inside, y: KICK.bar + KICK.clear }
        : short ? { x: side * spread * KICK.inside, y: 1 } : { x: side * (KICK.upright + KICK.wide + 2.5 * spread), y: KICK.bar + KICK.clear };
      this.launchBall({ x: k.at.x, y: 0.12, z: k.at.z }, { ...to, z: END_LINE }, time);
      k.struck = true;
      this.phase = 'air';
      this.events.push('kick');
      return;
    }
    const a = { ...this.ball }, landed = this.dropBall(dt), b = this.ball;
    if (a.z < END_LINE && b.z >= END_LINE) {
      const t = (END_LINE - a.z) / (b.z - a.z), x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      this.kickResult(Math.abs(x) < KICK.upright && y > KICK.bar);
    } else if (landed) this.kickResult(false);
  },

  kickResult(good) {
    const xp = this.kick.kind === 'xp';
    this.finish(good ? (xp ? 'Extra point is good' : 'Field goal is good') : 'No good', 0, good ? 'fieldgoal' : 'nogood');
  },

  afterKick(r) {
    const g = this.game, k = this.kick, good = r.kind === 'fieldgoal';
    r.distance = k.distance;
    if (good) g.us += k.kind === 'xp' ? 1 : 3;
    this.settle(k.kind === 'xp' ? (good ? 'Extra point' : 'Extra point missed') : good ? `Field goal from ${k.distance} yards` : `Missed from ${k.distance} yards`);
  },

  stepSpike() {
    const s = this.spike, qb = this.byId.QB;
    this.holdBall(qb);
    if (!s.wound && this.time >= SPIKE.wind) { s.wound = true; qb.action = 'throw'; qb.actionTime = 0.4; }
    if (this.time < SPIKE.release) return;
    // Into the turf at his feet: an incomplete pass.
    const fx = Math.sin(qb.facing), fz = Math.cos(qb.facing);
    this.ball = { x: qb.x + fz * 0.25 + fx * 0.5, y: 1.5, z: qb.z - fx * 0.25 + fz * 0.5, vx: fx * 3, vy: -9, vz: fz * 3 };
    this.carrier = null; this.threw = true; this.stats.attempts++;
    this.finish('Spiked', 0, 'incomplete');
  },
};
