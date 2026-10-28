// Team-coloured capsules, the ball and the control ring: what the athletes
// layer draws while a skinned model is still loading (when no procedural
// layer was handed over to stand in). Same interface as every athletes layer.
import * as THREE from '../../vendor/three.module.js';
import { uniformFor } from './palette.js';
import { makeBall, makeRing, makeContactShadows } from './props.js';

export function controlledPlayer(state) {
  const players = state?.players || [];
  return players.find(p => p.id === (state.carrier || state.selected)) || players[0];
}

export class PlaceholderAthletes {
  constructor(scene, players) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'athlete-placeholders';
    const geometry = new THREE.CapsuleGeometry(0.26, 1.5, 4, 10);
    geometry.translate(0, 1.03, 0);
    this.bodies = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.7 }), Math.max(1, players.length));
    this.bodies.frustumCulled = false;
    players.forEach((p, i) => this.bodies.setColorAt(i, new THREE.Color(uniformFor(p).jersey)));
    this.index = new Map(players.map((p, i) => [p.id, i]));
    this.ball = makeBall();
    this.ring = makeRing();
    this.contactShadows = makeContactShadows(Math.max(1, players.length));
    this.group.add(this.bodies, this.ball, this.ring, this.contactShadows);
    scene.add(this.group);
    this.dummy = new THREE.Object3D();
  }

  setQuality(profile = {}) {
    this.bodies.castShadow = (profile.shadow || 0) > 0;
  }

  update(state, dt, { menu = false } = {}) {
    const controlled = controlledPlayer(state);
    const d = this.dummy;
    for (const p of state?.players || []) {
      const i = this.index.get(p.id);
      if (i === undefined) continue;
      d.position.set(p.x || 0, 0, -(p.z || 0));
      d.rotation.set(0, Math.PI - (p.facing || 0), 0);
      d.updateMatrix();
      this.bodies.setMatrixAt(i, d.matrix);
      d.position.y = 0.022;
      d.rotation.set(-Math.PI / 2, 0, 0);
      d.updateMatrix();
      this.contactShadows.setMatrixAt(i, d.matrix);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.contactShadows.instanceMatrix.needsUpdate = true;
    const b = state?.ball || { x: 0, y: 0, z: 0 };
    this.ball.position.set(b.x || 0, Math.max(this.ball.userData.radius, b.y || 0), -(b.z || 0));
    this.ring.visible = !!controlled && !menu && state.phase !== 'dead';
    if (controlled) this.ring.position.set(controlled.x || 0, 0.03, -(controlled.z || 0));
    this.scene.updateMatrixWorld(true);
    return controlled;
  }

  dispose() { this.group.removeFromParent(); }
}

// Removes an athletes layer's objects from the scene. Skinned and placeholder
// layers dispose themselves; the procedural Athletes (dist/js/athletes.js)
// has no dispose, so its rigs, instanced part batches, ball, ring and contact
// shadows are taken out here.
export function removeLayer(layer) {
  if (!layer) return;
  if (typeof layer.dispose === 'function') { layer.dispose(); return; }
  layer.rigs?.forEach?.(r => (r.root || r)?.removeFromParent?.());
  layer.batch?.batches?.forEach?.(b => b.mesh?.removeFromParent?.());
  for (const key of ['ball', 'ring', 'contactShadows', 'group']) layer[key]?.removeFromParent?.();
}
