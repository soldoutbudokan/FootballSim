import * as THREE from '../../vendor/three.module.js';
import { TAU, SIDES, clamp, lerp, smoothstep, bump, sampleTrack, wrapAngle, damp } from './math.js';
import { armAngles } from './pose.js';

// Action layer: each function modifies the locomotion base pose for one
// action of plan section 3.4 (plus 'pocket', the quarterback holding the ball
// in the pocket). Hand targets are in the chest frame, feet in the tilt frame.

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _w = new THREE.Vector3(), _perp = new THREE.Vector3();

// The ball goes in the sideline arm (right arm when the carrier is on the
// right half of the field) and stays there for the rest of the run.
function carryArm(anim, p) {
  if (anim.carryArm === undefined) anim.carryArm = p.x < -0.5 ? 0 : 1;
  return anim.carryArm;
}

// High and tight: hand cupping the nose in front of the chest, forearm along
// the ball, elbow pinned to the ribs.
function tuck(pose, i, weight = 1) {
  const side = SIDES[i];
  pose.hands[i].lerp(_w.set(side * 0.105, 0.13, 0.19), weight);
  pose.elbows[i].lerp(_w.set(side * 0.9, -1, -0.45), weight);
  pose.wrists[i].lerp(_w.set(0.55, 0, 0), weight);
}

// Lying on the ground the legs stretch out along the body (feet at full leg
// length below the hips in the tilt frame), so knees never dig into the turf.
function legsOut(anim, pose, weight, z = -0.04, lift = 0) {
  const d = anim.dims, reach = 0.985 * (d.thigh + d.shin);
  for (let i = 0; i < 2; i++) {
    _w.set(SIDES[i] * 0.12 + pose.pelvis.x, pose.pelvis.y - reach + lift, z + pose.pelvis.z);
    pose.feet[i].lerp(_w, weight);
    pose.footRot[i].x = lerp(pose.footRot[i].x, 0.9, weight);
    pose.knees[i].lerp(_w.set(SIDES[i] * 0.5, 0, 1), weight);
  }
}

// A hand flat on the ground `along` yards ahead of the body's pivot and
// `out` yards to that hand's side (for a body lying face down).
const _g = new THREE.Vector3(), _gl = { x: 0, z: 0 };
function palmDown(anim, pose, i, along, out, weight) {
  anim.rootToWorld(_w.set(SIDES[i] * out, 0, along), _gl);
  anim.worldToChest(pose, _g.set(_gl.x, 0.06, _gl.z), _w);
  pose.hands[i].lerp(_w, weight);
  pose.elbows[i].lerp(_w.set(SIDES[i], 0.3, -0.4), weight);
  pose.wrists[i].lerp(_w.set(-0.3, 0, 0), weight);
}

// Helper: point in the scene for a snapshot player's body part.
function bodyPoint(ctx, id, part, out, height = 1.0) {
  const rig = ctx.rigs.get(id);
  if (rig && rig.world[part]) return out.copy(rig.world[part]);
  const q = ctx.byId.get(id);
  return q ? out.set(q.x, height, -q.z) : null;
}

export function startAction(anim, action, data, p, ctx) {
  if (action === 'ready') { anim.carryArm = undefined; anim.catchPoint = null; }
  switch (action) {
    case 'catch':
      data.point = ctx.catchFrom ? ctx.catchFrom.clone() : anim.catchPoint ? anim.catchPoint.clone() : null;
      anim.carryArm = undefined;
      carryArm(anim, p);
      break;
    case 'throw':
      // Wind up facing downfield, follow through along the ball's flight.
      data.face = (q, c) => {
        const b = c.ball, flying = c.phase === 'air' && Math.hypot(b.vx || 0, b.vz || 0) > 1;
        const dir = anim.spec.team === 'offense' ? 1 : -1;
        return flying ? { x: q.x + b.vx, z: q.z + b.vz } : { x: q.x, z: q.z + 10 * dir };
      };
      break;
    case 'cut': plant(anim, data, 0.2); break;
    case 'juke': plant(anim, data, 0.45); break;
    case 'block':
      data.face = (q, c) => (q.engaged != null ? c.byId.get(q.engaged) : null);
      break;
    case 'tackle': {
      const target = ctx.byId.get(ctx.carrierId) || nearestOpponent(anim, p, ctx);
      data.target = target?.id;
      const dist = target ? Math.hypot(target.x - p.x, target.z - p.z) : 1;
      data.mode = anim.speed > 7.2 || dist > 1.15 ? 'dive' : 'wrap';
      data.fallAt = null;
      data.face = (q, c) => (data.target && !data.locked ? c.byId.get(data.target) : null);
      break;
    }
    case 'down':
      data.holdYaw = anim.yaw;
      data.roll = (anim.seed - 0.5) * 0.7;
      data.holding = ctx.holderId === p.id;
      break;
    case 'stumble':
      data.side = Math.abs(anim.lean) > 0.1 ? Math.sign(anim.lean) : (anim.seed < 0.5 ? 1 : -1);
      break;
  }
}

function nearestOpponent(anim, p, ctx) {
  let best = null, bestD = Infinity;
  for (const q of ctx.state.players) {
    const rig = ctx.rigs.get(q.id);
    if (!rig || rig.spec.team === anim.spec.team) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

// Where a wrap tackler comes to rest: lying parallel to the carrier (facing
// the way he falls, or the opposite way if that is the shorter turn) and
// half a yard to the side he tackled from, so the two bodies never overlap.
function landingBeside(anim, carrier, p, ctx) {
  const yaw = carrier.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
  const dx = p.x - carrier.x, dz = -p.z + carrier.z;
  const side = Math.abs(dx * rx + dz * rz) > 0.05 ? Math.sign(dx * rx + dz * rz) : (anim.seed < 0.5 ? 1 : -1);
  const same = Math.abs(wrapAngle(anim.yaw - yaw)) < Math.PI / 2;
  // Same way: beside his hips, a little ahead. Opposite: feet by his head,
  // arms around his legs.
  const along = same ? 0.25 : 1.75, lateral = 0.62 * side;
  const pivot = { x: carrier.x + fx * along + rx * lateral, z: -carrier.z + fz * along + rz * lateral };
  const holdYaw = same ? yaw : yaw + Math.PI;
  anim.data.holdYaw = holdYaw;
  // Roll toward the carrier: facing the same way from the carrier's right
  // (side > 0), the carrier is on his left (positive roll leans right).
  const roll = 0.28 * (same ? -side : side);
  return { pivot, roll };
}

// Cut and juke: the plant foot is the outside foot of the new direction. The
// direction comes from the simulation's lean, else from the turn rate or the
// sideways drift; a juke on command may only show it a few frames in, so the
// choice waits up to 0.12 s for a clear signal.
function plant(anim, data, duration) {
  data.duration = duration;
  data.dir = null;
}

function senseCut(anim, data, age) {
  if (data.dir !== null) return;
  let dir = 0;
  if (Math.abs(anim.lean) > 0.15) dir = Math.sign(anim.lean);
  else if (Math.abs(anim.turn) > 0.7) dir = Math.sign(anim.turn);
  else if (Math.abs(anim.local.x) > 0.15) dir = -Math.sign(anim.local.x);
  if (!dir && age < 0.12) return;
  data.dir = dir || (anim.seed < 0.5 ? 1 : -1);     // +1 = toward his right
  data.plant = data.dir > 0 ? 0 : 1;                 // cutting right plants the left foot
  // At speed the plant lands well ahead of the hips (that is what brakes him)
  // and the body travels over it.
  _a.set(SIDES[data.plant] * 0.3, 0, clamp(0.1 + 0.055 * anim.speed, 0.15, 0.5));
  data.foot = anim.rootToWorld(_a, { x: 0, z: 0 });
}

// Hands meet a ball approaching through the air (anticipation before the
// simulation registers the catch): both hands together, elbows soft, eyes on
// the ball. Only for a ball that passes within reach (anticipateCatches).
function reachForBall(anim, pose, p, ctx) {
  const reach = anim.reach;
  if (!reach) return;
  if (ctx.ballScene && reach.t < 1.6) anim.lookAt(pose, ctx.ballScene, 0.85 * (1 - smoothstep(1.0, 1.6, reach.t)));
  const w = (1 - smoothstep(0.18, 0.5, reach.t)) * (1 - smoothstep(0.8, 1.3, reach.dist));
  if (w <= 0) return;
  // Turn the shoulders toward the ball, then put both hands on it.
  anim.worldToTilt(pose, reach.point, _a);
  pose.spine.y += clamp(Math.atan2(_a.x, Math.max(0.05, _a.z)), -0.7, 0.7) * w;
  anim.worldToChest(pose, reach.point, _a);
  // A ball beyond the arms is met where they can get to, elbows still bent.
  const d = anim.dims, top = _d.set(0, d.shoulder[1], d.shoulder[2]), most = 0.86 * (d.upperArm + d.forearm);
  _a.sub(top);
  if (_a.length() > most) _a.setLength(most);
  _a.add(top);
  for (let i = 0; i < 2; i++) {
    _b.copy(_a); _b.x += SIDES[i] * 0.075;
    pose.hands[i].lerp(_b, w);
    pose.elbows[i].lerp(_c.set(SIDES[i] * 0.9, -0.5, -0.3), w);
    pose.wrists[i].lerp(_c.set(-0.3, 0, SIDES[i] * 0.9), w);
  }
}

// Which of his feet is the inside one (toward the quarterback), 0 = left,
// 1 = right, -1 when the quarterback is straight ahead or behind.
const _qb = new THREE.Vector3();
function insideFoot(anim, ctx) {
  const qb = ctx.byId.get(ctx.qbId);
  if (!qb) return -1;
  const local = anim.worldToRoot(_qb.set(qb.x, 0, -qb.z), _w);
  return Math.abs(local.x) < 0.6 ? -1 : local.x > 0 ? 0 : 1;
}

// Live-ball postures for a player without the ball, shown while he is doing
// nothing else (the 'run' action): an offensive lineman's pass set while the
// line protects (ctx.protect) or a two-point drive stance on runs, a
// defensive lineman's rush crouch, a coverage player's ready crouch. Weight 1
// when standing, fading out as he speeds up so the gait, the backpedal and
// the shuffle take over without a pop.
export function livePosture(anim, p, ctx) {
  const live = ctx.phase === 'live' || ctx.phase === 'air' || ctx.phase === 'run';
  if (!live || ctx.holderId === p.id) return null;
  const role = anim.spec.role, v = anim.speed;
  if (role === 'ol') {
    if (!ctx.protect) return { kind: 'drive', w: 1 - smoothstep(2.5, 5, v) };
    // He kick-slides sideways and back in his set (facing downfield, see
    // Animator.updateYaw); a run blocker firing forward during the mesh is
    // not setting.
    return { kind: 'set', w: (1 - smoothstep(3.8, 5.5, v)) * (1 - smoothstep(0.9, 2.0, p.vz || 0)) };
  }
  if (role === 'dl') return { kind: 'drive', w: 1 - smoothstep(2.5, 5, v) };
  if (role === 'cb' || role === 's' || role === 'lb') return { kind: 'cover', w: 1 - smoothstep(1.0, 2.4, v) };
  return null;
}

// Hands up in front of the chest, ready to punch (chest frame).
function handsUp(pose, d, w, x = 0.14, y = 0.1, z = 0.3) {
  for (let i = 0; i < 2; i++) {
    pose.hands[i].lerp(_w.set(SIDES[i] * x * d.torso, y, z), w);
    pose.elbows[i].lerp(_w.set(SIDES[i] * 0.45, -1, -0.35), w);
    pose.wrists[i].lerp(_w.set(-0.75, 0, 0), w);
  }
}

// Each posture moves the locomotion pose toward itself by weight w.
export const POSTURES = {
  // Pass set: knees bent and hips down, a little forward lean, hands up, the
  // inside foot forward and the outside one kicked back, weight bouncing on
  // short choppy steps when he is not sliding.
  set(anim, pose, w, p, ctx) {
    const d = anim.dims, still = 1 - smoothstep(0.15, 0.7, anim.speed);
    const chop = Math.sin(TAU * 2.6 * ctx.time + anim.seed * 6);
    pose.pelvis.y = lerp(pose.pelvis.y, d.hipY - 0.15 + 0.01 * chop * chop * still, w);
    pose.pelvis.z = lerp(pose.pelvis.z, -0.04, w);
    pose.hips.set(lerp(pose.hips.x, 0.36, w), pose.hips.y * (1 - w), pose.hips.z * (1 - w));
    pose.spine.set(lerp(pose.spine.x, 0.02, w), pose.spine.y * (1 - w), pose.spine.z * (1 - w));
    pose.head.x = lerp(pose.head.x, -0.04, w);
    const inside = insideFoot(anim, ctx);
    for (let i = 0; i < 2; i++) {
      pose.feet[i].z += w * (inside < 0 ? 0 : i === inside ? 0.08 : -0.12);
      pose.feet[i].y += 0.035 * w * still * Math.max(0, i ? -chop : chop);
      pose.knees[i].lerp(_w.set(SIDES[i] * 0.4, 0, 1), w);
    }
    handsUp(pose, d, w);
  },

  // Two-point crouch of a lineman off the ball: pads low, hands up.
  drive(anim, pose, w) {
    const d = anim.dims;
    pose.pelvis.y = lerp(pose.pelvis.y, Math.min(pose.pelvis.y, d.hipY - 0.13), w);
    pose.hips.x = lerp(pose.hips.x, Math.max(pose.hips.x, 0.5), w);
    pose.spine.x = lerp(pose.spine.x, Math.max(pose.spine.x, 0.14), w);
    pose.head.x = lerp(pose.head.x, -0.12, w);
    for (let i = 0; i < 2; i++) pose.feet[i].x += SIDES[i] * 0.06 * w;
    handsUp(pose, d, w, 0.15, 0.08, 0.33);
  },

  // Coverage ready crouch: knees bent, hips back, slight forward lean, arms
  // bent with the hands near the hips, feet staggered (inside foot up), eyes
  // where the simulation faces him. Linebackers and safeties sit lower.
  cover(anim, pose, w, p, ctx) {
    const d = anim.dims, corner = anim.spec.role === 'cb';
    pose.pelvis.y = lerp(pose.pelvis.y, Math.min(pose.pelvis.y, d.hipY - (corner ? 0.13 : 0.17)), w);
    pose.pelvis.z = lerp(pose.pelvis.z, -0.04, w);
    pose.hips.set(lerp(pose.hips.x, corner ? 0.46 : 0.52, w), pose.hips.y * (1 - w), pose.hips.z * (1 - w));
    pose.spine.set(lerp(pose.spine.x, 0.1, w), pose.spine.y * (1 - w), pose.spine.z * (1 - w));
    pose.head.set(lerp(pose.head.x, -0.04, w), pose.head.y * (1 - w), pose.head.z);
    const inside = insideFoot(anim, ctx), lead = inside < 0 ? (anim.seed < 0.5 ? 0 : 1) : inside;
    for (let i = 0; i < 2; i++) {
      pose.feet[i].x += SIDES[i] * 0.08 * w;
      pose.feet[i].z += w * (i === lead ? 0.1 : -0.1);
      if (i !== lead) pose.footRot[i].x = lerp(pose.footRot[i].x, 0.2, w);
      pose.knees[i].lerp(_w.set(SIDES[i] * 0.3, 0, 1), w);
      pose.hands[i].lerp(_w.set(SIDES[i] * 0.25 * d.torso, -0.3, 0.17), w);
      pose.elbows[i].lerp(_w.set(SIDES[i] * 0.55, -0.45, -0.9), w);
      pose.wrists[i].lerp(_w.set(0.15, 0, 0), w);
    }
  },
};

// Engaged pairs. How far each body reaches forward of its feet (yards along
// its facing) for a net torso lean and hips offset: the chest plate and the
// facemask. Pivoting the whole torso at the hips overestimates the reach, so
// the pair errs toward space between them.
const chestFront = (d, lean, hipsZ) => hipsZ + 0.62 * d.k * Math.sin(lean) + 0.165 * (1 + d.torso) / 2 * Math.cos(lean);
const helmetFront = (d, lean, hipsZ) => hipsZ + 0.88 * d.k * Math.sin(lean) + 0.19;

// Postures of the two men (lean = net torso pitch with room to spare,
// hipsZ = pelvis ahead of the feet, drop = pelvis below standing height).
const BLOCK_STYLES = {
  pass: { lean: 0.26, hipsZ: -0.07, drop: 0.17 },     // blocker in his pass set
  rush: { lean: 0.6, hipsZ: 0.05, drop: 0.13 },       // rusher leaning into him
  drive: { lean: 0.55, hipsZ: 0.05, drop: 0.15 },     // run blocker driving
  anchor: { lean: 0.36, hipsZ: -0.02, drop: 0.16 },   // defender holding his ground
};

function blockStyle(offense, run, out) {
  const a = BLOCK_STYLES[offense ? 'pass' : 'rush'], b = BLOCK_STYLES[offense ? 'drive' : 'anchor'];
  out.lean = lerp(a.lean, b.lean, run); out.hipsZ = lerp(a.hipsZ, b.hipsZ, run); out.drop = lerp(a.drop, b.drop, run);
  return out;
}

// The share of each man's full lean that fits in the gap (the same for both
// men, so the two always agree), and how far both sit back when even upright
// bodies would touch.
const MARGIN = 0.06;
function pairFit(gap, dA, sA, dB, sB) {
  const need = f => {
    const la = sA.lean * f, lb = sB.lean * f;
    const ca = chestFront(dA, la, sA.hipsZ), cb = chestFront(dB, lb, sB.hipsZ);
    const ha = helmetFront(dA, la, sA.hipsZ), hb = helmetFront(dB, lb, sB.hipsZ);
    return Math.max(ca + cb, ha + cb, hb + ca);
  };
  const room = gap - MARGIN;
  if (need(1) <= room) return { f: 1, back: 0 };
  if (need(0) > room) return { f: 0, back: (need(0) - room) / 2 };
  let lo = 0, hi = 1;
  for (let k = 0; k < 10; k++) { const m = (lo + hi) / 2; if (need(m) <= room) lo = m; else hi = m; }
  return { f: lo, back: 0 };
}
const _styleA = {}, _styleB = {};

const THROW_RIGHT = [[0, -0.075, 0.15, 0.27], [0.07, -0.21, 0.37, 0.02], [0.15, -0.27, 0.45, -0.16], [0.23, -0.16, 0.57, 0.36], [0.3, -0.03, 0.24, 0.47], [0.4, 0.14, -0.1, 0.33]];
const THROW_LEFT = [[0, 0.075, 0.15, 0.27], [0.08, 0.19, 0.19, 0.42], [0.17, 0.2, 0.15, 0.46], [0.23, 0.23, 0.02, 0.2], [0.4, 0.22, -0.12, -0.04]];
const THROW_SPINE = [[0, 0.08, 0, 0], [0.12, -0.02, -0.6, 0.12], [0.18, -0.04, -0.62, 0.12], [0.23, 0.18, 0.15, -0.05], [0.32, 0.4, 0.42, -0.12], [0.4, 0.38, 0.45, -0.15]];
const THROW_HIPS = [[0, 0.15, 0, 0], [0.12, 0.1, -0.35, 0], [0.2, 0.12, -0.1, 0], [0.26, 0.2, 0.28, 0], [0.4, 0.22, 0.32, 0]];

export const ACTIONS = {
  run(anim, pose, age, data, p, ctx) {
    for (const kind in POSTURES) if (anim.postures[kind] > 0.005) POSTURES[kind](anim, pose, anim.postures[kind], p, ctx);
    if (ctx.phase === 'air') reachForBall(anim, pose, p, ctx);
    // After the whistle, most players who are standing around put their
    // hands on their hips, each in his own time rather than all at once.
    if (ctx.dead && anim.seed < 0.7) {
      const start = 0.7 + 0.9 * anim.seed;
      const w = smoothstep(start, start + 0.9, ctx.deadTime) * (1 - smoothstep(0.4, 1.2, anim.speed));
      if (w > 0) {
        anim.prepareChest(pose);
        for (let i = 0; i < 2; i++) {
          pose.hands[i].lerp(anim.chestPoint(SIDES[i] * 0.21 * anim.dims.torso, pose.pelvis.y + 0.13, 0.03, _a), w);
          pose.elbows[i].lerp(_b.set(SIDES[i], -0.15, -0.25), w);
          pose.wrists[i].lerp(_b.set(0.3, 0, SIDES[i] * -1.2), w);
        }
        pose.spine.x -= 0.06 * w;
      }
    }
  },

  carry(anim, pose, age, data, p) {
    tuck(pose, carryArm(anim, p));
    pose.spine.x += 0.04;
  },

  // Ball in both hands at the numbers. Dropping (or shuffling) he stays
  // tall with the ball up; set in the pocket he flexes his knees, staggers
  // his feet a third of a yard (left foot forward), keeps his shoulders
  // square downfield and bounces lightly while his eyes scan the field.
  pocket(anim, pose, age, data, p, ctx) {
    const d = anim.dims, t = ctx.time;
    pose.hands[0].set(0.075, 0.14, 0.25); pose.hands[1].set(-0.075, 0.15, 0.25);
    pose.elbows[0].set(0.9, -1, -0.1); pose.elbows[1].set(-0.9, -1, -0.1);
    pose.wrists[0].set(-0.2, 0, -0.9); pose.wrists[1].set(-0.2, 0, 0.9);
    // Quarterbacks drop back tall, even when shuffling backwards.
    pose.spine.x = Math.min(pose.spine.x, 0.12);
    pose.hips.x = Math.min(pose.hips.x, 0.16);
    pose.pelvis.y = Math.max(pose.pelvis.y, d.hipY - 0.12);
    const set = 1 - smoothstep(0.5, 1.8, anim.speed);
    if (set > 0) {
      const bounce = Math.sin(TAU * 1.7 * t + anim.seed * 5);
      pose.pelvis.set(lerp(pose.pelvis.x, 0.015 * Math.sin(TAU * 0.6 * t + anim.seed * 3), set), lerp(pose.pelvis.y, d.hipY - 0.085 + 0.008 * bounce, set), lerp(pose.pelvis.z, 0, set));
      pose.hips.set(lerp(pose.hips.x, 0.16, set), lerp(pose.hips.y, -0.12, set), pose.hips.z * (1 - set));
      pose.spine.set(lerp(pose.spine.x, 0.05, set), lerp(pose.spine.y, 0.12, set), pose.spine.z * (1 - set));
      pose.feet[0].lerp(_a.set(0.15, d.ankle, 0.17), set);
      pose.feet[1].lerp(_a.set(-0.17, d.ankle, -0.16), set);
      pose.footRot[0].lerp(_a.set(0, 0.1, 0), set);
      pose.footRot[1].lerp(_a.set(0, -0.4, 0), set);
      for (let i = 0; i < 2; i++) pose.knees[i].lerp(_a.set(SIDES[i] * 0.3, 0, 1), set);
    }
    pose.head.set(0, 0.45 * Math.sin(t * 0.8 + anim.seed * 3), 0);
  },

  // Wind-up, stride, release at 0.23 s, follow-through across the body.
  throw(anim, pose, age, data, p) {
    const t = Math.min(age, 0.4), d = anim.dims;
    sampleTrack(THROW_SPINE, t, _a); pose.spine.set(_a.x, _a.y, _a.z);
    sampleTrack(THROW_HIPS, t, _a); pose.hips.set(_a.x, _a.y, _a.z);
    sampleTrack(THROW_RIGHT, t, pose.hands[1]);
    sampleTrack(THROW_LEFT, t, pose.hands[0]);
    const cock = smoothstep(0.02, 0.12, t) * (1 - smoothstep(0.2, 0.3, t));
    pose.elbows[1].set(-1, lerp(-0.6, 0.15, cock), -0.3);
    pose.elbows[0].set(0.9, -0.6, -0.3);
    pose.wrists[1].set(lerp(0, -0.6, cock), 0, 0);
    pose.wrists[0].set(-0.2, 0, -0.6);
    pose.head.set(0, 0, 0);
    // Legs: step toward the target with the front foot, pivot on the back foot.
    const legs = 1 - smoothstep(2, 4, anim.speed);
    if (legs > 0) {
      const step = smoothstep(0.02, 0.18, t);
      pose.feet[0].lerp(_a.set(0.16, d.ankle + 0.08 * bump(0.02, 0.18, t), lerp(0.1, 0.42, step)), legs);
      pose.feet[1].lerp(_a.set(-0.2, d.ankle, -0.2), legs);
      pose.footRot[1].x = lerp(pose.footRot[1].x, 0.6 * smoothstep(0.25, 0.38, t), legs);
      pose.footRot[1].y = lerp(pose.footRot[1].y, -0.5, legs);
      pose.pelvis.z = lerp(pose.pelvis.z, 0.1 * smoothstep(0.1, 0.3, t), legs);
      pose.pelvis.y = lerp(pose.pelvis.y, d.hipY - 0.09, legs);
    }
  },

  // Hands where the ball arrived, then bring it in to the tuck. The meeting
  // point is fixed in the chest frame when the catch starts, so the hands do
  // not trail behind a receiver who keeps running.
  catch(anim, pose, age, data, p, ctx) {
    const i = carryArm(anim, p), j = 1 - i;
    const secure = smoothstep(0.04, 0.26, age);
    // The shoulders stay turned to where the ball arrived (a ball thrown
    // across or over the shoulder), then square up as it comes in.
    if (data.twist === undefined) {
      data.twist = 0;
      if (data.point) {
        anim.worldToTilt(pose, data.point, _a);
        data.twist = clamp(Math.atan2(_a.x, Math.max(0.05, _a.z)), -0.8, 0.8);
      }
    }
    pose.spine.y += data.twist * (1 - secure);
    if (!data.local) {
      const twisted = _w.copy(pose.spine);
      pose.spine.y += data.twist * secure;            // full twist for the meeting point
      data.local = data.point ? anim.worldToChest(pose, data.point, new THREE.Vector3()) : new THREE.Vector3(0, 0.2, 0.42);
      pose.spine.copy(twisted);
      // Never further than the arms reach, never behind the shoulders.
      data.local.z = Math.max(0.02, data.local.z);
      const reach = 0.92 * (anim.dims.upperArm + anim.dims.forearm);
      const sh = _d.set(0, anim.dims.shoulder[1], 0), off = data.local.clone().sub(sh);
      if (off.length() > reach) data.local.copy(sh).addScaledVector(off.normalize(), reach);
    }
    _a.copy(data.local);
    _b.copy(_a); _b.x += SIDES[i] * 0.07;
    _c.set(SIDES[i] * 0.105, 0.13, 0.19);
    pose.hands[i].copy(_b).lerp(_c, secure);
    pose.elbows[i].set(SIDES[i] * 0.9, -0.8, -0.35);
    pose.wrists[i].set(lerp(-0.3, 0.55, secure), 0, SIDES[i] * 0.9 * (1 - secure));
    // Off hand covers the ball as it comes in, then returns to the run.
    _b.copy(_a); _b.x += SIDES[j] * 0.07;
    _d.set(SIDES[i] * 0.03, 0.18, 0.25);
    _b.lerp(_d, secure);
    const release = smoothstep(0.32, 0.45, age);
    pose.hands[j].copy(_b).lerp(anim.base.hands[j], release);
    pose.elbows[j].set(SIDES[j] * 0.9, -0.8, -0.3);
    pose.wrists[j].set(-0.3, 0, SIDES[j] * 0.9 * (1 - release));
    if (data.point) anim.lookAt(pose, data.point, 0.7 * (1 - secure));
  },

  cut: plantAndDrive,
  juke: plantAndDrive,

  // Engaged pair. The blocker sits in his pass set: hips down, back fairly
  // upright, arms out with the hands on the rusher's chest plate, elbows in.
  // The rusher leans into him with his hands on the blocker's shoulder pads.
  // On runs the blocker drives and the defender anchors. Each puts his helmet
  // to his own left of the other man's, and the lean of both shrinks with the
  // gap (pairFit) so bodies never pass through each other: a tight gap
  // straightens them up.
  block(anim, pose, age, data, p, ctx) {
    const d = anim.dims, offense = anim.spec.team === 'offense';
    const q = p.engaged != null ? ctx.byId.get(p.engaged) : null;
    const other = q ? ctx.animators.get(q.id) : null;
    const gap = q ? Math.hypot(q.x - p.x, q.z - p.z) : 1.3;
    // Run or pass, eased so a block that starts during the mesh does not pop.
    const run = ctx.protect ? 0 : 1;
    data.run = data.run === undefined ? run : damp(data.run, run, 5, ctx.dt);
    const mine = blockStyle(offense, data.run, _styleA);
    let fit = { f: 1, back: 0 };
    if (other) {
      const theirs = blockStyle(other.spec.team === 'offense', data.run, _styleB);
      // Offense first, so both men get the same answer.
      fit = offense ? pairFit(gap, d, mine, other.dims, theirs) : pairFit(gap, other.dims, theirs, d, mine);
    }
    const lean = mine.lean * fit.f, chop = Math.sin(ctx.time * 9 + anim.seed * 5);
    pose.pelvis.set(0.02, d.hipY - mine.drop + 0.01 * chop, mine.hipsZ - fit.back);
    pose.hips.set(0.7 * lean, 0, 0);
    // Head to his own left: shoulders rolled a little that way.
    pose.spine.set(0.3 * lean, 0, -0.1);
    pose.head.set(offense ? -0.04 : -0.1, -0.22, 0);
    for (let i = 0; i < 2; i++) {
      pose.feet[i].x += SIDES[i] * 0.12;
      // Blocker: left foot a little ahead. Rusher: feet driving back under him.
      pose.feet[i].z += offense ? (i ? -0.06 : 0.06) : (i ? -0.16 : -0.02);
      pose.knees[i].set(SIDES[i] * 0.35, 0, 1);
    }
    const rig = q ? ctx.rigs.get(q.id) : null;
    // The hands travel to their spot (from wherever they were) instead of
    // jumping when he locks on, or switches to another man.
    data.hands ??= [anim.pose.hands[0].clone(), anim.pose.hands[1].clone()];
    const follow = 1 - Math.exp(-30 * ctx.dt);
    for (let i = 0; i < 2; i++) {
      if (rig) {
        // A point on the opponent's body (his chest frame): my left hand lands
        // on his right side. The wrist stops short of the surface so the palm,
        // not the wrist, meets it.
        const od = rig.dims, depth = (1 + od.torso) / 2, s = -SIDES[i];
        if (offense) _a.set(s * 0.12 * od.torso, 0.21 * od.k, 0.16 * depth);
        else _a.set(s * 0.2 * od.torso, 0.33 * od.k, 0.12 * depth);
        _a.applyMatrix4(rig.chest.matrixWorld);
        anim.worldToChest(pose, _a, _b);
        _c.set(SIDES[i] * d.shoulder[0], d.shoulder[1], d.shoulder[2]);
        _d.subVectors(_b, _c);
        const len = _d.length();
        if (len > 0.1) _b.addScaledVector(_d, -0.07 / len);
        data.hands[i].lerp(_b, follow);
      }
      // Without a man (the block just ended) the hands hold where they were.
      pose.hands[i].set(data.hands[i].x, data.hands[i].y + 0.015 * Math.sin(ctx.time * 9 + i * 2), data.hands[i].z);
      pose.elbows[i].set(SIDES[i] * (offense ? 0.3 : 0.65), -1, -0.15);
      pose.wrists[i].set(offense ? -1.15 : -0.8, 0, 0);
    }
  },

  // The tackler: wrap up chest to chest, or launch at the legs when closing fast.
  tackle(anim, pose, age, data, p, ctx) {
    const d = anim.dims;
    const target = data.target ? bodyPoint(ctx, data.target, 'pelvis', _a) : null;
    const targetAnim = data.target ? ctx.animators.get(data.target) : null;
    const goingDown = ctx.dead || (targetAnim && (targetAnim.action === 'down' || (targetAnim.action === 'wrapped' && targetAnim.age > 0.5)));
    if (goingDown && data.fallAt === null) data.fallAt = age;
    if (age > 0.3 && !data.locked) { data.locked = true; if (!data.landing) data.holdYaw = anim.yaw; }
    // Axis from the tackler toward the carrier (scene space, where z = -sim z)
    // for wrapping the arms around him.
    if (target) _perp.set(target.x - p.x, 0, target.z + p.z).normalize();
    else _perp.set(Math.sin(anim.yaw), 0, Math.cos(anim.yaw));
    const ax = _perp.x, az = _perp.z;

    if (data.mode === 'wrap') {
      const fall = data.fallAt === null ? 0 : smoothstep(0, 0.6, age - data.fallAt), f = fall * fall;
      if (fall > 0 && !data.landing && targetAnim) data.landing = landingBeside(anim, targetAnim, p, ctx);
      pose.pelvis.y = d.hipY - 0.24 * (1 - fall) - 0.05;
      pose.hips.x = lerp(0.62, 0.12, fall);
      pose.spine.x = lerp(0.35, 0.08, fall);
      pose.feet[0].x += 0.08; pose.feet[1].x -= 0.08;
      pose.tiltPitch = 1.32 * f;
      pose.head.set(-0.15 - 0.9 * fall, 0.35, 0);
      if (fall > 0) legsOut(anim, pose, fall);
      if (data.landing) {
        // Slide the pivot to the landing spot (in his turning root frame) and
        // roll a little toward the carrier so the inside arm drapes over him.
        const local = anim.worldToRoot(data.landing.pivot, _c);
        pose.tiltSide = local.x * fall; pose.tiltFwd = local.z * fall;
        pose.tiltRoll = data.landing.roll * f;
      }
      if (target) {
        for (let i = 0; i < 2; i++) {
          // Hands meet behind the carrier's back at belt height.
          const s = SIDES[i];
          _b.set(target.x + ax * 0.16 + az * s * 0.14, target.y + 0.12, target.z + az * 0.16 - ax * s * 0.14);
          anim.worldToChest(pose, _b, pose.hands[i]);
          pose.elbows[i].set(s * 1, -0.3, -0.1);
          pose.wrists[i].set(-0.4, 0, s * 0.8);
        }
      }
      return;
    }
    // Dive: launch low and horizontal, arms around the thighs, land prone.
    const launch = smoothstep(0.04, 0.3, age), ground = smoothstep(0.3, 0.62, age);
    pose.tiltPitch = 1.15 * launch + 0.3 * ground;
    pose.tiltLift = 0.25 * bump(0.06, 0.62, age);
    pose.tiltFwd = 0.35 * launch;
    pose.pelvis.y = lerp(d.hipY - 0.2, d.hipY - 0.04, launch);
    pose.hips.x = lerp(0.6, 0.0, launch); pose.spine.x = lerp(0.3, 0.05, launch);
    legsOut(anim, pose, launch, -0.06, 0.1 * (1 - ground));
    pose.head.set(-0.9 * launch, 0.3 * launch, 0);
    if (target) {
      for (let i = 0; i < 2; i++) {
        const s = SIDES[i];
        _b.set(target.x + ax * 0.1 + az * s * 0.13, Math.max(0.35, target.y - 0.35), target.z + az * 0.1 - ax * s * 0.13);
        anim.worldToChest(pose, _b, _c);
        pose.hands[i].lerp(_c, launch);
        pose.elbows[i].set(s, -0.2, -0.2);
      }
    }
  },

  // Being tackled: churning legs, bent knees, both arms on the ball.
  wrapped(anim, pose, age, data, p, ctx) {
    pose.pelvis.y -= 0.16;
    pose.hips.x = 0.36; pose.spine.x = 0.32;
    pose.head.set(-0.1, 0, 0);
    if (ctx.holderId === p.id) {
      const i = carryArm(anim, p), j = 1 - i;
      tuck(pose, i);
      pose.hands[j].set(SIDES[i] * 0.03, 0.18, 0.25);
      pose.elbows[j].set(SIDES[j] * 0.8, -1, -0.2);
    }
  },

  // Falls forward and stays down; ball kept tucked under the body.
  down(anim, pose, age, data, p, ctx) {
    const d = anim.dims;
    const buckle = smoothstep(0, 0.22, age), fall = smoothstep(0.08, 0.62, age), f = fall * fall * (3 - 2 * fall);
    pose.tiltPitch = 1.4 * f; pose.tiltRoll = data.roll * f; pose.tiltLift = 0.03 * f;
    pose.pelvis.set(0, lerp(lerp(pose.pelvis.y, d.hipY - 0.3, buckle), d.hipY - 0.06, f), 0);
    pose.hips.set(lerp(pose.hips.x + 0.3 * buckle, 0.04, f), 0, 0);
    pose.spine.set(lerp(pose.spine.x, 0.08, f), 0.15 * data.roll * f, 0);
    legsOut(anim, pose, f);
    // Free hands come down flat on the turf beside the helmet.
    if (data.holding) {
      const i = carryArm(anim, p);
      tuck(pose, i);
      palmDown(anim, pose, 1 - i, 1.45, 0.4, f);
    } else {
      for (let i = 0; i < 2; i++) palmDown(anim, pose, i, 1.35, 0.36, f);
    }
    pose.head.set(lerp(pose.head.x, -1.15, f), data.roll * 1.6 * f, 0);
  },

  // Missed tackle: he lunges past, pitches forward off balance, the hand on
  // the falling side reaches for the turf and the other arm flies back for
  // balance; then he gathers himself and runs on.
  stumble(anim, pose, age, data, p, ctx) {
    const d = anim.dims, u = age / 0.7, side = data.side;
    const lurch = bump(0, 0.95, u) ** 0.8, reach = bump(0.1, 0.8, u);
    pose.pelvis.y -= 0.22 * lurch;
    pose.pelvis.x -= side * 0.06 * lurch;
    pose.hips.x += 0.4 * lurch; pose.hips.z += side * 0.12 * lurch;
    pose.spine.x += 0.55 * lurch; pose.spine.z += side * 0.22 * lurch; pose.spine.y -= side * 0.25 * lurch;
    pose.head.x = lerp(pose.head.x, 0.35, lurch);
    pose.head.y += side * 0.3 * lurch;
    // A wide, staggered base while he fights for balance.
    for (let i = 0; i < 2; i++) pose.feet[i].x += SIDES[i] * 0.08 * lurch;
    const down = side > 0 ? 1 : 0, flung = 1 - down;
    armAngles(pose, flung, d, -0.75, 0.55, 0.75, 0, lurch);
    armAngles(pose, down, d, 0.9, 0.25, 0.35, 0, lurch);
    if (reach > 0) {
      anim.prepareChest(pose);
      pose.hands[down].lerp(anim.chestPoint(SIDES[down] * 0.32 + pose.pelvis.x, 0.07, 0.62, _a), reach);
      pose.wrists[down].set(-1.0 * reach, 0, 0);
    }
    if (ctx.holderId === p.id) tuck(pose, carryArm(anim, p));
  },
};

// Cut / juke: deep knee bend over a planted outside foot, hips shifted and
// banked into the new direction (the body roll replaces, rather than adds
// to, the running bank so a hard juke never tips him over), eyes to the new
// direction, then drive out of it.
function plantAndDrive(anim, pose, age, data, p, ctx) {
  const T = data.duration, u = age / T, juke = T > 0.3;
  const w = Math.sin(Math.PI * clamp(age / (T * 1.1), 0, 1));
  senseCut(anim, data, age);
  const holding = ctx.holderId === p.id, arm = holding ? carryArm(anim, p) : -1;
  if (holding) tuck(pose, arm);
  pose.pelvis.y -= (juke ? 0.16 : 0.1) * w;
  pose.hips.x += 0.1 * w; pose.spine.x += 0.12 * w;
  if (data.dir === null) return;

  const dir = data.dir, i = data.plant, side = SIDES[i];
  pose.pelvis.x = lerp(pose.pelvis.x, -dir * (juke ? 0.13 : 0.09), w);
  pose.hips.z = lerp(pose.hips.z, dir * (juke ? 0.2 : 0.24), w);
  pose.spine.z = lerp(pose.spine.z, dir * 0.08, w);
  pose.spine.y += -dir * (juke ? 0.22 : 0.15) * w;
  pose.head.y += -dir * 0.35 * w;
  // The plant foot stays where it landed until the body has moved off it
  // (ground contact at speed is short), then rejoins the stride.
  const local = anim.worldToRoot(data.foot, _a);
  const behind = -local.z, wide = Math.abs(local.x);
  if (behind > 0.5 || wide > 0.7) data.released = true;
  const plantW = data.released ? 0 : (1 - smoothstep(0.55, 0.9, u)) * (1 - smoothstep(0.3, 0.5, behind)) * (1 - smoothstep(0.55, 0.7, wide));
  const f = pose.feet[i];
  f.x = lerp(f.x, local.x, plantW); f.z = lerp(f.z, local.z, plantW); f.y = lerp(f.y, anim.dims.ankle, plantW);
  pose.footRot[i].set(lerp(pose.footRot[i].x, 0.1, plantW), lerp(pose.footRot[i].y, -dir * 0.5, plantW), -side * 0.25 * plantW * w);
  pose.knees[i].set(side * 0.1 - dir * 0.4, 0, 1);
  // The other foot stays under the hips, ready to step into the new line.
  const o = pose.feet[1 - i];
  o.x = lerp(o.x, -side * 0.06, 0.6 * w);
  // Free arm out for balance on the plant side.
  if (arm !== i) {
    pose.hands[i].lerp(_b.set(side * 0.46, -0.24, 0.12), w * 0.8);
    pose.elbows[i].lerp(_c.set(side * 0.3, -1, -0.2), w);
  }
}
