// Public entry points of the skinned-character pipeline.
//
//   createSkinnedAthletes(scene, players, options) -> Promise<SkinnedAthletes>
//   new AthletesLayer(scene, players, options)      synchronous wrapper: draws
//       simple placeholders until the model has loaded (or a fallback layer
//       if it fails), so a frame never throws
//   loadModelIndex(url)                             reads dist/models/index.json
//
// options:
//   modelUrl     './models/player.glb' (GLB/glTF or FBX, rigged, T-pose)
//   clipUrls     {slot: url} or [url, ...] (slot from the file name)
//   index        URL of a models index.json instead of modelUrl/clipUrls
//   palette      {offense: {...}, defense: {...}, qb: {...}} colour overrides
//   quality      a graphics.js PROFILES entry
//   clipAliases  {slot: 'clip name inside the model file'}
//   manager      THREE.LoadingManager
//   fallback     () => an Athletes-like layer to use if loading fails
//   dev          true when loading the development stand-in (./dev/Xbot.glb)
import * as THREE from '../../vendor/three.module.js';
import { loadCharacterAsset } from './asset.js';
import { SkinnedAthletes } from './athletes.js';
import { resolveModelIndex } from './clips.js';
import { uniformFor } from './palette.js';
import { makeBall, makeRing, makeContactShadows } from './props.js';

export { SkinnedAthletes };
export const MODEL_INDEX_URL = './models/index.json';

// Reads the model index; null when no model is listed (or no index).
export async function loadModelIndex(url = MODEL_INDEX_URL) {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) return null;
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    return resolveModelIndex(await response.json(), base);
  } catch {
    return null;
  }
}

export async function createSkinnedAthletes(scene, players, options = {}) {
  let { modelUrl, clipUrls } = options;
  if (!modelUrl && options.index) {
    const index = await loadModelIndex(options.index);
    if (!index) throw new Error(`No character model listed in ${options.index}`);
    ({ modelUrl, clipUrls } = index);
  }
  if (!modelUrl) throw new Error('createSkinnedAthletes needs options.modelUrl or options.index');
  if (/\/dev\//.test(modelUrl) && !options.dev) throw new Error('The development stand-in model needs options.dev = true');
  const messages = [];
  const asset = await loadCharacterAsset({
    modelUrl, clipUrls, manager: options.manager, clipAliases: options.clipAliases,
    log: m => messages.push(m),
  });
  if (messages.length) console.warn('Character clips: ' + messages.join('; '));
  const layer = new SkinnedAthletes(scene, players, asset, options);
  layer.messages = messages;
  return layer;
}

// Team-coloured capsules, the ball and the ring: drawn while the model loads.
export class PlaceholderAthletes {
  constructor(scene, players) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'athlete-placeholders';
    const geometry = new THREE.CapsuleGeometry(0.26, 1.5, 4, 10);
    geometry.translate(0, 1.03, 0);
    this.bodies = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.7 }), players.length);
    this.bodies.frustumCulled = false;
    players.forEach((p, i) => this.bodies.setColorAt(i, new THREE.Color(uniformFor(p).jersey)));
    this.ids = players.map(p => p.id);
    this.ball = makeBall();
    this.ring = makeRing();
    this.contactShadows = makeContactShadows(players.length);
    this.group.add(this.bodies, this.ball, this.ring, this.contactShadows);
    scene.add(this.group);
    this.dummy = new THREE.Object3D();
  }
  setQuality() {}
  update(state, dt, { menu = false } = {}) {
    const players = state.players || [];
    const controlled = players.find(p => p.id === (state.carrier || state.selected)) || players[0];
    players.forEach(p => {
      const i = this.ids.indexOf(p.id);
      if (i < 0) return;
      const d = this.dummy;
      d.position.set(p.x, 0, -p.z); d.rotation.set(0, Math.PI - (p.facing || 0), 0); d.scale.set(1, 1, 1); d.updateMatrix();
      this.bodies.setMatrixAt(i, d.matrix);
      d.position.y = 0.022; d.rotation.set(-Math.PI / 2, 0, 0); d.updateMatrix();
      this.contactShadows.setMatrixAt(i, d.matrix);
    });
    this.bodies.instanceMatrix.needsUpdate = true;
    this.contactShadows.instanceMatrix.needsUpdate = true;
    const b = state.ball || { x: 0, y: 0, z: 0 };
    this.ball.position.set(b.x, Math.max(0.1, b.y), -b.z);
    if (controlled) { this.ring.position.set(controlled.x, 0.03, -controlled.z); this.ring.visible = !menu && state.phase !== 'dead'; }
    this.scene.updateMatrixWorld(true);
    return controlled;
  }
  dispose() { this.group.removeFromParent(); }
}

// Synchronous wrapper with the Athletes interface. The model loads in the
// background; until then placeholders render. On failure it switches to
// options.fallback() when given (e.g. the procedural Athletes), else keeps
// the placeholders. `ready` resolves to the skinned layer or null.
export class AthletesLayer {
  constructor(scene, players, options = {}) {
    this.scene = scene;
    this.players = players;
    this.options = options;
    this.profile = options.quality;
    this.active = new PlaceholderAthletes(scene, players);
    this.status = 'loading';
    this.ready = createSkinnedAthletes(scene, players, options).then(layer => {
      this.swap(layer);
      this.status = 'ready';
      return layer;
    }).catch(error => {
      console.warn('Skinned athletes unavailable, using ' + (options.fallback ? 'the procedural athletes' : 'placeholders') + ': ' + (error?.message || error));
      this.status = 'failed';
      if (options.fallback) this.swap(options.fallback());
      return null;
    });
  }
  swap(layer) {
    this.active.dispose?.();
    this.active = layer;
    if (this.profile) layer.setQuality(this.profile);
  }
  get ball() { return this.active.ball; }
  get ring() { return this.active.ring; }
  setQuality(profile) { this.profile = profile; this.active.setQuality(profile); }
  update(state, dt, options) {
    try {
      return this.active.update(state, dt, options);
    } catch (error) {
      if (!this.reported) { console.warn('Athletes update failed: ' + (error?.message || error)); this.reported = true; }
      const players = state.players || [];
      return players.find(p => p.id === (state.carrier || state.selected)) || players[0];
    }
  }
}
