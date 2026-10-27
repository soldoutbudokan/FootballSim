import * as THREE from '../../vendor/three.module.js';
import { GRAVITY } from '../sim.js';

// Camera direction for every view. Poses are computed in SIMULATION
// coordinates (x across, y up, z downfield) and converted to scene space
// (z negated) at the end. Motion uses critically damped springs.

export const CAMERA_MODES = ['game', 'broadcast', 'all22'];
export const normalizeCameraMode = mode => (CAMERA_MODES.includes(mode) ? mode : 'game');

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Critically damped spring toward `target` (Unity-style SmoothDamp).
function damp(current, target, velocity, key, smoothTime, dt) {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity[key] + omega * change) * dt;
  velocity[key] = (velocity[key] - omega * temp) * decay;
  return target + (change + temp) * decay;
}
function dampVector(current, target, velocity, smoothTime, dt) {
  current.x = damp(current.x, target.x, velocity, 'x', smoothTime, dt);
  current.y = damp(current.y, target.y, velocity, 'y', smoothTime, dt);
  current.z = damp(current.z, target.z, velocity, 'z', smoothTime, dt);
}

export class CameraDirector {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'game';
    this.position = new THREE.Vector3(0, 8, 10);
    this.target = new THREE.Vector3(0, 0, 35);
    this.fov = 42;
    this.velocity = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: { v: 0 } };
    this.snapNext = true;
    this.anchorId = null;
    this.phase = null;
    this.transition = 0;
    this.hold = null;
    this.broadcastZ = 35;
    this.all22Z = 35;
    this.lag = { broadcast: 0, all22: 0 };
    this.menuTime = 0;
  }

  // The next update jumps straight to the desired pose.
  cut() {
    this.snapNext = true;
  }

  update(state, dt, { menu = false, replay = false, aspect = 16 / 9 } = {}) {
    const controlled = state.players.find(p => p.id === (state.carrier || state.selected)) || state.players[0];
    let pose, smooth;
    if (menu) {
      this.menuTime += dt;
      pose = this.menuPose(state);
      smooth = 0.9;
    } else if (replay) {
      pose = this.replayPose(state);
      smooth = 0.3;
    } else {
      // Swing smoothly when the controlled player changes (catch, handoff) or the ball is snapped.
      const anchor = state.phase === 'air' ? 'ball' : controlled.id;
      if (anchor !== this.anchorId || (state.phase !== this.phase && (state.phase === 'live' || this.phase === 'presnap'))) {
        if (this.anchorId !== null) this.transition = 1;
        this.anchorId = anchor;
      }
      if (state.phase !== 'dead') this.hold = null;
      this.phase = state.phase;
      this.transition = Math.max(0, this.transition - dt * 1.1);
      if (this.mode === 'broadcast') pose = this.broadcastPose(state, controlled, dt);
      else if (this.mode === 'all22') pose = this.all22Pose(state, controlled, dt);
      else pose = this.gamePose(state, controlled, aspect);
      smooth = pose.smooth * (1 + this.transition * 1.6);
      if (state.phase === 'dead') pose = this.deadPose(pose, state);
    }
    this.apply(pose, smooth, dt);
  }

  apply(pose, smooth, dt) {
    if (this.snapNext || dt <= 0) {
      this.position.copy(pose.position);
      this.target.copy(pose.target);
      this.fov = pose.fov;
      this.velocity = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: { v: 0 } };
      this.snapNext = false;
    } else {
      dampVector(this.position, pose.position, this.velocity.position, smooth, dt);
      dampVector(this.target, pose.target, this.velocity.target, smooth * (pose.targetSmooth ?? 1), dt);
      this.fov = damp(this.fov, pose.fov, this.velocity.fov, 'v', Math.max(0.35, smooth * 1.4), dt);
    }
    const camera = this.camera;
    camera.position.set(this.position.x, this.position.y, -this.position.z);
    camera.lookAt(this.target.x, this.target.y, -this.target.z);
    if (Math.abs(camera.fov - this.fov) > 1e-3) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  // --- game camera: low, behind the offense --------------------------------

  gamePose(state, controlled, aspect) {
    // Portrait screens get a wider lens so the play stays readable.
    const portrait = aspect < 1;
    const fov = portrait ? clamp(42 / Math.sqrt(aspect), 42, 62) : 42;
    if (state.phase === 'presnap') return this.formationPose(state, aspect, fov);
    if (state.phase === 'air') {
      // Track between the ball and where it will come down, a little wider.
      const b = state.ball, land = landingPoint(b);
      const fx = b.x + (land.x - b.x) * 0.55, fz = b.z + (land.z - b.z) * 0.55;
      return {
        position: new THREE.Vector3(fx * 0.7, 7.2, Math.min(b.z, fz) - 13),
        target: new THREE.Vector3(fx, 0.8, fz + 2),
        fov: fov + 4,
        smooth: 0.32,
      };
    }
    const vx = controlled.vx || 0, vz = controlled.vz || 0;
    const back = 10.5, height = 5.5, ahead = 12;
    const lead = clamp(vz * 0.25, -1.5, 2.5);
    return {
      position: new THREE.Vector3(controlled.x * 0.88 + vx * 0.1, height, controlled.z - back + lead * 0.5),
      target: new THREE.Vector3(controlled.x * 0.9 + vx * 0.25, 0.9, controlled.z + ahead + lead),
      fov,
      smooth: 0.25,
    };
  }

  // Pre-snap: behind the quarterback, pulled back just far enough that every
  // receiver at the line is on screen.
  formationPose(state, aspect, fov) {
    const los = state.spot;
    let spread = 6;
    for (const p of state.players) if (Math.abs(p.z - los) < 7) spread = Math.max(spread, Math.abs(p.x));
    spread += 2.2;
    const tanH = Math.tan(fov * DEG / 2) * aspect;
    let back = 16;
    const position = new THREE.Vector3(), target = new THREE.Vector3(), f = new THREE.Vector3();
    for (let i = 0; i < 6; i++) {
      position.set(0, 3.2 + back * 0.2, los - back);
      target.set(0, 0.4, los + 8);
      f.copy(target).sub(position).normalize();
      const depth = (los - position.z) * f.z + (0 - position.y) * f.y;   // view depth of the LOS at x = 0
      const needed = spread / (tanH * 0.94);
      back = clamp(back * Math.pow(needed / Math.max(1, depth), 0.85), 15.5, 36);
    }
    position.set(0, 3.2 + back * 0.2, los - back);
    return { position, target, fov, smooth: 0.45 };
  }

  // Dead ball: hold the last framing and push in slowly.
  deadPose(pose, state) {
    if (!this.hold) this.hold = { position: this.position.clone(), target: this.target.clone(), fov: this.fov };
    const push = Math.min(0.28, (state.deadTime || 0) * 0.07);
    return {
      position: this.hold.position.clone().lerp(this.hold.target, push),
      target: this.hold.target.clone(),
      fov: this.hold.fov,
      smooth: 0.6,
    };
  }

  // --- broadcast: sideline press box, long lens -----------------------------

  broadcastPose(state, controlled, dt) {
    const focus = state.phase === 'air' ? state.ball : state.phase === 'presnap' ? { x: 0, z: state.spot + 3 } : controlled;
    this.broadcastZ = damp(this.broadcastZ, focus.z, this.lag, 'broadcast', 0.8, dt);
    if (!Number.isFinite(this.broadcastZ) || this.snapNext) this.broadcastZ = focus.z;
    const position = new THREE.Vector3(-60, 22, this.broadcastZ - 4);
    const target = new THREE.Vector3(focus.x * 0.75, 0.6, this.broadcastZ);
    const distance = position.distanceTo(target);
    // Keep players a similar size on screen whatever the distance.
    const fov = clamp(2 * Math.atan(8.5 / distance) / DEG, 12, 30);
    return { position, target, fov, smooth: 0.5, targetSmooth: 0.7 };
  }

  // --- all-22: high end-zone view behind the offense ------------------------

  all22Pose(state, controlled, dt) {
    const focusZ = state.phase === 'presnap' ? state.spot : Math.max(state.spot - 4, (state.phase === 'air' ? state.ball.z : controlled.z) - 6);
    this.all22Z = damp(this.all22Z, focusZ, this.lag, 'all22', 0.7, dt);
    if (!Number.isFinite(this.all22Z) || this.snapNext) this.all22Z = focusZ;
    return {
      position: new THREE.Vector3(0, 32, this.all22Z - 38),
      target: new THREE.Vector3(0, 0, this.all22Z + 9),
      fov: 38,
      smooth: 0.45,
    };
  }

  // --- menu: slow eye-level pass across the field from the defense's side ---

  menuPose(state) {
    const t = this.menuTime;
    const s = 0.5 - 0.5 * Math.cos(t * 2 * Math.PI / 90);   // 0 -> 1 -> 0 over 90 s
    const spot = state.spot;
    const x = -25 + s * 30, z = spot + 31 - s * 6;
    return {
      position: new THREE.Vector3(x, 1.9 + s * 0.8, z),
      target: new THREE.Vector3(x * 0.35 + 4, 3.2, spot - 22),
      fov: 40,
      smooth: 0.9,
    };
  }

  // --- replay: low three-quarter angle tracking the ball, slow push-in -------

  replayPose(state) {
    const b = state.ball;
    const push = 1 - 0.3 * Math.min(1, (state.time || 0) / 5);
    return {
      position: new THREE.Vector3(b.x - 8.5 * push, 2.4 + 0.6 * push, b.z - 8.5 * push),
      target: new THREE.Vector3(b.x, Math.max(0.6, Math.min(b.y, 3)), b.z + 1),
      fov: 38,
      smooth: 0.3,
    };
  }

  // Scene-space point the camera is looking at on the ground (for grass and shadows).
  groundFocus(out) {
    return out.set(this.target.x, 0, -this.target.z);
  }
}

// Where a ball in flight comes down to catch height (simulation coordinates).
export function landingPoint(ball) {
  const vy = ball.vy || 0, vx = ball.vx || 0, vz = ball.vz || 0;
  const h = (ball.y || 0) - 1.3;
  const t = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * GRAVITY * h))) / GRAVITY;
  const time = Number.isFinite(t) ? clamp(t, 0, 4) : 0;
  return { x: ball.x + vx * time, z: ball.z + vz * time };
}
