import * as THREE from '../../vendor/three.module.js';
import { SIDES } from './math.js';

// A full-body pose, the common currency between the animation layer and the
// rig. Everything is a number or a vector so two poses can be blended.
//
// Frames (all right-handed, +Y up, the athlete faces +Z, his right is -X):
//   root   - on the ground under the player, yawed to his facing
//   tilt   - root rotated about a ground pivot (falls, dives); feet live here
//   chest  - the upper torso; hand targets and elbow poles live here
// Angle triples are (pitch, yaw, roll): +pitch leans forward, +yaw turns to
// his left, +roll leans to his right.
export class Pose {
  constructor() {
    this.yaw = 0;              // extra yaw of the whole body relative to the root
    this.tiltPitch = 0;        // whole-body rotation about the ground pivot
    this.tiltRoll = 0;
    this.tiltLift = 0;         // pivot raised off the ground (airborne dive)
    this.tiltFwd = 0;          // pivot moved forward (lunges)
    this.tiltSide = 0;         // pivot moved to his left (landing beside a tackled carrier)
    this.pelvis = new THREE.Vector3(0, 1, 0);   // hip-joint centre in the tilt frame
    this.hips = new THREE.Vector3();            // pelvis orientation
    this.spine = new THREE.Vector3();           // spread over abdomen and chest
    this.head = new THREE.Vector3();            // head orientation in the tilt frame
    this.feet = [new THREE.Vector3(0.1, 0.09, 0), new THREE.Vector3(-0.1, 0.09, 0)];
    this.footRot = [new THREE.Vector3(), new THREE.Vector3()];
    this.knees = [new THREE.Vector3(0.15, 0, 1), new THREE.Vector3(-0.15, 0, 1)];
    this.hands = [new THREE.Vector3(0.22, -0.4, 0), new THREE.Vector3(-0.22, -0.4, 0)];
    this.elbows = [new THREE.Vector3(0.3, -0.4, -1), new THREE.Vector3(-0.3, -0.4, -1)];
    this.wrists = [new THREE.Vector3(), new THREE.Vector3()];  // hand flex, twist, roll
  }

  copy(o) {
    this.yaw = o.yaw; this.tiltPitch = o.tiltPitch; this.tiltRoll = o.tiltRoll; this.tiltLift = o.tiltLift; this.tiltFwd = o.tiltFwd; this.tiltSide = o.tiltSide;
    this.pelvis.copy(o.pelvis); this.hips.copy(o.hips); this.spine.copy(o.spine); this.head.copy(o.head);
    for (let i = 0; i < 2; i++) {
      this.feet[i].copy(o.feet[i]); this.footRot[i].copy(o.footRot[i]); this.knees[i].copy(o.knees[i]);
      this.hands[i].copy(o.hands[i]); this.elbows[i].copy(o.elbows[i]); this.wrists[i].copy(o.wrists[i]);
    }
    return this;
  }

  // Moves this pose toward `o` by t (0..1).
  lerp(o, t) {
    if (t <= 0) return this;
    if (t >= 1) return this.copy(o);
    const mix = (a, b) => a + (b - a) * t;
    this.yaw = mix(this.yaw, o.yaw); this.tiltPitch = mix(this.tiltPitch, o.tiltPitch); this.tiltRoll = mix(this.tiltRoll, o.tiltRoll);
    this.tiltLift = mix(this.tiltLift, o.tiltLift); this.tiltFwd = mix(this.tiltFwd, o.tiltFwd); this.tiltSide = mix(this.tiltSide, o.tiltSide);
    this.pelvis.lerp(o.pelvis, t); this.hips.lerp(o.hips, t); this.spine.lerp(o.spine, t); this.head.lerp(o.head, t);
    for (let i = 0; i < 2; i++) {
      this.feet[i].lerp(o.feet[i], t); this.footRot[i].lerp(o.footRot[i], t); this.knees[i].lerp(o.knees[i], t);
      this.hands[i].lerp(o.hands[i], t); this.elbows[i].lerp(o.elbows[i], t); this.wrists[i].lerp(o.wrists[i], t);
    }
    return this;
  }
}

// Spine rotation is shared between the abdomen and the chest so a deep bend
// curves the back instead of hinging at the belt.
export const SPINE_SPLIT = 0.45;

const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();
const _m = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0);

export function eulerQuat(v, out, scale = 1) {
  _e.set(v.x * scale, v.y * scale, v.z * scale, 'YXZ');
  return out.setFromEuler(_e);
}

// Chest frame expressed in the tilt frame, for a pose and a rig's dimensions.
// Mirrors exactly what Rig.apply does to its nodes.
export function chestMatrix(pose, dims, out) {
  out.compose(pose.pelvis, eulerQuat(pose.hips, _q), _s);
  _m.compose(_p.set(0, dims.waist, 0), eulerQuat(pose.spine, _q, SPINE_SPLIT), _s);
  out.multiply(_m);
  _m.compose(_p.set(0, dims.mid, 0), eulerQuat(pose.spine, _q, 1 - SPINE_SPLIT), _s);
  return out.multiply(_m);
}

// Tilt frame in world (scene) space for a root at simulation (x, z).
export function tiltMatrix(x, z, yaw, pose, out) {
  out.compose(_p.set(x, 0, -z), _q.setFromAxisAngle(UP, yaw + pose.yaw), _s);
  _e.set(pose.tiltPitch, 0, pose.tiltRoll, 'XZY');
  _m.compose(_p.set(pose.tiltSide, pose.tiltLift, pose.tiltFwd), _q.setFromEuler(_e), _s);
  return out.multiply(_m);
}

// Places a hand by forward kinematics from shoulder flexion (forward +),
// elbow flexion, abduction (elbow out) and how far the forearm crosses toward
// the midline, all in radians, in the chest frame; the elbow pole follows.
// `weight` blends from the pose's current arm toward the result.
const _u = new THREE.Vector3(), _f = new THREE.Vector3(), _el = new THREE.Vector3();
export function armAngles(pose, i, d, flex, elbow, abduct = 0.1, inward = 0, weight = 1) {
  if (weight <= 0) return;
  const side = SIDES[i], [sx, sy, sz] = d.shoulder;
  _u.set(side * Math.sin(abduct), -Math.cos(abduct) * Math.cos(flex), Math.cos(abduct) * Math.sin(flex));
  _el.set(side * sx, sy, sz).addScaledVector(_u, d.upperArm);
  const a = flex + elbow;
  _f.set(side * (0.5 * Math.sin(abduct) - inward), -Math.cos(a), Math.sin(a)).normalize();
  _el.addScaledVector(_f, d.forearm);
  pose.hands[i].lerp(_el, weight);
  pose.elbows[i].lerp(_u, weight);
}
