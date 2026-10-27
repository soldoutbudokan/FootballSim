import * as THREE from '../../vendor/three.module.js';
import { Pose, chestMatrix, tiltMatrix, armAngles } from './pose.js';
import { TAU, SIDES, clamp, lerp, smoothstep, fract, damp, wrapAngle, approachAngle, hashString } from './math.js';
import { applyStance } from './stances.js';
import { ACTIONS, startAction } from './actions.js';

// Seconds each timed action lasts in the simulation (plan section 3.4).
const DURATIONS = { throw: 0.4, catch: 0.45, juke: 0.45, cut: 0.2, tackle: 1.0, stumble: 0.7 };
const SIM_ACTIONS = new Set(['ready', 'run', 'cut', 'juke', 'block', 'throw', 'catch', 'carry', 'wrapped', 'tackle', 'down', 'stumble']);

function blendTime(from, to) {
  if (to === 'ready') return 0;
  if (from === 'ready') return 0.24;
  return { throw: 0.07, catch: 0.1, cut: 0.06, juke: 0.06, tackle: 0.1, down: 0.14, stumble: 0.08, wrapped: 0.1 }[to] ?? 0.16;
}

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3();

// Drives one athlete: turns snapshot fields (velocity, facing, action, stride
// phase) into a Pose for the rig. A locomotion base pose is built every frame;
// the current action then modifies it, cross-fading from the previous action.
export class Animator {
  constructor(rig, spec) {
    this.rig = rig;
    this.spec = spec;
    this.dims = rig.dims;
    this.seed = hashString(spec.id);
    this.pose = new Pose();
    this.base = new Pose();
    this.work = new Pose();
    this.prevPose = new Pose();
    this.yaw = Math.PI;
    this.speed = 0; this.accel = 0; this.lean = 0; this.turn = 0; this.heading = 0; this.backpedal = false;
    this.cycle = this.seed; this.stepLen = 1; this.lastPhase = null;
    this.local = new THREE.Vector2(0, 1);     // movement direction in the root frame
    this.action = null; this.age = 0; this.data = {};
    this.prevAction = null; this.prevAge = 0; this.prevData = {}; this.blend = 1; this.blendDuration = 0.16;
    this.locks = [{ active: false, x: 0, z: 0 }, { active: false, x: 0, z: 0 }];
    this.catchPoint = null;                     // where the hands met the ball (world)
    this.reach = null;                          // live anticipation of a pass {point, t, dist}
    this.fresh = true;
    this.x = 0; this.z = 0;
    this.chestInverse = new THREE.Matrix4();
  }

  update(p, ctx) {
    const teleport = this.fresh || ctx.reset || Math.hypot(p.x - this.x, p.z - this.z) > 2.5;
    this.x = p.x; this.z = p.z;
    this.kinematics(p, ctx, teleport);

    const action = this.resolveAction(p, ctx);
    if (teleport || action !== this.action) {
      this.prevAction = teleport ? null : this.action;
      this.prevAge = this.age;
      this.prevData = this.data;
      this.action = action;
      this.data = {};
      this.age = DURATIONS[action] && p.actionTime > 0 ? Math.max(0, DURATIONS[action] - p.actionTime) : 0;
      this.blendDuration = teleport ? 0 : blendTime(this.prevAction, action);
      this.blend = this.blendDuration > 0 ? 0 : 1;
      if (teleport) this.resetLocks();
      startAction(this, action, this.data, p, ctx);
    } else {
      this.age += ctx.dt;
      // Replays can jump forward; keep timed actions in step with the snapshot.
      if (DURATIONS[action] && p.actionTime > 0) this.age = Math.max(this.age, DURATIONS[action] - p.actionTime - 0.05);
    }
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + ctx.dt / this.blendDuration);
      this.prevAge += ctx.dt;
    }

    this.updateYaw(p, ctx, teleport);
    this.advanceGait(p, ctx, teleport);
    this.locomotion(this.base, p, ctx);

    this.evaluate(this.work.copy(this.base), this.action, this.age, this.data, p, ctx);
    if (this.blend < 1 && this.prevAction) {
      this.evaluate(this.prevPose.copy(this.base), this.prevAction, this.prevAge, this.prevData, p, ctx);
      this.pose.copy(this.prevPose).lerp(this.work, smoothstep(0, 1, this.blend));
    } else {
      this.pose.copy(this.work);
    }
    this.fresh = false;
    return this.pose;
  }

  // -------------------------------------------------------------------------
  // Snapshot -> motion state. Every new snapshot field has a fallback so the
  // rig works with simulations that do not emit speed, lean or backpedal.

  kinematics(p, ctx, teleport) {
    const vx = p.vx || 0, vz = p.vz || 0, dt = ctx.dt;
    const speed = Number.isFinite(p.speed) ? p.speed : Math.hypot(vx, vz);
    const heading = speed > 0.4 ? Math.atan2(vx, vz) : this.heading;
    if (teleport) {
      this.accel = 0; this.lean = 0; this.turn = 0;
    } else if (dt > 0) {
      this.accel = damp(this.accel, clamp((speed - this.speed) / dt, -25, 25), 7, dt);
      // Banking follows the simulation's lean (plan 3.1); a simulation that
      // does not report it gets an upright runner.
      this.lean = damp(this.lean, Number.isFinite(p.lean) ? clamp(p.lean, -1, 1) : 0, 9, dt);
      // Signed turn rate (positive = turning to his right), used to read the
      // direction of a cut when the snapshot carries no lean.
      const turnRate = speed > 0.8 ? wrapAngle(heading - this.heading) / dt : 0;
      this.turn = damp(this.turn, clamp(turnRate, -12, 12), 12, dt);
    }
    this.speed = speed;
    this.heading = heading;
    const facing = Math.PI - this.yaw;
    const forward = vx * Math.sin(facing) + vz * Math.cos(facing);
    const right = vx * Math.cos(facing) - vz * Math.sin(facing);
    if (speed > 0.05) this.local.set(-right / speed, forward / speed);
    this.backpedal = typeof p.backpedal === 'boolean' ? p.backpedal : (forward < -0.45 * speed && speed > 0.8);
  }

  resolveAction(p, ctx) {
    if (ctx.presnap) return 'ready';
    const holder = ctx.holderId === p.id;
    let a = SIM_ACTIONS.has(p.action) ? p.action : 'run';
    if (a === 'ready') a = 'run';
    // Stay in the stance after the snap until this player actually moves, so
    // he fires out of it instead of standing up first.
    if (this.action === 'ready' && a === 'run' && !holder && p.engaged == null && this.speed < 0.6 && ctx.state.time < 1.2) return 'ready';
    // After the whistle players on the ground stay there.
    if (ctx.dead && (this.action === 'down' || this.action === 'tackle')) return this.action;
    if (ctx.dead && this.action === 'wrapped') return 'down';
    if (a === 'run' || a === 'carry' || (a === 'block' && holder)) {
      if (holder) return ctx.pocket && p.id === ctx.qbId ? 'pocket' : 'carry';
      if (p.engaged != null && !ctx.dead) return 'block';
      return 'run';
    }
    return a;
  }

  updateYaw(p, ctx, teleport) {
    let target = Math.PI - (Number.isFinite(p.facing) ? p.facing : 0);
    const face = this.data.face?.(p, ctx);
    if (face) target = Math.PI - Math.atan2(face.x - p.x, face.z - p.z);
    if (this.data.holdYaw !== undefined) target = this.data.holdYaw;
    this.yaw = teleport || ctx.presnap ? target : approachAngle(this.yaw, target, 11 * ctx.dt);
  }

  // Stride length grows with speed: about 3.2 steps/s at 5 yd/s and 4.5 at
  // top speed. The cycle advances with distance travelled so feet do not skate.
  advanceGait(p, ctx, teleport) {
    const v = this.speed, role = this.spec.role;
    let cadence = v < 1 ? lerp(1.5, 1.8, v) : v < 5 ? lerp(1.8, 3.2, (v - 1) / 4) : lerp(3.2, 4.5, clamp((v - 5) / 4.3, 0, 1));
    if (this.backpedal) cadence *= 1.35;
    if (role === 'ol' || role === 'dl') cadence *= 1.1;
    const churning = this.action === 'block' || this.action === 'wrapped';
    if (churning) cadence = Math.max(cadence, 3.2);
    // Sideways movement is a quick step-together shuffle, not a stride.
    this.stepLen = Math.max(0.2, v / cadence) * (1 - 0.6 * Math.abs(this.local.x));
    let dist = v * ctx.dt;
    if (Number.isFinite(p.phase) && this.lastPhase !== null && !teleport) {
      const delta = p.phase - this.lastPhase;
      if (delta >= 0 && delta < 3) dist = delta;
    }
    this.lastPhase = Number.isFinite(p.phase) ? p.phase : null;
    let advance = dist / (2 * this.stepLen);
    if (churning && v < 2.5) advance = Math.max(advance, ctx.dt * 1.5);
    this.cycle += advance;
  }

  // -------------------------------------------------------------------------
  // Locomotion base pose: walk, jog, sprint, backpedal and shuffle from one
  // parametric gait, with stance feet pinned to the ground in world space.

  locomotion(pose, p, ctx) {
    const d = this.dims, v = this.speed;
    const moving = smoothstep(0.08, 0.9, v), run = smoothstep(2.0, 6.5, v), sprint = smoothstep(6.5, 9.0, v);
    const bp = this.backpedal ? smoothstep(0.5, 2, v) : 0;
    const s = fract(this.cycle);
    const lateral = Math.abs(this.local.x);
    const duty = lerp(0.62, 0.36, run) - 0.06 * sprint;
    const reachLen = Math.min(2 * duty * this.stepLen, 1.2) * moving * (1 - 0.35 * lateral);
    const lift = (lerp(0.06, 0.27, run) + 0.22 * sprint) * moving * (1 - 0.55 * bp) * (1 - 0.45 * lateral);
    const behind = lerp(0.1, 0.28, run) * (1 - bp);
    const width = lerp(0.115, 0.07, run) + 0.13 * lateral + 0.04 * bp;
    const dx = this.local.x, dz = this.local.y;

    pose.yaw = 0; pose.tiltPitch = 0; pose.tiltRoll = 0; pose.tiltLift = 0; pose.tiltFwd = 0;
    for (let i = 0; i < 2; i++) {
      const side = SIDES[i], ph = fract(s + i * 0.5), stance = ph < duty;
      let along, h, pitch;
      if (stance) {
        const u = ph / duty, heel = smoothstep(0.5, 1, u) * run;
        along = lerp(reachLen * (0.5 - behind), -reachLen * (0.5 + behind), u);
        h = heel * 0.07; pitch = heel * 0.55;
      } else {
        // Swing: heel recovers high behind, the knee drives through, and at
        // speed the foot reaches out and paws back just before contact.
        const u = (ph - duty) / (1 - duty), paw = 0.14 * sprint;
        along = lerp(-reachLen * (0.5 + behind), reachLen * (0.5 - behind) + paw, smoothstep(0.06, 0.8, u)) - paw * smoothstep(0.8, 1, u);
        h = lift * Math.sin(Math.PI * u ** 0.85);
        pitch = run * (u < 0.4 ? 0.55 : lerp(0.55, -0.2, (u - 0.4) / 0.6));
      }
      const foot = pose.feet[i];
      foot.set(side * width + dx * along, d.ankle + h, dz * along);
      // Feet never cross the midline: sideways motion becomes a shuffle.
      foot.x = side * Math.max(side * foot.x, 0.07);
      if (stance && moving > 0.05) this.pinFoot(i, foot); else this.locks[i].active = false;
      // A planted foot the body has slid past is picked up rather than crossed.
      if (side * foot.x < 0.05) { foot.x = side * 0.05; this.locks[i].active = false; }
      pose.footRot[i].set(pitch, side * 0.1, 0);
      pose.knees[i].set(side * 0.2, 0, 1);
    }

    // Pelvis: two bobs per cycle (lowest mid-stance), counter-rotating hips and
    // shoulders, forward lean from speed and acceleration, bank into turns.
    const bob = -Math.cos(TAU * 2 * (s - duty / 2)) * lerp(0.012, 0.034, run) * moving;
    const bank = this.lean * smoothstep(1.5, 5, v);
    const accelLean = clamp(this.accel / 9, -0.3, 0.6) * smoothstep(0.5, 3, v);
    // Low and leaning when exploding out of a stance or a cut.
    const crouch = 0.025 + 0.04 * run + 0.02 * sprint + 0.15 * bp + 0.09 * Math.max(0, accelLean);
    const swing = Math.cos(TAU * s) * moving;
    pose.pelvis.set(-bank * 0.1, d.hipY - crouch + bob, 0);
    pose.hips.set(0.04 + 0.08 * run + 0.06 * sprint + 0.12 * accelLean + 0.22 * bp, -0.1 * run * swing, 0.035 * moving * Math.sin(TAU * s) + bank * 0.26);
    const breathe = 0.012 * Math.sin(ctx.time * 2.1 + this.seed * 7) * (1 - moving);
    // Backpedalling: chest over the knees, weight on the balls of the feet.
    pose.spine.set(0.04 + 0.1 * run + 0.08 * sprint + 0.2 * accelLean + 0.3 * bp + breathe, 0.16 * run * swing * (1 - bp), bank * 0.1);
    pose.head.set(0.04 - 0.05 * run, 0, 0);

    // Arms swing against the legs, set by joint angles: shoulder flexion
    // (forward +) and elbow flexion. Sprinters pump hard with the elbows near
    // 90 degrees, the front hand rising to the chin and the back hand passing
    // the hip; walkers swing nearly straight arms.
    const amp = (0.22 * (1 - run) + 0.55 * run + 0.35 * sprint) * moving;
    const bent = smoothstep(0, 0.55, run) * moving;
    for (let i = 0; i < 2; i++) {
      const side = SIDES[i], w = (i === 0 ? -1 : 1) * Math.cos(TAU * s);
      let flex = 0.05 + amp * w - 0.06 * sprint;
      let elbow = lerp(0.22, 1.5, bent) + (0.25 * w + 0.05) * run;
      let abduct = 0.1 + 0.08 * run, inward = 0.28 * run * Math.max(0, w);
      // Backpedalling defensive backs pump short, bent arms in front of the hips.
      if (bp > 0) {
        flex = lerp(flex, 0.02 + 0.34 * w, bp);
        elbow = lerp(elbow, 1.4 + 0.15 * w, bp);
        abduct = lerp(abduct, 0.2, bp);
        inward = lerp(inward, 0.05, bp);
      }
      armAngles(pose, i, d, flex, elbow, abduct, inward);
      pose.wrists[i].set(-0.1 * run, 0, 0);
    }
  }

  resetLocks() { for (const l of this.locks) l.active = false; }

  // Keeps a stance foot where it landed; drags it only if the body has moved
  // away further than a leg can stretch.
  pinFoot(i, foot) {
    const lock = this.locks[i];
    if (!lock.active) {
      this.rootToWorld(foot, lock);
      lock.active = true;
      return;
    }
    const local = this.worldToRoot(lock, _v);
    const err = Math.hypot(local.x - foot.x, local.z - foot.z);
    if (err > 0.32) {
      const k = (err - 0.32) / err;
      local.x += (foot.x - local.x) * k; local.z += (foot.z - local.z) * k;
      this.rootToWorld(local, lock);
    }
    foot.x = local.x; foot.z = local.z;
  }

  // Root frame (yaw only) <-> scene space, for the current position and yaw.
  rootToWorld(local, out) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    out.x = this.x + local.x * c + local.z * s;
    out.z = -this.z - local.x * s + local.z * c;
    return out;
  }

  worldToRoot(world, out) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw), dx = world.x - this.x, dz = world.z + this.z;
    out.x = dx * c - dz * s;
    out.z = dx * s + dz * c;
    out.y = 0;
    return out;
  }

  // -------------------------------------------------------------------------
  // Helpers for the action and stance layers.

  evaluate(pose, action, age, data, p, ctx) {
    if (action === 'ready') applyStance(this, pose, p, ctx);
    else ACTIONS[action]?.(this, pose, age, data, p, ctx);
  }

  // Call once the pose's torso is final; chestPoint/handAt then convert
  // tilt-frame points into that pose's chest frame.
  prepareChest(pose) {
    chestMatrix(pose, this.dims, this.chestInverse).invert();
  }

  chestPoint(x, y, z, out) {
    return out.set(x, y, z).applyMatrix4(this.chestInverse);
  }

  // Hand target from a point in the tilt frame.
  handAt(pose, i, x, y, z) {
    this.chestPoint(x, y, z, pose.hands[i]);
  }

  // Scene-space point -> tilt frame of `pose` (uses this.yaw and position).
  worldToTilt(pose, point, out) {
    tiltMatrix(this.x, this.z, this.yaw, pose, _m).invert();
    return out.copy(point).applyMatrix4(_m);
  }

  // Scene-space point -> chest frame of `pose`.
  worldToChest(pose, point, out) {
    tiltMatrix(this.x, this.z, this.yaw, pose, _m);
    chestMatrix(pose, this.dims, _m2);
    return out.copy(point).applyMatrix4(_m.multiply(_m2).invert());
  }

  // Head orientation (tilt frame) that looks at a scene-space point.
  lookAt(pose, point, weight = 1) {
    const local = this.worldToTilt(pose, point, _v);
    const dx = local.x, dy = local.y - (pose.pelvis.y + 0.85 * this.dims.k), dz = local.z;
    const yaw = Math.atan2(dx, dz), pitch = Math.atan2(-dy, Math.hypot(dx, dz));
    pose.head.x = lerp(pose.head.x, clamp(pitch, -0.9, 0.9), weight);
    pose.head.y = lerp(pose.head.y, clamp(yaw, -1.3, 1.3), weight);
  }
}
