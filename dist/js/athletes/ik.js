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
export function solveTwoBone(origin, target, pole, upperLength, lowerLength, outQuat) {
  _dir.subVectors(target, origin);
  let dist = _dir.length();
  if (dist < 1e-6) { _dir.set(0, -1, 0); dist = 1e-6; }
  _dir.divideScalar(dist);
  dist = clamp(dist, Math.abs(upperLength - lowerLength) + 1e-3, (upperLength + lowerLength) * 0.9995);

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
