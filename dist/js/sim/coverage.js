// Pass coverage: the per-step defensive dispatch, the coverage jobs of the
// call (pattern-matching zones, quarters, man technique, robbers and spies),
// the plaster rule on a scramble, run fits and play fakes, hip flips and
// reading the ball in the air. The call itself (who has which job, what the
// defense shows before the snap) comes from defense.js as `d.assign` in the
// play's own frame; landmarks are mirrored here for a flipped play.
import { RECEIVERS } from '../plays.js';
import { STEP, clamp, dist, ZERO, scaled, seekWant, trackWant, speedCap, GET_OFF, PULL_UP } from './common.js';

const GRAVITY = 10.73;
const FLIP_TIME = 0.25;                // lateral grip is halved while flipping
const BACKPEDAL_SPEED = 0.65;          // share of top speed, moving away from facing
const CUSHION = 3;                     // yards a receiver may close before the flip
const MAX_BACKPEDAL = 7;               // yards of backpedal before a back must open up
const WIDE_THREAT = 5;                 // yards across to a vertical that also turns him
const SHUFFLE_SPEED = 0.88;
// A man rotating a long way from his pre-snap look (over 6 yd) runs a
// crossover for `window` s after he starts: `side` of top speed across the
// field and `back` of it away from the quarterback, still facing him. A deep
// zone defender bails the same way the whole time he faces him.
const ROTATE = { window: 1.2, side: 1, back: 0.9 };
// Pattern-matching zones (see planCoverage). Yards and yards past the line.
const COVER = {
  window: 8.5, stick: 2,   // an underneath man matches within `window` yd across his landmark; his own man gets `stick` yd more room and is `stick` yd cheaper
  flat: 3, flatWide: 11,   // a curl/flat man takes a receiver in his flat (`flatWide` yd or more off the ball, short) first: `flat` yd cheaper
  flatLook: 0.6,           // ... reading a release by where it will be in `flatLook` s, from his first step
  back: 8, backFloor: 4,   // the hole player drops no deeper than `back` while the back is still a checkdown in front of him; on the back he sits no shallower than `backFloor`
  slant: 6, under: 8, hash: 7, inward: 2,  // a hook or curl man outside the hash takes #1 breaking inside (a slant, a dig) `slant` yd cheaper; a flat man a short release coming inside him (faster than `inward` yd/s) `under` yd dearer
  outward: 1.5, declare: 1, settled: 3,  // a flat route: moving out faster than `outward` yd/s and than upfield, or under `settled` yd/s after `declare` s
  wall: 4, wallTo: 14,     // a curl/flat man walls #2's vertical to `wallTo` yd: `wall` yd cheaper
  carryAt: 7,              // a matched receiver going upfield past this depth is carried like man coverage
  vertical: 6, deep: 15,   // a deep threat: past `vertical` yd and going upfield, or past `deep` yd
  half: 9,                 // ... to a half-field safety, past `half` yd: a route that stops at 6 yd is the underneath's
  widen: 0.6, seam: 1,     // with nothing deep yet, a half widens `widen` of the way to #1 releasing upfield unless a seam inside him on that side is as fast (within `seam` yd/s)
  post: 3, postSpeed: 6,   // to a post safety, a receiver going upfield past `post` yd at over `postSpeed` yd/s
  top: 1, over: 8, topWidth: 4,  // a deep man is on top: `top` to `over` yd deeper and within `topWidth` yd across
  close: 3,                // a carrier or man defender within this of his receiver counts as help
  middleHelp: 0.5,         // a deep middle, half or free safety helps underneath at this share of the difficulty's help
  cushionSpeed: 0.1, floor: 6, middle: 12,  // a quarters man keeps `cushionSpeed` yd more cushion per yd/s; on top a deep man is never shallower than `floor` (`middle` for a deep middle, half or free safety)
  reach: 14, open: 2.5, keep: 1.5,  // help: the most open man within `reach` yd (open: no other defender within `open`), keeping his choice by `keep` yd
  shade: 0.35,             // an empty deep zone shades this share of the way toward the vertical beside it
  phase: 1,                // a deep man on top shades at most this far off his receiver toward his landmark
  inside: 0.5,             // a deep middle ranks a vertical this much less dangerous per yard off his landmark across
  bracket: 1.5,            // help leans to the offense's favourite target as if he were this much more open
  loose: 0.1, eyes: 0.4,   // a deep man splitting two carried verticals leans `loose` per yard toward the one carried worse,
                           // and `eyes` × the difficulty's eyes toward the one the quarterback turns to throw to
};
// A deep zone's landmark depth (yd) before any vertical takes him deeper: a
// post safety (a deep middle or a free safety), a half, an outside third.
const SETTLE = { post: 20, half: 18, third: 17 };
// A deep man on top of a vertical (deepOver). While the receiver is short
// the cushion is `base` yd plus `speed` yd per yd/s of his speed upfield, so
// the defender is already running with him rather than waiting for him to
// close; from `from` to `to` yd past the line an outside man closes to
// `level` yd over him, `hip` yd to the quarterback's side (his own side of a
// receiver within `middle` yd of the quarterback's line): in phase, where the
// ball comes in. The middle of the field stays `keep` (plus `keepSpeed` per
// yd/s) over the deepest man and never comes up from its landmark while he
// is short of it: nobody is behind him. A man on top runs with the receiver
// once he is within `run` yd of the defender (of the middle's landmark).
const OVER = { base: 0.9, speed: 0.3, from: 12, to: 20, level: 0.3, hip: 0.8, middle: 2, keep: 1, keepSpeed: 0.1, run: 8 };
// Quarters (Cover 4 and the strong side of Cover 6). A corner opens and
// carries #1 once he is past `bail` yd and running upfield faster than
// `bailSpeed` yd/s, or on anything vertical past `carry` yd (keeping him
// while he stays past `settle`); otherwise he squats over #1, keeping
// `squat` yd of cushion (more the faster #1 comes) and never shallower than
// `floor`. A safety reads #2: while #2 is still short and coming, he sits
// `read` yd over him (never shallower than `readFloor`); vertical, he
// carries him, until #2 flattens (moving across more than `flatten` times
// as fast as upfield); out or under, he robs the window on his side (#1's
// curl or in-cut first, `first` yd cheaper, or a crosser coming into it;
// nearest to `robX`, `robZ`) from inside, `rob` yd deeper than his man
// between `robFloor` and `robTop` yd, and over the top of #1's post or
// dig however deep it goes (he caps #1 for the corner).
const QUARTERS = { settled: 1.2, carry: 8, settle: 8, bail: 5, bailSpeed: 5, flatten: 2, squat: 2.2, floor: 7, outside: 1.2, rob: 1.5, robFloor: 6, robTop: 18, inside: 2, robX: 9, robZ: 12, first: 3, read: 5, readFloor: 9 };
// Man technique. Press: mirror at the line for `press` s, then trail. Trail
// (with help over the top): a step (`trail` yd) behind on a vertical, `lev`
// yd to the leverage side; otherwise squeezed `under` yd deeper. Off: start
// `cushion` yd deep (from the call) and give it up at `close` yd per yard
// the receiver gains, never closer than `top`, over where the receiver will
// be `ahead` s on. With no help he stays on top, `top` yd over the same
// point. Both leads shrink by `squeeze` × DIFFICULTY.squeeze: a man who
// trusts his read of the stem gives it less ground and plays the break.
// Beaten for the top on a vertical, he sits in the hip pocket, `pocket` yd
// off him toward the quarterback.
const MAN = { hip: 0.5, press: 0.45, lev: 0.6, trail: 0.5, under: 0.6, close: 0.7, top: 1.2, ahead: 0.13, squeeze: 0.5, jamRange: 1.3, jamUntil: 0.9, pocket: 0.8 };
// The plaster rule: once the quarterback scrambles, or holds the ball past
// `hold` s, every zone defender takes the nearest receiver man to man
// (keeping his man unless another is `keep` yd nearer) and nobody leaves
// coverage for the quarterback while he can still throw.
const PLASTER = { hold: 3.5, keep: 2 };
// A robber sits in the hole and drives on crossers within `window` yd of the
// ball, handing a vertical off at `carry` yd; with nobody to take he follows
// the quarterback's throwing motion (DIFFICULTY.eyes). A spy mirrors the
// quarterback `depth` yd past the line and attacks once he leaves the pocket.
const RAT = { window: 10, carry: 12, crosser: 2 };
const SPY = { depth: 4.5, effort: 0.9 };
// Steps of the quarterback's facing kept for the defenders reading his eyes
// (more than the slowest reaction time).
const FACINGS = 64;
// A delayed rusher shows a pass drop until his count: `drop` yd straight
// back at `effort` of top speed, so he is not the one man who stands still
// at the snap.
const SHOW = { drop: 1.5, effort: 0.5 };
// Banjo against a bunch: the men on it settle who takes whom `at` s (plus
// their reaction time) after the snap, outside to outside, from where the
// receivers are heading `look` s ahead.
const BANJO = { at: 0.55, look: 0.5 };
// Leverage at the catch point: an underneath man sits `zone` yd off his
// receiver toward the quarterback (in the throwing lane), anchored `anchor`
// of the way to his landmark; a man in phase on a short route sits `man` yd
// toward the quarterback.
const LANE = { zone: 0.5, anchor: 0.08, man: 0.25 };
// Within `near` yd short of the goal line (z = `line`) an underneath or man
// defender sits `side` yd on the goal-line side of his receiver.
const GOAL = { line: 110, near: 5, side: 0.7, end: 119.5 };
// Inside the 20 (`zone` yd from the goal line) the end line is everybody's
// deep help: a deep man on top of a receiver, or helping on one, plays him
// in phase, `over` yd over him, instead of keeping a cushion or his
// landmark depth.
const RED = { zone: 20, over: 1 };
// Seeing the ball: a man defender sees it within his field of view (the
// cosine of the angle off his facing above `man`); a zone defender, whose
// eyes are on the quarterback, sees it over either shoulder too, even
// running straight away from him (above `zone`).
const EYES = { man: -0.34, zone: -1.01 };
// Leaning on a receiver still going upfield faster than `stem` yd/s, an
// empty deep zone keeps its depth (deepOver). A free underneath man helping
// on a vertical past `from` yd sinks `under` yd under him and `inside` yd
// inside, no deeper than `to` yd, `help` times the difficulty's help of the
// way from his landmark.
const LEAN = { stem: 2, from: 7, under: 1.5, inside: 1.2, to: 15, help: 2 };
// Reading a receiver's change of speed over `span` s of what was seen.
const READ = { span: 0.1 };
// Breaking on the ball (breakOnBall): the flight is sampled every `step` s;
// a point where the ball is `low` to `high` yd up is his if he can get within
// `reach` yd of it in time, carried on along his own line for `turn` s before
// he drives on it. Before that, within `phase` yd of the receiver running
// under it (the one whose line takes him within `mark` yd of where it comes
// down), he stays in phase on him, `front` yd to the side the ball comes in
// on, and plays it through his hands. Otherwise a pass coming down within
// `far` yd, and within his run in its flight plus `near` yd, he runs through
// the catch point, `front` yd short of it on the line the ball comes in on;
// one within `rally` yd he rallies to: the catch point carried on along the
// line of the receiver under it for as long as he needs to get there past
// the ball, at most `lead` s.
const BREAK = { step: 0.04, low: 0.9, high: 2.3, turn: 0.2, reach: 0.4, phase: 4, far: 15, near: 3, front: 0.45, mark: 3, rally: 30, lead: 1.2 };
// A play fake: a linebacker's downhill read step at this share of top speed.
const BITE_SPEED = 0.4;
// The pole runner in Tampa 2 matches within `width` yd of the ball, takes a
// vertical there `cost` yd cheaper (so does the Cover 2 hole player), sits
// on it no shallower than his landmark and as deep as `depth` yd, and
// carries it as far as it goes. He runs the deep middle whatever the back
// does: a route short of `short` yd that is not going straight upfield
// inside him (a checkdown, a flat, a drag) is the hooks'.
const POLE = { width: 9, cost: 3, depth: 22, short: 8 };

export const coverage = {
  planDefense(dt = STEP) {
    const pursuit = this.phase === 'run' || this.phase === 'tackle' || this.crossedLine;
    const pocket = this.inPocket(), rep = this.call.rep;
    // Once the quarterback has scrambled the defense plays a scramble for the
    // rest of the rep, even if he steps back inside the pocket box.
    const loose = this.carrier === 'QB' && this.phase === 'live' && (rep.scrambled || this.scrambling());
    if (loose) rep.scrambled = true;
    if (this.phase === 'air' && rep.throwAt === null) rep.throwAt = this.time - (this.pass.elapsed || 0);
    // The throwing motion and the quarterback's shoulders, for the men who
    // read his eyes (seesThrow).
    if (this.throwIntent) rep.windupAt ??= this.time; else if (this.phase === 'live') rep.windupAt = null;
    this.noteFacing();
    // After a catch every defender has watched the ball into the receiver's
    // hands: he reads the runner DIFFICULTY.chase s late, not his ordinary
    // reaction latency.
    const chase = this.completed && this.carrier && this.carrier !== 'QB' ? this.skill.chase : undefined;
    this.defense.forEach(d => {
      if (chase !== undefined) d.latency = chase;
      d.sprinting = true;
      if (this.phase === 'air') this.readPass(d, dt);
      if (this.phase === 'tackle' && d.id === this.tackle.tackler) return;
      if (this.phase === 'tackle' && this.tackle.helpers.has(d.id)) {
        const c = this.byId[this.carrier];
        d.want = { x: c.vx, z: c.vz };
        return;
      }
      if (this.time < this.getOff(d)) { d.want = ZERO; return; }
      if (d.engaged) { this.drivePast(d); return; }
      if (this.phase === 'tackle' && dist(d, this.byId[this.carrier]) >= PULL_UP.pileOn) { d.want = this.pullUpWant(d); return; }
      // A delayed rusher goes on his count while the pass rush is on.
      if (!d.rushing && d.rush && d.rush.at > 0 && pocket && this.time >= d.rush.at) d.rushing = true;
      // Run fits: each man reads the handoff at his own time (DIFFICULTY.runRead).
      // Before the handoff he reads the back, not the quarterback at the mesh.
      if (pursuit || (this.play.type === 'run' && this.time > d.readRun)) {
        const target = this.play.type === 'run' && !this.handoff && !this.crossedLine ? 'R' : this.carrier || 'R';
        this.turnHips(d); d.want = this.pursue(d, target, speedCap(d), 0, d.leverage); return;
      }
      if (d.rushing) { d.want = this.rushWant(d); return; }
      // A spy attacks a quarterback who leaves the pocket.
      if (loose && d.assign?.kind === 'spy') { this.turnHips(d); d.want = this.pursue(d, 'QB', speedCap(d), 0, d.leverage); return; }
      // A play fake holds the second level: a read step downhill, then the
      // drop. He reads the fake shown, not the call: he plays the run until
      // his reaction time after the quarterback stops selling it (fakeRead).
      if (this.play.type === 'pa' && this.time < this.fakeRead(d, d.bite)) { d.want = seekWant(d, { x: d.x, z: this.spot + 1 }, speedCap(d, BITE_SPEED)); return; }
      const cover = this.cover(d);
      if (this.phase === 'air' && d.ballAware) {
        // Stay in coverage when the pass is elsewhere. The read is an estimate
        // from the visible ball, not access to the quarterback's chosen target.
        const want = this.breakOnBall(d, this.readFlight(d));
        if (want) { this.turnHips(d); d.want = want; return; }
      }
      if (!d.turned) this.readThreat(d, cover.threat);
      d.want = this.backpedalLimit(d, cover.want);
    });
  },

  // The quarterback has scrambled (at any time this rep) or held the ball
  // too long: plaster.
  plastering() {
    return this.phase === 'live' && this.carrier === 'QB' && !this.crossedLine && (this.call.rep.scrambled || this.scrambling() || this.time > PLASTER.hold);
  },

  // Coverage, planned once a step for every coverage defender from the
  // receivers as the defense sees them (DIFFICULTY.read seconds late, carried
  // forward), so difficulty still works through reaction time. Each defender
  // gets a `job` (see cover):
  //   man    play one receiver: man coverage (press, trail, off, on top), a
  //          vertical he carries, or the plaster rule;
  //   zone   sit on the receiver he matched in his underneath zone;
  //   top    stay on top of the one deep threat in his deep zone;
  //   split  midpoint two deep threats, leaning to the one nobody carries;
  //   squat  a quarters corner over #1 when #1 is not vertical;
  //   read   a quarters safety over #2 while #2 declares;
  //   rob    a quarters safety in the window inside #1 when #2 is not vertical;
  //   lean   move from an anchor toward an open man or a nearby vertical
  //          (sinking under a vertical, for a free underneath man);
  //   rat    a robber in the hole with nobody to take;
  //   spy    mirror the quarterback;
  //   hold   keep the pre-snap look (a held rotation; a delayed rusher
  //          shows a drop from it);
  //   spot   hold his landmark.
  // Deep men own every vertical in their zone (quarters players first take
  // #1 and #2 by their reads). Underneath men are matched one receiver each,
  // nearest landmark first, keeping last step's man unless another is clearly
  // nearer. A matched receiver who goes upfield is carried until a deep man
  // has him (or past the difficulty's carry depth); only then is he handed
  // off. A man with nobody to match helps on the open receiver.
  planCoverage() {
    this.coverPlanAt = this.time;
    const spot = this.spot, skill = this.skill, flip = this.config.flip ? -1 : 1, call = this.call, lay = call.layout, rep = call.rep;
    const seen = this.coverSeen = {};
    for (const id of RECEIVERS) if (!this.byId[id].pickup && this.carrier !== id) seen[id] = this.readReceiver(id, skill.read ?? skill.latency);
    const ids = Object.keys(seen), order = id => RECEIVERS.indexOf(id), px = r => r.x * flip;
    const upfield = r => r.vz > 2.5 && r.vz > Math.abs(r.vx) * 0.8;
    // Still going upfield, a looser test for keeping a job taken on upfield,
    // so a read near the threshold does not flip it every step.
    const rising = r => r.vz > 1 && r.vz > Math.abs(r.vx) * 0.5;
    const men = [], deeps = [], quarters = [], unders = [], rest = [];
    for (const d of this.defense) {
      const a = d.assign;
      if (d.rushing || !a) continue;
      if (a.kind === 'hold' || this.time < d.rotate.at) {
        const show = d.rush?.at > 0;
        rest.push({ d, job: { kind: 'hold', x: d.start.x, z: d.start.z + (show ? SHOW.drop : 0), effort: show ? SHOW.effort : 1, fake: !!d.rotate.fake } });
        continue;
      }
      // (A man on a bunch has his receiver from the banjo once it is settled.)
      if (a.kind === 'man') men.push({ d, id: d.banjoId || a.id, a });
      else if (a.kind === 'deep') {
        // How shallow he comes: an outside third squeezes down on a hitch,
        // the middle of the field (a deep middle, a half, a free safety)
        // stays deep enough to stay over everything (less in the red zone).
        const post = Math.abs(a.x) < 6 || a.lo === -Infinity && a.hi === Infinity;
        const middle = post || a.lo === 0 || a.hi === 0 || (a.lo < 0 && a.hi > 0);
        const floor = Math.min(middle ? COVER.middle : COVER.floor, (115 - spot) * 0.5);
        // He settles at his landmark depth (SETTLE) until a vertical takes
        // him deeper: the post safety deepest, over everything.
        const settle = post ? SETTLE.post : middle ? SETTLE.half : SETTLE.third;
        deeps.push({ d, x: a.x * flip, px: a.x, z: Math.min(115, spot + Math.min(a.depth, settle)), depth: a.depth, lo: a.lo, hi: a.hi, floor, middle, post, half: middle && !post, help: middle ? COVER.middleHelp : 1, threats: [], job: null });
      }
      else if (a.kind === 'quarter') quarters.push({ d, side: a.side, role: a.role, x: a.side * 14 * flip, z: Math.min(115, spot + 20), threats: [], job: null });
      else if (a.kind === 'under' || a.kind === 'rat') unders.push({ d, role: a.kind === 'rat' ? 'rat' : a.role, side: Math.sign(a.x), x: a.x * flip, z: Math.min(115, spot + a.depth), depth: a.depth, seam: !!a.seam, job: null });
      else rest.push({ d, job: { kind: a.kind } });
    }
    // The hole player sees the back: while the back is still a checkdown (in
    // the backfield or short, checking for a rusher or released, but not in
    // a block), the hole player, with nobody to match, drops no deeper than
    // COVER.back (the Tampa 2 pole runner runs the middle).
    const checkdown = lay.backs.some(id => { const b = this.byId[id]; return this.carrier !== id && !b.lock && !b.blocked && (seen[id] || b).z < spot + 4; });
    // A receiver is carried (by an underneath man last step, or manned) when
    // his man is within `close` yd of him.
    const near = (d, id) => dist(d, seen[id]) < COVER.close;
    const carried = id => unders.some(u => u.d.carrying && u.d.match === id && near(u.d, id)) || men.some(m => m.id === id && near(m.d, id));
    const claim = id => (carried(id) ? 0 : unders.some(u => u.d.handed === id) ? 2 : 1);

    // Quarters: corners first (on #1), then safeties (reading #2). A vertical
    // a quarters player takes is his alone; the deep zones never see it.
    const owned = new Map();
    const top = (q, id) => { q.job = { kind: 'top', id, primary: id, threats: [id] }; q.threats = [id]; owned.set(id, q); };
    quarters.sort((a, b) => (a.role === b.role ? a.side - b.side : a.role === 'corner' ? -1 : 1));
    for (const q of quarters) {
      const [one, two] = (lay.nums[q.side] || []).filter(id => seen[id]);
      const kept = id => q.d.job?.primary === id;
      const deepNow = id => { const r = seen[id]; return r.z > spot + QUARTERS.carry && r.vz > 1 || (kept(id) && r.z > spot + QUARTERS.settle && r.vz > -1 && Math.abs(r.vx) < QUARTERS.flatten * Math.max(0, r.vz) + 1); };
      const out = q.side * flip;
      if (q.role === 'corner') {
        const bails = one && seen[one].z > spot + QUARTERS.bail && seen[one].vz > QUARTERS.bailSpeed && upfield(seen[one]);
        if (one && !owned.has(one) && (deepNow(one) || bails)) top(q, one);
        else q.job = one ? { kind: 'squat', id: one, out } : { kind: 'spot', x: q.side * 16 * flip, z: spot + 10 };
        continue;
      }
      const r2 = two && seen[two];
      if (two && !owned.has(two) && (deepNow(two) || (r2.z > spot + COVER.vertical && upfield(r2)))) { top(q, two); continue; }
      // No #2 going vertical: any other vertical inside #1 on his half (a
      // trips #3, a deep crosser) nobody else has.
      const r1 = one && seen[one];
      const inner = ids.find(id => id !== one && !owned.has(id) && (deepNow(id) || (seen[id].z > spot + QUARTERS.carry && upfield(seen[id])))
        && px(seen[id]) * q.side > -4 && (!r1 || Math.abs(px(seen[id])) < Math.abs(px(r1))));
      if (inner) { top(q, inner); continue; }
      // #2 still declaring (short and going upfield): sit over him and wait,
      // as long as he keeps coming.
      if (r2 && r2.z < spot + COVER.vertical && (upfield(r2) || (q.d.job?.kind === 'read' && q.d.job.id === two && rising(r2)))) { q.job = { kind: 'read', id: two }; continue; }
      // #2 out or under: rob the intermediate window on his side, #1's curl
      // or in-cut first, or a crosser coming into it from the other side.
      let rob = null, best = Infinity;
      for (const id of ids) {
        const r = seen[id], x = px(r) * q.side;
        if (owned.has(id) || x < -3 || r.z < spot + QUARTERS.robFloor || r.z > spot + QUARTERS.robTop + 4) continue;
        const cost = Math.hypot(x - QUARTERS.robX, r.z - spot - QUARTERS.robZ) - (id === one ? QUARTERS.first : 0) - (q.d.job?.id === id ? COVER.stick : 0);
        if (cost < best) { best = cost; rob = id; }
      }
      rob ||= one;
      const cap = !!rob && rob === one && seen[one].z > spot + QUARTERS.carry && seen[one].vz > 1;
      q.job = rob ? { kind: 'rob', id: rob, cap, out: Math.sign(seen[rob].x - this.pocketX()) || out } : { kind: 'spot', x: q.side * 8 * flip, z: spot + 12 };
    }

    // Deep zones: each owns the verticals between its `lo` and `hi` (play
    // frame, so a flipped play is covered as the mirror image of the same
    // call). A vertical stays with last step's deep man while within 2 yd of
    // his zone.
    deeps.sort((a, b) => a.px - b.px);
    const wasDeep = id => deeps.some(z => z.d.job?.threats?.includes(id));
    // The post safety reads a fast inside release sooner (COVER.post); a
    // half-field safety leaves a short route to the underneath (COVER.half).
    // A deep threat stays one while still going upfield near that depth (to
    // a half, while still rising: an out or a dig that has broken is not a
    // vertical).
    const vertical = (r, id, z) => r.z > spot + COVER.deep || (r.z > spot + (z.half ? COVER.half : COVER.vertical) && upfield(r)) || (z.post && r.z > spot + COVER.post && upfield(r) && (r.vz > COVER.postSpeed || wasDeep(id)))
      || (wasDeep(id) && r.z > spot + COVER.vertical - 1 && (z.half ? rising(r) : r.vz > 0));
    for (const id of ids) {
      const r = seen[id];
      if (owned.has(id)) continue;
      const x = px(r);
      const owner = deeps.find(z => z.d.job?.threats?.includes(id) && x > z.lo - 2 && x < z.hi + 2) || deeps.find(z => x >= z.lo && x < z.hi);
      if (owner && vertical(r, id, owner)) owner.threats.push(id);
    }
    // How loose a receiver is: the nearest coverage defender to him but one.
    const coverers = this.defense.filter(d => !d.rushing && !d.engaged && d.action !== 'stumble');
    const looseness = (id, but) => { let g = Infinity; for (const q of coverers) if (q !== but) g = Math.min(g, dist(q, seen[id])); return g; };
    // (Run again below when an underneath man hands a vertical off this step,
    // so the deep man takes him on the same step.)
    const deepJobs = () => { for (const z of deeps) {
      z.job = null;
      const prev = z.d.job?.threats || [];
      // The most dangerous first: the deepest and fastest, and for a deep
      // middle the nearest the middle of the field (a seam before a go).
      const danger = id => seen[id].z + 0.5 * Math.max(0, seen[id].vz) + (prev.slice(0, 2).includes(id) ? 2 : 0) - (z.help < 1 ? COVER.inside * Math.abs(px(seen[id]) - z.px) : 0);
      const threats = z.threats.sort((a, b) => danger(b) - danger(a) || order(a) - order(b));
      if (threats.length === 1) z.job = { kind: 'top', id: threats[0], primary: threats[0], floor: z.floor, middle: z.middle };
      else if (threats.length > 1) {
        // Two verticals: midpoint them, leaning to the one nobody else has,
        // and first to one an underneath man has handed off to him; when
        // both are carried (or neither), toward the one carried worse.
        const [a, b] = threats, sa = claim(a), sb = claim(b);
        const w = sa === sb ? clamp(0.5 + COVER.loose * (Math.min(6, looseness(a, z.d)) - Math.min(6, looseness(b, z.d))), 0.2, 0.8) : sa > sb ? 0.8 : 0.2;
        z.job = { kind: 'split', a, b, w, primary: w > 0.75 ? a : w < 0.25 ? b : null, floor: z.floor, middle: z.middle };
      }
      if (z.job) z.job.threats = threats;
    } };
    deepJobs();
    // A deep man has a receiver when he is assigned to him alone and on top
    // of him: deeper by `top` to `over` yd and within `topWidth` across.
    const onTop = (d, r, width) => d.z > r.z + COVER.top && d.z < r.z + COVER.over && Math.abs(d.x - r.x) < width;
    const deepHas = id => deeps.some(z => z.job?.primary === id && onTop(z.d, seen[id], COVER.topWidth)) || (owned.has(id) && onTop(owned.get(id).d, seen[id], COVER.topWidth));
    const deepOwns = id => owned.has(id) || deeps.some(z => z.threats.includes(id));

    // Underneath: carries first. A carry ends when a deep man has the
    // receiver, past the carry depth (a robber hands off sooner, the Tampa 2
    // pole runner never), or (a curl/flat defender sinking with a vertical a
    // deep man has taken) when a receiver shows in his flat; it becomes a
    // plain match when the receiver settles back underneath.
    const flatRole = u => u.role === 'flat' || u.role === 'curlflat' || u.role === 'seamflat';
    const carryLimit = u => (u.role === 'pole' ? Infinity : u.role === 'rat' ? Math.min(skill.carry, RAT.carry) : skill.carry);
    // In the flat: outside him and short, on a flat route (moving out faster
    // than upfield) or settled there once the routes have declared; #1
    // releasing from his split is not a flat route.
    const flatRoute = r => r.vx * Math.sign(r.x) > Math.max(COVER.outward, r.vz) || (this.time > COVER.declare && Math.hypot(r.vx, r.vz) < COVER.settled);
    // (`look` s ahead: a curl/flat man's first step reads where the release is headed.)
    const inFlat = (u, r, look = 0) => Math.sign(r.x) === Math.sign(u.x) && Math.abs(r.x + r.vx * look) > COVER.flatWide && r.z < spot + 6 && r.z > spot - 2 && flatRoute(r);
    // A curl/flat or seam/flat man reads #2 on his side: while #2 is going
    // upfield short of `wallTo` yd he walls the seam (`wall` yd cheaper),
    // unless a receiver shows in his flat.
    // A two-deep hook (`seam`) walls #2's seam the same way whatever shows
    // in the flat: the flat is the corner's.
    const walls = (u, id, r) => (flatRole(u) || u.seam) && u.side && lay.nums[u.side]?.[1] === id && upfield(r) && r.z < spot + COVER.wallTo
      && (u.seam || !ids.some(k => k !== id && inFlat(u, seen[k])));
    // He leaves #1's vertical stem to the deep third outside him, and a short
    // release coming inside him (faster than `inward` yd/s, a little faster
    // still to give up one he has) to the hooks, `under` yd dearer.
    const leaves = (u, id, r) => flatRole(u) && u.side && lay.nums[u.side]?.[0] === id && upfield(r);
    const inside = (u, id, r) => flatRole(u) && r.z < spot + 6 && r.vx * Math.sign(u.x) < -COVER.inward - (u.d.match === id ? 1 : 0);
    // A hook or curl man passes a release to the flat on to the flat defender
    // on that side and, dropping outside the hash (`hash` yd or wider), walls
    // #1 coming inside (a slant, a dig) instead.
    const hookRole = u => u.role === 'hook' || u.role === 'curl';
    // (Once he has #1 he keeps walling him until #1 turns upfield; he never
    // carries #1's vertical, the corner's and the deep half's.)
    const passes = (u, r) => hookRole(u) && unders.some(f => flatRole(f) && !f.d.carrying && inFlat(f, r, COVER.flatLook));
    const walling = (u, id) => hookRole(u) && Math.abs(u.x) >= COVER.hash && lay.nums[u.side]?.[0] === id;
    const wallsIn = (u, id, r) => walling(u, id) && r.z < spot + 12 && (u.d.match === id && !upfield(r) || r.vx * Math.sign(u.x) < -COVER.outward);
    const taken = new Set();
    let handed = false;
    for (const u of unders) {
      const d = u.d, r = seen[d.match];
      if (d.handed && (!seen[d.handed] || seen[d.handed].z < spot + COVER.carryAt - 1)) d.handed = null;
      if (!r) { d.match = null; d.carrying = false; continue; }
      if (!d.carrying) continue;
      // A flat defender (a Cover 2 corner) sinks with #1 only until a flat
      // route shows and a deep man has #1 in his zone; a curl/flat man waits
      // until the deep man is on top.
      const flat = flatRole(u) && r.z > spot + 8 && (u.role === 'flat' ? deepOwns(d.match) : deepHas(d.match)) && ids.some(id => id !== d.match && inFlat(u, seen[id]));
      if (deepHas(d.match) || r.z > spot + carryLimit(u) || flat) { d.handed = d.match; d.match = null; d.carrying = false; handed = true; }
      else if (!upfield(r) && r.z < spot + COVER.carryAt) d.carrying = false;
      else taken.add(d.match);
    }
    if (handed) deepJobs();
    const pairs = [];
    for (const u of unders) {
      const d = u.d;
      if (d.carrying) continue;
      const window = u.role === 'rat' ? RAT.window : u.role === 'pole' ? POLE.width : COVER.window;
      for (const id of ids) {
        // A flat defender's window runs out to the sideline on his side.
        const r = seen[id], mine = d.match === id, wide = flatRole(u) && Math.sign(r.x) === Math.sign(u.x) && Math.abs(r.x) > Math.abs(u.x);
        // The hole player takes a released back wherever he is.
        const back = u.role === 'hole' && lay.backs.includes(id);
        if (taken.has(id) || id === d.handed || r.z < spot - (back ? 6 : 2) || (!wide && !wallsIn(u, id, r) && Math.abs(r.x - u.x) > window + (mine ? COVER.stick : 0))) continue;
        // A two-deep hook or the hole player leaves a release to the flat to
        // the corner, for good once he has.
        if ((u.seam || u.role === 'hole') && r.z < spot + 6 && (d.flatPass?.has(id) || (r.z < spot + 4 && Math.abs(r.x + r.vx * COVER.flatLook) > COVER.flatWide && r.vx * Math.sign(r.x) > Math.max(COVER.outward, r.vz)))) { (d.flatPass ||= new Set()).add(id); continue; }
        // A back still checking for a rusher behind the line is nobody's yet.
        if (r.z < spot && lay.backs.includes(id) && !this.byId[id].released) continue;
        // (Never one past where he would hand him off: a robber would take
        // and drop two verticals in turn.)
        if (!mine && (r.z > spot + Math.min(u.role === 'rat' ? carryLimit(u) : skill.carry, 18) || (r.z > spot + COVER.carryAt && deepHas(id)))) continue;
        // (His own man too, once he settles short or turns across.)
        if (u.role === 'pole' && r.z < spot + POLE.short && (mine ? r.vz < 1 : !(upfield(r) && Math.abs(r.vx) < 0.5 * r.vz && Math.abs(r.x - this.pocketX()) < POLE.width))) continue;
        // A curl/flat defender takes the flat first; the hooks wall the
        // inside; a robber jumps crossers; the pole runner takes the seam.
        let cost = Math.hypot(r.x - u.x, r.z - u.z) - (mine ? COVER.stick : 0) - (flatRole(u) && inFlat(u, r, COVER.flatLook) ? COVER.flat : 0) - (walls(u, id, r) ? COVER.wall : 0) - (wallsIn(u, id, r) ? COVER.slant : 0)
          + (leaves(u, id, r) ? COVER.wall : 0) + (inside(u, id, r) ? COVER.under : 0) + (passes(u, r) ? COVER.flat : 0);
        if (u.role === 'rat' && Math.abs(r.vx) > Math.abs(r.vz)) cost -= RAT.crosser;
        if ((u.role === 'pole' || u.role === 'hole') && upfield(r) && Math.abs(px(r) - this.pocketX() * flip) < POLE.width) cost -= POLE.cost;
        pairs.push({ u, id, cost });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost || unders.indexOf(a.u) - unders.indexOf(b.u) || order(a.id) - order(b.id));
    const matched = new Set();
    for (const { u, id } of pairs) if (!matched.has(u) && !taken.has(id)) { matched.add(u); taken.add(id); u.d.match = id; }
    for (const u of unders) {
      const d = u.d;
      if (!d.carrying && !matched.has(u)) d.match = null;
      const r = seen[d.match];
      if (r && !d.carrying && upfield(r) && r.z > spot + COVER.carryAt && !walling(u, d.match)) d.carrying = true;
      if (d.match) u.job = { kind: d.carrying ? 'man' : 'zone', id: d.match, tech: 'top', x: u.x, z: u.z, deep: u.role === 'pole' ? POLE.depth : 16, floor: u.role === 'pole' ? u.depth : u.role === 'hole' && lay.backs.includes(d.match) ? COVER.backFloor : 2 };
    }

    // Help. Each receiver's coverage gap is the distance to the nearest other
    // coverage defender; a free man leans toward the most open one in reach,
    // keeping last step's choice unless another is clearly more open, and
    // toward the offense's favourite target (call.bracket) a little more.
    const openMan = (d, minDepth, where = () => true) => {
      let best = null, score = COVER.open;
      for (const id of ids) {
        const r = seen[id];
        if (r.z < spot + minDepth || dist(d, r) > COVER.reach || !where(r)) continue;
        let gap = Infinity;
        for (const q of coverers) if (q !== d) gap = Math.min(gap, dist(q, r));
        if (d.helpOn === id) gap += COVER.keep;
        if (call.bracket && lay.slot[id] === call.bracket) gap += COVER.bracket;
        if (gap > score) { score = gap; best = id; }
      }
      return (d.helpOn = best);
    };
    for (const u of unders) {
      if (u.job) continue;
      if (u.role === 'rat') { u.job = { kind: 'rat', x: u.x, z: u.z }; continue; }
      // Nobody open: help under the nearest vertical in reach instead. A
      // two-deep hook helps inside the flat; the pole runner helps only past
      // POLE.short and never comes up from his landmark.
      const pole = u.role === 'pole';
      let id = openMan(u.d, 1, pole ? r => r.z >= spot + POLE.short : u.seam ? r => Math.abs(px(r)) < COVER.flatWide || r.z > spot + 6 : undefined);
      if (!id) {
        let near = COVER.reach;
        for (const k of ids) { const r = seen[k], g = dist(u.d, r); if (r.z > spot + LEAN.from && upfield(r) && g < near) { near = g; id = k; } }
      }
      const z = checkdown && u.role === 'hole' ? Math.min(u.z, spot + COVER.back) : u.z;
      u.job = id ? { kind: 'lean', id, w: skill.help, x: u.x, z, lo: pole ? u.z : spot + 2, hi: spot + 16 } : { kind: 'spot', x: u.x, z };
    }
    for (const z of deeps) {
      if (z.job) continue;
      // A half-field safety over a flat corner with nothing deep yet reads #2
      // to #1: when #1 releases vertically and no seam inside him on that
      // side runs as fast, he widens with #1 (COVER.widen) to take away the
      // hole between the corner and himself. (Over man, the corner trails #1
      // and the half stays over both.) Once he widens he keeps widening while
      // #1 is still rising outside.
      if (z.half && unders.some(u => u.role === 'flat' && u.side === Math.sign(z.px))) {
        const side = Math.sign(z.px), [one] = (lay.nums[side] || []).filter(id => seen[id]), r1 = one && seen[one];
        // (Widening, he gives it up for a seam within half that.)
        const widening = r1 && z.d.job?.widen && z.d.job.id === one;
        const seam = r => r.z > spot && upfield(r) && Math.abs(r.vx) < 0.5 * r.vz && r.vz > r1.vz - COVER.seam * (widening ? 0.5 : 1);
        if (r1 && (widening ? rising(r1) : upfield(r1) && r1.z > spot + 1) && Math.abs(r1.x) > COVER.flatWide && !ids.some(id => id !== one && Math.sign(seen[id].x) === Math.sign(r1.x) && Math.abs(seen[id].x) < Math.abs(r1.x) && seam(seen[id]))) {
          z.job = { kind: 'lean', id: one, w: COVER.widen, x: z.x, z: z.z, lo: z.z, hi: 115, over: true, keep: z.middle ? z.z : 0, floor: z.floor, widen: true };
          continue;
        }
      }
      // An empty deep zone: squeeze an open man underneath in it (a corner
      // sinking on a hitch), else shade toward the nearest vertical beside
      // it, else help on any open man near him. He stays deeper than his man.
      const own = openMan(z.d, 1, r => px(r) >= z.lo && px(r) < z.hi);
      if (own) { z.job = { kind: 'lean', id: own, w: skill.help * z.help, x: z.x, z: z.z, lo: spot + z.floor - 4, hi: 115, over: true, keep: z.middle ? z.z : 0, floor: z.floor }; continue; }
      // Ties go to the first in play-frame order, the same on a flipped play.
      let beside = null;
      for (const other of deeps) for (const id of other.threats) if (!beside || Math.abs(seen[id].x - z.x) < Math.abs(seen[beside].x - z.x)) beside = id;
      for (const id of owned.keys()) if (!beside || Math.abs(seen[id].x - z.x) < Math.abs(seen[beside].x - z.x)) beside = id;
      if (beside) { z.job = { kind: 'lean', id: beside, w: COVER.shade, x: z.x, z: z.z, lo: z.z, hi: 115, over: true, keep: z.middle ? z.z : 0, floor: z.floor }; continue; }
      const id = openMan(z.d, 1);
      z.job = id ? { kind: 'lean', id, w: skill.help * z.help, x: z.x, z: z.z, lo: spot + z.floor - 2, hi: 115, over: true, keep: z.middle ? z.z : 0, floor: z.floor } : { kind: 'spot', x: z.x, z: z.z };
    }

    // Man coverage. Against a bunch the men on it banjo once the receivers
    // have released: outside to outside, by where they are heading. A man
    // whose receiver stays in to block is free: he robs the shallow middle
    // and doubles the most open man near him.
    if (call.banjo.length && rep.banjoAt === null && this.time >= BANJO.at + (skill.read ?? skill.latency)) {
      rep.banjoAt = this.time;
      const group = men.filter(m => m.a.banjo && seen[m.a.id]), out = lay.bunch.side * flip;
      const ahead = id => (seen[id].x + seen[id].vx * BANJO.look) * out;
      const recs = group.map(m => m.a.id).sort((a, b) => ahead(b) - ahead(a) || order(a) - order(b));
      group.sort((a, b) => b.d.x * out - a.d.x * out || a.d.number - b.d.number).forEach((m, k) => { m.d.banjoId = recs[k]; });
    }
    for (const m of men) {
      const id = m.d.banjoId || m.id, a = m.a;
      m.id = id;
      if (seen[id]) {
        const sx = lay.at[id]?.x || 0, out = (sx ? Math.sign(sx) : Math.sign(m.d.start.x * flip) || 1) * flip;
        const pressing = a.press && this.time < GET_OFF[m.d.role] + MAN.press;
        // With help over the top, corners press and trail or play off, and
        // linebackers and safeties play in phase from where they line up;
        // with none, everybody stays on top of his man.
        const corner = m.d.role === 'cb';
        const tech = pressing ? 'press' : !a.help ? 'top' : !corner ? 'trail' : a.press ? 'trail' : 'off';
        m.job = { kind: 'man', id, tech, lev: a.lev, out, cushion: corner ? a.cushion : Math.min(a.cushion, m.d.start.z - spot) };
        // A pressed receiver: the corner gets his hands on him once, at the line.
        const r = this.byId[id];
        if (pressing && this.time < MAN.jamUntil && !rep.jams.has(id) && dist(m.d, r) < MAN.jamRange) { rep.jams.add(id); this.jam?.(r, m.d, a.jam); }
        continue;
      }
      const x = this.pocketX(), z = spot + 7, help = openMan(m.d, 1);
      m.job = help ? { kind: 'lean', id: help, w: Math.max(skill.help, 0.5), x, z, lo: spot + 3, hi: spot + 12 } : { kind: 'spot', x, z };
    }

    // The plaster rule: every zone defender takes the nearest uncovered
    // receiver, nearest pairs first, and the men stay glued.
    if (this.plastering()) {
      const covered = new Set(men.filter(m => m.job.kind === 'man').map(m => m.job.id));
      const free = [...deeps, ...quarters, ...unders], pairs = [];
      for (const c of free) for (const id of ids) {
        if (covered.has(id) || seen[id].z < spot - 2) continue;
        pairs.push({ c, id, cost: dist(c.d, seen[id]) - (c.d.plasterOn === id ? PLASTER.keep : 0) });
      }
      pairs.sort((a, b) => a.cost - b.cost || a.c.d.number - b.c.d.number || order(a.id) - order(b.id));
      const busy = new Set();
      for (const { c, id } of pairs) {
        if (busy.has(c) || covered.has(id)) continue;
        busy.add(c); covered.add(id); c.d.plasterOn = id;
        c.job = { kind: 'man', id, tech: 'plaster', over: !unders.includes(c), threats: c.job?.threats, primary: c.job?.threats ? id : undefined };
      }
      for (const m of men) if (m.job.kind === 'man') m.job.tech = 'plaster';
    }
    for (const c of [...men, ...deeps, ...quarters, ...unders, ...rest]) { if (c.x !== undefined) { c.job.x ??= c.x; c.job.z ??= c.z; } c.d.job = c.job; }
  },

  // Coverage movement for one defender's job (planCoverage). Returns the
  // wanted velocity and the receiver who threatens him (for the hip flip).
  cover(d) {
    if (this.coverPlanAt !== this.time || !d.job) this.planCoverage();
    const cap = speedCap(d), job = d.job, seen = this.coverSeen, spot = this.spot;
    if (!job) return { want: ZERO, threat: null };
    if (job.kind === 'hold') {
      // The held look (a delayed rusher's shown drop); a lineman who drops
      // first takes a rush step.
      if (job.fake) { const qb = this.byId.QB; return { want: scaled(qb.x - d.x, qb.z - d.z, cap * 0.45), threat: null }; }
      return { want: seekWant(d, { x: job.x, z: job.z }, cap * (job.effort ?? 1)), threat: null };
    }
    if (job.kind === 'spy') {
      const q = this.estimate('QB', d.latency);
      return { want: seekWant(d, { x: q.x, z: spot + SPY.depth }, cap * SPY.effort), threat: null };
    }
    if (job.kind === 'rat') {
      // In the hole, following the quarterback's throwing motion.
      let x = job.x;
      const facing = this.seesThrow(d) ? this.qbFacingSeen(d.latency) : null;
      if (facing !== null && Math.cos(facing) > 0.2) {
        const qb = this.perceive('QB', d.latency), line = qb.x + Math.tan(facing) * (job.z - qb.z), px = this.pocketX();
        x += (clamp(line, px - RAT.window, px + RAT.window) - x) * this.skill.eyes;
      }
      return { want: seekWant(d, { x, z: job.z }, cap), threat: null };
    }
    const r = job.id ? seen[job.id] : null;
    if ((job.kind !== 'split' && job.kind !== 'spot' && !r)) return { want: ZERO, threat: null };
    if (job.kind === 'man') {
      // The side he shades to: toward the sideline (outside) or the ball.
      const lead = this.skill.routeLead, lev = (job.lev === 'outside' ? 1 : -1) * (job.out || 0), v = { x: r.vx, z: r.vz };
      const ahead = MAN.ahead * (1 - MAN.squeeze * (this.skill.squeeze ?? 0));
      let target;
      if (job.tech === 'press') target = { x: r.x + lev * 0.5, z: r.z + 0.9 };
      else if (job.tech === 'trail') {
        // In phase: hip to hip, a step behind and to his leverage on a
        // vertical (the help is over the top); otherwise on him in the
        // throwing lane, driving on the break.
        const lane = this.laneOffset(r, LANE.man);
        target = r.vz > 3 && r.z > spot + 5
          ? { x: r.x + lev * MAN.lev + r.vx * lead, z: r.z - MAN.trail }
          : { x: r.x + lev * MAN.hip + lane.x + r.vx * lead, z: r.z + lane.z + r.vz * lead };
      } else if (job.tech === 'plaster') target = { x: r.x + r.vx * lead, z: r.z + (job.over ? 1.5 : 0.4) };
      else if (d.z < r.z && r.vz > 3) {
        // Beaten for the top on a vertical: in the hip pocket on the
        // quarterback's side, where the ball comes over his shoulder.
        const lane = this.laneOffset(r, MAN.pocket);
        target = { x: r.x + lane.x + r.vx * lead, z: r.z + lane.z + r.vz * lead };
      } else if (job.tech === 'off') {
        // The cushion is kept over where he will be `ahead` s on (MAN):
        // leading by the difficulty's routeLead here would give more ground
        // the better he reads.
        const cushion = Math.max(MAN.top, job.cushion - MAN.close * Math.max(0, r.z - spot));
        target = { x: r.x + lev * MAN.lev + r.vx * lead, z: r.z + cushion + r.vz * ahead };
      } else target = { x: r.x + lev * MAN.lev + r.vx * lead, z: r.z + MAN.top + r.vz * ahead };
      if (job.tech !== 'press') this.goalSide(r, target);
      return { want: trackWant(d, target, v, cap), threat: r };
    }
    if (job.kind === 'top') {
      // Stay on top while he is short: deeper than the receiver by a cushion
      // that grows with his speed, matching his vertical speed instead of
      // waiting at the landmark, shaded toward his landmark by at most
      // `phase` yd. Coming into the deep-throw range (PHASE) an outside man
      // closes to in phase: level with him, on his hip on the quarterback's
      // side, where the ball comes in. The middle of the field stays on top
      // (`middle`): nobody is behind him.
      const { z, k } = this.deepOver(d, job, r);
      const qx = this.byId.QB.x - r.x, side = Math.abs(qx) > OVER.middle ? Math.sign(qx) : Math.sign(d.x - r.x) || 1;
      const target = { x: r.x + clamp((job.x - r.x) * 0.15, -COVER.phase, COVER.phase) * (1 - k) + side * OVER.hip * k, z };
      // He runs with the receiver once he is within `run` yd of the depth he
      // keeps (of the defender, for an outside man).
      const ahead = r.z > (job.middle ? z : d.z) - OVER.run ? Math.max(0, r.vz) : 0;
      return { want: trackWant(d, target, { x: r.vx, z: ahead }, cap, 1.6), threat: r };
    }
    if (job.kind === 'split') {
      const a = seen[job.a], b = seen[job.b], deeper = a.z > b.z ? a : b;
      // Eyes on the quarterback: once he sees him start to throw, lean to the
      // side he faces. He keeps that lean while the ball is in the air until
      // he finds it.
      let w = job.w;
      if (this.seesThrow(d) && !(this.phase === 'air' && d.eyesOn)) {
        const qb = this.perceive('QB', d.latency), facing = this.qbFacingSeen(d.latency);
        const side = r => Math.abs(Math.sin(Math.atan2(r.x - qb.x, r.z - qb.z) - facing));
        d.eyesOn = side(a) < side(b) ? job.a : job.b;
      } else if (this.phase !== 'air') d.eyesOn = null;
      if (d.eyesOn) w = clamp(w + (d.eyesOn === job.a ? 1 : d.eyesOn === job.b ? -1 : 0) * this.skill.eyes * COVER.eyes, 0, 1);
      const target = { x: job.x * 0.15 + (w * a.x + (1 - w) * b.x) * 0.85, z: this.deepOver(d, job, deeper).z };
      const ahead = deeper.z > (job.middle ? target.z : d.z) - OVER.run ? Math.max(0, deeper.vz) : 0;
      return { want: trackWant(d, target, { x: (w * a.vx + (1 - w) * b.vx) * 0.85, z: ahead }, cap, 1.6), threat: deeper };
    }
    if (job.kind === 'zone') {
      // Sit on him, in the throwing lane (between him and the quarterback),
      // moving with him rather than waiting for him; never out of the zone.
      const lead = this.skill.routeLead, lane = this.laneOffset(r, LANE.zone), lo = spot + (job.floor ?? 2), hi = spot + (job.deep || 16), z = r.z + lane.z + r.vz * lead;
      const target = this.goalSide(r, { x: job.x * LANE.anchor + (r.x + lane.x + r.vx * lead) * (1 - LANE.anchor), z: clamp(z, lo, hi) });
      return { want: trackWant(d, target, { x: r.vx, z: z > lo && z < hi ? r.vz : 0 }, cap), threat: r };
    }
    if (job.kind === 'squat' || job.kind === 'read') {
      // Keep the cushion over him as he comes, matching his vertical speed
      // (a pedal, not a wait at the spot); a corner squeezes a receiver who
      // settles (a hitch or a curl) down to `settled` yd over him.
      const squat = job.kind === 'squat', ahead = Math.max(0, r.vz), settled = squat && r.vz < 1.5;
      const target = squat
        ? { x: r.x + job.out * QUARTERS.outside * (settled ? 0.4 : 1), z: settled ? r.z + QUARTERS.settled : Math.max(r.z + QUARTERS.squat + ahead * COVER.cushionSpeed, spot + QUARTERS.floor) }
        : { x: r.x, z: Math.max(r.z + QUARTERS.read + ahead * COVER.cushionSpeed, spot + QUARTERS.readFloor) };
      return { want: trackWant(d, target, { x: r.vx * 0.5, z: r.z + 6 > d.z ? ahead : 0 }, cap, 1.6), threat: r };
    }
    if (job.kind === 'rob') {
      const z = r.z + QUARTERS.rob, lo = spot + QUARTERS.robFloor, hi = job.cap ? GOAL.end : spot + QUARTERS.robTop;
      const target = { x: r.x - job.out * QUARTERS.inside, z: clamp(z, lo, hi) };
      return { want: trackWant(d, target, { x: r.vx * 0.85, z: z > lo && z < hi ? r.vz : 0 }, cap, 2), threat: r };
    }
    if (job.kind === 'lean') {
      // A point between the anchor and where the receiver is heading; a deep
      // man stays deeper than him.
      const ax = r.x + r.vx * 0.3, az = r.z + r.vz * 0.3;
      let z = clamp(job.z + (az - job.z) * job.w, job.lo, job.hi), vz = r.vz * job.w;
      const red = GOAL.line - spot <= RED.zone;
      if (job.over) z = Math.max(z, r.z + (red ? RED.over : 2));
      // A deep man comes down only on a receiver who has declared short: one
      // still in his stem (going upfield) could be a vertical, so the middle
      // of the field keeps its landmark depth and an outside man stays on
      // top of him (deepOver), running with him; both shade only across.
      if (job.floor && r.vz > LEAN.stem) {
        if (job.keep && !red) z = Math.max(z, job.keep);
        else { z = this.deepOver(d, job, r).z; vz = r.vz; }
      }
      // A free underneath man helps on a vertical by sinking under it on the
      // inside, so the ball has to go over him: as far as he helps (LEAN).
      // (Every deep man's lean has a floor: he never comes down under it.)
      if (!job.floor && r.z > spot + LEAN.from && r.vz > LEAN.stem && r.vz > Math.abs(r.vx)) {
        const inside = Math.sign(this.pocketX() - r.x) || 1, k = Math.min(1, job.w * LEAN.help);
        const sz = Math.min(r.z - LEAN.under, spot + LEAN.to), sink = { x: job.x + (r.x + inside * LEAN.inside - job.x) * k, z: Math.max(job.lo, job.z + (sz - job.z) * k) };
        return { want: trackWant(d, sink, { x: r.vx * k, z: sz < spot + LEAN.to ? r.vz * k : 0 }, cap, 2), threat: r };
      }
      const free = z > job.lo && z < job.hi;
      return { want: trackWant(d, { x: job.x + (ax - job.x) * job.w, z: Math.min(115, z) }, { x: r.vx * job.w, z: free ? vz : 0 }, cap, 2), threat: r };
    }
    return { want: seekWant(d, { x: job.x, z: job.z }, cap), threat: null };
  },

  // A man who reads the quarterback's eyes (DIFFICULTY.eyes) sees the
  // throwing motion his reaction time after it starts, like everything else
  // the offense does (the ball still in his hand or already in the air).
  seesThrow(d) {
    const at = this.call.rep.windupAt;
    return !!this.skill.eyes && at != null && (this.throwIntent || this.phase === 'air') && this.time - at >= d.latency - 1e-9;
  },

  // The quarterback's facing, kept every step (planDefense), and as a
  // defender saw it `latency` s ago: the newest one at or before then.
  noteFacing() {
    let f = this.facingTrail;
    if (!f || f.players !== this.players) f = this.facingTrail = { players: this.players, t: new Float64Array(FACINGS), a: new Float64Array(FACINGS), head: -1, count: 0 };
    f.head = (f.head + 1) % FACINGS; f.t[f.head] = this.time; f.a[f.head] = this.byId.QB.facing;
    f.count = Math.min(FACINGS, f.count + 1);
  },
  qbFacingSeen(latency) {
    const f = this.facingTrail;
    if (!f || f.players !== this.players || !f.count) return this.byId.QB.facing;
    let i = f.head;
    for (let n = 1; n < f.count && f.t[i] > this.time - latency + 1e-9; n++) i = (i - 1 + FACINGS) % FACINGS;
    return f.a[i];
  },

  // How deep a man on top of a vertical sits (OVER), and how far into
  // closing to in phase (k, 0 to 1) an outside man is.
  deepOver(d, job, r) {
    const spot = this.spot, v = Math.max(0, r.vz);
    if (GOAL.line - spot <= RED.zone) return { z: Math.min(GOAL.end, r.z + RED.over), k: 1 };
    if (job.middle) return { z: Math.min(GOAL.end, Math.max(job.z, r.z + OVER.keep + v * OVER.keepSpeed)), k: 0 };
    const k = clamp((r.z - spot - OVER.from) / (OVER.to - OVER.from), 0, 1);
    return { z: Math.min(GOAL.end, Math.max(spot + (job.floor ?? COVER.floor), r.z + (OVER.base + v * OVER.speed) * (1 - k) + OVER.level * k)), k };
  },

  // A receiver as a coverage man reads him: where he was `latency` s ago,
  // carried forward at the velocity seen then and, as far as the difficulty
  // reads a receiver's body (DIFFICULTY.anticipate), at the change of speed
  // seen then too: a receiver sinking his hips into a break is seen slowing
  // before the break shows. The change is measured over READ.span s of what
  // was seen and never carried past a stop.
  readReceiver(id, latency) {
    const now = this.perceive(id, latency), k = this.skill.anticipate || 0;
    const lag = this.time - now.t;
    if (!k || lag <= 0) return { t: now.t, x: now.x + now.vx * lag, z: now.z + now.vz * lag, vx: now.vx, vz: now.vz };
    const was = this.perceive(id, latency + READ.span), dt = now.t - was.t;
    const ax = dt > 1e-3 ? (now.vx - was.vx) / dt * k : 0, az = dt > 1e-3 ? (now.vz - was.vz) / dt * k : 0;
    // Only as long as the change keeps him moving the way he was going.
    const speed = Math.hypot(now.vx, now.vz), along = speed > 0.5 ? (ax * now.vx + az * now.vz) / speed : 0;
    const t = along < 0 ? Math.min(lag, speed / -along) : lag;
    return { t: now.t, x: now.x + now.vx * lag + 0.5 * ax * t * t, z: now.z + now.vz * lag + 0.5 * az * t * t, vx: now.vx + ax * t, vz: now.vz + az * t };
  },

  // Near the goal line a man on a receiver short of it plays on the goal-line
  // side of him (GOAL), so a catch is stopped short. Changes `target`.
  goalSide(r, target) {
    if (r.z > GOAL.line - GOAL.near && r.z < GOAL.line) target.z = Math.max(target.z, r.z + GOAL.side);
    return target;
  },

  // `yards` from a receiver toward the quarterback: a spot in the throwing lane.
  laneOffset(r, yards) {
    const qb = this.byId.QB;
    return scaled(qb.x - r.x, qb.z - r.z, yards);
  },

  // Until he opens his hips, a coverage defender faces the quarterback, so
  // moving away from him is a slower backpedal and sideways a shuffle; a man
  // rotating a long way from his pre-snap look runs a crossover instead.
  backpedalLimit(d, want) {
    if (d.turned) return want;
    const speed = Math.hypot(want.x, want.z);
    if (speed < 0.5) return want;
    const away = -(want.x * Math.sin(d.facing) + want.z * Math.cos(d.facing)) / speed;
    // A deep zone defender bails: a crossover run to depth, eyes inside.
    const rotating = d.assign?.kind === 'deep' || (d.rotate?.crossover && this.time < d.rotate.at + ROTATE.window);
    const share = away > 0.17 ? (rotating ? ROTATE.back : BACKPEDAL_SPEED) : away > -0.5 ? (rotating ? ROTATE.side : SHUFFLE_SPEED) : 1;
    const cap = speedCap(d) * share;
    return speed > cap ? scaled(want.x, want.z, cap) : want;
  },

  // Flip and run once a receiver eats the cushion going vertical; flipping
  // out of a backpedal costs a quarter second of grip.
  // A vertical far to his side also makes him open up and run to it.
  readThreat(d, threat) {
    const threatened = threat && threat.vz > 4 && (threat.z > d.z - CUSHION || (Math.abs(threat.x - d.x) > WIDE_THREAT && threat.z > d.z - 16));
    if (threatened || d.z - d.start.z > MAX_BACKPEDAL) this.turnHips(d);
  },

  turnHips(d) {
    if (d.turned) return;
    d.turned = true;
    if (d.backpedal) d.flip = FLIP_TIME;
  },

  // Track a pass only after actually seeing it. A trailing man defender can
  // notice his receiver looking back, but needs extra time to locate the ball.
  // Turning away from the quarterback is therefore a real coverage tradeoff
  // for a man defender; a zone defender runs with his head turned to the
  // quarterback and sees the ball over his shoulder (EYES).
  readPass(d, dt) {
    if (d.engaged || ['stumble', 'tackle', 'down'].includes(d.action)) return;
    const dx = this.ball.x - d.x, dz = this.ball.z - d.z, gap = Math.hypot(dx, dz);
    const cone = d.assign && d.assign.kind !== 'man' ? EYES.zone : EYES.man;
    const visible = gap < 0.1 || (dx * Math.sin(d.facing) + dz * Math.cos(d.facing)) / gap > cone;
    const receiver = this.byId[this.pass.receiver];
    const receiverCue = this.pass.elapsed > 0.16 && receiver && dist(d, receiver) < 2.8;
    if (visible || receiverCue || d.ballAware) {
      d.ballRead += dt;
      if (d.ballRead >= this.skill.ballReaction + (visible ? 0 : 0.16)) d.ballAware = true;
      if (d.ballAware && visible) d.ballSightAt = this.time;
    } else d.ballRead = Math.max(0, d.ballRead - dt);
  },

  // Breaking on the ball: the flight as he reads it (readFlight), sampled
  // every BREAK.step s. He takes the earliest point where the ball will be
  // catchable that he can reach before it does and waits there, to play the
  // ball before the receiver's hands; with none in reach he runs through the
  // catch point. Too far to get there with the ball, he rallies to where the
  // catch will be run. Null when the pass comes down out of his range.
  breakOnBall(d, flight) {
    const b = this.ball, cap = speedCap(d), T = flight.remaining, end = flight.target;
    // The side the ball comes in on, and the receiver running under it (the
    // one whose line takes him nearest to where it comes down), as the
    // coverage reads the receivers (planCoverage, DIFFICULTY.read late).
    const bx = b.x - end.x, bz = b.z - end.z, bl = Math.hypot(bx, bz) || 1, fx = bx / bl * BREAK.front, fz = bz / bl * BREAK.front;
    let under = null, best = BREAK.mark;
    for (const id of RECEIVERS) {
      const r = this.coverSeen?.[id] || (this.byId[id] && this.estimate(id, d.latency));
      if (!r) continue;
      const g = Math.hypot(r.x + r.vx * T - end.x, r.z + r.vz * T - end.z);
      if (g < best) { best = g; under = r; }
    }
    // On him: stay in phase on the side the ball comes in on and play it
    // through his hands, rather than racing him to the spot.
    if (under && dist(d, under) < BREAK.phase) return trackWant(d, { x: under.x + fx, z: under.z + fz }, { x: under.vx, z: under.vz }, cap);
    const ex = end.x - (b.x + b.vx * T), ez = end.z - (b.z + b.vz * T);
    const sx = d.x + d.vx * BREAK.turn, sz = d.z + d.vz * BREAK.turn;
    for (let t = BREAK.step; t < T + BREAK.step - 1e-9; t += BREAK.step) {
      const u = Math.min(t, T), y = b.y + b.vy * u - 0.5 * GRAVITY * u * u;
      if (y < BREAK.low || y > BREAK.high) continue;
      const x = b.x + b.vx * u + ex * u / T, z = b.z + b.vz * u + ez * u / T;
      if (Math.hypot(x - sx, z - sz) <= cap * Math.max(0, u - BREAK.turn) + BREAK.reach) return seekWant(d, { x, z }, cap);
    }
    const far = dist(d, end);
    // Through the receiver's hands from the side the ball comes in on.
    if (far <= Math.min(BREAK.far, cap * T + BREAK.near)) return seekWant(d, { x: end.x + fx, z: end.z + fz }, cap, cap);
    if (far > BREAK.rally) return null;
    // Rallying: the catch point carried on along the line of the receiver
    // under it for the rest of the way.
    const lead = under ? clamp(far / cap - T, 0, BREAK.lead) : 0;
    return scaled(end.x + (under ? under.vx : 0) * lead - d.x, end.z + (under ? under.vz : 0) * lead - d.z, cap);
  },

  readFlight(d) {
    const b = this.ball;
    const remaining = clamp((b.vy + Math.sqrt(Math.max(0, b.vy * b.vy + 2 * GRAVITY * (b.y - 1.6)))) / GRAVITY, 0.05, 3);
    // Early reads have some depth/width error; watching the flight refines it.
    // The fixed per-player bias consumes no random draws and cannot reveal a
    // route or the throw's intended receiver/landing coordinate. It is in the
    // play's frame, so a flipped play is misread as the mirror image.
    const error = this.skill.judgment * Math.min(1, remaining) / (1 + d.ballRead * 2);
    const angle = d.number * 2.399963;
    return { remaining, target: { x: b.x + b.vx * remaining + Math.sin(angle) * error * this.playSide(), z: b.z + b.vz * remaining + Math.cos(angle) * error } };
  },
};
