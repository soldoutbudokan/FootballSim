import * as THREE from '../../vendor/three.module.js';
import { GRAVITY } from '../sim.js';

// Camera direction for every view. Poses are computed in SIMULATION
// coordinates (x across, y up, z downfield) and converted to scene space
// (z negated) at the end. Motion uses critically damped springs.

export const CAMERA_MODES = ['game', 'broadcast', 'all22'];
export const normalizeCameraMode = mode => (CAMERA_MODES.includes(mode) ? mode : 'game');

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The play camera, relative to the controlled player: high enough that the
// offensive line does not fill the bottom of the frame and the ball reads.
export const GAME_RIG = { back: 12, height: 7.5, ahead: 14, lookHeight: 0.9, fov: 46, smooth: 0.25 };

// Before the snap: wider and higher behind the quarterback, so all five
// eligible receivers (split out to 21 yd) and their badges are in frame. On
// narrower screens the camera backs up (up to maxBack yards behind the
// quarterback, rising `climb` yards per yard) until `halfWidth` yards either
// side of the ball fill `fill` of the half-frame at the line of scrimmage.
export const PRESNAP_RIG = { back: 15, height: 8, ahead: 12, lookHeight: 0.6, fov: 58, halfWidth: 21.5, fill: 0.95, maxBack: 22, climb: 0.3 };

// At the snap the pre-snap framing eases into the play camera over this long
// (seconds of game time).
export const SNAP_EASE = 0.7;

// While the carrier is being wrapped up the camera swings around him, away
// from the tackler, and rises a little so the tackler does not hide him.
export const TACKLE_SWING = { angle: 25 * DEG, rise: 1.2 };

// The title menu frames the players right of centre (left of centre being
// under the menu); on portrait screens the menu fills the bottom, so the
// players sit in the upper part of the frame.
const MENU_FRAMING = { landscape: { x: 0.42, y: 0.05 }, portrait: { x: 0, y: 0.38 } };

const smoothstep = t => { const k = clamp(t, 0, 1); return k * k * (3 - 2 * k); };

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
    this.presnapAnchor = null;   // the quarterback's pre-snap spot (snap ease)
    this.swingSide = 0;          // -1 / +1: side the camera swung to in a tackle
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
      pose = this.menuPose(state, aspect);
      smooth = 0.9;
    } else if (replay) {
      pose = this.replayPose(state);
      smooth = 0.3;
    } else {
      // Swing smoothly when the controlled player changes (catch, handoff).
      // The game camera eases out of its pre-snap framing on its own (below);
      // the other views glide at the snap as before.
      const anchor = state.phase === 'air' ? 'ball' : controlled.id;
      const snapped = state.phase !== this.phase && (state.phase === 'live' || this.phase === 'presnap');
      if (anchor !== this.anchorId || (snapped && this.mode !== 'game')) {
        if (this.anchorId !== null && !(this.mode === 'game' && this.phase === 'presnap')) this.transition = 1;
        this.anchorId = anchor;
      }
      if (state.phase !== 'dead') this.hold = null;
      if (state.phase === 'presnap') { this.presnapAnchor = { x: controlled.x, z: controlled.z }; this.swingSide = 0; }
      this.phase = state.phase;
      this.transition = Math.max(0, this.transition - dt * 1.1);
      if (this.mode === 'broadcast') pose = this.broadcastPose(state, controlled, dt);
      else if (this.mode === 'all22') pose = this.all22Pose(state, controlled, dt);
      else pose = this.gameCamera(state, controlled, aspect);
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

  // --- game camera: behind the offense ---------------------------------------

  // Pre-snap framing before the snap; the play rig after it, eased in from
  // the pre-snap framing over SNAP_EASE seconds of game time.
  gameCamera(state, controlled, aspect) {
    if (state.phase === 'presnap') return this.presnapPose(state, controlled, aspect);
    const pose = this.gamePose(state, controlled, aspect);
    const ease = smoothstep((state.time || 0) / SNAP_EASE);
    if (ease >= 1) return pose;
    const from = this.presnapPose(state, this.presnapAnchor || { x: 0, z: (state.spot ?? 35) - 5 }, aspect);
    // The blend is already smooth: follow it closely so the whole move takes
    // about SNAP_EASE rather than SNAP_EASE plus the follow lag.
    return {
      position: from.position.lerp(pose.position, ease),
      target: from.target.lerp(pose.target, ease),
      fov: from.fov + (pose.fov - from.fov) * ease,
      smooth: pose.smooth * 0.5,
    };
  }

  // Behind the quarterback (`qb`: his pre-snap position), far and high enough
  // for the whole formation at this aspect ratio.
  presnapPose(state, qb, aspect) {
    const R = PRESNAP_RIG;
    const fov = aspect < 1 ? clamp(R.fov / Math.sqrt(aspect), R.fov, 72) : R.fov;
    const halfFrame = Math.max(0.1, aspect) * Math.tan(fov * DEG / 2);
    const depth = Math.max(0, (state.spot ?? 35) - qb.z);
    const back = clamp(R.halfWidth / (R.fill * halfFrame) - depth, R.back, R.maxBack);
    return {
      position: new THREE.Vector3(qb.x * 0.88, R.height + (back - R.back) * R.climb, qb.z - back),
      target: new THREE.Vector3(qb.x * 0.92, R.lookHeight, qb.z + R.ahead),
      fov,
      smooth: GAME_RIG.smooth,
    };
  }

  // During the play, behind whoever has the ball or is selected:
  // GAME_RIG.back yards behind, GAME_RIG.height above, looking GAME_RIG.ahead
  // yards downfield.
  gamePose(state, controlled, aspect) {
    // Portrait screens get a wider lens so the play stays readable.
    const fov = aspect < 1 ? clamp(GAME_RIG.fov / Math.sqrt(aspect), GAME_RIG.fov, 60) : GAME_RIG.fov;
    if (state.phase === 'air') return this.airPose(state, fov);
    const vx = controlled.vx || 0, vz = controlled.vz || 0;
    // A critically damped follow trails a moving player by velocity x smooth
    // time; leading by the same amount keeps the rig distance at full speed.
    const leadX = clamp(vx * GAME_RIG.smooth, -2.5, 2.5), leadZ = clamp(vz * GAME_RIG.smooth, -2.5, 2.5);
    // Slightly toward the middle of the field so a player near the sideline
    // still has the field in front of him.
    const cx = controlled.x * 0.88 + leadX, cz = controlled.z + leadZ;
    let back = GAME_RIG.back, height = GAME_RIG.height, ahead = GAME_RIG.ahead, yaw = 0;
    if (state.phase === 'tackle') {
      // Swing around the carrier away from the tackler (chosen once per
      // tackle so the camera does not flip back and forth), rise, and look
      // closer in.
      if (!this.swingSide) this.swingSide = tackleSwingSide(state, controlled);
      yaw = this.swingSide * TACKLE_SWING.angle;
      height += TACKLE_SWING.rise;
      ahead *= 0.4;
    }
    // yaw > 0 puts the camera on the carrier's +x side, looking back across.
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    return {
      position: new THREE.Vector3(cx + back * sin, height, cz - back * cos),
      target: new THREE.Vector3(controlled.x * 0.92 + leadX - ahead * sin, GAME_RIG.lookHeight, cz + ahead * cos),
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
  // carry the camera over the tackle and frame empty grass. The game camera
  // also rises and steps aside (away from the tackle, or from the players
  // standing over the ball) so a downed carrier is not hidden behind them.
  deadPose(pose, state) {
    if (!this.hold) {
      const side = this.mode === 'game' ? (this.swingSide || crowdSide(state)) : 0;
      this.hold = { position: this.position.clone(), target: this.target.clone(), fov: this.fov, side };
    }
    const t = state.deadTime || 0, b = state.ball;
    const focus = new THREE.Vector3(b.x, clamp(b.y, 0.6, 1.4), b.z);
    const settle = smoothstep(t / 1.2);
    const target = this.hold.target.clone().lerp(focus, 0.85 * settle);
    const position = this.hold.position.clone();
    if (this.mode === 'game') {
      // After a tackle swing the camera is already aside and raised.
      const swung = this.swingSide !== 0;
      position.x += this.hold.side * (swung ? 1 : 2.5) * settle;
      position.y += (swung ? 0.5 : 1.4) * settle;
    }
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

  menuPose(state, aspect = 16 / 9) {
    const t = this.menuTime;
    const s = 0.5 - 0.5 * Math.cos(t * 2 * Math.PI / 90);   // 0 -> 1 -> 0 over 90 s
    const spot = state.spot ?? 35;
    const x = -25 + s * 30, z = spot + 31 - s * 6, fov = 40;
    const position = new THREE.Vector3(x, 2.3 + s * 0.8, z);
    // Aim so the formation (centred a yard behind the ball) lands at the
    // framing point instead of the centre of the screen.
    const framing = aspect < 1 ? MENU_FRAMING.portrait : MENU_FRAMING.landscape;
    const target = aimOffset(position, new THREE.Vector3(0, 1, spot - 1), framing, fov, aspect);
    return { position, target, fov, smooth: 0.9 };
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

// A look-at point that puts `focus` at normalised screen position
// (framing.x, framing.y) (-1..1, +x right, +y up) seen from `position`
// (simulation coordinates). Looking along heading a, screen-right is
// heading a + 90 degrees (scene z is negated).
export function aimOffset(position, focus, framing, fov, aspect) {
  const dx = focus.x - position.x, dz = focus.z - position.z, flat = Math.hypot(dx, dz) || 1;
  const tanV = Math.tan(fov * DEG / 2);
  const yaw = Math.atan2(dx, dz) - Math.atan(framing.x * aspect * tanV);
  const pitch = Math.atan2(focus.y - position.y, flat) - Math.atan(framing.y * tanV);
  return new THREE.Vector3(
    position.x + Math.sin(yaw) * flat,
    position.y + Math.tan(pitch) * flat,
    position.z + Math.cos(yaw) * flat,
  );
}

// The side (-1 or +1, simulation x) the game camera swings to while the
// carrier is wrapped up: away from the tackler. With the tackler straight
// behind the carrier, toward the middle of the field.
export function tackleSwingSide(state, carrier) {
  const tackler = state.players.find(p => p.action === 'tackle' && p.id !== carrier.id);
  const dx = tackler ? tackler.x - carrier.x : 0;
  if (Math.abs(dx) > 0.15) return dx > 0 ? -1 : 1;
  return carrier.x > 0 ? -1 : 1;
}

// After the whistle without a tackle swing: away from the players standing
// within 3 yd of the ball (the one holding it excluded).
export function crowdSide(state) {
  const b = state.ball;
  let sum = 0, count = 0, nearest = null, gap = Infinity;
  for (const p of state.players) {
    const d = Math.hypot(p.x - b.x, p.z - b.z);
    if (d < gap) { gap = d; nearest = p; }
  }
  for (const p of state.players) {
    if (p === nearest || Math.hypot(p.x - b.x, p.z - b.z) > 3) continue;
    sum += p.x - b.x; count++;
  }
  if (!count || Math.abs(sum / count) < 0.15) return b.x > 0 ? -1 : 1;
  return sum > 0 ? -1 : 1;
}

// Where a ball in flight comes down to catch height (simulation coordinates).
export function landingPoint(ball) {
  const vy = ball.vy || 0, vx = ball.vx || 0, vz = ball.vz || 0;
  const h = (ball.y || 0) - 1.3;
  const t = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * GRAVITY * h))) / GRAVITY;
  const time = Number.isFinite(t) ? clamp(t, 0, 4) : 0;
  return { x: ball.x + vx * time, z: ball.z + vz * time };
}
