// One player: a skinned clone of the character asset in its team's uniform,
// an AnimationMixer driven ONLY by the simulation snapshot through the blend
// tree, and the procedural layer on top. Root motion is ignored: the
// simulation owns position, the root is placed at (x, 0, -z) facing
// root.rotation.y = PI - facing (scene z is negated, as for the old rigs).
import * as THREE from '../../vendor/three.module.js';
import * as SkeletonUtils from '../../vendor/SkeletonUtils.js';
import { planAnimation, ActionClock, approachWeights, estimateLean, ACTION_DURATION, THROW_RELEASE } from './blend.js';
import { PoseRig } from './pose.js';
import * as P from './procedural.js';
import { uniformFor } from './palette.js';
import { numberTexture } from './props.js';
import { STANDARD_HEIGHT } from './rig.js';

// Linemen stand 2.12 yd and ~8 % wider (non-uniform scale on the root).
export function bodyScale(role) {
  if (role === 'ol' || role === 'dl') return { height: 2.12 / STANDARD_HEIGHT, width: 1.08 };
  return { height: 1, width: 1 };
}

const FADE = 0.16;           // clip cross-fade (s)
const LAYER_FADE = 0.14;     // procedural layer fade (s)
const MAX_UPPER = 400;       // weight that lets an upper-body clip dominate
const frac = x => x - Math.floor(x);

export class Character {
  constructor(asset, spec, shared) {
    this.asset = asset;
    this.spec = spec;
    this.ctx = shared.ctx; // {available, gaits} for the blend tree
    this.uniform = uniformFor(spec, shared.palette);
    this.root = new THREE.Group();
    this.root.name = 'athlete-' + spec.id;
    this.body = SkeletonUtils.clone(asset.fit);
    this.root.add(this.body);
    const scale = bodyScale(spec.role);
    this.root.scale.set(scale.height * scale.width, scale.height, scale.height);

    this.meshes = [];
    this.body.traverse(o => { if (o.isSkinnedMesh) this.meshes.push(o); });
    this.addLods(asset);
    let numberMap = null;
    const numberFor = () => (numberMap ||= numberTexture(spec.number ?? '', this.uniform.number, this.uniform.jersey));
    shared.materials.dress(this.body, this.uniform, numberFor);
    for (const m of this.meshes) {
      m.frustumCulled = false; // posed limbs leave the rest-pose bounds; 22 players are always near the camera
      m.receiveShadow = true;
    }
    this.setLod(0);

    this.bones = {};
    for (const [c, bone] of Object.entries(asset.rig.canon)) this.bones[c] = this.body.getObjectByName(bone.name);
    this.restLocal = Object.entries(this.bones).map(([c, b]) => ({ b, q: b.quaternion.clone(), p: b.position.clone() }));
    this.pose = new PoseRig(this.bones, shared.base, shared.rest);

    if (shared.atlas && this.bones.Spine2 && !shared.materials.numberSlot) {
      const plates = new THREE.Mesh(shared.atlas.plates(spec.id, shared.placement).applyMatrix4(shared.spineInverse), shared.atlas.material);
      plates.name = 'numbers';
      plates.castShadow = false;
      this.bones.Spine2.add(plates);
    }

    this.mixer = new THREE.AnimationMixer(this.body);
    this.actions = {};
    for (const [slot, info] of Object.entries(asset.clips)) {
      this.actions['clip:' + slot] = this.makeAction(info.clip);
      if (info.upper) this.actions['upper:' + slot] = this.makeAction(info.upper);
    }
    this.weights = {};
    this.layers = {};
    this.clock = new ActionClock();
    this.phase = Math.random();
    this.times = {};
    this.prevPhase = null;
    this.prevFacing = null;
    this.lean = 0;
    this.accel = 0;
    this.prevSpeed = null;
    this.strafe = 0;
    this.ball = null;
    this.frame = 0;
  }

  makeAction(clip) {
    const action = this.mixer.clipAction(clip);
    action.play();
    action.setEffectiveWeight(0);
    action.enabled = false;
    return action;
  }

  // A reduced sibling for every skinned mesh, bound to the same skeleton.
  addLods(asset) {
    for (const mesh of [...this.meshes]) {
      mesh.userData.lod = 0;
      const lod = asset.lods?.get(mesh.geometry.uuid);
      if (!lod) continue;
      const reduced = new THREE.SkinnedMesh(lod.geometry, mesh.material);
      reduced.name = mesh.name + ':lod1';
      reduced.position.copy(mesh.position); reduced.quaternion.copy(mesh.quaternion); reduced.scale.copy(mesh.scale);
      reduced.bindMode = mesh.bindMode;
      reduced.bind(mesh.skeleton, mesh.bindMatrix);
      reduced.userData.lod = 1;
      mesh.parent.add(reduced);
      this.meshes.push(reduced);
    }
  }

  // 0 = full mesh, 1 = reduced mesh.
  setLod(level) {
    if (this.lod === level) return;
    this.lod = level;
    const has = this.meshes.some(m => m.userData.lod === level);
    for (const m of this.meshes) m.visible = has ? m.userData.lod === level : m.userData.lod === 0;
  }

  setShadows(cast) { for (const m of this.meshes) m.castShadow = cast; }

  // Poses the player from its snapshot. env: {state, ball (character-space
  // ball position or null), look (0..1 look-at weight), skipAnimation}
  update(p, dt, env) {
    this.root.position.set(p.x, 0, -p.z);
    this.root.rotation.set(0, Math.PI - (p.facing || 0), 0);
    this.frame++;
    if (env.skipAnimation) return;
    dt = Math.max(0, Math.min(0.1, dt));

    const state = env.state;
    const speed = Number.isFinite(p.speed) ? p.speed : Math.hypot(p.vx || 0, p.vz || 0);
    if (!Number.isFinite(p.lean)) {
      const raw = estimateLean(this.prevFacing, p.facing || 0, speed, dt);
      this.lean += (raw - this.lean) * Math.min(1, dt * 8);
    } else this.lean = p.lean;
    this.prevFacing = p.facing || 0;
    // Smoothed forward acceleration (yd/s^2) for the running lean.
    if (this.prevSpeed != null && dt > 0) this.accel += ((speed - this.prevSpeed) / dt - this.accel) * Math.min(1, dt * 6);
    this.prevSpeed = speed;

    const released = state.phase === 'air' || (state.carrier !== p.id && p.action === 'throw');
    const elapsed = this.clock.update(visual(p, state), p.actionTime, dt, { released });
    const plan = planAnimation({ ...p, speed, lean: this.lean }, this.spec, state, elapsed, this.ctx);
    this.advancePhase(p, speed, plan, dt);

    this.resetBones();
    this.applyClips(plan, dt);
    this.mixer.update(0);
    this.pose.invalidate();
    this.applyProcedural(plan, env, dt);
  }

  // Locomotion phase in cycles: from the distance the simulation moved the
  // player (replay-safe), at the blend's cycle rate.
  advancePhase(p, speed, plan, dt) {
    let distance = speed * dt;
    if (Number.isFinite(p.phase) && this.prevPhase !== null) {
      const delta = p.phase - this.prevPhase;
      if (delta >= 0 && delta < speed * dt * 3 + 0.5) distance = delta;
    }
    this.prevPhase = Number.isFinite(p.phase) ? p.phase : null;
    const rate = plan.cycleRate || 0;
    this.phase += speed > 0.25 ? (distance * rate) / speed : rate * dt;
    this.phase = frac(this.phase);
  }

  resetBones() {
    for (const r of this.restLocal) { r.b.quaternion.copy(r.q); r.b.position.copy(r.p); }
  }

  // Target weights from the plan, cross-faded, then clip times.
  applyClips(plan, dt) {
    const clips = this.asset.clips;
    const target = {};
    const overlay = plan.overlay;
    const full = overlay ? 1 - overlay.upper : 0;
    for (const e of plan.locomotion) target['clip:' + e.slot] = e.weight * (1 - full);
    if (overlay) {
      target['clip:' + overlay.slot] = (target['clip:' + overlay.slot] || 0) + full;
      if (overlay.upper > 0 && this.actions['upper:' + overlay.slot]) target['upper:' + overlay.slot] = overlay.upper;
    }
    this.weights = approachWeights(this.weights, target, dt, FADE);

    let base = 0;
    for (const [key, w] of Object.entries(this.weights)) if (key.startsWith('clip:')) base += w;
    for (const [key, action] of Object.entries(this.actions)) {
      let w = this.weights[key] || 0;
      if (key.startsWith('upper:') && w > 0) w = Math.min(MAX_UPPER, (w / Math.max(1e-3, 1 - w)) * Math.max(base, 1e-3));
      action.enabled = w > 1e-4;
      action.setEffectiveWeight(w);
      if (!action.enabled) continue;
      const slot = key.slice(key.indexOf(':') + 1);
      action.time = this.clipTime(slot, clips[slot], plan, dt);
    }
  }

  clipTime(slot, info, plan, dt) {
    const d = info.duration;
    if (info.gait) {
      const t = frac(this.phase + (info.gait.leftStrike || 0));
      return (plan.reverse && slot !== 'backpedal' ? 1 - t : t) * d * 0.9999;
    }
    const overlay = plan.overlay && plan.overlay.slot === slot ? plan.overlay : null;
    if (!overlay || info.loop) {
      // Free-running loops (idle, stances, carry, block) on their own clock.
      this.times[slot] = ((this.times[slot] || 0) + dt) % d;
      return this.times[slot];
    }
    const e = overlay.elapsed;
    switch (slot) {
      case 'throw': {
        const release = info.release ?? d * 0.5;
        const start = Math.max(0, release - THROW_RELEASE * 2.5);
        const t = e <= THROW_RELEASE ? start + (release - start) * (e / THROW_RELEASE) : release + (e - THROW_RELEASE);
        return Math.min(d, t);
      }
      case 'catch': return Math.min(d, Math.max(0, (info.contact ?? 0.15) - 0.1 + e));
      case 'fall': case 'tackle': return Math.min(d, e);
      default: {
        const nominal = ACTION_DURATION[plan.action] || d;
        return Math.min(d, e * Math.min(1.6, Math.max(1, d / nominal)));
      }
    }
  }

  // Cross-fades a procedural layer toward on/off and returns its weight.
  layer(name, on, dt, fade = LAYER_FADE) {
    const w = this.layers[name] || 0;
    const next = on ? Math.min(1, w + dt / fade) : Math.max(0, w - dt / fade);
    this.layers[name] = next;
    return next;
  }

  applyProcedural(plan, env, dt) {
    const rig = this.pose, legs = this.asset.legs, pr = plan.procedural;
    const action = pr.action;
    const progress = pr.progress;
    const e = this.clock.elapsed;

    // Stances plant their own feet.
    let stanced = 0;
    for (const type of ['three', 'two', 'split', 'gun']) {
      const w = this.layer('stance-' + type, pr.stance === type, dt, 0.22);
      if (w > 0) P.stance(rig, type, w, legs);
      stanced += w;
    }
    // Leg-shaping layers that move the feet on purpose.
    this.strafe += (pr.strafe - this.strafe) * Math.min(1, dt * 7);
    P.strafe(rig, this.strafe, 1);
    P.stretchStride(rig, plan.stretch || 1);

    // Everything below lowers or shifts the hips; the feet stay where the
    // clips put them (or where a layer moves them: the throw's step).
    const feet = P.footPositions(rig);
    const moving = plan.mode === 'forward' && !action && plan.overlay == null;
    P.runLean(rig, plan.speed, this.accel, this.layer('lean', moving || action === 'carry', dt, 0.3));
    P.backpedal(rig, this.layer('backpedal', pr.backpedal, dt, 0.25), legs);
    // The quarterback in the pocket holds the ball at the chest in both hands.
    const qbHold = this.spec.role === 'qb' && plan.action === 'carry' && plan.speed < 3.5 && env.state.phase === 'live';
    this.holding = qbHold;
    P.carry(rig, this.layer('carry', action === 'carry' && !qbHold, dt));
    P.holdBall(rig, this.layer('hold', action === 'carry' && qbHold, dt));
    P.catchBall(rig, progress, env.ball, this.layer('catch', action === 'catch' || env.reach > 0, dt, 0.1) * Math.max(action === 'catch' ? 1 : 0, env.reach || 0));
    P.throwBall(rig, e, this.layer('throw', action === 'throw', dt, 0.06), feet);
    P.block(rig, this.layer('block', action === 'block', dt), legs, feet, 1 - Math.min(1, plan.speed / 2.5));
    P.cut(rig, progress, this.lean, this.layer('cut', action === 'cut', dt, 0.06), legs);
    P.juke(rig, progress, this.jukeDirection(plan), this.layer('juke', action === 'juke', dt, 0.06), legs);
    P.wrapped(rig, this.layer('wrapped', action === 'wrapped', dt), legs);
    P.stumble(rig, progress, this.layer('stumble', action === 'stumble', dt), legs);
    const tackleDown = P.tackle(rig, e, this.layer('tackle', action === 'tackle', dt, 0.08), legs) || 0;
    P.down(rig, e, this.layer('down', action === 'down', dt, 0.08), legs);
    const grounded = Math.max(this.layers.down || 0, (this.layers.tackle || 0) * tackleDown);
    P.keepFeet(rig, feet, (1 - grounded) * Math.max(0, 1 - stanced), legs);

    P.bank(rig, this.lean, plan.speed, 1 - grounded);
    P.lookAt(rig, env.lookTarget, this.layer('look', !!env.lookTarget, dt, 0.25) * 0.85);
  }

  // The sim pushes lateral velocity in the juke direction; a juke to the
  // player's right rolls the body right. Latched for the whole move.
  jukeDirection(plan) {
    if (plan.action !== 'juke') { this.jukeSign = 0; return 1; }
    if (!this.jukeSign) this.jukeSign = (plan.lateral || 0) >= 0 ? 1 : -1;
    return this.jukeSign;
  }

  // Where a carried ball sits (character space): tucked along the right
  // forearm, or in the hand(s).
  ballAnchor(mode) {
    const rig = this.pose;
    if (!rig.bones.RightHand) return null;
    const hand = rig.pos('RightHand'), elbow = rig.pos('RightForeArm');
    const along = hand.clone().sub(elbow).normalize();
    if (mode === 'tuck') {
      const pos = elbow.clone().lerp(hand, 0.72);
      pos.x += 0.05; // toward the body's midline (right arm is at -x)
      return { position: pos, direction: along };
    }
    if (mode === 'both' && rig.bones.LeftHand) {
      const left = rig.pos('LeftHand');
      const pos = hand.clone().lerp(left, 0.5);
      pos.z += 0.04;
      return { position: pos, direction: new THREE.Vector3(0, 0, 1) };
    }
    return { position: hand.clone().addScaledVector(along, 0.07), direction: along };
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}

// The visual action key the clock tracks (pre-snap 'ready', carrier 'carry').
function visual(p, state) {
  if (state.phase === 'presnap') return 'ready';
  return p.action || 'run';
}
