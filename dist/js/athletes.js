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
//   new Athletes(scene, players)  players = sim.players (id, team, role, number, speed)
//   setQuality(profile)
//   update(state, dt, {menu}) -> the controlled player's snapshot
// update() poses every rig, the ball, the indicator and the shadows, and leaves
// their world matrices and instance buffers ready for renderer.render().
export class Athletes {
  constructor(scene, players) {
    this.scene = scene;
    this.materials = createMaterials(players);
    const geometry = createGeometries();
    this.squad = new Squad(scene, players.length, this.materials);
    this.group = this.squad.group;
    this.rigs = new Map();
    this.animators = new Map();
    const atlas = this.materials.atlas;
    players.forEach((spec, i) => {
      const cell = { offset: atlas.offsets.get(spec.id), scale: atlas.scale, white: atlas.white };
      const rig = new Rig(this.squad, spec, i, geometry, cell);
      this.rigs.set(spec.id, rig);
      this.animators.set(spec.id, new Animator(rig, spec));
    });
    this.squad.finish();
    for (const g of Object.values(geometry)) g.dispose();
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
      if (!holderId && dead) holderId = state.players.find(p => p.action === 'catch')?.id ?? null;
    }
    const qb = this.byId.get(this.qbId);
    const b = state.ball;
    this.ballScene.set(b.x, b.y, -b.z);
    const ctx = {
      state, phase: state.phase, presnap, dead, reset,
      dt: animDt, realDt: Math.max(0, Math.min(dt, 0.1)), time: this.time,
      deadTime: state.deadTime || 0, spot: state.spot ?? 35, ball: b, ballScene: this.ballScene,
      byId: this.byId, rigs: this.rigs, animators: this.animators,
      holderId, carrierId: state.carrier, qbId: this.qbId,
      pocket: holderId === this.qbId && state.phase === 'live' && !!qb && qb.z < (state.spot ?? 35) + 0.3,
    };
    this.anticipateCatches(ctx);
    return ctx;
  }

  // While the ball is in the air, every eligible player gets the point and
  // time at which the ball passes closest to him, so hands can reach early.
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
      if (!p || Math.hypot(p.x - b.x, p.z - b.z) > 30) continue;
      let best = null;
      for (let t = 0; t <= 1.6; t += 1 / 60) {
        const y = b.y + vy * t - 0.5 * GRAVITY * t * t;
        if (y < 0.2) break;
        if (y > 3.1) continue;
        const bx = b.x + vx * t, bz = b.z + vz * t;
        const d = Math.hypot(bx - (p.x + (p.vx || 0) * t), bz - (p.z + (p.vz || 0) * t));
        if (!best || d < best.dist) best = { t, dist: d, x: bx, y, z: bz };
      }
      if (!best || best.dist > 2.2) continue;
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
