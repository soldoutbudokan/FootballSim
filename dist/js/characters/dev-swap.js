// Development harness: swaps the running game's athletes layer for the
// skinned one at runtime, without touching scene.js. Use from the console or
// Playwright on a page opened with ?debug=1:
//
//   const { swapAthletes } = await import('./js/characters/dev-swap.js');
//   await swapAthletes();                                  // ./dev/Xbot.glb stand-in
//   await swapAthletes({ index: './models/index.json' });  // the real model
//
// The stand-in lives in dist/dev/ (git-ignored, excluded from releases), so
// this path only works in a development checkout after `node scripts/vendor.mjs`.
import { createSkinnedAthletes } from './index.js';

export const DEV_MODEL_URL = './dev/Xbot.glb';

// Removes whatever the previous layer put in the scene.
export function removeLayer(scene, layer) {
  if (!layer) return;
  if (typeof layer.dispose === 'function') { layer.dispose(); return; }
  // The procedural Athletes: rigs, an instanced RigBatch, ball, ring, shadows.
  layer.rigs?.forEach(r => (r.root || r)?.removeFromParent?.());
  layer.batch?.batches?.forEach(b => b.mesh?.removeFromParent());
  for (const key of ['ball', 'ring', 'contactShadows', 'group']) layer[key]?.removeFromParent?.();
}

export async function swapAthletes(options = {}, handle = window.footballsim) {
  if (!handle?.view) throw new Error('Open the game with ?debug=1 first');
  const view = handle.view;
  const settings = options.modelUrl || options.index ? options : { modelUrl: DEV_MODEL_URL, dev: true, ...options };
  const next = await createSkinnedAthletes(view.scene, handle.sim.players, { quality: view.profile, camera: view.camera, ...settings });
  const previous = view.athletes;
  removeLayer(view.scene, previous);
  view.athletes = next;
  next.setQuality(view.profile);
  return next;
}
