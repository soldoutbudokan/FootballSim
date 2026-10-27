import * as THREE from '../../vendor/three.module.js';
import { football, footballLaces, BALL } from './geometry.js';
import { smoothstep } from './math.js';

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const SNAP_TIME = 0.3;       // shotgun snap flight, seconds after the snap
const SPIN_RATE = 36;        // rad/s, a tight spiral
const _v = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _m = new THREE.Matrix4();

// The practice ball. It is never instanced: one mesh pair, placed each frame
// from the snapshot (in flight, at rest) or from the holder's hands.
export class Football {
  constructor(scene, materials) {
    this.group = new THREE.Group();
    this.group.name = 'athletes:ball';
    const body = new THREE.Mesh(football(), materials.leather);
    const laces = new THREE.Mesh(footballLaces(), materials.laces);
    body.castShadow = laces.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body, laces);
    scene.add(this.group);
    this.target = new THREE.Vector3();
    this.targetQuat = new THREE.Quaternion();
    this.fromPos = new THREE.Vector3();
    this.fromQuat = new THREE.Quaternion();
    this.snapFrom = new THREE.Vector3(0, BALL.radius, -35);
    this.lastAir = new THREE.Vector3();
    this.anchor = null;
    this.blend = 1;
    this.blendTime = 0.1;
    this.spin = 0;
    this.flightYaw = 0;
  }

  get position() { return this.group.position; }

  update(ctx, athletes) {
    const s = ctx.state, b = s.ball;
    let anchor;
    if (s.phase === 'presnap') {
      anchor = 'snap';
      this.onGround(b.x, b.z, 0, false);
      this.snapFrom.copy(this.target);
    } else if (ctx.holderId && athletes.rigs.has(ctx.holderId)) {
      anchor = 'held:' + ctx.holderId;
      this.held(athletes.rigs.get(ctx.holderId), athletes.animators.get(ctx.holderId), ctx);
      if (s.phase === 'live' && ctx.holderId === ctx.qbId && s.time < SNAP_TIME) this.snapArc(s.time / SNAP_TIME);
    } else if (s.phase === 'air') {
      anchor = 'air';
      this.inFlight(b, ctx.dt);
    } else {
      anchor = 'loose';
      this.onGround(b.x, b.z, this.flightYaw, true);
    }

    if (anchor !== this.anchor) {
      const continuous = this.anchor === 'snap' || this.anchor === null || ctx.reset || anchor === 'snap';
      this.blend = continuous ? 1 : 0;
      this.blendTime = anchor === 'loose' ? 0.25 : 0.1;
      this.fromPos.copy(this.group.position);
      this.fromQuat.copy(this.group.quaternion);
      this.anchor = anchor;
    }
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + ctx.dt / this.blendTime);
      const w = smoothstep(0, 1, this.blend);
      this.group.position.copy(this.fromPos).lerp(this.target, w);
      this.group.quaternion.copy(this.fromQuat).slerp(this.targetQuat, w);
    } else {
      this.group.position.copy(this.target);
      this.group.quaternion.copy(this.targetQuat);
    }
    this.group.updateMatrixWorld(true);
  }

  // Lying on the turf: pre-snap at the line (nose downfield, laces up), or a
  // dead loose ball rolled onto its side.
  onGround(x, z, yaw, onSide) {
    this.target.set(x, BALL.radius * 0.98, -z);
    _e.set(0, yaw, onSide ? Math.PI / 2 : 0, 'YXZ');
    this.targetQuat.setFromEuler(_e);
  }

  // Nose along the velocity, spinning about its long axis.
  inFlight(b, dt) {
    this.target.set(b.x, b.y, -b.z);
    _v.set(b.vx || 0, b.vy || 0, -(b.vz || 0));
    if (_v.lengthSq() < 0.5) _v.subVectors(this.target, this.lastAir);
    this.lastAir.copy(this.target);
    if (_v.lengthSq() < 1e-6) return;
    _v.normalize();
    this.flightYaw = Math.atan2(_v.x, _v.z);
    this.spin += dt * SPIN_RATE;
    this.targetQuat.setFromUnitVectors(Z_AXIS, _v).multiply(_q.setFromAxisAngle(Z_AXIS, this.spin));
  }

  // Shotgun snap: a low spiral from the centre's hand back to the quarterback.
  snapArc(u) {
    const w = smoothstep(0, 1, u);
    _v.copy(this.target);
    this.target.lerpVectors(this.snapFrom, _v, w);
    this.target.y += Math.sin(Math.PI * u) * 0.35;
    _u.subVectors(_v, this.snapFrom).normalize();
    this.spin += 0.016 * SPIN_RATE;
    if (u < 0.95) this.targetQuat.setFromUnitVectors(Z_AXIS, _u).multiply(_q.setFromAxisAngle(Z_AXIS, this.spin));
  }

  // In the holder's hands: two hands at the chest (pocket, gun, early catch),
  // the throwing hand during the throw, otherwise tucked along the forearm.
  held(rig, anim, ctx) {
    const W = rig.world, action = anim?.action;
    const twoHands = action === 'pocket' || action === 'ready' || (action === 'catch' && anim.age < 0.22);
    const yaw = rig.root.rotation.y;
    if (action === 'throw') {
      // Ball sits in the fingers of the right hand, nose toward the target.
      _m.copy(rig.hands[1].matrixWorld);
      this.target.set(-0.035, -0.085, 0.02).applyMatrix4(_m);
      _e.set(-0.35, yaw, 0, 'YXZ');
      this.targetQuat.setFromEuler(_e);
    } else if (twoHands) {
      this.target.addVectors(W.hands[0], W.hands[1]).multiplyScalar(0.5);
      this.target.x += Math.sin(yaw) * 0.06; this.target.z += Math.cos(yaw) * 0.06;
      this.target.y -= 0.02;
      _e.set(-0.15, yaw, 0, 'YXZ');
      this.targetQuat.setFromEuler(_e);
    } else {
      const i = anim?.carryArm ?? 1;
      // Along the forearm, nose in the hand, pressed against the ribs.
      _u.subVectors(W.hands[i], W.elbows[i]);
      const len = _u.length();
      if (len > 1e-4) _u.divideScalar(len); else _u.set(Math.sin(yaw), 0, Math.cos(yaw));
      this.target.copy(W.elbows[i]).addScaledVector(_u, len * 0.62);
      _v.subVectors(W.chest, this.target); _v.y = 0;
      if (_v.lengthSq() > 1e-6) this.target.addScaledVector(_v.normalize(), 0.035);
      this.target.y += 0.015;
      this.targetQuat.setFromUnitVectors(Z_AXIS, _u);
      // Roll so the laces face away from the body.
      _q.setFromAxisAngle(Z_AXIS, (i === 1 ? -1 : 1) * Math.PI / 2);
      this.targetQuat.multiply(_q);
    }
  }
}

