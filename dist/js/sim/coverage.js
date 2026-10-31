// Pass coverage: the per-step defensive dispatch, pattern-matching zones,
// man technique, hip flips and reading the ball in the air.
import { RECEIVERS } from '../plays.js';
import { STEP, DEG, clamp, dist, ZERO, scaled, seekWant, trackWant, meetWant, speedCap, GET_OFF, PULL_UP } from './common.js';
import { MAN } from './defense.js';

const GRAVITY = 10.73;
const FLIP_TIME = 0.25;                // lateral grip is halved while flipping
const BACKPEDAL_SPEED = 0.65;          // share of top speed, moving away from facing
const CUSHION = 3;                     // yards a receiver may close before the flip
const MAX_BACKPEDAL = 7;               // yards of backpedal before a back must open up
const WIDE_THREAT = 5;                 // yards across to a vertical that also turns him
const SHUFFLE_SPEED = 0.88;

// Zone landmarks [x, depth past the line] for defenders 4..10. A landmark
// deeper than 20 yd is a deep zone. Cover 3: curl/flat, two hooks and the
// strong safety's curl/flat underneath, three deep thirds. Cover 2: two hooks,
// the middle hole and the corners' flats underneath, two deep halves.
const ZONES = {
  cover3: [[-13, 7], [-4, 9], [5, 9], [-19, 23], [19, 23], [0, 26], [13, 7]],
  cover2: [[-8, 11], [0, 12], [8, 11], [-23, 5], [23, 5], [-12, 25], [12, 25]],
};
// Pattern-matching zones (see planCoverage). Yards and yards past the line.
const COVER = {
  window: 8.5, stick: 2,   // an underneath man matches within `window` yd across his landmark; his own man gets `stick` yd more room and is `stick` yd cheaper
  flat: 3,                 // a curl/flat man takes a receiver in his flat first: `flat` yd cheaper
  carryAt: 7,              // a matched receiver going upfield past this depth is carried like man coverage
  vertical: 6, deep: 15,   // a deep threat: past `vertical` yd and going upfield, or past `deep` yd
  split: 12,               // Cover 3 deep thirds split this far either side of the ball, so the middle owns the seams
  top: 1, over: 8, topWidth: 4,  // a deep man is on top: `top` to `over` yd deeper and within `topWidth` yd across
  close: 3,                // a carrier or man defender within this of his receiver counts as help
  cushion: 1, cushionSpeed: 0.1, floor: 8,  // on top: `cushion` + `cushionSpeed` × his speed deeper, never shallower than `floor`
  reach: 14, open: 2.5, keep: 1.5,  // help: the most open man within `reach` yd (open: no other defender within `open`), keeping his choice by `keep` yd
  shade: 0.35,             // an empty deep zone shades this share of the way toward the vertical beside it
};

export const coverage = {
  planDefense(dt = STEP) {
    const pursuit = this.phase === 'run' || this.phase === 'tackle' || this.crossedLine || (this.play.type === 'run' && this.time > 0.8);
    this.defense.forEach((d, i) => {
      d.sprinting = true;
      if (this.phase === 'air') this.readPass(d, dt);
      if (this.phase === 'tackle' && d.id === this.tackle.tackler) return;
      if (this.phase === 'tackle' && this.tackle.helpers.has(d.id)) {
        const c = this.byId[this.carrier];
        d.want = { x: c.vx, z: c.vz };
        return;
      }
      if (this.time < GET_OFF[d.role]) { d.want = ZERO; return; }
      if (d.engaged) { this.drivePast(d); return; }
      if (this.phase === 'tackle' && dist(d, this.byId[this.carrier]) >= PULL_UP.pileOn) { d.want = this.pullUpWant(d); return; }
      if (pursuit) { this.turnHips(d); d.want = this.pursue(d, this.carrier || 'R', speedCap(d), 0, d.leverage); return; }
      if (d.rushing) { d.want = this.rushWant(d); return; }
      const cover = this.cover(d);
      if (this.phase === 'air' && d.ballAware) {
        const flight = this.readFlight(d);
        // Stay in coverage when the pass is elsewhere. The read is an estimate
        // from the visible ball, not access to the quarterback's chosen target.
        if (dist(d, flight.target) < Math.min(15, d.top * flight.remaining + 3)) {
          this.turnHips(d);
          // Brake into the spot: arrive under control instead of running past it.
          const want = meetWant(d, flight.target, flight.remaining, speedCap(d));
          d.want = scaled(want.x, want.z, Math.min(Math.hypot(want.x, want.z), Math.sqrt(1.6 * d.brake * dist(d, flight.target))));
          return;
        }
      }
      if (!d.turned) this.readThreat(d, cover.threat);
      d.want = this.backpedalLimit(d, cover.want);
    });
  },

  // Pattern-matching coverage, planned once a step for every coverage
  // defender from the receivers as the defense sees them (`latency` seconds
  // late, carried forward), so difficulty still works through reaction time.
  // Each defender gets a `job` (see cover):
  //   man    trail one receiver: man coverage, or a vertical he carries;
  //   zone   sit on the receiver he matched in his underneath zone;
  //   top    stay on top of the one deep threat in his deep zone;
  //   split  midpoint two deep threats, leaning to the one nobody carries;
  //   lean   move from an anchor toward an open man or a nearby vertical;
  //   spot   hold his landmark.
  // Deep men own every vertical in their zone. Underneath men are matched
  // one receiver each, nearest landmark first, keeping last step's man unless
  // another is clearly nearer. A matched receiver who goes upfield is carried
  // until a deep man has him (or past the difficulty's carry depth); only then
  // is he handed off. A man with nobody to match helps on the open receiver.
  planCoverage() {
    this.coverPlanAt = this.time;
    const spot = this.spot, skill = this.skill, flip = this.config.flip ? -1 : 1;
    const seen = this.coverSeen = {};
    for (const id of RECEIVERS) if (!this.byId[id].pickup && this.carrier !== id) seen[id] = this.estimate(id, skill.latency);
    const ids = Object.keys(seen), order = id => RECEIVERS.indexOf(id);
    const upfield = r => r.vz > 2.5 && r.vz > Math.abs(r.vx) * 0.8;
    const men = [], deeps = [], unders = [];
    const manIds = this.coverage === 'blitz' ? MAN.blitz : MAN.base;
    this.defense.forEach((d, i) => {
      if (d.rushing) return;
      if (this.coverage === 'blitz' || (this.coverage === 'man' && i < 9)) { men.push({ d, id: manIds[i - 4] }); return; }
      let x, depth;
      if (this.coverage === 'man') [x, depth] = [i === 9 ? -12 : 12, 24];
      else [x, depth] = (ZONES[this.coverage] || ZONES.cover3)[i - 4];
      const zone = { d, x: x * flip, z: Math.min(115, spot + depth), depth, job: null };
      (depth > 20 ? deeps : unders).push(zone);
    });
    // A receiver is carried (by an underneath man last step, or manned) when
    // his man is within `close` yd of him.
    const near = (d, id) => dist(d, seen[id]) < COVER.close;
    const carried = id => unders.some(u => u.d.carrying && u.d.match === id && near(u.d, id)) || men.some(m => m.id === id && near(m.d, id));

    // Deep zones: thirds (split wide, so the middle owns the seams) or halves.
    // A vertical stays with last step's deep man while within 2 yd of his zone.
    // Zones and their edges are in the play's own frame (x × flip), so a
    // flipped play is covered as the mirror image of the same call.
    deeps.sort((a, b) => (a.x - b.x) * flip);
    const edges = deeps.length === 3 ? [-COVER.split, COVER.split] : deeps.length === 2 ? [0] : [];
    deeps.forEach((z, k) => { z.lo = k ? edges[k - 1] : -Infinity; z.hi = k < edges.length ? edges[k] : Infinity; z.threats = []; });
    // A deep threat stays one while he is still going upfield near that depth.
    const wasDeep = id => deeps.some(z => z.d.job?.threats?.includes(id));
    const vertical = (r, id) => r.z > spot + COVER.deep || (r.z > spot + COVER.vertical && upfield(r)) || (wasDeep(id) && r.z > spot + COVER.vertical - 1 && r.vz > 0);
    for (const id of ids) {
      const r = seen[id];
      if (!vertical(r, id)) continue;
      const x = r.x * flip;
      const owner = deeps.find(z => z.d.job?.threats?.includes(id) && x > z.lo - 2 && x < z.hi + 2) || deeps.find(z => x >= z.lo && x < z.hi);
      if (owner) owner.threats.push(id);
    }
    for (const z of deeps) {
      const prev = z.d.job?.threats || [];
      const danger = id => seen[id].z + 0.5 * Math.max(0, seen[id].vz) + (prev.slice(0, 2).includes(id) ? 2 : 0);
      const threats = z.threats.sort((a, b) => danger(b) - danger(a) || order(a) - order(b));
      if (threats.length === 1) z.job = { kind: 'top', id: threats[0], primary: threats[0] };
      else if (threats.length > 1) {
        // Two verticals: midpoint them, leaning to the one nobody else has.
        const [a, b] = threats, ca = carried(a), cb = carried(b), w = ca === cb ? 0.5 : ca ? 0.2 : 0.8;
        z.job = { kind: 'split', a, b, w, primary: w > 0.75 ? a : w < 0.25 ? b : null };
      }
      if (z.job) z.job.threats = threats;
    }
    // A deep man has a receiver when he is assigned to him alone and on top
    // of him: deeper by `top` to `over` yd and within `topWidth` across.
    const onTop = (d, r, width) => d.z > r.z + COVER.top && d.z < r.z + COVER.over && Math.abs(d.x - r.x) < width;
    const deepHas = id => deeps.some(z => z.job?.primary === id && onTop(z.d, seen[id], COVER.topWidth));

    // Underneath: carries first. A carry ends when a deep man has the
    // receiver, past the carry depth, or (a curl/flat defender sinking with a
    // vertical with a deep man over it) when a receiver shows in his flat; it
    // becomes a plain match when the receiver settles back underneath.
    const deepOver = id => deeps.some(z => z.threats.includes(id) && onTop(z.d, seen[id], 2 * COVER.topWidth));
    const outside = u => Math.abs(u.x) >= 12 && u.depth <= 8;
    const inFlat = (u, r) => Math.sign(r.x) === Math.sign(u.x) && Math.abs(r.x) > Math.abs(u.x) - 5 && r.z < spot + 6 && r.z > spot - 2;
    const taken = new Set();
    for (const u of unders) {
      const d = u.d, r = seen[d.match];
      if (d.handed && (!seen[d.handed] || seen[d.handed].z < spot + COVER.carryAt - 1)) d.handed = null;
      if (!r) { d.match = null; d.carrying = false; continue; }
      if (!d.carrying) continue;
      const flat = outside(u) && r.z > spot + 8 && deepOver(d.match) && ids.some(id => id !== d.match && inFlat(u, seen[id]));
      if (deepHas(d.match) || r.z > spot + skill.carry || flat) { d.handed = d.match; d.match = null; d.carrying = false; }
      else if (!upfield(r) && r.z < spot + COVER.carryAt) d.carrying = false;
      else taken.add(d.match);
    }
    const pairs = [];
    for (const u of unders) {
      const d = u.d;
      if (d.carrying) continue;
      for (const id of ids) {
        const r = seen[id], mine = d.match === id;
        if (taken.has(id) || id === d.handed || r.z < spot - 2 || Math.abs(r.x - u.x) > COVER.window + (mine ? COVER.stick : 0)) continue;
        if (!mine && (r.z > spot + Math.min(skill.carry, 18) || (r.z > spot + COVER.carryAt && deepHas(id)))) continue;
        // A curl/flat defender takes the flat first; the hooks wall the inside.
        pairs.push({ u, id, cost: Math.hypot(r.x - u.x, r.z - u.z) - (mine ? COVER.stick : 0) - (outside(u) && inFlat(u, r) ? COVER.flat : 0) });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost || unders.indexOf(a.u) - unders.indexOf(b.u) || order(a.id) - order(b.id));
    const matched = new Set();
    for (const { u, id } of pairs) if (!matched.has(u) && !taken.has(id)) { matched.add(u); taken.add(id); u.d.match = id; }
    for (const u of unders) {
      const d = u.d;
      if (!d.carrying && !matched.has(u)) d.match = null;
      const r = seen[d.match];
      if (r && !d.carrying && upfield(r) && r.z > spot + COVER.carryAt) d.carrying = true;
      if (d.match) u.job = { kind: d.carrying ? 'man' : 'zone', id: d.match, x: u.x, z: u.z };
    }

    // Help. Each receiver's coverage gap is the distance to the nearest other
    // coverage defender; a free man leans toward the most open one in reach,
    // keeping last step's choice unless another is clearly more open.
    const coverers = this.defense.filter(d => !d.rushing && !d.engaged && d.action !== 'stumble');
    const openMan = (d, minDepth, where = () => true) => {
      let best = null, score = COVER.open;
      for (const id of ids) {
        const r = seen[id];
        if (r.z < spot + minDepth || dist(d, r) > COVER.reach || !where(r)) continue;
        let gap = Infinity;
        for (const q of coverers) if (q !== d) gap = Math.min(gap, dist(q, r));
        if (d.helpOn === id) gap += COVER.keep;
        if (gap > score) { score = gap; best = id; }
      }
      return (d.helpOn = best);
    };
    for (const u of unders) {
      if (u.job) continue;
      const id = openMan(u.d, 1);
      u.job = id ? { kind: 'lean', id, w: skill.help, x: u.x, z: u.z, lo: spot + 2, hi: spot + 16 } : { kind: 'spot', x: u.x, z: u.z };
    }
    for (const z of deeps) {
      if (z.job) continue;
      // An empty deep zone: squeeze an open man underneath in it (a corner
      // sinking on a hitch), else shade toward the nearest vertical beside
      // it, else help on any open man near him. He stays deeper than his man.
      const own = openMan(z.d, 1, r => r.x * flip >= z.lo && r.x * flip < z.hi);
      if (own) { z.job = { kind: 'lean', id: own, w: skill.help, x: z.x, z: z.z, lo: spot + 4, hi: 115, over: true }; continue; }
      // Ties go to the first in play-frame order, the same on a flipped play.
      let beside = null;
      for (const other of deeps) for (const id of other.threats) if (!beside || Math.abs(seen[id].x - z.x) < Math.abs(seen[beside].x - z.x)) beside = id;
      if (beside) { z.job = { kind: 'lean', id: beside, w: COVER.shade, x: z.x, z: z.z, lo: z.z, hi: 115, over: true }; continue; }
      const id = openMan(z.d, 1);
      z.job = id ? { kind: 'lean', id, w: skill.help, x: z.x, z: z.z, lo: spot + 4, hi: 115, over: true } : { kind: 'spot', x: z.x, z: z.z };
    }
    // Man coverage. A man whose receiver stays in to block is free: he robs
    // the shallow middle and doubles the most open man near him.
    for (const m of men) {
      if (seen[m.id]) { m.job = { kind: 'man', id: m.id }; continue; }
      const x = this.pocketX(), z = spot + 7, id = openMan(m.d, 1);
      m.job = id ? { kind: 'lean', id, w: Math.max(skill.help, 0.5), x, z, lo: spot + 3, hi: spot + 12 } : { kind: 'spot', x, z };
    }
    for (const c of [...men, ...deeps, ...unders]) { if (c.x !== undefined) { c.job.x ??= c.x; c.job.z ??= c.z; } c.d.job = c.job; }
  },

  // Coverage movement for one defender's job (planCoverage). Returns the
  // wanted velocity and the receiver who threatens him (for the hip flip).
  cover(d) {
    if (this.coverPlanAt !== this.time || !d.job) this.planCoverage();
    const cap = speedCap(d), job = d.job, seen = this.coverSeen, spot = this.spot;
    const r = job && job.id ? seen[job.id] : null;
    if (!job || (job.kind !== 'split' && job.kind !== 'spot' && !r)) return { want: ZERO, threat: null };
    if (job.kind === 'man') {
      const lead = this.skill.routeLead, target = { x: r.x + r.vx * lead, z: r.z + 1.2 + r.vz * lead };
      return { want: trackWant(d, target, { x: r.vx, z: r.vz }, cap), threat: r };
    }
    if (job.kind === 'top') {
      // Stay on top: deeper than the receiver by a cushion that grows with his
      // speed, matching his vertical speed instead of waiting at the landmark.
      const target = { x: job.x * 0.15 + r.x * 0.85, z: Math.max(Math.min(job.z, spot + COVER.floor), r.z + COVER.cushion + Math.max(0, r.vz) * COVER.cushionSpeed) };
      const ahead = r.z > d.z - 8 ? Math.max(0, r.vz) : 0;
      return { want: trackWant(d, target, { x: r.vx * 0.72, z: ahead }, cap, 1.6), threat: r };
    }
    if (job.kind === 'split') {
      const a = seen[job.a], b = seen[job.b], w = job.w, deeper = a.z > b.z ? a : b;
      const target = { x: job.x * 0.15 + (w * a.x + (1 - w) * b.x) * 0.85, z: Math.max(Math.min(job.z, spot + COVER.floor), deeper.z + COVER.cushion + Math.max(0, deeper.vz) * COVER.cushionSpeed) };
      const ahead = deeper.z > d.z - 8 ? Math.max(0, deeper.vz) : 0;
      return { want: trackWant(d, target, { x: (w * a.vx + (1 - w) * b.vx) * 0.85, z: ahead }, cap, 1.6), threat: deeper };
    }
    if (job.kind === 'zone') {
      const target = { x: job.x * 0.15 + r.x * 0.85, z: clamp(r.z + 1, spot + 2, spot + 16) };
      return { want: seekWant(d, target, cap), threat: r };
    }
    if (job.kind === 'lean') {
      // A point between the anchor and where the receiver is heading; a deep
      // man stays deeper than him.
      const ax = r.x + r.vx * 0.3, az = r.z + r.vz * 0.3;
      let z = clamp(job.z + (az - job.z) * job.w, job.lo, job.hi);
      if (job.over) z = Math.max(z, r.z + 2);
      return { want: seekWant(d, { x: job.x + (ax - job.x) * job.w, z: Math.min(115, z) }, cap), threat: r };
    }
    return { want: seekWant(d, { x: job.x, z: job.z }, cap), threat: null };
  },

  // Until he opens his hips, a coverage defender faces the quarterback, so
  // moving away from him is a slower backpedal and sideways a shuffle.
  backpedalLimit(d, want) {
    if (d.turned) return want;
    const speed = Math.hypot(want.x, want.z);
    if (speed < 0.5) return want;
    const away = -(want.x * Math.sin(d.facing) + want.z * Math.cos(d.facing)) / speed;
    const share = away > 0.17 ? BACKPEDAL_SPEED : away > -0.5 ? SHUFFLE_SPEED : 1;
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
  // Turning away from the quarterback is therefore a real coverage tradeoff.
  readPass(d, dt) {
    if (d.engaged || ['stumble', 'tackle', 'down'].includes(d.action)) return;
    const dx = this.ball.x - d.x, dz = this.ball.z - d.z, gap = Math.hypot(dx, dz);
    const visible = gap < 0.1 || (dx * Math.sin(d.facing) + dz * Math.cos(d.facing)) / gap > -0.34;
    const receiver = this.byId[this.pass.receiver];
    const receiverCue = this.pass.elapsed > 0.16 && receiver && dist(d, receiver) < 2.8;
    if (visible || receiverCue || d.ballAware) {
      d.ballRead += dt;
      if (d.ballRead >= this.skill.ballReaction + (visible ? 0 : 0.16)) d.ballAware = true;
      if (d.ballAware && visible) d.ballSightAt = this.time;
    } else d.ballRead = Math.max(0, d.ballRead - dt);
  },

  readFlight(d) {
    const b = this.ball;
    const remaining = clamp((b.vy + Math.sqrt(Math.max(0, b.vy * b.vy + 2 * GRAVITY * (b.y - 1.6)))) / GRAVITY, 0.05, 3);
    // Early reads have some depth/width error; watching the flight refines it.
    // The fixed per-player bias consumes no random draws and cannot reveal a
    // route or the throw's intended receiver/landing coordinate.
    const error = this.skill.judgment * Math.min(1, remaining) / (1 + d.ballRead * 2);
    const angle = d.number * 2.399963;
    return { remaining, target: { x: b.x + b.vx * remaining + Math.sin(angle) * error, z: b.z + b.vz * remaining + Math.cos(angle) * error } };
  },
};
