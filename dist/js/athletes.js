import * as THREE from '../vendor/three.module.js';
import { GRAVITY } from './sim.js';
import { Squad, Rig, createGeometries } from './athletes/rig.js';
import { Animator } from './athletes/motion.js';
import { createMaterials } from './athletes/uniform.js';
import { Football } from './athletes/ball.js';
import { Markers } from './athletes/markers.js';

// Everything that moves: the 22 athletes, the ball, the control indicator and
// the contact shadows. Scene units are yards; simulation +z maps to scene -z.
//
// Interface (plan section 3.5):
//   new Athletes(scene, players, {camera})  players = sim.players (id, team, role, number, speed)
//   setQuality(profile)
//   update(state, dt, {menu}) -> the controlled player's snapshot
// update() poses every rig, the ball, the indicator and the shadows, and leaves
// their world matrices and instance buffers ready for renderer.render().
// Distance from the camera (yards) beyond which an athlete is drawn with the
// reduced meshes, per graphics tier; High and Ultra always draw full detail.
// An athlete switches back inside the distance minus LOD_HYSTERESIS. At
// Balanced the game camera sits about 30 yd from the deep safeties, so the
// switch is pushed past them (and the band widened) to keep them from popping.
export const LOD_DISTANCE = { performance: 20, balanced: 40 };
const LOD_HYSTERESIS = { performance: 2, balanced: 4 };
// Highest ball (yards) a player reaches for: a leaping two-hand catch.
const CATCH_TOP = 2.6;

export class Athletes {
  // options.camera: the scene camera, for the distance level of detail
  // (without it the controlled player stands in for the camera).
  constructor(scene, players, options = {}) {
    this.scene = scene;
    this.camera = options.camera || null;
    this.materials = createMaterials(players);
    const geometry = createGeometries(), low = createGeometries({ low: true });
    this.squad = new Squad(scene, players.length, this.materials);
    this.group = this.squad.group;
    this.rigs = new Map();
    this.animators = new Map();
    const atlas = this.materials.atlas;
    players.forEach((spec, i) => {
      const cell = { offset: atlas.offsets.get(spec.id), scale: atlas.scale, white: atlas.white };
      const rig = new Rig(this.squad, spec, i, geometry, cell, low);
      this.rigs.set(spec.id, rig);
      this.animators.set(spec.id, new Animator(rig, spec));
    });
    this.squad.finish();
    for (const g of [...Object.values(geometry), ...Object.values(low)]) g.dispose();
    this.index = new Map(players.map((spec, i) => [spec.id, i]));
    this.levels = new Uint8Array(players.length);
    this.lodDistance = Infinity;
    this.lodBand = 2;
    this.ball = new Football(this.group, this.materials);
    this.markers = new Markers(this.group, players.length);
    this.qbId = players.find(p => p.role === 'qb')?.id ?? 'QB';
    this.lastClock = null;
    this.time = 0;
    this.byId = new Map();
    this.ballScene = new THREE.Vector3();
  }

  setQuality(profile) {
    // Small parts (towels, tape, belts, chin straps) are skipped on the lowest tier.
    this.squad.setDetail(profile.detail !== false);
    this.markers.setQuality(profile);
    this.lodDistance = LOD_DISTANCE[profile.id] ?? Infinity;
    this.lodBand = LOD_HYSTERESIS[profile.id] ?? 2;
  }

  // Full or reduced meshes per athlete, by distance from the camera.
  chooseLevels(state, controlled) {
    const eye = this.camera?.position;
    const far = this.lodDistance;
    for (const p of state.players) {
      const i = this.index.get(p.id);
      if (i === undefined) continue;
      let d = 0;
      if (Number.isFinite(far)) d = eye ? Math.hypot(p.x - eye.x, 1.1 - eye.y, -p.z - eye.z) : Math.hypot(p.x - controlled.x, p.z - controlled.z) + 11;
      const limit = this.levels[i] ? far - this.lodBand : far;
      this.levels[i] = d > limit ? 1 : 0;
    }
    this.squad.setLevels(this.levels);
  }

  update(state, dt, { menu = false } = {}) {
    const ctx = this.frameContext(state, dt, menu);
    for (const p of state.players) {
      const anim = this.animators.get(p.id);
      if (!anim) continue;
      anim.rig.apply(anim.update(p, ctx), p.x, p.z, anim.yaw);
    }
    this.squad.commit();
    this.ball.update(ctx, this);
    const controlled = state.players.find(p => p.id === (state.carrier || state.selected)) || state.players[0];
    this.chooseLevels(state, controlled);
    this.markers.update(ctx, this, controlled, this.ball, menu);
    // Everything this module draws lives under one group; its world matrices
    // are current when update() returns, whatever the scene's auto-update.
    this.group.updateMatrixWorld(true);
    return controlled;
  }

  // Per-frame facts shared by every animator.
  frameContext(state, dt, menu) {
    const presnap = state.phase === 'presnap';
    // Animation advances with simulation time so replays (half speed, paused,
    // scrubbed) stay in step with the recorded motion.
    const clock = (state.time || 0) + (state.deadTime || 0);
    let animDt = dt, reset = false;
    if (!presnap && !menu && this.lastClock !== null) {
      animDt = clock - this.lastClock;
      if (animDt < -1e-6 || animDt > 0.3) { reset = true; animDt = 0; }
    }
    this.lastClock = presnap ? null : clock;
    animDt = Math.max(0, Math.min(animDt, 0.1));
    this.time += animDt;

    this.byId.clear();
    for (const p of state.players) this.byId.set(p.id, p);
    const dead = state.phase === 'dead';
    let holderId = null;
    if (!presnap && state.phase !== 'air') {
      holderId = state.carrier || null;
      if (!holderId && dead) holderId = this.deadBallHolder(state);
    }
    const qb = this.byId.get(this.qbId);
    const b = state.ball;
    this.ballScene.set(b.x, b.y, -b.z);
    const pocket = holderId === this.qbId && state.phase === 'live' && !!qb && qb.z < (state.spot ?? 35) + 0.3;
    const ctx = {
      state, phase: state.phase, presnap, dead, reset,
      dt: animDt, realDt: Math.max(0, Math.min(dt, 0.1)), time: this.time,
      deadTime: state.deadTime || 0, spot: state.spot ?? 35, ball: b, ballScene: this.ballScene,
      byId: this.byId, rigs: this.rigs, animators: this.animators,
      holderId, carrierId: state.carrier, qbId: this.qbId,
      pocket,
      // Linemen pass protect while the simulation's line protects the pocket
      // (never on a run play); otherwise they run block. A snapshot without
      // the field: while the quarterback holds the ball behind the line and
      // while a pass is in the air.
      protect: state.pocket ?? (pocket || state.phase === 'air'),
      // Where the ball was when a pass was caught: the snapshot already puts
      // it in the receiver's hands, the hands still have to meet it there.
      catchFrom: this.lastPhase === 'air' && state.phase !== 'air' ? this.ball.position.clone() : null,
    };
    this.lastPhase = state.phase;
    this.anticipateCatches(ctx);
    return ctx;
  }

  // Scene-space point at the crown of player `id`'s helmet, wherever his
  // pose puts it (a crouched stance, a dive). Used for the receiver badges.
  helmetTop(id, out) {
    const rig = this.rigs.get(id);
    if (!rig) return null;
    // Head joint -> shell centre (0.115) -> crown (0.135, flattened), helmet scale 1.05.
    return out.copy(rig.world.head).setY(rig.world.head.y + 0.255);
  }

  // Removes this layer from the scene and frees its GPU resources (when the
  // skinned athletes replace it). Every geometry, material and texture under
  // the group belongs to this instance.
  dispose() {
    this.group.removeFromParent();
    const textures = new Set();
    this.group.traverse(o => {
      o.geometry?.dispose?.();
      for (const m of [].concat(o.material || [])) {
        for (const value of Object.values(m)) if (value?.isTexture) textures.add(value);
        m.dispose();
      }
    });
    for (const t of textures) t.dispose();
    this.squad.bones.texture.dispose();   // shader uniform, not a material property
  }

  // After the whistle with no carrier (an interception) the simulation keeps
  // the ball, motionless, in a player's hands. A dropped or incomplete ball
  // is moving or on the turf, so nobody holds it.
  deadBallHolder(state) {
    const b = state.ball;
    if (b.y < 0.8 || Math.hypot(b.vx || 0, b.vy || 0, b.vz || 0) > 0.01) return null;
    let best = null, gap = 0.6;
    for (const p of state.players) {
      const d = Math.hypot(p.x - b.x, p.z - b.z);
      if (d < gap) { gap = d; best = p.id; }
    }
    return best;
  }

  // While the ball is in the air, every player it will pass within reach of
  // (about 1.3 yd, at a height his hands can get to) gets the point and time
  // of its closest approach, so his hands can reach for it early. Linemen and
  // anyone locked in a block do not reach.
  anticipateCatches(ctx) {
    const air = ctx.phase === 'air';
    for (const anim of this.animators.values()) {
      if (ctx.presnap) anim.catchPoint = null;
      anim.reach = null;
    }
    if (!air) return;
    const b = ctx.ball, vx = b.vx || 0, vy = b.vy || 0, vz = b.vz || 0;
    for (const [id, anim] of this.animators) {
      const role = anim.spec.role;
      if (id === this.qbId || role === 'ol') continue;
      const p = ctx.byId.get(id);
      if (!p || p.engaged != null || Math.hypot(p.x - b.x, p.z - b.z) > 30) continue;
      let best = null;
      for (let t = 0; t <= 1.6; t += 1 / 60) {
        const y = b.y + vy * t - 0.5 * GRAVITY * t * t;
        if (y < 0.3) break;
        if (y > CATCH_TOP) continue;
        const bx = b.x + vx * t, bz = b.z + vz * t;
        const d = Math.hypot(bx - (p.x + (p.vx || 0) * t), bz - (p.z + (p.vz || 0) * t));
        if (!best || d < best.dist) best = { t, dist: d, x: bx, y, z: bz };
      }
      if (!best || best.dist > 1.3) continue;
      // The hands meet the ball out along its incoming path (relative to the
      // runner), not at the body: back off 0.42 yd from the closest approach.
      const rx = vx - (p.vx || 0), ry = vy - GRAVITY * best.t, rz = vz - (p.vz || 0), rl = Math.hypot(rx, ry, rz) || 1;
      const back = 0.42;
      const point = new THREE.Vector3(
        best.x - (p.vx || 0) * best.t - rx / rl * back,
        Math.max(0.45, best.y - ry / rl * back),
        -(best.z - (p.vz || 0) * best.t - rz / rl * back),
      );
      anim.reach = { point, t: best.t, dist: best.dist };
      if (best.t < 0.3 && best.dist < 1.3) anim.catchPoint = point.clone();
    }
  }
}
