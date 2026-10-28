// Bone manipulation in CHARACTER SPACE (the player root's local space: feet on
// y = 0, facing +z, left at +x, yards), independent of each rig's own bone
// axes. The procedural layer is written with these primitives, so it works
// on any humanoid after the mixer has posed it from clips:
//   rotate(bone, q)        apply a character-space rotation to a bone
//   aim(bone, child, dir)  turn a bone so its child lies along `dir`
//   reach(...)             two-bone IK (hip-knee-ankle, shoulder-elbow-wrist)
// Positions/rotations are computed lazily up the parent chain and cached
// until the next change.
import * as THREE from '../../vendor/three.module.js';

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const IDENTITY = new THREE.Quaternion();

export class PoseRig {
  // bones: {canonical: Bone}; base: {quaternion, scale, position} of the hips'
  // parent in character space; rest: {canonical: {quaternion (local), charQuaternion}}
  constructor(bones, base, rest) {
    this.bones = bones;
    this.base = base;
    this.rest = rest;
    this.top = bones.Hips.parent;   // the static node above the skeleton
    this.qCache = new Map();
    this.pCache = new Map();
    this.length = {};
    for (const [a, b] of [['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'], ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'],
      ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'], ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand']]) {
      this.length[a] = bones[b].position.length() * base.scale;
    }
  }

  invalidate() { this.qCache.clear(); this.pCache.clear(); }

  // Character-space rotation of a node (Bone or the static top node).
  charQuat(node) {
    if (node === this.top) return this.base.quaternion;
    let q = this.qCache.get(node);
    if (!q) {
      q = new THREE.Quaternion().multiplyQuaternions(this.charQuat(node.parent), node.quaternion);
      this.qCache.set(node, q);
    }
    return q;
  }

  // Character-space position of a node (bones are assumed unscaled).
  charPos(node) {
    if (node === this.top) return this.base.position;
    let p = this.pCache.get(node);
    if (!p) {
      p = node.position.clone().multiplyScalar(this.base.scale).applyQuaternion(this.charQuat(node.parent)).add(this.charPos(node.parent));
      this.pCache.set(node, p);
    }
    return p;
  }

  pos(name) { return this.charPos(this.bones[name]); }
  quat(name) { return this.charQuat(this.bones[name]); }

  // Applies a character-space rotation (pre-multiplied) to a bone, scaled by
  // weight 0..1. Children follow.
  rotate(name, q, weight = 1) {
    const bone = this.bones[name];
    if (!bone || weight <= 0) return;
    const parent = this.charQuat(bone.parent);
    _q.copy(q);
    if (weight < 1) _q.slerpQuaternions(IDENTITY, q, weight);
    // local' = (P^-1 q P) local
    _qi.copy(parent).invert();
    _q2.copy(_qi).multiply(_q).multiply(parent);
    bone.quaternion.premultiply(_q2);
    this.invalidate();
  }

  // Rotation about a character-space axis.
  turn(name, axis, angle) {
    if (!angle) return;
    this.rotate(name, _q.setFromAxisAngle(axis, angle).clone());
  }

  // Turns `name` so that its child joint lies along `dir` (character space).
  aim(name, child, dir, weight = 1) {
    const from = _v.copy(this.pos(child)).sub(this.pos(name));
    if (from.lengthSq() < 1e-10 || dir.lengthSq() < 1e-10) return;
    from.normalize();
    const to = _v2.copy(dir).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(from, to);
    this.rotate(name, q, weight);
  }

  // Two-bone IK: upper -> mid -> end reaches `target`, the middle joint bending
  // toward `pole` (a character-space direction). Weight blends from the
  // animated pose.
  reach(upper, mid, end, target, pole, weight = 1) {
    if (weight <= 0) return;
    const a = this.length[upper], b = this.length[mid];
    const root = this.pos(upper).clone();
    const toTarget = _v3.copy(target).sub(root);
    let d = toTarget.length();
    if (d < 1e-6) return;
    d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, d));
    const dir = toTarget.normalize();
    const cos = (a * a + d * d - b * b) / (2 * a * d);
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const bend = pole.clone().addScaledVector(dir, -pole.dot(dir));
    if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1).addScaledVector(dir, -dir.z);
    bend.normalize();
    const knee = root.clone().addScaledVector(dir, a * cos).addScaledVector(bend, a * sin);
    this.aim(upper, mid, knee.sub(root), weight);
    const tip = root.addScaledVector(dir, d);
    const midPos = this.pos(mid).clone();
    this.aim(mid, end, tip.sub(midPos), weight);
  }

  // Sets a bone's character-space rotation (blended), e.g. keep a foot flat.
  orient(name, q, weight = 1) {
    const current = this.quat(name);
    const delta = new THREE.Quaternion().copy(q).multiply(_qi.copy(current).invert());
    this.rotate(name, delta, weight);
  }

  // Moves the hips by a character-space offset (yards).
  shiftHips(offset) {
    const hips = this.bones.Hips;
    const local = _v.copy(offset).applyQuaternion(_qi.copy(this.charQuat(hips.parent)).invert()).multiplyScalar(1 / this.base.scale);
    hips.position.add(local);
    this.invalidate();
  }

  // Places the hips at a character-space height (yards), keeping x/z.
  hipsHeight(y, weight = 1) {
    const current = this.pos('Hips').y;
    this.shiftHips(_v2.set(0, (y - current) * weight, 0));
  }

  // Exaggerates a bone's rotation away from its rest pose (k > 1).
  stretch(name, k) {
    const bone = this.bones[name];
    const rest = this.rest[name]?.quaternion;
    if (!bone || !rest || Math.abs(k - 1) < 1e-3) return;
    _q.copy(rest).invert().multiply(bone.quaternion);         // rest -> current, local
    const angle = 2 * Math.acos(Math.min(1, Math.abs(_q.w)));
    if (angle < 1e-4) return;
    const axis = _v.set(_q.x, _q.y, _q.z).normalize().multiplyScalar(Math.sign(_q.w) || 1);
    _q2.setFromAxisAngle(axis, angle * k);
    bone.quaternion.copy(rest).multiply(_q2);
    this.invalidate();
  }
}

export const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
