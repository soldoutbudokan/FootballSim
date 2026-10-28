// Public entry points of the skinned-character pipeline.
//
//   createSkinnedAthletes(scene, players, options) -> Promise<SkinnedAthletes>
//   loadModelIndex(url)                             reads dist/models/index.json
//
// The scene does not import this module directly: layer.js (AthletesLayer,
// the synchronous wrapper with placeholders and the procedural fallback)
// imports it on demand, so the loaders are only downloaded when a model is.
//
// options:
//   modelUrl     './models/player.glb' (GLB/glTF or FBX, rigged, T-pose)
//   clipUrls     {slot: url} or [url, ...] (slot from the file name)
//   index        URL of a models index.json listing the model and clip files
//   palette      {offense: {...}, defense: {...}, qb: {...}} colour overrides
//   quality      a graphics.js PROFILES entry
//   clipAliases  {slot: 'clip name inside the model file'}
//   manager      THREE.LoadingManager
//   dev          true when loading the development stand-in (./dev/Xbot.glb)
import { loadCharacterAsset } from './asset.js';
import { SkinnedAthletes } from './athletes.js';
import { resolveModelIndex } from './clips.js';
import { CHARACTER_INDEX_URL } from './choose.js';

export { SkinnedAthletes };
export { AthletesLayer } from './layer.js';
export { PlaceholderAthletes } from './placeholders.js';
export const MODEL_INDEX_URL = CHARACTER_INDEX_URL;

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
  if (options.index) {
    // The index names the model and any separate clip files; an explicit
    // modelUrl / clipUrls wins over it.
    const index = await loadModelIndex(options.index);
    if (index) { modelUrl ||= index.modelUrl; clipUrls ||= index.clipUrls; }
    else if (!modelUrl) throw new Error(`No character model listed in ${options.index}`);
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
