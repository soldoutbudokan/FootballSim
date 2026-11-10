// Teammates without the ball: whom a free blocker takes and where he goes.
// A coach's rule, the same at every difficulty: block the most dangerous
// man, the free defender who would get to the ball carrier first, and take
// him where you can still get in his way; with nobody to block, get in front
// of the ball. Used by the receivers (downfield on a run, after a catch, on a
// scramble past the line and once a pass is in the air to somebody else) and
// by a lineman on a run whose own man is gone or out of reach (sim/run.js).
// Blockers see the defenders where they are now, and never where they will
// cut to.
import { RECEIVERS } from '../plays.js';
import { clamp, dist, scaled, seekWant, speedCap } from './common.js';

// The plan is made every `every` steps. A defender is a threat when he can
// meet the carrier, as the carrier runs now, within `horizon` s; one more
// than `behind` yd behind the carrier is nobody's (a block in the back), and
// so is one who is not playing the ball yet (see coming: `at`, `coming`). A
// blocker can take a threat he is within `near` yd of, or whose line to the
// meeting point he can step into in time: the first of the `samples` (shares
// of that line) he reaches, at `pace` of his top speed after `start` s, no
// later than `slack` s after the defender. Threats are handed out most
// dangerous first, each to the blocker who gets there soonest; a blocker
// keeps the man he had unless another blocker beats him to that man by
// `keep` s. Within `close` yd he squares up `off` yd from his man, between
// him and the ball; farther off he runs at the cut-off point and arrives at
// `arrive` of his speed. A pass in the air: the others see it `see` s after
// the release, go to their man and wait `wait` yd off him until the catch;
// a defender who will be at the catch within `wave` s of the ball is left
// alone (he cannot be cut off, and must not be touched).
// With nobody to block (ESCORT) a man ahead of the carrier gets `ahead` yd in
// front of him and `side` yd to his own side at `effort` of his speed; one
// behind him follows at `trail`, no closer than `room` yd.
export const SUPPORT = {
  every: 4, horizon: 4, behind: 1, near: 1.6, samples: [0.2, 0.4, 0.6, 0.8, 0.95], pace: 0.85, start: 0.1, slack: 0.1,
  keep: 0.35, close: 3, off: 0.9, arrive: 0.6, see: 0.25, wait: 2, wave: 0.3, at: 5, coming: 2,
};
const ESCORT = { ahead: 5, side: 2.5, effort: 0.9, trail: 0.6, room: 4, edge: 24 };
const DOWN = new Set(['stumble', 'tackle', 'down']);

// Seconds until a man running `speed` yd/s can meet a target now (dx, dz)
// away and moving at (vx, vz); Infinity if he never can.
export function meetTime(dx, dz, vx, vz, speed) {
  const a = vx * vx + vz * vz - speed * speed, b = 2 * (dx * vx + dz * vz), c = dx * dx + dz * dz;
  if (c < 1e-9) return 0;
  if (Math.abs(a) < 1e-6) return b < -1e-9 ? -c / b : Infinity;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const root = Math.sqrt(disc), r1 = (-b - root) / (2 * a), r2 = (-b + root) / (2 * a);
  const t = Math.min(r1 >= 0 ? r1 : Infinity, r2 >= 0 ? r2 : Infinity);
  return t;
}

export const support = {
  // What the blockers protect: the ball carrier as he runs now; before the
  // handoff the hole the play is called to (they know their own call); a
  // pass in the air, the spot it is thrown to. Null while the quarterback
  // holds the ball behind the line.
  supportRef() {
    if (this.phase === 'air') return this.pass ? { x: this.pass.target.x, z: this.pass.target.z, vx: 0, vz: 0, fixed: true, air: true, carrier: null, left: Math.max(0, this.pass.duration - this.pass.elapsed) } : null;
    if (this.play.type === 'run' && !this.handoff) {
      const st = this.runState();
      return { x: this.pocketX() + st.side * Math.abs(this.play.lane || 2), z: this.spot + 0.5, vx: 0, vz: 0, fixed: true, air: false, carrier: null };
    }
    const c = this.byId[this.carrier];
    if (!c || (c.id === 'QB' && !this.crossedLine && this.play.type !== 'run')) return null;
    return { x: c.x, z: c.z, vx: c.vx, vz: c.vz, fixed: false, air: false, carrier: c };
  },

  // How dangerous a defender is to `ref`: when and where he meets it running
  // flat out (`T` s, at `mx`, `mz`). T is Infinity for a man who cannot.
  threatOf(d, ref) {
    const dx = ref.x - d.x, dz = ref.z - d.z, speed = speedCap(d);
    if (ref.fixed) return { d, T: Math.hypot(dx, dz) / speed, mx: ref.x, mz: ref.z };
    const T = meetTime(dx, dz, ref.vx, ref.vz, speed);
    return { d, T, mx: ref.x + ref.vx * (Number.isFinite(T) ? T : 0), mz: ref.z + ref.vz * (Number.isFinite(T) ? T : 0) };
  },

  // A defender is playing the ball: within `at` yd of it, or running at it
  // (or at where he would meet it) at `coming` yd/s or more. A man still in
  // coverage, backing off with his receiver, is not a threat yet: the
  // receiver runs him off instead of stopping to block him.
  coming(d, ref) {
    const dx = ref.x - d.x, dz = ref.z - d.z, gap = Math.hypot(dx, dz);
    if (gap < SUPPORT.at) return true;
    return (d.vx * dx + d.vz * dz) / gap >= SUPPORT.coming;
  },

  // Where blocker `o` can get in the way of a threat (SUPPORT): the point
  // and when he gets there, or null if the man is past him.
  cutOff(o, th) {
    const d = th.d;
    if (dist(o, d) < SUPPORT.near) return { x: d.x, z: d.z, t: 0 };
    const pace = speedCap(o) * SUPPORT.pace;
    for (const s of SUPPORT.samples) {
      const x = d.x + (th.mx - d.x) * s, z = d.z + (th.mz - d.z) * s;
      const t = Math.hypot(x - o.x, z - o.z) / pace + SUPPORT.start;
      if (t <= s * th.T + SUPPORT.slack) return { x, z, t };
    }
    return null;
  },

  // This rep's support state, made fresh for every new set of players.
  supportState() {
    let st = this.supportPlan;
    if (!st || st.players !== this.players) st = this.supportPlan = { players: this.players, count: 0 };
    return st;
  },

  // Hand the threats out to the free blockers (see SUPPORT). `blockers` are
  // the men with nobody; `taken` the defenders somebody else already has;
  // `barred(o, d)` a man this blocker may not take (one who just got off
  // him). Sets each blocker's `support`: { id, x, z } or null. A blocker in
  // `pinned` keeps what he has. Returns the reference point.
  planSupport(blockers, taken, barred, pinned) {
    const st = this.supportState(), ref = this.supportRef();
    if (!ref) { for (const o of blockers) o.support = null; return null; }
    const free = blockers.filter(o => !(pinned && pinned.has(o.id)));
    if (st.count++ % SUPPORT.every) {
      // Between plans a blocker only loses a man who is gone.
      for (const o of free) if (o.support) { const d = this.byId[o.support.id]; if (!d || DOWN.has(d.action) || taken.has(d.id)) o.support = null; }
      return ref;
    }
    const threats = [];
    for (const d of this.defense) {
      if (taken.has(d.id) || DOWN.has(d.action)) continue;
      if (ref.carrier && d.z < ref.z - SUPPORT.behind) continue;
      const th = this.threatOf(d, ref);
      // A man who will be at the catch when the ball is cannot be cut off
      // (and must not be touched): the blockers take the next wave.
      if (ref.air && th.T < ref.left + SUPPORT.wave) continue;
      if (th.T < SUPPORT.horizon && this.coming(d, ref)) threats.push(th);
    }
    threats.sort((a, b) => a.T - b.T || a.d.number - b.d.number);
    const next = new Map();
    for (const th of threats) {
      let best = null, cost = Infinity, where = null;
      for (const o of free) {
        if (next.has(o.id) || (barred && barred(o, th.d))) continue;
        const cut = this.cutOff(o, th);
        if (!cut) continue;
        const c = cut.t - (o.support && o.support.id === th.d.id ? SUPPORT.keep : 0);
        if (c < cost) { cost = c; best = o; where = cut; }
      }
      if (best) next.set(best.id, { id: th.d.id, x: where.x, z: where.z });
    }
    for (const o of free) o.support = next.get(o.id) || null;
    return ref;
  },

  // A blocker's run at the man he picked: at the cut-off point while he is
  // far off, squared up between him and the ball once he is close.
  supportWant(o, d, pick, ref, effort = 1) {
    const cap = speedCap(o, effort);
    if (dist(o, d) < SUPPORT.close) {
      const away = scaled(ref.x - d.x, ref.z - d.z, SUPPORT.off);
      return seekWant(o, { x: d.x + away.x, z: d.z + away.z }, cap * 0.9);
    }
    return seekWant(o, pick, cap, cap * SUPPORT.arrive);
  },

  // Nobody to block: get in front of the ball carrier, or follow the play.
  escortWant(o, ref) {
    const c = ref.carrier;
    if (!c) return null;
    const gap = dist(o, c);
    if (o.z > c.z + 1) {
      const side = Math.abs(o.x - c.x) > 0.5 ? Math.sign(o.x - c.x) : this.playSide();
      const spot = { x: clamp(c.x + side * ESCORT.side, -ESCORT.edge, ESCORT.edge), z: Math.min(118, c.z + ESCORT.ahead) };
      return seekWant(o, spot, speedCap(o, ESCORT.effort), Math.min(Math.hypot(c.vx, c.vz), speedCap(o, ESCORT.effort)));
    }
    if (gap < ESCORT.room) return { x: c.vx * 0.5, z: c.vz * 0.5 };
    return scaled(c.x - o.x, c.z - o.z, speedCap(o, ESCORT.trail));
  },

  // The receivers' plan off the ball on a pass play: after a catch, on a
  // scramble past the line, or with a pass in the air to somebody else.
  planReceiverSupport() {
    const air = this.phase === 'air';
    const blockers = [];
    for (const id of RECEIVERS) {
      const p = this.byId[id];
      if (id === this.carrier || p.pickup || (air && (this.pass.receiver === id || this.pass.elapsed < SUPPORT.see))) { p.support = null; continue; }
      blockers.push(p);
    }
    const taken = new Set(), pinned = new Set();
    for (const d of this.defense) if (d.engaged && this.byId[d.engaged]?.role === 'ol') taken.add(d.id);
    for (const p of blockers) if (p.stalking && p.support) { pinned.add(p.id); taken.add(p.support.id); }
    return this.planSupport(blockers, taken, (o, d) => o.blockDone === d.id || d.ballNearAt != null, pinned);
  },
};
