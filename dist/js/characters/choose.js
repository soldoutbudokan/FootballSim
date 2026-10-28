// Which athletes layer the scene builds. Pure (no renderer), unit-tested.
//
//   ?athletes=procedural   the built-in procedural athletes, always
//   ?athletes=skinned      the skinned layer from ./models/player.glb
//   ?athletes=dev          the skinned layer from the development stand-in
//   (none) or auto         skinned when the model is published, else
//                          procedural
//
// The model is ./models/player.glb unless ./models/index.json (committed with
// the game) names another file (player.fbx); the index also lists separate
// clip files. A failed skinned load always falls back to the procedural
// athletes.
import { resolveModelIndex } from './clips.js';

export const CHARACTER_MODEL_URL = './models/player.glb';
export const CHARACTER_INDEX_URL = './models/index.json';
export const DEV_CHARACTER_URL = './dev/Xbot.glb';

// The `athletes` URL parameter, normalised; unknown values mean auto.
export function athletesParam(search = '') {
  let value = null;
  try { value = new URLSearchParams(search).get('athletes'); } catch { value = null; }
  value = String(value || 'auto').toLowerCase();
  return ['procedural', 'skinned', 'dev', 'auto'].includes(value) ? value : 'auto';
}

// Does the decision need to know whether a model is published?
export function needsProbe(search = '') {
  return athletesParam(search) === 'auto';
}

// -> {kind: 'procedural'} or {kind: 'skinned', modelUrl, dev}
export function athletesChoice(search = '', modelPublished = false, modelUrl = CHARACTER_MODEL_URL) {
  const param = athletesParam(search);
  if (param === 'procedural') return { kind: 'procedural' };
  if (param === 'dev') return { kind: 'skinned', modelUrl: DEV_CHARACTER_URL, dev: true };
  if (param === 'skinned' || modelPublished) return { kind: 'skinned', modelUrl, dev: false };
  return { kind: 'procedural' };
}

// The committed model index -> {modelUrl, clipUrls}, or null without one.
export async function readModelIndex(url = CHARACTER_INDEX_URL, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response?.ok) return null;
    return resolveModelIndex(await response.json(), url.slice(0, url.lastIndexOf('/') + 1));
  } catch {
    return null;
  }
}

// HEAD request for the published model. Any failure means "not published".
export async function modelPublished(url = CHARACTER_MODEL_URL, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return false;
  try {
    const response = await fetchImpl(url, { method: 'HEAD', cache: 'no-cache' });
    return !!response && response.ok;
  } catch {
    return false;
  }
}
