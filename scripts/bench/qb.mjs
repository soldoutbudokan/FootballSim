// The scripted quarterback: plays like a competent human on a controller,
// not an oracle. He sees what the screen shows (every player's position and
// velocity, blocks, the ball) and knows the called play (its routes and its
// coaching cue). He never reads the defense's call, jobs or reads.
//
// Every TIME.look s after the drop sets he scores each receiver's openness
// (yards): separation from the nearest defender at the ball's arrival and
// now, less a penalty for each defender who can get a hand on the ball in
// the throwing lane. The receiver is carried along his route at full speed
// for the flight time; defenders along their velocity, then closing on the
// catch point once they have seen the throw. He throws to the first read if
// it is open, then to the best open man (open enough for his AGGRESSION),
// takes the checkdown late, escapes or throws it away under pressure and
// never holds the ball past TIME.hold. A seeded reaction delay, the time it
// takes to hold the button for the style, and an occasional late throw
// stand between deciding and the ball leaving his hand.
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
// Defenders at the ball's arrival: carried along their velocity for at most
// `horizon` s, then closing on the catch point at `close` yd/s once they
// have seen the throw (`react` s after the ball is out). Fitted by throwing
// to random receivers at random times: this matches the mean separation at
// the catch and correlates 0.48 with it (a gentle 3 yd/s closing: 0.37).
const READ = { horizon: 1.2, react: 0.45, close: 5 };
// Openness, in yards: `arrive` of the separation at the catch point plus
// `now` of the separation now (at most `nowCap` more than at arrival), less
// `lane` for each defender in the throwing lane (in full when he is on the
// line of the ball). A defender is in the lane when the ball passes him
// below `height` yd within his reach: `reach` yd, growing at `grow` yd/s
// once he has reacted (`react` s), to `reachMax`. A bullet from under
// `close` yd is harder to catch (`closeCost`); a lob with a defender over the
// top costs `overTop`.
const OPEN = { arrive: 0.7, now: 0.3, nowCap: 2, lane: 2.5, height: 2.6, reach: 0.9, grow: 3, react: 0.35, reachMax: 3, close: 8, closeCost: 0.3, overTop: 1 };
// What it takes to throw: openness of `start` yd at aggression 0, `span`
// less at aggression 1, easing by `decay` yd/s after the first read to a
// floor of `floor` (`floorSpan` less at aggression 1). The checkdown needs
// `checkdown`; under pressure anyone at `panic` (plus `panicSpan` × caution);
// at the end of the hold, anyone at `last`.
const NEED = { start: 3.4, span: 1.8, decay: 0.4, floor: 1.6, floorSpan: 0.6, checkdown: 1.2, panic: 1.0, panicSpan: 0.6, last: 0.6 };
// Choosing among open men: openness counts `open` (less `openSpan` ×
// aggression), expected yards `value` (plus `valueSpan` × aggression), and
// each step down the progression costs `order`.
const SCORE = { open: 1.1, openSpan: 0.6, value: 0.12, valueSpan: 0.18, order: 0.35, yac: 0.5, yacCap: 12 };
// Pressure, from each free defender's time to reach him (the gap less a
// tackling `reach`, over his closing speed). Within `near` yd and closing
// faster than `closing` yd/s: escape now. Arriving within `hot` s (from
// inside `hotRange` yd): throw hot and drift away. Arriving before he could
// get a throw off (his reaction plus `act` s): throw it away if nobody is
// open at all.
const PRESSURE = { near: 1.8, closing: 0.5, hot: 0.9, hotRange: 5, reach: 0.95, act: 0.12 };
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
    let best = this.best(pool, need);
    if (best) return { id: best, why };
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

  best(pool, need) {
    const a = this.aggression;
    let best = null, top = -Infinity;
    pool.forEach(id => {
      const look = this.looks[id];
      if (!look || !look.available || look.open < need) return;
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

  // The best throw to one receiver: the style that leaves him most open.
  look(sim, qb, p, id) {
    const now = nearest(sim.defense, p).gap;
    const styles = gap(qb, p) < 20 ? ['bullet', 'touch'] : ['touch', 'lob'];
    let best = null;
    for (const style of styles) {
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
    let sep = Infinity, close = null, room = 15;
    for (const d of sim.defense) {
      const e = this.defenderAt(d, wait, flight, at), g = Math.hypot(e.x - at.x, e.z - at.z);
      if (g < sep) { sep = g; close = e; }
      if (e.z > at.z - 1) room = Math.min(room, g);
    }
    const lane = this.lane(sim, qb, at, flight, wait);
    let open = OPEN.arrive * sep + OPEN.now * Math.min(now, sep + OPEN.nowCap) - OPEN.lane * lane;
    if (style === 'bullet' && gap(qb, at) < OPEN.close) open -= OPEN.closeCost;
    if (style === 'lob' && close && close.z > at.z && sep < 6) open -= OPEN.overTop;
    const depth = at.z - this.spot;
    return { style, at: { x: at.x, z: at.z }, flight, arriveSep: sep, lane, open, depth, value: depth + SCORE.yac * Math.min(room, SCORE.yacCap), lead: this.lead(at, close, sep) };
  }

  // Where a defender will be when the ball arrives: on his line for the
  // wait and the start of the flight, then closing on the catch point.
  defenderAt(d, wait, flight, at) {
    if (blocked(d)) return d;
    const h = Math.min(wait + flight, READ.horizon);
    let x = d.x + d.vx * h, z = d.z + d.vz * h;
    const reach = READ.close * Math.max(0, flight + TIME.release - READ.react);
    const dx = at.x - x, dz = at.z - z, g = Math.hypot(dx, dz);
    if (g > 0.3) { const k = Math.min(reach, g - 0.3) / g; x += dx * k; z += dz * k; }
    return { x, z };
  }

  // How many defenders can get a hand on the ball on its way (0 = a clean lane).
  lane(sim, qb, at, flight, wait) {
    const fx = qb.x, fz = qb.z, dx = at.x - fx, dz = at.z - fz, len2 = dx * dx + dz * dz;
    if (len2 < 1) return 0;
    let danger = 0;
    for (const d of sim.defense) {
      if (blocked(d)) continue;
      let s = clamp(((d.x - fx) * dx + (d.z - fz) * dz) / len2, 0, 1);
      const h = Math.min(wait + s * flight, READ.horizon);
      const px = d.x + d.vx * h, pz = d.z + d.vz * h;
      s = clamp(((px - fx) * dx + (pz - fz) * dz) / len2, 0, 1);
      if (s < 0.06 || s > 0.88) continue;
      const y = 1.85 - 0.25 * s + 0.5 * GRAVITY * flight * flight * s * (1 - s);
      if (y > OPEN.height) continue;
      const off = Math.hypot(fx + dx * s - px, fz + dz * s - pz);
      const reach = Math.min(OPEN.reachMax, OPEN.reach + OPEN.grow * Math.max(0, s * flight + TIME.release - OPEN.react));
      if (off < reach) danger += 1 - off / reach;
    }
    return danger;
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
    let near = null, hot = null, sack = false;
    for (const d of sim.defense) {
      if (blocked(d)) continue;
      const g = gap(d, qb), c = closing(d, qb), eta = Math.max(0, g - PRESSURE.reach) / Math.max(0.5, c);
      if (g < PRESSURE.near && c > PRESSURE.closing && (!near || g < near.gap)) near = { d, gap: g, closing: c };
      if (g < PRESSURE.hotRange && c > 1 && eta < PRESSURE.hot && (!hot || eta < hot.eta)) hot = { d, gap: g, eta };
      if (c > 0 && eta < this.reaction + PRESSURE.act) sack = true;
    }
    const n = nearest(sim.defense, qb);
    return { near, hot, sack, gap: n.gap, who: n.d?.id };
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
export const TUNING = { TIME, BALL, ROUTE, READ, OPEN, NEED, SCORE, PRESSURE, POCKET };
