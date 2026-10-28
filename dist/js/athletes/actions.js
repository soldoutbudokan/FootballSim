import * as THREE from '../../vendor/three.module.js';
import { SIDES, clamp, lerp, smoothstep, bump, sampleTrack } from './math.js';
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
      // A carrier running into the tackler's chest drives him onto his back.
      const into = target && dist > 1e-3 ? -((target.vx || 0) * (target.x - p.x) + (target.vz || 0) * (target.z - p.z)) / dist : 0;
      data.fallBack = data.mode === 'wrap' && into > 1.5;
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
// simulation registers the catch). Also turns the head to track the ball.
function reachForBall(anim, pose, p, ctx) {
  const reach = anim.reach;
  if (!reach) return;
  if (ctx.ballScene && reach.t < 1.6 && reach.dist < 4) anim.lookAt(pose, ctx.ballScene, 0.85 * (1 - smoothstep(1.0, 1.6, reach.t)));
  const w = (1 - smoothstep(0.18, 0.5, reach.t)) * (1 - smoothstep(1.0, 1.8, reach.dist));
  if (w <= 0) return;
  // Turn the shoulders toward the ball, then put both hands on it.
  anim.worldToTilt(pose, reach.point, _a);
  pose.spine.y += clamp(Math.atan2(_a.x, Math.max(0.05, _a.z)), -0.7, 0.7) * w;
  anim.worldToChest(pose, reach.point, _a);
  for (let i = 0; i < 2; i++) {
    _b.copy(_a); _b.x += SIDES[i] * 0.075;
    pose.hands[i].lerp(_b, w);
    pose.elbows[i].lerp(_c.set(SIDES[i] * 0.9, -0.5, -0.3), w);
    pose.wrists[i].lerp(_c.set(-0.3, 0, SIDES[i] * 0.9), w);
  }
}

const THROW_RIGHT = [[0, -0.075, 0.15, 0.27], [0.07, -0.21, 0.37, 0.02], [0.15, -0.27, 0.45, -0.16], [0.23, -0.16, 0.57, 0.36], [0.3, -0.03, 0.24, 0.47], [0.4, 0.14, -0.1, 0.33]];
const THROW_LEFT = [[0, 0.075, 0.15, 0.27], [0.08, 0.19, 0.19, 0.42], [0.17, 0.2, 0.15, 0.46], [0.23, 0.23, 0.02, 0.2], [0.4, 0.22, -0.12, -0.04]];
const THROW_SPINE = [[0, 0.08, 0, 0], [0.12, -0.02, -0.6, 0.12], [0.18, -0.04, -0.62, 0.12], [0.23, 0.18, 0.15, -0.05], [0.32, 0.4, 0.42, -0.12], [0.4, 0.38, 0.45, -0.15]];
const THROW_HIPS = [[0, 0.15, 0, 0], [0.12, 0.1, -0.35, 0], [0.2, 0.12, -0.1, 0], [0.26, 0.2, 0.28, 0], [0.4, 0.22, 0.32, 0]];

export const ACTIONS = {
  run(anim, pose, age, data, p, ctx) {
    if (ctx.phase === 'air') reachForBall(anim, pose, p, ctx);
    // After the whistle, players who are standing around put their hands on their hips.
    if (ctx.dead) {
      const w = smoothstep(0.8, 1.7, ctx.deadTime) * (1 - smoothstep(0.4, 1.2, anim.speed));
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

  pocket(anim, pose, age, data, p, ctx) {
    pose.hands[0].set(0.075, 0.09, 0.28); pose.hands[1].set(-0.075, 0.1, 0.28);
    pose.elbows[0].set(0.9, -1, 0); pose.elbows[1].set(-0.9, -1, 0);
    pose.wrists[0].set(-0.2, 0, -0.9); pose.wrists[1].set(-0.2, 0, 0.9);
    // Quarterbacks drop back tall, even when shuffling backwards.
    pose.spine.x = Math.min(pose.spine.x, 0.12);
    pose.hips.x = Math.min(pose.hips.x, 0.16);
    pose.pelvis.y = Math.max(pose.pelvis.y, anim.dims.hipY - 0.12);
    pose.head.y = 0.35 * Math.sin(ctx.time * 0.8 + anim.seed * 3);
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
    if (!data.local) {
      data.local = data.point ? anim.worldToChest(pose, data.point, new THREE.Vector3()) : new THREE.Vector3(0, 0.2, 0.42);
      // Never further than the arms reach, never behind the chest.
      data.local.z = Math.max(0.18, data.local.z);
      const reach = 0.9 * (anim.dims.upperArm + anim.dims.forearm);
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

  // Engaged: low, wide base, hands inside on the opponent's chest.
  block(anim, pose, age, data, p, ctx) {
    const d = anim.dims;
    pose.pelvis.y = d.hipY - 0.2;
    pose.hips.x = 0.5; pose.spine.x = 0.28;
    pose.feet[0].x += 0.12; pose.feet[1].x -= 0.12;
    pose.feet[0].z += 0.06; pose.feet[1].z -= 0.06;
    pose.head.set(-0.1, 0, 0);
    const opp = p.engaged != null ? bodyPoint(ctx, p.engaged, 'chest', _a, 1.35) : null;
    if (opp) {
      anim.worldToChest(pose, opp, _b);
      // Contact surface: a little short of the opponent's chest centre.
      const len = Math.hypot(_b.x, _b.y - 0.2, _b.z);
      _b.multiplyScalar(Math.max(0, len - 0.17) / Math.max(len, 1e-3));
    } else _b.set(0, 0.2, 0.55);
    for (let i = 0; i < 2; i++) {
      pose.hands[i].set(_b.x + SIDES[i] * 0.13, _b.y + 0.02 * Math.sin(ctx.time * 9 + i * 2), _b.z);
      pose.elbows[i].set(SIDES[i] * 0.5, -1, -0.2);
      pose.wrists[i].set(-1.1, 0, 0);
    }
  },

  // The tackler: wrap up chest to chest, or launch at the legs when closing fast.
  tackle(anim, pose, age, data, p, ctx) {
    const d = anim.dims;
    const target = data.target ? bodyPoint(ctx, data.target, 'pelvis', _a) : null;
    const targetAnim = data.target ? ctx.animators.get(data.target) : null;
    const goingDown = ctx.dead || (targetAnim && (targetAnim.action === 'down' || (targetAnim.action === 'wrapped' && targetAnim.age > 0.5)));
    if (goingDown && data.fallAt === null) data.fallAt = age;
    if (age > 0.3 && !data.locked) { data.locked = true; data.holdYaw = anim.yaw; }
    // Axis from the tackler toward the carrier (scene space, where z = -sim z)
    // for wrapping the arms around him.
    if (target) _perp.set(target.x - p.x, 0, target.z + p.z).normalize();
    else _perp.set(Math.sin(anim.yaw), 0, Math.cos(anim.yaw));
    const ax = _perp.x, az = _perp.z;

    if (data.mode === 'wrap') {
      const fall = data.fallAt === null ? 0 : smoothstep(0, 0.6, age - data.fallAt), f = fall * fall;
      const back = data.fallBack ? -1 : 1;
      pose.pelvis.y = d.hipY - 0.24 * (1 - fall) - 0.05;
      pose.hips.x = lerp(0.62, data.fallBack ? -0.1 : 0.12, fall);
      pose.spine.x = lerp(0.35, data.fallBack ? 0.25 : 0.08, fall);
      pose.feet[0].x += 0.08; pose.feet[1].x -= 0.08;
      pose.tiltPitch = back * 1.32 * f; pose.tiltFwd = back * 0.2 * fall;
      pose.head.set(data.fallBack ? -0.15 + 1.2 * fall : -0.15 - 0.9 * fall, 0.35, 0);
      if (fall > 0) {
        if (data.fallBack) {
          // Driven onto his back: knees come up, feet stay planted.
          for (let i = 0; i < 2; i++) {
            pose.feet[i].lerp(_c.set(SIDES[i] * 0.15, d.ankle, 0.12), fall);
            pose.footRot[i].x = lerp(pose.footRot[i].x, -0.6, fall);
          }
        } else legsOut(anim, pose, fall);
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
    if (data.holding) {
      const i = carryArm(anim, p), j = 1 - i;
      tuck(pose, i);
      pose.hands[j].lerp(_c.set(SIDES[j] * 0.32, 0.5, 0.24), f);
      pose.elbows[j].set(SIDES[j], -0.3, -0.3);
    } else {
      for (let i = 0; i < 2; i++) {
        pose.hands[i].lerp(_c.set(SIDES[i] * 0.33, 0.45, 0.26), f);
        pose.elbows[i].set(SIDES[i], -0.3, -0.3);
      }
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
