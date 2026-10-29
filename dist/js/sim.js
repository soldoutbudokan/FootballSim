import { FORMATION, PLAYS, RECEIVERS, routeFor, hotRouteFor, formationFor, COVERAGES } from './plays.js';

// Units are yards and seconds. +z points downfield (own end line z = 0, goal
// lines at z = 10 and z = 110) and +x is the offense's right. A heading is
// atan2(vx, vz), so 0 faces downfield. Everything random comes from the seeded
// generator, so a seed and a sequence of inputs always replay the same rep.
export const STEP = 1 / 120, WIDTH = 53.333333, GOAL = 110, GRAVITY = 10.73;

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
const smoothstep = t => t * t * (3 - 2 * t);
const ZERO = Object.freeze({ x: 0, z: 0 });

export function seededRandom(seed = 12345) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function flightVelocity(from, to, time) {
  return {
    x: (to.x - from.x) / time,
    y: (to.y - from.y + 0.5 * GRAVITY * time * time) / time,
    z: (to.z - from.z) / time,
  };
}

export function nearestOnSegment(a, b, p) {
  const dx = b.x - a.x, dz = b.z - a.z, den = dx * dx + dz * dz;
  const t = den ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / den, 0, 1) : 0;
  return { x: a.x + dx * t, z: a.z + dz * t, y: a.y + (b.y - a.y) * t, t };
}

// ---------------------------------------------------------------------------
// Bodies (plan 4.1). Top speeds live on each player spec (`speed`, yards/s).
// zeroToTop is the time from a standing start to 99 % of top speed; brake and
// agility (sideways grip) are yards/s²; mass only matters in collisions.
//
// Acceleration along the direction of travel tapers as a0 × (1 − (v/top)²), so
// top speed is approached asymptotically: v(t) = top × tanh(a0 t / top). With
// a0 = atanh(0.99) × top / zeroToTop a receiver runs 10 yards in about 1.7 s
// and 40 in about 5.0 s at a 9.3 yd/s top speed (game speed in pads). The
// plan's 0.65 taper with the same table times would give 2.1 s ten-yard splits.
const BODY = {
  wr: { zeroToTop: 2.6, brake: 15, agility: 12, mass: 1.0 },
  cb: { zeroToTop: 2.6, brake: 15, agility: 12, mass: 1.0 },
  rb: { zeroToTop: 2.6, brake: 15, agility: 12, mass: 1.08 },
  s: { zeroToTop: 2.6, brake: 15, agility: 12, mass: 1.05 },
  te: { zeroToTop: 2.9, brake: 14, agility: 10, mass: 1.2 },
  lb: { zeroToTop: 2.9, brake: 14, agility: 10, mass: 1.18 },
  qb: { zeroToTop: 3.0, brake: 14, agility: 10, mass: 1.06 },
  ol: { zeroToTop: 3.4, brake: 12, agility: 7.5, mass: 1.45 },
  dl: { zeroToTop: 3.4, brake: 12, agility: 7.5, mass: 1.4 },
};
const TOP_REACH = Math.atanh(0.99);

const JOG = 0.8;                       // user speed without sprint, share of top
const CUT_ANGLE = 55 * DEG;            // sharper changes of direction plant first
const FULL_BRAKE_ANGLE = 120 * DEG;
const CUT_SPEED = 3;
const CUT_TIME = 0.2;
const PLANT_GRIP = 1.2;
const FACING_RATE = 9;                 // rad/s
const FLIP_RATE = 13;                  // a defensive back opening his hips
const FLIP_TIME = 0.25;                // lateral grip is halved while flipping
const BACKPEDAL_SPEED = 0.65;          // share of top speed, moving away from facing
const CUSHION = 3;                     // yards a receiver may close before the flip
const MAX_BACKPEDAL = 7;               // yards of backpedal before a back must open up
const WIDE_THREAT = 5;                 // yards across to a vertical that also turns him
const SHUFFLE_SPEED = 0.88;
const JUKE = { plant: 0.25, action: 0.45, keep: 0.65, cost: 0.05, minSpeed: 2 };
const SPRINT_DRAIN = 1 / 9;            // a full tank lasts nine seconds of sprinting
const RECOVERY = 0.12;
const REACH = 0.95;                    // tackling reach, yards
const DIVE_REACH = 1.7;                // a diving tackle from behind
const SHED_RANGE = 1.6, SHED_TIME = 0.3;  // a blocked man reads the ball carrier
const WRAP_KEEP = 0.8;
const TACKLE_DECEL = 12, GANG_DECEL = 6, TACKLE_HOLD = 0.9;
const STUMBLE_TIME = 0.7, STUMBLE_SPEED = 0.3, BROKEN_KEEP = 0.8;
// Pursuit leverage: each pursuer aims min..min+spread yards to his own side
// of the carrier's path (the side he lined up on), fading out between `far`
// and `near` yards from the carrier so he still closes to make the tackle;
// a defender in front of the runner takes only `front` of it. Pursuers
// arrive side by side instead of in single file.
const LEVERAGE = { min: 1.0, spread: 0.5, near: 2.5, far: 7, front: 0.25 };
// Once the carrier is wrapped up, pursuers who are not in on the tackle pull
// up: those within `reach` yards of their spot steer to it, radius..radius+
// spread yards from the carrier and fanned out to their own side; the rest
// ease off where they are, braking at brake..brake+brakeSpread of full, so
// they stop at varied spots. A defender already within `pileOn` yards keeps
// coming and can join the tackle.
const PULL_UP = { radius: 1.8, spread: 2.7, fan: 28 * DEG, flank: 55 * DEG, effort: 0.7, pileOn: 1.6, reach: 6, brake: 0.5, brakeSpread: 0.4 };
const BALL_REST = 0.1;                 // centre height of a ball lying on the turf
const CATCH_GRACE = 0.35;
const MESH_REACH = 1.25;               // QB to back, body centres, at the exchange              // a new carrier runs on through the catch
const GET_OFF = { ol: 0.06, qb: 0, rb: 0.1, wr: 0.18, te: 0.18, dl: 0.2, lb: 0.28, cb: 0.28, s: 0.28 };
const DIFFICULTY = {
  // Difficulty changes reads and anticipation, never bodies or catching odds.
  // `contain`: yards outside a scrambling quarterback the edge rusher on his
  // side keeps (rush lane discipline). `carry`: yards past the line where an
  // underneath defender gives up a vertical he is carrying when no deep man
  // has taken it. `help`: how far a defender with an empty zone leans toward
  // the most open receiver near him (share of the way from his landmark).
  rookie: { latency: 0.40, ballReaction: 0.42, judgment: 1.8, routeLead: 0.06, contain: 0.3, carry: 16, help: 0.2 },
  pro: { latency: 0.28, ballReaction: 0.28, judgment: 0.9, routeLead: 0.13, contain: 1.0, carry: 21, help: 0.45 },
  allpro: { latency: 0.18, ballReaction: 0.18, judgment: 0.35, routeLead: 0.20, contain: 1.5, carry: Infinity, help: 0.7 },
};
// Pass protection (the pocket). Tackles kick-slide back and out, guards and
// the centre set short (`kick` yd out, `depth` yd behind the line), and each
// blocker meets his rusher in the lane: the spot `square` yd from the rusher
// toward the quarterback, no more than `reach` yd either side of his set.
// A blocker within `engage` yd of a rusher, and nearer the quarterback than
// he is, locks up with him; a pair more than `part` yd apart comes unlocked.
// Locked, the rusher drives the blocker back at the matchup's push speed and
// wins the rep at a hazard rate of win × (t / ramp)³ per second, t the time
// since the snap, so pressure builds while the quarterback holds the ball.
// A spare lineman within `helpRange` yd scales it by `help`; a quarterback
// out of the pocket (`box` yd wide of the centre) or within `close` yd of the
// rusher adds `loose`. The winner rips past at `rip` yd/s, `slip` yd to the
// side he won for each yard toward the quarterback, then aims up to `lean`
// yd to that side of the quarterback for `burst` s. Nobody can pick him up
// for `clear` s, and the beaten blocker stumbles for `beaten` s. Ends lined
// up more than `edge` yd wide rush the arc (aiming `arc` yd outside the
// quarterback per yard still to go, at most `arcMax`); the others push the
// A and B gaps (within `gap` yd of the centre). The back checks for a free
// rusher until `pickup` s after the snap and blocks him if one comes; using
// him costs `backCost` yd in the protection count, so the line goes first.
const POCKET = {
  tackle: { kick: 0.9, depth: 2.0, reach: 2.4 }, guard: { kick: 0.15, depth: 1.2, reach: 2.2 }, centre: { kick: 0, depth: 1.1, reach: 2.4 },
  square: 0.95, engage: 1.3, part: 2.2, ramp: 2.5, help: 0.5, helpRange: 1.6, box: 4.4, close: 2, loose: 4,
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

const DEFENSE = [
  { id: 'DE1', number: 91, role: 'dl', x: -4.8, z: 1.2, speed: 7.2 },
  { id: 'DT1', number: 95, role: 'dl', x: -1.5, z: 1.2, speed: 6.9 },
  { id: 'DT2', number: 97, role: 'dl', x: 1.6, z: 1.2, speed: 6.8 },
  { id: 'DE2', number: 99, role: 'dl', x: 4.8, z: 1.2, speed: 7.2 },
  { id: 'LB1', number: 54, role: 'lb', x: -7, z: 5, speed: 8.4 },
  { id: 'LB2', number: 52, role: 'lb', x: 0, z: 6, speed: 8.2 },
  { id: 'LB3', number: 56, role: 'lb', x: 7, z: 5, speed: 8.3 },
  { id: 'CB1', number: 23, role: 'cb', x: -21, z: 6, speed: 9.3 },
  { id: 'CB2', number: 24, role: 'cb', x: 21, z: 6, speed: 9.3 },
  { id: 'FS', number: 31, role: 's', x: -9, z: 17, speed: 9.0 },
  { id: 'SS', number: 32, role: 's', x: 9, z: 17, speed: 8.9 },
];
const FRONTS = [
  { name: 'Even', x: [-4.8, -1.6, 1.6, 4.8] }, { name: 'Over', x: [-5.8, -2.8, 0.65, 4.2] },
  { name: 'Under', x: [-4.2, -0.65, 2.8, 5.8] }, { name: 'Wide 9', x: [-7, -2, 2, 7] },
];
// Man assignments for defenders 4..10 (LB1, LB2, LB3, CB1, CB2, FS, SS).
const MAN = {
  blitz: ['', '', 'Y', 'X', 'B', 'R', 'A'],
  base: ['Y', 'R', 'A', 'X', 'B', 'Y', 'A'],
};
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

function defensiveAlignment(coverage, front, random) {
  const support = {
    cover3: [[-9, 5], [-1, 6], [6, 5], [-21, 8], [21, 8], [0, 20], [10, 8]],
    cover2: [[-8, 5], [0, 6], [8, 5], [-22, 4], [22, 4], [-12, 18], [12, 18]],
    man: [[-10, 2.5], [-2, 4], [6.4, 2.5], [-21, 2], [21, 2], [-11, 20], [11, 20]],
    blitz: [[-2.7, 1.5], [2.7, 1.5], [-10, 2.5], [-21, 1.8], [21, 1.8], [-3.5, 4], [6.4, 2.5]],
  }[coverage];
  return DEFENSE.map((spec, i) => {
    const [x, z] = i < 4 ? [FRONTS[front].x[i], 1.2] : support[i - 4];
    return { ...spec, x: x + (random() - 0.5) * 0.8, z: Math.max(0.8, z + (random() - 0.5) * 0.7) };
  });
}

// Each defender's pursuit leverage and pull-up spot, varied by his index
// with low-discrepancy fractions (no random draws, so the seeded stream is
// unchanged). The side is the one he lined up on; the middle men alternate.
function assignPursuitAngles(d, k) {
  const f = (k * 0.618034) % 1, g = (k * 0.381966 + 0.2) % 1;
  const side = Math.abs(d.start.x) > 0.5 ? Math.sign(d.start.x) : (k % 2 ? 1 : -1);
  d.leverage = side * (LEVERAGE.min + LEVERAGE.spread * f);
  d.pullUp = {
    radius: PULL_UP.radius + PULL_UP.spread * g, fan: side * PULL_UP.fan * (0.4 + 0.6 * f),
    brake: PULL_UP.brake + PULL_UP.brakeSpread * f, mode: null, bearing: 0,
  };
}

function createPlayer(spec, team, spot, flip) {
  const body = BODY[spec.role];
  const x = flip ? -spec.x : spec.x, z = spot + spec.z, top = spec.speed;
  return {
    ...spec, team, x, z, y: 0, vx: 0, vz: 0,
    facing: team === 'offense' ? 0 : Math.PI,
    lean: 0, backpedal: false,
    route: [], routeIndex: 0, start: { x, z },
    stamina: 1, action: 'ready', actionTime: 0, engaged: null, shed: 0, phase: 0, ease: 1,
    // Physical model
    top, a0: TOP_REACH * top / body.zeroToTop, brake: body.brake, agility: body.agility, mass: body.mass,
    want: ZERO, sprinting: false, latAccel: 0,
    cutting: false, sinceCut: 9, lastMoveAt: -9, juke: null,
    // Coverage: `turned` is false while a defender still faces the quarterback.
    turned: team === 'offense', flip: 0,
    latency: 0, seen: null, aim: null, ballRead: 0, ballAware: false, ballSightAt: -9,
    // Pass protection: `lock` is the partner in a pass-rush rep (it outlasts
    // a step, unlike `engaged`); a rusher wins once `have` reaches `need`.
    lock: null, assignment: null, need: 0, have: 0, wonAt: -9, winSide: 0, beatenUntil: -9, pickup: null, released: false,
    // Zone coverage (planCoverage): `job` is this step's task, `match` the
    // receiver he has, `carrying` whether he runs with him upfield, `handed`
    // the vertical he passed to a deep man, `helpOn` the open man he leans to.
    job: null, match: null, carrying: false, handed: null, helpOn: null,
  };
}

// Recent positions of one player, so defenders can react to what they saw a
// moment ago instead of to the present.
class Trail {
  constructor(size = 72) {
    this.size = size; this.count = 0; this.head = -1;
    this.t = new Float64Array(size); this.x = new Float64Array(size); this.z = new Float64Array(size);
    this.vx = new Float64Array(size); this.vz = new Float64Array(size);
  }
  push(t, p) {
    this.head = (this.head + 1) % this.size;
    this.t[this.head] = t; this.x[this.head] = p.x; this.z[this.head] = p.z;
    this.vx[this.head] = p.vx; this.vz[this.head] = p.vz;
    this.count = Math.min(this.size, this.count + 1);
  }
  // Newest sample taken at or before `time` (the oldest one if none is).
  at(time) {
    let index = this.head;
    for (let n = 1; n < this.count && this.t[index] > time + 1e-9; n++) index = (index - 1 + this.size) % this.size;
    return { t: this.t[index], x: this.x[index], z: this.z[index], vx: this.vx[index], vz: this.vz[index] };
  }
}

// ---------------------------------------------------------------------------
// Momentum mover. The wanted velocity (wx, wz) is split along and across the
// current velocity. Along it, acceleration tapers toward top speed and braking
// is stronger; across it, the turn is limited by grip, so a fast player swings
// wide (radius v²/agility) unless he slows first. A sharp change of direction
// at speed becomes a plant: brake in proportion to the angle, turn while slow,
// then accelerate out. Returns true when this step starts such a cut.
function moveBody(p, wx, wz, dt, { brakeScale = 1 } = {}) {
  p.sinceCut += dt;
  if (p.juke) return jukeBody(p, dt);
  const fatigue = fatigueOf(p);
  const top = p.top * (1 - 0.12 * fatigue), a0 = p.a0 * (1 - 0.2 * fatigue);
  const speed = Math.hypot(p.vx, p.vz), want = Math.hypot(wx, wz);
  let fx, fz;
  if (speed > 0.3) { fx = p.vx / speed; fz = p.vz / speed; }
  else if (want > 1e-4) { fx = wx / want; fz = wz / want; }
  else { fx = Math.sin(p.facing); fz = Math.cos(p.facing); }
  const rx = fz, rz = -fx;
  const vAlong = p.vx * fx + p.vz * fz, vAcross = p.vx * rx + p.vz * rz;
  let dAlong = wx * fx + wz * fz - vAlong, dAcross = wx * rx + wz * rz - vAcross;
  // Sideways grip is the agility figure at top speed; slower, a player can
  // plant wider and harder, so his grip grows (up to 2.2x from a standstill).
  let lateral = p.agility * (p.flip > 0 ? 0.5 : 1) * (1 + PLANT_GRIP * Math.max(0, 1 - speed / top));
  const brake = p.brake * brakeScale;

  const angle = want > 1 && speed > 0.3 ? Math.acos(clamp((p.vx * wx + p.vz * wz) / (speed * want), -1, 1)) : 0;
  const cutting = angle > CUT_ANGLE && speed > CUT_SPEED;
  let started = false;
  if (cutting) {
    // Brake in proportion to the angle (fully from 120°); while still fast
    // the plant foot is braking, not turning.
    const level = clamp((angle - CUT_ANGLE) / (FULL_BRAKE_ANGLE - CUT_ANGLE), 0, 1);
    dAlong = Math.min(dAlong, -level * brake * dt);
    lateral *= 1 - 0.5 * level * clamp((speed - CUT_SPEED) / 3, 0, 1);
    started = !p.cutting && p.sinceCut > CUT_TIME;
    if (started) p.sinceCut = 0;
  }
  p.cutting = cutting;

  const accel = a0 * Math.max(0, 1 - (Math.max(0, vAlong) / top) ** 2);
  dAlong = dAlong > 0 ? Math.min(dAlong, accel * dt) : Math.max(dAlong, -brake * dt);
  dAcross = clamp(dAcross, -lateral * dt, lateral * dt);
  const dvx = fx * dAlong + rx * dAcross, dvz = fz * dAlong + rz * dAcross;
  p.vx += dvx; p.vz += dvz;
  p.latAccel = (dvx * Math.cos(p.facing) - dvz * Math.sin(p.facing)) / dt;
  integrate(p, dt);
  return started;
}

// A juke plant: over JUKE.plant seconds the velocity blends from what it was
// to the juke's exit velocity, so the carrier never teleports.
function jukeBody(p, dt) {
  const j = p.juke;
  const before = smoothstep(clamp(j.t / JUKE.plant, 0, 1));
  j.t += dt;
  const k = smoothstep(clamp(j.t / JUKE.plant, 0, 1));
  const vx = j.from.x + (j.to.x - j.from.x) * k, vz = j.from.z + (j.to.z - j.from.z) * k;
  const dvx = (j.to.x - j.from.x) * (k - before), dvz = (j.to.z - j.from.z) * (k - before);
  p.vx = vx; p.vz = vz;
  p.latAccel = (dvx * Math.cos(p.facing) - dvz * Math.sin(p.facing)) / dt;
  if (j.t >= JUKE.plant) p.juke = null;
  integrate(p, dt);
  return false;
}

function integrate(p, dt) {
  p.x += p.vx * dt; p.z += p.vz * dt;
  if (Math.abs(p.x) > 29) { p.x = clamp(p.x, -29, 29); p.vx = 0; }
  if (p.z < 0 || p.z > 120) { p.z = clamp(p.z, 0, 120); p.vz = 0; }
  p.phase += Math.hypot(p.vx, p.vz) * dt;
}

// 0 while fresh, rising to 1 as the tank empties below 60 %.
function fatigueOf(p) { return clamp((0.6 - p.stamina) / 0.6, 0, 1); }

function speedCap(p, effort = 1) {
  const cap = p.top * effort * (1 - 0.12 * fatigueOf(p));
  return p.action === 'stumble' ? cap * STUMBLE_SPEED : cap;
}

function scaled(x, z, speed) {
  const d = Math.hypot(x, z);
  return d > 1e-6 ? { x: x / d * speed, z: z / d * speed } : ZERO;
}

// Toward a point, slowing so the player stops on it (or passes at `exit`).
function seekWant(p, target, cap, exit = 0) {
  const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
  if (d < 0.05) return ZERO;
  return scaled(dx, dz, Math.min(cap, Math.sqrt(exit * exit + 1.6 * p.brake * d)));
}

// Match a moving target's velocity and close the gap to it.
function trackWant(p, target, velocity, cap, gain = 2.5) {
  const wx = velocity.x + (target.x - p.x) * gain, wz = velocity.z + (target.z - p.z) * gain;
  const speed = Math.hypot(wx, wz);
  return speed > cap ? scaled(wx, wz, cap) : { x: wx, z: wz };
}

// Arrive at `target` when the ball does, `timeLeft` seconds from now.
function meetWant(p, target, timeLeft, cap) {
  const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
  if (d < 0.25) return ZERO;
  return scaled(dx, dz, Math.min(cap, d / Math.max(0.15, timeLeft)));
}

// Lateral shade of a pursuit aim point: `leverage` yards along the normal of
// the carrier's path (as the defender saw it), oriented so + is toward +x,
// fading to nothing as the defender closes in.
function leverageOffset(seen, d, leverage) {
  if (!leverage) return ZERO;
  const speed = Math.hypot(seen.vx, seen.vz);
  let nx = 1, nz = 0, ux = 0, uz = 1;
  if (speed > 1) { ux = seen.vx / speed; uz = seen.vz / speed; nx = uz; nz = -ux; }
  if (nx < 0) { nx = -nx; nz = -nz; }
  const gap = Math.hypot(seen.x - d.x, seen.z - d.z);
  // Trailing pursuers take the full angle; a man in front of the runner only
  // shades it, so he still squares up to make the tackle.
  const ahead = gap > 1e-6 ? ((d.x - seen.x) * ux + (d.z - seen.z) * uz) / gap : 0;
  const share = ahead > 0 ? 1 - (1 - LEVERAGE.front) * Math.min(1, ahead * 2) : 1;
  const k = leverage * share * clamp((gap - LEVERAGE.near) / (LEVERAGE.far - LEVERAGE.near), 0, 1);
  return { x: nx * k, z: nz * k };
}

function project(a, b, p) {
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  if (len < 1e-6) return { x: b.x, z: b.z, along: 0, len: 0, ux: 0, uz: 0 };
  const ux = dx / len, uz = dz / len, along = clamp((p.x - a.x) * ux + (p.z - a.z) * uz, 0, len);
  return { x: a.x + ux * along, z: a.z + uz * along, along, len, ux, uz };
}

// 0 (straight on) to 180° (a comeback) between the legs a→b and b→c.
function breakAngle(a, b, c) {
  const ax = b.x - a.x, az = b.z - a.z, bx = c.x - b.x, bz = c.z - b.z;
  const den = Math.hypot(ax, az) * Math.hypot(bx, bz);
  return den < 1e-6 ? 0 : Math.acos(clamp((ax * bx + az * bz) / den, -1, 1));
}

// Route running (plan 4.2): stay on the line of the current leg, and arrive at
// each break at a speed set by its angle, clamp(1 − angle/180° × 0.9, 0.35, 1)
// of top speed, braking over the last (v² − exit²)/(2 × brake) yards. The cut
// itself is the mover's plant when the next leg pulls the wanted direction
// round. The last landmark is a spot to settle on.
const BREAK_RADIUS = 0.45;
function routeWant(p, cap) {
  const route = p.route;
  if (!route.length) return ZERO;
  let leg;
  for (;;) {
    const from = p.routeIndex ? route[p.routeIndex - 1] : p.start, to = route[p.routeIndex];
    leg = { from, to, ...project(from, to, p) };
    const last = p.routeIndex >= route.length - 1;
    if (last || (leg.len - leg.along > BREAK_RADIUS && dist(p, to) > BREAK_RADIUS)) break;
    p.routeIndex++;
  }
  const next = route[p.routeIndex + 1];
  const remaining = Math.max(0, leg.len - leg.along);
  if (!next && dist(p, leg.to) < 0.12) return ZERO;
  const exit = next ? cap * clamp(1 - breakAngle(leg.from, leg.to, next) / Math.PI * 0.9, 0.35, 1) : 0;
  const speed = Math.min(cap, Math.sqrt(exit * exit + 2 * p.brake * 0.85 * Math.max(0, remaining - (next ? BREAK_RADIUS : 0))));
  // Steer at a point a little ahead on the leg; it pulls a drifting runner
  // back onto the line without fighting his momentum.
  const look = Math.min(remaining, clamp(speed * 0.3, 0.8, 2.5));
  const aimX = leg.x + leg.ux * look, aimZ = leg.z + leg.uz * look;
  const dx = (leg.len ? aimX : leg.to.x) - p.x, dz = (leg.len ? aimZ : leg.to.z) - p.z;
  if (Math.hypot(dx, dz) < 0.05) return seekWant(p, leg.to, speed);
  return scaled(dx, dz, speed);
}

// ---------------------------------------------------------------------------
export class Simulation {
  constructor(seed = Date.now(), options = {}) {
    this.random = seededRandom(seed);
    this.config = { spot: 35, offense: 'random', coverage: 'random', difficulty: 'allpro', mode: 'drive', flip: false, ...options };
    this.stats = { reps: 0, attempts: 0, completions: 0, yards: 0, passing: 0, rushing: 0, td: 0, ints: 0, sacks: 0 };
    this.spot = clamp(Number(this.config.spot) || 35, 11, 105);
    this.down = 1; this.toGo = Math.min(10, GOAL - this.spot);
    this.play = PLAYS[0]; this.events = [];
    this.reset(true);
  }

  configure(options) {
    if (this.phase !== 'presnap' && this.phase !== 'dead') return false;
    Object.assign(this.config, options);
    this.config.spot = clamp(Number(this.config.spot) || 35, 11, 105);
    this.spot = this.config.spot; this.down = 1; this.toGo = Math.min(10, GOAL - this.spot);
    this.reset(true);
    return true;
  }

  selectPlay(id) {
    if (!['presnap', 'dead'].includes(this.phase) || (id !== 'random' && !PLAYS.some(p => p.id === id))) return false;
    this.config.offense = id;
    this.reset(true);
    return true;
  }

  reset(newCalls = false) {
    this.phase = 'presnap'; this.time = 0; this.deadTime = 0;
    this.pass = null; this.throwIntent = null; this.result = null;
    this.handoff = false; this.crossedLine = false; this.tackler = null; this.tackle = null; this.holder = null;
    this.selected = 'QB'; this.carrier = 'QB'; this.jukeCooldown = 0;
    this.recording = []; this.recordClock = 0;
    this.completed = false; this.threw = false; this.events = [];
    this.catchAt = 0; this.possessionAt = 0; this.coverPlanAt = -1; this.coverSeen = {};
    if (newCalls) {
      this.play = this.config.offense === 'random'
        ? PLAYS[Math.floor(this.random() * PLAYS.length)]
        : PLAYS.find(p => p.id === this.config.offense) || this.play;
      const cover = this.config.coverage;
      this.coverage = cover === 'random' ? ['cover3', 'cover2', 'man', 'blitz'][Math.floor(this.random() * 4)] : cover;
      const front = Math.floor(this.random() * FRONTS.length);
      this.defensiveFront = FRONTS[front].name;
      this.alignment = defensiveAlignment(this.coverage, front, this.random);
      this.hotRoutes = {}; this.audibled = false;
    }
    this.skill = DIFFICULTY[this.config.difficulty] || DIFFICULTY.pro;
    const flip = this.config.flip;
    const formation = formationFor(this.play);
    this.players = formation.map(p => createPlayer(p, 'offense', this.spot, flip));
    this.players.push(...this.alignment.map((p, i) => {
      let x = p.x, z = p.z;
      // Man defenders travel with their assignments when the offense changes
      // formation, including an audible. Keep the called front/safety shell.
      const ids = this.coverage === 'blitz' ? MAN.blitz : MAN.base;
      if (i >= COVERAGES[this.coverage].rushers && (this.coverage === 'blitz' || (this.coverage === 'man' && i < 9))) {
        const id = ids[i - 4], base = FORMATION.find(o => o.id === id), aligned = formation.find(o => o.id === id);
        if (base && aligned) { x += aligned.x - base.x; z = Math.max(1.2, z + aligned.z - base.z); }
      }
      return createPlayer({ ...p, x, z: Math.min(z, 118 - this.spot) }, 'defense', this.spot, flip);
    }));
    this.players.forEach(p => {
      p.shed = 2.5 + this.random() * 2.8;
      p.route = routeFor(this.effectivePlay, p.id, this.spot, flip);
      if (p.team === 'defense') p.latency = this.skill.latency;
    });
    this.byId = Object.fromEntries(this.players.map(p => [p.id, p]));
    this.offense = this.players.filter(p => p.team === 'offense');
    this.defense = this.players.filter(p => p.team === 'defense');
    this.defense.forEach(assignPursuitAngles);
    this.line = this.offense.filter(p => p.role === 'ol');
    this.trails = new Map(this.offense.map(p => [p.id, new Trail()]));
    this.ball = { x: 0, y: BALL_REST, z: this.spot, vx: 0, vy: 0, vz: 0 };
    this.lastBall = { ...this.ball };
    this.saveFrame();
  }

  get effectivePlay() {
    const hot = Object.fromEntries(Object.entries(this.hotRoutes).map(([id, kind]) => [id, hotRouteFor(id, kind, this.play)]));
    return { ...this.play, routes: { ...this.play.routes, ...hot } };
  }

  setHotRoute(id, kind) {
    if (this.phase !== 'presnap' || this.play.type === 'run' || !RECEIVERS.includes(id) || (kind !== 'default' && !hotRouteFor(id, kind, this.play))) return false;
    if (kind === 'default') delete this.hotRoutes[id]; else this.hotRoutes[id] = kind;
    this.byId[id].route = routeFor(this.effectivePlay, id, this.spot, this.config.flip);
    this.byId[id].routeIndex = 0;
    return true;
  }

  audible(id) {
    const play = PLAYS.find(p => p.id === id);
    if (this.phase !== 'presnap' || !play) return false;
    this.play = play; this.hotRoutes = {}; this.audibled = true;
    this.reset();
    return true;
  }

  snap() {
    if (this.phase !== 'presnap') return false;
    this.phase = 'live';
    this.events.push('snap');
    this.stats.reps++;
    return true;
  }

  requestThrow(id, style = 'bullet', lead = { x: 0, z: 0 }) {
    if (this.phase !== 'live' || this.carrier !== 'QB' || this.crossedLine || this.threw || this.throwIntent || this.play.type === 'run' || !RECEIVERS.includes(id) || this.time < 0.28) return false;
    if (this.play.type === 'pa' && this.time < 1.1) return false;
    this.throwIntent = {
      id, style: ['bullet', 'touch', 'lob'].includes(style) ? style : 'bullet',
      lead: { x: clamp(lead.x || 0, -1, 1), z: clamp(lead.z || 0, -1, 1) }, at: this.time + 0.23,
    };
    this.byId.QB.action = 'throw'; this.byId.QB.actionTime = 0.4;
    return true;
  }

  throwAway() {
    if (this.phase !== 'live' || this.carrier !== 'QB' || this.crossedLine || this.threw || this.time < 0.3) return false;
    this.stats.attempts++; this.threw = true;
    this.finish('Thrown away', 0, 'incomplete');
    return true;
  }

  // Where a receiver will be after `t` seconds if he keeps running his route:
  // a ghost copy runs the same route logic through the same momentum model.
  predict(p, t) {
    const ghost = { ...p, juke: null, want: ZERO };
    const n = Math.max(1, Math.round(t * 60)), dt = t / n;
    let clock = this.time;
    for (let i = 0; i < n; i++) {
      clock += dt;
      const want = clock < GET_OFF[ghost.role] ? ZERO : routeWant(ghost, speedCap(ghost));
      moveBody(ghost, want.x, want.z, dt);
    }
    return { x: ghost.x, z: ghost.z };
  }

  release() {
    const intent = this.throwIntent, p = this.byId[intent.id], qb = this.byId.QB;
    const speed = { bullet: 28, touch: 22, lob: 16 }[intent.style];
    let duration = clamp(dist(qb, p) / speed, 0.42, 2.8), target;
    for (let i = 0; i < 3; i++) {
      target = this.predict(p, duration);
      duration = clamp(dist(qb, target) / speed, 0.42, 2.8);
    }
    const nearest = Math.min(...this.defense.map(d => dist(d, qb)));
    const pressure = clamp((3.3 - nearest) / 2.7, 0, 1), moving = Math.hypot(qb.vx, qb.vz) / 7;
    const spread = 0.18 + moving * 1.6 + pressure * 2.8;
    target.x += intent.lead.x * 2.5 + (this.random() - 0.5) * spread;
    target.z += intent.lead.z * 2.5 + (this.random() - 0.5) * spread;
    target.x = clamp(target.x, -29, 29); target.z = clamp(target.z, 0, 119);
    // The ball leaves the throwing (right) hand, a little ahead of the body.
    const fx = Math.sin(qb.facing), fz = Math.cos(qb.facing);
    const from = { x: qb.x + fz * 0.25 + fx * 0.35, y: 1.85, z: qb.z - fx * 0.25 + fz * 0.35 };
    const to = { ...target, y: 1.6 }, v = flightVelocity(from, to, duration);
    this.ball = { ...from, vx: v.x, vy: v.y, vz: v.z };
    this.pass = { target: to, receiver: p.id, duration, elapsed: 0, style: intent.style, pressure, distance: Math.hypot(to.x - from.x, to.z - from.z), attempted: new Set() };
    this.threw = true; this.stats.attempts++; this.phase = 'air'; this.carrier = null; this.throwIntent = null;
    this.events.push('throw');
  }

  // A deliberate hard plant (plan 4.1). Momentum-consistent: forward speed
  // drops about 35 % and the sideways velocity becomes direction × (½v + 2.5)
  // over a quarter second. Jukes chain once the move is finished; each one
  // costs speed and a little stamina, but nothing ever refuses one for being
  // tired.
  juke(direction = 1) {
    if (!['live', 'run'].includes(this.phase) || this.jukeCooldown > 0) return false;
    const p = this.byId[this.carrier];
    if (!p || p.juke || (this.play.type === 'run' && !this.handoff)) return false;
    const speed = Math.hypot(p.vx, p.vz);
    if (speed <= JUKE.minSpeed) return false;
    const side = direction < 0 ? -1 : 1, fx = p.vx / speed, fz = p.vz / speed;
    const forward = speed * JUKE.keep, lateral = side * (0.5 * speed + 2.5);
    p.juke = { t: 0, from: { x: p.vx, z: p.vz }, to: { x: fx * forward + fz * lateral, z: fz * forward - fx * lateral } };
    p.action = 'juke'; p.actionTime = JUKE.action;
    p.stamina = Math.max(0, p.stamina - JUKE.cost);
    p.lastMoveAt = this.time; p.cutting = false;
    this.jukeCooldown = JUKE.action;
    this.events.push('juke');
    return true;
  }

  // A player as one defender perceives him: where he was `latency` seconds ago.
  perceive(id, latency) {
    const trail = this.trails.get(id), p = this.byId[id];
    if (!trail || !trail.count) return { t: this.time, x: p.x, z: p.z, vx: p.vx, vz: p.vz };
    return trail.at(this.time - latency);
  }

  // The defender's estimate of where that player is now: the delayed sample
  // carried forward at the velocity seen then. Right for steady running,
  // wrong for `latency` seconds after every cut or break.
  estimate(id, latency) {
    const seen = this.perceive(id, latency), lag = this.time - seen.t;
    return { t: seen.t, x: seen.x + seen.vx * lag, z: seen.z + seen.vz * lag, vx: seen.vx, vz: seen.vz };
  }

  // ---------------------------------------------------------------------------
  step(dt, input = {}) {
    if (this.phase === 'presnap') return;
    this.jukeCooldown = Math.max(0, this.jukeCooldown - dt);
    if (this.phase === 'dead') { this.stepDead(dt); return; }
    this.time += dt;
    this.tickActions(dt);
    if (this.phase !== 'tackle') this.planController(input);
    this.planBlocking(dt);
    this.planReceivers();
    this.planHandoff();
    this.planDefense(dt);
    this.moveAll(dt);
    if (this.phase === 'tackle') this.dragTackle(dt);
    this.separate();
    this.updateBodies(dt);
    if (this.carrier === 'QB' && this.byId.QB.z > this.spot + 0.3) this.crossedLine = true;
    this.recordTrails();
    if (this.throwIntent && this.time >= this.throwIntent.at) this.release();
    if (this.phase === 'air') this.flyBall(dt);
    this.checkCarrier();
    if (this.time > 22 && this.phase !== 'dead') this.endRep('Rep complete', 'timeout');
    this.recordClock += dt;
    if (this.recordClock >= 0.05) { this.recordClock -= 0.05; this.saveFrame(); }
  }

  tickActions(dt) {
    for (const p of this.players) {
      p.actionTime = Math.max(0, p.actionTime - dt);
      if (!p.actionTime && p.action !== 'wrapped') p.action = this.restingAction(p);
      p.engaged = null;
      p.want = ZERO; p.sprinting = false; p.ease = 1;
    }
  }

  // The action a player shows when nothing timed is going on.
  restingAction(p) {
    if (p.id !== this.carrier) return 'run';
    return p.id === 'QB' && !this.crossedLine ? 'run' : 'carry';
  }

  // The user steers the ball carrier: the stick sets a wanted velocity and the
  // momentum model does the rest, the same frame.
  planController(input) {
    const p = this.byId[this.carrier];
    if (!p || (this.play.type === 'run' && !this.handoff)) return;
    let x = input.x || 0, z = input.z || 0;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    const amount = Math.min(1, len), sprint = !!input.sprint;
    if (amount < 0.05 && p.id !== 'QB' && this.time - this.possessionAt < CATCH_GRACE) {
      p.want = { x: p.vx, z: p.vz }; p.sprinting = false;
      return;
    }
    p.want = amount > 0.01 ? scaled(x, z, speedCap(p, sprint ? 1 : JOG) * amount) : ZERO;
    p.sprinting = sprint && amount > 0.1;
    // An idle quarterback settles into a short drop after the snap.
    if (p.id === 'QB' && this.time < 0.6 && amount < 0.05) p.want = seekWant(p, { x: p.x, z: this.spot - 6.5 }, 0.5 * p.top);
  }

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
  }

  // A called pass while the quarterback still holds the ball behind the line
  // or has just let it go.
  inPocket() {
    return this.play.type !== 'run' && !this.pursuing() && (this.phase === 'live' || this.phase === 'air');
  }

  pursuing() {
    return this.phase === 'run' || this.phase === 'tackle' || this.crossedLine || (this.play.type === 'run' && this.time > 0.8);
  }

  rushers() { return this.defense.slice(0, COVERAGES[this.coverage].rushers); }

  pocketX() { return this.byId.C ? this.byId.C.start.x : 0; }

  // The quarterback has left the pocket sideways.
  scrambling() { return this.carrier === 'QB' && Math.abs(this.byId.QB.x - this.pocketX()) > POCKET.box; }

  // Where a rusher lined up: his side of the centre, and whether he is an end
  // outside the tackles.
  rushSide(d) {
    const off = d.start.x - this.pocketX();
    return { off, side: Math.sign(off) || 1, edge: Math.abs(off) > POCKET.edge };
  }

  matchup(o, d) {
    return o.role === 'rb' ? MATCHUP.back : this.rushSide(d).edge ? MATCHUP.edge : MATCHUP.inside;
  }

  // Where a lineman sets: tackles kick back and out, guards and centre short.
  setPoint(o) {
    const off = o.start.x - this.pocketX(), a = Math.abs(off);
    const set = a > 2.4 ? POCKET.tackle : a > 0.8 ? POCKET.guard : POCKET.centre;
    return { x: o.start.x + Math.sign(off) * set.kick, z: this.spot - set.depth, reach: set.reach };
  }

  // The spot between a rusher and the quarterback where a blocker squares up.
  squarePoint(d, extra = 0) {
    const qb = this.byId.QB, away = scaled(qb.x - d.x, qb.z - d.z, POCKET.square + extra);
    return { x: d.x + away.x, z: d.z + away.z };
  }

  // Pass protection. Pairs already locked fight it out first (contest); then
  // the free blockers (linemen who are neither locked nor beaten, and the
  // back while he checks) are matched to the free rushers (assignProtection)
  // and lock up with them on contact. A spare lineman picks up any free
  // rusher who comes within reach.
  protect(dt) {
    const rushers = this.rushers(), rb = this.byId.R;
    for (const d of rushers) if (d.lock) this.contest(this.byId[d.lock], d, dt);
    const catching = this.phase === 'air' && this.pass.receiver === 'R';
    if (catching && rb.lock) { this.byId[rb.lock].lock = null; rb.lock = null; }
    const back = rb.start.z < this.spot - 3 && this.carrier !== 'R' && !catching && !rb.released;
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
    // check he releases into his route for good.
    if (back && !rb.lock && !rb.assignment && this.time >= POCKET.pickup) rb.released = true;
    for (const o of this.line) this.passSet(o, rushers);
    if (back && (rb.lock || rb.assignment)) { this.passSet(rb, rushers); rb.pickup = rb.lock || rb.assignment; }
  }

  // One blocker's step in protection: locked, stay square between the rusher
  // and the quarterback, giving ground as the rusher pushes; assigned, meet
  // him in his lane from the set point; spare, sit behind the nearest block
  // ready to help; beaten, recover toward the quarterback.
  passSet(o, rushers) {
    o.sprinting = false;
    const back = o.role === 'rb', set = back ? null : this.setPoint(o);
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
    if (back) return;
    if (this.time < o.beatenUntil) { o.want = seekWant(o, { x: set.x, z: set.z - 0.6 }, speedCap(o, 0.7)); return; }
    let near = null;
    for (const q of rushers) if (!near || dist(q, set) < dist(near, set)) near = q;
    const behind = near && dist(near, set) < 4 ? this.squarePoint(near, 1) : set;
    o.want = seekWant(o, { x: clamp(behind.x, set.x - set.reach, set.x + set.reach), z: Math.min(set.z, behind.z) }, speedCap(o, 0.6));
  }

  // A blocker can only take on a rusher he is in front of (nearer the
  // quarterback): a beaten man must get back between them first.
  canLock(o, d) {
    const qb = this.byId.QB;
    return dist(o, d) < POCKET.engage && this.time - d.wonAt >= POCKET.clear && dist(o, qb) < dist(d, qb);
  }

  // Blocker and rusher lock up. The rusher draws how much pressure it takes
  // him to win this rep (an exponential threshold, so wins are spread in time
  // and fixed by the seed) and the side he will win on.
  lock(o, d) {
    o.lock = d.id; d.lock = o.id; o.assignment = d.id;
    const m = this.matchup(o, d), { side } = this.rushSide(d);
    d.need = -Math.log(1 - this.random()); d.have = 0;
    d.winSide = side * (this.random() < m.outside ? 1 : -1);
    d.vx *= 0.8; d.vz *= 0.8;
  }

  // A locked rep. Pressure builds with the time since the snap; a spare
  // lineman beside the block slows it, and a rusher at the quarterback or a
  // quarterback out of the pocket speeds it. The winner beats his blocker,
  // who stumbles and cannot block for a moment.
  contest(o, d, dt) {
    if (!o || dist(o, d) > POCKET.part) { if (o) o.lock = null; d.lock = null; return; }
    const qb = this.byId.QB, m = this.matchup(o, d);
    let rate = m.win * (this.time / POCKET.ramp) ** 3;
    if (this.line.some(h => h !== o && !h.lock && !h.assignment && this.time >= h.beatenUntil && dist(h, d) < POCKET.helpRange)) rate *= POCKET.help;
    if (this.scrambling() || dist(d, qb) < POCKET.close) rate += POCKET.loose;
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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  engage(a, b) {
    a.engaged = b.id; b.engaged = a.id;
    for (const p of [a, b]) if (!['stumble', 'tackle', 'catch'].includes(p.action)) { p.action = 'block'; p.actionTime = 0.1; }
  }

  // What blockers protect and engaged defenders drive toward.
  guardPoint() {
    const c = this.byId[this.carrier];
    if (c) return c;
    return this.byId.QB;
  }

  planReceivers() {
    const run = this.play.type === 'run';
    for (const id of RECEIVERS) {
      const p = this.byId[id];
      if (this.carrier === id) continue;
      p.sprinting = true;
      if (this.time < GET_OFF[p.role]) { p.want = ZERO; continue; }
      if (this.phase === 'air' && this.pass.receiver === id && this.pass.elapsed > 0.12) {
        p.want = meetWant(p, this.pass.target, (this.pass.duration || 0) - this.pass.elapsed, speedCap(p));
        continue;
      }
      // A back who picked up a blitzer stays in to block (see protect).
      if (p.pickup) { p.sprinting = false; continue; }
      // On runs, and once a pass is caught, the other receivers block.
      const blocking = (run && id !== 'R') || (this.completed && this.phase !== 'air');
      if (blocking && this.blockDownfield(p)) continue;
      p.want = routeWant(p, speedCap(p));
    }
  }

  // Receivers blocking: take the nearest defender in front of them.
  blockDownfield(p) {
    let defender = null, best = Infinity;
    for (const d of this.defense) if (d.z > p.z - 1 && d.action !== 'tackle' && dist(d, p) < best) { best = dist(d, p); defender = d; }
    if (!defender || best >= 3.5) return false;
    if (best < 1.2 && !defender.engaged && this.time < defender.shed + 0.9) this.engage(p, defender);
    const c = this.guardPoint(), away = scaled(c.x - defender.x, c.z - defender.z, 0.9);
    p.want = seekWant(p, { x: defender.x + away.x, z: defender.z + away.z }, speedCap(p, 0.9));
    return true;
  }

  // Run plays: the quarterback meets the back at the mesh and hands off.
  planHandoff() {
    if (this.play.type !== 'run' || this.handoff) return;
    const qb = this.byId.QB, rb = this.byId.R;
    // Step to where the back will be in a moment, an arm's length short of him.
    const ahead = { x: rb.x + rb.vx * 0.25, z: rb.z + rb.vz * 0.25 }, reach = scaled(qb.x - ahead.x, qb.z - ahead.z, 0.8);
    qb.want = seekWant(qb, { x: ahead.x + reach.x, z: ahead.z + reach.z }, 0.7 * qb.top);
    if (this.time > 0.4 && dist(qb, rb) < MESH_REACH) {
      this.handoff = true; this.carrier = 'R'; this.selected = 'R'; this.phase = 'run';
      this.possessionAt = this.time;
      rb.action = 'carry'; rb.actionTime = 0.3;
      this.events.push('handoff');
    }
  }

  planDefense(dt = STEP) {
    const pursuit = this.phase === 'run' || this.phase === 'tackle' || this.crossedLine || (this.play.type === 'run' && this.time > 0.8);
    const rushers = COVERAGES[this.coverage].rushers;
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
      if (i < rushers) {
        d.turned = true;
        // Rush lanes (rushShade); flat out once the quarterback scrambles.
        d.want = this.pursue(d, 'QB', speedCap(d, this.scrambling() ? 1 : 0.92), this.rushShade(d));
        return;
      }
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
  }

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
  }

  // Pursuit with reaction latency (plan 4.3): aim from where the target was
  // `latency` seconds ago, led along the velocity seen then toward an intercept,
  // with the total lookahead capped at 0.6 s. A cut is invisible to the
  // defender for `latency` seconds and his own momentum does the rest.
  // `leverage` (yards, signed: + toward +x) shades the aim to the defender's
  // side of the carrier's path while he is still far away (LEVERAGE).
  pursue(d, id, cap, edge = 0, leverage = 0) {
    const seen = this.perceive(id, d.latency);
    d.seen = seen;
    const qx = seen.x + seen.vx * d.latency - d.x, qz = seen.z + seen.vz * d.latency - d.z;
    const a = seen.vx * seen.vx + seen.vz * seen.vz - cap * cap, b = 2 * (qx * seen.vx + qz * seen.vz), c = qx * qx + qz * qz;
    let s = Infinity;
    if (Math.abs(a) < 1e-6) { if (b < 0) s = -c / b; }
    else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const r1 = (-b - Math.sqrt(disc)) / (2 * a), r2 = (-b + Math.sqrt(disc)) / (2 * a);
        s = Math.min(...[r1, r2].filter(r => r >= 0), Infinity);
      }
    }
    const lead = Math.min(d.latency + s, 0.6);
    const shade = leverageOffset(seen, d, leverage);
    d.aim = { x: seen.x + seen.vx * lead + edge + shade.x, z: seen.z + seen.vz * lead + shade.z };
    const dx = d.aim.x - d.x, dz = d.aim.z - d.z;
    if (Math.hypot(dx, dz) < 0.4) return trackWant(d, d.aim, { x: seen.vx, z: seen.vz }, cap);
    return scaled(dx, dz, cap);
  }

  // The carrier is wrapped up: a pursuer who is not in on the tackle pulls up
  // (PULL_UP) instead of running into the pile: near it, at his own spot
  // beside it (the bearing fixed the first time, from where he is, fanned to
  // his side); farther away, easing off where he is. Sets d.ease, the share
  // of full braking his movement uses this step.
  pullUpWant(d) {
    const c = this.byId[this.carrier], pu = d.pullUp;
    d.ease = 1;
    if (!c || !pu) return ZERO;
    // Decided once, the first time: far from the pile he eases off where he
    // is; closing on it, he steers to his spot beside it; otherwise (already
    // at the pile, shed from a block, standing) he stops.
    if (!pu.mode) {
      const gap = dist(d, c);
      pu.mode = gap > pu.radius + PULL_UP.reach ? 'ease' : gap > PULL_UP.pileOn && this.closingSpeed(d, c) > 1 ? 'spot' : 'stop';
      if (pu.mode === 'spot') pu.bearing = this.pullUpBearing(d, c);
    }
    if (pu.mode === 'ease') d.ease = pu.brake;
    if (pu.mode !== 'spot') return ZERO;
    const target = { x: c.x + Math.sin(pu.bearing) * pu.radius, z: c.z + Math.cos(pu.bearing) * pu.radius };
    return seekWant(d, target, speedCap(d, PULL_UP.effort));
  }

  // Heading from the carrier to a pursuer's pull-up spot: from where the
  // pursuer is, fanned to his side, and never straight behind the carrier
  // (the trailers spread to the flanks instead of lining up behind him).
  pullUpBearing(d, c) {
    const speed = Math.hypot(c.vx, c.vz);
    const behind = speed > 0.5 ? Math.atan2(-c.vx, -c.vz) : Math.PI;
    let rel = wrapAngle(Math.atan2(d.x - c.x, d.z - c.z) - behind + d.pullUp.fan);
    // Stay on the flank he is already on; dead behind, take his own side.
    const side = Math.abs(rel) > 10 * DEG ? Math.sign(rel) : Math.sign(d.pullUp.fan) || 1;
    if (Math.abs(rel) < PULL_UP.flank) rel = side * (PULL_UP.flank + Math.abs(d.pullUp.fan));
    return behind + rel;
  }

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
    const first = COVERAGES[this.coverage]?.rushers ?? 4;
    const seen = this.coverSeen = {};
    for (const id of RECEIVERS) if (!this.byId[id].pickup && this.carrier !== id) seen[id] = this.estimate(id, skill.latency);
    const ids = Object.keys(seen), order = id => RECEIVERS.indexOf(id);
    const upfield = r => r.vz > 2.5 && r.vz > Math.abs(r.vx) * 0.8;
    const men = [], deeps = [], unders = [];
    const manIds = this.coverage === 'blitz' ? MAN.blitz : MAN.base;
    this.defense.forEach((d, i) => {
      if (i < first) return;
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
    deeps.sort((a, b) => a.x - b.x);
    const edges = deeps.length === 3 ? [-COVER.split, COVER.split] : deeps.length === 2 ? [0] : [];
    deeps.forEach((z, k) => { z.lo = k ? edges[k - 1] : -Infinity; z.hi = k < edges.length ? edges[k] : Infinity; z.threats = []; });
    // A deep threat stays one while he is still going upfield near that depth.
    const wasDeep = id => deeps.some(z => z.d.job?.threats?.includes(id));
    const vertical = (r, id) => r.z > spot + COVER.deep || (r.z > spot + COVER.vertical && upfield(r)) || (wasDeep(id) && r.z > spot + COVER.vertical - 1 && r.vz > 0);
    for (const id of ids) {
      const r = seen[id];
      if (!vertical(r, id)) continue;
      const owner = deeps.find(z => z.d.job?.threats?.includes(id) && r.x > z.lo - 2 && r.x < z.hi + 2) || deeps.find(z => r.x >= z.lo && r.x < z.hi);
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
    const coverers = this.defense.filter((d, i) => i >= first && !d.engaged && d.action !== 'stumble');
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
      const own = openMan(z.d, 1, r => r.x >= z.lo && r.x < z.hi);
      if (own) { z.job = { kind: 'lean', id: own, w: skill.help, x: z.x, z: z.z, lo: spot + 4, hi: 115, over: true }; continue; }
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
  }

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
  }

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
  }

  // Flip and run once a receiver eats the cushion going vertical; flipping
  // out of a backpedal costs a quarter second of grip.
  // A vertical far to his side also makes him open up and run to it.
  readThreat(d, threat) {
    const threatened = threat && threat.vz > 4 && (threat.z > d.z - CUSHION || (Math.abs(threat.x - d.x) > WIDE_THREAT && threat.z > d.z - 16));
    if (threatened || d.z - d.start.z > MAX_BACKPEDAL) this.turnHips(d);
  }

  turnHips(d) {
    if (d.turned) return;
    d.turned = true;
    if (d.backpedal) d.flip = FLIP_TIME;
  }

  // Integrate every player once, from the velocity each one wants this step.
  moveAll(dt) {
    const controlled = this.carrier || this.selected;
    for (const p of this.players) {
      if (this.phase === 'tackle' && (p.id === this.carrier || p.id === this.tackle.tackler)) continue;
      const started = moveBody(p, p.want.x, p.want.z, dt, { brakeScale: p.ease });
      if (!started) continue;
      p.lastMoveAt = this.time;
      if (['run', 'carry', 'block'].includes(p.action)) { p.action = 'cut'; p.actionTime = CUT_TIME; }
      if (p.id === controlled) this.events.push('cut');
    }
  }

  // Soft separation keeps bodies from overlapping. The ball carrier is never
  // pushed: contact with defenders is resolved by tackling, and teammates step
  // out of his way (except the quarterback at the mesh).
  separate() {
    const players = this.players, carrier = this.carrier;
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), r = (a.role === 'ol' || b.role === 'ol') ? 0.72 : 0.56;
      if (d >= r || d < 0.001) continue;
      if (a.id === carrier || b.id === carrier) {
        const other = a.id === carrier ? b : a, sign = a.id === carrier ? 1 : -1;
        if (other.team !== 'offense' || other.id === 'QB') continue;
        const push = (r - d) * 0.36;
        other.x += sign * dx / d * push; other.z += sign * dz / d * push;
        continue;
      }
      if (this.tackle && (a.id === this.tackle.tackler || b.id === this.tackle.tackler)) continue;
      const push = (r - d) * 0.18;
      a.x -= dx / d * push; a.z -= dz / d * push; b.x += dx / d * push; b.z += dz / d * push;
    }
  }

  // Stamina, facing, backpedal and lean after everyone has moved.
  updateBodies(dt) {
    for (const p of this.players) {
      const speed = Math.hypot(p.vx, p.vz);
      p.stamina = clamp(p.stamina + (p.sprinting && speed > 1 ? -SPRINT_DRAIN : RECOVERY) * dt, 0, 1);
      p.flip = Math.max(0, p.flip - dt);
      this.turnBody(p, dt, speed);
    }
  }

  turnBody(p, dt, speed = Math.hypot(p.vx, p.vz)) {
    const target = this.facingTarget(p, speed);
    const rate = (p.flip > 0 ? FLIP_RATE : FACING_RATE) * dt;
    p.facing = wrapAngle(p.facing + clamp(wrapAngle(target - p.facing), -rate, rate));
    p.backpedal = speed > 0.8 && (p.vx * Math.sin(p.facing) + p.vz * Math.cos(p.facing)) / speed < -0.5;
    p.lean += (clamp(p.latAccel / p.agility, -1, 1) - p.lean) * (1 - Math.exp(-dt / 0.08));
  }

  // Facing follows the velocity, except for engaged blockers (square to each
  // other), a quarterback in the pocket (downfield, or at his target while
  // throwing), and coverage defenders who have not flipped (at the QB).
  facingTarget(p, speed) {
    const toward = q => Math.atan2(q.x - p.x, q.z - p.z);
    const qb = this.byId.QB, live = this.phase === 'live' || this.phase === 'air';
    if (this.phase === 'dead') return speed > 0.5 ? Math.atan2(p.vx, p.vz) : p.facing;
    if (p.engaged && this.byId[p.engaged]) return toward(this.byId[p.engaged]);
    // Pass blockers kick-slide facing their man (or downfield), never turning
    // their backs on the rush.
    if ((p.role === 'ol' || p.pickup) && this.inPocket()) return p.assignment && this.byId[p.assignment] ? toward(this.byId[p.assignment]) : 0;
    if (this.tackle && p.id === this.tackle.tackler) return toward(this.byId[this.carrier]);
    if (p.id === 'QB' && live && !this.crossedLine && p.z < this.spot && speed < 3.5) {
      if (this.play.type === 'run' && !this.handoff) return toward(this.byId.R);
      const intent = this.throwIntent ? this.byId[this.throwIntent.id] : p.action === 'throw' && this.pass ? this.pass.target : null;
      return intent ? toward(intent) : 0;
    }
    if (this.phase === 'air' && p.ballAware && dist(p, this.ball) < 4) return toward(this.ball);
    if (p.team === 'defense' && !p.turned && live) return toward(qb);
    return speed > 0.5 ? Math.atan2(p.vx, p.vz) : p.facing;
  }

  recordTrails() {
    for (const p of this.offense) this.trails.get(p.id).push(this.time, p);
  }

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
  }

  readFlight(d) {
    const b = this.ball;
    const remaining = clamp((b.vy + Math.sqrt(Math.max(0, b.vy * b.vy + 2 * GRAVITY * (b.y - 1.6)))) / GRAVITY, 0.05, 3);
    // Early reads have some depth/width error; watching the flight refines it.
    // The fixed per-player bias consumes no random draws and cannot reveal a
    // route or the throw's intended receiver/landing coordinate.
    const error = this.skill.judgment * Math.min(1, remaining) / (1 + d.ballRead * 2);
    const angle = d.number * 2.399963;
    return { remaining, target: { x: b.x + b.vx * remaining + Math.sin(angle) * error, z: b.z + b.vz * remaining + Math.cos(angle) * error } };
  }

  // ---------------------------------------------------------------------------
  // The ball. Every player gets one play on a pass, not another lottery ticket
  // every 1/120 second that the ball remains inside his reach.
  flyBall(dt) {
    this.lastBall = { ...this.ball };
    const b = this.ball;
    b.x += b.vx * dt; b.z += b.vz * dt; b.y += b.vy * dt - 0.5 * GRAVITY * dt * dt; b.vy -= GRAVITY * dt;
    this.pass.elapsed += dt;
    this.pass.attempted ||= new Set();
    const candidates = [];
    if (this.pass.elapsed > 0.12) for (const p of this.players) {
      if (p.role === 'ol' || p.id === 'QB' || this.pass.attempted.has(p.id) || p.engaged || ['stumble', 'tackle', 'down'].includes(p.action)) continue;
      if (p.team === 'defense') {
        if (!p.ballAware) continue;
        // Acquiring the flight once does not grant eyes in the back of the
        // helmet. Use the incoming side when the ball is right on his body.
        let dx = this.lastBall.x - p.x, dz = this.lastBall.z - p.z;
        if (Math.hypot(dx, dz) < 0.15) { dx = -b.vx; dz = -b.vz; }
        const incoming = Math.hypot(dx, dz);
        if (incoming > 0.01 && (dx * Math.sin(p.facing) + dz * Math.cos(p.facing)) / incoming < -0.42) continue;
      }
      const near = nearestOnSegment(this.lastBall, b, p), gap = Math.hypot(near.x - p.x, near.z - p.z);
      // A high/low ball needs more extension and less horizontal reach.
      const reach = near.y > 2.15 ? 0.60 : near.y < 0.9 ? 0.55 : 0.78;
      if (gap < reach && near.y > 0.55 && near.y < (p.role === 'dl' ? 2.15 : 2.55) && Math.abs(p.x) < WIDTH / 2 && p.z > 0 && p.z < 120) candidates.push({ p, gap, near, reach });
    }
    // Resolve the first physical contact along the swept flight, then the
    // nearest hands for simultaneous contacts. Offense and defense share it.
    candidates.sort((a, b) => a.near.t - b.near.t || a.gap - b.gap || a.p.number - b.p.number);
    for (const contact of candidates) {
      this.pass.attempted.add(contact.p.id);
      if (contact.p.team === 'defense') this.playBall(contact);
      else this.catchBall(contact.p);
      if (this.phase !== 'air') return;
    }
    if (b.y <= 0.15 || Math.abs(b.x) > WIDTH / 2 + 0.7 || b.z > 120 || b.z < 0) {
      if (b.y <= 0.15) this.restBall(b.x, b.z);
      this.finish('Incomplete', 0, 'incomplete');
    }
  }

  // Being in reach earns a chance to make a play, not possession. Catching a
  // moving football takes two hands and clean position; a reaching defender
  // is more likely to break up the pass. These odds are difficulty-independent.
  playBall({ p, gap, near, reach }) {
    const b = this.ball;
    const reachQuality = clamp(1 - 0.65 * gap / reach, 0.25, 1);
    const heightQuality = clamp(1 - Math.abs(near.y - 1.5) * 0.32, 0.55, 1);
    const relative = Math.hypot(b.vx - p.vx, b.vy, b.vz - p.vz);
    const speedQuality = clamp(1 - Math.max(0, relative - 16) * 0.015, 0.55, 1);
    const receiver = this.offense.find(o => RECEIVERS.includes(o.id) && dist(o, p) < 1.0);
    const hands = { cb: 0.52, s: 0.56, lb: 0.40, dl: 0.18 }[p.role] || 0.4;
    const possession = hands * reachQuality * heightQuality * speedQuality * (receiver ? 0.68 : 1);
    const breakup = clamp(0.60 + 0.25 * reachQuality, 0, 0.86);
    const roll = this.random();
    p.action = 'catch'; p.actionTime = 0.35;
    if (roll < possession) { this.catchBall(p); return; }
    if (roll < possession + (1 - possession) * breakup) {
      this.ball = { x: near.x, y: Math.max(0.6, near.y), z: near.z, vx: b.vx * 0.18, vy: 1.3, vz: b.vz * 0.18 };
      this.events.push('deflection');
      this.finish('Pass broken up', 0, 'incomplete');
    }
  }

  catchBall(p) {
    p.action = 'catch'; p.actionTime = 0.45;
    if (p.team === 'defense') {
      this.stats.ints++;
      this.events.push('interception');
      this.holder = p.id;
      this.holdBall(p);
      this.finish('Intercepted', 0, 'interception');
      return;
    }
    // Drops (plan 4.2): a base rate, much more with a defender on him, and a
    // little more for a bullet from close range.
    const contested = this.defense.some(d => dist(d, p) < 1.0);
    const chance = 0.03 + (contested ? 0.25 : 0) + (this.pass.style === 'bullet' && this.pass.distance < 8 ? 0.08 : 0);
    if (this.random() < chance) {
      const b = this.ball, side = (this.random() - 0.5) * 2;
      this.ball = { x: b.x, y: Math.max(0.6, b.y), z: b.z, vx: p.vx * 0.3 + side, vy: 2.2, vz: p.vz * 0.3 - b.vz * 0.05 };
      this.events.push('drop');
      this.finish('Dropped', 0, 'incomplete');
      return;
    }
    this.completed = true; this.stats.completions++;
    this.carrier = p.id; this.selected = p.id; this.phase = 'run';
    this.catchAt = this.possessionAt = this.time;
    this.holdBall(p);
    this.events.push('catch');
  }

  // Carried: at the carrier's hands on his right side, velocity zero.
  holdBall(p) {
    const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    Object.assign(this.ball, { x: p.x + fz * 0.27 + fx * 0.12, y: 1.25, z: p.z - fx * 0.27 + fz * 0.12, vx: 0, vy: 0, vz: 0 });
  }

  restBall(x, z) { Object.assign(this.ball, { x, y: BALL_REST, z, vx: 0, vy: 0, vz: 0 }); }

  // ---------------------------------------------------------------------------
  // Scoring, sidelines and tackling.
  checkCarrier() {
    if (!this.carrier || this.phase === 'dead') return;
    const c = this.byId[this.carrier];
    this.holdBall(c);
    if (c.z >= GOAL) { this.stats.td++; this.finish('Touchdown', Math.max(0, GOAL - this.spot), 'touchdown'); }
    else if (Math.abs(c.x) > WIDTH / 2 - 0.18) this.endRep('Out of bounds', 'out');
    else if (this.phase === 'tackle') this.checkTackleEnd(c);
    else if (this.time > 0.85 && (!this.completed || this.time - this.catchAt > 0.18)) this.tryTackles(c);
  }

  // Contact (plan 4.3): every free defender within reach gets one attempt.
  // A pursuer who cannot close the last yard leaves his feet instead: one
  // diving attempt from up to DIVE_REACH, at lower odds the farther he dives.
  tryTackles(c) {
    const free = this.defense.filter(d => !d.engaged && d.action !== 'stumble');
    const reach = free.filter(d => dist(d, c) < REACH).sort((a, b) => dist(a, c) - dist(b, c));
    for (const d of reach) {
      if (this.random() < this.tackleChance(d, c)) { this.startTackle(d, c); return; }
      this.brokenTackle(d, c);
    }
    for (const d of free) {
      const gap = dist(d, c);
      if (gap < REACH || gap > DIVE_REACH || !this.chasing(d, c) || this.closingSpeed(d, c) > 0.5) continue;
      const stretch = (gap - REACH) / (DIVE_REACH - REACH);
      if (this.random() < this.tackleChance(d, c) * (0.75 - 0.3 * stretch)) { this.startTackle(d, c); return; }
      this.brokenTackle(d, c);
    }
  }

  // Running at the carrier (not past or away from him).
  chasing(d, c) {
    const speed = Math.hypot(d.vx, d.vz), gap = Math.max(1e-6, dist(c, d));
    return d.turned && speed > 3 && (d.vx * (c.x - d.x) + d.vz * (c.z - d.z)) / (speed * gap) > 0.64;
  }

  // How fast the gap between a defender and the carrier is shrinking.
  closingSpeed(d, c) {
    const gap = Math.max(1e-6, dist(c, d));
    return ((d.vx - c.vx) * (c.x - d.x) + (d.vz - c.vz) * (c.z - d.z)) / gap;
  }

  tackleChance(d, c) {
    const cs = Math.hypot(c.vx, c.vz), ds = Math.hypot(d.vx, d.vz);
    // Approach angle: 0° chasing from behind, 180° head on.
    const ax = ds > 1 ? d.vx / ds : c.x - d.x, az = ds > 1 ? d.vz / ds : c.z - d.z;
    const an = Math.hypot(ax, az) || 1;
    const angle = cs > 0.5 ? Math.acos(clamp((ax * c.vx + az * c.vz) / (an * cs), -1, 1)) : Math.PI / 2;
    // How fast the defender himself is coming in, toward the carrier.
    const gap = Math.max(1e-6, dist(c, d));
    const closing = (d.vx * (c.x - d.x) + d.vz * (c.z - d.z)) / gap;
    const advantage = clamp((ds - cs) / 3, -1.5, 1.5);
    const shaken = this.time - c.lastMoveAt < 0.3 && angle > 60 * DEG ? 1 : 0;
    const overrun = closing > cs + 2 && angle > 70 * DEG ? 1 : 0;
    return clamp(0.78 + 0.12 * advantage - 0.25 * shaken - 0.10 * overrun, 0.30, 0.97);
  }

  startTackle(d, c) {
    const sack = this.carrier === 'QB' && !this.threw && !this.crossedLine && this.play.type !== 'run';
    // The hit: momentum is shared, so a head-on tackle stops the runner short
    // (never driving him backward) and one from behind lets him fall forward.
    // Being wrapped also breaks his stride: he keeps WRAP_KEEP of his speed.
    const speed = Math.hypot(c.vx, c.vz), ux = speed > 1e-6 ? c.vx / speed : 0, uz = speed > 1e-6 ? c.vz / speed : 0;
    const k = 0.45 * d.mass / (d.mass + c.mass);
    let vx = c.vx + (d.vx - c.vx) * k, vz = c.vz + (d.vz - c.vz) * k;
    const back = vx * ux + vz * uz;
    if (back < 0) { vx -= back * ux; vz -= back * uz; }
    c.vx = vx * WRAP_KEEP; c.vz = vz * WRAP_KEEP;
    c.juke = null; c.cutting = false;
    c.action = 'wrapped'; c.actionTime = TACKLE_HOLD;
    d.action = 'tackle'; d.actionTime = 1.0;
    this.tackle = { tackler: d.id, at: this.time, from: { x: c.x, z: c.z }, helpers: new Set(), sack };
    this.tackler = d.id; this.phase = 'tackle'; this.throwIntent = null;
    this.events.push('tackle');
  }

  brokenTackle(d, c) {
    d.action = 'stumble'; d.actionTime = STUMBLE_TIME;
    d.vx *= STUMBLE_SPEED; d.vz *= STUMBLE_SPEED; d.juke = null;
    c.vx *= BROKEN_KEEP; c.vz *= BROKEN_KEEP;
    if (c.juke) { c.juke.to.x *= BROKEN_KEEP; c.juke.to.z *= BROKEN_KEEP; c.juke.from.x *= BROKEN_KEEP; c.juke.from.z *= BROKEN_KEEP; }
    this.events.push('broken-tackle');
  }

  // Wrapped up, the carrier keeps going, decelerating at 12 yd/s² plus 6 for
  // each extra defender in on the tackle; the tackler rides him down.
  dragTackle(dt) {
    const t = this.tackle, c = this.byId[this.carrier], d = this.byId[t.tackler];
    for (const q of this.defense) {
      if (q.id === d.id || t.helpers.has(q.id) || q.engaged || q.action === 'stumble' || dist(q, c) >= REACH) continue;
      t.helpers.add(q.id);
      q.action = 'tackle'; q.actionTime = 1.0;
    }
    const speed = Math.hypot(c.vx, c.vz), slowed = Math.max(0, speed - (TACKLE_DECEL + GANG_DECEL * t.helpers.size) * dt);
    if (speed > 1e-6) { c.vx *= slowed / speed; c.vz *= slowed / speed; }
    c.latAccel = 0; integrate(c, dt);
    // The tackler hangs on, closing to arm's length.
    const gap = Math.max(1e-6, dist(d, c)), hold = Math.max(0.6, gap - 2 * dt);
    d.x = c.x + (d.x - c.x) / gap * hold; d.z = c.z + (d.z - c.z) / gap * hold;
    d.vx = c.vx; d.vz = c.vz; d.latAccel = 0;
    d.phase += slowed * dt;
  }

  checkTackleEnd(c) {
    const t = this.tackle;
    if (Math.hypot(c.vx, c.vz) >= 0.5 && this.time - t.at < TACKLE_HOLD) return;
    c.action = 'down'; c.actionTime = 0;
    if (t.sack) this.stats.sacks++;
    this.endRep(t.sack ? 'Sacked' : 'Tackled', t.sack ? 'sack' : 'tackle');
  }

  // A carrier downed, pushed out or still holding the ball in his own end
  // zone when the rep ends gives up a safety; standing there is legal.
  endRep(label, kind) {
    const c = this.byId[this.carrier];
    if (c && c.z <= 10) this.finish('Safety', c.z - this.spot, 'safety');
    else this.finish(label, c ? c.z - this.spot : 0, kind);
  }

  // After the whistle players pull up instead of freezing; a loose ball falls
  // to the turf and comes to rest.
  stepDead(dt) {
    this.deadTime += dt;
    for (const p of this.players) {
      p.juke = null;
      // Short moves run out; the downed carrier and his tacklers stay down,
      // and blocks are released a moment after the whistle.
      p.actionTime = Math.max(0, p.actionTime - dt);
      if (!p.actionTime && p.action !== 'down' && p.action !== 'tackle') p.action = this.restingAction(p);
      if (this.deadTime > 0.4) p.engaged = null;
      const grounded = p.action === 'down' || p.action === 'tackle';
      // After a tackle the other defenders pull up beside the pile.
      if (this.tackle && p.team === 'defense' && !grounded) {
        const want = this.pullUpWant(p);
        moveBody(p, want.x, want.z, dt, { brakeScale: p.ease });
      } else moveBody(p, 0, 0, dt, { brakeScale: grounded ? 1.6 : 0.6 });
      p.cutting = false;
      this.turnBody(p, dt);
    }
    const b = this.ball, holder = this.byId[this.carrier || this.holder];
    if (holder) this.holdBall(holder);
    else if (b.vx || b.vy || b.vz || b.y > BALL_REST) {
      b.x += b.vx * dt; b.z += b.vz * dt; b.y += b.vy * dt - 0.5 * GRAVITY * dt * dt; b.vy -= GRAVITY * dt;
      if (b.y <= BALL_REST) this.restBall(clamp(b.x, -32, 32), clamp(b.z, -2, 122));
    }
  }

  finish(label, yards, kind) {
    if (this.phase === 'dead') return;
    const gain = Math.round(yards);
    this.phase = 'dead'; this.deadTime = 0; this.throwIntent = null;
    this.result = { label, yards: gain, kind, time: this.time, completed: this.completed, firstDown: gain >= this.toGo };
    this.stats.yards += gain;
    if (this.completed) this.stats.passing += gain;
    else if (!this.threw && kind !== 'sack') this.stats.rushing += gain;
    this.events.push(kind === 'touchdown' ? 'touchdown' : 'whistle');
    this.saveFrame();
  }

  next() {
    if (this.phase !== 'dead') return false;
    if (this.config.mode === 'drive') {
      const r = this.result;
      if (['touchdown', 'interception', 'safety'].includes(r.kind) || (this.down === 4 && !r.firstDown)) {
        this.spot = this.config.spot; this.down = 1; this.toGo = Math.min(10, GOAL - this.spot);
      } else {
        this.spot = clamp(this.spot + r.yards, 11, 109);
        if (r.firstDown) { this.down = 1; this.toGo = Math.min(10, GOAL - this.spot); }
        else { this.down++; this.toGo = Math.min(GOAL - this.spot, this.toGo - r.yards); }
      }
    }
    this.reset(true);
    return true;
  }

  snapshot() {
    return {
      phase: this.phase, time: this.time, deadTime: this.deadTime, carrier: this.carrier, selected: this.selected, spot: this.spot,
      ball: { ...this.ball },
      players: this.players.map(p => ({
        id: p.id, x: p.x, z: p.z, vx: p.vx, vz: p.vz, facing: p.facing,
        speed: Math.hypot(p.vx, p.vz), lean: p.lean, backpedal: p.backpedal,
        action: p.action, actionTime: p.actionTime, phase: p.phase, stamina: p.stamina, engaged: p.engaged,
      })),
      result: this.result,
    };
  }

  saveFrame() {
    this.recording.push(this.snapshot());
    if (this.recording.length > 460) this.recording.shift();
  }

  drainEvents() { return this.events.splice(0); }
}
