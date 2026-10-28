// Bone-name mapping for humanoid rigs. Pure functions with no renderer
// dependency so they can be unit-tested in Node.
//
// Everything in the character layer talks about bones by CANONICAL names,
// which are Mixamo's names without the "mixamorig:" prefix. A model's own
// names are mapped onto these by, in order of trust:
//   1. exact canonical names after stripping rig prefixes (Mixamo, Ready Player Me),
//   2. a table of aliases used by common rigs (Unreal, Unity/VRM, Rigify,
//      3ds Max Biped, DAZ, Character Creator),
//   3. token rules ("upper arm" + left side -> LeftArm),
//   4. name similarity, accepted only when the side matches.
// The spine is then resolved from the hierarchy (the bones between the hips
// and the neck) because rigs disagree about how many spine bones they have.

export const CANONICAL_BONES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
];

// Without these the animation layer cannot pose a body.
export const REQUIRED_BONES = [
  'Hips', 'Spine', 'Head',
  'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot',
];

// The canonical parent of each bone; used to validate guesses.
export const CANONICAL_PARENT = {
  Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
};

// Bones above the hips; an "upper body" clip mask keeps only these (plus
// fingers and anything else parented under them).
export const UPPER_BODY_BONES = [
  'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
];

// The Mixamo map: Mixamo's exported names (with the namespace three.js keeps
// after sanitising "mixamorig:Hips" to "mixamorigHips") -> canonical.
export const MIXAMO_MAP = Object.fromEntries(
  CANONICAL_BONES.flatMap(name => [['mixamorig:' + name, name], ['mixamorig' + name, name]]),
);

// A generic humanoid map: aliases used by other common rigs. Keys are
// normalised (lowercase letters and digits only).
const ALIASES = {
  Hips: ['hips', 'hip', 'pelvis', 'bip01pelvis', 'bippelvis', 'ccbasehip', 'ccbasepelvis', 'jbipchips', 'defhips', 'root_hips'],
  Spine: ['spine01', 'spine', 'abdomen', 'abdomenlower', 'bip01spine', 'jbipcspine', 'ccbasewaist', 'waist', 'lowerback', 'torso1'],
  Spine1: ['spine02', 'chest', 'abdomenupper', 'bip01spine1', 'jbipcchest', 'ccbasespine01', 'spine1'],
  Spine2: ['spine03', 'upperchest', 'chestupper', 'bip01spine2', 'jbipcupperchest', 'ccbasespine02', 'spine2', 'torso'],
  Neck: ['neck', 'neck01', 'necklower', 'bip01neck', 'jbipcneck', 'ccbasenecktwist01'],
  Head: ['head', 'bip01head', 'jbipchead', 'ccbasehead'],
  LeftShoulder: ['claviclel', 'lclavicle', 'lcollar', 'leftcollar', 'shoulderl', 'bip01lclavicle', 'jbiplshoulder', 'ccbaselclavicle'],
  LeftArm: ['upperarml', 'luparm', 'lupperarm', 'lshldr', 'lshldrbend', 'leftupperarm', 'bip01lupperarm', 'jbiplupperarm', 'ccbaselupperarm', 'arml'],
  LeftForeArm: ['lowerarml', 'forearml', 'lforearm', 'lforearmbend', 'leftlowerarm', 'leftelbow', 'bip01lforearm', 'jbipllowerarm', 'ccbaselforearm'],
  LeftHand: ['handl', 'lhand', 'leftwrist', 'bip01lhand', 'jbiplhand', 'ccbaselhand'],
  RightShoulder: ['clavicler', 'rclavicle', 'rcollar', 'rightcollar', 'shoulderr', 'bip01rclavicle', 'jbiprshoulder', 'ccbaserclavicle'],
  RightArm: ['upperarmr', 'ruparm', 'rupperarm', 'rshldr', 'rshldrbend', 'rightupperarm', 'bip01rupperarm', 'jbiprupperarm', 'ccbaserupperarm', 'armr'],
  RightForeArm: ['lowerarmr', 'forearmr', 'rforearm', 'rforearmbend', 'rightlowerarm', 'rightelbow', 'bip01rforearm', 'jbiprlowerarm', 'ccbaserforearm'],
  RightHand: ['handr', 'rhand', 'rightwrist', 'bip01rhand', 'jbiprhand', 'ccbaserhand'],
  LeftUpLeg: ['thighl', 'lthigh', 'lthighbend', 'leftupperleg', 'lefthip', 'upperlegl', 'bip01lthigh', 'jbiplupperleg', 'ccbaselthigh'],
  LeftLeg: ['calfl', 'shinl', 'lshin', 'lcalf', 'leftlowerleg', 'leftknee', 'lowerlegl', 'bip01lcalf', 'jbipllowerleg', 'ccbaselcalf'],
  LeftFoot: ['footl', 'lfoot', 'leftankle', 'bip01lfoot', 'jbiplfoot', 'ccbaselfoot'],
  LeftToeBase: ['balll', 'toel', 'ltoe', 'lefttoe', 'lefttoes', 'toesl', 'bip01ltoe0', 'jbipltoebase', 'ccbaseltoebase'],
  RightUpLeg: ['thighr', 'rthigh', 'rthighbend', 'rightupperleg', 'righthip', 'upperlegr', 'bip01rthigh', 'jbiprupperleg', 'ccbaserthigh'],
  RightLeg: ['calfr', 'shinr', 'rshin', 'rcalf', 'rightlowerleg', 'rightknee', 'lowerlegr', 'bip01rcalf', 'jbiprlowerleg', 'ccbasercalf'],
  RightFoot: ['footr', 'rfoot', 'rightankle', 'bip01rfoot', 'jbiprfoot', 'ccbaserfoot'],
  RightToeBase: ['ballr', 'toer', 'rtoe', 'righttoe', 'righttoes', 'toesr', 'bip01rtoe0', 'jbiprtoebase', 'ccbasertoebase'],
};
export const HUMANOID_ALIASES = ALIASES;

const ALIAS_LOOKUP = new Map();
for (const [canonical, list] of Object.entries(ALIASES)) {
  for (const alias of list) if (!ALIAS_LOOKUP.has(alias)) ALIAS_LOOKUP.set(alias, canonical);
}

const normalise = text => text.toLowerCase().replace(/[^a-z0-9]/g, '');

// "mixamorig:LeftArm", "mixamorigLeftArm", "mixamorig1_LeftArm",
// "Armature|LeftArm" and Maya namespaces like "rig:LeftArm" -> "LeftArm".
export function stripRigPrefix(name) {
  let out = String(name || '');
  const cut = Math.max(out.lastIndexOf(':'), out.lastIndexOf('|'));
  if (cut >= 0 && cut < out.length - 1) out = out.slice(cut + 1);
  out = out.replace(/^mixamorig\d*_?/i, '');
  return out;
}

// Splits a bone name into lowercase words: camelCase, digits and separators.
export function tokenize(name) {
  return stripRigPrefix(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const FINGER = /^(thumb|index|middle|ring|pinky|pinkie|finger|fingers|palm\d*|metacarpal|carpal)$/;
const END = /^(end|top|nub|tip|twist|roll|ik|pole|target|ctrl|control|helper|socket|weapon|prop|jaw|eye|eyes)$/;

// Returns {side: 'Left'|'Right'|null, words} with the side words removed.
export function sideOf(tokens) {
  let side = null;
  const words = [];
  for (const t of tokens) {
    if (t === 'l' || t === 'left' || t === 'lft') side = side || 'Left';
    else if (t === 'r' || t === 'right' || t === 'rgt') side = side || 'Right';
    else if (/^l[a-z]{3,}$/.test(t) && PART_WORDS.has(t.slice(1))) { side = side || 'Left'; words.push(t.slice(1)); }
    else if (/^r[a-z]{3,}$/.test(t) && PART_WORDS.has(t.slice(1))) { side = side || 'Right'; words.push(t.slice(1)); }
    else words.push(t);
  }
  return { side, words };
}

// Words that name a body part; used to recognise DAZ-style "lShldr" tokens.
const PART_WORDS = new Set(['shldr', 'shoulder', 'collar', 'clavicle', 'arm', 'forearm', 'hand', 'thigh', 'shin', 'calf', 'foot', 'toe', 'hip', 'knee', 'elbow', 'wrist', 'ankle', 'uparm', 'loarm', 'upleg', 'leg']);

// Token rules: which body part a set of words describes.
function partOf(words, side) {
  const joined = words.join('');
  const has = w => words.includes(w);
  if (words.some(w => FINGER.test(w)) || words.some(w => END.test(w))) return null;
  if (side) {
    if (has('clavicle') || has('collar') || (has('shoulder') && !has('upper'))) return 'Shoulder';
    if (/upperarm|uparm|shldr|humerus/.test(joined) || (has('arm') && (has('upper') || words.length === 1))) return 'Arm';
    if (/forearm|lowerarm|loarm|elbow|radius|ulna/.test(joined)) return 'ForeArm';
    if (has('hand') || has('wrist')) return 'Hand';
    if (/upleg|upperleg|thigh|femur/.test(joined) || has('hip')) return 'UpLeg';
    if (/lowerleg|loleg|calf|shin|knee|tibia/.test(joined) || (has('leg') && words.length === 1)) return 'Leg';
    if (has('foot') || has('ankle')) return 'Foot';
    if (has('toe') || has('toes') || has('toebase') || has('ball')) return 'ToeBase';
    return null;
  }
  if (has('hips') || has('pelvis') || (has('hip') && words.length <= 2)) return 'Hips';
  if (has('neck')) return 'Neck';
  if (has('head')) return 'Head';
  if (has('spine') || has('chest') || has('abdomen') || has('torso') || has('waist')) return 'Spine';
  return null;
}

// Rule-based classification of a single name, or null.
export function classifyBone(name) {
  const stripped = stripRigPrefix(name);
  const direct = CANONICAL_BONES.find(c => c.toLowerCase() === stripped.toLowerCase());
  if (direct) return direct;
  const alias = ALIAS_LOOKUP.get(normalise(stripped));
  if (alias) return alias;
  const { side, words } = sideOf(tokenize(name));
  const part = partOf(words, side);
  if (!part) return null;
  return side ? side + part : part;
}

// Dice coefficient on character bigrams, 0..1.
export function similarity(a, b) {
  const grams = s => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) || 0) + 1);
    return out;
  };
  const x = normalise(a), y = normalise(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const gx = grams(x), gy = grams(y);
  let shared = 0;
  for (const [g, n] of gx) shared += Math.min(n, gy.get(g) || 0);
  return (2 * shared) / (x.length - 1 + y.length - 1);
}

const sideOfCanonical = c => (c.startsWith('Left') ? 'Left' : c.startsWith('Right') ? 'Right' : null);

// Best canonical name for a bone by similarity, requiring the same side.
function similarBone(name, threshold) {
  const { side } = sideOf(tokenize(name));
  if (tokenize(name).some(w => FINGER.test(w) || END.test(w))) return null;
  let best = null, score = threshold;
  for (const canonical of CANONICAL_BONES) {
    if (sideOfCanonical(canonical) !== side) continue;
    for (const candidate of [canonical, ...ALIASES[canonical]]) {
      const s = similarity(stripRigPrefix(name), candidate);
      if (s > score) { score = s; best = canonical; }
    }
  }
  return best;
}

const PRIORITY = { exact: 4, alias: 3, rule: 2, similar: 1, chain: 5, inferred: 0 };

// Maps a skeleton onto canonical names.
//   bones: [{name, parent}] where parent is the index of the parent bone or -1.
// Returns {map: {canonical: boneName}, how: {canonical: method}, missing: [...],
//          ok: all required bones present}.
export function mapSkeleton(bones, { similarityThreshold = 0.72 } = {}) {
  const list = bones.map((b, i) => ({ name: b.name, parent: b.parent ?? -1, index: i }));
  const depth = i => { let d = 0; for (let p = list[i].parent; p >= 0 && d < 512; p = list[p].parent) d++; return d; };
  const found = new Map(); // canonical -> {index, method}

  const offer = (canonical, index, method) => {
    const current = found.get(canonical);
    const better = !current
      || PRIORITY[method] > PRIORITY[current.method]
      || (PRIORITY[method] === PRIORITY[current.method] && depth(index) < depth(current.index));
    if (better) found.set(canonical, { index, method });
  };

  for (const bone of list) {
    const stripped = stripRigPrefix(bone.name);
    const direct = CANONICAL_BONES.find(c => c.toLowerCase() === stripped.toLowerCase());
    if (direct) { offer(direct, bone.index, 'exact'); continue; }
    const alias = ALIAS_LOOKUP.get(normalise(stripped));
    if (alias) { offer(alias, bone.index, 'alias'); continue; }
    const rule = classifyBone(bone.name);
    if (rule && CANONICAL_BONES.includes(rule)) { offer(rule, bone.index, 'rule'); continue; }
    const similar = similarBone(bone.name, similarityThreshold);
    if (similar) offer(similar, bone.index, 'similar');
  }

  resolveSpine(list, found);
  inferShoulders(list, found);
  validateHierarchy(list, found);

  const map = {}, how = {};
  for (const canonical of CANONICAL_BONES) {
    const hit = found.get(canonical);
    if (hit) { map[canonical] = list[hit.index].name; how[canonical] = hit.method; }
  }
  const missing = CANONICAL_BONES.filter(c => !map[c]);
  return { map, how, missing, ok: REQUIRED_BONES.every(c => map[c]) };
}

function ancestors(list, index) {
  const out = [];
  for (let p = list[index].parent; p >= 0 && out.length < 512; p = list[p].parent) out.push(p);
  return out;
}

// Spine bones are whatever lies between the hips and the neck (or head).
function resolveSpine(list, found) {
  const hips = found.get('Hips'), top = found.get('Neck') || found.get('Head');
  if (!hips || !top) return;
  const chain = ancestors(list, top.index);
  const at = chain.indexOf(hips.index);
  if (at < 0) return;
  // ancestors are listed upward; the spine runs from the hips' child upward.
  let spine = chain.slice(0, at).reverse();
  if (!found.get('Neck')) {
    // Without a neck the bone just under the head may be the neck.
    const last = spine[spine.length - 1];
    if (last !== undefined && /neck/i.test(list[last].name)) { found.set('Neck', { index: last, method: 'chain' }); spine = spine.slice(0, -1); }
  } else if (spine.length && /neck/i.test(list[spine[spine.length - 1]].name)) {
    spine = spine.slice(0, -1); // a second neck bone ("neckLower") is not spine
  }
  if (!spine.length) return;
  const exact = ['Spine', 'Spine1', 'Spine2'].every(c => found.get(c)?.method === 'exact');
  if (exact) return; // Mixamo-named rigs are already right
  for (const c of ['Spine', 'Spine1', 'Spine2']) found.delete(c);
  found.set('Spine', { index: spine[0], method: 'chain' });
  if (spine.length >= 2) found.set('Spine2', { index: spine[spine.length - 1], method: 'chain' });
  if (spine.length >= 3) found.set('Spine1', { index: spine[Math.floor(spine.length / 2)], method: 'chain' });
}

// A clavicle that is named oddly is still the arm's parent below the chest.
function inferShoulders(list, found) {
  const spineTop = found.get('Spine2') || found.get('Spine1') || found.get('Spine');
  for (const side of ['Left', 'Right']) {
    if (found.get(side + 'Shoulder')) continue;
    const arm = found.get(side + 'Arm');
    if (!arm) continue;
    const parent = list[arm.index].parent;
    const spineBones = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck'].map(c => found.get(c)?.index);
    if (parent >= 0 && !spineBones.includes(parent) && (!spineTop || ancestors(list, parent).includes(spineTop.index))) {
      found.set(side + 'Shoulder', { index: parent, method: 'inferred' });
    }
  }
}

// Drops guesses that contradict the hierarchy (a forearm must hang below the
// upper arm, a foot below the shin, ...). Exact names are always trusted.
// Only limb chains are checked: some rigs hang the legs off a "Body" bone
// next to the hips, which is fine for animation.
const CHAIN_CHECKED = new Set(['LeftForeArm', 'LeftHand', 'RightForeArm', 'RightHand', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightLeg', 'RightFoot', 'RightToeBase']);
function validateHierarchy(list, found) {
  for (const [canonical, hit] of [...found]) {
    if (hit.method === 'exact' || !CHAIN_CHECKED.has(canonical)) continue;
    const parentCanonical = CANONICAL_PARENT[canonical];
    const parentHit = parentCanonical && (found.get(parentCanonical) || found.get(CANONICAL_PARENT[parentCanonical]));
    if (!parentHit) continue;
    if (!ancestors(list, hit.index).includes(parentHit.index)) found.delete(canonical);
  }
}

// retargetClip wants {targetBoneName: sourceBoneName}.
export function retargetNames(targetMap, sourceMap) {
  const names = {};
  for (const canonical of CANONICAL_BONES) {
    if (targetMap[canonical] && sourceMap[canonical]) names[targetMap[canonical]] = sourceMap[canonical];
  }
  return names;
}

// For two rigs that share a naming scheme (any Mixamo characters), tracks can
// simply be renamed. Matches every bone, fingers included, by stripped name,
// falling back to the canonical map.
export function renameMap(targetNames, sourceNames, targetMap = {}, sourceMap = {}) {
  const byStripped = new Map(targetNames.map(n => [stripRigPrefix(n).toLowerCase(), n]));
  const canonicalOfSource = new Map(Object.entries(sourceMap).map(([c, n]) => [n, c]));
  const out = {};
  for (const source of sourceNames) {
    const direct = byStripped.get(stripRigPrefix(source).toLowerCase());
    if (direct) { out[source] = direct; continue; }
    const canonical = canonicalOfSource.get(source);
    if (canonical && targetMap[canonical]) out[source] = targetMap[canonical];
  }
  return out;
}
