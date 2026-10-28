import { FORMATION, PLAYS, RECEIVERS, routeFor, hotRouteFor, COVERAGES } from './plays.js';

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
const SHUFFLE_SPEED = 0.88;
const JUKE = { plant: 0.25, action: 0.45, keep: 0.65, cost: 0.05, minSpeed: 2 };
const SPRINT_DRAIN = 1 / 9;            // a full tank lasts nine seconds of sprinting
const RECOVERY = 0.12;
const REACH = 0.95;                    // tackling reach, yards
const TACKLE_DECEL = 12, GANG_DECEL = 6, TACKLE_HOLD = 0.9;
const STUMBLE_TIME = 0.7, STUMBLE_SPEED = 0.3, BROKEN_KEEP = 0.8;
const BALL_REST = 0.1;                 // centre height of a ball lying on the turf
const CATCH_GRACE = 0.35;
const MESH_REACH = 1.25;               // QB to back, body centres, at the exchange              // a new carrier runs on through the catch
const GET_OFF = { ol: 0.06, qb: 0, rb: 0.1, wr: 0.18, te: 0.18, dl: 0.2, lb: 0.28, cb: 0.28, s: 0.28 };
const DIFFICULTY = {
  rookie: { latency: 0.40, speed: 0.94, ballReaction: 0.58 },
  pro: { latency: 0.28, speed: 1.0, ballReaction: 0.32 },
  allpro: { latency: 0.18, speed: 1.04, ballReaction: 0.18 },
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
const ZONES = {
  cover3: [[-11, 7], [0, 9], [11, 7], [-19, 23], [19, 23], [0, 26], [7, 12]],
  cover2: [[-8, 11], [0, 12], [8, 11], [-23, 5], [23, 5], [-12, 25], [12, 25]],
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

function createPlayer(spec, team, spot, flip, speedScale = 1) {
  const body = BODY[spec.role];
  const x = flip ? -spec.x : spec.x, z = spot + spec.z, top = spec.speed * speedScale;
  return {
    ...spec, team, x, z, y: 0, vx: 0, vz: 0,
    facing: team === 'offense' ? 0 : Math.PI,
    lean: 0, backpedal: false,
    route: [], routeIndex: 0, start: { x, z },
    stamina: 1, action: 'ready', actionTime: 0, engaged: null, shed: 0, phase: 0,
    // Physical model
    top, a0: TOP_REACH * top / body.zeroToTop, brake: body.brake, agility: body.agility, mass: body.mass,
    want: ZERO, sprinting: false, grip: 1, latAccel: 0,
    cutting: false, sinceCut: 9, lastMoveAt: -9, juke: null,
    // Coverage: `turned` is false while a defender still faces the quarterback.
    turned: team === 'offense', flip: 0,
    latency: 0, seen: null, aim: null,
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
function moveBody(p, wx, wz, dt, { grip = 1, brakeScale = 1 } = {}) {
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
  let lateral = p.agility * grip * (p.flip > 0 ? 0.5 : 1) * (1 + PLANT_GRIP * Math.max(0, 1 - speed / top));
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
    this.config = { spot: 35, offense: 'random', coverage: 'random', difficulty: 'pro', mode: 'reps', flip: false, ...options };
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
    this.handoff = false; this.crossedLine = false; this.tackler = null; this.tackle = null;
    this.selected = 'QB'; this.carrier = 'QB'; this.jukeCooldown = 0;
    this.recording = []; this.recordClock = 0;
    this.completed = false; this.threw = false; this.events = [];
    this.catchAt = 0; this.possessionAt = 0;
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
    this.players = FORMATION.map(p => createPlayer(p, 'offense', this.spot, flip));
    this.players.push(...this.alignment.map(p => createPlayer({ ...p, z: Math.min(p.z, 118 - this.spot) }, 'defense', this.spot, flip, this.skill.speed)));
    this.players.forEach(p => {
      p.shed = 2.5 + this.random() * 2.8;
      p.route = routeFor(this.effectivePlay, p.id, this.spot, flip);
      if (p.team === 'defense') p.latency = this.skill.latency;
    });
    this.byId = Object.fromEntries(this.players.map(p => [p.id, p]));
    this.offense = this.players.filter(p => p.team === 'offense');
    this.defense = this.players.filter(p => p.team === 'defense');
    this.line = this.offense.filter(p => p.role === 'ol');
    this.trails = new Map(this.offense.map(p => [p.id, new Trail()]));
    this.ball = { x: 0, y: BALL_REST, z: this.spot, vx: 0, vy: 0, vz: 0 };
    this.lastBall = { ...this.ball };
    this.saveFrame();
  }

  get effectivePlay() {
    const hot = Object.fromEntries(Object.entries(this.hotRoutes).map(([id, kind]) => [id, hotRouteFor(id, kind)]));
    return { ...this.play, routes: { ...this.play.routes, ...hot } };
  }

  setHotRoute(id, kind) {
    if (this.phase !== 'presnap' || this.play.type === 'run' || !RECEIVERS.includes(id) || (kind !== 'default' && !hotRouteFor(id, kind))) return false;
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
    this.pass = { target: to, receiver: p.id, duration, elapsed: 0, style: intent.style, pressure, distance: Math.hypot(to.x - from.x, to.z - from.z) };
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
    this.planBlocking();
    this.planReceivers();
    this.planHandoff();
    this.planDefense();
    this.moveAll(dt);
    if (this.phase === 'tackle') this.dragTackle(dt);
    this.separate();
    this.updateBodies(dt);
    if (this.carrier === 'QB' && this.byId.QB.z > this.spot + 0.3) this.crossedLine = true;
    this.recordTrails();
    if (this.throwIntent && this.time >= this.throwIntent.at) this.release();
    if (this.phase === 'air') this.flyBall(dt);
    this.checkCarrier();
    if (this.time > 22 && this.phase !== 'dead') this.finish('Rep complete', this.carrier ? this.byId[this.carrier].z - this.spot : 0, 'timeout');
    this.recordClock += dt;
    if (this.recordClock >= 0.05) { this.recordClock -= 0.05; this.saveFrame(); }
  }

  tickActions(dt) {
    for (const p of this.players) {
      p.actionTime = Math.max(0, p.actionTime - dt);
      if (!p.actionTime && p.action !== 'wrapped') p.action = this.restingAction(p);
      p.engaged = null;
      p.want = ZERO; p.sprinting = false;
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

  // Pass protection and run blocking share one engagement model: each lineman
  // takes the nearest free defender, and the pair locks up until the
  // defender's shed time. Locked defenders drive toward the ball slowly.
  planBlocking() {
    const run = this.play.type === 'run', guard = this.guardPoint();
    if (this.time < GET_OFF.ol) return;
    const assigned = this.assignBlocks();
    for (const o of this.line) {
      const d = assigned.get(o.id);
      if (!d) continue;
      if (dist(o, d) < 1.55 && this.time < d.shed + (run ? 0.9 : 0) && d.action !== 'stumble') this.engage(o, d);
      let target;
      if (o.engaged) {
        // Stay square between the defender and the ball.
        const away = scaled(guard.x - d.x, guard.z - d.z, 0.95);
        target = { x: d.x + away.x, z: d.z + away.z };
      } else if (run) target = { x: d.x + (this.config.flip ? -1 : 1) * 0.2, z: d.z - 0.7 };
      else target = { x: d.x, z: Math.min(this.spot - 0.7, d.z - 0.8) };
      o.want = seekWant(o, target, speedCap(o, run ? 0.85 : 0.5));
      o.sprinting = false;
    }
  }

  // Blocking assignments: the closest lineman-defender pairs are matched
  // first, so two linemen never take the same man and nobody leaves a rusher
  // to his neighbour. A lineman keeps his man unless another is much closer.
  assignBlocks() {
    const pairs = [];
    for (const o of this.line) for (const d of this.defense) {
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
      if (run && id !== 'R' && this.blockDownfield(p)) continue;
      p.want = routeWant(p, speedCap(p));
    }
  }

  // Run plays: receivers take the nearest defender in front of them.
  blockDownfield(p) {
    let defender = null, best = Infinity;
    for (const d of this.defense) if (d.z > p.z - 1 && dist(d, p) < best) { best = dist(d, p); defender = d; }
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
    if ((this.time > 0.4 && dist(qb, rb) < MESH_REACH) || this.time > 0.75) {
      this.handoff = true; this.carrier = 'R'; this.selected = 'R'; this.phase = 'run';
      this.possessionAt = this.time;
      rb.action = 'carry'; rb.actionTime = 0.3;
      this.events.push('handoff');
    }
  }

  planDefense() {
    const pursuit = this.phase === 'run' || this.phase === 'tackle' || this.crossedLine || (this.play.type === 'run' && this.time > 0.8);
    const rushers = COVERAGES[this.coverage].rushers;
    this.defense.forEach((d, i) => {
      d.sprinting = true;
      if (this.phase === 'tackle' && d.id === this.tackle.tackler) return;
      if (this.phase === 'tackle' && this.tackle.helpers.has(d.id)) {
        const c = this.byId[this.carrier];
        d.want = { x: c.vx, z: c.vz };
        return;
      }
      if (this.time < GET_OFF[d.role]) { d.want = ZERO; return; }
      if (d.engaged) { this.drivePast(d); return; }
      if (pursuit) { this.turnHips(d); d.want = this.pursue(d, this.carrier || 'R', speedCap(d)); return; }
      if (i < rushers) {
        d.turned = true;
        const edge = i === 0 || i === 3 ? Math.sign(d.start.x) * 1.5 * Math.max(0, 1 - this.time * 0.35) : 0;
        d.want = this.pursue(d, 'QB', speedCap(d, 0.92), edge);
        return;
      }
      const cover = this.cover(d, i);
      if (this.phase === 'air' && this.pass.elapsed > this.skill.ballReaction && dist(d, this.pass.target) < 15) {
        this.turnHips(d);
        d.want = meetWant(d, this.pass.target, (this.pass.duration || 0) - this.pass.elapsed, speedCap(d));
        return;
      }
      if (!d.turned) this.readThreat(d, cover.threat);
      d.want = this.backpedalLimit(d, cover.want);
    });
  }

  // A blocked defender keeps driving toward the ball at a walking pace.
  drivePast(d) {
    const goal = this.guardPoint(), run = this.play.type === 'run' || this.phase === 'run';
    d.want = scaled(goal.x - d.x, goal.z - d.z, run ? 0.3 : 0.6);
    d.sprinting = false;
  }

  // Pursuit with reaction latency (plan 4.3): aim from where the target was
  // `latency` seconds ago, led along the velocity seen then toward an intercept,
  // with the total lookahead capped at 0.6 s. A cut is invisible to the
  // defender for `latency` seconds and his own momentum does the rest.
  pursue(d, id, cap, edge = 0) {
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
    d.aim = { x: seen.x + seen.vx * lead + edge, z: seen.z + seen.vz * lead };
    const dx = d.aim.x - d.x, dz = d.aim.z - d.z;
    if (Math.hypot(dx, dz) < 0.4) return trackWant(d, d.aim, { x: seen.vx, z: seen.vz }, cap);
    return scaled(dx, dz, cap);
  }

  // Zone and man coverage on the receivers as this defender perceives them.
  cover(d, i) {
    const cap = speedCap(d);
    const ids = this.coverage === 'blitz' ? MAN.blitz : MAN.base;
    if (this.coverage === 'blitz' || (this.coverage === 'man' && i < 9)) {
      const seen = this.estimate(ids[i - 4], d.latency);
      const target = { x: seen.x + seen.vx * 0.13, z: seen.z + 1.2 + seen.vz * 0.13 };
      return { want: trackWant(d, target, { x: seen.vx, z: seen.vz }, cap), threat: seen };
    }
    let zx, depth;
    if (this.coverage === 'man') { zx = (i === 9 ? -12 : 12) * (this.config.flip ? -1 : 1); depth = 24; }
    else {
      [zx, depth] = (ZONES[this.coverage] || ZONES.cover3)[i - 4];
      if (this.config.flip) zx = -zx;
    }
    let target = { x: zx, z: Math.min(115, this.spot + depth) };
    const deep = depth > 20;
    let near = null, best = Infinity;
    for (const id of RECEIVERS) {
      const r = this.estimate(id, d.latency);
      if (Math.abs(r.x - zx) < (deep ? 12 : 8) && r.z > this.spot + (deep ? 9 : -2) && dist(r, target) < best) { best = dist(r, target); near = r; }
    }
    if (!near) return { want: seekWant(d, target, cap), threat: null };
    if (deep) {
      // Stay on top: deeper than the receiver by a cushion that grows with his
      // speed, matching his vertical speed instead of waiting at the landmark.
      const z = Math.max(this.spot + depth, near.z + 2 + Math.max(0, near.vz) * 0.35);
      target = { x: zx * 0.28 + near.x * 0.72, z };
      const ahead = near.z > d.z - 8 ? Math.max(0, near.vz) : 0;
      return { want: trackWant(d, target, { x: near.vx * 0.72, z: ahead }, cap, 1.6), threat: near };
    }
    target = { x: zx * 0.28 + near.x * 0.72, z: clamp(near.z + 1, this.spot + 2, this.spot + 16) };
    return { want: seekWant(d, target, cap), threat: near };
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
  readThreat(d, threat) {
    const threatened = threat && threat.vz > 4 && threat.z > d.z - CUSHION;
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
      const started = moveBody(p, p.want.x, p.want.z, dt);
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
    if (this.tackle && p.id === this.tackle.tackler) return toward(this.byId[this.carrier]);
    if (p.id === 'QB' && live && !this.crossedLine && p.z < this.spot && speed < 3.5) {
      if (this.play.type === 'run' && !this.handoff) return toward(this.byId.R);
      const intent = this.throwIntent ? this.byId[this.throwIntent.id] : p.action === 'throw' && this.pass ? this.pass.target : null;
      return intent ? toward(intent) : 0;
    }
    if (p.team === 'defense' && !p.turned && live) return toward(qb);
    return speed > 0.5 ? Math.atan2(p.vx, p.vz) : p.facing;
  }

  recordTrails() {
    for (const p of this.offense) this.trails.get(p.id).push(this.time, p);
  }

  // ---------------------------------------------------------------------------
  // The ball.
  flyBall(dt) {
    this.lastBall = { ...this.ball };
    const b = this.ball;
    b.x += b.vx * dt; b.z += b.vz * dt; b.y += b.vy * dt - 0.5 * GRAVITY * dt * dt; b.vy -= GRAVITY * dt;
    this.pass.elapsed += dt;
    const candidates = [];
    if (this.pass.elapsed > 0.18) for (const p of this.players) {
      if (p.role === 'ol' || p.id === 'QB' || (p.team === 'defense' && p.role === 'dl' && b.y > 2)) continue;
      const near = nearestOnSegment(this.lastBall, b, p), gap = Math.hypot(near.x - p.x, near.z - p.z);
      if (gap < 0.84 && near.y > 0.55 && near.y < 2.55 && Math.abs(p.x) < WIDTH / 2 && p.z < 120) candidates.push({ p, gap });
    }
    candidates.sort((x, y) => x.gap - y.gap);
    if (candidates.length) this.catchBall(candidates[0].p);
    else if (b.y <= 0.15 || Math.abs(b.x) > WIDTH / 2 + 0.7 || b.z > 120 || b.z < 0) {
      if (b.y <= 0.15) this.restBall(b.x, b.z);
      this.finish('Incomplete', 0, 'incomplete');
    }
  }

  catchBall(p) {
    p.action = 'catch'; p.actionTime = 0.45;
    if (p.team === 'defense') {
      this.stats.ints++;
      this.events.push('interception');
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
    else if (c.z <= 10) this.finish('Safety', c.z - this.spot, 'safety');
    else if (Math.abs(c.x) > WIDTH / 2 - 0.18) this.finish('Out of bounds', c.z - this.spot, 'out');
    else if (this.phase === 'tackle') this.checkTackleEnd(c);
    else if (this.time > 0.85 && (!this.completed || this.time - this.catchAt > 0.18)) this.tryTackles(c);
  }

  // Contact (plan 4.3): every free defender within reach gets one attempt.
  tryTackles(c) {
    const reach = this.defense
      .filter(d => !d.engaged && d.action !== 'stumble' && dist(d, c) < REACH)
      .sort((a, b) => dist(a, c) - dist(b, c));
    for (const d of reach) {
      if (this.random() < this.tackleChance(d, c)) { this.startTackle(d, c); return; }
      this.brokenTackle(d, c);
    }
  }

  tackleChance(d, c) {
    const cs = Math.hypot(c.vx, c.vz), ds = Math.hypot(d.vx, d.vz);
    // Approach angle: 0° chasing from behind, 180° head on.
    const ax = ds > 1 ? d.vx / ds : c.x - d.x, az = ds > 1 ? d.vz / ds : c.z - d.z;
    const an = Math.hypot(ax, az) || 1;
    const angle = cs > 0.5 ? Math.acos(clamp((ax * c.vx + az * c.vz) / (an * cs), -1, 1)) : Math.PI / 2;
    const gap = Math.max(1e-6, dist(c, d));
    const closing = ((d.vx - c.vx) * (c.x - d.x) + (d.vz - c.vz) * (c.z - d.z)) / gap;
    const advantage = clamp((ds - cs) / 3, -1.5, 1.5);
    const shaken = this.time - c.lastMoveAt < 0.3 && angle > 60 * DEG ? 1 : 0;
    const overrun = closing > cs + 2 && angle > 70 * DEG ? 1 : 0;
    return clamp(0.78 + 0.12 * advantage - 0.25 * shaken - 0.10 * overrun, 0.30, 0.97);
  }

  startTackle(d, c) {
    const sack = this.carrier === 'QB' && !this.threw && !this.crossedLine && this.play.type !== 'run';
    // The hit: momentum is shared, so a head-on tackle stops the runner short
    // and a tackle from behind lets him fall forward.
    const k = 0.6 * d.mass / (d.mass + c.mass);
    c.vx += (d.vx - c.vx) * k; c.vz += (d.vz - c.vz) * k;
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
    this.finish(t.sack ? 'Sacked' : 'Tackled', c.z - this.spot, t.sack ? 'sack' : 'tackle');
  }

  // After the whistle players pull up instead of freezing; a loose ball falls
  // to the turf and comes to rest.
  stepDead(dt) {
    this.deadTime += dt;
    for (const p of this.players) {
      p.juke = null;
      const grounded = p.action === 'down' || p.action === 'tackle';
      moveBody(p, 0, 0, dt, { brakeScale: grounded ? 1.6 : 0.6 });
      p.cutting = false;
      this.turnBody(p, dt);
    }
    const b = this.ball;
    if (this.carrier) this.holdBall(this.byId[this.carrier]);
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
