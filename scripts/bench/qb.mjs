// The scripted quarterback: plays like a competent human on a controller,
// not an oracle. He sees what the screen shows (every player's position and
// velocity, blocks, the ball) and knows the called play (its routes and its
// coaching cue). He never reads the defense's call, jobs or reads.
//
// Every TIME.look s after the drop sets he scores each receiver's openness
// (yards) for each style of throw: how far the nearest defender is still
// short of the catch point when the ball gets there, and the separation
// now, less the throw's spread and a cost for each defender who can get a
// hand on the ball before the receiver. The receiver is carried along his
// route at full speed until the ball arrives; each defender keeps his run
// until he reacts (to the route if he is on the receiver, to the ball once
// it is out if not) and then sprints for the spot. He picks the style that
// leaves his man most open, never lobs into a man near the spot and never
// winds up a throw the rush will not give him time for. He throws to the
// first read if it is open (or to a man running free), then to the best
// open man (open enough for his AGGRESSION), takes the checkdown late,
// escapes or throws it away under pressure and never holds the ball past
// TIME.hold. A seeded reaction delay, the time it takes to hold the button
// for the style, and an occasional late throw stand between deciding and
// the ball leaving his hand.
import { plays } from './game.mjs';
import { generator, clamp, gap, lerp, topSpeed, blocked, nearest, closing, travel } from './util.mjs';
import { runway } from './carrier.mjs';

const { RECEIVERS, routeFor } = plays;
const GRAVITY = 10.73, HALF = 26.67;
// Timing, in seconds after the snap unless noted.
const TIME = {
  look: 0.1,                       // between decisions
  first: { pass: 1.0, pa: 1.3 },   // the first look: the drop has set, or the fake is done
  hot: 0.6,                        // the earliest throw, to a hot man in front of a free rusher
  fake: 1.1,                       // play action: no throw before the fake is done (sim.js requestThrow)
  firstRead: 0.4,                  // the first read alone gets this long after the first look
  checkdown: 2.6,                  // nothing open: take the checkdown
  hold: 4.5,                       // never hold the ball longer
  reaction: [0.15, 0.3],           // seeing it to pressing the button, one draw per rep
  charge: { lob: 0.06, touch: 0.16, bullet: 0.26 },  // holding the button for each style (README Controls)
  late: { chance: 0.12, extra: [0.15, 0.4] },        // now and then a throw comes out late
  release: 0.23,                   // button to ball out of the hand (sim.js requestThrow)
};
// Ball speeds by style (yd/s) and the flight-time clamp, as in the simulation.
const BALL = { bullet: 28, touch: 22, lob: 16, min: 0.42, max: 2.8 };
// A receiver slows into a break: each break costs `cut` s at top speed per
// 180 degrees of turn.
const ROUTE = { cut: 0.35 };
// Defenders, as he reads them. A man playing the receiver (within `near`
// yd of him, or of his run until the ball is out, as a corner he runs at;
// or already running at the catch point, within `heading` of it at
// `moving` yd/s or more) runs the receiver's route `lag` s late, from where
// he is; one beyond `far` yd keeps his own run (for at most `horizon` s: a
// drop settles); in between, in proportion. Each reads the ball `react` s
// after it is out (a deep man over the top breaks on it then) and sprints
// for the spot at `speed` of his top speed, accelerating at `accel` yd/s²
// from his speed that way and losing `cut` s at top speed per 180 degrees
// of turn. On random throws (any receiver, style and time) the margin
// this gives correlates 0.35 with the separation at the catch; the old
// model (his own line for 1.2 s, then 5 yd/s at the spot): 0.11.
const READ = { lag: 0.2, react: 0.3, horizon: 0.6, near: 3, far: 6, heading: Math.cos(60 * Math.PI / 180), moving: 4, speed: 1, accel: 6, cut: 0.1 };
// The throw's spread (yd), as in the simulation's THROW table: `set` plus
// `far` per yard past `crisp` by style, `moving` per 7 yd/s of his own
// speed, and up to `pressure` with a defender inside `near` yd (fully at
// `close`). The ball leaves 1.85 yd up and comes in `catch` yd up by style.
const THROW = { set: 0.18, far: { bullet: 0.035, touch: 0.045, lob: 0.06 }, crisp: 5, moving: 1.6, pressure: 2.8, near: 3.3, close: 0.6, catch: { bullet: 1.6, touch: 1.65, lob: 1.8 } };
// Openness, in yards: `arrive` of the margin at the catch point (how far
// the nearest defender is still short of it when the ball gets there, less
// than zero when he is there first; counted up to `cap`) plus `now` of the
// separation now (at most `nowCap` more than the margin), less `miss` of
// the throw's spread and `lane` for each defender who can get a hand on the
// ball before the receiver does: one within `reach` yd of its path (in full
// on it) while it is low enough to play (`low` to `high` yd up, `dl` for a
// lineman), more than `front` yd short of the catch, and at least `after`
// s out of the hand (no defender can play it sooner). A bullet from under
// `close` yd is harder to catch (`closeCost`). A lob, or any ball thrown
// `lobFrom` yd or more, needs `lob` yd of margin: he does not throw it up
// into a defender. A lob is no throw under `lobFrom` yd, and with the
// nearest man over the top it costs `overTop`, since a long miss is his
// ball. A man in trail (`trailing`) counts `trail` yd farther off: he must
// play the ball through the receiver, and fewer of his are picks.
const OPEN = {
  arrive: 0.7, cap: 8, now: 0.3, nowCap: 2, miss: 0.3, lane: 1.5, reach: 0.8, low: 0.55, high: 2.55, dl: 2.15, front: 3, after: 0.3, samples: 16,
  close: 8, closeCost: 0.3, lob: 2, lobFrom: 20, overTop: 0.5, trail: 1, trailGap: 5, trailBehind: 0.5,
};
// What it takes to throw: openness of `start` yd at aggression 0, `span`
// less at aggression 1, easing by `decay` yd/s after the first read to a
// floor of `floor` (`floorSpan` less at aggression 1). While he is on his
// first read, another man must be `free` yd more open and at least `short`
// yd downfield to catch his eye. A throw caught `deep` yd downfield or more
// needs `deepCut` yd less (in proportion from `short` yd): worth the risk
// of a breakup (the margin rule above keeps it from a pick). The checkdown
// needs `checkdown`; under pressure anyone at `panic` (plus `panicSpan` ×
// caution); at the end of the hold, anyone at `last`.
const NEED = { start: 2.8, span: 1.6, decay: 0.6, floor: 1.2, floorSpan: 0.6, free: 2, short: 10, deep: 30, deepCut: 1, checkdown: 1.0, panic: 1.0, panicSpan: 0.6, last: 0.6 };
// Choosing among open men: openness counts `open` (less `openSpan` ×
// aggression), expected yards `value` (plus `valueSpan` × aggression), and
// each step down the progression costs `order`.
const SCORE = { open: 1.1, openSpan: 0.6, value: 0.12, valueSpan: 0.18, order: 0.35, yac: 0.5, yacCap: 12 };
// Pressure, from each free defender's time to reach him (the gap less a
// tackling `reach`, over his closing speed). Within `near` yd and closing
// faster than `closing` yd/s: escape now. Arriving within `hot` s (from
// inside `hotRange` yd): throw hot and drift away. Arriving before he could
// get a throw off (his reaction plus `act` s): throw it away if nobody is
// open at all. The first to arrive from inside `clock` yd sets the time he
// has: a throw that would leave his hand later is no throw.
const PRESSURE = { near: 1.8, closing: 0.5, hot: 1.0, hotRange: 6.5, reach: 0.95, act: 0.12, clock: 10 };
// The pocket: a set quarterback stays `depth` yd behind the line when he
// steps up and `edge` yd inside the sideline; `drop` yd is a set drop (an
// under-centre drop is finished by hand); `box` yd wide of the centre is
// out of the pocket (as in protection.js); a roll-out goes `roll` yd wide.
// He scrambles, once flushed or late (`late` s), along the heading within
// `fan` of straight ahead with the most runway, if it is `lane` yd or more.
const POCKET = { depth: 2, edge: 22, drop: 5.5, box: 4.4, roll: 6, late: 3.2, lane: 4, fan: 50 * Math.PI / 180 };

// The read order from the play's coaching cue: receivers in the order the
// cue names them; one who clears, pulls or widens a defender goes after the
// others, one named as the checkdown or outlet goes last, and "roll toward
// {B}" names a direction, not a read. Receivers the cue does
// not name follow the named reads, deepest route first, the back last.
export function progression(play, depthOf = () => 0) {
  const text = play.read || '', named = [], clears = [], checks = [];
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    const id = m[1];
    if (!RECEIVERS.includes(id) || named.includes(id) || clears.includes(id) || checks.includes(id)) continue;
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 32).toLowerCase(), before = text.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    if (/toward\s*$/.test(before)) continue;
    if (/checkdown|outlet/.test(before) || /^\W*(is |as )?(the )?(checkdown|outlet)/.test(after)) checks.push(id);
    else if (/^(\W?s \w+ |\s+and \{\w+\}\s+)?\s*(clears?|fades? to clear|pulls|widen them)/.test(after)) clears.push(id);
    else named.push(id);
  }
  const rest = RECEIVERS.filter(id => !named.includes(id) && !clears.includes(id) && !checks.includes(id));
  const back = rest.filter(id => id === 'R'), others = rest.filter(id => id !== 'R').sort((a, b) => depthOf(b) - depthOf(a));
  const order = [...named, ...others, ...clears, ...back, ...checks];
  const checkdown = checks[0] || (play.routes?.R?.length ? 'R' : [...RECEIVERS].sort((a, b) => depthOf(a) - depthOf(b))[0]);
  return { order, clears, checkdown };
}

export class Quarterback {
  constructor(sim, { aggression = 0.5, seed = 1 } = {}) {
    const play = sim.effectivePlay ?? sim.play, flip = !!sim.config?.flip;
    this.random = generator(seed);
    this.aggression = clamp(aggression, 0, 1);
    this.reaction = lerp(TIME.reaction[0], TIME.reaction[1], this.random());
    this.passing = play.type !== 'run';
    this.first = play.type === 'pa' ? TIME.first.pa : TIME.first.pass;
    this.lockout = play.type === 'pa' ? TIME.fake : 0;
    this.spot = sim.spot;
    this.routes = {}; this.leg = {}; this.starts = {};
    for (const id of RECEIVERS) {
      const p = sim.byId[id];
      this.routes[id] = p ? routeFor(play, id, sim.spot, flip) : [];
      this.leg[id] = 0;
      this.starts[id] = p ? { x: p.x, z: p.z } : { x: 0, z: sim.spot };
    }
    const depthOf = id => Math.max(0, ...this.routes[id].map(q => q.z - sim.spot));
    Object.assign(this, progression(play, depthOf));
    this.pocketX = sim.byId.C ? sim.byId.C.x : 0;
    // A boot: "roll toward {B}" rolls to that receiver's side.
    const roll = /roll toward \{(\w+)\}/i.exec(play.read || '');
    this.rollSide = roll && this.starts[roll[1]] ? Math.sign(this.starts[roll[1]].x - this.pocketX) : 0;
    this.input = { x: 0, z: 0, sprint: false };
    this.nextLook = 0;
    this.pending = null;     // a decision waiting for the thumb: { at, id, style, lead, open } or { at, away }
    this.looks = {};         // the last evaluation of each receiver
    this.decision = null;    // the throw: { id, style, lead, open, arriveSep, lane, decidedAt, at, why }
    this.threwAway = false;
    this.scrambling = 0;     // the scramble heading (radians), 0 in the pocket
    this.escapes = 0;        // looks spent escaping a rusher
    this.escape = '';        // the last escape: step up, slide left or right
    this.clock = Infinity;   // s until the first free rusher gets to him
    this.note = 'drop';
  }

  // The stick for this step while the quarterback has the ball behind the line.
  pocket(sim) {
    const t = sim.time;
    if (this.pending && t >= this.pending.at - 1e-9) this.execute(sim);
    if (t >= this.nextLook - 1e-9) { this.nextLook = t + TIME.look; this.think(sim); }
    return this.input;
  }

  execute(sim) {
    const p = this.pending;
    this.pending = null;
    if (p.away) {
      if (sim.throwAway()) { this.threwAway = true; this.note = 'throw away'; }
      return;
    }
    if (sim.requestThrow(p.id, p.style, p.lead)) {
      this.decision = { id: p.id, style: p.style, lead: p.lead, open: p.open, value: p.value, arriveSep: p.arriveSep, lane: p.lane, decidedAt: p.decidedAt, at: sim.time, why: p.why };
      this.note = `throw ${p.id} ${p.style}`;
    } else this.note = `throw ${p.id} refused`;
  }

  think(sim) {
    const t = sim.time;
    if (!this.passing) { this.note = 'handoff'; return; }
    this.track(sim);
    const threat = this.threat(sim);
    if (this.decision || this.threwAway) { this.hold(); return; }
    this.move(sim, threat);
    if (this.pending) return;
    this.clock = threat.clock;
    const pressured = !!(threat.near || threat.hot);
    if (t < this.first && !(pressured && t >= TIME.hot)) { this.note = t < 0.6 ? 'drop' : this.note; return; }
    this.evaluate(sim);
    const pick = this.choose(sim, threat);
    if (pick?.away) { this.pending = { at: t + this.reaction, away: true }; this.note = 'throw away (decided)'; return; }
    if (pick) { this.schedule(sim, pick); return; }
    // Scrambling: aim again each look; keep running if the lane has closed.
    const heading = this.scrambleHeading(sim, threat);
    if (heading || this.scrambling) {
      this.scrambling = heading || this.scrambling;
      this.note = `scramble ${Math.round(this.scrambling * 180 / Math.PI)}°`;
      this.move(sim, threat);
    } else if (this.escape && (threat.near || threat.hot)) this.note = `${this.escape} (${(threat.near || threat.hot).d.id})`;
  }

  // Pick a target, a throw away, or nothing yet.
  choose(sim, threat) {
    const t = sim.time, a = this.aggression, since = t - this.first;
    let need = Math.max(NEED.floor - NEED.floorSpan * a, NEED.start - NEED.span * a - NEED.decay * Math.max(0, since - TIME.firstRead));
    let pool = since < TIME.firstRead ? this.order.slice(0, 1) : this.order, why = since < TIME.firstRead ? 'first read' : 'best open';
    if (threat.near || threat.hot) { pool = this.order; need = Math.min(need, NEED.panic + NEED.panicSpan * (1 - a)); why = 'hot'; }
    let best = this.best(pool, need, NEED.free);
    if (best) return { id: best, why: pool.includes(best) ? why : 'free' };
    const check = this.looks[this.checkdown];
    if (t >= TIME.checkdown && check?.available && check.open >= NEED.checkdown) return { id: this.checkdown, why: 'checkdown' };
    // About to be sacked: a throw would not get out in time, so throw it
    // away, unless he has already taken off (then he runs it).
    if (threat.sack && !this.scrambling) return { away: true };
    if (t >= TIME.hold) {
      best = this.best(this.order, NEED.last);
      return best ? { id: best, why: 'last chance' } : { away: true };
    }
    const top = pool.filter(id => this.looks[id]?.available).sort((x, y) => this.looks[y].open - this.looks[x].open)[0];
    this.note = top ? `${why}: ${top} ${this.looks[top].open.toFixed(1)} < ${need.toFixed(1)}` : why;
    return null;
  }

  // The best man open enough: `need` yd for the reads in `pool`, `free`
  // more for anyone else, less for a deep throw (NEED).
  best(pool, need, free = Infinity) {
    const a = this.aggression;
    let best = null, top = -Infinity;
    this.order.forEach(id => {
      const look = this.looks[id];
      if (!look || !look.available) return;
      const read = pool.includes(id);
      if (!read && look.depth < NEED.short) return;
      const bar = need + (read ? 0 : free) - NEED.deepCut * clamp((look.depth - NEED.short) / (NEED.deep - NEED.short), 0, 1);
      if (look.open < bar) return;
      const score = look.open * (SCORE.open - SCORE.openSpan * a) + look.value * (SCORE.value + SCORE.valueSpan * a) - SCORE.order * this.order.indexOf(id);
      if (score > top) { top = score; best = id; }
    });
    return best;
  }

  schedule(sim, pick) {
    const look = this.looks[pick.id];
    let delay = this.reaction + TIME.charge[look.style];
    if (this.random() < TIME.late.chance) delay += lerp(TIME.late.extra[0], TIME.late.extra[1], this.random());
    this.pending = { at: Math.max(sim.time + delay, this.lockout), id: pick.id, style: look.style, lead: look.lead, open: look.open, value: look.value, arriveSep: look.arriveSep, lane: look.lane, decidedAt: sim.time, why: pick.why };
    this.note = `${pick.why}: ${pick.id} ${look.style} open ${look.open.toFixed(1)}`;
  }

  evaluate(sim) {
    const qb = sim.byId.QB;
    for (const id of RECEIVERS) if (sim.byId[id]) this.looks[id] = this.look(sim, qb, sim.byId[id], id);
  }

  // The best throw to one receiver: the style that leaves him most open,
  // the quicker ball when it is close.
  look(sim, qb, p, id) {
    const now = nearest(sim.defense, p).gap;
    let best = null;
    for (const style of ['bullet', 'touch', 'lob']) {
      const option = this.option(sim, qb, p, id, style, now);
      if (!best || option.open > best.open + 0.05) best = option;
    }
    best.available = this.running(sim, p, id);
    best.sep = now;
    return best;
  }

  option(sim, qb, p, id, style, now) {
    const wait = this.reaction + TIME.charge[style] + TIME.release;
    let flight = 0.8, at = p;
    for (let i = 0; i < 3; i++) {
      at = this.ahead(p, id, wait + flight);
      flight = clamp(gap(qb, at) / BALL[style], BALL.min, BALL.max);
    }
    const length = gap(qb, at), arrive = wait + flight;
    let sep = Infinity, close = null, room = 15, lane = 0;
    for (const d of sim.defense) {
      // A blocked man stays on his block and cannot play the ball.
      const free = !blocked(d), on = free ? this.on(d, p, wait, flight, at) : 0;
      let short = this.short(d, free ? wait + READ.react : Infinity, at.x, at.z, arrive);
      if (on > 0) short = lerp(short, this.mirror(d, p, id, wait, flight, at), on);
      if (this.trailing(d, p, at)) short += OPEN.trail;
      if (short < sep) { sep = short; close = d; }
      if (d.z > at.z - 1) room = Math.min(room, Math.max(0, short));
      if (free) lane += this.inLane(d, lerp(wait + READ.react, READ.lag, on), qb, at, style, wait, flight, length);
    }
    const spread = this.spread(sim, qb, length, style);
    let open = OPEN.arrive * Math.min(sep, OPEN.cap) + OPEN.now * Math.min(now, Math.max(0, sep) + OPEN.nowCap) - OPEN.miss * spread - OPEN.lane * lane;
    if (style === 'bullet' && length < OPEN.close) open -= OPEN.closeCost;
    if (wait > this.clock || (style === 'lob' && length < OPEN.lobFrom) || ((style === 'lob' || length >= OPEN.lobFrom) && sep < OPEN.lob)) open = -Infinity;
    else if (style === 'lob' && close && close.z > at.z && sep < 6) open -= OPEN.overTop;
    const depth = at.z - this.spot;
    return { style, at: { x: at.x, z: at.z }, flight, arriveSep: sep, lane, spread, open, depth, value: depth + SCORE.yac * Math.min(room, SCORE.yacCap), lead: this.lead(at, close && this.toward(close, at, sep), sep) };
  }

  // How much a defender is playing this receiver (0 to 1, READ).
  on(d, p, wait, flight, at) {
    const sx = at.x - p.x, sz = at.z - p.z, len2 = sx * sx + sz * sz;
    const u = len2 > 1e-6 ? clamp(((d.x - p.x) * sx + (d.z - p.z) * sz) / len2, 0, wait / (wait + flight)) : 0;
    let on = clamp((READ.far - Math.hypot(p.x + sx * u - d.x, p.z + sz * u - d.z)) / (READ.far - READ.near), 0, 1);
    const speed = Math.hypot(d.vx, d.vz), g = gap(d, at);
    if (speed > 0.5 && g > 1e-6) {
      const cos = (d.vx * (at.x - d.x) + d.vz * (at.z - d.z)) / (speed * g);
      on = Math.max(on, clamp((cos - READ.heading) / (1 - READ.heading), 0, 1) * clamp(speed / READ.moving, 0, 1));
    }
    return on;
  }

  // How far a man playing the receiver is still short of the catch point
  // when the ball gets there: he runs the receiver's route `lag` s late
  // (where the receiver goes, he goes, from where he is) until he reads the
  // ball, then sprints for the spot from the receiver's speed and heading.
  mirror(d, p, id, wait, flight, at) {
    const lag = READ.lag, read = wait + READ.react;
    const was = { x: p.x - p.vx * lag, z: p.z - p.vz * lag };
    const then = this.ahead(p, id, Math.max(0, read - lag)), next = this.ahead(p, id, Math.max(0, read - lag) + 0.1);
    const ox = d.x + then.x - was.x, oz = d.z + then.z - was.z, dx = at.x - ox, dz = at.z - oz, g = Math.hypot(dx, dz);
    if (g < 1e-6) return 0;
    const hx = next.x - then.x, hz = next.z - then.z, step = Math.hypot(hx, hz), top = topSpeed(d) * READ.speed;
    const speed = Math.min(top, step / 0.1), along = step > 1e-6 ? speed * (hx * dx + hz * dz) / (step * g) : 0;
    const turn = step > 1e-6 ? Math.acos(clamp((hx * dx + hz * dz) / (step * g), -1, 1)) / Math.PI : 0;
    return g - Math.max(0, travel(Math.max(0, along), top, flight - READ.react, READ.accel) - top * READ.cut * turn);
  }

  // How far a defender is still short of the point (x, z) in `t` s (less
  // than zero when he gets there first): he keeps his run until `commit` s
  // (never, for a blocked man), then sprints for it, turning as a runner
  // must.
  short(d, commit, x, z, t) {
    const h = Math.min(t, commit, READ.horizon);
    const ox = d.x + d.vx * h, oz = d.z + d.vz * h, dx = x - ox, dz = z - oz, g = Math.hypot(dx, dz);
    if (t <= commit || g < 1e-6) return g;
    const speed = Math.hypot(d.vx, d.vz), along = speed > 0.1 ? (d.vx * dx + d.vz * dz) / g : 0;
    const turn = speed > 0.5 ? Math.acos(clamp(along / speed, -1, 1)) / Math.PI : 0;
    const top = topSpeed(d) * READ.speed;
    return g - Math.max(0, travel(Math.max(0, along), top, t - commit, READ.accel) - top * READ.cut * turn);
  }

  // A man chasing the receiver from behind (within `trailGap` yd, at
  // least `trailBehind` yd back along his run to the catch) has to play
  // the ball through him: the ball is put out in front, away from him.
  trailing(d, p, at) {
    const rx = at.x - p.x, rz = at.z - p.z, run = Math.hypot(rx, rz);
    return run > 1 && gap(d, p) < OPEN.trailGap && ((d.x - p.x) * rx + (d.z - p.z) * rz) / run < -OPEN.trailBehind;
  }

  // Where the nearest defender comes from: `short` yd back from the catch
  // point toward him (for the lead).
  toward(d, at, short) {
    const dx = d.x - at.x, dz = d.z - at.z, g = Math.hypot(dx, dz) || 1, k = Math.max(0.3, short) / g;
    return { x: at.x + dx * k, z: at.z + dz * k };
  }

  // How much of a hand one defender can get on the ball before the
  // receiver (0 to 1): the ball's path sampled while it is low enough for
  // him to play and short of the catch.
  inLane(d, commit, qb, at, style, wait, flight, length) {
    if (length < 1) return 0;
    const high = d.role === 'dl' ? OPEN.dl : OPEN.high, rise = 0.5 * GRAVITY * flight * flight, end = THROW.catch[style];
    let best = Infinity;
    for (let k = 1; k < OPEN.samples; k++) {
      const s = k / OPEN.samples, u = s * flight;
      if ((1 - s) * length < OPEN.front) break;
      if (u < OPEN.after) continue;
      const y = 1.85 + (end - 1.85) * s + rise * s * (1 - s);
      if (y < OPEN.low || y > high) continue;
      best = Math.min(best, this.short(d, commit, qb.x + (at.x - qb.x) * s, qb.z + (at.z - qb.z) * s, wait + u));
    }
    return clamp(1 - best / OPEN.reach, 0, 1);
  }

  // The spread of the throw (THROW): its length and style, his own speed,
  // and a rusher in his face.
  spread(sim, qb, length, style) {
    const rush = nearest(sim.defense, qb).gap, pressure = clamp((THROW.near - rush) / (THROW.near - THROW.close), 0, 1);
    return THROW.set + Math.max(0, length - THROW.crisp) * THROW.far[style] + Math.hypot(qb.vx, qb.vz) / 7 * THROW.moving + pressure * THROW.pressure;
  }

  // Lead (the arrow keys, -1/0/1 a side): away from a defender who will be
  // on him, never out of bounds, and back toward the quarterback (never
  // deeper: the simulation already leads him along his route).
  lead(at, close, sep) {
    const lead = { x: 0, z: 0 };
    if (!close || sep > 2.5) return lead;
    const ax = at.x - close.x, az = at.z - close.z, g = Math.hypot(ax, az) || 1;
    if (Math.abs(ax / g) > 0.45 && Math.abs(at.x + Math.sign(ax) * 2.5) < HALF - 1.5) lead.x = Math.sign(ax);
    if (az / g < -0.45) lead.z = -1;
    return lead;
  }

  // Each receiver's place on his route: the leg he is running.
  track(sim) {
    for (const id of RECEIVERS) {
      const p = sim.byId[id], r = this.routes[id];
      if (!p) continue;
      let k = this.leg[id];
      while (k < r.length - 1) {
        const from = k ? r[k - 1] : this.starts[id], to = r[k];
        const lx = to.x - from.x, lz = to.z - from.z, len = Math.hypot(lx, lz);
        const along = len > 1e-6 ? ((p.x - from.x) * lx + (p.z - from.z) * lz) / len : len;
        if (along >= len - 0.6 || gap(p, to) < 1) k++; else break;
      }
      this.leg[id] = k;
    }
  }

  // Where a receiver will be in `t` s: along the rest of his route at full
  // speed, slowing into each break, settling on the last landmark.
  ahead(p, id, t) {
    const r = this.routes[id], top = topSpeed(p);
    let left = travel(Math.hypot(p.vx, p.vz), top, t), x = p.x, z = p.z, hx = p.vx, hz = p.vz;
    for (let k = this.leg[id]; k < r.length && left > 0; k++) {
      const lx = r[k].x - x, lz = r[k].z - z, len = Math.hypot(lx, lz);
      if (len < 1e-6) continue;
      const hs = Math.hypot(hx, hz);
      if (hs > 0.5) left -= top * ROUTE.cut * Math.acos(clamp((hx * lx + hz * lz) / (hs * len), -1, 1)) / Math.PI;
      if (left <= len) { const k2 = Math.max(0, left) / len; return { x: x + lx * k2, z: z + lz * k2 }; }
      left -= len; x = r[k].x; z = r[k].z; hx = lx; hz = lz;
    }
    return { x, z };
  }

  // Out on his route, not staying in to block: a back who sits beside the
  // quarterback behind the line after the pickup window is blocking.
  running(sim, p, id) {
    if (id !== 'R') return true;
    return !(sim.time > 1.3 && p.z < this.spot && gap(p, sim.byId.QB) < 4.5 && Math.hypot(p.vx, p.vz) < 2);
  }

  // The rushers who matter: free men about to arrive (near), on their way
  // (hot), or close enough that only a throw away beats the sack.
  threat(sim) {
    const qb = sim.byId.QB;
    let near = null, hot = null, sack = false, clock = Infinity;
    for (const d of sim.defense) {
      if (blocked(d)) continue;
      const g = gap(d, qb), c = closing(d, qb), eta = Math.max(0, g - PRESSURE.reach) / Math.max(0.5, c);
      if (g < PRESSURE.near && c > PRESSURE.closing && (!near || g < near.gap)) near = { d, gap: g, closing: c };
      if (g < PRESSURE.hotRange && c > 1 && eta < PRESSURE.hot && (!hot || eta < hot.eta)) hot = { d, gap: g, eta };
      if (c > 0 && eta < this.reaction + PRESSURE.act) sack = true;
      if (g < PRESSURE.clock && c > 1) clock = Math.min(clock, eta);
    }
    const n = nearest(sim.defense, qb);
    return { near, hot, sack, clock, gap: n.gap, who: n.d?.id };
  }

  hold() { this.input.x = 0; this.input.z = 0; this.input.sprint = false; }

  // The stick in the pocket: finish an under-centre drop, roll on a boot,
  // step up or slide away from a rusher, or run once he has decided to.
  move(sim, threat) {
    const qb = sim.byId.QB, t = sim.time, input = this.input;
    this.hold();
    if (t < 0.6) return;
    if (this.scrambling) {
      input.x = Math.sin(this.scrambling); input.z = Math.cos(this.scrambling); input.sprint = true;
      return;
    }
    const rush = threat.near || threat.hot;
    if (!rush) {
      if (qb.z > this.spot - POCKET.drop && t < 1.6) { input.z = -0.7; return; }
      if (this.rollSide && t < 2.4 && Math.abs(qb.x - this.pocketX) < POCKET.roll && this.edgeClear(sim, this.rollSide)) {
        input.x = this.rollSide; input.z = -0.15; this.note = 'roll';
      }
      return;
    }
    // Escape: away from every free defender close by, weighted by nearness;
    // stepping up when the rush comes from the edge or behind, sliding when
    // it comes up the middle. A man still on his way only moves him a little.
    let rx = 0, rz = 0;
    for (const d of sim.defense) {
      if (blocked(d)) continue;
      const g = Math.max(0.4, gap(d, qb));
      if (g < 5) { rx += (qb.x - d.x) / (g * g * g); rz += (qb.z - d.z) / (g * g * g); }
    }
    const len = Math.hypot(rx, rz) || 1;
    let x = rx / len, z = rz / len;
    const middle = rush.d.z > qb.z + 0.4 && Math.abs(rush.d.x - qb.x) < 1.5;
    if (middle || z < -0.5) { x = Math.sign(x || qb.x - this.pocketX || 1); z = -0.2; this.escape = x < 0 ? 'slide left' : 'slide right'; }
    else { z = Math.max(z, 0) + 0.8; this.escape = 'step up'; }
    if (qb.z > this.spot - POCKET.depth) z = Math.min(z, 0);
    if (Math.abs(qb.x) > POCKET.edge && Math.sign(x) === Math.sign(qb.x)) x = 0;
    const l = Math.hypot(x, z) || 1, amount = threat.near ? 1 : 0.6;
    input.x = x / l * amount; input.z = z / l * amount;
    this.escapes++;
  }

  // Nobody free within a few yards of the roll point.
  edgeClear(sim, side) {
    const qb = sim.byId.QB, spot = { x: qb.x + side * 3, z: qb.z };
    return !sim.defense.some(d => !blocked(d) && gap(d, spot) < 3.5);
  }

  // Run for it: flushed (out of the pocket or a rusher on him) or late,
  // nothing open, and a heading that gains `lane` yd upfield before anyone
  // can get there. Returns the heading (radians, never exactly 0), or 0.
  scrambleHeading(sim, threat) {
    const qb = sim.byId.QB, t = sim.time;
    const flushed = Math.abs(qb.x - this.pocketX) > POCKET.box || threat.near || threat.hot;
    if (t < 1.5 || !(flushed || t > POCKET.late)) return 0;
    const side = Math.sign(qb.x - this.pocketX) || 1, speed = Math.hypot(qb.vx, qb.vz);
    let best = 0, gain = POCKET.lane - 1e-9;
    for (const k of [0, 0.5, 1, 1.4, -0.5, -1]) {
      const a = k * side * POCKET.fan, run = runway(sim, qb, Math.sin(a), Math.cos(a), speed);
      if (run.yards * Math.cos(a) > gain) { gain = run.yards * Math.cos(a); best = a || 1e-6; }
    }
    return best;
  }
}

// The tables, for experiments that tune the quarterback himself.
export const TUNING = { TIME, BALL, ROUTE, READ, THROW, OPEN, NEED, SCORE, PRESSURE, POCKET };
