import * as THREE from '../../vendor/three.module.js';
import { clamp } from './math.js';

const _dir = new THREE.Vector3(), _bend = new THREE.Vector3(), _upper = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _basis = new THREE.Matrix4();

// Analytic two-bone IK in the limb's parent space.
//
// `origin` is the upper joint (hip or shoulder), `target` the end effector
// (ankle or wrist) and `pole` the direction the middle joint (knee or elbow)
// should point. Bones hang along their local -Y axis at rest.
//
// Writes the upper bone's local orientation into `outQuat` (local +Z points
// toward the pole side) and returns the hinge angle for the lower bone about
// its local X axis (0 = straight, positive = folding away from the pole).
//
// A limb does not lock straight. Past 96.5 % of its length the hinge opens
// ever more slowly toward a small remaining bend, so the last centimetre of
// reach no longer swings the knee through twenty degrees, and the limb gives
// up to 3 % of its length instead (`out.stretch`, yards, for the caller to
// add to the two bones); `out.short` is how far the end still is from a
// target it cannot reach.
const SOFT = 0.965, TOP = 0.997, GIVE = 0.03;
export function solveTwoBone(origin, target, pole, upperLength, lowerLength, outQuat, out = null) {
  _dir.subVectors(target, origin);
  const reach = _dir.length(), length = upperLength + lowerLength;
  let dist = reach;
  if (dist < 1e-6) { _dir.set(0, -1, 0); dist = 1e-6; }
  _dir.divideScalar(dist);
  let stretch = 0;
  const soft = SOFT * length, top = TOP * length;
  if (dist > soft) {
    const eased = soft + (top - soft) * (1 - Math.exp(-(dist - soft) / (top - soft)));
    stretch = Math.min(dist - eased, GIVE * length);
    dist = eased;
  }
  if (out) { out.stretch = stretch; out.short = Math.max(0, reach - dist - stretch); }
  dist = Math.max(dist, Math.abs(upperLength - lowerLength) + 1e-3);

  // Bend plane: the pole's component perpendicular to the reach direction.
  _bend.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
  if (_bend.lengthSq() < 1e-8) _bend.set(0, 0, 1).addScaledVector(_dir, -_dir.z);
  if (_bend.lengthSq() < 1e-8) _bend.set(1, 0, 0);
  _bend.normalize();

  const cosA = clamp((upperLength * upperLength + dist * dist - lowerLength * lowerLength) / (2 * upperLength * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _upper.copy(_dir).multiplyScalar(cosA).addScaledVector(_bend, sinA);

  _y.copy(_upper).negate();
  _z.copy(_bend).multiplyScalar(cosA).addScaledVector(_dir, -sinA);
  _x.crossVectors(_y, _z);
  _basis.makeBasis(_x, _y, _z);
  outQuat.setFromRotationMatrix(_basis);

  const cosB = clamp((upperLength * upperLength + lowerLength * lowerLength - dist * dist) / (2 * upperLength * lowerLength), -1, 1);
  return Math.PI - Math.acos(cosB);
}
