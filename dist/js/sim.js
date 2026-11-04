import { PLAYS, RECEIVERS, routeFor, hotRouteFor, formationFor } from './plays.js';
import { STEP, DEG, clamp, dist, wrapAngle, smoothstep, ZERO, STUMBLE_SPEED, GET_OFF, LEVERAGE, PULL_UP, fatigueOf, speedCap, scaled, seekWant, trackWant, meetWant } from './sim/common.js';
import { DIFFICULTY, defense } from './sim/defense.js';
import { coverage } from './sim/coverage.js';
import { protection } from './sim/protection.js';
import { callPlay } from './sim/offense.js';

// Units are yards and seconds. +z points downfield (own end line z = 0, goal
// lines at z = 10 and z = 110) and +x is the offense's right. A heading is
// atan2(vx, vz), so 0 faces downfield. Everything random comes from the seeded
// generator, so a seed and a sequence of inputs always replay the same rep.
export { STEP };
export const WIDTH = 53.333333, GOAL = 110, GRAVITY = 10.73;

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
const JUKE = { plant: 0.25, action: 0.45, keep: 0.65, cost: 0.05, minSpeed: 2 };
const SPRINT_DRAIN = 1 / 9;            // a full tank lasts nine seconds of sprinting
const RECOVERY = 0.12;
const REACH = 0.95;                    // tackling reach, yards
const DIVE_REACH = 1.7;                // a diving tackle from behind
const WRAP_KEEP = 0.8;
const SCREEN = 0.3;                    // a body this close to the line between tackler and runner blocks the tackle
// Receivers blocking on a run or after a catch: the nearest defender in
// front of him within `range` yd, if that defender is within `near` yd of the
// ball carrier; he locks on inside `engage` yd and holds him at most `hold`
// s (a stalk block, not a pin), then lets him go for good.
const DOWNFIELD = { range: 3.5, engage: 1.2, near: 12, hold: 1.3 };
const TACKLE_DECEL = 12, GANG_DECEL = 6, TACKLE_HOLD = 0.9;
// A miss: the tackler stumbles for STUMBLE_TIME at STUMBLE_SPEED of his top
// speed; the runner keeps BROKEN_KEEP of his speed through the contact.
const STUMBLE_TIME = 0.55, BROKEN_KEEP = 0.65;
// Tackle odds (tackleChance). A man who gets his hands on the runner makes
// `base`; each unit of speed edge ((his speed - the runner's) / 3, ±1.5) is
// worth `speed`, in full from behind and only `square` of it head on (the
// runner runs into a man in his path). A runner who cut or juked within
// `shakeTime` s takes `shaken` off. A man who comes in hot, within
// `overrunTime` s of a cut or juke, on a line that now misses the runner by
// over `missAngle`, has been made to overrun him and takes `overrun` off (the
// larger of the two counts, they do not add up). A second man on the same
// step hits a runner already off balance: he closes `help` of the gap from
// his odds to a sure tackle.
const TACKLE = {
  base: 0.88, speed: 0.1, square: 0.25, min: 0.25, max: 0.97, help: 0.5,
  shaken: 0.38, shakeTime: 0.3, overrun: 0.32, overrunTime: 0.8, missAngle: 40 * DEG,
};
const BALL_REST = 0.1;                 // centre height of a ball lying on the turf
const CATCH_GRACE = 0.35;              // a new carrier runs on through the catch
const MESH_REACH = 1.25;               // QB to back, body centres, at the exchange

// Each defender's pursuit leverage and pull-up spot, varied by his index
// with low-discrepancy fractions (no random draws, so the seeded stream is
// unchanged). The side is the one he lined up on, from the ball at x0; the
// middle men alternate in the play's frame (`playSide` +1, or -1 on a
// flipped play), so a flipped rep mirrors.
function assignPursuitAngles(d, k, x0 = 0, playSide = 1) {
  const f = (k * 0.618034) % 1, g = (k * 0.381966 + 0.2) % 1, off = d.start.x - x0;
  const side = Math.abs(off) > 0.5 ? Math.sign(off) : (k % 2 ? 1 : -1) * playSide;
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
    // `blocked`: the back has locked up with a rusher this rep, so he stays in.
    lock: null, assignment: null, need: 0, have: 0, wonAt: -9, winSide: 0, beatenUntil: -9, pickup: null, released: false, blocked: false,
    // Zone coverage (planCoverage): `job` is this step's task, `match` the
    // receiver he has, `carrying` whether he runs with him upfield, `handed`
    // the vertical he passed to a deep man, `helpOn` the open man he leans to.
    job: null, match: null, carrying: false, handed: null, helpOn: null,
    // Route running (runRoute): the route's `kind` and `key` leg, the man-or-
    // zone read, where he sits down, the decisions taken, a jam and the
    // scramble drill lane. `ghost` marks predict()'s copy.
    kind: null, key: 0, manRead: 0, mode: null, legAt: -1, sitting: false, sitX: 0, sitZ: 0, slideAt: -9, noSit: false, converted: false, extended: false, workBack: false,
    jamUntil: -9, jamSide: 0, drillDeep: false, drillLane: 0, drillZ: 0, avoidId: null, avoidSide: 0, ghost: false,
    blockOn: null, blockAt: 0, blockDone: null,
  };
}

// Recent positions of one player, so defenders can react to what they saw a
// moment ago instead of to the present.
class Trail {
  constructor(size = 120) {
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

// Lateral shade of a pursuit aim point: `leverage` yards along the normal of
// the carrier's path, toward the side the pursuer lined up on (LEVERAGE),
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

// Open-field pursuit angles (pursue). The carrier's path, as a defender saw
// it, runs on at the velocity he saw and turns up (or down) the field `edge`
// yd from the middle: the sideline fences him in. The defender aims at the
// first point of that path he can reach in time (within `reach` yd), sampled
// every `step` s up to `horizon` s ahead, so he takes an angle instead of
// chasing. One who cannot get there in time chases `trail` s ahead of the
// carrier and, when the carrier is more than `wide` yd from the middle of
// the field and the defender is inside him, stays `force` yd inside him so
// the carrier has only the sideline.
const PURSUIT = { edge: 25.8, step: 0.1, horizon: 2.5, reach: 0.5, trail: 0.6, wide: 6, force: 1.2 };
function carrierPath(seen, t) {
  const x = seen.x + seen.vx * t, z = seen.z + seen.vz * t;
  if (Math.abs(x) <= PURSUIT.edge) return { x, z };
  const side = Math.sign(x), t0 = Math.abs(seen.vx) > 1e-6 ? clamp((side * PURSUIT.edge - seen.x) / seen.vx, 0, t) : 0;
  return { x: side * PURSUIT.edge, z: seen.z + seen.vz * t0 + (seen.vz >= 0 ? 1 : -1) * Math.hypot(seen.vx, seen.vz) * (t - t0) };
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
// Receivers against the coverage. A receiver runs his landmarks with
// routeWant, but he reads the defense on the way, READ.latency s late, the
// same at every difficulty, so difficulty stays a property of the defense.
//
// Man or zone: each step he scores how closely the nearest coverage defender
// stays on him: one within `near` yd (in full inside `tight`), less how fast
// the gap between them opens or closes, as a share of `approach` × his speed.
// A man trailing him or running with him scores near 1 however the release
// weaves; a corner squatting in the flat as he runs at him, or a deep man
// bailing away from him, scores near 0. The score settles over `tau` s while
// he runs faster than `moving` yd/s; over `man` it reads as a man on him (or
// a zone defender matching him, which is the same thing to a receiver).
const READ = { latency: 0.25, near: 4.5, tight: 2.5, approach: 0.5, tau: 0.35, man: 0.45, moving: 2.5 };
// The safety shell: coverage defenders deeper than `depth` yd past the line
// and within `width` yd of the ball (one-high, two-high or none). A deep
// defender for a seam is one at least `over` yd deeper than the seam runner
// and more than `own` yd from him (not the man carrying him).
const SHELL = { depth: 12, width: 15, over: 3, own: 3 };
// Seams and posts. Passing `at` yd past the line, a seam picks the middle of
// the gap between the nearest deep defenders either side of him (or the
// sideline where there is none): away from a single-high safety into the
// void beside him, between two-high safeties. He bends at most `bend` yd off
// his line and stays `hash` yd on his own side of the ball. A post that
// breaks against a single deep middle defender narrows to a skinny post,
// `skinny` of its width; against two-high or none it stays a true post.
const BEND = { at: 9, bend: 3.5, hash: 2.5, skinny: 0.45 };
// Sit or run. A sit route (curl, hitch, stick, snag, checkdown) decides at
// its break, `look` s into its last leg (or within `arrive` yd of its end).
// He keeps running if a man has been on him (his score reads man), or if a
// coverage defender will be within `contest` yd of the spot when he gets
// there (from the velocity he sees, at most `ahead` s on) or is driving on it
// at over `drive` yd/s from within `driveFrom` yd. A deep defender bailing
// over the top, or one sitting in his own zone away from the spot, leaves
// him the hole. Sitting, he shows the quarterback his numbers; when a
// coverage defender comes within `crowd` yd of him he slides `slide` yd away
// from him (no more often than every `every` s, never more than `shift` yd
// from the landmark) to open the window again. Running, he breaks away from
// his man's leverage (a man more than `leverage` yd to one side), `away` yd
// across and `back` yd toward the line, and keeps going.
// A crosser against zone settles once he has run `run` yd of his crossing
// leg, shallower than `deep` yd, where he would stop with `room` yd to every
// coverage defender and none closing on the spot faster than `closing` yd/s;
// one coming within `crowd` yd gets him up and crossing again, for good.
// Against man he never sits.
const SIT = { look: 0, arrive: 1, contest: 2.5, ahead: 0.8, drive: 3, driveFrom: 6, crowd: 2, slide: 1.5, every: 0.6, shift: 2.5, leverage: 1, away: 8, back: 1.5, run: 4, deep: 18, room: 3.5, closing: 3 };
// Late in the down (after `at` s) a vertical deeper than `depth` yd with a
// coverage defender within `covered` yd throttles down and works `back` yd
// toward the quarterback at `effort` of his speed. Routes that run out of
// landmarks keep going along their last leg, a crosser to `edge` yd from the
// middle of the field and a vertical to `deep` yd past the line, then settle.
const LATE = { at: 3, depth: 12, covered: 2, back: 5, effort: 0.7, edge: 23.5, deep: 55 };
// The scramble drill. Once the quarterback is out of the pocket off script
// (rolling to the called side on a boot is the script) the receivers see it
// READ.latency s later and break off to his side. Those shallower than
// `split` yd work toward the sideline he rolls to, `lead` + `gap` × lane yd
// past him and `low` to `high` yd past the line; the deeper ones go deep on
// that side, `deepLead` + `gap` × lane yd past him, `climb` yd deeper than
// they were and at least `deep` yd. Lanes go out from the quarterback in the
// order the receivers already stand, never more than `edge` yd from the
// middle of the field.
const DRILL = { split: 10, lead: 5, gap: 5, low: 3, high: 7, deepLead: 8, climb: 4, deep: 16, edge: 24 };
// A jam at the line (jam(), called by the coverage): while it lasts the
// receiver's wanted velocity is damped to `damp` and pushed `push` yd/s
// across, away from the defender's hands. A clean release (`clean` of the
// time) shakes it in `quick` of the jam. Otherwise he is rerouted: held for
// the jam and `cost` s more, and the landmark he is running to (if it is
// shallower than `depth` yd) moves `shift` yd to the side he was pushed.
const JAM = { clean: 0.4, quick: 0.4, damp: 0.3, push: 1.6, cost: [0.3, 0.6], shift: [0.8, 2], depth: 16 };
// Receivers step around a defender in their path: the nearest one less than
// `ahead` yd in front and within `width` yd of his line, whom he is running
// into at over `closing` yd/s, aiming `clear` yd beside him but never more
// than `off` yd off the line of his route. A prediction (predict) runs the
// defenders on at their present velocity for at most `lookahead` s.
const AVOID = { ahead: 1.4, width: 0.9, closing: 0.5, clear: 1.0, off: 1.2, lookahead: 0.5 };
const RUNS_ON = new Set(['cross', 'slant', 'seam', 'go', 'post', 'corner']);
const VERTICAL = new Set(['seam', 'go', 'post', 'corner']);

// What a route asks of its runner, from the shape of its last leg (the rules
// are mirror-symmetric, so a flipped play reads the same):
//   sit     comes back or stops short (curl, hitch, stick, snag, checkdown);
//   cross   runs across the formation (drag, dig, shallow, over);
//   out     runs to his own sideline (out, flat, sail, swing);
//   seam    a vertical inside the numbers; go: one outside them;
//   post    in and upfield off a stem at least KIND.postDepth deep;
//   slant   in and upfield off a short stem; corner: out and upfield.
// `key` is the leg the decision belongs to (the post's first leg in).
const KIND = { sitLength: 4.5, short: 2.5, flat: 1.6, vertical: 0.45, seamWidth: 13, checkdown: 9, flatDepth: 6, postDepth: 9, postBreak: 20 * DEG };
function routeKind(route, start, spot) {
  const n = route.length;
  if (!n) return { kind: null, key: 0 };
  const from = i => (i ? route[i - 1] : start);
  const b = route[n - 1], a = from(n - 1), lx = b.x - a.x, lz = b.z - a.z, len = Math.hypot(lx, lz);
  const kind = k => ({ kind: k, key: n - 1 });
  if (len < KIND.short || (lz < -0.5 && len < KIND.sitLength)) return kind('sit');
  if (Math.abs(lx) > KIND.flat * Math.abs(lz)) return kind(Math.sign(b.x) !== Math.sign(a.x) || Math.abs(b.x) < Math.abs(a.x) ? 'cross' : 'out');
  if (lz <= 0) return kind('sit');
  if (Math.abs(lx) < KIND.vertical * lz) return kind(b.z - spot < KIND.checkdown ? 'sit' : Math.abs(b.x) < KIND.seamWidth ? 'seam' : 'go');
  if (Math.abs(b.x) >= Math.abs(a.x)) return kind(b.z - spot < KIND.flatDepth ? 'out' : 'corner');
  // In and upfield: walk back over the legs that keep going that way.
  const inward = i => { const p = from(i), q = route[i], dx = q.x - p.x, dz = q.z - p.z; return dz > 0 && Math.abs(dx) >= KIND.vertical * dz && Math.abs(q.x) < Math.abs(p.x); };
  let k = n - 1;
  while (k > 0 && inward(k - 1)) k--;
  const brk = from(k);
  return { kind: k > 0 && brk.z - spot >= KIND.postDepth && breakAngle(from(k - 1), brk, route[k]) >= KIND.postBreak ? 'post' : 'slant', key: k };
}

// The quarterback's drop while the user is not steering him. From the gun a
// one-step settle to `quick` yd on quick game, otherwise three steps to `gun`
// yd at `effort` of his speed; under centre a five-step drop to `centre` yd
// at `centreEffort`, opened `open` rad to his throwing side until he is
// `setNear` yd from his set. Play action: see FAKE and BOOT, then set at
// `action` yd. Throwing, he plants (`plant` × full braking). Once the user has
// steered him, letting go of the stick sets his feet at `reset` × full
// braking, square to the line.
const DROP = { quick: 6, gun: 7, centre: 7, action: 7.5, effort: 0.62, centreEffort: 0.8, open: 1.0, setNear: 1.0, plant: 1.3, reset: 1.6 };
// Play action: he meets the back where the back's first leg passes nearest
// him, `side` yd to the side away from where the back goes next, facing him,
// at `effort` of his speed; he rides the fake until the back, having come
// within `mesh` yd, is `past` yd farther away again (no sooner than `min` s,
// no later than `max` s). A throw waits for the fake (faking()).
const FAKE = { side: 0.9, mesh: 1.8, past: 0.4, min: 0.6, max: 0.9, effort: 0.5 };
// A boot: after the fake he rolls away from it along `path` ([x out from the
// ball, z from the line], yd) at `effort` of his speed, shoulders turned
// `facing` rad toward the line from his run, moving on within `near` yd.
const BOOT = { path: [[4, -6.6], [8.5, -6.2], [11.5, -5]], effort: 0.85, facing: 0.7, near: 1.0 };
// Accuracy. A set throw lands within ± spread/2 yd each way (long or short,
// left or right) of the aim point. The spread is `set` plus `far` (by style)
// per yard of the throw past `crisp` yd: a short throw stays on the hands, a
// 40-yd bullet spreads about 1.4 yd, a touch ball 1.8 and a lob 2.3 (a ball
// put up with air under it is harder to place). Moving adds spread per
// 7 yd/s of speed: `toward` running at the target, `across` running across
// the throw and `away` throwing back against his own momentum (across his
// body); his speed is the larger of now and `reset` of his speed `settle` s
// ago, so a quarterback who has only just stopped is not set yet. A defender
// within `near` yd adds up to `pressure` as he closes to `close` yd.
const THROW = {
  set: 0.18, far: { bullet: 0.035, touch: 0.045, lob: 0.06 }, crisp: 5,
  toward: 0.6, across: 1.6, away: 2.8, settle: 0.2, reset: 0.6, pressure: 2.8, near: 3.3, close: 0.6,
};
// Placement. A quarterback puts the ball where only his man can get it. He
// reads each defender's leverage on the receiver: where the man is from him
// now, carried on at his own speed against the receiver's run to the catch
// for up to `carry` s, and able to close `adjust` of his top speed more once
// he reads the ball, `react` s after the release. A man who can get within
// `near` yd of the catch (fully within `tight`) pushes the ball away from
// his side. The catch point moves up to `shift` yd away from the defenders,
// square to the throw or back toward the quarterback (the back shoulder); a
// push beyond the receiver, who cannot outrun his route, turns to the side
// it already leans, or to the outside. The ball comes in `hands` yd off his
// body that way, at his far shoulder, and the miss leans the same way: the
// part of the error toward the defenders folds back. None of this on throws
// shorter than `from` yd, all of it from `full` yd. The ball arrives `catch`
// yd high by style: a lob drops in over the receiver's shoulder, above a man
// trailing him.
const PLACE = { carry: 1, adjust: 0.35, react: 0.5, near: 2, tight: 0.6, shift: 1, hands: 0.45, from: 15, full: 25, catch: { bullet: 1.6, touch: 1.65, lob: 1.8 } };

// Contested catches (catchBall): a defender within `near` yd (close enough
// to get a hand in or hit the receiver as the ball arrives) adds to the drop
// chance, up to `front` when he is between the receiver and the ball and
// `trail` when he trails behind (the receiver shields him), in full within
// `tight` yd. A bullet from inside `close` yd adds `bullet`.
const CATCH = { base: 0.03, near: 1.8, tight: 0.6, front: 0.5, trail: 0.3, bullet: 0.08, close: 8 };

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
      // Coordinator's call (offense.js): one draw, weighted for the situation.
      this.play = this.config.offense === 'random'
        ? callPlay({ down: this.down, toGo: this.toGo, spot: this.spot, mode: this.config.mode }, this.random())
        : PLAYS.find(p => p.id === this.config.offense) || this.play;
      this.callDefense();
      this.hotRoutes = {}; this.audibled = false;
    }
    this.skill = DIFFICULTY[this.config.difficulty] || DIFFICULTY.pro;
    const flip = this.config.flip;
    const formation = formationFor(this.play);
    this.players = formation.map(p => createPlayer(p, 'offense', this.spot, flip));
    this.players.push(...this.alignDefense(formation).map(p => createPlayer(p, 'defense', this.spot, flip)));
    this.players.forEach(p => {
      p.shed = 2.5 + this.random() * 2.8;
      p.route = routeFor(this.effectivePlay, p.id, this.spot, flip);
      if (p.team === 'defense') this.initDefender(p);
      else Object.assign(p, routeKind(p.route, p.start, this.spot));
    });
    this.byId = Object.fromEntries(this.players.map(p => [p.id, p]));
    this.offense = this.players.filter(p => p.team === 'offense');
    this.defense = this.players.filter(p => p.team === 'defense');
    this.defense.forEach((d, k) => assignPursuitAngles(d, k, this.pocketX(), this.playSide()));
    this.line = this.offense.filter(p => p.role === 'ol');
    this.trails = new Map(this.players.map(p => [p.id, new Trail()]));
    // The offense's reads (readCoverage), the scramble drill and the
    // quarterback's drop (planPasser).
    this.seenDefense = []; this.shell = 0; this.drillAt = null; this.drillSide = 0;
    this.qbSteered = false; this.qbFacing = null; this.fakeDone = false; this.fakeNear = Infinity; this.bootLeg = 0;
    this.dropPlan = this.planDrop();
    this.ball = { x: 0, y: BALL_REST, z: this.spot, vx: 0, vy: 0, vz: 0 };
    this.lastBall = { ...this.ball };
    this.saveFrame();
  }

  // +1, or -1 on a flipped play. Exact ties (a man straight over the ball,
  // an about-turn) break toward the same side of the play, not of the
  // field, so a flipped rep is the mirror image of the same seed.
  playSide() { return this.config.flip ? -1 : 1; }

  get effectivePlay() {
    const hot = Object.fromEntries(Object.entries(this.hotRoutes).map(([id, kind]) => [id, hotRouteFor(id, kind, this.play)]));
    return { ...this.play, routes: { ...this.play.routes, ...hot } };
  }

  setHotRoute(id, kind) {
    if (this.phase !== 'presnap' || this.play.type === 'run' || !RECEIVERS.includes(id) || (kind !== 'default' && !hotRouteFor(id, kind, this.play))) return false;
    if (kind === 'default') delete this.hotRoutes[id]; else this.hotRoutes[id] = kind;
    const p = this.byId[id];
    p.route = routeFor(this.effectivePlay, id, this.spot, this.config.flip);
    p.routeIndex = 0;
    Object.assign(p, routeKind(p.route, p.start, this.spot));
    if (id === 'R') this.dropPlan = this.planDrop();
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
    if (this.play.type === 'pa' && this.faking()) return false;
    this.throwIntent = {
      id, style: ['bullet', 'touch', 'lob'].includes(style) ? style : 'bullet',
      lead: { x: clamp(lead.x || 0, -1, 1), z: clamp(lead.z || 0, -1, 1) }, at: this.time + 0.23,
    };
    this.byId.QB.action = 'throw'; this.byId.QB.actionTime = 0.4;
    return true;
  }

  // A play-action quarterback is still riding the fake (no throw yet): until
  // the back is past him, and never past FAKE.max s.
  faking() {
    return this.play.type === 'pa' && this.phase === 'live' && !this.fakeDone && this.time < FAKE.max;
  }

  // The fake as the defense sees it: a play-action quarterback riding the
  // fake at the mesh, not steered out of it. Run reads key on this, not on
  // the call.
  fakeShown() {
    return this.faking() && !this.qbSteered && !!this.dropPlan?.mesh;
  }

  throwAway() {
    if (this.phase !== 'live' || this.carrier !== 'QB' || this.crossedLine || this.threw || this.play.type === 'run' || this.time < 0.3) return false;
    this.stats.attempts++; this.threw = true;
    this.finish('Thrown away', 0, 'incomplete');
    return true;
  }

  // Where a receiver will be after `t` seconds if he keeps running his route:
  // a ghost copy runs the same route logic (runRoute, with the reads he has
  // made and the defense as he sees it now) through the same momentum model.
  // The ghost changes nothing outside itself and draws no random numbers.
  predict(p, t) {
    const ghost = { ...p, juke: null, want: ZERO, ghost: true };
    const n = Math.max(1, Math.round(t / STEP)), dt = t / n, plain = this.play.type === 'run' || this.completed;
    let clock = this.time;
    for (let i = 0; i < n; i++) {
      clock += dt;
      const want = clock < GET_OFF[ghost.role] ? ZERO : plain ? routeWant(ghost, speedCap(ghost)) : this.runRoute(ghost, speedCap(ghost), clock);
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
    // Accuracy (THROW): the length of the throw and its style, set feet, on
    // the move toward, across or away from the throw, and pressure. The error
    // lands long or short and to either side.
    const length = Math.max(0, dist(qb, target) - THROW.crisp) * THROW.far[intent.style];
    const nearest = Math.min(...this.defense.map(d => dist(d, qb)));
    const pressure = clamp((THROW.near - nearest) / (THROW.near - THROW.close), 0, 1);
    const then = this.perceive('QB', THROW.settle);
    let vx = qb.vx, vz = qb.vz, pace = Math.hypot(vx, vz);
    if (Math.hypot(then.vx, then.vz) * THROW.reset > pace) { vx = then.vx * THROW.reset; vz = then.vz * THROW.reset; pace = Math.hypot(vx, vz); }
    const aim = scaled(target.x - qb.x, target.z - qb.z, 1), ux = aim === ZERO ? 0 : aim.x, uz = aim === ZERO ? 1 : aim.z;
    const along = pace > 0.3 ? (vx * ux + vz * uz) / pace : 0;
    const per7 = along >= 0 ? THROW.across + (THROW.toward - THROW.across) * along : THROW.across + (THROW.away - THROW.across) * -along;
    const spread = THROW.set + length + pace / 7 * per7 + pressure * THROW.pressure;
    // `wide` is drawn in the play's frame, so a flipped rep misses to the
    // mirrored side.
    const long = (this.random() - 0.5) * spread, wide = (this.random() - 0.5) * spread * this.playSide();
    const error = { x: ux * long + uz * wide, z: uz * long - ux * wide };
    // Placement (PLACE): away from the defenders, the miss folded the same way.
    const place = this.placement(qb, p, target, duration, ux, uz), into = error.x * place.ux + error.z * place.uz;
    if (into < 0) { error.x -= 2 * into * place.k * place.ux; error.z -= 2 * into * place.k * place.uz; }
    target.x += intent.lead.x * 2.5 + error.x + place.ux * PLACE.shift * place.k;
    target.z += intent.lead.z * 2.5 + error.z + place.uz * PLACE.shift * place.k;
    target.x = clamp(target.x, -29, 29); target.z = clamp(target.z, 0, 119);
    this.qbFacing = null;
    // The ball leaves the throwing (right) hand, a little ahead of the body,
    // and comes in at the receiver's far shoulder. He throws (and carries)
    // right-handed on a flipped play too: the one intended asymmetry.
    const fx = Math.sin(qb.facing), fz = Math.cos(qb.facing), hands = PLACE.hands * place.k;
    const from = { x: qb.x + fz * 0.25 + fx * 0.35, y: 1.85, z: qb.z - fx * 0.25 + fz * 0.35 };
    const to = { x: clamp(target.x + place.ux * hands, -29.5, 29.5), y: PLACE.catch[intent.style], z: clamp(target.z + place.uz * hands, 0, 119.5) };
    const v = flightVelocity(from, to, duration);
    this.ball = { ...from, vx: v.x, vy: v.y, vz: v.z };
    this.pass = { target: { ...target, y: to.y }, receiver: p.id, duration, elapsed: 0, style: intent.style, pressure, spread, error, place, distance: Math.hypot(to.x - from.x, to.z - from.z), attempted: new Set() };
    this.threw = true; this.stats.attempts++; this.phase = 'air'; this.carrier = null; this.throwIntent = null;
    this.events.push('throw');
  }

  // Where to put the ball against the defenders around the catch (PLACE):
  // the unit direction away from them (`ux`, `uz`) and how hard they push
  // it there (`k`, 0 to 1), for a throw to `p` meeting him at `target`
  // after `duration` s; (ux, uz) is the throw's direction.
  placement(qb, p, target, duration, ux, uz) {
    const len = clamp((dist(qb, target) - PLACE.from) / (PLACE.full - PLACE.from), 0, 1), carry = Math.min(duration, PLACE.carry);
    // The receiver's run to the catch, on average.
    const rx = (target.x - p.x) / duration, rz = (target.z - p.z) / duration;
    let vx = 0, vz = 0;
    if (len > 0) for (const d of this.defense) {
      // From his spot at the catch to the catch point.
      let gx = p.x - d.x + (rx - d.vx) * carry, gz = p.z - d.z + (rz - d.vz) * carry, g = Math.hypot(gx, gz);
      const gap = Math.max(0, g - PLACE.adjust * d.top * Math.max(0, duration - PLACE.react));
      const w = clamp((PLACE.near - gap) / (PLACE.near - PLACE.tight), 0, 1);
      if (!w) continue;
      // Carried on right onto the spot, he comes from where he is now.
      if (g < 0.3) { gx = p.x - d.x; gz = p.z - d.z; g = Math.hypot(gx, gz); }
      if (g > 1e-6) { vx += w * gx / g; vz += w * gz / g; }
    }
    const m = Math.hypot(vx, vz);
    if (m < 1e-6) return { ux: 0, uz: 0, k: 0 };
    // In the throw's frame: along it (beyond the receiver +) and across it
    // (toward the near sideline +).
    let nx = uz, nz = -ux;
    if (nx * (target.x - this.pocketX()) < 0) { nx = -nx; nz = -nz; }
    let a = (vx * ux + vz * uz) / m, l = (vx * nx + vz * nz) / m;
    if (a > 0) { l += (Math.abs(l) > 0.2 ? Math.sign(l) : 1) * a; a = 0; }
    const sx = a * ux + l * nx, sz = a * uz + l * nz, s = Math.hypot(sx, sz) || 1;
    return { ux: sx / s, uz: sz / s, k: Math.min(1, m) * len };
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
    this.planReceivers(dt);
    this.planHandoff();
    this.planDefense(dt);
    this.moveAll(dt);
    if (this.phase === 'tackle') this.dragTackle(dt);
    this.separate();
    this.updateBodies(dt);
    if (this.carrier === 'QB' && this.byId.QB.z > this.spot + 0.3) this.crossedLine = true;
    this.recordTrails();
    // A quarterback who steps over the line during the wind-up pulls the
    // ball down (requestThrow refuses past the line too).
    if (this.throwIntent && this.crossedLine) {
      this.throwIntent = null;
      const qb = this.byId.QB;
      qb.action = this.restingAction(qb); qb.actionTime = 0;
    } else if (this.throwIntent && this.time >= this.throwIntent.at) this.release();
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
    // Untouched, the quarterback runs his drop (planPasser).
    if (p.id === 'QB' && this.phase === 'live' && !this.crossedLine) this.planPasser(p, amount);
  }


  planReceivers(dt = STEP) {
    const run = this.play.type === 'run', reading = !run && !this.completed && (this.phase === 'live' || this.phase === 'air');
    if (reading) this.readCoverage(dt);
    for (const id of RECEIVERS) {
      const p = this.byId[id];
      if (this.carrier === id) continue;
      p.sprinting = true;
      if (this.time < GET_OFF[p.role]) { p.want = ZERO; continue; }
      if (this.phase === 'air' && this.pass.receiver === id && this.pass.elapsed > 0.12) {
        p.want = this.jammed(p, meetWant(p, this.pass.target, (this.pass.duration || 0) - this.pass.elapsed, speedCap(p)));
        continue;
      }
      // A back who picked up a blitzer stays in to block (see protect).
      if (p.pickup) { p.sprinting = false; continue; }
      // On runs, and once a pass is caught, the other receivers block.
      const blocking = (run && id !== 'R') || (this.completed && this.phase !== 'air');
      if (blocking && this.blockDownfield(p)) continue;
      p.want = reading ? this.runRoute(p, speedCap(p)) : routeWant(p, speedCap(p));
    }
  }

  // Receivers blocking (DOWNFIELD): take the nearest defender in front of
  // them who matters to the play, and hold him for a stalk block's length.
  blockDownfield(p) {
    let defender = null, best = Infinity;
    for (const d of this.defense) if (d.z > p.z - 1 && d.action !== 'tackle' && d.id !== p.blockDone && dist(d, p) < best) { best = dist(d, p); defender = d; }
    const c = this.guardPoint();
    if (!defender || best >= DOWNFIELD.range || dist(defender, c) > DOWNFIELD.near) return false;
    if (best < DOWNFIELD.engage && !defender.engaged && this.time < defender.shed + 0.9) {
      if (p.blockOn !== defender.id) { p.blockOn = defender.id; p.blockAt = this.time; }
      // The block is over: he lets his man go and eases off.
      if (this.time - p.blockAt > DOWNFIELD.hold) { p.blockDone = defender.id; p.want = ZERO; p.sprinting = false; return true; }
      this.engage(p, defender);
    }
    const away = scaled(c.x - defender.x, c.z - defender.z, 0.9);
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


  // ---------------------------------------------------------------------------
  // Receivers against the coverage (see READ). Once a step, live: what the
  // defense looked like READ.latency s ago (seenDefense), the safety shell,
  // each route runner's man-or-zone score and the scramble drill.
  readCoverage(dt) {
    const L = READ.latency, spot = this.spot, x0 = this.pocketX();
    this.seenDefense = this.defense.map(d => {
      const s = this.perceive(d.id, L);
      return { id: d.id, x: s.x, z: s.z, vx: s.vx, vz: s.vz, cover: !d.rushing && !d.engaged && d.action !== 'tackle' && d.action !== 'down' };
    });
    let shell = 0;
    for (const s of this.seenDefense) if (s.cover && s.z > spot + SHELL.depth && Math.abs(s.x - x0) < SHELL.width) shell++;
    this.shell = shell;
    for (const id of RECEIVERS) {
      const p = this.byId[id];
      if (p.pickup || this.carrier === id || this.time < GET_OFF[p.role]) continue;
      const me = this.perceive(id, L), speed = Math.hypot(me.vx, me.vz);
      if (speed < READ.moving) continue;
      let near = null, gap = READ.near;
      for (const s of this.seenDefense) {
        const g = s.cover ? Math.hypot(s.x - me.x, s.z - me.z) : Infinity;
        if (g < gap) { gap = g; near = s; }
      }
      let e = 0;
      if (near) {
        const closing = gap > 1e-6 ? ((me.vx - near.vx) * (near.x - me.x) + (me.vz - near.vz) * (near.z - me.z)) / gap : 0;
        e = clamp((READ.near - gap) / (READ.near - READ.tight), 0, 1) * (1 - clamp(Math.abs(closing) / (READ.approach * speed), 0, 1));
      }
      p.manRead += (e - p.manRead) * Math.min(1, dt / READ.tau);
    }
    this.checkDrill();
  }

  // Start the scramble drill once the quarterback is out of the pocket off
  // script, and keep it pointed at the side he is on.
  checkDrill() {
    const qb = this.byId.QB, off = qb.x - this.pocketX();
    if (this.drillAt !== null) {
      if (Math.abs(off) > 2) this.drillSide = Math.sign(off);
      return;
    }
    if (this.phase !== 'live' || this.carrier !== 'QB' || this.crossedLine || !this.scrambling()) return;
    const boot = this.dropPlan?.boot;
    if (boot && Math.sign(off) === boot) return;
    this.drillAt = this.time; this.drillSide = Math.sign(off) || this.playSide();
    const runners = RECEIVERS.map(id => this.byId[id]).filter(p => !p.pickup && this.carrier !== p.id);
    for (const deep of [false, true]) {
      const group = runners.filter(p => (p.z - this.spot >= DRILL.split) === deep);
      group.sort((a, b) => a.x * this.drillSide - b.x * this.drillSide || RECEIVERS.indexOf(a.id) - RECEIVERS.indexOf(b.id));
      group.forEach((p, lane) => { p.drillDeep = deep; p.drillLane = lane; p.drillZ = p.z; p.sitting = false; });
    }
  }

  // One route runner's wanted velocity. The same code runs the live receiver
  // and the ghost that predict() runs ahead (p.ghost): it changes only the
  // runner's own fields (a new route is a new array, never an edit) and draws
  // no random numbers, so a ghost leaves the rep exactly as it found it.
  // `clock` is the time the runner is at (later than now for a ghost).
  runRoute(p, cap, clock = this.time) {
    if (!p.route.length) return ZERO;
    let want;
    if (this.drillAt !== null && clock >= this.drillAt + READ.latency) want = this.drillWant(p, cap);
    else {
      this.passTeammate(p);
      this.readRoute(p, clock);
      const last = p.route.length - 1, end = p.route[last];
      if (p.sitting) want = seekWant(p, { x: p.sitX, z: p.sitZ }, cap * (p.workBack ? LATE.effort : 1));
      else {
        want = routeWant(p, cap);
        if (p.routeIndex >= last && dist(p, end) < 0.6 && (!RUNS_ON.has(p.kind) || p.extended)) { p.sitting = true; p.sitX = end.x; p.sitZ = end.z; }
        want = this.avoidWant(p, want, clock);
      }
    }
    return this.jammed(p, want, clock);
  }

  // A jam (JAM) damps a receiver's wanted velocity and pushes him across
  // while it lasts, whether he runs his route or to a ball in the air.
  jammed(p, want, clock = this.time) {
    return clock < p.jamUntil ? { x: want.x * JAM.damp + p.jamSide * JAM.push, z: want.z * JAM.damp } : want;
  }

  // The decisions along a route (see SIT, BEND and LATE), each taken once.
  readRoute(p, clock) {
    const spot = this.spot, last = p.route.length - 1, end = p.route[last];
    if (p.kind === 'sit' && !p.mode && p.routeIndex >= p.key) {
      if (p.legAt < 0) p.legAt = clock;
      if (clock - p.legAt >= SIT.look || dist(p, end) < SIT.arrive) this.sitOrRun(p, clock);
    }
    else if (p.kind === 'cross' && p.routeIndex >= p.key && !p.sitting) this.findHole(p);
    else if (p.kind === 'seam' && !p.converted && p.z - spot >= BEND.at && p.routeIndex <= p.key) this.bendSeam(p, clock);
    else if (p.kind === 'post' && !p.converted && p.routeIndex >= p.key) this.skinnyPost(p);
    if (p.sitting && p.kind === 'cross' && !p.workBack && this.crowded(p.sitX, p.sitZ, SIT.crowd)) { p.sitting = false; p.noSit = true; }
    if (p.sitting && p.kind === 'sit' && p.mode === 'zone') this.slide(p, clock);
    if (!p.sitting && !p.workBack && VERTICAL.has(p.kind) && clock >= LATE.at && p.z - spot > LATE.depth && this.crowded(p.x, p.z, LATE.covered)) {
      const qb = this.byId.QB, back = scaled(qb.x - p.x, qb.z - p.z, LATE.back);
      p.workBack = p.sitting = true; p.sitX = p.x + back.x; p.sitZ = p.z + back.z;
    }
    if (!p.extended && !p.sitting && RUNS_ON.has(p.kind) && p.routeIndex >= p.route.length - 1) this.extendRoute(p);
  }

  // A coverage defender (as seen) within `room` yd of a spot.
  crowded(x, z, room) {
    for (const s of this.seenDefense) if (s.cover && Math.hypot(s.x - x, s.z - z) < room) return true;
    return false;
  }

  // A coverage defender will be on the spot a receiver is heading for: within
  // SIT.contest yd of it when he gets there, running on at the velocity seen
  // (a ghost runs the defense on from now), or driving on it (SIT).
  spotTaken(p, spot, clock) {
    const speed = Math.max(2, Math.hypot(p.vx, p.vz)), ahead = clock - this.time + Math.min(SIT.ahead, dist(p, spot) / speed);
    for (const s of this.seenDefense) {
      if (!s.cover) continue;
      const g = Math.hypot(s.x - spot.x, s.z - spot.z);
      if (Math.hypot(s.x + s.vx * ahead - spot.x, s.z + s.vz * ahead - spot.z) < SIT.contest) return true;
      if (g < SIT.driveFrom && g > 1e-6 && (s.vx * (spot.x - s.x) + s.vz * (spot.z - s.z)) / g > SIT.drive) return true;
    }
    return false;
  }

  // The nearest coverage defender (as seen) to a spot, or null.
  nearestSeen(x, z) {
    let near = null, gap = Infinity;
    for (const s of this.seenDefense) {
      const g = s.cover ? Math.hypot(s.x - x, s.z - z) : Infinity;
      if (g < gap) { gap = g; near = s; }
    }
    return near;
  }

  // Sitting in a zone hole: slide away from a defender who closes on it (SIT).
  slide(p, clock) {
    const end = p.route[p.route.length - 1], near = this.nearestSeen(p.sitX, p.sitZ);
    if (!near || clock - p.slideAt < SIT.every || Math.hypot(near.x - p.sitX, near.z - p.sitZ) >= SIT.crowd) return;
    const side = Math.abs(near.x - p.sitX) > 0.2 ? Math.sign(p.sitX - near.x) : Math.sign(this.pocketX() - p.sitX) || this.playSide();
    const x = clamp(p.sitX + side * SIT.slide, end.x - SIT.shift, end.x + SIT.shift);
    if (Math.abs(x - p.sitX) < 0.3) return;
    p.sitX = clamp(x, -LATE.edge, LATE.edge); p.slideAt = clock;
  }

  // A sit route at its decision point: settle in the hole against zone, keep
  // running away from his man against man (SIT).
  sitOrRun(p, clock) {
    const end = p.route[p.route.length - 1], man = p.manRead > READ.man || this.spotTaken(p, end, clock);
    p.mode = man ? 'man' : 'zone';
    if (!man) { p.sitting = true; p.sitX = end.x; p.sitZ = end.z; return; }
    // Away from his leverage; with the man straight behind him, the way the
    // route breaks, or toward the middle of the field.
    const near = this.nearestSeen(p.x, p.z), x0 = this.pocketX(), from = p.route.length > 1 ? p.route[p.route.length - 2] : p.start;
    let side = near && Math.abs(p.x - near.x) > SIT.leverage ? Math.sign(p.x - near.x) : Math.abs(end.x - from.x) > 0.5 ? Math.sign(end.x - from.x) : -Math.sign(p.x - x0) || this.playSide();
    if (Math.abs(p.x + side * SIT.away) > LATE.edge) side = -side;
    const to = { x: clamp(p.x + side * SIT.away, -LATE.edge, LATE.edge), z: Math.max(this.spot + 1, p.z - SIT.back) };
    p.route = [...p.route.slice(0, p.routeIndex), to];
    p.kind = Math.sign(to.x - x0) === Math.sign(p.x - x0) && Math.abs(to.x - x0) > Math.abs(p.x - x0) ? 'out' : 'cross';
    p.key = p.routeIndex;
  }

  // A crosser against zone settles in the first hole on his way (SIT).
  findHole(p) {
    if (p.noSit || p.mode === 'man' || p.manRead > READ.man || p.z - this.spot > SIT.deep) return;
    const from = p.key ? p.route[p.key - 1] : p.start;
    if (dist(p, from) < SIT.run) return;
    const speed = Math.hypot(p.vx, p.vz), stop = speed * speed / (2 * 0.85 * p.brake);
    const x = speed > 0.5 ? p.x + p.vx / speed * stop : p.x, z = speed > 0.5 ? p.z + p.vz / speed * stop : p.z;
    if (Math.abs(x) > LATE.edge) return;
    for (const s of this.seenDefense) {
      if (!s.cover) continue;
      const g = Math.hypot(s.x - x, s.z - z);
      if (g < SIT.room || (g > 1e-6 && ((x - s.x) * s.vx + (z - s.z) * s.vz) / g > SIT.closing)) return;
    }
    p.mode = 'zone'; p.sitting = true; p.sitX = x; p.sitZ = z;
  }

  // A seam splits the deep defenders (BEND).
  // (A ghost runs the deep defenders on at the velocity seen, for at most a
  // second, to the moment it reaches the read.)
  bendSeam(p, clock) {
    p.converted = true;
    const lag = Math.min(1, clock - this.time);
    let lo = -WIDTH / 2, hi = WIDTH / 2;
    for (const s of this.seenDefense) {
      const sx = s.x + s.vx * lag, sz = s.z + s.vz * lag;
      if (!s.cover || sz < p.z + SHELL.over || Math.hypot(sx - p.x, sz - p.z) < SHELL.own) continue;
      if (sx <= p.x) lo = Math.max(lo, sx); else hi = Math.min(hi, sx);
    }
    const end = p.route[p.key], x0 = this.pocketX(), side = Math.sign(end.x - x0) || this.playSide();
    let x = clamp((lo + hi) / 2, end.x - BEND.bend, end.x + BEND.bend);
    if ((x - x0) * side < BEND.hash) x = x0 + side * BEND.hash;
    p.route = p.route.map((q, i) => (i === p.key ? { x, z: q.z } : q));
  }

  // A post against a single-high safety narrows to a skinny post (BEND).
  skinnyPost(p) {
    p.converted = true;
    if (this.shell !== 1) return;
    const brk = p.key ? p.route[p.key - 1] : p.start;
    p.route = p.route.map((q, i) => (i >= p.key ? { x: brk.x + (q.x - brk.x) * BEND.skinny, z: q.z } : q));
  }

  // Out of landmarks, a crosser or a vertical runs on along his last leg
  // (LATE.edge, LATE.deep).
  extendRoute(p) {
    p.extended = true;
    const n = p.route.length, b = p.route[n - 1], a = n > 1 ? p.route[n - 2] : p.start;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) return;
    const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    let s = Infinity;
    if (Math.abs(ux) > 1e-6) s = ((ux > 0 ? 1 : -1) * LATE.edge - b.x) / ux;
    if (uz > 1e-6) s = Math.min(s, (Math.min(118, this.spot + LATE.deep) - b.z) / uz);
    if (s > 1 && Number.isFinite(s)) p.route = [...p.route, { x: b.x + ux * s, z: b.z + uz * s }];
  }

  // The quarterback standing on a landmark (the mesh of a fake): the back
  // takes it as reached instead of running into him.
  passTeammate(p) {
    const to = p.route[p.routeIndex], qb = this.byId.QB;
    if (p.routeIndex < p.route.length - 1 && dist(qb, to) < 0.7 && dist(p, to) < 1.4) p.routeIndex++;
  }

  // Step around a defender in his path (AVOID). The side is kept while the
  // same man is in the way, so he does not dither between two.
  avoidWant(p, want, clock) {
    const speed = Math.hypot(want.x, want.z), lag = clock - this.time;
    if (speed < 2 || lag > AVOID.lookahead) return want;
    const ux = want.x / speed, uz = want.z / speed, nx = uz, nz = -ux;
    let best = null, ahead = AVOID.ahead, bx = 0, bz = 0, lat = 0;
    for (const d of this.defense) {
      if (d.action === 'tackle' || d.action === 'down') continue;
      const dx = d.x + d.vx * lag - p.x, dz = d.z + d.vz * lag - p.z, a = dx * ux + dz * uz, l = dx * nx + dz * nz;
      if (a <= 0.15 || a >= ahead || Math.abs(l) >= AVOID.width || (p.vx - d.vx) * ux + (p.vz - d.vz) * uz < AVOID.closing) continue;
      best = d; ahead = a; bx = dx; bz = dz; lat = l;
    }
    if (!best) { p.avoidId = null; return want; }
    if (p.avoidId !== best.id || !p.avoidSide) {
      const next = p.route[Math.min(p.routeIndex + 1, p.route.length - 1)];
      const toward = (next.x - p.x) * nx + (next.z - p.z) * nz;
      // Head-up on a straight leg he steps to the outside (the side of the
      // ball he is on, in the frame of the normal).
      p.avoidSide = Math.abs(lat) > 0.1 ? -Math.sign(lat) : Math.sign(toward) || Math.sign((p.x - this.pocketX()) * nx) || this.playSide();
      p.avoidId = best.id;
    }
    // He gives up at most AVOID.off yd of his line: a man who keeps walling
    // him off is run into (and pushed through), not followed across the field.
    const ax = p.x + bx + nx * p.avoidSide * AVOID.clear, az = p.z + bz + nz * p.avoidSide * AVOID.clear;
    const to = p.route[p.routeIndex], line = project(p.routeIndex ? p.route[p.routeIndex - 1] : p.start, to, { x: ax, z: az });
    if (line.len > 1e-6 && Math.abs((ax - line.x) * line.uz - (az - line.z) * line.ux) > AVOID.off) return want;
    return scaled(ax - p.x, az - p.z, speed);
  }

  // The scramble drill (DRILL): work to the quarterback's side.
  drillWant(p, cap) {
    const qb = this.byId.QB, side = this.drillSide, spot = this.spot;
    const x = qb.x + side * ((p.drillDeep ? DRILL.deepLead : DRILL.lead) + DRILL.gap * p.drillLane);
    const z = p.drillDeep ? Math.max(spot + DRILL.deep, p.drillZ + DRILL.climb) : clamp(p.drillZ, spot + DRILL.low, spot + DRILL.high);
    return seekWant(p, { x: clamp(x, -DRILL.edge, DRILL.edge), z: Math.min(118, z) }, cap);
  }

  // A press defender gets his hands on a receiver at the line (JAM). Called
  // by the coverage with the two players (or their ids) and how long the jam
  // lasts; draws two numbers from the seeded stream. Returns whether it took.
  jam(receiver, defender, seconds = 0.4) {
    const r = typeof receiver === 'string' ? this.byId[receiver] : receiver;
    const d = typeof defender === 'string' ? this.byId[defender] : defender;
    if (!r || !d || !RECEIVERS.includes(r.id) || r.team !== 'offense' || this.phase !== 'live' || this.carrier === r.id || this.time < r.jamUntil) return false;
    const side = Math.abs(r.x - d.x) > 0.2 ? Math.sign(r.x - d.x) : Math.sign(r.x - this.pocketX()) || this.playSide();
    const win = this.random(), how = this.random();
    r.jamSide = side;
    if (win < JAM.clean) { r.jamUntil = this.time + seconds * JAM.quick; return true; }
    const cost = JAM.cost[0] + (JAM.cost[1] - JAM.cost[0]) * how, shift = side * (JAM.shift[0] + (JAM.shift[1] - JAM.shift[0]) * how);
    r.jamUntil = this.time + seconds + cost;
    r.route = r.route.map((q, i) => (i === r.routeIndex && q.z < this.spot + JAM.depth ? { x: clamp(q.x + shift, -LATE.edge, LATE.edge), z: q.z } : q));
    this.events.push('jam');
    return true;
  }

  // ---------------------------------------------------------------------------
  // The quarterback's drop (DROP, FAKE, BOOT): planned at reset from the
  // formation and the call.
  planDrop() {
    if (this.play.type === 'run') return null;
    const qb = this.byId.QB, under = this.spot - qb.start.z < 2.5;
    const quick = this.play.family === 'quick' || /quick/i.test(this.play.tag || '');
    const plan = { x: qb.start.x, depth: under ? DROP.centre : quick ? DROP.quick : DROP.gun, open: under, mesh: null, boot: 0 };
    const r = this.byId.R, first = r.route[0];
    if (this.play.type !== 'pa' || !first) return plan;
    const next = r.route[1] || first, near = project(r.start, first, qb);
    const nx = near.uz, nz = -near.ux, side = -Math.sign((next.x - first.x) * nx + (next.z - first.z) * nz) || this.playSide();
    plan.mesh = { x: near.x + nx * side * FAKE.side, z: near.z + nz * side * FAKE.side };
    plan.depth = DROP.action; plan.open = false;
    if (/boot/i.test(this.play.id + ' ' + this.play.name)) plan.boot = -Math.sign(next.x - first.x) || this.playSide();
    return plan;
  }

  // The quarterback before he throws, run or cross the line. The stick
  // always wins; untouched he runs his drop.
  planPasser(p, amount) {
    this.qbFacing = null;
    // Steered, he is not riding a fake any more (faking(), fakeShown()).
    if (amount >= 0.05) { this.qbSteered = true; this.fakeDone = true; return; }
    if (this.throwIntent || p.action === 'throw') { p.want = ZERO; p.ease = DROP.plant; return; }
    if (this.qbSteered) { p.want = ZERO; p.ease = DROP.reset; return; }
    const plan = this.dropPlan, r = this.byId.R;
    if (!plan) return;
    if (plan.mesh && !this.fakeDone) {
      const gap = dist(p, r);
      this.fakeNear = Math.min(this.fakeNear, gap);
      if (this.time >= FAKE.max || (this.time >= FAKE.min && (r.pickup || (this.fakeNear < FAKE.mesh && gap > this.fakeNear + FAKE.past)))) this.fakeDone = true;
      else {
        p.want = seekWant(p, plan.mesh, speedCap(p, FAKE.effort));
        this.qbFacing = Math.atan2(r.x - p.x, r.z - p.z);
        return;
      }
    }
    if (plan.boot) {
      const at = k => ({ x: this.pocketX() + plan.boot * BOOT.path[k][0], z: this.spot + BOOT.path[k][1] });
      if (this.bootLeg < BOOT.path.length - 1 && dist(p, at(this.bootLeg)) < BOOT.near) this.bootLeg++;
      const target = at(this.bootLeg), last = this.bootLeg === BOOT.path.length - 1, cap = speedCap(p, BOOT.effort);
      p.want = seekWant(p, target, cap, last ? 0 : 0.8 * cap);
      this.qbFacing = last && dist(p, target) < BOOT.near ? 0 : plan.boot * BOOT.facing;
      return;
    }
    const set = { x: plan.x, z: this.spot - plan.depth };
    p.want = seekWant(p, set, speedCap(p, plan.open ? DROP.centreEffort : DROP.effort));
    if (plan.open && dist(p, set) > DROP.setNear) this.qbFacing = DROP.open;
  }

  // Pursuit with reaction latency (plan 4.3): aim from where the target was
  // `latency` seconds ago, led along the velocity seen then toward an intercept.
  // A cut is invisible to the defender for `latency` seconds and his own
  // momentum does the rest. In the open field (pursuing(): after a catch or a
  // handoff, or a quarterback over the line) he takes an angle to the first
  // point of the carrier's path he can reach (PURSUIT); otherwise (the rush on
  // a quarterback still behind the line) the total lookahead is capped at
  // 0.6 s. `leverage` (yards, signed: + toward +x) shades the aim to the
  // defender's side of the carrier's path while he is still far away
  // (LEVERAGE).
  pursue(d, id, cap, edge = 0, leverage = 0) {
    const seen = this.perceive(id, d.latency);
    d.seen = seen;
    if (this.pursuing()) return this.pursueAngle(d, seen, cap, edge, leverage);
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

  // Open-field pursuit (PURSUIT): the earliest point of the carrier's path,
  // as the defender saw it, that he can reach in time; or, when he cannot get
  // there, a chase that keeps him inside the carrier.
  pursueAngle(d, seen, cap, edge, leverage) {
    let aim = null;
    for (let t = d.latency; t <= d.latency + PURSUIT.horizon + 1e-9; t += PURSUIT.step) {
      const q = carrierPath(seen, t);
      if (Math.hypot(q.x - d.x, q.z - d.z) <= cap * (t - d.latency) + PURSUIT.reach) { aim = q; break; }
    }
    if (!aim) {
      aim = carrierPath(seen, d.latency + PURSUIT.trail);
      if (Math.abs(aim.x) > PURSUIT.wide && Math.abs(d.x) < Math.abs(aim.x)) aim.x -= Math.sign(aim.x) * PURSUIT.force;
    }
    const shade = leverageOffset(seen, d, leverage);
    d.aim = { x: aim.x + edge + shade.x, z: aim.z + shade.z };
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
    // at the pile, shed from a block, standing) he stops. Closing is his own
    // run at the carrier, who is about to stop: a trailer who was not gaining
    // on him (one who just missed, say) still takes a spot, not a file.
    if (!pu.mode) {
      const gap = dist(d, c), running = (d.vx * (c.x - d.x) + d.vz * (c.z - d.z)) / Math.max(1e-6, gap);
      pu.mode = gap > pu.radius + PULL_UP.reach ? 'ease' : gap > PULL_UP.pileOn && running > 1 ? 'spot' : 'stop';
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
  // pushed: contact with defenders is resolved by tackling, so until a tackle
  // is tried a defender in his way is pushed aside (not run through), and
  // teammates step out of his way (except the quarterback at the mesh).
  // A quarterback still behind the line is a body in the pocket, not a
  // runner in the open field: he slides off his blockers and off a rusher
  // in a block, who hold their ground, so stepping up never moves the line.
  separate() {
    const players = this.players, carrier = this.carrier, pocket = carrier === 'QB' && this.phase === 'live' && !this.crossedLine;
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), r = (a.role === 'ol' || b.role === 'ol') ? 0.72 : 0.56;
      if (d >= r || d < 0.001) continue;
      if (a.id === carrier || b.id === carrier) {
        const other = a.id === carrier ? b : a, sign = a.id === carrier ? 1 : -1;
        if (other.id === 'QB' || (this.tackle && (other.id === this.tackle.tackler || this.tackle.helpers.has(other.id)))) continue;
        const push = (r - d) * 0.36;
        if (pocket && (other.team === 'offense' ? other.role === 'ol' || other.pickup : other.engaged || other.lock)) {
          const qb = a.id === carrier ? a : b;
          qb.x -= sign * dx / d * push; qb.z -= sign * dz / d * push;
          continue;
        }
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
    // An exact about-turn (a quarterback turning to a back straight behind
    // him, a lineman backing straight up) turns through the play side, the
    // offense's right (its left on a flipped play), so a flipped rep mirrors.
    let turn = wrapAngle(target - p.facing);
    if (Math.abs(turn) > Math.PI - 1e-9) turn = Math.PI * this.playSide() * (Math.cos(p.facing) < 0 ? -1 : 1);
    p.facing = wrapAngle(p.facing + clamp(turn, -rate, rate));
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
    // The quarterback turns to his target to throw, even on the run; on a
    // play-action fake he faces the back, and under centre he drops opened
    // up (qbFacing, planPasser); otherwise in the pocket he faces downfield.
    if (p.id === 'QB' && live && !this.crossedLine && p.z < this.spot) {
      const run = this.play.type === 'run' && !this.handoff;
      const intent = run ? null : this.throwIntent ? this.byId[this.throwIntent.id] : p.action === 'throw' && this.pass ? this.pass.target : null;
      if (intent) return toward(intent);
      if (this.qbFacing !== null && this.phase === 'live') return this.qbFacing;
      // Dropping back he keeps his eyes downfield, however fast.
      if (run ? speed < 3.5 : speed < 3.5 || p.vz < -0.3 * speed) return run ? toward(this.byId.R) : 0;
    }
    if (this.phase === 'air' && p.ballAware && dist(p, this.ball) < 4) return toward(this.ball);
    // A receiver who has settled shows the quarterback his numbers; the man
    // the ball is thrown to looks it in once he is under it.
    if (p.team === 'offense' && RECEIVERS.includes(p.id) && live && p.id !== this.carrier && speed < 3) {
      if (this.phase === 'air' && this.pass.receiver === p.id) return toward(this.ball);
      if (p.sitting || this.drillAt !== null) return toward(qb);
    }
    if (p.team === 'defense' && !p.turned && live) return toward(qb);
    return speed > 0.5 ? Math.atan2(p.vx, p.vz) : p.facing;
  }

  // Every player's recent positions: the defense reads the offense late and
  // the receivers read the defense late (perceive).
  recordTrails() {
    for (const p of this.players) this.trails.get(p.id).push(this.time, p);
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
    // Drops (plan 4.2): a base rate, and a little more for a bullet from
    // close range. A defender on him (CATCH) can knock it loose as it
    // arrives, most when he is between him and the ball: a breakup at the
    // catch. One draw decides both.
    const drop = CATCH.base + (this.pass.style === 'bullet' && this.pass.distance < CATCH.close ? CATCH.bullet : 0);
    const roll = this.random();
    if (roll < drop + this.catchContest(p)) {
      const b = this.ball, side = (this.random() - 0.5) * 2;
      this.ball = { x: b.x, y: Math.max(0.6, b.y), z: b.z, vx: p.vx * 0.3 + side, vy: 2.2, vz: p.vz * 0.3 - b.vz * 0.05 };
      if (roll < drop) { this.events.push('drop'); this.finish('Dropped', 0, 'incomplete'); }
      else { this.events.push('deflection'); this.finish('Pass broken up', 0, 'incomplete'); }
      return;
    }
    this.completed = true; this.stats.completions++;
    this.carrier = p.id; this.selected = p.id; this.phase = 'run';
    this.catchAt = this.possessionAt = this.time;
    this.holdBall(p);
    this.events.push('catch');
  }

  // How contested a catch is (CATCH): the worst defender within reach of
  // the receiver, by how close he is and whether he is between the receiver
  // and the incoming ball or trailing behind him.
  catchContest(p) {
    const b = this.ball, bx = -b.vx, bz = -b.vz, bl = Math.hypot(bx, bz);
    let worst = 0;
    for (const d of this.defense) {
      const g = dist(d, p);
      if (g >= CATCH.near || d.engaged || ['stumble', 'tackle', 'down'].includes(d.action)) continue;
      const front = bl > 0.1 && g > 1e-6 ? ((d.x - p.x) * bx + (d.z - p.z) * bz) / (bl * g) : 0;
      const close = clamp((CATCH.near - g) / (CATCH.near - CATCH.tight), 0, 1);
      worst = Math.max(worst, close * (CATCH.trail + (CATCH.front - CATCH.trail) * (front + 1) / 2));
    }
    return worst;
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
  // diving attempt from up to DIVE_REACH, at 90 % of his odds at arm's length
  // down to 70 % at full stretch.
  // Two men on him at once are not two separate coin flips: once one misses,
  // the next on the same step hits a runner already off balance (TACKLE.help).
  tryTackles(c) {
    const free = this.defense.filter(d => !d.engaged && d.action !== 'stumble' && !(dist(d, c) < DIVE_REACH && this.screened(d, c)));
    const reach = free.filter(d => dist(d, c) < REACH).sort((a, b) => dist(a, c) - dist(b, c));
    let missed = false;
    const attempt = (d, odds) => {
      const p = missed ? odds + (1 - odds) * TACKLE.help : odds;
      if (this.random() < p) { this.startTackle(d, c); return true; }
      this.brokenTackle(d, c); missed = true;
      return false;
    };
    for (const d of reach) if (attempt(d, this.tackleChance(d, c))) return;
    for (const d of free) {
      const gap = dist(d, c);
      if (gap < REACH || gap > DIVE_REACH || !this.chasing(d, c) || this.closingSpeed(d, c) > 0.5) continue;
      const stretch = (gap - REACH) / (DIVE_REACH - REACH);
      if (attempt(d, this.tackleChance(d, c) * (0.9 - 0.2 * stretch))) return;
    }
  }

  // A teammate of the runner's between a defender and him: his body is in
  // the way (within SCREEN yd of the line between them, short of both ends),
  // so the defender cannot get his hands on the runner through him.
  screened(d, c) {
    const dx = c.x - d.x, dz = c.z - d.z, len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) return false;
    for (const o of this.offense) {
      if (o === c) continue;
      const t = ((o.x - d.x) * dx + (o.z - d.z) * dz) / len2;
      if (t > 0.15 && t < 0.85 && Math.hypot(d.x + dx * t - o.x, d.z + dz * t - o.z) < SCREEN) return true;
    }
    return false;
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
    // Speed edge counts in full from behind, a quarter of it head on.
    const advantage = clamp((ds - cs) / 3, -1.5, 1.5);
    const behind = (1 + Math.cos(angle)) / 2;
    const edge = advantage * (TACKLE.square + (1 - TACKLE.square) * behind);
    // Just cut or juked: the man was set for where the runner was going.
    const sinceMove = this.time - c.lastMoveAt;
    const shaken = sinceMove < TACKLE.shakeTime && angle > 60 * DEG ? TACKLE.shaken : 0;
    // Overrun: the runner's move left a man who came in hot, across or head
    // on, on a line that no longer points at him.
    const overrun = sinceMove < TACKLE.overrunTime && ds > cs + 1 && angle > 70 * DEG && closing < ds * Math.cos(TACKLE.missAngle) ? TACKLE.overrun : 0;
    return clamp(TACKLE.base + TACKLE.speed * edge - Math.max(shaken, overrun), TACKLE.min, TACKLE.max);
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
    // The tackler hangs on at arm's length, closing to it (or easing out to
    // it) at 2 yd/s.
    const gap = Math.max(1e-6, dist(d, c)), hold = gap > 0.6 ? Math.max(0.6, gap - 2 * dt) : Math.min(0.6, gap + 2 * dt);
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
    this.noteResult(this.result);
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
      // The line is in pass protection (never on a run play).
      pocket: this.inPocket(),
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
Object.assign(Simulation.prototype, defense, coverage, protection);
