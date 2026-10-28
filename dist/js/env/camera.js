import * as THREE from '../../vendor/three.module.js';
import { GRAVITY } from '../sim.js';

// Camera direction for every view. Poses are computed in SIMULATION
// coordinates (x across, y up, z downfield) and converted to scene space
// (z negated) at the end. Motion uses critically damped springs.

export const CAMERA_MODES = ['game', 'broadcast', 'all22'];
export const normalizeCameraMode = mode => (CAMERA_MODES.includes(mode) ? mode : 'game');

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The default game camera (plan 4.5), relative to the controlled player.
export const GAME_RIG = { back: 10.5, height: 5.5, ahead: 12, lookHeight: 0.9, fov: 42, smooth: 0.25 };

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

  // Switching views glides to the new framing; a held dead-ball shot belongs
  // to the old view, so it is dropped.
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.hold = null;
    this.transition = 1;
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

  // The same rig before the snap (behind the quarterback) and during the play
  // (behind whoever has the ball or is selected): GAME_RIG.back yards behind,
  // GAME_RIG.height above, looking GAME_RIG.ahead yards downfield.
  gamePose(state, controlled, aspect) {
    // Portrait screens get a wider lens so the play stays readable.
    const fov = aspect < 1 ? clamp(GAME_RIG.fov / Math.sqrt(aspect), GAME_RIG.fov, 56) : GAME_RIG.fov;
    if (state.phase === 'air') return this.airPose(state, fov);
    const moving = state.phase !== 'presnap';
    const vx = moving ? controlled.vx || 0 : 0, vz = moving ? controlled.vz || 0 : 0;
    // A critically damped follow trails a moving player by velocity x smooth
    // time; leading by the same amount keeps the rig distance at full speed.
    const leadX = clamp(vx * GAME_RIG.smooth, -2.5, 2.5), leadZ = clamp(vz * GAME_RIG.smooth, -2.5, 2.5);
    // Slightly toward the middle of the field so a player near the sideline
    // still has the field in front of him.
    const x = controlled.x * 0.88 + leadX;
    return {
      position: new THREE.Vector3(x, GAME_RIG.height, controlled.z - GAME_RIG.back + leadZ),
      target: new THREE.Vector3(controlled.x * 0.92 + leadX, GAME_RIG.lookHeight, controlled.z + GAME_RIG.ahead + leadZ),
      fov,
      smooth: GAME_RIG.smooth,
    };
  }

  // Ball in the air: frame the ball and the spot where it will come down from
  // behind and a little higher, with a slightly wider lens. As the ball
  // arrives the framing converges on the receiver, ready to follow him.
  airPose(state, fov) {
    const b = state.ball, land = landingPoint(b);
    const mx = b.x + (land.x - b.x) * 0.5, mz = b.z + (land.z - b.z) * 0.5;
    const span = Math.hypot(land.x - b.x, land.z - b.z);
    return {
      position: new THREE.Vector3(mx * 0.75, GAME_RIG.height + 1 + Math.min(2, span * 0.06), Math.min(b.z, mz) - GAME_RIG.back - 1.5 - Math.min(4, span * 0.12)),
      target: new THREE.Vector3(mx, clamp(b.y * 0.4, GAME_RIG.lookHeight, 4), mz + 2),
      fov: fov + 5,
      smooth: 0.35,
    };
  }

  // Dead ball: hold the last framing, settle the look onto the ball (the
  // pile, the receiver, the spot where the pass landed) and push in slowly
  // toward it. Pushing toward the old look-at point, 12 yd downfield, would
  // carry the camera over the tackle and frame empty grass.
  deadPose(pose, state) {
    if (!this.hold) this.hold = { position: this.position.clone(), target: this.target.clone(), fov: this.fov };
    const t = state.deadTime || 0, b = state.ball;
    const focus = new THREE.Vector3(b.x, clamp(b.y, 0.6, 1.4), b.z);
    const settle = Math.min(1, t / 1.2);
    const target = this.hold.target.clone().lerp(focus, 0.85 * settle * settle * (3 - 2 * settle));
    const position = this.hold.position.clone();
    const reach = position.distanceTo(focus);
    const push = Math.min(0.22, t * 0.06) * clamp((reach - 6) / reach, 0, 1);
    position.lerp(focus, push);
    return { position, target, fov: this.hold.fov, smooth: 0.6 };
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
      position: new THREE.Vector3(x, 2.3 + s * 0.8, z),
      target: new THREE.Vector3(x * 0.35 + 4, 2.4, spot - 22),
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
