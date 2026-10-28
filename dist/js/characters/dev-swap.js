// Development harness: swaps the running game's athletes layer for the
// skinned one at runtime, without touching scene.js. Use from the console or
// Playwright on a page opened with ?debug=1:
//
//   const { swapAthletes } = await import('./js/characters/dev-swap.js');
//   await swapAthletes();                                   // ./dev/Xbot.glb stand-in
//   await swapAthletes({ modelUrl: './dev/test/Soldier.glb', dev: true,
//                        clipUrls: { catch: './dev/clips/catch.fbx' } });
//   await swapAthletes({ index: './models/index.json' });   // the published model
//
// The stand-in lives in dist/dev/ (ignored by version control and excluded
// from releases), so the default only works in a development checkout after
// `node scripts/vendor.mjs`.
import { createSkinnedAthletes } from './index.js';
import { removeLayer } from './placeholders.js';
import { DEV_CHARACTER_URL } from './choose.js';

export const DEV_MODEL_URL = DEV_CHARACTER_URL;
export { removeLayer };

export async function swapAthletes(options = {}, handle = window.footballsim) {
  if (!handle?.view) throw new Error('Open the game with ?debug=1 first');
  const view = handle.view;
  const settings = options.modelUrl || options.index ? options : { modelUrl: DEV_MODEL_URL, dev: true, ...options };
  const next = await createSkinnedAthletes(view.scene, handle.sim.players, { quality: view.profile, camera: view.camera, ...settings });
  const current = view.athletes;
  if (current && typeof current.swap === 'function') {
    current.swap(next, 'skinned'); // an AthletesLayer: keep the wrapper
  } else {
    removeLayer(current);
    view.athletes = next;
    next.setQuality(view.profile);
  }
  return next;
}
