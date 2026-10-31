// Blocking: pass protection and the pass rush (the pocket), run blocking,
// and how blocked defenders fight through.
import { STEP, clamp, dist, scaled, seekWant, trackWant, speedCap, STUMBLE_SPEED, GET_OFF } from './common.js';

const SHED_RANGE = 1.6, SHED_TIME = 0.3;  // a blocked man reads the ball carrier

// The launch point: the spot the rush is aimed at and the line protects. Until
// the quarterback sets it is `depth` yd behind the line (deeper if he drops
// deeper). He has set once he slows below `still` yd/s after `settle` s, or at
// `late` s whatever he is doing; the point is then frozen where he is (within
// `wide` yd of the centre, `min` to `max` yd deep). The pocket is built around
// this spot: when the quarterback climbs or slides inside it, nobody on the
// line moves with him.
const LAUNCH = { depth: 7, settle: 0.45, still: 1, late: 1.2, wide: 2, min: 4.5, max: 10 };

// Pass protection (the pocket). Tackles kick-slide back and out, guards and
// the centre set short (`kick` yd out, `depth` yd behind the line), and each
// blocker meets his rusher in the lane: the spot `square` yd from the rusher
// toward the launch point, no more than `reach` yd either side of his set.
// A blocker within `engage` yd of a rusher, and nearer the quarterback than
// he is, locks up with him; a pair more than `part` yd apart comes unlocked.
// Locked, the rusher drives his blocker back along his own lane at the
// matchup's push speed (the pair never slides with the quarterback: the lane
// bends at most `bend` yd toward where the rusher has seen him go) and wins
// at a hazard rate of win × (t / ramp)^power per second, t the time since
// the snap, so pressure builds while the quarterback holds the ball. A spare
// lineman within `helpRange` yd scales it by `help`. A rusher closing on the
// quarterback adds up to `loose` (none at `near` yd, all of it within
// `close`), falling to `onMove` of it as the quarterback runs by (2 to 5
// yd/s): moving the launch point beats the collapse. A rusher who has been
// ridden level with a quarterback who stepped up (`washDepth` yd) and wide of
// him has lost his angle: `wash` of the rate. The winner rips past at `rip`
// yd/s along his lane, slipping to the side he won (the move's `slip`), then
// leans up to `lean` yd that way for `burst` s. Nobody can pick him up
// for `clear` s, and the beaten blocker stumbles for `beaten` s. Ends lined up
// more than `edge` yd wide rush the arc, aiming `arc` yd outside the launch
// point per yard still to go (`arcMin` to `arcMax`) and up to `beyond` yd
// past it: the arc runs past the launch point, and turning the corner takes
// a win; the others push their gap (`gaps`, yd from the centre; lined up
// without a called gap, within `gap` yd of the centre), bending to the launch
// point by its depth. Rushers re-aim at the quarterback once they have seen
// him move off the launch point (`moved` yd, blended over a yard), or when
// within `chase` yd of him. Linemen rush at `effort` of top speed, blitzers
// flat out. The back checks for a free rusher until `pickup` s after the snap
// and blocks him if one comes (unless he has a hot route); once he has
// blocked he stays in. Using him costs `backCost` yd in the protection count,
// so the line goes first. The pocket box is `box` yd either side of the
// launch point.
const POCKET = {
  tackle: { kick: 0.9, depth: 2.0, reach: 2.4 }, guard: { kick: 0.15, depth: 1.2, reach: 2.2 }, centre: { kick: 0, depth: 1.1, reach: 2.4 },
  square: 0.95, engage: 1.3, part: 2.2, ramp: 1.4, power: 2.5, help: 0.5, helpRange: 1.6,
  box: 4.4, close: 1.5, near: 3.5, loose: 3, onMove: 0.25, wash: 0.35, washDepth: 0.5, bend: 0.6,
  beaten: 0.5, clear: 0.5, burst: 0.5, lean: 0.6, rip: 5.5,
  edge: 3.5, arc: 1.0, arcMin: 2.0, arcMax: 4.2, beyond: 0.8, gap: 2.4, gaps: { A: 0.8, B: 2.4, C: 4.2 },
  moved: 1, chase: 3, effort: 0.92, pickup: 1.2, backCost: 2, own: 1.5,
};
// Pass-rush matchups: `push` is how fast the pair gives ground (yd/s), `win`
// the base hazard (per second at `ramp`) and `shed` the base chance to come
// off the block when the quarterback leaves the pocket.
const MATCHUP = {
  edge: { push: 0.75, win: 0.32, shed: 0.85 },    // an end on a tackle: slow to collapse, likelier to win
  inside: { push: 1.1, win: 0.22, shed: 0.6 },    // a tackle on a guard: a steady push
  nose: { push: 1.2, win: 0.2, shed: 0.55 },      // a nose on the centre
  blitzer: { push: 0.6, win: 0.36, shed: 0.8 },   // a linebacker or back on a lineman: quick, light
  back: { push: 1.6, win: 0.8, shed: 0.9 },       // anyone on a back: he gives ground fast
};
// Rush moves, drawn when the rep locks up. `push` and `win` scale the
// matchup; `slip` is how far to the side the winner rips per yard forward
// (square to his lane); `arc` scales an edge rusher's arc and `travel`
// (yd/s) is how fast a locked end runs it, his tackle kick-sliding with
// him, slowing over the last `TURN` yd before the launch point's depth;
// there he has to turn the corner and the matchup's push takes over. A speed rush
// runs the arc and wins outside over the long path; a bull rush drives the
// blocker straight back into the quarterback's lap (the pocket collapses even
// without a win); a counter (spin or swim) wins inside, the short path.
const MOVES = {
  speed: { push: 0.8, win: 1.2, slip: 0.35, arc: 1.2, travel: 4.5, side: 1 },
  bull: { push: 1.7, win: 0.55, slip: 0.1, arc: 0.4, travel: 0, side: 1 },
  counter: { push: 1, win: 1, slip: 0.5, arc: 1, travel: 3.2, side: -1 },
};
const TURN = 1.5;
// Share of each move by lane: [speed, bull]; the rest are counters.
const MOVE_MIX = { edge: [0.5, 0.2], inside: [0.25, 0.45], blitzer: [0.5, 0.1] };
// The quarterback leaves the pocket. A rusher sees it `recognise` s (by
// difficulty, below) after his ordinary reaction latency, plus up to
// `spread` s of his own; he reads the quarterback's run `anticipate` s ahead.
// A locked rusher must then come off his block (the contain man as soon as
// he sees the quarterback roll his way, below): an attempt lasting `min` to
// `max` s (cut short if the quarterback runs within `close` yd of him) while
// he fights across toward the quarterback at `fight` yd/s (the contain man
// runs outside toward his contain spot at `widen` of his top speed). It
// works at the matchup's shed chance, times the difficulty's `shed`, falling
// to `square` of it when his blocker is square between him and the
// quarterback. A failed attempt can be tried again after `retry` s; a good
// one sends him off at `burst` yd/s and leaves the blocker `recover` s to
// turn; the man he got off cannot take him again for `relock` s, and on a
// scramble nobody locks up with a rusher unless he is in that rusher's path
// to the quarterback (within about `path` of straight ahead, as a cosine).
// A blocker is square when he is within about 50° of the line from the
// rusher to the quarterback (`squareFrom`, a cosine). The end on the side
// the quarterback rolls to keeps contain: he aims `width` yd plus the
// difficulty's contain outside the point where he can meet the quarterback's
// path (`lead` s ahead at least, `leadMax` at most), holding his depth
// `front` to `hold` yd in front of it until he is outside him, then
// squeezing to `front`; once he is outside him, level or in
// front (give or take `close` yd), within `attack` yd, he takes him on. A
// free contain man does this as soon as he sees the quarterback run toward
// his side at `roll` yd/s, before he is out. Inside rushers chase with
// `inside` yd of inside-out leverage. Linemen keep riding the man they have;
// one with nobody drifts toward the quarterback at `drift` of top speed, no
// more than `roam` yd from his set, and only takes a rusher within `reach`
// yd.
const SCRAMBLE = {
  spread: 0.1, anticipate: 0.35, min: 0.3, max: 0.6, fight: 1.4, widen: 0.8, square: 0.35, squareFrom: 0.64, retry: 0.2, burst: 4.5, recover: 0.25,
  relock: 1, path: 0.5, width: 0.5, lead: 0.4, leadMax: 1, front: 1, hold: 3, close: 1.2, attack: 2.5, roll: 3, inside: 0.8, drift: 0.4, roam: 2.5, reach: 2.5,
};
// Discipline by difficulty (never speed): `recognise` (s, see SCRAMBLE),
// `shed` (scales the chance to get off a block), `stunt` (chance of an
// end-tackle twist on a rep), `pa` (s a lineman plays the run on a
// play-action fake).
const DISCIPLINE = {
  rookie: { recognise: 0.2, shed: 0.75, stunt: 0.08, pa: 0.9 },
  pro: { recognise: 0.12, shed: 1, stunt: 0.15, pa: 0.75 },
  allpro: { recognise: 0.06, shed: 1.15, stunt: 0.22, pa: 0.6 },
};
// Play action: until he reads pass a defensive lineman fits his gap `fit` yd
// on his side of the line at `effort` of top speed, and once blocked holds
// his ground (leaning in at `push` yd/s) instead of rushing; his pressure
// clock starts when he reads pass. A called blitzer comes anyway.
const PLAY_ACTION = { fit: 0.3, effort: 0.5, push: 0.3 };
// Some reps the rush gets home sooner than others: every rusher's strength
// is 2^(-`weak` to +`strong`) for the whole rep times 2^(±`lock`) for his
// matchup (uniform in the exponent, from draws the rep makes anyway); see
// rushStrength.
const SPREAD = { weak: 1.6, strong: 1, lock: 0.6 };
// Twists. An end and the tackle beside him trade lanes: in a T-E game the
// tackle goes first, slanting across the guard's face into the C gap, and
// the end loops behind him into the B gap; in an E-T game the end crashes
// inside and the tackle loops around to the edge. The penetrator slants to
// his new gap `depth` yd past the line (a blocker on him rides him across at
// `slant` yd/s); the looper steps flat along the line (`behind` yd on his
// side of it) until he is within `near` yd of his new gap, or `loop` s, then
// rushes it. The line passes the stunt off (`pickup`: the share of reps it
// sees it): when the penetrator crosses into the next man's zone, that man
// takes him if he is free and within `reach` yd more than the lock range,
// and the first blocker is free for the looper.
const STUNT = { depth: 1.2, slant: 2.5, behind: 0.7, near: 0.8, loop: 1.1, pickup: 0.75, reach: 0.5 };

export const protection = {
  // While the quarterback holds a called pass, the line protects the pocket
  // (see protect). Otherwise (run plays, and after a catch or a scramble over
  // the line) each lineman takes a defender (see assignBlocks) and the pair
  // locks up until the defender's shed time; locked defenders drive toward
  // the ball slowly.
  planBlocking(dt = STEP) {
    const run = this.play.type === 'run', guard = this.guardPoint();
    this.byId.R.pickup = null;
    if (!run) this.trackLaunch();
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

  // The quarterback has left the pocket sideways: more than `box` yd from the
  // launch point.
  scrambling() { return this.carrier === 'QB' && Math.abs(this.byId.QB.x - this.rushState().launch.x) > POCKET.box; },

  // This rep's pass-rush state, made fresh for every new set of players:
  // the launch point, whether the quarterback has set, the twist (if any) and
  // the contain men on each side.
  rushState() {
    let st = this.passRush;
    if (!st || st.players !== this.players) {
      st = this.passRush = {
        players: this.players, launch: { x: this.pocketX(), z: this.spot - LAUNCH.depth }, set: false,
        decided: false, stunt: null, strength: 1, containL: null, containR: null,
      };
    }
    return st;
  },

  discipline() { return DISCIPLINE[this.config.difficulty] || DISCIPLINE.pro; },

  // How well this rusher's rep is going (SPREAD): the rep's strength times
  // his move's. It scales his win rate, and its square root his push and
  // how fast he runs the arc.
  rushStrength(d) { return (this.rushState().strength || 1) * (d.rushEdge || 1); },

  // On play action a defensive lineman plays the run until he reads pass,
  // the difficulty's `pa` s after the snap (0 on any other play, or for a
  // called blitzer).
  readsPassAt(d) { return this.play.type === 'pa' && d.role === 'dl' && d.rush?.lane !== 'blitz' ? this.discipline().pa : 0; },
  readsRun(d) { return this.time < this.readsPassAt(d); },

  // The launch point follows the drop until the quarterback sets, then stays.
  // The first live step also decides the twist.
  trackLaunch() {
    const st = this.rushState(), qb = this.byId.QB, L = st.launch;
    if (!st.decided && this.phase !== 'presnap') {
      // One draw for the rep: the twist, and (from an unrelated digit of the
      // same draw) how well this rush goes against this protection.
      const roll = this.random();
      st.decided = true; st.stunt = this.planStunt(roll);
      st.strength = 2 ** (SPREAD.strong - (SPREAD.weak + SPREAD.strong) * (roll * 9973 % 1));
    }
    if (st.set || this.phase === 'presnap') return;
    L.z = Math.min(this.spot - LAUNCH.depth, qb.z);
    const still = this.time > LAUNCH.settle && Math.hypot(qb.vx, qb.vz) < LAUNCH.still;
    if (!still && this.time < LAUNCH.late && this.carrier === 'QB') return;
    const x0 = this.pocketX();
    st.set = true;
    L.x = clamp(qb.x, x0 - LAUNCH.wide, x0 + LAUNCH.wide);
    L.z = clamp(qb.z, this.spot - LAUNCH.max, this.spot - LAUNCH.min);
  },

  // A twist between an end and the tackle beside him, on a seeded share of
  // pass reps: `roll` is the rep's draw (one on every pass rep, so the
  // stream does not depend on the front), whose remainder also picks the
  // side, the game and whether the line sees it. `config.stunt` can force
  // one ({ kind: 'TE' | 'ET', side: -1 | 1, picked }) or rule it out
  // ('none').
  planStunt(roll) {
    const chance = this.discipline().stunt, forced = this.config.stunt;
    if (forced === 'none' || (!forced && roll >= chance)) return null;
    const u = forced ? roll : roll / chance, x0 = this.pocketX();  // uniform again, given a twist
    const side = forced?.side || (u < 0.5 ? -1 : 1), kind = forced?.kind || (u * 2 % 1 < 0.5 ? 'TE' : 'ET');
    const dl = this.defense.filter(d => d.rushing && d.role === 'dl' && !(d.rush?.at > 0) && Math.sign(d.start.x - x0) === side);
    if (dl.length < 2) return null;
    dl.sort((a, b) => side * (a.start.x - b.start.x));
    const tackle = dl[0], end = dl[dl.length - 1];
    if (side * (end.start.x - x0) < POCKET.edge - 0.8) return null;
    const te = kind === 'TE';
    return {
      kind, side, pen: te ? tackle.id : end.id, loop: te ? end.id : tackle.id,
      penX: x0 + side * (te ? POCKET.gaps.C : Math.abs(tackle.start.x - x0)), loopX: x0 + side * (te ? POCKET.gaps.B : POCKET.gaps.C),
      picked: forced?.picked ?? u * 4 % 1 < STUNT.pickup, passed: false,
    };
  },

  // A rusher's lane: his side, whether he rushes the arc (`edge`), his gap's
  // x at the line, and whether he is a blitzer (flat out). From the called
  // rush (`d.rush`: lane, side and gap in the play's own frame, so mirrored
  // with a flipped play) or, without one, from where he lined up. A twist
  // gives its two men each other's lanes.
  laneOf(d) {
    const x0 = this.pocketX(), off = d.start.x - x0, r = d.rush, st = this.passRush;
    const blitzer = d.role !== 'dl' || r?.lane === 'blitz';
    const side = r?.side ? r.side * (this.config.flip ? -1 : 1) : Math.sign(off) || 1;
    const stunt = st && st.players === this.players ? st.stunt : null;
    if (stunt && d.id === stunt.pen) return { side: stunt.side, edge: false, x: stunt.penX, blitzer };
    if (stunt && d.id === stunt.loop) return { side: stunt.side, edge: stunt.kind === 'ET', x: stunt.loopX, blitzer };
    if (r?.gap) return { side, edge: r.lane === 'edge' || (r.gap === 'C' && r.lane !== 'inside'), x: x0 + side * (POCKET.gaps[r.gap] ?? POCKET.gap), blitzer };
    const edge = r?.lane ? r.lane === 'edge' || (r.lane === 'blitz' && Math.abs(off) > POCKET.edge) : Math.abs(off) > POCKET.edge;
    return { side, edge, x: x0 + clamp(off, -POCKET.gap, POCKET.gap), blitzer };
  },

  matchup(o, d) {
    if (o.role === 'rb') return MATCHUP.back;
    if (d.role !== 'dl') return MATCHUP.blitzer;
    if (this.laneOf(d).edge) return MATCHUP.edge;
    return o.id === 'C' ? MATCHUP.nose : MATCHUP.inside;
  },

  // Where a lineman sets: tackles kick back and out, guards and centre short.
  setPoint(o) {
    const off = o.start.x - this.pocketX(), a = Math.abs(off);
    const set = a > 2.4 ? POCKET.tackle : a > 0.8 ? POCKET.guard : POCKET.centre;
    return { x: o.start.x + Math.sign(off) * set.kick, z: this.spot - set.depth, reach: set.reach };
  },

  // What the protection is built around: the launch point while the
  // quarterback is in the pocket, the quarterback himself once he leaves it.
  pocketRef() { return this.scrambling() ? this.byId.QB : this.rushState().launch; },

  // The spot between a rusher and `ref` where a blocker squares up.
  squarePoint(d, extra = 0, ref = this.pocketRef()) {
    const away = scaled(ref.x - d.x, ref.z - d.z, POCKET.square + extra);
    return { x: d.x + away.x, z: d.z + away.z };
  },

  // How long a rusher takes to see the quarterback go somewhere new: his
  // reaction latency, the difficulty's recognition time and a little of his
  // own (fixed by his number, no draw). The trail holds 0.6 s.
  recognition(d) {
    const own = (d.number * 0.618034) % 1;
    return Math.min(0.55, (this.skill.latency ?? 0.28) + this.discipline().recognise + SCRAMBLE.spread * own);
  },

  // The quarterback as this rusher has recognised him, and as he sees him
  // with his ordinary reaction latency (both cached per step).
  seenQB(d) {
    if (d.qbSeen && d.qbSeen.t === this.time) return d.qbSeen.p;
    const p = this.perceive('QB', this.recognition(d));
    d.qbSeen = { t: this.time, p };
    return p;
  },
  watchQB(d) {
    if (d.qbWatch && d.qbWatch.t === this.time) return d.qbWatch.p;
    const p = this.perceive('QB', d.latency);
    d.qbWatch = { t: this.time, p };
    return p;
  },

  // This rusher has seen the quarterback leave the pocket.
  sawOut(d) {
    if (this.carrier !== 'QB') return false;
    const seen = this.seenQB(d), x = seen.x + seen.vx * SCRAMBLE.anticipate;
    return Math.abs(x - this.rushState().launch.x) > POCKET.box;
  },

  // What a free rusher aims through his lane at: the launch point, or the
  // quarterback once the rusher has seen him move off it (blended over a
  // yard so the aim does not jump).
  freeRef(d) {
    const st = this.rushState(), L = st.launch;
    if (!st.set) return L;
    const seen = this.seenQB(d), gap = Math.hypot(seen.x - L.x, seen.z - L.z);
    const k = clamp(gap - POCKET.moved * 0.5, 0, POCKET.moved) / POCKET.moved;
    return { x: L.x + (seen.x - L.x) * k, z: L.z + (seen.z - L.z) * k };
  },

  // What a locked rusher drives his blocker toward: the launch point, bent
  // at most `bend` yd toward where he has seen the quarterback go (the block
  // anchors both men); once he has seen him leave the pocket, the
  // quarterback.
  lockRef(d) {
    if (this.sawOut(d)) return this.seenQB(d);
    const L = this.rushState().launch, ref = this.freeRef(d);
    const off = scaled(ref.x - L.x, ref.z - L.z, Math.min(POCKET.bend, Math.hypot(ref.x - L.x, ref.z - L.z)));
    return { x: L.x + off.x, z: L.z + off.z };
  },

  // The point a rusher aims at in his lane toward `ref`: an end runs the arc
  // outside and past it, bending in as he reaches its depth; an inside man
  // pushes his gap, bending toward it as he gets deeper.
  laneAim(d, ref, lane = this.laneOf(d)) {
    const depth = Math.max(0, d.z - ref.z), move = MOVES[d.rushMove] || MOVES.counter;
    if (lane.edge) {
      const w = clamp(POCKET.arc * depth, POCKET.arcMin, POCKET.arcMax) * move.arc;
      return { x: ref.x + lane.side * w, z: ref.z - POCKET.beyond * Math.min(1, w / POCKET.arcMax) };
    }
    const k = clamp(depth / 8, 0, 1);
    return { x: ref.x + (lane.x - ref.x) * k, z: ref.z };
  },

  // Where a twist's man is going before he rushes his new lane: the
  // penetrator's slant point, the looper's loop point, or null once there.
  twistAim(d, lane) {
    const st = this.passRush, sk = st && st.players === this.players ? st.stunt : null;
    if (!sk || this.time > STUNT.loop || Math.abs(d.x - lane.x) < STUNT.near) return null;
    if (d.id === sk.pen) return { x: lane.x, z: this.spot - STUNT.depth };
    if (d.id === sk.loop) return { x: lane.x, z: this.spot + STUNT.behind };
    return null;
  },

  // The widest edge rusher on each side keeps contain on a scramble that way.
  markContain(st, rushers) {
    let left = null, right = null;
    for (const d of rushers) {
      const lane = this.laneOf(d);
      if (!lane.edge) continue;
      if (lane.side > 0 && (!right || d.start.x > right.start.x)) right = d;
      if (lane.side < 0 && (!left || d.start.x < left.start.x)) left = d;
    }
    st.containL = left ? left.id : null; st.containR = right ? right.id : null;
  },

  unlock(o, d) {
    if (o) { o.lock = null; o.assignment = null; }
    if (d) { d.lock = null; d.disengage = null; }
  },

  // Pass protection. A man who stops rushing is let go at once. Pairs
  // already locked fight it out (contest); a twist is passed off; then the
  // free blockers (linemen who are neither locked nor beaten, and the back
  // while he checks or once he has blocked) are matched to the free rushers
  // (assignProtection) and lock up with them on contact. A spare blocker
  // picks up any free rusher who comes within reach.
  protect(dt) {
    const st = this.rushState(), rushers = this.rushers(), rb = this.byId.R;
    if (st.stunt && !(this.byId[st.stunt.pen].rushing && this.byId[st.stunt.loop].rushing)) st.stunt = null;
    for (const o of this.line) this.keepLock(o);
    this.keepLock(rb);
    this.markContain(st, rushers);
    for (const d of rushers) if (d.lock) this.contest(this.byId[d.lock], d, dt);
    this.passOff(st);
    const catching = this.phase === 'air' && this.pass.receiver === 'R';
    if (catching && rb.lock) this.unlock(rb, this.byId[rb.lock]);
    // A back with a hot route runs it; one lined up in the backfield checks.
    const back = !this.hotRoutes.R && rb.start.z < this.spot - 3 && this.carrier !== 'R' && !catching && !rb.released;
    const blockers = this.line.filter(o => !o.lock && this.time >= o.beatenUntil);
    if (back && !rb.lock && this.time >= rb.beatenUntil) blockers.push(rb);
    const free = rushers.filter(d => !d.lock);
    const plan = this.assignProtection(blockers, free);
    for (const o of this.line) if (!blockers.includes(o)) o.assignment = o.lock;
    if (!blockers.includes(rb)) rb.assignment = rb.lock;
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

  // A blocker lets go of a man who has stopped rushing (he drops into
  // coverage) and forgets an assignment who has.
  keepLock(o) {
    const d = o.lock ? this.byId[o.lock] : null;
    if (d && (!d.rushing || d.lock !== o.id)) this.unlock(o, d.lock === o.id ? d : null);
    else if (!d && o.assignment && !this.byId[o.assignment]?.rushing) o.assignment = null;
  },

  // A twist crossing the line: the blocker on the penetrator hands him to
  // the next man once he has crossed into that man's zone, if the line saw
  // it and the next man is free and close; he is then free for the looper.
  passOff(st) {
    const sk = st.stunt;
    if (!sk || !sk.picked || sk.passed) return;
    const d = this.byId[sk.pen], o = d.lock ? this.byId[d.lock] : null;
    if (!o || o.role !== 'ol') return;
    const mine = this.setPoint(o).x, gone = Math.abs(mine - d.x);
    const next = this.line.find(n => n !== o && !n.lock && this.time >= n.beatenUntil && sk.side * (this.setPoint(n).x - mine) > 0
      && Math.abs(this.setPoint(n).x - d.x) < gone && dist(n, d) < POCKET.engage + STUNT.reach);
    if (!next) return;
    this.unlock(o, d);
    this.lock(next, d);
    sk.passed = true;
    this.events.push('pass-off');
  },

  // One blocker's step in protection. Locked, stay square between the
  // rusher and the launch point and move with him, giving ground as he
  // pushes; when the quarterback leaves the pocket a lineman keeps riding his
  // man on that line (he does not re-square on the quarterback, so a man the
  // quarterback has run past can get off him). Assigned, meet the rusher in
  // his lane from the set point; spare, sit behind the nearest block ready to
  // help, or, on a scramble, drift toward the quarterback without running
  // across the formation; beaten, recover. The back has no set point: he
  // works from a spot just in front of the quarterback and mirrors him.
  passSet(o, rushers) {
    o.sprinting = false;
    const back = o.role === 'rb', qb = this.byId.QB, scramble = this.scrambling(), launch = this.rushState().launch;
    const ref = back || scramble ? qb : launch;
    const set = back ? { x: qb.x + qb.vx * 0.25, z: qb.z + 1.2 + qb.vz * 0.25, reach: 2 } : this.setPoint(o);
    if (o.lock) {
      const d = this.byId[o.lock];
      this.engage(o, d);
      o.want = trackWant(o, this.squarePoint(d, 0, back ? qb : launch), { x: d.vx, z: d.vz }, speedCap(o, 0.7));
      return;
    }
    const d = o.assignment ? this.byId[o.assignment] : null;
    if (d) {
      const lane = this.squarePoint(d, 0, ref);
      const target = back ? { x: lane.x, z: Math.min(lane.z, this.spot - 1) }
        : { x: clamp(lane.x, set.x - set.reach, set.x + set.reach), z: Math.min(set.z, lane.z) };
      o.want = seekWant(o, target, speedCap(o, back ? 0.85 : 0.6));
      return;
    }
    if (scramble && !back) {
      const target = { x: clamp(qb.x, set.x - SCRAMBLE.roam, set.x + SCRAMBLE.roam), z: Math.max(qb.z + 1.5, set.z - 1) };
      o.want = seekWant(o, target, speedCap(o, SCRAMBLE.drift));
      return;
    }
    if (this.time < o.beatenUntil) { o.want = seekWant(o, { x: set.x, z: set.z - 0.6 }, speedCap(o, 0.7)); return; }
    let near = null;
    for (const q of rushers) if (!near || dist(q, set) < dist(near, set)) near = q;
    const behind = near && dist(near, set) < 4 ? this.squarePoint(near, 1, ref) : set;
    o.want = seekWant(o, { x: clamp(behind.x, set.x - set.reach, set.x + set.reach), z: Math.min(set.z, behind.z) }, speedCap(o, back ? 0.85 : 0.6));
  },

  // A blocker can only take on a rusher he is in front of (nearer the
  // quarterback): a beaten man must get back between them first. A rusher
  // who has just shed his man is not his again at once, and on a scramble a
  // blocker must be in the rusher's path to the quarterback.
  canLock(o, d) {
    const qb = this.byId.QB, since = this.time - d.wonAt;
    if (dist(o, d) >= POCKET.engage || since < POCKET.clear || dist(o, qb) >= dist(d, qb)) return false;
    if (d.shedFrom === o.id && since < SCRAMBLE.relock) return false;
    if (!this.scrambling()) return true;
    const toO = scaled(o.x - d.x, o.z - d.z, 1), toQB = scaled(qb.x - d.x, qb.z - d.z, 1);
    return toO.x * toQB.x + toO.z * toQB.z > SCRAMBLE.path;
  },

  // Blocker and rusher lock up. The rusher draws how much pressure it takes
  // him to win this rep (an exponential threshold, so wins are spread in time
  // and fixed by the seed) and his move, which sets the side he wins on and
  // how well it is working (`rushEdge`, SPREAD.lock).
  lock(o, d) {
    o.lock = d.id; d.lock = o.id; o.assignment = d.id;
    if (o.role === 'rb') o.blocked = true;
    const lane = this.laneOf(d), mix = lane.edge ? MOVE_MIX.edge : d.role !== 'dl' ? MOVE_MIX.blitzer : MOVE_MIX.inside;
    d.need = -Math.log(1 - this.random()); d.have = 0;
    const r = this.random();
    d.rushMove = r < mix[0] ? 'speed' : r < mix[0] + mix[1] ? 'bull' : 'counter';
    // Where the draw fell inside the move's share: how good the move is.
    const u = d.rushMove === 'speed' ? r / mix[0] : d.rushMove === 'bull' ? (r - mix[0]) / mix[1] : (r - mix[0] - mix[1]) / (1 - mix[0] - mix[1]);
    d.rushEdge = 2 ** (SPREAD.lock * (2 * u - 1));
    d.winSide = lane.side * MOVES[d.rushMove].side;
    d.disengage = null;
    d.vx *= 0.8; d.vz *= 0.8;
  },

  // A locked rep. Pressure builds with the time since the snap (since the
  // rusher read pass, on play action; nothing while he reads run), scaled by
  // the rep's and the move's strength (SPREAD); a spare lineman beside the
  // block slows it, a rusher washed past a quarterback who stepped up has
  // lost his angle, and a rusher closing on the quarterback (less so on one
  // on the move) speeds it. The winner beats his blocker, who stumbles and
  // cannot block for a moment. Once the rusher has seen the quarterback leave
  // the pocket he works to get off the block instead (shedding).
  contest(o, d, dt) {
    if (!o || o.lock !== d.id || dist(o, d) > POCKET.part) { this.unlock(o && o.lock === d.id ? o : null, d); return; }
    if (this.shedding(o, d) || this.readsRun(d)) return;
    const qb = this.byId.QB, m = this.matchup(o, d), move = MOVES[d.rushMove] || MOVES.counter;
    const clock = Math.max(0, this.time - this.readsPassAt(d));
    let rate = m.win * move.win * (clock / POCKET.ramp) ** POCKET.power;
    if (this.line.some(h => h !== o && !h.lock && !h.assignment && this.time >= h.beatenUntil && dist(h, d) < POCKET.helpRange)) rate *= POCKET.help;
    const closing = clamp((POCKET.near - dist(d, qb)) / (POCKET.near - POCKET.close), 0, 1);
    if (closing > 0) {
      const moving = clamp((Math.hypot(qb.vx, qb.vz) - 2) / 3, 0, 1);
      rate += POCKET.loose * closing * (1 - (1 - POCKET.onMove) * moving);
    }
    if (d.z < qb.z + POCKET.washDepth && Math.abs(d.x - qb.x) > 1.2) rate *= POCKET.wash;
    d.have += rate * this.rushStrength(d) * dt;
    if (d.have < d.need) return;
    this.unlock(o, d);
    o.beatenUntil = this.time + POCKET.beaten; o.action = 'stumble'; o.actionTime = POCKET.beaten; o.lostTo = d.id;
    o.vx *= STUMBLE_SPEED; o.vz *= STUMBLE_SPEED;
    // The rip, swim or drive: over a quarter second (the juke blend) the
    // rusher goes from his push to `rip` yd/s along his lane and to the side
    // he won (a bull rusher straight through). With a quarterback who has
    // stepped up, an edge rusher's lane takes him behind him: a loop.
    const ref = this.freeRef(d), aim = d.rushMove === 'bull' ? ref : this.laneAim(d, ref);
    const to = scaled(aim.x - d.x, aim.z - d.z, 1), turn = -Math.sign(to.z) * d.winSide || d.winSide;
    const past = scaled(to.x - turn * to.z * move.slip, to.z + turn * to.x * move.slip, POCKET.rip);
    d.juke = { t: 0, from: { x: d.vx, z: d.vz }, to: past };
    d.wonAt = this.time;
    this.events.push('block-win');
  },

  // Coming off a block when the quarterback leaves the pocket: a rusher who
  // has seen it starts an attempt (SCRAMBLE: duration and success drawn now),
  // fights across toward the quarterback while it lasts, and at its end is
  // either off (a burst toward the quarterback, or the contain man's spot;
  // the blocker needs a moment to turn) or still held, and may try again.
  // True while the rep is about the shed, not the rush.
  shedding(o, d) {
    if (!d.disengage) {
      if (this.time < (d.retryAt || 0) || !(this.sawOut(d) || this.containAim(d, true))) return false;
      const time = SCRAMBLE.min + (SCRAMBLE.max - SCRAMBLE.min) * this.random();
      d.disengage = { end: this.time + time, ok: this.random() < this.shedChance(o, d) };
    }
    if (this.time < d.disengage.end && dist(d, this.byId.QB) > SCRAMBLE.close) return true;
    const ok = d.disengage.ok;
    d.disengage = null;
    if (!ok) { d.retryAt = this.time + SCRAMBLE.retry; return true; }
    this.unlock(o, d);
    o.beatenUntil = this.time + SCRAMBLE.recover;
    const contain = this.containAim(d, true) || (this.sawOut(d) && this.containAim(d));
    const to = contain && contain !== 'attack' ? contain : this.byId.QB;
    d.wonAt = this.time; d.winSide = Math.sign(to.x - d.x) || 1; d.shedFrom = o.id;
    d.juke = { t: 0, from: { x: d.vx, z: d.vz }, to: scaled(to.x - d.x, to.z - d.z, SCRAMBLE.burst) };
    this.events.push('shed');
    return true;
  },

  // The chance a shed works: the matchup's, scaled by discipline, and lower
  // the squarer the blocker is between the rusher and the quarterback (one
  // already turned, or run past, loses him).
  shedChance(o, d) {
    const qb = this.byId.QB, toQB = scaled(qb.x - d.x, qb.z - d.z, 1), toO = scaled(o.x - d.x, o.z - d.z, 1);
    const square = clamp((toQB.x * toO.x + toQB.z * toO.z - SCRAMBLE.squareFrom) / (1 - SCRAMBLE.squareFrom), 0, 1);
    return clamp(this.matchup(o, d).shed * this.discipline().shed * (1 - (1 - SCRAMBLE.square) * square), 0.05, 0.97);
  },

  // Protection: block the most dangerous rushers, those who would reach the
  // quarterback first, so the one left free is the farthest; among those
  // choices take the shortest trips (so the line slides toward an overload),
  // keep last step's man, give a recovered blocker the man who beat him
  // (`own` yd, so the spare stays free to help), and use the back only when
  // the line runs out. On a scramble a lineman only takes a man within
  // reach: nobody runs across the formation. Exact search over every
  // matching (at most six blockers and seven rushers).
  assignProtection(blockers, rushers) {
    const qb = this.byId.QB, n = blockers.length, k = rushers.length, full = 1 << k, scramble = this.scrambling();
    const plan = new Map();
    if (!n || !k) return plan;
    const cost = blockers.map(o => rushers.map(d => scramble && o.role === 'ol' && dist(o, d) > SCRAMBLE.reach ? Infinity
      : dist(o, this.squarePoint(d)) - (o.assignment === d.id ? 1 : 0) - (o.lostTo === d.id ? POCKET.own : 0) + (o.role === 'rb' ? POCKET.backCost : 0)));
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

  // A blocked defender keeps driving toward the ball. In pass protection the
  // rusher drives his blocker back along his own lane toward the launch
  // point at the matchup's push speed, whatever the quarterback does (see
  // lockRef); the contain man who sees the quarterback roll his way runs
  // outside toward his contain spot instead (at `widen` of his top speed:
  // his blocker is on his inside and cannot stop that, and if he cannot
  // keep up the pair parts); while shedding a rusher fights across toward
  // the quarterback; on play action, while he reads run, he holds his
  // ground. Elsewhere he leans toward the ball at a walking pace.
  drivePast(d) {
    d.sprinting = false;
    if (d.lock) {
      const o = this.byId[d.lock];
      const contain = this.containAim(d, true) || (this.sawOut(d) && this.containAim(d));
      if (contain && contain !== 'attack') { d.want = scaled(contain.x - d.x, contain.z - d.z, speedCap(d, SCRAMBLE.widen)); return; }
      if (d.disengage) {
        const seen = this.seenQB(d);
        d.want = scaled(seen.x - d.x, seen.z - d.z, SCRAMBLE.fight);
        return;
      }
      if (this.readsRun(d)) { d.want = scaled(0, -1, PLAY_ACTION.push); return; }
      const twist = this.twistAim(d, this.laneOf(d));
      if (twist) { d.want = seekWant(d, twist, STUNT.slant); return; }
      const move = MOVES[d.rushMove] || MOVES.counter, k = Math.sqrt(this.rushStrength(d)), push = this.matchup(o, d).push * move.push * k;
      const ref = this.lockRef(d), aim = d.rushMove === 'bull' ? ref : this.laneAim(d, ref);
      const travel = this.laneOf(d).edge ? clamp((d.z - ref.z) / TURN, 0, 1) : 0;
      const speed = push + Math.max(0, move.travel * k - push) * travel;
      d.want = scaled(aim.x - d.x, aim.z - d.z, Math.min(speed, 2 * Math.hypot(aim.x - d.x, aim.z - d.z)));
      return;
    }
    const goal = this.guardPoint(), run = this.play.type === 'run' || this.phase === 'run';
    d.want = scaled(goal.x - d.x, goal.z - d.z, run ? 0.3 : 0.6);
  },

  // A free rusher's step. Just past his blocker he leans to the side he won;
  // once free (won, shed, or within `chase` yd) he chases the quarterback.
  // Otherwise he runs his lane toward the launch point (an edge rusher the
  // arc), re-aiming only when he has seen the quarterback move; a twist's
  // looper first jab-steps across behind the penetrator. Once he has seen
  // the quarterback leave the pocket, see scrambleWant. Linemen rush at
  // `effort`, blitzers and everyone on a scramble flat out. On play action
  // a lineman first plays the run (PLAY_ACTION).
  rushWant(d) {
    d.turned = true;
    const st = this.rushState(), lane = this.laneOf(d), qb = this.byId.QB;
    if (this.sawOut(d)) return this.scrambleWant(d, lane);
    const contain = this.containAim(d, true);
    if (contain === 'attack') return this.pursue(d, 'QB', speedCap(d, 1));
    if (contain) { d.aim = contain; return scaled(contain.x - d.x, contain.z - d.z, speedCap(d, 1)); }
    const cap = speedCap(d, lane.blitzer ? 1 : POCKET.effort), since = this.time - d.wonAt;
    if (since < POCKET.burst) return this.pursue(d, 'QB', cap, d.winSide * POCKET.lean * (1 - since / POCKET.burst));
    if (d.wonAt > 0 || dist(d, qb) < POCKET.chase) return this.pursue(d, 'QB', speedCap(d, 1));
    if (this.readsRun(d)) return seekWant(d, { x: lane.x, z: this.spot + PLAY_ACTION.fit }, speedCap(d, PLAY_ACTION.effort));
    const twist = this.twistAim(d, lane);
    if (twist) return seekWant(d, twist, speedCap(d, 0.9), 2);
    const aim = this.laneAim(d, this.freeRef(d), lane);
    d.aim = aim;
    return scaled(aim.x - d.x, aim.z - d.z, cap);
  },

  // A rusher who has seen the quarterback leave the pocket. The end on the
  // side he rolls to keeps contain: outside and in front of his path, never
  // inside him, closing only once outside him (wider with discipline). The
  // others chase: the backside from behind, inside men with inside-out
  // leverage so they do not overrun him.
  scrambleWant(d, lane) {
    const st = this.rushState(), roll = Math.sign(this.seenQB(d).x - st.launch.x) || 1, cap = speedCap(d, 1);
    const contain = this.containAim(d);
    if (contain === 'attack') return this.pursue(d, 'QB', cap);
    if (contain) { d.aim = contain; return scaled(contain.x - d.x, contain.z - d.z, cap); }
    return this.pursue(d, 'QB', cap, lane.edge ? 0 : -roll * SCRAMBLE.inside);
  },

  // The contain man's aim on a scramble to his side (null for anyone else,
  // and, with `rolling`, unless he has seen the quarterback run his way at
  // `roll` yd/s or more, which he reads with his ordinary reaction latency:
  // it is his key): outside the point where he can meet the
  // quarterback's path, holding his depth `front` to `hold` yd in front of
  // it (he does not retreat after him) until he is outside him, then
  // squeezing to `front` yd; once he is within `attack` yd,
  // outside him and level or in front, or squarely in front of him (`close`
  // yd upfield), he takes him on ('attack').
  containAim(d, rolling = false) {
    const st = this.rushState(), now = this.watchQB(d);
    if (rolling && (this.carrier !== 'QB' || Math.abs(now.vx) < SCRAMBLE.roll)) return null;
    const roll = rolling ? Math.sign(now.vx) : Math.sign(this.seenQB(d).x - st.launch.x) || 1;
    if ((roll > 0 ? st.containR : st.containL) !== d.id) return null;
    const outside = roll * (d.x - now.x) > 0 && d.z > now.z - SCRAMBLE.close;
    if ((outside || d.z > now.z + SCRAMBLE.close) && dist(d, now) < SCRAMBLE.attack) return 'attack';
    const lead = clamp(dist(d, now) / speedCap(d, 1), SCRAMBLE.lead, SCRAMBLE.leadMax);
    const px = now.x + now.vx * lead, pz = now.z + now.vz * lead, ahead = roll * (d.x - now.x) > 0 ? SCRAMBLE.front : clamp(d.z - pz, SCRAMBLE.front, SCRAMBLE.hold);
    return { x: px + roll * ((this.skill.contain ?? 1) + SCRAMBLE.width), z: pz + ahead };
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
};
