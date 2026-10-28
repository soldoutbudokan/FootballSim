import * as THREE from '../../vendor/three.module.js';
import { SIDES } from './math.js';

const _ball = new THREE.Vector3(), _local = new THREE.Vector3();

// Which pre-snap stance each player takes.
function stanceKind(spec, p, ctx) {
  const off = spec.team === 'offense';
  const depth = Math.abs(p.z - ctx.spot);
  switch (spec.role) {
    case 'ol': return spec.id === 'C' ? 'center' : 'threePoint';
    case 'dl': return spec.id.startsWith('DT') ? 'fourPoint' : 'threePoint';
    case 'te': return Math.abs(p.x) < 8 && depth < 2 ? 'threePoint' : 'receiver';
    case 'qb': return 'gun';
    case 'rb': return 'back';
    case 'wr': return 'receiver';
    case 'lb': return depth < 2.2 ? 'threePointRush' : 'backer';
    case 'cb': return depth < 3.5 ? 'press' : 'corner';
    case 's': return depth < 8 ? 'backer' : 'safety';
    default: return off ? 'receiver' : 'backer';
  }
}

// Pre-snap stances by role: linemen in three- or four-point stances, the
// centre over the ball, the quarterback in the gun, receivers in a split
// stance, backers and defensive backs in two-point crouches.
export function applyStance(anim, pose, p, ctx) {
  const d = anim.dims, k = d.k, a = d.ankle, t = ctx.time, seed = anim.seed;
  const breathe = 0.014 * Math.sin(t * 2.3 + seed * 9);
  const kind = stanceKind(anim.spec, p, ctx);
  pose.yaw = 0; pose.tiltPitch = 0; pose.tiltRoll = 0; pose.tiltLift = 0; pose.tiltFwd = 0; pose.tiltSide = 0;
  pose.head.set(0, 0, 0);
  for (let i = 0; i < 2; i++) { pose.footRot[i].set(0, SIDES[i] * 0.14, 0); pose.knees[i].set(SIDES[i] * 0.35, 0, 1); pose.wrists[i].set(0, 0, 0); }
  const feet = (lx, lz, rx, rz) => { pose.feet[0].set(lx, a, lz); pose.feet[1].set(rx, a, rz); };
  const elbowsOut = (x = 0.8, y = -0.6, z = -0.5) => { pose.elbows[0].set(x, y, z); pose.elbows[1].set(-x, y, z); };
  // Hand on the ground in front of the shoulder; knuckles down.
  const handDown = (i, x, z) => { anim.handAt(pose, i, x, 0.12 * k, z); pose.wrists[i].set(-0.9, 0, 0); };

  switch (kind) {
    case 'threePoint':
    case 'threePointRush': {
      const hand = anim.spec.team === 'defense' && p.x > 0 ? 0 : 1;   // outside hand for edge rushers
      const other = 1 - hand, rush = anim.spec.team === 'defense';
      pose.pelvis.set(0, (rush ? 0.72 : 0.67) * k, -0.12);
      pose.hips.set(rush ? 0.8 : 0.68, 0, 0);
      pose.spine.set(0.68 + breathe, 0, 0);
      pose.head.set(-0.08, 0, 0);
      if (hand === 1) feet(0.27, 0.04, -0.27, -0.2); else feet(0.27, -0.2, -0.27, 0.04);
      pose.footRot[hand].x = 0.3;
      anim.prepareChest(pose);
      handDown(hand, SIDES[hand] * 0.17, rush ? 0.58 : 0.5);
      anim.handAt(pose, other, SIDES[other] * 0.25, 0.55 * k, 0.33);
      elbowsOut(0.8, -0.3, -0.6);
      break;
    }
    case 'fourPoint': {
      pose.pelvis.set(0, 0.74 * k, -0.16);
      pose.hips.set(1.0, 0, 0);
      pose.spine.set(0.45 + breathe, 0, 0);
      pose.head.set(-0.12, 0, 0);
      feet(0.3, -0.06, -0.3, -0.1);
      pose.footRot[0].x = pose.footRot[1].x = 0.35;
      anim.prepareChest(pose);
      handDown(0, 0.19, 0.6); handDown(1, -0.19, 0.6);
      elbowsOut(0.7, -0.2, -0.7);
      break;
    }
    case 'center': {
      // The simulation puts him a quarter yard behind the ball; his stance
      // sits further back so the ball is out in front, under his facemask.
      pose.pelvis.set(0, 0.68 * k, -0.34);
      pose.hips.set(0.7, 0, 0);
      pose.spine.set(0.66 + breathe, 0, 0);
      pose.head.set(0.1, 0, 0);
      feet(0.29, -0.26, -0.29, -0.3);
      anim.prepareChest(pose);
      // Right hand on the ball on the ground in front of him.
      _ball.set(ctx.ball.x, 0.12, -ctx.ball.z);
      anim.worldToTilt(pose, _ball, _local);
      if (Math.hypot(_local.x, _local.z - 0.45) < 0.6) anim.handAt(pose, 1, _local.x - 0.02, 0.2 * k, _local.z - 0.06);
      else anim.handAt(pose, 1, -0.12, 0.2 * k, 0.5);
      pose.wrists[1].set(-0.7, 0, 0);
      anim.handAt(pose, 0, 0.25, 0.56 * k, 0.33);
      elbowsOut(0.8, -0.3, -0.6);
      break;
    }
    case 'gun': {
      // Shotgun: hands out to receive the snap, eyes working the defense.
      pose.pelvis.set(0, d.hipY - 0.1, 0);
      pose.hips.set(0.2, 0, 0);
      pose.spine.set(0.12 + breathe, 0, 0);
      pose.head.set(0.02, 0.45 * Math.sin(t * 0.45 + seed * 5), 0);
      feet(0.25, 0.02, -0.25, -0.08);
      anim.prepareChest(pose);
      anim.handAt(pose, 0, 0.14, 1.27 * k, 0.38);
      anim.handAt(pose, 1, -0.14, 1.27 * k, 0.38);
      pose.wrists[0].set(-0.4, 0, -0.6); pose.wrists[1].set(-0.4, 0, 0.6);
      elbowsOut(0.7, -1, -0.2);
      break;
    }
    case 'back': {
      pose.pelvis.set(0, 0.86 * k, -0.04);
      pose.hips.set(0.55, 0, 0);
      pose.spine.set(0.14 + breathe, 0, 0);
      pose.head.set(-0.05, 0, 0);
      feet(0.25, 0.02, -0.25, 0.0);
      anim.prepareChest(pose);
      anim.handAt(pose, 0, 0.2, 0.7 * k, 0.3);
      anim.handAt(pose, 1, -0.2, 0.7 * k, 0.3);
      elbowsOut(0.9, -0.2, -0.5);
      break;
    }
    case 'receiver': {
      // Split stance: inside foot up, weight forward, eyes inside to the ball.
      const insideIsLeft = p.x > 0 === (anim.spec.team === 'offense');
      pose.pelvis.set(0, 0.86 * k, 0);
      pose.hips.set(0.5, 0, 0);
      pose.spine.set(0.25 + breathe, 0, 0);
      pose.head.set(-0.1, (insideIsLeft ? 0.55 : -0.55), 0);
      if (insideIsLeft) feet(0.14, 0.26, -0.16, -0.3); else feet(0.16, -0.3, -0.14, 0.26);
      pose.footRot[insideIsLeft ? 1 : 0].x = 0.45;
      anim.prepareChest(pose);
      const front = insideIsLeft ? 1 : 0, back = 1 - front;
      anim.handAt(pose, front, SIDES[front] * 0.12, 1.02 * k, 0.33);
      anim.handAt(pose, back, SIDES[back] * 0.22, 0.86 * k, -0.08);
      elbowsOut(0.5, -0.5, -0.8);
      break;
    }
    case 'press': {
      pose.pelvis.set(0, 0.8 * k, 0);
      pose.hips.set(0.5, 0, 0);
      pose.spine.set(0.22 + breathe, 0, 0);
      pose.head.set(-0.1, 0, 0);
      feet(0.24, 0.12, -0.24, -0.12);
      pose.footRot[0].x = pose.footRot[1].x = 0.25;
      anim.prepareChest(pose);
      anim.handAt(pose, 0, 0.18, 0.98 * k, 0.32);
      anim.handAt(pose, 1, -0.18, 0.98 * k, 0.32);
      elbowsOut(0.6, -0.8, -0.4);
      break;
    }
    case 'corner': {
      pose.pelvis.set(0, 0.87 * k, 0);
      pose.hips.set(0.42, 0, 0);
      pose.spine.set(0.16 + breathe, 0, 0);
      pose.head.set(-0.05, 0, 0);
      feet(0.18, 0.16, -0.17, -0.24);
      pose.footRot[1].x = 0.35;
      anim.prepareChest(pose);
      anim.handAt(pose, 0, 0.22, 0.98 * k, 0.2);
      anim.handAt(pose, 1, -0.22, 0.98 * k, 0.2);
      elbowsOut(0.7, -0.7, -0.5);
      break;
    }
    case 'backer': {
      pose.pelvis.set(0, 0.82 * k, -0.04);
      pose.hips.set(0.58, 0, 0);
      pose.spine.set(0.12 + breathe, 0, 0);
      pose.head.set(-0.12, 0.25 * Math.sin(t * 0.5 + seed * 4), 0);
      feet(0.3, 0.02, -0.3, -0.02);
      pose.footRot[0].x = pose.footRot[1].x = 0.2;
      anim.prepareChest(pose);
      anim.handAt(pose, 0, 0.22, 0.8 * k, 0.32);
      anim.handAt(pose, 1, -0.22, 0.8 * k, 0.32);
      elbowsOut(0.8, -0.4, -0.5);
      break;
    }
    case 'safety':
    default: {
      pose.pelvis.set(0, 0.93 * k, 0);
      pose.hips.set(0.32, 0, 0);
      pose.spine.set(0.1 + breathe, 0, 0);
      pose.head.set(-0.06, 0.3 * Math.sin(t * 0.4 + seed * 3), 0);
      feet(0.21, 0.08, -0.21, -0.08);
      anim.prepareChest(pose);
      anim.handAt(pose, 0, 0.2, 0.82 * k, 0.24);
      anim.handAt(pose, 1, -0.2, 0.82 * k, 0.24);
      elbowsOut(0.8, -0.4, -0.5);
    }
  }
}
