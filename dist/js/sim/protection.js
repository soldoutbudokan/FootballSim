// Blocking: pass protection and the pass rush (the pocket), run blocking,
// and how blocked defenders fight through.
import { STEP, clamp, dist, scaled, seekWant, trackWant, speedCap, STUMBLE_SPEED, GET_OFF } from './common.js';

const SHED_RANGE = 1.6, SHED_TIME = 0.3;  // a blocked man reads the ball carrier
// Pass protection (the pocket). Tackles kick-slide back and out, guards and
// the centre set short (`kick` yd out, `depth` yd behind the line), and each
// blocker meets his rusher in the lane: the spot `square` yd from the rusher
// toward the quarterback, no more than `reach` yd either side of his set.
// A blocker within `engage` yd of a rusher, and nearer the quarterback than
// he is, locks up with him; a pair more than `part` yd apart comes unlocked.
// Locked, the rusher drives the blocker back at the matchup's push speed and
// wins the rep at a hazard rate of win × (t / ramp)³ per second, t the time
// since the snap, so pressure builds while the quarterback holds the ball.
// A spare lineman within `helpRange` yd scales it by `help`. A rusher within
// `close` yd of the quarterback adds `loose`, falling to `onMove` of it as
// the quarterback runs by (2 to 5 yd/s): moving the launch point beats the
// collapse. A quarterback out of the pocket (`box` yd wide of the centre)
// adds `scramble` for the rushers lined up on the side he rolls to, whose
// blockers he has run past, and `away` of it for the rest, so the near side
// comes off within a fraction of a second and the far side within about a
// second. The winner rips past at `rip` yd/s, `slip` yd to the side he won
// for each yard toward the quarterback, then aims up to `lean` yd to that
// side of the quarterback for `burst` s. Nobody can pick him up for `clear`
// s, and the beaten blocker stumbles for `beaten` s. Ends lined up more than
// `edge` yd wide rush the arc (aiming `arc` yd outside the quarterback per
// yard still to go, at most `arcMax`); the others push the A and B gaps
// (within `gap` yd of the centre). The back checks for a free rusher until
// `pickup` s after the snap and blocks him if one comes (unless he has a hot
// route); once he has blocked he stays in. Using him costs `backCost` yd in
// the protection count, so the line goes first.
const POCKET = {
  tackle: { kick: 0.9, depth: 2.0, reach: 2.4 }, guard: { kick: 0.15, depth: 1.2, reach: 2.2 }, centre: { kick: 0, depth: 1.1, reach: 2.4 },
  square: 0.95, engage: 1.3, part: 2.2, ramp: 2.5, help: 0.5, helpRange: 1.6,
  box: 4.4, close: 2, loose: 4, onMove: 0.25, scramble: 3, away: 0.33,
  beaten: 0.5, clear: 0.3, burst: 0.5, lean: 1.2, rip: 5.5, slip: 0.8, edge: 3.5, arc: 0.6, arcMax: 4.2, gap: 2.4, pickup: 1.2, backCost: 2,
};
// Pass-rush matchups: `push` is how fast the pair gives ground (yd/s), `win`
// the base hazard (per second) and `outside` the share of wins taken on the
// rusher's outside shoulder.
const MATCHUP = {
  edge: { push: 0.75, win: 0.3, outside: 0.7 },    // an end on a tackle: slow to collapse, likelier to win
  inside: { push: 1.1, win: 0.2, outside: 0.5 },  // a tackle or blitzer on a guard or centre: a steady push
  back: { push: 1.6, win: 0.8, outside: 0.5 },    // anyone on a back: he gives ground fast
};

export const protection = {
  // While the quarterback holds a called pass, the line protects the pocket
  // (see protect). Otherwise (run plays, and after a catch or a scramble over
  // the line) each lineman takes a defender (see assignBlocks) and the pair
  // locks up until the defender's shed time; locked defenders drive toward
  // the ball slowly.
  planBlocking(dt = STEP) {
    const run = this.play.type === 'run', guard = this.guardPoint();
    this.byId.R.pickup = null;
    if (this.time < GET_OFF.ol) return;
    if (this.inPocket()) { this.protect(dt); return; }
    for (const p of this.players) p.lock = null;
    this.readTheBall();
    const assigned = this.assignBlocks();
    for (const o of this.line) {
      if (run && o.id === this.play.pullingGuard && this.pullBlock(o)) continue;
      const d = assigned.get(o.id);
      if (!d) continue;
      if (dist(o, d) < 1.55 && this.time < d.shed + (run ? 0.9 : 0) && d.action !== 'stumble') this.engage(o, d);
      let target;
      if (o.engaged) {
        // Stay square between the defender and the ball.
        const away = scaled(guard.x - d.x, guard.z - d.z, 0.95);
        target = { x: d.x + away.x, z: d.z + away.z };
      } else if (run) {
        const side = Math.sign(this.play.lane || 1) * (this.config.flip ? -1 : 1);
        const stretch = this.play.blocking === 'stretch';
        target = { x: d.x + side * (stretch ? 0.85 : 0.2), z: d.z - (stretch ? 0.4 : 0.7) };
      }
      else target = { x: d.x, z: Math.min(this.spot - 0.7, d.z - 0.8) };
      o.want = seekWant(o, target, speedCap(o, run ? 0.85 : 0.5));
      o.sprinting = false;
    }
  },

  // A called pass while the quarterback still holds the ball behind the line
  // or has just let it go.
  inPocket() {
    return this.play.type !== 'run' && !this.pursuing() && (this.phase === 'live' || this.phase === 'air');
  },

  pursuing() {
    return this.phase === 'run' || this.phase === 'tackle' || this.crossedLine || (this.play.type === 'run' && this.time > 0.8);
  },

  rushers() { return this.defense.filter(d => d.rushing); },

  pocketX() { return this.byId.C ? this.byId.C.start.x : 0; },

  // The quarterback has left the pocket sideways.
  scrambling() { return this.carrier === 'QB' && Math.abs(this.byId.QB.x - this.pocketX()) > POCKET.box; },

  // Where a rusher lined up: his side of the centre, and whether he is an end
  // outside the tackles.
  rushSide(d) {
    const off = d.start.x - this.pocketX();
    return { off, side: Math.sign(off) || 1, edge: Math.abs(off) > POCKET.edge };
  },

  matchup(o, d) {
    return o.role === 'rb' ? MATCHUP.back : this.rushSide(d).edge ? MATCHUP.edge : MATCHUP.inside;
  },

  // Where a lineman sets: tackles kick back and out, guards and centre short.
  setPoint(o) {
    const off = o.start.x - this.pocketX(), a = Math.abs(off);
    const set = a > 2.4 ? POCKET.tackle : a > 0.8 ? POCKET.guard : POCKET.centre;
    return { x: o.start.x + Math.sign(off) * set.kick, z: this.spot - set.depth, reach: set.reach };
  },

  // The spot between a rusher and the quarterback where a blocker squares up.
  squarePoint(d, extra = 0) {
    const qb = this.byId.QB, away = scaled(qb.x - d.x, qb.z - d.z, POCKET.square + extra);
    return { x: d.x + away.x, z: d.z + away.z };
  },

  // Pass protection. Pairs already locked fight it out first (contest); then
  // the free blockers (linemen who are neither locked nor beaten, and the
  // back while he checks or once he has blocked) are matched to the free
  // rushers (assignProtection) and lock up with them on contact. A spare
  // blocker picks up any free rusher who comes within reach.
  protect(dt) {
    const rushers = this.rushers(), rb = this.byId.R;
    for (const d of rushers) if (d.lock) this.contest(this.byId[d.lock], d, dt);
    const catching = this.phase === 'air' && this.pass.receiver === 'R';
    if (catching && rb.lock) { this.byId[rb.lock].lock = null; rb.lock = null; }
    // A back with a hot route runs it; one lined up in the backfield checks.
    const back = !this.hotRoutes.R && rb.start.z < this.spot - 3 && this.carrier !== 'R' && !catching && !rb.released;
    const blockers = this.line.filter(o => !o.lock && this.time >= o.beatenUntil);
    if (back && !rb.lock && this.time >= rb.beatenUntil) blockers.push(rb);
    const free = rushers.filter(d => !d.lock);
    const plan = this.assignProtection(blockers, free);
    for (const o of [...this.line, rb]) if (!blockers.includes(o)) o.assignment = o.lock;
    for (const o of blockers) {
      const d = plan.get(o.id);
      o.assignment = d ? d.id : null;
      if (d && this.canLock(o, d)) this.lock(o, d);
    }
    for (const o of blockers) {
      if (o.lock || o.assignment) continue;
      const d = free.find(q => !q.lock && this.canLock(o, q));
      if (d) this.lock(o, d);
    }
    // The back blocks only once he has a man; with none by the end of his
    // check he releases into his route for good. Once he has blocked he stays
    // in, beaten or not: `pickup` is his man, or 'QB' while he has none.
    if (back && !rb.blocked && !rb.lock && !rb.assignment && this.time >= POCKET.pickup) rb.released = true;
    for (const o of this.line) this.passSet(o, rushers);
    if (back && (rb.lock || rb.assignment || rb.blocked)) { this.passSet(rb, rushers); rb.pickup = rb.lock || rb.assignment || 'QB'; }
  },

  // One blocker's step in protection: locked, stay square between the rusher
  // and the quarterback, giving ground as the rusher pushes; assigned, meet
  // him in his lane from the set point; spare, sit behind the nearest block
  // ready to help; beaten, recover toward the quarterback. The back has no
  // set point: he works from a spot just in front of the quarterback.
  passSet(o, rushers) {
    o.sprinting = false;
    const back = o.role === 'rb', qb = this.byId.QB;
    const set = back ? { x: qb.x, z: qb.z + 1.2, reach: 2 } : this.setPoint(o);
    if (o.lock) {
      const d = this.byId[o.lock];
      this.engage(o, d);
      o.want = trackWant(o, this.squarePoint(d), { x: d.vx, z: d.vz }, speedCap(o, 0.7));
      return;
    }
    const d = o.assignment ? this.byId[o.assignment] : null;
    if (d) {
      const lane = this.squarePoint(d);
      const target = back ? { x: lane.x, z: Math.min(lane.z, this.spot - 1) }
        : { x: clamp(lane.x, set.x - set.reach, set.x + set.reach), z: Math.min(set.z, lane.z) };
      o.want = seekWant(o, target, speedCap(o, back ? 0.85 : 0.6));
      return;
    }
    if (this.time < o.beatenUntil) { o.want = seekWant(o, { x: set.x, z: set.z - 0.6 }, speedCap(o, 0.7)); return; }
    let near = null;
    for (const q of rushers) if (!near || dist(q, set) < dist(near, set)) near = q;
    const behind = near && dist(near, set) < 4 ? this.squarePoint(near, 1) : set;
    o.want = seekWant(o, { x: clamp(behind.x, set.x - set.reach, set.x + set.reach), z: Math.min(set.z, behind.z) }, speedCap(o, 0.6));
  },

  // A blocker can only take on a rusher he is in front of (nearer the
  // quarterback): a beaten man must get back between them first.
  canLock(o, d) {
    const qb = this.byId.QB;
    return dist(o, d) < POCKET.engage && this.time - d.wonAt >= POCKET.clear && dist(o, qb) < dist(d, qb);
  },

  // Blocker and rusher lock up. The rusher draws how much pressure it takes
  // him to win this rep (an exponential threshold, so wins are spread in time
  // and fixed by the seed) and the side he will win on.
  lock(o, d) {
    o.lock = d.id; d.lock = o.id; o.assignment = d.id;
    if (o.role === 'rb') o.blocked = true;
    const m = this.matchup(o, d), { side } = this.rushSide(d);
    d.need = -Math.log(1 - this.random()); d.have = 0;
    d.winSide = side * (this.random() < m.outside ? 1 : -1);
    d.vx *= 0.8; d.vz *= 0.8;
  },

  // A locked rep. Pressure builds with the time since the snap; a spare
  // lineman beside the block slows it, and a rusher at the quarterback (less
  // so at one on the move) or a quarterback out of the pocket speeds it (more
  // on the side he rolls to). The winner beats his blocker, who stumbles and
  // cannot block for a moment.
  contest(o, d, dt) {
    if (!o || dist(o, d) > POCKET.part) { if (o) o.lock = null; d.lock = null; return; }
    const qb = this.byId.QB, m = this.matchup(o, d);
    let rate = m.win * (this.time / POCKET.ramp) ** 3;
    if (this.line.some(h => h !== o && !h.lock && !h.assignment && this.time >= h.beatenUntil && dist(h, d) < POCKET.helpRange)) rate *= POCKET.help;
    if (dist(d, qb) < POCKET.close) {
      const moving = clamp((Math.hypot(qb.vx, qb.vz) - 2) / 3, 0, 1);
      rate += POCKET.loose * (1 - (1 - POCKET.onMove) * moving);
    } else if (this.scrambling()) {
      const near = this.rushSide(d).side === Math.sign(qb.x - this.pocketX());
      rate += POCKET.scramble * (near ? 1 : POCKET.away);
    }
    d.have += rate * dt;
    if (d.have < d.need) return;
    o.lock = d.lock = null; o.assignment = null;
    o.beatenUntil = this.time + POCKET.beaten; o.action = 'stumble'; o.actionTime = POCKET.beaten;
    o.vx *= STUMBLE_SPEED; o.vz *= STUMBLE_SPEED;
    // The rip or swim: over a quarter second (the juke blend) the rusher
    // goes from his push to `rip` yd/s past the blocker's shoulder.
    const toQB = scaled(qb.x - d.x, qb.z - d.z, 1), past = scaled(toQB.x + d.winSide * POCKET.slip, toQB.z, POCKET.rip);
    d.juke = { t: 0, from: { x: d.vx, z: d.vz }, to: past };
    d.wonAt = this.time;
    this.events.push('block-win');
  },

  // Protection: block the most dangerous rushers, those who would reach the
  // quarterback first, so the one left free is the farthest; among those
  // choices take the shortest trips (so the line slides toward an overload),
  // keep last step's man, and use the back only when the line runs out.
  // Exact search over every matching (at most six blockers and six rushers).
  assignProtection(blockers, rushers) {
    const qb = this.byId.QB, n = blockers.length, k = rushers.length, full = 1 << k;
    const plan = new Map();
    if (!n || !k) return plan;
    const cost = blockers.map(o => rushers.map(d => dist(o, this.squarePoint(d)) - (o.assignment === d.id ? 1 : 0) + (o.role === 'rb' ? POCKET.backCost : 0)));
    // Leaving a rusher free costs far more than any trip, and more the sooner
    // he would arrive (about 2 yd of trips per yard nearer the quarterback).
    const free = rushers.map(d => 100 - 14 * dist(d, qb) / d.top);
    const best = Array.from({ length: n + 1 }, () => new Float64Array(full));
    const pick = Array.from({ length: n }, () => new Int8Array(full));
    for (let mask = 0; mask < full; mask++) for (let j = 0; j < k; j++) if (!(mask & 1 << j)) best[n][mask] += free[j];
    for (let i = n - 1; i >= 0; i--) for (let mask = 0; mask < full; mask++) {
      let b = best[i + 1][mask], choice = -1;
      for (let j = 0; j < k; j++) {
        if (mask & 1 << j) continue;
        const c = cost[i][j] + best[i + 1][mask | 1 << j];
        if (c < b - 1e-9) { b = c; choice = j; }
      }
      best[i][mask] = b; pick[i][mask] = choice;
    }
    for (let i = 0, mask = 0; i < n; i++) {
      const j = pick[i][mask];
      if (j >= 0) { plan.set(blockers[i].id, rushers[j]); mask |= 1 << j; }
    }
    return plan;
  },

  // Where a rusher aims, as a lateral shade (yd, + toward +x) off the
  // quarterback: an end rushes the arc outside the tackle, bending in as he
  // reaches the quarterback's depth; an inside man pushes his gap; a rusher
  // who just won goes past his blocker on that side, then straight in. On a
  // scramble the end on that side contains (keeps outside leverage) and the
  // others chase.
  rushShade(d) {
    const qb = this.byId.QB, x0 = this.pocketX(), { off, side, edge } = this.rushSide(d);
    if (this.scrambling()) return edge && Math.sign(qb.x - x0) === side ? side * this.skill.contain : 0;
    const since = this.time - d.wonAt;
    if (since < POCKET.burst) return d.winSide * POCKET.lean * (1 - since / POCKET.burst);
    if (d.wonAt > 0) return 0;
    const depth = Math.max(0, d.z - qb.z);
    if (edge) return side * Math.min(POCKET.arcMax, POCKET.arc * depth);
    return (x0 + clamp(off, -POCKET.gap, POCKET.gap) - qb.x) * clamp(depth / 8, 0, 1);
  },

  // A gap scheme pulls its backside guard behind the line before he leads
  // through the called gap. The other four linemen cover his vacated matchup.
  pullBlock(o) {
    if ((o.pullStage || 0) >= 2) return false;
    const side = this.config.flip ? -1 : 1, lane = this.play.lane * side;
    o.pullStage ||= 0;
    const target = o.pullStage === 0 ? { x: o.start.x, z: this.spot - 1.9 } : { x: lane, z: this.spot - 1.9 };
    if (dist(o, target) < 0.65 || this.time > (o.pullStage === 0 ? 0.65 : 1.9)) o.pullStage++;
    if (o.pullStage >= 2) return false;
    o.want = seekWant(o, target, speedCap(o, 0.9));
    return true;
  },

  // A blocked defender comes off his block when the ball carrier gets close:
  // SHED_TIME to disengage, so a back hitting the hole cleanly is past him,
  // and one dancing beside the block is not.
  readTheBall() {
    const c = this.byId[this.carrier];
    if (!c) return;
    const bonus = this.play.type === 'run' ? 0.9 : 0;
    for (const d of this.defense) {
      if (dist(d, c) < SHED_RANGE) d.shed = Math.min(d.shed, this.time + SHED_TIME - bonus);
    }
  },

  // Blocking assignments: the closest lineman-defender pairs are matched
  // first, so two linemen never take the same man and nobody leaves a rusher
  // to his neighbour. A lineman keeps his man unless another is much closer.
  assignBlocks() {
    const pairs = [];
    for (const o of this.line) for (const d of this.defense) {
      if (this.play.type === 'run' && o.id === this.play.pullingGuard && (o.pullStage || 0) < 2) continue;
      pairs.push({ o, d, cost: dist(o, d) - (o.assignment === d.id ? 1.5 : 0) });
    }
    pairs.sort((a, b) => a.cost - b.cost || a.o.number - b.o.number || a.d.number - b.d.number);
    const taken = new Set(), result = new Map();
    for (const { o, d } of pairs) {
      if (result.has(o.id) || taken.has(d.id)) continue;
      result.set(o.id, d); taken.add(d.id); o.assignment = d.id;
    }
    return result;
  },

  engage(a, b) {
    a.engaged = b.id; b.engaged = a.id;
    for (const p of [a, b]) if (!['stumble', 'tackle', 'catch'].includes(p.action)) { p.action = 'block'; p.actionTime = 0.1; }
  },

  // What blockers protect and engaged defenders drive toward.
  guardPoint() {
    const c = this.byId[this.carrier];
    if (c) return c;
    return this.byId.QB;
  },

  // A blocked defender keeps driving toward the ball. In pass protection the
  // rusher drives his blocker back along his rush lane at the matchup's push
  // speed and the pair slides with the quarterback; elsewhere he leans toward
  // the ball at a walking pace.
  drivePast(d) {
    d.sprinting = false;
    if (d.lock) {
      const o = this.byId[d.lock], qb = this.byId.QB;
      const push = scaled(qb.x + this.rushShade(d) - d.x, qb.z - d.z, this.matchup(o, d).push);
      d.want = { x: push.x + qb.vx * 0.85, z: push.z };
      return;
    }
    const goal = this.guardPoint(), run = this.play.type === 'run' || this.phase === 'run';
    d.want = scaled(goal.x - d.x, goal.z - d.z, run ? 0.3 : 0.6);
  },

  // A rusher's step: his lane (rushShade), flat out once the quarterback
  // scrambles.
  rushWant(d) {
    d.turned = true;
    return this.pursue(d, 'QB', speedCap(d, this.scrambling() ? 1 : 0.92), this.rushShade(d));
  },
};
