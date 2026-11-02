// Blocking: pass protection and the pass rush (the pocket), run blocking,
// and how blocked defenders fight through.
import { RECEIVERS } from '../plays.js';
import { STEP, clamp, dist, scaled, seekWant, trackWant, speedCap, STUMBLE_SPEED, GET_OFF } from './common.js';

const SHED_RANGE = 1.6, SHED_TIME = 0.3;  // a blocked man reads the ball carrier

// The launch point: the spot the rush is aimed at and the line protects. Until
// the quarterback sets it is his drop's depth behind the line (`depth` yd
// without a planned drop; deeper if he drops deeper). He has set once he
// slows below `still` yd/s after `settle` s, or at `late` s whatever he is
// doing (on play action, `late` s after the fake); the point is then frozen
// where he is (within `wide` yd of the centre, `min` to `max` yd deep). A
// quarterback running his drop by himself has not set while he rides a fake
// or is more than `short` yd short of his depth. The pocket is built around
// this spot: when the quarterback climbs or slides inside it, nobody on the
// line moves with him.
const LAUNCH = { depth: 7, settle: 0.45, still: 1, late: 1.2, wide: 2, min: 4.5, max: 10, short: 1 };

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
// yd/s, slipping to the side he won (the move's `slip`): he bends at the
// quarterback, or with less discipline (DISCIPLINE `bend`) carries on up his
// lane and runs past him; then he leans up to `lean` yd that way for `burst`
// s, flat out. Nobody can pick him up for `clear` s, and the beaten blocker
// stumbles for `beaten` s. A rusher nobody has (no blocker assigned to him)
// takes the straight lane to the launch point, skirting the blocks in his
// way by `skirt` yd (straightLane). Ends lined up more than `edge` yd wide
// rush the arc, aiming `arc` yd outside the launch point per yard still to
// go (`arcMin` to `arcMax`) and up to `beyond` yd past it: the arc runs past
// the launch point, and turning the corner takes a win; the others push
// their gap (`gaps`, yd from the centre; lined up without a called gap,
// within `gap` yd of the centre), bending to the launch point by its depth.
// Rushers re-aim at the quarterback once they have seen him move off the
// launch point (`moved` yd, blended over a yard), or when within `chase` yd
// of him. Linemen rush at `effort` of top speed, blitzers
// flat out. The back checks for a free rusher until `pickup` s after the snap
// and blocks him if one comes (unless he has a hot route); once he has
// blocked he stays in. Using him costs `backCost` yd in the protection count,
// so the line goes first. The pocket box is `box` yd either side of the
// launch point.
const POCKET = {
  tackle: { kick: 0.9, depth: 2.0, reach: 2.4 }, guard: { kick: 0.15, depth: 1.2, reach: 2.2 }, centre: { kick: 0, depth: 1.1, reach: 2.4 },
  square: 0.95, engage: 1.3, part: 2.2, ramp: 1.4, power: 2.5, help: 0.5, helpRange: 1.6,
  box: 4.4, close: 1.5, near: 3.5, loose: 3, onMove: 0.25, wash: 0.35, washDepth: 0.5, bend: 0.6,
  beaten: 0.5, clear: 0.5, burst: 0.5, lean: 0.6, rip: 6.2, skirt: 1.2,
  edge: 3.5, arc: 1.0, arcMin: 1.5, arcMax: 3.0, beyond: 0.8, gap: 2.4, gaps: { A: 0.8, B: 2.4, C: 4.2 },
  moved: 1, chase: 3, effort: 0.92, pickup: 1.2, backCost: 2, own: 1.5,
};
// Pass-rush matchups: `push` is how fast the pair gives ground (yd/s), `win`
// the hazard at Pro (per second at `ramp`; DISCIPLINE `plan` scales it) and
// `shed` the base chance to come off the block when the quarterback leaves
// the pocket.
const MATCHUP = {
  edge: { push: 0.75, win: 0.77, shed: 0.85 },    // an end on a tackle: slow to collapse, likelier to win
  inside: { push: 1.1, win: 0.53, shed: 0.6 },    // a tackle on a guard: a steady push
  nose: { push: 1.2, win: 0.48, shed: 0.55 },     // a nose on the centre
  blitzer: { push: 0.6, win: 0.86, shed: 0.8 },   // a linebacker or back on a lineman: quick, light
  back: { push: 1.6, win: 1.9, shed: 0.9 },       // anyone on a back: he gives ground fast
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
// `spread` s of his own; once he sees him break for the edge (within `edge`
// yd of the edge of the pocket box and still running out at `roll` yd/s or
// more) he reads the run `anticipate` s ahead. A slide that stops short of
// that is the quarterback moving inside the pocket: nobody reacts to it.
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
// squeezing to `front`; within `attack` yd, level with him or in front
// (give or take `close` yd), he takes him on. A contain man does this as
// soon as he sees the quarterback break for the edge on his side (with his
// ordinary reaction latency), before he is out. Inside rushers chase with
// `inside` yd of inside-out leverage. Linemen keep riding the man they have;
// one with nobody drifts toward the quarterback at `drift` of top speed, no
// more than `roam` yd from his set, and only takes a rusher within `reach`
// yd.
const SCRAMBLE = {
  spread: 0.1, anticipate: 0.35, edge: 0.75, min: 0.3, max: 0.6, fight: 1.4, widen: 0.8, square: 0.35, squareFrom: 0.64, retry: 0.2, burst: 4.5, recover: 0.25,
  relock: 1, path: 0.5, width: 0.5, lead: 0.4, leadMax: 1, front: 1, hold: 3, close: 1.2, attack: 2.5, roll: 3, inside: 0.8, drift: 0.4, roam: 2.5, reach: 2.5,
};
// Discipline by difficulty (never speed): `recognise` (s, see SCRAMBLE),
// `shed` (scales the chance to get off a block), `stunt` (chance of an
// end-tackle twist on a rep), `pa` (s a lineman plays the run on a
// play-action fake), `plan` (scales the chance to win a rep: an All-pro
// rusher reads his blocker's set, picks the move it gives him and has a
// counter ready; a Rookie picks a move and runs it into the man), `bend`
// (how far a winner turns at the quarterback rather than running on up his
// lane: 0 runs the arc past him, 1 flattens straight at him), `jump` (s
// after the snap a called blitzer from the second level goes: he times the
// count instead of reacting to the ball, GET_OFF; a Rookie does not) and
// `tip` (the share of called blitzers who give it away before the snap,
// creeping or staring at their gap, so the line counts them and knows they
// come; fixed by the man's number, no draw).
const DISCIPLINE = {
  rookie: { recognise: 0.2, shed: 0.75, stunt: 0.08, pa: 0.9, plan: 0.25, bend: 0.5, jump: 0.28, tip: 0.8 },
  pro: { recognise: 0.12, shed: 1, stunt: 0.15, pa: 0.75, plan: 1, bend: 0.7, jump: 0.2, tip: 0 },
  allpro: { recognise: 0.06, shed: 1.15, stunt: 0.22, pa: 0.6, plan: 4, bend: 1, jump: 0.12, tip: 0 },
};
// Play action: until he reads pass a defensive lineman fits his gap `fit` yd
// on his side of the line at `effort` of top speed, and once blocked holds
// his ground (leaning in at `push` yd/s) instead of rushing; his pressure
// clock starts when he reads pass. He reads pass the difficulty's `pa` s
// after the snap at most, or his reaction latency after the quarterback
// stops selling the fake: the fake is over, or the user has taken him off
// it and he is no longer within `mesh` yd of the back. A called blitzer
// comes anyway.
const PLAY_ACTION = { fit: 0.3, effort: 0.5, push: 0.3, mesh: 1.8 };
// Some reps the rush gets home sooner than others: every rusher's strength
// is 2^(-`weak` to +`strong`) for the whole rep times 2^(±`lock`) for his
// matchup (uniform in the exponent, from draws the rep makes anyway); see
// rushStrength.
const SPREAD = { weak: 2.6, strong: 1, lock: 0.6 };
// The protection's rules (see protect). The count at the snap takes in every
// lineman, anyone walked up within `walk` yd of the line and `edge` yd of the
// ball, and anyone in the box (`deep` by `wide` yd). The line sees a man come
// `read` s after he goes, and sees a counted man drop once he was, `read` s
// ago, `gone` yd deeper than he lined up (twice that to the side) or backing
// off at `away` yd/s. A lineman's zone is `zone` yd either side of his set
// (the centre and the slide side shifted `slide` yd toward the slide); he
// keeps a man who strays up to `keep` yd farther, and anyone `inside` yd
// behind the line is anyone's. A counted man who has not shown either way is
// worth `maybe` yd of trips: a spare sets up on him, nobody leaves a rusher
// for him. The matching looks at `most` threats at a time (an exact search).
const PROTECT = { walk: 2.5, edge: 8, deep: 6, wide: 5.5, read: 0.3, gone: 1, away: 2, zone: 2.5, slide: 1.6, keep: 1, inside: 2.5, maybe: 8, most: 8 };
// After the throw a rusher who has seen the ball go (his reaction latency
// after the release) comes off his block and runs to where it comes down
// (as he reads the flight), carried on along the line of the receiver he
// sees under it (the nearest within `mark` yd) for as long as he needs to
// get there past the ball, at most `lead` s.
const PEEL = { mark: 4, lead: 1.5 };
// Twists. An end and the tackle beside him trade lanes: in a T-E game the
// tackle goes first, slanting across the guard's face into the C gap, and
// the end loops behind him into the B gap; in an E-T game the end crashes
// inside and the tackle loops around to the edge. The penetrator slants to
// his new gap `depth` yd past the line (a blocker on him rides him across at
// `slant` yd/s); the looper steps flat along the line (`behind` yd on his
// side of it) until he is within `near` yd of his new gap, or `loop` s, then
// rushes it. The line passes the stunt off (`pickup`: the share of reps it
// sees it): when the penetrator crosses into the next man's zone (outside
// in a T-E game, inside in an E-T game), that man takes him if he is free
// or on the looper (the two trade men) and within `reach` yd more than the
// lock range, and the first blocker is free for the looper. A called pressure with more
// than `most` rushers brings its own picture: the line does not twist on it.
const STUNT = { depth: 1.2, slant: 2.5, behind: 0.7, near: 0.8, loop: 1.1, pickup: 0.75, reach: 0.5, most: 5 };

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
        players: this.players, launch: { x: this.pocketX(), z: this.spot - (this.dropPlan?.depth ?? LAUNCH.depth) }, set: false,
        decided: false, stunt: null, strength: 1, containL: null, containR: null, fakeEnd: null,
      };
    }
    return st;
  },

  discipline() { return DISCIPLINE[this.config.difficulty] || DISCIPLINE.pro; },

  // When a defender moves after the snap: his reaction to the ball (GET_OFF),
  // but a called blitzer from the second level times the snap count and goes
  // with it (the difficulty's `jump`).
  getOff(d) {
    const get = GET_OFF[d.role];
    return d.rushing && d.role !== 'dl' && !(d.rush?.at > 0) ? Math.min(get, this.discipline().jump) : get;
  },

  // How well this rusher's rep is going (SPREAD): the rep's strength times
  // his move's. It scales his win rate, and its square root his push and
  // how fast he runs the arc.
  rushStrength(d) { return (this.rushState().strength || 1) * (d.rushEdge || 1); },

  // On play action a defensive lineman plays the run until he reads pass
  // (PLAY_ACTION; 0 on any other play, or for a called blitzer).
  readsPassAt(d) { return this.play.type === 'pa' && d.role === 'dl' && d.rush?.lane !== 'blitz' ? this.fakeRead(d, this.discipline().pa) : 0; },
  readsRun(d) { return this.time < this.readsPassAt(d); },

  // When this defender stops playing a play-action fake: his reaction
  // latency after the quarterback stopped selling it, and `most` s after the
  // snap at most.
  fakeRead(d, most) {
    const end = this.rushState().fakeEnd;
    return end === null ? most : Math.min(most, end + (d.latency ?? 0));
  },

  // The launch point follows the drop until the quarterback sets, then stays.
  // The first live step also decides the twist. On play action it also notes
  // when the quarterback stops selling the fake (PLAY_ACTION).
  trackLaunch() {
    const st = this.rushState(), qb = this.byId.QB, L = st.launch;
    if (!st.decided && this.phase !== 'presnap') {
      // One draw for the rep: the twist, and (from an unrelated digit of the
      // same draw) how well this rush goes against this protection.
      const roll = this.random();
      st.decided = true; st.stunt = this.planStunt(roll);
      st.strength = 2 ** (SPREAD.strong - (SPREAD.weak + SPREAD.strong) * (roll * 9973 % 1));
    }
    if (this.phase === 'presnap') return;
    const pa = this.play.type === 'pa', plan = this.dropPlan, scripted = !!plan && !this.qbSteered;
    const faking = pa && this.carrier === 'QB' && this.faking();
    if (pa && st.fakeEnd === null && !(faking && (scripted || dist(qb, this.byId.R) < PLAY_ACTION.mesh))) st.fakeEnd = this.time;
    if (st.set) return;
    const depth = plan?.depth ?? LAUNCH.depth;
    L.z = Math.min(this.spot - depth, qb.z);
    const dropping = scripted && ((plan.mesh && faking) || qb.z > this.spot - depth + LAUNCH.short);
    const still = !dropping && this.time > LAUNCH.settle && Math.hypot(qb.vx, qb.vz) < LAUNCH.still;
    const late = LAUNCH.late + (pa ? st.fakeEnd ?? Infinity : 0);
    if (!still && this.time < late && this.carrier === 'QB') return;
    const x0 = this.pocketX();
    st.set = true;
    // (One already out of the pocket, rolling, leaves it where it was.)
    if (Math.abs(qb.x - L.x) <= POCKET.box) L.x = clamp(qb.x, x0 - LAUNCH.wide, x0 + LAUNCH.wide);
    L.z = clamp(qb.z, this.spot - LAUNCH.max, this.spot - LAUNCH.min);
  },

  // A twist between an end and the tackle beside him, on a seeded share of
  // pass reps: `roll` is the rep's draw (one on every pass rep, so the
  // stream does not depend on the front), whose remainder also picks the
  // side (in the play's own frame, so a flipped play twists on the mirrored
  // side), the game and whether the line sees it; none on a pressure with
  // more than STUNT `most` rushers. `config.stunt` can force one ({ kind:
  // 'TE' | 'ET', side: -1 | 1 in the play's own frame, like d.rush.side,
  // picked }) or rule it out ('none'). The plan's `side` is on the field.
  planStunt(roll) {
    const chance = this.discipline().stunt, forced = this.config.stunt;
    if (forced === 'none' || (!forced && (roll >= chance || this.rushers().length > STUNT.most))) return null;
    const u = forced ? roll : roll / chance, x0 = this.pocketX();  // uniform again, given a twist
    const side = (this.config.flip ? -1 : 1) * (forced?.side || (u < 0.5 ? -1 : 1)), kind = forced?.kind || (u * 2 % 1 < 0.5 ? 'TE' : 'ET');
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
  // own (fixed by his number, no draw). The trail holds 1 s.
  recognition(d) {
    const own = (d.number * 0.618034) % 1;
    return Math.min(0.95, (this.skill.latency ?? 0.28) + this.discipline().recognise + SCRAMBLE.spread * own);
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

  // This rusher has seen the quarterback leave the pocket, or break for its
  // edge on a run that takes him out (read `anticipate` s ahead).
  sawOut(d) {
    if (this.carrier !== 'QB') return false;
    const seen = this.seenQB(d), off = seen.x - this.rushState().launch.x;
    return Math.abs(off) > POCKET.box || (this.breaking(seen) !== 0 && Math.abs(off + seen.vx * SCRAMBLE.anticipate) > POCKET.box);
  },

  // The side the quarterback, as seen in `seen`, is breaking out of the
  // pocket to (SCRAMBLE `edge`, `roll`), or 0.
  breaking(seen) {
    const off = seen.x - this.rushState().launch.x, side = Math.sign(off);
    return Math.abs(off) > POCKET.box - SCRAMBLE.edge && side * seen.vx >= SCRAMBLE.roll ? side : 0;
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

  // Pass protection, by the rules a line plays by rather than by knowing who
  // comes (PROTECT). At the snap the line makes its call from the look
  // (callProtection): who it counts and which way it slides. Each step the
  // threats it accounts for (threat: the counted men it has not seen drop,
  // and anyone it has seen come) are matched to the blockers who have no
  // man (assignProtection), each lineman within his zone, the back to a man
  // he has seen come; with more threats than blockers the one who would
  // arrive last is the quarterback's. A lineman who has a man he is sure of
  // keeps him (he is committed) until he sees him drop, the man leaves his
  // zone or gets past him, someone else has him, or the man who beat him
  // has recovered to take him back; so a man the count missed, or one who
  // shows up where a committed man was, can come free. Pairs already locked
  // fight it out (contest); a twist is passed off or loses the looper; a
  // blocker with no man picks up any free rusher who comes within reach.
  // Once a rusher sees the ball thrown he comes off his block (PEEL). On a
  // scramble everyone is matched afresh among the rushers, within reach.
  protect(dt) {
    const st = this.rushState(), rushers = this.rushers(), rb = this.byId.R, qb = this.byId.QB, scramble = this.scrambling();
    if (st.stunt && !(this.byId[st.stunt.pen].rushing && this.byId[st.stunt.loop].rushing)) st.stunt = null;
    if (!st.call) st.call = this.callProtection();
    for (const o of this.line) this.keepLock(o);
    this.keepLock(rb);
    for (const d of rushers) if (d.lock && this.sawThrow(d)) this.unlock(this.byId[d.lock], d);
    this.markContain(st, rushers);
    for (const d of rushers) if (d.lock) this.contest(this.byId[d.lock], d, dt);
    this.passOff(st);
    this.loseLooper(st);
    const catching = this.phase === 'air' && this.pass.receiver === 'R';
    if (catching && rb.lock) this.unlock(rb, this.byId[rb.lock]);
    // A back with a hot route runs it; one lined up in the backfield checks.
    const back = !this.hotRoutes.R && rb.start.z < this.spot - 3 && this.carrier !== 'R' && !catching && !rb.released;
    const blockers = this.line.filter(o => !o.lock && this.time >= o.beatenUntil);
    if (back && !rb.lock && this.time >= rb.beatenUntil) blockers.push(rb);
    const threats = scramble ? rushers : this.defense.filter(d => this.threat(d, st));
    for (const o of this.line) if (!blockers.includes(o)) o.assignment = o.lock;
    if (!blockers.includes(rb)) rb.assignment = rb.lock;
    // Committed linemen keep their men (a recovered blocker gets back the
    // man who beat him); the rest, and the back, are matched to the threats
    // nobody has.
    const taken = new Set();
    for (const o of blockers) {
      o.lastMan = o.assignment;  // last step's man (assignProtection keeps him if it can)
      const d = o.assignment ? this.byId[o.assignment] : null;
      const owner = d && blockers.some(q => q !== o && q.lostTo === d.id), past = d && dist(d, qb) < dist(o, qb);
      if (!d || o.role !== 'ol' || scramble || owner || past || d.lock || taken.has(d.id) || !threats.includes(d) || !this.declared(d) || !this.inZone(o, d, PROTECT.keep)) o.assignment = null;
      else taken.add(d.id);
    }
    const open = blockers.filter(o => !o.assignment), loose = threats.filter(d => !d.lock && !taken.has(d.id)).slice(0, PROTECT.most);
    const plan = this.assignProtection(open, loose);
    for (const o of open) { const d = plan.get(o.id); o.assignment = d ? d.id : null; }
    for (const o of blockers) {
      const d = o.assignment ? this.byId[o.assignment] : null;
      if (d && d.rushing && this.canLock(o, d)) this.lock(o, d);
    }
    for (const o of blockers) {
      if (o.lock || o.assignment) continue;
      const d = rushers.find(q => !q.lock && this.canLock(o, q));
      if (d) this.lock(o, d);
    }
    // The back blocks only once he has a man; with none by the end of his
    // check he releases into his route for good. Once he has blocked he stays
    // in, beaten or not: `pickup` is his man, or 'QB' while he has none.
    if (back && !rb.blocked && !rb.lock && !rb.assignment && this.time >= POCKET.pickup) rb.released = true;
    for (const o of this.line) this.passSet(o, rushers);
    if (back && (rb.lock || rb.assignment || rb.blocked)) { this.passSet(rb, rushers); rb.pickup = rb.lock || rb.assignment || 'QB'; }
  },

  // The protection's call from the look at the snap: the count (every
  // lineman, and anyone walked up within `walk` yd of the line and `edge` yd
  // of the ball, or in the box, within `deep` and `wide` yd, and any blitzer
  // who tipped it, DISCIPLINE `tip`, whom the line is sure of) and the slide:
  // toward the side with more of them (on a tie away from the back, or to
  // the play's right), the back taking the other side.
  callProtection() {
    const x0 = this.pocketX(), count = new Set(), side = { [-1]: 0, 1: 0 };
    const tip = this.discipline().tip, tipped = new Set();
    for (const d of this.defense) {
      const deep = d.start.z - this.spot, off = d.start.x - x0, a = Math.abs(off);
      if (d.rushing && d.role !== 'dl' && (d.number * 0.618034) % 1 < tip) tipped.add(d.id);
      if (!(d.role === 'dl' || tipped.has(d.id) || (deep < PROTECT.walk && a < PROTECT.edge) || (deep < PROTECT.deep && a < PROTECT.wide))) continue;
      count.add(d.id);
      if (a >= 0.5) side[Math.sign(off)]++;
    }
    const back = this.byId.R.start.x - x0;
    const slide = side[1] !== side[-1] ? Math.sign(side[1] - side[-1]) : Math.abs(back) > 0.5 ? -Math.sign(back) : this.config.flip ? -1 : 1;
    return { count, slide, tipped, dropped: new Set() };
  },

  // A man the protection is accounting for: one it counted until it sees him
  // drop, or a rusher it did not count once he declares (`read` s after he
  // goes).
  threat(d, st) {
    if (d.rushing && this.declared(d)) return true;
    if (!st.call.count.has(d.id) || st.call.dropped.has(d.id)) return false;
    if (!d.rushing && this.dropped(d)) { st.call.dropped.add(d.id); return false; }
    return true;
  },

  // A rusher the line is sure of: a lineman, or a man it has seen come
  // (rushing, `read` s after he goes). A counted man who has not shown
  // either way (a spy, a man sitting in the box) is only a maybe (see
  // assignProtection).
  declared(d) {
    return d.role === 'dl' || this.passRush?.call?.tipped.has(d.id) || (d.rushing && this.time >= (d.rush?.at > 0 ? d.rush.at : this.getOff(d)) + PROTECT.read);
  },

  // The line has seen this man drop: `read` s ago he was more than `gone` yd
  // deeper than he lined up (twice that to the side), or backing off at
  // `away` yd/s.
  dropped(d) {
    const p = this.perceive(d.id, PROTECT.read);
    return p.z - d.start.z > PROTECT.gone || Math.abs(p.x - d.start.x) > 2 * PROTECT.gone || p.vz > PROTECT.away;
  },

  // A blocker's zone. A lineman takes the rushers within `zone` (+ `extra`)
  // yd of his set point, anyone outside the tackles counting as at the
  // tackle's set; the centre and the linemen on the slide side work a gap
  // (`slide` yd) that way. A man through the line (`inside` yd behind it)
  // and the man who beat him are anyone's; the back has the whole width.
  inZone(o, d, extra = 0) {
    if (o.role !== 'ol' || o.lostTo === d.id || d.z < this.spot - PROTECT.inside) return true;
    const x0 = this.pocketX(), slide = this.passRush.call.slide;
    const lt = this.setPoint(this.byId.LT).x, rt = this.setPoint(this.byId.RT).x, set = this.setPoint(o).x;
    const shift = (set - x0) * slide >= -0.5 ? PROTECT.slide * slide : 0;
    return Math.abs(clamp(d.x, Math.min(lt, rt), Math.max(lt, rt)) - set - shift) <= PROTECT.zone + extra;
  },

  // A blocker lets go of a man who has stopped rushing (he drops into
  // coverage): he felt him go, so the line knows he has dropped.
  keepLock(o) {
    const d = o.lock ? this.byId[o.lock] : null, call = this.rushState().call;
    if (d && !d.rushing && call) call.dropped.add(d.id);
    if (d && (!d.rushing || d.lock !== o.id)) this.unlock(o, d.lock === o.id ? d : null);
  },

  // A twist crossing the line: the blocker on the penetrator hands him to
  // the next man the way he crosses (out in a T-E game, in in an E-T game)
  // once he has crossed into that man's zone, if the line saw it and the
  // next man is close and free or on the looper (whom he lets go: they
  // exchange); the first blocker is then free for the looper.
  passOff(st) {
    const sk = st.stunt;
    if (!sk || !sk.picked || sk.passed) return;
    const d = this.byId[sk.pen], o = d.lock ? this.byId[d.lock] : null;
    if (!o || o.role !== 'ol') return;
    const mine = this.setPoint(o).x, gone = Math.abs(mine - d.x), way = sk.kind === 'TE' ? sk.side : -sk.side;
    let next = null;
    for (const n of this.line) {
      const at = this.setPoint(n).x;
      if (n === o || (n.lock && n.lock !== sk.loop) || this.time < n.beatenUntil || way * (at - mine) <= 0
        || Math.abs(at - d.x) >= gone || dist(n, d) >= POCKET.engage + STUNT.reach) continue;
      if (!next || Math.abs(at - mine) < Math.abs(this.setPoint(next).x - mine)) next = n;
    }
    if (!next) return;
    if (next.lock) this.unlock(next, this.byId[next.lock]);
    this.unlock(o, d);
    this.lock(next, d);
    sk.passed = true;
    this.events.push('pass-off');
  },

  // The looper crossing behind the penetrator: the man who had him cannot
  // follow him through the penetrator's block. Unless the line passes the
  // twist off he is free until someone inside picks him up.
  loseLooper(st) {
    const sk = st.stunt;
    if (!sk || sk.passed || sk.lost) return;
    const pen = this.byId[sk.pen], loop = this.byId[sk.loop];
    if (Math.sign(loop.x - pen.x) === Math.sign(loop.start.x - pen.start.x)) return;
    const o = this.line.find(q => q.assignment === loop.id && !q.lock);
    if (o) { sk.lost = o.id; o.assignment = null; }
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
  // who has just shed his man is not his again at once; a looper lost to a
  // twist is not his man's, and nobody takes a man who has seen the ball
  // thrown. On a scramble a blocker must be in the rusher's path to the
  // quarterback, and a rusher chasing him (he has seen him go) runs around
  // a blocker rather than into him: only the locks he already has hold him.
  canLock(o, d) {
    const qb = this.byId.QB, since = this.time - d.wonAt;
    if (dist(o, d) >= POCKET.engage || since < POCKET.clear || dist(o, qb) >= dist(d, qb)) return false;
    const scramble = this.scrambling();
    if (d.shedFrom === o.id && since < SCRAMBLE.relock) return false;
    if (this.lostLooper(o, d) || this.sawThrow(d)) return false;
    if (!scramble) return true;
    if (this.sawOut(d)) return false;
    const toO = scaled(o.x - d.x, o.z - d.z, 1), toQB = scaled(qb.x - d.x, qb.z - d.z, 1);
    return toO.x * toQB.x + toO.z * toQB.z > SCRAMBLE.path;
  },

  // This blocker lost this looper to the twist (see loseLooper).
  lostLooper(o, d) {
    const st = this.passRush, sk = st && st.players === this.players ? st.stunt : null;
    return !!sk && !sk.passed && sk.lost === o.id && sk.loop === d.id;
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
    d.have += rate * this.rushStrength(d) * this.discipline().plan * dt;
    if (d.have < d.need) return;
    this.unlock(o, d);
    o.beatenUntil = this.time + POCKET.beaten; o.action = 'stumble'; o.actionTime = POCKET.beaten; o.lostTo = d.id;
    o.vx *= STUMBLE_SPEED; o.vz *= STUMBLE_SPEED;
    // The rip, swim or drive: over a quarter second (the juke blend) the
    // rusher goes from his push to `rip` yd/s and to the side he won (a bull
    // rusher straight through), bent from his lane toward the quarterback by
    // the difficulty's `bend`. An undisciplined end runs on up the arc, and
    // with a quarterback who has stepped up his lane takes him behind him.
    const ref = this.freeRef(d), lane = d.rushMove === 'bull' ? ref : this.laneAim(d, ref), bend = this.discipline().bend;
    const aim = { x: lane.x + (ref.x - lane.x) * bend, z: lane.z + (ref.z - lane.z) * bend };
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

  // Protection: block the most dangerous threats, those who would reach the
  // quarterback first, so the one left free is the farthest (a counted man
  // who has not shown is only a maybe, PROTECT); among those choices take
  // the shortest trips, keep last step's man, give a recovered blocker the
  // man who beat him (`own` yd, so the spare stays free to help), and use the
  // back only when the line runs out. Nobody takes a man already past him; a
  // lineman takes only a man in his zone (inZone), and on a scramble only a
  // man within reach: nobody runs across the formation. The back takes only
  // a man he has seen come. Exact search over every matching (at most six
  // blockers and eight threats).
  assignProtection(blockers, rushers) {
    const qb = this.byId.QB, n = blockers.length, k = rushers.length, full = 1 << k, scramble = this.scrambling();
    const plan = new Map();
    if (!n || !k) return plan;
    const cost = blockers.map(o => rushers.map(d => dist(d, qb) < dist(o, qb) || (scramble ? o.role === 'ol' && dist(o, d) > SCRAMBLE.reach : !this.inZone(o, d) || this.lostLooper(o, d) || (o.role === 'rb' && !(d.rushing && this.declared(d)))) ? Infinity
      : dist(o, this.squarePoint(d)) - (o.lastMan === d.id ? 1 : 0) - (o.lostTo === d.id ? POCKET.own : 0) + (o.role === 'rb' ? POCKET.backCost : 0)));
    // Leaving a rusher free costs far more than any trip, and more the sooner
    // he would arrive (about 2 yd of trips per yard nearer the quarterback).
    const free = rushers.map(d => scramble || this.declared(d) ? 100 - 14 * dist(d, qb) / d.top : PROTECT.maybe);
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
    if (this.sawThrow(d)) return this.peelWant(d);
    const st = this.rushState(), lane = this.laneOf(d), qb = this.byId.QB;
    if (this.sawOut(d)) return this.scrambleWant(d, lane);
    const contain = this.containAim(d, true);
    if (contain === 'attack') return this.pursue(d, 'QB', speedCap(d, 1));
    if (contain) { d.aim = contain; return scaled(contain.x - d.x, contain.z - d.z, speedCap(d, 1)); }
    const cap = speedCap(d, lane.blitzer ? 1 : POCKET.effort), since = this.time - d.wonAt;
    if (since < POCKET.burst) return this.pursue(d, 'QB', speedCap(d, 1), d.winSide * POCKET.lean * (1 - since / POCKET.burst));
    if (d.wonAt > 0 || dist(d, qb) < POCKET.chase) return this.pursue(d, 'QB', speedCap(d, 1));
    if (this.readsRun(d)) return seekWant(d, { x: lane.x, z: this.spot + PLAY_ACTION.fit }, speedCap(d, PLAY_ACTION.effort));
    const twist = this.twistAim(d, lane);
    if (twist) return seekWant(d, twist, speedCap(d, 0.9), 2);
    const aim = this.unblocked(d) ? this.straightLane(d, this.freeRef(d), lane) : this.laneAim(d, this.freeRef(d), lane);
    d.aim = aim;
    return scaled(aim.x - d.x, aim.z - d.z, cap);
  },

  // Nobody is blocking him or set to: no lineman or back has him.
  unblocked(d) {
    if (d.lock) return false;
    for (const o of this.line) if (o.assignment === d.id) return false;
    return this.byId.R.assignment !== d.id;
  },

  // The free man's straight lane to `ref`: straight at it, around the
  // nearest body in the way (a lineman, or a rusher locked with one, ahead
  // of him within `skirt` yd of the line), passing `skirt` yd beside it: on
  // the outside for an edge rusher, who keeps contain, else on the side the
  // line already passes it.
  straightLane(d, ref, lane) {
    const dx = ref.x - d.x, dz = ref.z - d.z, len = Math.hypot(dx, dz);
    if (len < 0.5) return ref;
    const ux = dx / len, uz = dz / len;
    let aim = ref, best = len;
    for (const o of this.players) {
      if (o === d || !(o.role === 'ol' || (o.team === 'defense' && o.lock))) continue;
      const along = (o.x - d.x) * ux + (o.z - d.z) * uz, off = (o.x - d.x) * uz - (o.z - d.z) * ux;
      if (along <= 0 || along >= best || Math.abs(off) >= POCKET.skirt) continue;
      // Which side of it: + is to the right of his run, (uz, -ux).
      const by = lane.edge && Math.abs(uz) > 0.3 ? lane.side * Math.sign(uz) : off > 0 ? -1 : 1;
      best = along; aim = { x: o.x + by * uz * POCKET.skirt, z: o.z - by * ux * POCKET.skirt };
    }
    return aim;
  },

  // The ball is out and he has seen it go (PEEL).
  sawThrow(d) { return this.phase === 'air' && this.pass.elapsed >= d.latency; },

  // A rusher's pursuit after the throw (PEEL): to where the ball comes down,
  // carried on along the line of the receiver he sees running under it (as
  // he reads him, with his reaction latency).
  peelWant(d) {
    const flight = this.readFlight(d), end = flight.target, cap = speedCap(d, 1);
    let mark = null, near = PEEL.mark;
    for (const id of RECEIVERS) {
      if (!this.byId[id]) continue;
      const r = this.estimate(id, d.latency), g = dist(r, end);
      if (g < near) { near = g; mark = r; }
    }
    const lead = mark ? clamp(dist(d, end) / cap - flight.remaining, 0, PEEL.lead) : 0;
    d.aim = { x: end.x + (mark ? mark.vx * lead : 0), z: end.z + (mark ? mark.vz * lead : 0) };
    return scaled(d.aim.x - d.x, d.aim.z - d.z, cap);
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
  // and, with `rolling`, unless he has seen the quarterback break for the
  // edge his way, which he reads with his ordinary reaction latency: it is
  // his key; see breaking): outside the point where he can meet the
  // quarterback's path, holding his depth `front` to `hold` yd in front of
  // it (he does not retreat after him) until he is outside him, then
  // squeezing to `front` yd; once he is within `attack` yd, level with him
  // or in front (give or take `close` yd), he takes him on ('attack'), from
  // outside or, if the quarterback has got outside him, from there: he does
  // not run around him to win his edge back.
  containAim(d, rolling = false) {
    const st = this.rushState(), now = this.watchQB(d);
    const roll = rolling ? (this.carrier === 'QB' ? this.breaking(now) : 0) : Math.sign(this.seenQB(d).x - st.launch.x) || 1;
    if (!roll) return null;
    if ((roll > 0 ? st.containR : st.containL) !== d.id) return null;
    if (d.z > now.z - SCRAMBLE.close && dist(d, now) < SCRAMBLE.attack) return 'attack';
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
