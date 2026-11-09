import * as THREE from '../../vendor/three.module.js';
import { SIDES, clamp, lerp, smoothstep, bump } from './math.js';
import { carryArm } from './carry.js';

// Playing the ball in the air: the reach as it arrives, and what the hands
// and body do in the half second after it gets there (a catch brought in to
// the tuck, a drop, a defender's swat). Where the ball arrives decides the
// look: he goes up for a high one, sinks for a low one, turns his shoulders
// to one thrown across him and looks one in over his shoulder without
// breaking stride (the yaw limit for that is in Animator.updateYaw).

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

const JUMP_TIME = 0.2;         // seconds off the ground either side of the catch
const JUMP = 0.38;             // highest jump, yards

// The body's height for a ball arriving `y` yd off the ground, `tau` seconds
// from its arrival (negative before): a jump that peaks as the ball gets
// there, or a knee bend down to a low one. Returns how low he went (0..1).
function meetHeight(anim, pose, y, tau) {
  const k = anim.dims.k;
  const high = clamp((y - 2.0 * k) / 0.55, 0, 1), low = clamp((1.05 * k - y) / 0.5, 0, 1);
  if (high > 0) {
    const air = Math.max(0, 1 - (tau / JUMP_TIME) ** 2), load = bump(-0.36, -0.17, tau), land = bump(0.17, 0.36, tau);
    pose.tiltLift += JUMP * high * air;
    pose.pelvis.y -= 0.1 * k * high * (load + land);
    pose.spine.x -= 0.1 * high * air;
    pose.feet[0].y += 0.1 * high * air; pose.feet[1].y += 0.04 * high * air;
    for (let i = 0; i < 2; i++) pose.footRot[i].x += 0.5 * high * air;
  }
  const sink = low * (1 - smoothstep(0.1, 0.32, Math.abs(tau)));
  if (sink > 0) {
    pose.pelvis.y -= 0.24 * k * sink;
    pose.hips.x += 0.3 * sink; pose.spine.x += 0.32 * sink;
  }
  return sink;
}

// Hands meet a ball approaching through the air (anticipation before the
// simulation registers the catch): both hands together, elbows soft, eyes on
// the ball. Only for a ball that passes within reach (anticipateCatches).
export function reachForBall(anim, pose, p, ctx) {
  const reach = anim.reach;
  if (!reach) return;
  if (ctx.ballScene && reach.t < 1.6) anim.lookAt(pose, ctx.ballScene, 0.85 * (1 - smoothstep(1.0, 1.6, reach.t)));
  const near = 1 - smoothstep(0.8, 1.3, reach.dist);
  if (near <= 0) return;
  const sink = meetHeight(anim, pose, reach.point.y, -reach.t) * near;
  // The arms go late: the hands show in the last third of a second.
  const w = (1 - smoothstep(0.12, 0.4, reach.t)) * near;
  if (w <= 0) return;
  // Turn the shoulders toward the ball, then put both hands on it.
  anim.worldToTilt(pose, reach.point, _a);
  pose.spine.y += clamp(Math.atan2(_a.x, Math.max(0.05, _a.z)), -0.7, 0.7) * w;
  anim.worldToChest(pose, reach.point, _a);
  // A ball beyond the arms is met where they can get to, elbows still bent.
  const d = anim.dims, top = _d.set(0, d.shoulder[1], d.shoulder[2]), most = 0.84 * (d.upperArm + d.forearm);
  _a.sub(top);
  if (_a.length() > most) _a.setLength(most);
  _a.add(top);
  for (let i = 0; i < 2; i++) {
    _b.copy(_a); _b.x += SIDES[i] * 0.075;
    pose.hands[i].lerp(_b, w);
    pose.elbows[i].lerp(_c.set(SIDES[i] * 0.9, -0.5, -0.3), w);
    // Thumbs together above the chest, little fingers together below it.
    pose.wrists[i].lerp(_c.set(lerp(-0.3, 0.45, sink), 0, SIDES[i] * lerp(0.9, -0.7, sink)), w);
  }
}

// The catch action. Hands where the ball arrived (fixed in the chest frame
// when the action starts, so they do not trail behind a man who keeps
// running), then: the ball brought in to the tuck by the man who has it; a
// swat through it by a defender who does not; hands coming apart after it
// and a dropped head for a receiver who let it go.
export function catchBall(anim, pose, age, data, p, ctx) {
  const i = carryArm(anim, p), j = 1 - i, d = anim.dims;
  const holding = ctx.holderId === p.id;
  const secure = holding ? smoothstep(0.04, 0.26, age) : smoothstep(0.1, 0.4, age);
  meetHeight(anim, pose, data.point ? data.point.y : 1.4, age);
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
    const twisted = _c.copy(pose.spine);
    pose.spine.y += data.twist * secure;            // full twist for the meeting point
    data.local = data.point ? anim.worldToChest(pose, data.point, new THREE.Vector3()) : new THREE.Vector3(0, 0.2, 0.42);
    pose.spine.copy(twisted);
    // Never further than the arms reach, never behind the shoulders.
    data.local.z = Math.max(0.02, data.local.z);
    const reach = 0.92 * (d.upperArm + d.forearm);
    const sh = _d.set(0, d.shoulder[1], 0), off = data.local.clone().sub(sh);
    if (off.length() > reach) data.local.copy(sh).addScaledVector(off.normalize(), reach);
  }
  _a.copy(data.local);
  if (!holding) return anim.spec.team === 'defense' ? swat(anim, pose, age, data) : bobble(anim, pose, age, data, ctx);

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
}

// A defender who got a hand on it (or only played at it): the arm on the
// ball's side goes through where it was and on down across his body.
function swat(anim, pose, age, data) {
  const s = data.local.x >= 0 ? 0 : 1, o = 1 - s;
  const through = smoothstep(0.02, 0.3, age), back = smoothstep(0.3, 0.45, age), swing = bump(0, 0.42, age);
  _b.copy(_a).lerp(_c.set(-SIDES[s] * 0.14, -0.26, 0.36), through);
  pose.hands[s].copy(_b).lerp(anim.base.hands[s], back);
  pose.elbows[s].lerp(_c.set(SIDES[s] * 0.7, -0.6, -0.3), 1 - back);
  pose.wrists[s].set(-0.8 * (1 - back), 0, 0);
  _b.copy(_a); _b.x += SIDES[o] * 0.1;
  pose.hands[o].copy(_b).lerp(anim.base.hands[o], smoothstep(0, 0.2, age));
  pose.spine.y += -SIDES[s] * 0.32 * swing;
  pose.spine.x += 0.1 * swing;
}

// A receiver who did not come down with it: the hands part and go after the
// ball for an instant, then fall; his eyes follow it to the turf.
function bobble(anim, pose, age, data, ctx) {
  const d = anim.dims;
  const chase = smoothstep(0.02, 0.16, age), drop = smoothstep(0.2, 0.45, age);
  anim.worldToChest(pose, ctx.ballScene, _b);
  const top = _d.set(0, d.shoulder[1], d.shoulder[2]), most = 0.8 * (d.upperArm + d.forearm);
  _b.sub(top); if (_b.length() > most) _b.setLength(most); _b.add(top);
  _b.z = Math.max(0.05, _b.z);
  for (let i = 0; i < 2; i++) {
    _c.copy(_a).lerp(_b, chase * 0.8);
    _c.x += SIDES[i] * lerp(0.07, 0.2, chase);
    pose.hands[i].copy(_c).lerp(anim.base.hands[i], drop);
    pose.elbows[i].lerp(_c.set(SIDES[i] * 0.9, -0.6, -0.3), 1 - drop);
    pose.wrists[i].set(-0.3 * (1 - drop), 0, SIDES[i] * 0.6 * (1 - drop));
  }
  anim.lookAt(pose, ctx.ballScene, 0.85 * (1 - smoothstep(0.34, 0.45, age)));
  pose.spine.x += 0.1 * smoothstep(0.12, 0.4, age);
}

// ---------------------------------------------------------------------------
// The handoff mesh on a run: the quarterback rides the ball out to the back's
// belly, the back makes a pocket for it (inside elbow up, other arm under),
// and the quarterback's hands stay out a moment after the ball has gone.

// Who is meshing this frame: { giver, taker, w (0..1), given } or null.
export function handoffMesh(ctx, qbId) {
  const s = ctx.state, qb = ctx.byId.get(qbId);
  if (!qb || s.pocket !== false || (ctx.phase !== 'live' && ctx.phase !== 'run')) return null;
  if (ctx.holderId === qbId) {
    let taker = null, gap = 2.3;
    for (const p of s.players) {
      if (ctx.rigs.get(p.id)?.spec.role !== 'rb') continue;
      const g = Math.hypot(p.x - qb.x, p.z - qb.z);
      if (g < gap) { gap = g; taker = p.id; }
    }
    return taker ? { giver: qbId, taker, w: 1 - smoothstep(0.95, 2.3, gap), given: false } : null;
  }
  const c = ctx.byId.get(s.carrier);
  if (c && c.action === 'carry' && c.actionTime > 0 && Math.hypot(c.x - qb.x, c.z - qb.z) < 2.6) return { giver: qbId, taker: c.id, w: clamp(c.actionTime / 0.3, 0, 1), given: true };
  return null;
}

// The quarterback's part: both hands carry the ball out to the back's belt.
export function giveBall(anim, pose, p, ctx) {
  const m = ctx.mesh;
  if (!m || m.giver !== p.id || m.w <= 0) return;
  const rig = ctx.rigs.get(m.taker);
  if (!rig) return;
  const d = anim.dims;
  _a.copy(rig.world.pelvis); _a.y += 0.2;
  anim.worldToChest(pose, _a, _b);
  const top = _d.set(0, d.shoulder[1], d.shoulder[2]), most = 0.8 * (d.upperArm + d.forearm);
  _b.sub(top); if (_b.length() > most) _b.setLength(most); _b.add(top);
  _b.z = Math.max(0.12, _b.z);
  for (let i = 0; i < 2; i++) {
    _c.copy(_b); _c.x += SIDES[i] * 0.075;
    pose.hands[i].lerp(_c, m.w);
    pose.elbows[i].lerp(_c.set(SIDES[i] * 0.7, -0.8, -0.3), m.w);
  }
  pose.spine.x += 0.1 * m.w;
  anim.lookAt(pose, rig.world.chest, 0.7 * m.w);
}

// The back's part, until the ball is his: a pocket at the belt.
export function takeBall(anim, pose, p, ctx) {
  const m = ctx.mesh;
  if (!m || m.taker !== p.id || m.given || m.w <= 0) return;
  const qb = ctx.byId.get(m.giver);
  if (!qb) return;
  const up = anim.worldToRoot(_a.set(qb.x, 0, -qb.z), _b).x > 0 ? 0 : 1, under = 1 - up;   // the arm on the quarterback's side goes over
  pose.hands[up].lerp(_c.set(-SIDES[up] * 0.1, 0.12, 0.2), m.w);
  pose.elbows[up].lerp(_c.set(SIDES[up], 0.1, -0.2), m.w);
  pose.wrists[up].lerp(_c.set(0.2, 0, 0), m.w);
  pose.hands[under].lerp(_c.set(-SIDES[under] * 0.04, -0.2, 0.22), m.w);
  pose.elbows[under].lerp(_c.set(SIDES[under] * 0.8, -1, -0.3), m.w);
  pose.wrists[under].lerp(_c.set(-0.9, 0, 0), m.w);
  pose.spine.x += 0.08 * m.w;
}
