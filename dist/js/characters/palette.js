// Team identity (plan 3.7) and how a model's materials or vertices are
// recoloured to it. Pure data and functions; unit-tested in Node.

export const COLORS = {
  navy: '#0f2742',
  navyDeep: '#091a2d',
  silver: '#c9ccd1',
  white: '#f1f1ee',
  red: '#c8322b',
  facemask: '#8e959c',
  black: '#17191c',
};

// Varied, natural skin tones (sRGB hex).
export const SKIN_TONES = ['#8d5a3b', '#5c3a28', '#c48a63', '#a36c49', '#3f2a1f', '#d9a982', '#74472f', '#b67b55'];

// Small stable hash so a player keeps the same look every rep.
export function hashId(id) {
  let h = 2166136261;
  for (const c of String(id)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// The uniform for one player: offense navy, defense white, quarterback in
// the red non-contact jersey; silver pants, navy helmets and socks.
export function uniformFor(spec = {}, overrides = {}) {
  const qb = spec.role === 'qb';
  const offense = spec.team !== 'defense';
  const h = hashId(spec.id ?? spec.number ?? 0);
  const base = {
    jersey: qb ? COLORS.red : offense ? COLORS.navy : COLORS.white,
    number: qb || offense ? COLORS.white : COLORS.navy,
    pants: COLORS.silver,
    helmet: COLORS.navy,
    stripe: COLORS.silver,
    facemask: COLORS.facemask,
    socks: COLORS.navy,
    shoes: h % 3 === 0 ? COLORS.black : COLORS.white,
    gloves: (h >>> 3) % 2 ? COLORS.white : COLORS.navy,
    skin: SKIN_TONES[(h >>> 5) % SKIN_TONES.length],
  };
  const team = offense ? overrides.offense : overrides.defense;
  return { ...base, ...(team || {}), ...(qb ? overrides.qb || {} : {}) };
}

// Material slots, matched case-insensitively against material and mesh
// names. Order matters: the first pattern that matches wins.
export const MATERIAL_SLOTS = [
  ['keep', /hair|beard|brow|lash|eye|teeth|tooth|tongue|mouth|nail/i],
  ['facemask', /face[\s_-]*mask|cage|grill/i],
  ['visor', /visor/i],
  ['helmet', /helmet|headwear|headgear|\bhat\b|\bcap\b/i],
  ['number', /number|numeral|digit/i],
  ['gloves', /glove/i],
  ['socks', /sock/i],
  ['shoes', /shoe|cleat|boot|sneaker|footwear|\bfeet\b/i],
  ['pants', /pant|short|trouser|\bbottoms?\b|legging/i],
  ['jersey', /jersey|shirt|\btop\b|torso|\btee\b|uniform|chest/i],
  ['skin', /skin|flesh|\bface\b|\bbody\b|\bhead\b|\barms?\b|\bhands?\b|\blegs?\b/i],
];

export function slotForMaterial(materialName = '', meshName = '') {
  for (const name of [materialName, meshName]) {
    // Split camelCase / separators so /top/ does not match "laptop" etc.
    const words = String(name).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.:|-]+/g, ' ');
    for (const [slot, pattern] of MATERIAL_SLOTS) if (pattern.test(words)) return slot;
  }
  return null;
}

// Decides how a model is recoloured: by named materials when the clothing is
// named, else by body region painted into vertex colours from skin weights.
//   materials: [{materialName, meshName}]
export function recolourMode(materials) {
  const slots = materials.map(m => slotForMaterial(m.materialName, m.meshName));
  return slots.includes('jersey') || slots.includes('pants') ? 'materials' : 'regions';
}

// Body regions for the vertex-colour fallback.
export const REGIONS = ['skin', 'jersey', 'pants', 'helmet', 'socks', 'shoes', 'gloves'];
const R = Object.fromEntries(REGIONS.map((r, i) => [r, i]));

// Classifies every vertex of a skinned mesh into a body region.
//   count: vertex count
//   skinIndex, skinWeight: flat arrays (4 per vertex)
//   position: flat array (3 per vertex), character space (feet at y=0, yards)
//   boneCanon: canonical name (or the nearest canonical ancestor) per bone index
//   joints: {canonical: [x, y, z]} joint positions in character space
// Returns Uint8Array of REGIONS indices.
export function classifyRegions({ count, skinIndex, skinWeight, position, boneCanon, joints }) {
  const out = new Uint8Array(count);
  const y = name => joints[name]?.[1];
  const along = (p, a, b) => {
    const A = joints[a], B = joints[b];
    if (!A || !B) return 0.5;
    const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
    const len2 = dx * dx + dy * dy + dz * dz || 1;
    return ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy + (p[2] - A[2]) * dz) / len2;
  };
  const height = Math.max(0.5, y('Head') ?? 1.9);
  const waist = (y('Hips') ?? height * 0.52) + height * 0.06;
  const weights = new Map();
  for (let v = 0; v < count; v++) {
    weights.clear();
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[v * 4 + k];
      if (!(w > 0)) continue;
      const bone = boneCanon[skinIndex[v * 4 + k]] || 'Hips';
      weights.set(bone, (weights.get(bone) || 0) + w);
    }
    let bone = 'Hips', best = -1;
    for (const [b, w] of weights) if (w > best) { best = w; bone = b; }
    const p = [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]];
    out[v] = regionFor(bone, p, { along, waist, y });
  }
  return out;
}

function regionFor(bone, p, { along, waist, y }) {
  const side = bone.startsWith('Left') ? 'Left' : bone.startsWith('Right') ? 'Right' : '';
  const part = bone.slice(side.length);
  switch (part) {
    case 'Head': return R.helmet;
    case 'Neck': {
      const neck = y('Neck'), head = y('Head');
      return neck != null && head != null && p[1] < neck + (head - neck) * 0.35 ? R.jersey : R.skin;
    }
    case 'Spine': case 'Spine1': case 'Spine2': case 'Shoulder': return p[1] > waist ? R.jersey : R.pants;
    case 'Arm': return along(p, side + 'Arm', side + 'ForeArm') < 0.5 ? R.jersey : R.skin;
    case 'ForeArm': return along(p, side + 'ForeArm', side + 'Hand') > 0.86 ? R.gloves : R.skin;
    case 'Hand': return R.gloves;
    case 'Hips': return p[1] > waist ? R.jersey : R.pants;
    case 'UpLeg': return R.pants;
    case 'Leg': return along(p, side + 'Leg', side + 'Foot') < 0.16 ? R.pants : R.socks;
    case 'Foot': case 'ToeBase': return R.shoes;
    default: return R.jersey;
  }
}

// Colour (hex) of a region for a uniform.
export function regionColor(uniform, region) {
  const name = typeof region === 'number' ? REGIONS[region] : region;
  return uniform[name] || uniform.jersey;
}
