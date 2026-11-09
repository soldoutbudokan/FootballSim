import * as THREE from '../../vendor/three.module.js';
import { TAU, SIDES, clamp, lerp, smoothstep, bump, sampleTrack, wrapAngle, damp } from './math.js';
import { armAngles } from './pose.js';
import { carryArm, tuck, cover, legsOut } from './carry.js';
import { tackled, tackle, tackleYaw, shrugOff, missFor, knockedDown } from './tackle.js';
import { reachForBall, catchBall, giveBall, takeBall } from './ballskills.js';

// Action layer: each function modifies the locomotion base pose for one
// action of plan section 3.4 (plus 'pocket', the quarterback holding the ball
// in the pocket). Hand targets are in the chest frame, feet in the tilt frame.

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _w = new THREE.Vector3(), _perp = new THREE.Vector3();

export function startAction(anim, action, data, p, ctx) {
  if (action === 'ready') { anim.carryArm = undefined; anim.catchPoint = null; }
  switch (action) {
    case 'catch':
      data.point = ctx.catchFrom ? ctx.catchFrom.clone() : anim.catchPoint ? anim.catchPoint.clone() : null;
      anim.carryArm = undefined;
      carryArm(anim, p);
      break;
    case 'throw':
      // Wind up facing downfield, follow through along the ball's flight.
      data.face = (q, c) => {
        const b = c.ball, flying = c.phase === 'air' && Math.hypot(b.vx || 0, b.vz || 0) > 1;
        const dir = anim.spec.team === 'offense' ? 1 : -1;
        return flying ? { x: q.x + b.vx, z: q.z + b.vz } : { x: q.x, z: q.z + 10 * dir };
      };
      break;
    case 'cut': plant(anim, data, 0.2); break;
    case 'juke': plant(anim, data, 0.45); break;
    case 'block':
      data.face = (q, c) => (q.engaged != null ? c.byId.get(q.engaged) : null);
      break;
    case 'tackled':
      data.yaw = (q, c) => c.tackle?.cyaw;
      break;
    case 'tackle':
    case 'assist':
      data.yaw = (q, c) => tackleYaw(anim, q, c);
      break;
    case 'stumble': {
      // A defender put on his back by a run block (the simulation's pancake:
      // a long stumble) goes down and bounces up.
      data.pancake = anim.spec.team === 'defense' && p.actionTime > 0.75 && !(ctx.state.misses || []).some(m => m.tackler === p.id && ctx.state.time - m.at < 0.05);
      // He falls toward the side the runner went by on (when the snapshot says).
      const miss = missFor(anim, p, ctx);
      data.side = miss ? miss.side : Math.abs(anim.lean) > 0.1 ? Math.sign(anim.lean) : (anim.seed < 0.5 ? 1 : -1);
      data.deep = !!miss?.deep;
      data.target = miss?.carrier;
      break;
    }
  }
}

// Cut and juke: the plant foot is the outside foot of the new direction. The
// direction comes from the simulation's lean, else from the turn rate or the
// sideways drift; a juke on command may only show it a few frames in, so the
// choice waits up to 0.12 s for a clear signal.
function plant(anim, data, duration) {
  data.duration = duration;
  data.dir = null;
}

function senseCut(anim, data, age) {
  if (data.dir !== null) return;
  let dir = 0;
  if (Math.abs(anim.lean) > 0.15) dir = Math.sign(anim.lean);
  else if (Math.abs(anim.turn) > 0.7) dir = Math.sign(anim.turn);
  else if (Math.abs(anim.local.x) > 0.15) dir = -Math.sign(anim.local.x);
  if (!dir && age < 0.12) return;
  data.dir = dir || (anim.seed < 0.5 ? 1 : -1);     // +1 = toward his right
  data.at = age;
  data.plant = data.dir > 0 ? 0 : 1;                 // cutting right plants the left foot
  // At speed the plant lands well ahead of the hips (that is what brakes him)
  // and the body travels over it.
  _a.set(SIDES[data.plant] * 0.3, 0, clamp(0.1 + 0.055 * anim.speed, 0.15, 0.5));
  data.foot = anim.rootToWorld(_a, { x: 0, z: 0 });
}

// Which of his feet is the inside one (toward the quarterback), 0 = left,
// 1 = right, -1 when the quarterback is straight ahead or behind.
const _qb = new THREE.Vector3();
function insideFoot(anim, ctx) {
  const qb = ctx.byId.get(ctx.qbId);
  if (!qb) return -1;
  const local = anim.worldToRoot(_qb.set(qb.x, 0, -qb.z), _w);
  return Math.abs(local.x) < 0.6 ? -1 : local.x > 0 ? 0 : 1;
}

// Live-ball postures for a player without the ball, shown while he is doing
// nothing else (the 'run' action): an offensive lineman's pass set while the
// line protects (ctx.protect) or a two-point drive stance on runs, a
// defensive lineman's rush crouch, a coverage player's ready crouch. Weight 1
// when standing, fading out as he speeds up so the gait, the backpedal and
// the shuffle take over without a pop.
export function livePosture(anim, p, ctx) {
  const live = ctx.phase === 'live' || ctx.phase === 'air' || ctx.phase === 'run';
  if (!live || ctx.holderId === p.id) return null;
  const role = anim.spec.role, v = anim.speed;
  if (role === 'ol') {
    if (!ctx.protect) return { kind: 'drive', w: 1 - smoothstep(2.5, 5, v) };
    // He kick-slides sideways and back in his set (facing downfield, see
    // Animator.updateYaw); a run blocker firing forward during the mesh is
    // not setting.
    return { kind: 'set', w: (1 - smoothstep(3.8, 5.5, v)) * (1 - smoothstep(0.9, 2.0, p.vz || 0)) };
  }
  if (role === 'dl') return { kind: 'drive', w: 1 - smoothstep(2.5, 5, v) };
  if (role === 'cb' || role === 's' || role === 'lb') return { kind: 'cover', w: 1 - smoothstep(1.0, 2.4, v) };
  return null;
}

// Hands up in front of the chest, ready to punch (chest frame).
function handsUp(pose, d, w, x = 0.14, y = 0.1, z = 0.3) {
  for (let i = 0; i < 2; i++) {
    pose.hands[i].lerp(_w.set(SIDES[i] * x * d.torso, y, z), w);
    pose.elbows[i].lerp(_w.set(SIDES[i] * 0.45, -1, -0.35), w);
    pose.wrists[i].lerp(_w.set(-0.75, 0, 0), w);
  }
}

// Standing around after the whistle: weight on one leg, eyes on the ball, and
// a word about the play from the men near it: defenders wave off an
// incompletion, the offense puts its arms up for a touchdown. Short, and not
// everyone.
function afterWhistle(anim, pose, p, ctx) {
  const still = 1 - smoothstep(0.3, 1.2, anim.speed), t = ctx.deadTime, d = anim.dims;
  if (still <= 0) return;
  const rest = smoothstep(0.5, 1.6, t + 0.6 * anim.seed) * still, side = anim.seed < 0.5 ? 1 : -1, off = side > 0 ? 1 : 0;
  pose.pelvis.x += side * 0.035 * rest; pose.pelvis.y -= 0.012 * rest;
  pose.hips.z += -side * 0.06 * rest; pose.spine.z += side * 0.04 * rest;
  pose.feet[off].z += 0.07 * rest; pose.feet[off].x += SIDES[off] * 0.03 * rest;
  if (ctx.ballScene) anim.lookAt(pose, ctx.ballScene, 0.55 * rest);
  const kind = ctx.state.result?.kind, defense = anim.spec.team === 'defense';
  const b = ctx.ball, near = Math.hypot(p.x - b.x, p.z - b.z);
  if (kind === 'incomplete' && defense && near < 7 && anim.seed < 0.62) {
    // "No good": the arms cross low in front and sweep out, twice.
    const from = 0.25 + 0.5 * anim.seed, u = (t - from) / 1.1, w = smoothstep(0, 0.15, u) * (1 - smoothstep(0.85, 1, u)) * still;
    if (w > 0) {
      const sweep = 0.5 - 0.5 * Math.cos(TAU * 2 * clamp(u, 0, 1));
      for (let i = 0; i < 2; i++) {
        pose.hands[i].lerp(_a.set(SIDES[i] * lerp(-0.06, 0.52, sweep), -0.3 + 0.05 * sweep, 0.3 - 0.1 * sweep), w);
        pose.elbows[i].lerp(_b.set(SIDES[i], -0.6, -0.4), w);
        pose.wrists[i].lerp(_b.set(-0.4, 0, 0), w);
      }
      pose.spine.x += 0.06 * w;
    }
  } else if (kind === 'touchdown' && !defense && ctx.holderId !== p.id && near < 16 && anim.seed > 0.35) {
    // Both arms straight up.
    const from = 0.35 + 0.8 * (anim.seed - 0.35), u = (t - from) / 1.3, w = smoothstep(0, 0.18, u) * (1 - smoothstep(0.8, 1, u)) * still;
    if (w > 0) {
      for (let i = 0; i < 2; i++) {
        pose.hands[i].lerp(_a.set(SIDES[i] * 0.26, 0.8 * d.k, 0.06), w);
        pose.elbows[i].lerp(_b.set(SIDES[i], -0.2, -0.4), w);
      }
      pose.spine.x -= 0.06 * w; pose.head.x -= 0.12 * w;
    }
  }
}

// Each posture moves the locomotion pose toward itself by weight w.
export const POSTURES = {
  // Pass set: knees bent and hips down, a little forward lean, hands up, the
  // inside foot forward and the outside one kicked back, weight bouncing on
  // short choppy steps when he is not sliding.
  set(anim, pose, w, p, ctx) {
    const d = anim.dims, still = 1 - smoothstep(0.15, 0.7, anim.speed);
    const chop = Math.sin(TAU * 2.6 * ctx.time + anim.seed * 6);
    pose.pelvis.y = lerp(pose.pelvis.y, d.hipY - 0.15 + 0.01 * chop * chop * still, w);
    pose.pelvis.z = lerp(pose.pelvis.z, -0.04, w);
    pose.hips.set(lerp(pose.hips.x, 0.36, w), pose.hips.y * (1 - w), pose.hips.z * (1 - w));
    pose.spine.set(lerp(pose.spine.x, 0.02, w), pose.spine.y * (1 - w), pose.spine.z * (1 - w));
    pose.head.x = lerp(pose.head.x, -0.04, w);
    const inside = insideFoot(anim, ctx);
    for (let i = 0; i < 2; i++) {
      pose.feet[i].z += w * (inside < 0 ? 0 : i === inside ? 0.08 : -0.12);
      pose.feet[i].y += 0.035 * w * still * Math.max(0, i ? -chop : chop);
      pose.knees[i].lerp(_w.set(SIDES[i] * 0.4, 0, 1), w);
    }
    handsUp(pose, d, w);
  },

  // Two-point crouch of a lineman off the ball: pads low, hands up.
  drive(anim, pose, w) {
    const d = anim.dims;
    pose.pelvis.y = lerp(pose.pelvis.y, Math.min(pose.pelvis.y, d.hipY - 0.13), w);
    pose.hips.x = lerp(pose.hips.x, Math.max(pose.hips.x, 0.5), w);
    pose.spine.x = lerp(pose.spine.x, Math.max(pose.spine.x, 0.14), w);
    pose.head.x = lerp(pose.head.x, -0.12, w);
    for (let i = 0; i < 2; i++) pose.feet[i].x += SIDES[i] * 0.06 * w;
    handsUp(pose, d, w, 0.15, 0.08, 0.33);
  },

  // Coverage ready crouch: knees bent, hips back, slight forward lean, arms
  // bent with the hands near the hips, feet staggered (inside foot up), eyes
  // where the simulation faces him. Linebackers and safeties sit lower.
  cover(anim, pose, w, p, ctx) {
    const d = anim.dims, corner = anim.spec.role === 'cb';
    pose.pelvis.y = lerp(pose.pelvis.y, Math.min(pose.pelvis.y, d.hipY - (corner ? 0.13 : 0.17)), w);
    pose.pelvis.z = lerp(pose.pelvis.z, -0.04, w);
    pose.hips.set(lerp(pose.hips.x, corner ? 0.46 : 0.52, w), pose.hips.y * (1 - w), pose.hips.z * (1 - w));
    pose.spine.set(lerp(pose.spine.x, 0.1, w), pose.spine.y * (1 - w), pose.spine.z * (1 - w));
    pose.head.set(lerp(pose.head.x, -0.04, w), pose.head.y * (1 - w), pose.head.z);
    const inside = insideFoot(anim, ctx), lead = inside < 0 ? (anim.seed < 0.5 ? 0 : 1) : inside;
    for (let i = 0; i < 2; i++) {
      pose.feet[i].x += SIDES[i] * 0.08 * w;
      pose.feet[i].z += w * (i === lead ? 0.1 : -0.1);
      if (i !== lead) pose.footRot[i].x = lerp(pose.footRot[i].x, 0.2, w);
      pose.knees[i].lerp(_w.set(SIDES[i] * 0.3, 0, 1), w);
      pose.hands[i].lerp(_w.set(SIDES[i] * 0.25 * d.torso, -0.3, 0.17), w);
      pose.elbows[i].lerp(_w.set(SIDES[i] * 0.55, -0.45, -0.9), w);
      pose.wrists[i].lerp(_w.set(0.15, 0, 0), w);
    }
  },

  // Breaking down to tackle: hips sunk, base widened, chest up, arms cocked
  // low and wide, eyes on the runner's hips.
  hit(anim, pose, w, p, ctx) {
    const d = anim.dims;
    pose.pelvis.y -= 0.17 * d.k * w;
    pose.hips.x = lerp(pose.hips.x, Math.max(pose.hips.x, 0.6), w);
    pose.spine.x = lerp(pose.spine.x, 0.14, w);
    pose.spine.y *= 1 - 0.6 * w;
    for (let i = 0; i < 2; i++) {
      pose.feet[i].x += SIDES[i] * 0.07 * w;
      pose.hands[i].lerp(_w.set(SIDES[i] * 0.31 * d.torso, -0.2, 0.3), w);
      pose.elbows[i].lerp(_w.set(SIDES[i] * 0.7, -0.5, -0.7), w);
      pose.wrists[i].lerp(_w.set(-0.5, 0, SIDES[i] * 0.4), w);
    }
    const rig = ctx.rigs.get(ctx.carrierId);
    if (rig) anim.lookAt(pose, rig.world.pelvis, 0.8 * w);
  },
};

// Engaged pairs. How far each body reaches forward of its feet (yards along
// its facing) for a net torso lean and hips offset: the chest plate and the
// facemask. Pivoting the whole torso at the hips overestimates the reach, so
// the pair errs toward space between them.
const chestFront = (d, lean, hipsZ) => hipsZ + 0.62 * d.k * Math.sin(lean) + 0.165 * (1 + d.torso) / 2 * Math.cos(lean);
const helmetFront = (d, lean, hipsZ) => hipsZ + 0.88 * d.k * Math.sin(lean) + 0.19;

// Postures of the two men (lean = net torso pitch with room to spare,
// hipsZ = pelvis ahead of the feet, drop = pelvis below standing height).
const BLOCK_STYLES = {
  pass: { lean: 0.26, hipsZ: -0.07, drop: 0.17 },     // blocker in his pass set
  rush: { lean: 0.6, hipsZ: 0.05, drop: 0.13 },       // rusher leaning into him
  drive: { lean: 0.55, hipsZ: 0.05, drop: 0.15 },     // run blocker driving
  anchor: { lean: 0.36, hipsZ: -0.02, drop: 0.16 },   // defender holding his ground
};

function blockStyle(offense, run, out) {
  const a = BLOCK_STYLES[offense ? 'pass' : 'rush'], b = BLOCK_STYLES[offense ? 'drive' : 'anchor'];
  out.lean = lerp(a.lean, b.lean, run); out.hipsZ = lerp(a.hipsZ, b.hipsZ, run); out.drop = lerp(a.drop, b.drop, run);
  return out;
}

// The share of each man's full lean that fits in the gap (the same for both
// men, so the two always agree), and how far both sit back when even upright
// bodies would touch.
const MARGIN = 0.06;
function pairFit(gap, dA, sA, dB, sB) {
  const need = f => {
    const la = sA.lean * f, lb = sB.lean * f;
    const ca = chestFront(dA, la, sA.hipsZ), cb = chestFront(dB, lb, sB.hipsZ);
    const ha = helmetFront(dA, la, sA.hipsZ), hb = helmetFront(dB, lb, sB.hipsZ);
    return Math.max(ca + cb, ha + cb, hb + ca);
  };
  const room = gap - MARGIN;
  if (need(1) <= room) return { f: 1, back: 0 };
  if (need(0) > room) return { f: 0, back: (need(0) - room) / 2 };
  let lo = 0, hi = 1;
  for (let k = 0; k < 10; k++) { const m = (lo + hi) / 2; if (need(m) <= room) lo = m; else hi = m; }
  return { f: lo, back: 0 };
}
const _styleA = {}, _styleB = {};

// The throw, keyed over the simulation's 0.4 s (release at 0.23 s). Hands in
// the chest frame; hips and spine as (pitch, yaw, roll), yaw + to his left.
// The hips load to the right and fire first, the shoulders stay closed a
// beat longer (the separation that whips the arm), the elbow leads the hand
// through, and the arm finishes across the body at the far hip.
const THROW_RIGHT = [[0, -0.075, 0.15, 0.25], [0.06, -0.2, 0.3, 0.1], [0.12, -0.3, 0.4, -0.16], [0.17, -0.32, 0.42, -0.2], [0.2, -0.27, 0.52, 0.05], [0.23, -0.2, 0.6, 0.42], [0.29, -0.02, 0.3, 0.5], [0.4, 0.2, -0.14, 0.3]];
const THROW_LEFT = [[0, 0.075, 0.15, 0.25], [0.08, 0.36, 0.18, 0.3], [0.15, 0.44, 0.14, 0.2], [0.21, 0.3, 0.02, 0.22], [0.27, 0.17, -0.02, 0.16], [0.4, 0.15, -0.05, 0.14]];
const THROW_HIPS = [[0, 0.15, -0.12, 0], [0.1, 0.12, -0.5, 0], [0.16, 0.14, -0.3, 0], [0.22, 0.2, 0.25, 0], [0.3, 0.25, 0.4, 0], [0.4, 0.25, 0.42, 0]];
const THROW_SPINE = [[0, 0.06, 0.1, 0], [0.1, -0.04, -0.5, 0.1], [0.17, -0.04, -0.55, 0.12], [0.23, 0.15, 0.1, -0.05], [0.31, 0.38, 0.45, -0.12], [0.4, 0.4, 0.5, -0.15]];

export const ACTIONS = {
  run(anim, pose, age, data, p, ctx) {
    for (const kind in POSTURES) if (anim.postures[kind] > 0.005) POSTURES[kind](anim, pose, anim.postures[kind], p, ctx);
    if (ctx.phase === 'air') reachForBall(anim, pose, p, ctx);
    if (ctx.mesh) { giveBall(anim, pose, p, ctx); takeBall(anim, pose, p, ctx); }
    // A man with nothing left to do watches the ball carrier.
    if ((ctx.phase === 'run' || ctx.phase === 'tackle') && anim.speed < 1.6 && p.engaged == null) anim.lookAt(pose, ctx.ballScene, 0.6 * (1 - smoothstep(0.6, 1.6, anim.speed)));
    // After the whistle, most players who are standing around put their
    // hands on their hips, each in his own time rather than all at once.
    if (ctx.dead && anim.seed < 0.7) {
      const start = 0.7 + 0.9 * anim.seed;
      const w = smoothstep(start, start + 0.9, ctx.deadTime) * (1 - smoothstep(0.4, 1.2, anim.speed));
      if (w > 0) {
        anim.prepareChest(pose);
        for (let i = 0; i < 2; i++) {
          pose.hands[i].lerp(anim.chestPoint(SIDES[i] * 0.21 * anim.dims.torso, pose.pelvis.y + 0.13, 0.03, _a), w);
          pose.elbows[i].lerp(_b.set(SIDES[i], -0.15, -0.25), w);
          pose.wrists[i].lerp(_b.set(0.3, 0, SIDES[i] * -1.2), w);
        }
        pose.spine.x -= 0.06 * w;
      }
    }
    if (ctx.dead) afterWhistle(anim, pose, p, ctx);
  },

  // Ball high and tight; with a tackler closing in front he drops his pads
  // and puts the other hand over the ball.
  carry(anim, pose, age, data, p, ctx) {
    const i = carryArm(anim, p), brace = anim.brace || 0;
    tuck(pose, i);
    pose.spine.x += 0.04;
    if (brace > 0.01) {
      cover(pose, i, brace);
      pose.pelvis.y -= 0.07 * brace;
      pose.spine.x += 0.16 * brace; pose.hips.x += 0.08 * brace;
      pose.head.x -= 0.1 * brace;
    }
    shrugOff(anim, pose, p, ctx);
    // A touchdown: the free arm goes up for a moment.
    if (ctx.dead && ctx.state.result?.kind === 'touchdown') {
      const j = 1 - i, w = smoothstep(0.25, 0.6, ctx.deadTime) * (1 - smoothstep(1.5, 2.1, ctx.deadTime));
      pose.hands[j].lerp(_a.set(SIDES[j] * 0.24, 0.78 * anim.dims.k, 0.12), w);
      pose.elbows[j].lerp(_b.set(SIDES[j], -0.2, -0.3), w);
      pose.spine.x -= 0.08 * w; pose.head.x -= 0.15 * w;
    }
  },

  // Ball in both hands at the numbers. Dropping (or shuffling) he stays
  // tall with the ball up; set in the pocket he flexes his knees, staggers
  // his feet a third of a yard (left foot forward), keeps his shoulders
  // square downfield and bounces lightly while his eyes scan the field.
  pocket(anim, pose, age, data, p, ctx) {
    const d = anim.dims, t = ctx.time;
    pose.hands[0].set(0.075, 0.14, 0.25); pose.hands[1].set(-0.075, 0.15, 0.25);
    pose.elbows[0].set(0.9, -1, -0.1); pose.elbows[1].set(-0.9, -1, -0.1);
    pose.wrists[0].set(-0.2, 0, -0.9); pose.wrists[1].set(-0.2, 0, 0.9);
    // Quarterbacks drop back tall, even when shuffling backwards.
    pose.spine.x = Math.min(pose.spine.x, 0.12);
    pose.hips.x = Math.min(pose.hips.x, 0.16);
    pose.pelvis.y = Math.max(pose.pelvis.y, d.hipY - 0.12);
    const set = 1 - smoothstep(0.5, 1.8, anim.speed);
    if (set > 0) {
      const bounce = Math.sin(TAU * 1.7 * t + anim.seed * 5);
      pose.pelvis.set(lerp(pose.pelvis.x, 0.015 * Math.sin(TAU * 0.6 * t + anim.seed * 3), set), lerp(pose.pelvis.y, d.hipY - 0.085 + 0.008 * bounce, set), lerp(pose.pelvis.z, 0, set));
      pose.hips.set(lerp(pose.hips.x, 0.16, set), lerp(pose.hips.y, -0.12, set), pose.hips.z * (1 - set));
      pose.spine.set(lerp(pose.spine.x, 0.05, set), lerp(pose.spine.y, 0.12, set), pose.spine.z * (1 - set));
      pose.feet[0].lerp(_a.set(0.15, d.ankle, 0.17), set);
      pose.feet[1].lerp(_a.set(-0.17, d.ankle, -0.16), set);
      pose.footRot[0].lerp(_a.set(0, 0.1, 0), set);
      pose.footRot[1].lerp(_a.set(0, -0.4, 0), set);
      for (let i = 0; i < 2; i++) pose.knees[i].lerp(_a.set(SIDES[i] * 0.3, 0, 1), set);
    }
    pose.head.set(0, 0.45 * Math.sin(t * 0.8 + anim.seed * 3), 0);
    if (ctx.mesh) giveBall(anim, pose, p, ctx);
  },

  // Load, stride, release at 0.23 s, follow-through across the body.
  throw(anim, pose, age, data, p) {
    const t = Math.min(age, 0.4), d = anim.dims;
    sampleTrack(THROW_SPINE, t, _a); pose.spine.set(_a.x, _a.y, _a.z);
    sampleTrack(THROW_HIPS, t, _a); pose.hips.set(_a.x, _a.y, _a.z);
    sampleTrack(THROW_RIGHT, t, pose.hands[1]);
    sampleTrack(THROW_LEFT, t, pose.hands[0]);
    // Cocked, the elbow is up and back at shoulder height; it drops through
    // the release and the hand turns over.
    const cock = smoothstep(0.02, 0.12, t) * (1 - smoothstep(0.2, 0.3, t)), through = smoothstep(0.22, 0.36, t);
    pose.elbows[1].set(-1, lerp(-0.6, 0.1, cock), lerp(-0.3, -0.6, cock));
    pose.elbows[0].set(0.8, -0.8, -0.4);
    pose.wrists[1].set(lerp(0, -0.7, cock) + 0.6 * through, 0, 0);
    pose.wrists[0].set(-0.2, 0, -0.6);
    pose.head.set(0, 0, 0);
    // Legs: weight back on the plant foot, a short step at the target, the
    // weight driven over the front leg, the back foot up on its toe and
    // dragging through.
    const legs = 1 - smoothstep(2, 4, anim.speed);
    if (legs > 0) {
      const step = smoothstep(0.02, 0.18, t), load = bump(0, 0.22, t);
      pose.feet[0].lerp(_a.set(0.16, d.ankle + 0.08 * bump(0.02, 0.18, t), lerp(0.12, 0.44, step)), legs);
      pose.feet[1].lerp(_a.set(-0.2, d.ankle + 0.03 * through, lerp(-0.2, -0.06, through)), legs);
      pose.footRot[0].set(0, 0.15, 0);
      pose.footRot[1].x = lerp(pose.footRot[1].x, 0.75 * smoothstep(0.2, 0.36, t), legs);
      pose.footRot[1].y = lerp(pose.footRot[1].y, -0.5, legs);
      pose.pelvis.z = lerp(pose.pelvis.z, -0.05 * load + 0.15 * smoothstep(0.12, 0.32, t), legs);
      pose.pelvis.y = lerp(pose.pelvis.y, d.hipY - 0.09 - 0.035 * load, legs);
      pose.knees[0].set(0.2, 0, 1); pose.knees[1].set(-0.45, 0, 1);
    }
  },

  // Catching, dropping and swatting the ball (ballskills.js).
  catch: catchBall,

  cut: plantAndDrive,
  juke: plantAndDrive,

  // Engaged pair. The blocker sits in his pass set: hips down, back fairly
  // upright, arms out with the hands on the rusher's chest plate, elbows in.
  // The rusher leans into him with his hands on the blocker's shoulder pads.
  // On runs the blocker drives and the defender anchors. Each puts his helmet
  // to his own left of the other man's, and the lean of both shrinks with the
  // gap (pairFit) so bodies never pass through each other: a tight gap
  // straightens them up.
  block(anim, pose, age, data, p, ctx) {
    const d = anim.dims, offense = anim.spec.team === 'offense';
    const q = p.engaged != null ? ctx.byId.get(p.engaged) : null;
    const other = q ? ctx.animators.get(q.id) : null;
    const gap = q ? Math.hypot(q.x - p.x, q.z - p.z) : 1.3;
    // Run or pass, eased so a block that starts during the mesh does not pop.
    const run = ctx.protect ? 0 : 1;
    data.run = data.run === undefined ? run : damp(data.run, run, 5, ctx.dt);
    const mine = blockStyle(offense, data.run, _styleA);
    let fit = { f: 1, back: 0 };
    if (other) {
      const theirs = blockStyle(other.spec.team === 'offense', data.run, _styleB);
      // Offense first, so both men get the same answer.
      fit = offense ? pairFit(gap, d, mine, other.dims, theirs) : pairFit(gap, other.dims, theirs, d, mine);
    }
    const lean = mine.lean * fit.f, chop = Math.sin(ctx.time * 9 + anim.seed * 5);
    pose.pelvis.set(0.02, d.hipY - mine.drop + 0.01 * chop, mine.hipsZ - fit.back);
    pose.hips.set(0.7 * lean, 0, 0);
    // Head to his own left: shoulders rolled a little that way.
    pose.spine.set(0.3 * lean, 0, -0.1);
    pose.head.set(offense ? -0.04 : -0.1, -0.22, 0);
    for (let i = 0; i < 2; i++) {
      pose.feet[i].x += SIDES[i] * 0.12;
      // Blocker: left foot a little ahead. Rusher: feet driving back under him.
      pose.feet[i].z += offense ? (i ? -0.06 : 0.06) : (i ? -0.16 : -0.02);
      pose.knees[i].set(SIDES[i] * 0.35, 0, 1);
    }
    const rig = q ? ctx.rigs.get(q.id) : null;
    // The hands travel to their spot (from wherever they were) instead of
    // jumping when he locks on, or switches to another man: the first trip
    // out from the chest is the punch.
    data.hands ??= [anim.pose.hands[0].clone(), anim.pose.hands[1].clone()];
    const follow = 1 - Math.exp(-30 * ctx.dt);
    // Hand fighting: each arm presses and gives in its own rhythm, the body
    // rocking with it; a pass rusher now and then throws one arm over (a swim).
    const beat = ctx.time * (4.2 + 2.4 * anim.seed) + anim.seed * 17, max = 0.96 * (d.upperArm + d.forearm);
    const rock = Math.sin(beat);
    pose.pelvis.z += 0.025 * rock; pose.spine.x += 0.04 * rock; pose.spine.y += 0.05 * Math.sin(beat * 0.63 + 1);
    const swim = !offense && data.run < 0.5 ? bump(0.74, 1, Math.sin(beat * 0.31 + anim.seed * 5)) : 0, over = anim.seed < 0.5 ? 0 : 1;
    for (let i = 0; i < 2; i++) {
      if (rig) {
        // A point on the opponent's body (his chest frame): my left hand lands
        // on his right side. The wrist stops short of the surface so the palm,
        // not the wrist, meets it.
        const od = rig.dims, depth = (1 + od.torso) / 2, s = -SIDES[i];
        if (offense) _a.set(s * 0.12 * od.torso, 0.21 * od.k, 0.16 * depth);
        else _a.set(s * 0.2 * od.torso, 0.33 * od.k, 0.12 * depth);
        _a.applyMatrix4(rig.chest.matrixWorld);
        anim.worldToChest(pose, _a, _b);
        _c.set(SIDES[i] * d.shoulder[0], d.shoulder[1], d.shoulder[2]);
        _d.subVectors(_b, _c);
        const len = _d.length(), give = 0.07 + 0.07 * (0.5 + 0.5 * Math.sin(beat + i * 2.4));
        if (len > 0.1) _b.addScaledVector(_d, -give / len);
        if (swim > 0 && i === over) { _b.y += 0.3 * swim; _b.z -= 0.1 * swim; }
        // A man who has got away is let go of, not followed by a stretching arm.
        if (len > max + 0.07) _b.copy(_c).addScaledVector(_d, max / len).lerp(_w.set(SIDES[i] * 0.14 * d.torso, 0.1, 0.3), smoothstep(max + 0.1, max + 0.45, len));
        data.hands[i].lerp(_b, follow);
      }
      // Without a man (the block just ended) the hands hold where they were.
      pose.hands[i].set(data.hands[i].x, data.hands[i].y + 0.015 * Math.sin(ctx.time * 9 + i * 2), data.hands[i].z);
      pose.elbows[i].set(SIDES[i] * (offense ? 0.3 : 0.65), -1, -0.15);
      pose.wrists[i].set(offense ? -1.15 : -0.8, 0, 0);
    }
  },

  // Tackles (tackle.js): the runner going down, the tackler on his legs or
  // beside him, the second man in.
  tackled, tackle, assist: tackle,

  // Missed tackle: he lunges past, pitches forward off balance, the hand on
  // the falling side reaches for the turf and the other arm flies back for
  // balance; then he gathers himself and runs on.
  stumble(anim, pose, age, data, p, ctx) {
    if (data.pancake) {
      const u = age / 0.9;
      knockedDown(anim, pose, 0.84 * smoothstep(0, 0.36, u) * (1 - smoothstep(0.52, 1, u)), u > 0.45);
      return;
    }
    const d = anim.dims, u = age / 0.55, side = data.side, deep = data.deep ? 1 : 0;
    const lurch = bump(0, 0.95, u) ** 0.8, reach = bump(0.1, 0.8, u);
    pose.pelvis.y -= (0.22 + 0.14 * deep) * lurch;
    pose.spine.x += 0.2 * deep * lurch;
    pose.pelvis.x -= side * 0.06 * lurch;
    pose.hips.x += 0.4 * lurch; pose.hips.z += side * 0.12 * lurch;
    pose.spine.x += 0.55 * lurch; pose.spine.z += side * 0.22 * lurch; pose.spine.y -= side * 0.25 * lurch;
    pose.head.x = lerp(pose.head.x, 0.35, lurch);
    pose.head.y += side * 0.3 * lurch;
    // A wide, staggered base while he fights for balance.
    for (let i = 0; i < 2; i++) pose.feet[i].x += SIDES[i] * 0.08 * lurch;
    const down = side > 0 ? 1 : 0, flung = 1 - down;
    armAngles(pose, flung, d, -0.75, 0.55, 0.75, 0, lurch);
    armAngles(pose, down, d, 0.9, 0.25, 0.35, 0, lurch);
    if (reach > 0) {
      anim.prepareChest(pose);
      pose.hands[down].lerp(anim.chestPoint(SIDES[down] * 0.32 + pose.pelvis.x, 0.07, 0.62, _a), reach);
      pose.wrists[down].set(-1.0 * reach, 0, 0);
    }
    // First both arms close on where the runner was: he grasps at air.
    const grasp = smoothstep(0, 0.06, age) * (1 - smoothstep(0.14, 0.32, age));
    const rig = data.target ? ctx.rigs.get(data.target) : null;
    if (grasp > 0 && rig) {
      const max = 0.9 * (d.upperArm + d.forearm);
      for (let i = 0; i < 2; i++) {
        anim.worldToChest(pose, rig.world.pelvis, _a);
        _a.x += SIDES[i] * 0.1;
        _d.set(SIDES[i] * d.shoulder[0], d.shoulder[1], d.shoulder[2]);
        _a.sub(_d); if (_a.length() > max) _a.setLength(max); _a.add(_d);
        pose.hands[i].lerp(_a, grasp);
        pose.elbows[i].lerp(_b.set(SIDES[i], -0.4, -0.2), grasp);
      }
    }
    if (ctx.holderId === p.id) tuck(pose, carryArm(anim, p));
  },
};

// Cut / juke: deep knee bend over a planted outside foot, hips shifted and
// banked into the new direction (the body roll replaces, rather than adds
// to, the running bank so a hard juke never tips him over), eyes to the new
// direction, then drive out of it.
function plantAndDrive(anim, pose, age, data, p, ctx) {
  const T = data.duration, u = age / T, juke = T > 0.3;
  const w = Math.sin(Math.PI * clamp(age / (T * 1.1), 0, 1));
  senseCut(anim, data, age);
  const holding = ctx.holderId === p.id, arm = holding ? carryArm(anim, p) : -1;
  if (holding) { tuck(pose, arm); shrugOff(anim, pose, p, ctx); }
  else if (ctx.phase === 'air') reachForBall(anim, pose, p, ctx);
  pose.pelvis.y -= (juke ? 0.16 : 0.1) * w;
  pose.hips.x += 0.1 * w; pose.spine.x += 0.12 * w;
  if (data.dir === null) return;

  const dir = data.dir, i = data.plant, side = SIDES[i];
  pose.pelvis.x = lerp(pose.pelvis.x, -dir * (juke ? 0.13 : 0.09), w);
  pose.hips.z = lerp(pose.hips.z, dir * (juke ? 0.2 : 0.24), w);
  pose.spine.z = lerp(pose.spine.z, dir * 0.08, w);
  pose.spine.y += -dir * (juke ? 0.22 : 0.15) * w;
  pose.head.y += -dir * 0.35 * w;
  // The plant foot stays where it landed until the body has moved off it
  // (ground contact at speed is short), then rejoins the stride.
  const local = anim.worldToRoot(data.foot, _a);
  const behind = -local.z, wide = Math.abs(local.x);
  if (behind > 0.5 || wide > 0.7) data.released = true;
  // The foot steps to its plant (a quick low arc from wherever the stride had
  // it), it does not appear there.
  const step = smoothstep(0, 0.09, age - data.at);
  const plantW = data.released ? 0 : step * (1 - smoothstep(0.55, 0.9, u)) * (1 - smoothstep(0.3, 0.5, behind)) * (1 - smoothstep(0.55, 0.7, wide));
  const f = pose.feet[i];
  f.x = lerp(f.x, local.x, plantW); f.z = lerp(f.z, local.z, plantW);
  f.y = lerp(f.y, anim.dims.ankle + 0.1 * Math.sin(Math.PI * step), plantW);
  pose.footRot[i].set(lerp(pose.footRot[i].x, 0.1, plantW), lerp(pose.footRot[i].y, -dir * 0.5, plantW), -side * 0.25 * plantW * w);
  pose.knees[i].set(side * 0.1 - dir * 0.4, 0, 1);
  // The other foot stays under the hips, ready to step into the new line.
  const o = pose.feet[1 - i];
  o.x = lerp(o.x, -side * 0.06, 0.6 * w);
  // Free arm out for balance on the plant side.
  if (arm !== i) {
    pose.hands[i].lerp(_b.set(side * 0.46, -0.24, 0.12), w * 0.8);
    pose.elbows[i].lerp(_c.set(side * 0.3, -1, -0.2), w);
  }
}
