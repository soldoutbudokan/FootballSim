// A loaded, normalised character: the model fitted into character space, its
// rest pose, and every clip converted onto its skeleton and measured once
// (gait cadence and speed, throw release, catch contact, fall settle time).
// Instances for the 22 players are cloned from this.
import * as THREE from '../../vendor/three.module.js';
import * as SkeletonUtils from '../../vendor/SkeletonUtils.js';
import { REQUIRED_BONES } from './bones.js';
import { assignSlots, slotForClipName, LOOPING_SLOTS, UPPER_BODY_SLOTS, CLIP_SLOTS } from './clips.js';
import { analyseGait } from './gait.js';
import { loadCharacterFile, describeRig, restVertices, normalise, legMetrics, captureRest, jointPositions } from './rig.js';
import { convertClip, stripRootMotion, maskClip } from './retarget.js';
import { clusterVertices, remapTriangles, gather } from './lod.js';

const GAIT_SLOTS = new Set(['walk', 'jog', 'run', 'sprint', 'backpedal', 'shuffle-left', 'shuffle-right']);

// clipUrls: {slot: url} or [url, ...] (slot from the file name).
function clipList(clipUrls) {
  if (!clipUrls) return [];
  if (Array.isArray(clipUrls)) return clipUrls.map(url => ({ slot: slotForClipName(url), url })).filter(e => e.slot);
  return Object.entries(clipUrls).filter(([slot, url]) => CLIP_SLOTS.includes(slot) && url).map(([slot, url]) => ({ slot, url }));
}

// The clip in a clip file: one named like the slot, else the longest.
function pickAnimation(animations, slot) {
  if (!animations.length) return null;
  return animations.find(a => slotForClipName(a.name) === slot)
    || [...animations].sort((a, b) => b.duration - a.duration)[0];
}

export async function loadCharacterAsset({ modelUrl, clipUrls, manager, clipAliases = {}, log = () => {} }) {
  const file = await loadCharacterFile(modelUrl, manager);
  const rig = describeRig(file.scene);
  if (!rig.meshes.length) throw new Error(`${modelUrl}: no skinned mesh found`);
  if (!rig.mapping.ok) {
    const missing = REQUIRED_BONES.filter(b => !rig.mapping.map[b]);
    throw new Error(`${modelUrl}: rig is missing bones ${missing.join(', ')}`);
  }
  const worldVertices = restVertices(rig);
  const { fit, scale } = normalise(rig, { vertices: worldVertices });
  rig.fitRoot = fit;
  rig.rest = captureRest(rig.bones);
  const legs = legMetrics(rig);

  // Character-space rest vertices (the fit was applied after measuring).
  const vertices = new Map();
  const v = new THREE.Vector3();
  for (const [mesh, data] of worldVertices) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 3) { v.fromArray(data, i).applyMatrix4(fit.matrixWorld).toArray(out, i); }
    vertices.set(mesh, out);
  }

  // Clips: those inside the model, then separate files (which win).
  const entries = file.animations.map(clip => ({ name: clip.name, source: 'model', clip, rig }));
  const files = await Promise.all(clipList(clipUrls).map(async ({ slot, url }) => {
    try {
      const f = await loadCharacterFile(url, manager);
      const clip = pickAnimation(f.animations, slot);
      if (!clip) { log(`${url}: no animation in file`); return null; }
      const source = describeRig(f.scene);
      if (!source.canon.Hips || !source.canon.Head || !source.canon.LeftUpLeg || !source.canon.RightUpLeg) {
        log(`${url}: cannot map the clip's skeleton (missing hips, head or legs)`); return null;
      }
      source.fitRoot = normalise(source, { legs }).fit;
      return { name: clip.name, fileName: slot, source: 'file', clip, rig: source, url };
    } catch (error) {
      log(`${url}: ${error.message || error}`); return null;
    }
  }));
  entries.push(...files.filter(Boolean));
  const assigned = assignSlots(entries, clipAliases);

  const probe = makeProbe(rig);
  const restHips = rig.canon.Hips.position.clone();
  const upperNames = subtreeNames(rig.canon.Spine);
  const clips = {};
  for (const [slot, entry] of Object.entries(assigned)) {
    const { clip, method } = convertClip(entry.clip, rig, entry.rig, { embedded: entry.source === 'model' });
    if (!clip.tracks.length) { log(`clip ${entry.name} (${slot}): no tracks match the model's bones`); continue; }
    clip.name = slot;
    const info = { slot, clip, method, loop: LOOPING_SLOTS.has(slot), duration: clip.duration, source: entry.url || 'model' };
    if (GAIT_SLOTS.has(slot)) info.gait = measureGait(probe, clip, slot.startsWith('shuffle') ? 'x' : 'z');
    stripRootMotion(clip, rig, restHips);
    if (slot === 'throw') info.release = measureRelease(probe, clip);
    if (slot === 'catch') info.contact = measureContact(probe, clip);
    if (slot === 'fall' || slot === 'tackle') info.settle = measureSettle(probe, clip);
    if (UPPER_BODY_SLOTS.has(slot)) info.upper = maskClip(clip, upperNames);
    clips[slot] = info;
  }
  probe.dispose();
  return {
    url: modelUrl, rig, fit, scale, legs, vertices, clips,
    lods: buildLods(rig, vertices),
    joints: Object.fromEntries(Object.entries(jointPositions(rig)).map(([k, p]) => [k, p.toArray()])),
    available: new Set(Object.keys(clips)),
  };
}

// A reduced copy of every skinned mesh for distant players (see lod.js).
// Map: source geometry uuid -> {geometry, source (new vertex -> old)}.
export const LOD_CELL = 0.034; // yards (~1.2 in) on a 2.06 yd athlete
function buildLods(rig, vertices) {
  const out = new Map();
  for (const mesh of rig.meshes) {
    const g = mesh.geometry;
    const positions = vertices.get(mesh);
    const index = g.index ? g.index.array : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
    const groups = g.groups.length ? g.groups : [{ start: 0, count: index.length, materialIndex: 0 }];
    // Small parts (a face, a hand) collapse quickly: refine the grid until
    // at least a fifth of the triangles survive.
    let cell = LOD_CELL, rep, source, triangles, ranges;
    for (let attempt = 0; attempt < 4; attempt++, cell *= 0.65) {
      ({ rep, source } = clusterVertices(positions, cell));
      triangles = []; ranges = [];
      for (const group of groups) {
        const tris = remapTriangles(index, rep, group.start, group.count);
        ranges.push([triangles.length, tris.length, group.materialIndex]);
        for (const t of tris) triangles.push(t);
      }
      if (triangles.length >= index.length * 0.2 || index.length < 900) break;
    }
    const lod = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(g.attributes)) lod.setAttribute(name, copyAttribute(attribute, source));
    if (g.groups.length) for (const [start, count, materialIndex] of ranges) lod.addGroup(start, count, materialIndex);
    lod.setIndex(triangles);
    lod.computeBoundingSphere();
    lod.name = (g.name || mesh.name) + ':lod1';
    out.set(g.uuid, { geometry: lod, source, triangles: triangles.length / 3, original: index.length / 3 });
  }
  return out;
}

function copyAttribute(attribute, source) {
  const n = attribute.itemSize;
  const array = attribute.isInterleavedBufferAttribute
    ? gather(attribute.data.array, n, source, attribute.data.stride, attribute.offset)
    : gather(attribute.array, n, source);
  return new THREE.BufferAttribute(array, n, attribute.normalized);
}

function subtreeNames(root) {
  const out = [];
  root?.traverse(o => out.push(o.name));
  return out;
}

// A private clone used to sample clips in character space.
function makeProbe(rig) {
  const root = SkeletonUtils.clone(rig.fitRoot);
  const mixer = new THREE.AnimationMixer(root);
  const bone = {};
  for (const [c, b] of Object.entries(rig.canon)) bone[c] = root.getObjectByName(b.name);
  const p = new THREE.Vector3();
  return {
    // Calls fn(time, position(canonical) -> Vector3 copy) at n evenly spaced times.
    sample(clip, n, fn) {
      const action = mixer.clipAction(clip);
      action.reset().play();
      action.setEffectiveWeight(1);
      for (let i = 0; i < n; i++) {
        const t = (clip.duration * i) / n;
        action.time = t;
        mixer.update(0);
        root.updateMatrixWorld(true);
        fn(t, c => (bone[c] ? bone[c].getWorldPosition(p).clone() : null));
      }
      action.stop();
      mixer.uncacheAction(clip);
    },
    dispose() { mixer.stopAllAction(); },
  };
}

function measureGait(probe, clip, axis) {
  const n = 64;
  const s = { times: [], leftY: [], leftZ: [], rightY: [], rightZ: [], hipsZ: [] };
  probe.sample(clip, n, (t, at) => {
    const l = at('LeftFoot'), r = at('RightFoot'), h = at('Hips');
    s.times.push(t);
    s.leftY.push(l.y); s.rightY.push(r.y);
    s.leftZ.push(l[axis]); s.rightZ.push(r[axis]); s.hipsZ.push(h[axis]);
  });
  return analyseGait(s, clip.duration);
}

// Throw release: the right hand's fastest forward motion relative to the hips.
function measureRelease(probe, clip) {
  const n = 60, z = [];
  probe.sample(clip, n, (t, at) => z.push(at('RightHand').z - at('Hips').z));
  let best = 1, speed = -Infinity;
  for (let i = 1; i < n - 1; i++) { const v = z[i + 1] - z[i - 1]; if (v > speed) { speed = v; best = i; } }
  return (best / n) * clip.duration;
}

// Catch contact: hands highest and furthest forward together.
function measureContact(probe, clip) {
  const n = 60;
  let best = 0, score = -Infinity;
  probe.sample(clip, n, (t, at) => {
    const l = at('LeftHand'), r = at('RightHand'), h = at('Hips');
    const s = (l.y + r.y) * 0.5 + (l.z + r.z) * 0.5 - h.z - l.distanceTo(r) * 0.5;
    if (s > score) { score = s; best = t; }
  });
  return best;
}

// When a fall reaches the ground: the hips' lowest point.
function measureSettle(probe, clip) {
  const n = 60;
  let best = clip.duration, low = Infinity;
  probe.sample(clip, n, (t, at) => { const y = at('Hips').y; if (y < low - 0.01) { low = y; best = t; } });
  return best;
}
