import * as THREE from '../../vendor/three.module.js';
import { SIDES, lerp } from './math.js';

// Small pose pieces shared by the action layer and the tackle choreography:
// how the ball is carried, and limbs laid out on the turf.

const _w = new THREE.Vector3(), _t = new THREE.Vector3();

// The ball goes in the sideline arm (right arm when the carrier is on the
// right half of the field) and stays there for the rest of the run.
export function carryArm(anim, p) {
  if (anim.carryArm === undefined) anim.carryArm = p.x < -0.5 ? 0 : 1;
  return anim.carryArm;
}

// High and tight: hand cupping the nose in front of the chest, forearm along
// the ball, elbow pinned to the ribs.
export function tuck(pose, i, weight = 1) {
  const side = SIDES[i];
  pose.hands[i].lerp(_w.set(side * 0.105, 0.13, 0.19), weight);
  pose.elbows[i].lerp(_w.set(side * 0.9, -1, -0.45), weight);
  pose.wrists[i].lerp(_w.set(0.55, 0, 0), weight);
}

// Both arms on the ball: the carry arm tucked, the other hand clamped over
// the point (going into contact, and all the way to the ground).
export function cover(pose, i, weight = 1) {
  const j = 1 - i;
  tuck(pose, i, weight);
  pose.hands[j].lerp(_w.set(SIDES[i] * 0.035, 0.17, 0.245), weight);
  pose.elbows[j].lerp(_w.set(SIDES[j] * 0.8, -1, -0.2), weight);
  pose.wrists[j].lerp(_w.set(0.3, 0, SIDES[j] * 0.5), weight);
}

// Lying on the ground the legs stretch out along the body (feet at full leg
// length below the hips in the tilt frame), so knees never dig into the turf.
export function legsOut(anim, pose, weight, z = -0.04, lift = 0) {
  const d = anim.dims, reach = 0.985 * (d.thigh + d.shin);
  for (let i = 0; i < 2; i++) {
    _w.set(SIDES[i] * 0.12 + pose.pelvis.x, pose.pelvis.y - reach + lift, z + pose.pelvis.z);
    pose.feet[i].lerp(_w, weight);
    pose.footRot[i].x = lerp(pose.footRot[i].x, 0.9, weight);
    pose.knees[i].lerp(_w.set(SIDES[i] * 0.5, 0, 1), weight);
  }
}

// A foot on the turf at (x, z) of the body frame (the root turned by the
// pose's own yaw: x to his left, z ahead), `height` above it, whatever the
// body's tilt.
export function footOnGround(anim, pose, i, x, z, weight, height = anim.dims.ankle) {
  pose.feet[i].lerp(anim.bodyToTilt(pose, _t.set(x, height, z), _w), weight);
}

// A hand flat on the turf at (x, z) of the body frame. The pose's torso must
// be final (anim.prepareChest).
export function handOnGround(anim, pose, i, x, z, weight, height = 0.055) {
  anim.bodyToTilt(pose, _t.set(x, height, z), _w);
  pose.hands[i].lerp(anim.chestPoint(_w.x, _w.y, _w.z, _t), weight);
  pose.elbows[i].lerp(_w.set(SIDES[i], 0.3, -0.4), weight);
  pose.wrists[i].lerp(_w.set(-0.3, 0, 0), weight);
}
