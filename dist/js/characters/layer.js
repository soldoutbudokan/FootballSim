// The athletes layer the scene constructs: synchronous, with the Athletes
// interface (plan 3.5), and safe from the first frame.
//
//   new AthletesLayer(scene, players, { Athletes, camera, quality, search })
//
// It shows an interim layer at once (the procedural Athletes when its class
// is handed over, else placeholder capsules), decides from the URL and a HEAD
// request for ./models/player.glb whether a skinned model is wanted (see
// choose.js), loads it in the background and swaps it in. A failed load keeps
// (or falls back to) the procedural athletes. The skinned pipeline and its
// loaders are imported only when a model is actually loaded, so the
// procedural game downloads nothing extra.
import { PlaceholderAthletes, controlledPlayer, removeLayer } from './placeholders.js';
import { athletesChoice, needsProbe, modelPublished } from './choose.js';

// The release build appends ?v=<hash> to static imports; carry it over to the
// dynamic one so the pipeline is cache-busted with the rest of the release.
const VERSION = (() => { try { return new URL(import.meta.url).search; } catch { return ''; } })();
const loadPipeline = () => import('./index.js' + VERSION);

export class AthletesLayer {
  // options:
  //   Athletes   the procedural layer's class (interim and fallback)
  //   camera     the scene camera (mesh level of detail by distance)
  //   quality    the graphics profile to start with
  //   search     URL query, default location.search
  //   fetch      fetch implementation for the model probe
  //   skinned    extra createSkinnedAthletes options (palette, clipUrls, ...)
  constructor(scene, players, options = {}) {
    this.scene = scene;
    this.players = players;
    this.options = options;
    this.profile = options.quality;
    this.kind = 'interim';
    this.status = 'choosing';
    this.error = null;
    this.active = this.makeFallback() || new PlaceholderAthletes(scene, players);
    if (this.active instanceof PlaceholderAthletes) this.kind = 'placeholders';
    else this.kind = 'procedural';
    if (this.profile) this.active.setQuality(this.profile);
    this.ready = this.choose().catch(error => this.fail(error));
  }

  makeFallback() {
    const { Athletes } = this.options;
    if (typeof Athletes !== 'function') return null;
    try { return new Athletes(this.scene, this.players); } catch (error) { console.warn('Procedural athletes unavailable: ' + (error?.message || error)); return null; }
  }

  async choose() {
    const search = this.options.search ?? (globalThis.location?.search || '');
    const published = needsProbe(search) ? await modelPublished(undefined, this.options.fetch) : false;
    const choice = athletesChoice(search, published);
    this.choice = choice;
    if (choice.kind !== 'skinned') {
      this.status = 'procedural';
      if (this.kind === 'placeholders') this.fail(new Error('no procedural layer was provided'));
      return null;
    }
    this.status = 'loading';
    const { createSkinnedAthletes } = await loadPipeline();
    const layer = await createSkinnedAthletes(this.scene, this.players, {
      modelUrl: choice.modelUrl, dev: choice.dev, quality: this.profile, camera: this.options.camera, ...(this.options.skinned || {}),
    });
    this.swap(layer, 'skinned');
    this.status = 'ready';
    return layer;
  }

  // A failed load: keep the procedural layer, or build it now.
  fail(error) {
    this.error = error;
    this.status = 'failed';
    console.warn('Skinned athletes unavailable, using ' + (this.kind === 'procedural' ? 'the procedural athletes' : 'placeholders') + ': ' + (error?.message || error));
    if (this.kind === 'placeholders') {
      const fallback = this.makeFallback();
      if (fallback) this.swap(fallback, 'procedural');
    }
    return null;
  }

  swap(layer, kind) {
    removeLayer(this.active);
    this.active = layer;
    this.kind = kind;
    if (this.profile) layer.setQuality(this.profile);
  }

  // Pass-throughs used by debugging and the dev harness.
  get ball() { return this.active.ball; }
  get ring() { return this.active.ring; }
  get contactShadows() { return this.active.contactShadows; }
  get rigs() { return this.active.rigs; }

  setQuality(profile) {
    this.profile = profile;
    this.active.setQuality(profile);
  }

  // Never throws: a broken frame still returns the controlled player and
  // leaves world matrices consistent for the render that follows.
  update(state, dt, options) {
    try {
      return this.active.update(state, dt, options);
    } catch (error) {
      if (!this.reported) { console.warn('Athletes update failed: ' + (error?.stack || error)); this.reported = true; }
      try { this.scene.updateMatrixWorld(true); } catch { /* nothing more to do */ }
      return controlledPlayer(state) || { id: null, x: 0, z: 0, vx: 0, vz: 0, facing: 0 };
    }
  }

  dispose() { removeLayer(this.active); }
}
