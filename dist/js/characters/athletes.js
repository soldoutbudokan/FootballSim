// The skinned athletes layer. Same interface as the procedural Athletes
// (plan 3.5): setQuality(profile) and update(state, dt, {menu}) -> the
// controlled player's snapshot, leaving world matrices ready for render.
import * as THREE from '../../vendor/three.module.js';
import { Character, bodyScale } from './character.js';
import { UniformMaterials } from './materials.js';
import { NumberAtlas, numberPlacement, makeBall, makeRing, makeContactShadows } from './props.js';
import { uniformFor } from './palette.js';

const ELIGIBLE_LOOK = new Set(['wr', 'te', 'rb', 'cb', 's', 'lb']);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

export class SkinnedAthletes {
  // players: sim.players (id, team, role, number); asset: loadCharacterAsset()
  constructor(scene, players, asset, options = {}) {
    this.scene = scene;
    this.asset = asset;
    this.options = options;
    this.group = new THREE.Group();
    this.group.name = 'skinned-athletes';
    scene.add(this.group);

    const shared = this.sharedData(players, options);
    this.rigs = new Map();
    for (const spec of players) {
      const c = new Character(asset, spec, shared);
      this.rigs.set(spec.id, c);
      this.group.add(c.root);
    }
    this.ball = makeBall();
    this.ring = makeRing();
    this.contactShadows = makeContactShadows(players.length);
    this.group.add(this.ball, this.ring, this.contactShadows);
    this.dummy = new THREE.Object3D();
    this.ballSpin = 0;
    this.frame = 0;
    this.setQuality(options.quality || { id: 'balanced', shadow: 1024 });
  }

  sharedData(players, options) {
    const asset = this.asset;
    const rig = asset.rig;
    rig.fitRoot.updateMatrixWorld(true);
    // The hips' parent in character space, and every canonical bone's rest.
    const base = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: 1 };
    rig.canon.Hips.parent.matrixWorld.decompose(base.position, base.quaternion, _s);
    base.scale = _s.x;
    const rest = {};
    for (const [c, bone] of Object.entries(rig.canon)) rest[c] = { quaternion: bone.quaternion.clone(), charQuaternion: bone.getWorldQuaternion(new THREE.Quaternion()) };
    const gaits = Object.fromEntries(Object.entries(asset.clips).filter(([, i]) => i.gait).map(([s, i]) => [s, i.gait]));
    const atlas = options.numbers === false ? null : new NumberAtlas(players.map(p => ({ key: p.id, number: p.number, color: uniformFor(p, options.palette).number })));
    return {
      palette: options.palette,
      materials: new UniformMaterials(asset),
      ctx: { available: asset.available, gaits },
      base, rest, atlas,
      placement: numberPlacement(asset.vertices, asset.joints),
      spineInverse: rig.canon.Spine2 ? rig.canon.Spine2.matrixWorld.clone().invert() : new THREE.Matrix4(),
    };
  }

  // Graphics profile (graphics.js PROFILES entry): shadow maps at balanced+,
  // contact shadows carry the grounding on performance; far players animate
  // at half rate on performance.
  setQuality(profile = {}) {
    this.profile = profile;
    const shadows = (profile.shadow || 0) > 0;
    for (const c of this.rigs.values()) c.setShadows(shadows);
    this.ball.castShadow = shadows;
    this.contactShadows.material.opacity = shadows ? 0.24 : 0.46;
    // Beyond this many yards from the focus, animate every other frame.
    this.lodDistance = profile.id === 'performance' ? 16 : profile.id === 'balanced' ? 30 : Infinity;
    // Beyond this many yards from the camera, draw the reduced mesh.
    this.meshLodDistance = { performance: 9, balanced: 17, high: 28 }[profile.id] ?? Infinity;
  }

  update(state, dt, { menu = false } = {}) {
    this.frame++;
    const players = state.players || [];
    const controlled = players.find(p => p.id === (state.carrier || state.selected)) || players[0];
    const focus = state.phase === 'air' ? state.ball : controlled || { x: 0, z: 0 };
    const target = this.passTarget(state);
    // The camera (when the integrator hands it over) picks mesh detail;
    // without one, distance from the focus stands in (the camera follows it).
    const eye = this.camera?.position || this.options.camera?.position || null;
    players.forEach((p, i) => {
      const c = this.rigs.get(p.id);
      if (!c) return;
      const fromFocus = Math.hypot(p.x - focus.x, p.z - focus.z);
      const fromEye = eye ? Math.hypot(p.x - eye.x, 1 - eye.y, -p.z - eye.z) : fromFocus + 9;
      c.setLod(fromEye > this.meshLodDistance ? 1 : 0);
      const far = fromFocus > this.lodDistance;
      const env = { state, skipAnimation: far && (this.frame + i) % 2 === 1 };
      if (!env.skipAnimation) this.lookAndReach(c, p, state, env, target);
      c.update(p, far ? dt * 2 : dt, env);
      this.placeShadow(i, p, c);
    });
    this.contactShadows.count = players.length;
    this.contactShadows.instanceMatrix.needsUpdate = true;
    this.placeRing(controlled, state, menu);
    this.placeBall(state, dt);
    this.scene.updateMatrixWorld(true);
    return controlled;
  }

  // The receiver the ball is heading to: nearest offensive eligible to it.
  passTarget(state) {
    if (state.phase !== 'air' || !state.ball) return null;
    const b = state.ball;
    let best = null, d = Infinity;
    for (const p of state.players) {
      const c = this.rigs.get(p.id);
      if (!c || p.id === 'QB' || !ELIGIBLE_LOOK.has(c.spec.role) || c.spec.team !== 'offense') continue;
      const dist = Math.hypot(p.x - b.x, p.z - b.z);
      if (dist < d) { d = dist; best = p.id; }
    }
    return best;
  }

  // Character-space ball position for heads and hands.
  toLocal(c, x, y, z) {
    c.root.updateMatrix();
    return _v.set(x, y, -z).applyMatrix4(_m.copy(c.root.matrix).invert()).clone();
  }

  lookAndReach(c, p, state, env, target) {
    const b = state.ball;
    if (!b) return;
    const airborne = state.phase === 'air';
    if (airborne && ELIGIBLE_LOOK.has(c.spec.role) && Math.hypot(p.x - b.x, p.z - b.z) < 45) {
      const local = this.toLocal(c, b.x, b.y, b.z);
      if (local.z > -0.5) env.lookTarget = local;
    }
    if (p.action === 'catch' || (airborne && target === p.id)) {
      env.ball = this.toLocal(c, b.x, b.y, b.z);
      if (airborne) {
        const speed = Math.max(4, Math.hypot(b.vx || 0, b.vy || 0, b.vz || 0));
        const eta = Math.hypot(p.x - b.x, (1.4 - b.y), p.z - b.z) / speed;
        env.reach = Math.max(0, Math.min(1, 1 - (eta - 0.12) / 0.35));
      }
    }
    if (state.phase === 'presnap' && c.spec.id === 'C') env.ball = this.toLocal(c, b.x, 0, b.z);
  }

  placeShadow(i, p, c) {
    const down = c.layers.down || c.layers.tackle || 0;
    const scale = bodyScale(c.spec.role);
    const d = this.dummy;
    d.position.set(p.x, 0.022, -p.z);
    d.rotation.set(-Math.PI / 2, 0, Math.PI - (p.facing || 0));
    d.scale.set(scale.width * scale.height, 1 + down * 1.3, 1);
    if (down > 0) d.position.add(_v.set(Math.sin(p.facing || 0), 0, -Math.cos(p.facing || 0)).multiplyScalar(0.7 * down));
    d.updateMatrix();
    this.contactShadows.setMatrixAt(i, d.matrix);
  }

  placeRing(p, state, menu) {
    this.ring.visible = !!p && !menu && state.phase !== 'dead';
    if (!p) return;
    this.ring.position.set(p.x, 0.03, -p.z);
    this.ring.rotation.set(0, Math.PI - (p.facing || 0), 0);
  }

  // Carried: in the carrier's hand/arm (state.ball ignored). In flight: from
  // state.ball, nose along the velocity with a spiral. Dead and unheld: on
  // the ground. Pre-snap: on the ground at the line.
  placeBall(state, dt) {
    const ball = this.ball, b = state.ball || { x: 0, y: 0, z: 0 };
    const r = ball.userData.radius;
    ball.visible = true;
    const carrier = state.carrier && this.rigs.get(state.carrier);
    const inFlight = state.phase === 'air';
    if (state.phase === 'presnap' || (!carrier && !inFlight)) {
      const settle = state.phase === 'dead' ? Math.max(r, (b.y || 0) - (state.deadTime || 0) * 4) : r;
      ball.position.set(b.x, Math.max(r * 0.92, state.phase === 'presnap' ? r * 0.92 : settle), -b.z);
      if (state.phase === 'presnap' || !this.restYaw) this.restYaw = 0;
      ball.quaternion.setFromEuler(new THREE.Euler(0, this.restYaw, 0));
      return;
    }
    if (inFlight) {
      ball.position.set(b.x, b.y, -b.z);
      const dir = _v.set(b.vx || 0, b.vy || 0, -(b.vz || 0));
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      this.ballSpin += dt * 34;
      ball.quaternion.setFromUnitVectors(Z, dir).multiply(_q.setFromAxisAngle(Z, this.ballSpin));
      this.restYaw = Math.atan2(dir.x, dir.z);
      return;
    }
    // Carried.
    const p = state.players.find(q => q.id === state.carrier);
    const mode = carrier.holding ? 'both' : p && (p.action === 'throw') ? 'hand' : p && p.action === 'catch' && carrier.clock.elapsed < 0.25 ? 'both' : 'tuck';
    const anchor = carrier.ballAnchor(mode);
    if (!anchor) { ball.position.set(b.x, b.y, -b.z); return; }
    carrier.root.updateMatrix();
    ball.position.copy(anchor.position).applyMatrix4(carrier.root.matrix);
    carrier.root.matrix.decompose(_s.set(0, 0, 0), _q, new THREE.Vector3());
    const dir = anchor.direction.clone().applyQuaternion(_q).normalize();
    ball.quaternion.setFromUnitVectors(Z, dir);
  }

  dispose() {
    for (const c of this.rigs.values()) c.dispose();
    this.group.removeFromParent();
  }
}
