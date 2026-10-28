// The procedural layer: poses applied to the bones AFTER the clips, written
// in character space with the PoseRig primitives. It does two jobs:
//  - always: banking into turns, stride exaggeration at speeds beyond the
//    clips, turning the legs for side shuffles, and a clamped look toward a
//    ball in the air;
//  - when a clip is missing: stances, throw, catch, carry, block, cut, juke,
//    tackle, wrapped, down and stumble, so the game is fully playable with
//    only idle + walk + run.
// Every layer takes a weight 0..1 that the caller cross-fades.
import * as THREE from '../../vendor/three.module.js';
import { AXIS } from './pose.js';
import { THROW_RELEASE } from './blend.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.max(0, Math.min(1, t));
const ease = t => { t = clamp01(t); return t * t * (3 - 2 * t); };
const _q = new THREE.Quaternion();

// Stance geometry by type, as fractions of the leg length (hips above the
// ankle) so it fits any model; x/z in yards for a 2.06 yd athlete.
// three: linemen, back flat, right hand down in front of the right shoulder
// two:   linebackers, backs, safeties, corners: hips back, chest over knees
// split: receivers, staggered feet, weight forward
// gun:   the quarterback waiting for the shotgun snap
export const STANCES = {
  three: { drop: 0.36, back: 0.02, hipsPitch: 1.0, spinePitch: 0.5, feet: [[0.26, 0.06], [-0.26, -0.18]], toeOut: 0.16 },
  two: { drop: 0.2, back: 0.1, hipsPitch: 0.45, spinePitch: 0.35, feet: [[0.22, 0.03], [-0.22, -0.05]], toeOut: 0.22 },
  split: { drop: 0.13, back: 0.04, hipsPitch: 0.28, spinePitch: 0.3, feet: [[0.12, 0.2], [-0.13, -0.22]], toeOut: 0.12 },
  gun: { drop: 0.07, back: 0.02, hipsPitch: 0.1, spinePitch: 0.12, feet: [[0.2, 0.02], [-0.2, 0.0]], toeOut: 0.2 },
};

// Spine pitch distributed over the spine bones (forward is +x rotation).
function pitchTorso(rig, angle) {
  rig.turn('Spine', AXIS.x, angle * 0.4);
  rig.turn('Spine1', AXIS.x, angle * 0.3);
  rig.turn('Spine2', AXIS.x, angle * 0.3);
}

// Head up by `angle` so a bent-over player still looks downfield.
function liftHead(rig, angle) {
  rig.turn('Neck', AXIS.x, -angle * 0.55);
  rig.turn('Head', AXIS.x, -angle * 0.45);
}

// Plants both feet at character-space (x, z) targets with the knees forward.
function plantFeet(rig, feet, ankle, toeOut, w) {
  const sides = ['Left', 'Right'];
  for (let i = 0; i < 2; i++) {
    const s = sides[i];
    if (!rig.bones[s + 'Foot']) continue;
    const [x, z] = feet[i];
    const target = V(x, ankle, z);
    const pole = V(i ? -0.25 : 0.25, 0, 1);
    rig.reach(s + 'UpLeg', s + 'Leg', s + 'Foot', target, pole, w);
    const rest = rig.rest[s + 'Foot']?.charQuaternion;
    if (rest) rig.orient(s + 'Foot', _q.setFromAxisAngle(AXIS.y, (i ? -1 : 1) * toeOut).multiply(rest).clone(), w);
  }
}

// Places a hand with two-bone IK; the elbow bends toward `pole`.
function hand(rig, side, target, pole, w) {
  if (!rig.bones[side + 'Hand']) return;
  rig.reach(side + 'Arm', side + 'ForeArm', side + 'Hand', target, pole, w);
}

// ---- stances --------------------------------------------------------------

export function stance(rig, type, w, legs) {
  const s = STANCES[type];
  if (!s || w <= 0) return;
  const drop = s.drop * legs.height;
  rig.shiftHips(V(0, -drop * w, -s.back * w));
  rig.turn('Hips', AXIS.x, s.hipsPitch * w);
  pitchTorso(rig, s.spinePitch * w);
  plantFeet(rig, s.feet, legs.ankle, s.toeOut, w);
  liftHead(rig, (s.hipsPitch + s.spinePitch) * w * 0.85);
  const knee = side => rig.pos(side + 'Leg');
  if (type === 'three') {
    // Right hand down in front of the right shoulder, left forearm on the thigh.
    const shoulder = rig.pos('RightArm');
    hand(rig, 'Right', V(shoulder.x * 0.85, legs.ankle * 0.6, shoulder.z + 0.12), V(-0.3, 0, -1), w);
    const k = knee('Left');
    hand(rig, 'Left', V(k.x - 0.02, k.y + 0.12, k.z + 0.06), V(0.6, -0.2, -0.6), w);
  } else if (type === 'two') {
    for (const side of ['Left', 'Right']) {
      const k = knee(side);
      hand(rig, side, V(k.x * 0.9, k.y + 0.1, k.z + 0.12), V(side === 'Left' ? 0.8 : -0.8, 0, -0.5), w);
    }
  } else if (type === 'split') {
    const hips = rig.pos('Hips');
    hand(rig, 'Left', V(0.2, hips.y + 0.12, hips.z + 0.22), V(0.7, -0.3, -0.6), w);
    hand(rig, 'Right', V(-0.22, hips.y + 0.08, hips.z + 0.16), V(-0.7, -0.3, -0.6), w);
  } else if (type === 'gun') {
    const hips = rig.pos('Hips');
    hand(rig, 'Left', V(0.07, hips.y + 0.12, hips.z + 0.34), V(0.8, -0.4, -0.3), w);
    hand(rig, 'Right', V(-0.07, hips.y + 0.12, hips.z + 0.34), V(-0.8, -0.4, -0.3), w);
  }
}

// ---- always-on layers -----------------------------------------------------

// Bank into a turn (lean > 0 turning right rolls to the right: +z).
export function bank(rig, lean, speed, w = 1) {
  const angle = lean * Math.min(1, speed / 6) * 0.32 * w;
  if (Math.abs(angle) > 1e-3) rig.turn('Hips', AXIS.z, angle);
}

// Longer strides than the clip was authored with (k > 1), or shorter ones
// (k < 1, legs only: shrinking an arm toward its bind pose would raise it
// toward the T-pose).
export function stretchStride(rig, k) {
  if (Math.abs(k - 1) < 0.001) return;
  for (const s of ['Left', 'Right']) {
    rig.stretch(s + 'UpLeg', k);
    rig.stretch(s + 'Leg', 1 + (k - 1) * 0.7);
    if (k > 1) rig.stretch(s + 'Arm', 1 + (k - 1) * 0.5);
  }
}

// Forward lean of a runner: more at speed, more while accelerating, upright
// while braking. `accel` in yd/s^2.
export function runLean(rig, speed, accel, w = 1) {
  if (w <= 0) return;
  const angle = (0.16 * Math.min(1, Math.max(0, (speed - 3) / 6)) + Math.max(-0.12, Math.min(0.2, accel * 0.03))) * w;
  if (Math.abs(angle) > 1e-3) pitchTorso(rig, angle);
}

// Feet where the clips put them (character space), recorded before the
// action layers lower or shift the hips.
export function footPositions(rig) {
  return ['Left', 'Right'].map(s => (rig.bones[s + 'Foot']
    ? { position: rig.pos(s + 'Foot').clone(), quaternion: rig.quat(s + 'Foot').clone() } : null));
}

// Puts the feet back on their recorded spots with leg IK (knees forward), so
// lowered hips bend the knees instead of sinking the feet into the turf.
export function keepFeet(rig, feet, w, legs) {
  if (w <= 0.001) return;
  ['Left', 'Right'].forEach((s, i) => {
    const foot = feet[i];
    if (!foot) return;
    const target = foot.position.clone();
    target.y = Math.max(target.y, legs.ankle * 0.92);
    if (rig.pos(s + 'Foot').distanceToSquared(target) < 4e-6) return;
    rig.reach(s + 'UpLeg', s + 'Leg', s + 'Foot', target, V(i ? -0.2 : 0.2, 0, 1), w);
    rig.orient(s + 'Foot', foot.quaternion, w);
  });
}

// Side shuffle without a clip: legs turn toward travel, torso keeps facing.
export function strafe(rig, angle, w) {
  if (!angle || w <= 0) return;
  rig.turn('Hips', AXIS.y, -angle * w);
  rig.turn('Spine', AXIS.y, angle * w * 0.55);
  rig.turn('Spine1', AXIS.y, angle * w * 0.3);
  rig.turn('Spine2', AXIS.y, angle * w * 0.15);
}

// Backpedal posture: low hips, chest over the knees, arms bent.
export function backpedal(rig, w, legs) {
  if (w <= 0) return;
  rig.shiftHips(V(0, -0.12 * legs.height * w, 0));
  pitchTorso(rig, 0.32 * w);
  liftHead(rig, 0.25 * w);
}

// Look toward a point (character space), small and clamped.
export function lookAt(rig, target, w) {
  if (!target || w <= 0 || !rig.bones.Head) return;
  const head = rig.pos('Head');
  const d = target.clone().sub(head);
  const yaw = Math.max(-1.1, Math.min(1.1, Math.atan2(d.x, d.z)));
  const pitch = Math.max(-0.45, Math.min(0.7, Math.atan2(d.y, Math.hypot(d.x, d.z))));
  rig.turn('Neck', AXIS.y, yaw * 0.4 * w);
  rig.turn('Head', AXIS.y, yaw * 0.6 * w);
  rig.turn('Neck', AXIS.x, -pitch * 0.4 * w);
  rig.turn('Head', AXIS.x, -pitch * 0.6 * w);
}

// ---- action stand-ins -----------------------------------------------------

// Ball tucked high and tight in the right arm.
export function carry(rig, w) {
  if (w <= 0) return;
  const chest = rig.pos('Spine2');
  hand(rig, 'Right', V(chest.x - 0.1, chest.y - 0.02, chest.z + 0.17), V(-1, -0.6, -0.5), w);
}

// QB holding the ball at the chest with both hands (pocket).
export function holdBall(rig, w) {
  if (w <= 0) return;
  const chest = rig.pos('Spine2');
  hand(rig, 'Right', V(chest.x - 0.08, chest.y - 0.02, chest.z + 0.26), V(-1, -0.5, -0.4), w);
  hand(rig, 'Left', V(chest.x + 0.06, chest.y - 0.04, chest.z + 0.28), V(1, -0.5, -0.4), w);
}

// Hands to the ball (character-space target), then pull it in.
export function catchBall(rig, progress, target, w) {
  if (w <= 0) return;
  const chest = rig.pos('Spine2');
  const reachTo = target ? target.clone() : V(0, chest.y + 0.15, chest.z + 0.5);
  // Clamp to what the arms can reach in front of the chest.
  reachTo.y = Math.max(chest.y - 0.45, Math.min(chest.y + 0.75, reachTo.y));
  reachTo.x = Math.max(chest.x - 0.45, Math.min(chest.x + 0.45, reachTo.x));
  reachTo.z = Math.max(chest.z + 0.22, Math.min(chest.z + 0.6, reachTo.z));
  const secure = V(chest.x - 0.08, chest.y - 0.02, chest.z + 0.2);
  const t = ease((progress - 0.25) / 0.65);
  const at = reachTo.lerp(secure, t);
  hand(rig, 'Left', V(at.x + 0.09, at.y, at.z), V(1, -0.6, -0.5), w);
  hand(rig, 'Right', V(at.x - 0.09, at.y, at.z), V(-1, -0.6, -0.5), w);
}

// Throwing motion keyed so the hand passes the release point at
// THROW_RELEASE seconds: hips and shoulders closed at the wind-up, the front
// (left) foot steps at the target, the arm drives over the top, then the
// hips open through the follow-through. `feet` (from footPositions) gets the
// step so keepFeet plants it.
export function throwBall(rig, elapsed, w, feet = null) {
  if (w <= 0) return;
  const hipsYaw = lerp(-0.5, 0.45, ease((elapsed - 0.08) / 0.25));
  rig.turn('Hips', AXIS.y, hipsYaw * w);
  const step = ease((elapsed - 0.04) / 0.16) * w;
  if (feet?.[0]) { feet[0].position.z += 0.26 * step; feet[0].position.x += 0.04 * step; }
  if (feet?.[1]) feet[1].position.z -= 0.06 * step;
  const shoulder = rig.pos('RightArm').clone();
  const hips = rig.pos('Hips');
  const keys = [
    // time, hand offset from the right shoulder (x, y, z), torso yaw, pitch
    [0.0, [-0.05, -0.2, 0.25], 0, 0],
    [0.11, [-0.1, 0.18, -0.3], -0.62, -0.08],
    [THROW_RELEASE, [0.05, 0.32, 0.32], 0.35, 0.18],
    [0.4, [0.4, -0.3, 0.42], 0.6, 0.32],
    [0.7, [0.25, -0.35, 0.3], 0.3, 0.12],
  ];
  let i = 0;
  while (i < keys.length - 2 && elapsed > keys[i + 1][0]) i++;
  const [t0, h0, y0, p0] = keys[i], [t1, h1, y1, p1] = keys[i + 1];
  const t = ease((elapsed - t0) / (t1 - t0));
  const yaw = lerp(y0, y1, t), pitch = lerp(p0, p1, t);
  rig.turn('Spine', AXIS.y, yaw * 0.35 * w);
  rig.turn('Spine1', AXIS.y, yaw * 0.35 * w);
  rig.turn('Spine2', AXIS.y, yaw * 0.3 * w);
  pitchTorso(rig, pitch * w);
  const s = rig.pos('RightArm');
  const off = [lerp(h0[0], h1[0], t), lerp(h0[1], h1[1], t), lerp(h0[2], h1[2], t)];
  hand(rig, 'Right', V(s.x + off[0], s.y + off[1], s.z + off[2]), V(-0.6, -0.4, -1), w);
  // Front arm points at the target, then tucks.
  const front = 1 - ease((elapsed - 0.12) / 0.2);
  const ls = rig.pos('LeftArm');
  hand(rig, 'Left', V(ls.x + 0.05, ls.y + 0.05 - (1 - front) * 0.35, ls.z + 0.25 + front * 0.25), V(1, -0.3, -0.4), w);
  void shoulder; void hips;
}

// Hands extended into the opponent, low and leaning in, on a wide base.
export function block(rig, w, legs, feet = null, still = 1) {
  if (w <= 0) return;
  rig.shiftHips(V(0, -0.2 * legs.height * w, -0.06 * w));
  rig.turn('Hips', AXIS.x, 0.3 * w);
  pitchTorso(rig, 0.34 * w);
  liftHead(rig, 0.55 * w);
  if (feet && still > 0) {
    // Feet shoulder-width and staggered when not driving.
    const k = w * still;
    const spots = [[0.27, 0.04], [-0.27, -0.16]];
    feet.forEach((f, i) => { if (f) { f.position.x = lerp(f.position.x, spots[i][0], k); f.position.z = lerp(f.position.z, spots[i][1], k); f.position.y = lerp(f.position.y, legs.ankle, k); } });
  }
  const chest = rig.pos('Spine2');
  hand(rig, 'Left', V(0.16, chest.y - 0.02, chest.z + 0.48), V(0.8, -0.8, -0.2), w);
  hand(rig, 'Right', V(-0.16, chest.y - 0.02, chest.z + 0.48), V(-0.8, -0.8, -0.2), w);
}

// Plant and cut: knee bend and a lean into the new direction.
export function cut(rig, progress, lean, w, legs) {
  if (w <= 0) return;
  const pulse = Math.sin(Math.PI * clamp01(progress)) * w;
  rig.shiftHips(V(0, -0.1 * legs.height * pulse, 0));
  rig.turn('Hips', AXIS.z, (lean >= 0 ? 1 : -1) * 0.22 * pulse);
  pitchTorso(rig, 0.2 * pulse);
}

// Juke: drop the hips and throw the shoulders over the plant foot.
export function juke(rig, progress, direction, w, legs) {
  if (w <= 0) return;
  const pulse = Math.sin(Math.PI * clamp01(progress)) * w;
  rig.shiftHips(V(0, -0.16 * legs.height * pulse, 0));
  rig.turn('Hips', AXIS.z, direction * 0.3 * pulse);
  rig.turn('Spine1', AXIS.z, direction * 0.15 * pulse);
  pitchTorso(rig, 0.25 * pulse);
  // Free arm out for balance.
  const side = direction > 0 ? 'Left' : 'Right';
  const s = rig.pos(side + 'Arm');
  hand(rig, side, V(s.x + (direction > 0 ? 0.45 : -0.45), s.y - 0.15, s.z + 0.1), V(0, -1, -0.3), pulse);
}

// Tackler: drive low, arms wrapping, then go to ground.
export function tackle(rig, elapsed, w, legs) {
  if (w <= 0) return 0;
  const drive = ease(elapsed / 0.25);
  rig.shiftHips(V(0, -0.22 * legs.height * drive * w, 0));
  pitchTorso(rig, 0.55 * drive * w);
  liftHead(rig, 0.35 * drive * w);
  const chest = rig.pos('Spine2');
  const wrap = ease((elapsed - 0.15) / 0.25);
  hand(rig, 'Left', V(0.32 - wrap * 0.26, chest.y - 0.1, chest.z + 0.55), V(1, 0, -0.3), w);
  hand(rig, 'Right', V(-0.32 + wrap * 0.26, chest.y - 0.1, chest.z + 0.55), V(-1, 0, -0.3), w);
  const down = ease((elapsed - 0.35) / 0.5);
  ground(rig, down, w, legs, 1);
  return down;
}

// Ball carrier being wrapped: knees bent, driving forward, ball held.
export function wrapped(rig, w, legs) {
  if (w <= 0) return;
  rig.shiftHips(V(0, -0.18 * legs.height * w, 0));
  pitchTorso(rig, 0.38 * w);
  liftHead(rig, 0.2 * w);
  const s = rig.pos('LeftArm');
  hand(rig, 'Left', V(s.x + 0.3, s.y - 0.2, s.z + 0.15), V(0.3, -1, -0.2), w);
}

// Missed tackle: off balance, arms out, recovering.
export function stumble(rig, progress, w, legs) {
  if (w <= 0) return;
  const k = Math.sin(Math.PI * Math.min(1, clamp01(progress) * 1.3)) * w;
  rig.shiftHips(V(0, -0.18 * legs.height * k, 0.04 * k));
  rig.turn('Hips', AXIS.x, 0.35 * k);
  pitchTorso(rig, 0.55 * k);
  rig.turn('Hips', AXIS.z, 0.22 * k);
  rig.turn('Spine1', AXIS.z, 0.12 * k);
  liftHead(rig, 0.5 * k);
  // Arms flung out and low, the off arm reaching for the turf.
  const l = rig.pos('LeftArm'), r = rig.pos('RightArm');
  hand(rig, 'Left', V(l.x + 0.5, l.y - 0.2, l.z + 0.25), V(0, -1, -0.4), k);
  hand(rig, 'Right', V(r.x - 0.35, r.y - 0.5, r.z + 0.35), V(0, -1, -0.4), k);
}

// Lying prone on the ground; `amount` 0..1 is how far down the fall is.
// The body pivots forward around the feet, so the hips travel ahead.
export function ground(rig, amount, w, legs, roll = 0) {
  const a = amount * w;
  if (a <= 0) return;
  const pitch = a * Math.PI * 0.47;
  rig.turn('Hips', AXIS.x, pitch);
  if (roll) rig.turn('Hips', AXIS.z, roll * 0.12 * a);
  // Lower the hips toward the ground and slide them forward.
  const hips = rig.pos('Hips');
  const lying = 0.16;
  rig.shiftHips(V(0, (lying - hips.y) * a, legs.height * 0.75 * Math.sin(pitch)));
  liftHead(rig, 0.6 * a);
  // Arms forward on the ground.
  const chest = rig.pos('Spine2');
  hand(rig, 'Left', V(chest.x + 0.25, 0.1, chest.z + 0.45), V(1, 1, -0.3), a);
  hand(rig, 'Right', V(chest.x - 0.15, 0.12, chest.z + 0.3), V(-1, 1, -0.3), a);
}

// Down (tackled) without a fall clip: fold forward over ~0.5 s, then stay down.
export function down(rig, elapsed, w, legs) {
  if (w <= 0) return;
  pitchTorso(rig, 0.25 * ease(elapsed / 0.2) * w);
  ground(rig, ease(elapsed / 0.55), w, legs, -1);
}
