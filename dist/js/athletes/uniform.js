import * as THREE from '../../vendor/three.module.js';
import { hashString } from './math.js';

// Team identity (plan section 3.7): a navy and silver practice squad.
// Offense in navy jerseys, defense in white, the quarterback in a red
// non-contact jersey; silver pants, navy socks and helmets for everyone.
export const TEAM = {
  navy: '#0f2742',
  white: '#f1f1ee',
  red: '#c8322b',
  silver: '#c9ccd1',
  numberLight: '#f4f4f0',
  numberDark: '#0f2742',
  belt: '#0b1522',
  sock: '#13253b',
};

export const SKIN_TONES = ['#f0c8a8', '#d9a27a', '#b97b52', '#94603f', '#6e4430', '#4e2f21', '#c48d68', '#7d5039'];

// Jersey and number colours for one player.
export function jerseyFor(spec) {
  if (spec.role === 'qb') return { jersey: TEAM.red, number: TEAM.numberLight };
  if (spec.team === 'offense') return { jersey: TEAM.navy, number: TEAM.numberLight };
  return { jersey: TEAM.white, number: TEAM.numberDark };
}

// Per-player look that does not depend on the jersey: skin, gloves, cleats,
// visor, tape. Derived from the id so it is stable between reps.
export function accessoriesFor(spec, index) {
  const h = hashString(spec.id + ':' + spec.number);
  const h2 = hashString(spec.number + spec.id);
  const skilled = ['wr', 'cb', 's', 'rb', 'te'].includes(spec.role);
  return {
    skin: SKIN_TONES[(index * 5 + Math.floor(h * 8)) % SKIN_TONES.length],
    glove: spec.role === 'ol' || spec.role === 'dl' ? (h2 < 0.5 ? '#e9eaea' : '#1a2a40') : (h < 0.55 ? '#f2f2f0' : TEAM.navy),
    cleat: h2 < 0.55 ? '#f3f3f1' : '#1b1c1f',
    visor: skilled && h > 0.62,
    tape: h2 > 0.35,
    towel: spec.role === 'qb' || spec.role === 'rb',
  };
}

// ---------------------------------------------------------------------------
// Block jersey numerals drawn from stroked centre lines on a 4 x 6 grid, so
// the numbers look like sewn tackle twill without depending on any font.

const GLYPHS = {
  0: [[[0.5, 0.5], [3.5, 0.5], [3.5, 5.5], [0.5, 5.5], true]],
  1: [[[2.1, 0.55], [2.1, 5.5]], [[0.95, 1.45], [2.1, 0.55]]],
  2: [[[0.5, 0.5], [3.5, 0.5], [3.5, 2.95], [0.5, 2.95], [0.5, 5.5], [3.5, 5.5]]],
  3: [[[0.5, 0.5], [3.5, 0.5], [3.5, 5.5], [0.5, 5.5]], [[1.25, 2.95], [3.5, 2.95]]],
  4: [[[0.5, 0.5], [0.5, 3.4], [3.6, 3.4]], [[2.9, 0.5], [2.9, 5.5]]],
  5: [[[3.5, 0.5], [0.5, 0.5], [0.5, 2.95], [3.5, 2.95], [3.5, 5.5], [0.5, 5.5]]],
  6: [[[3.5, 0.5], [0.5, 0.5], [0.5, 5.5], [3.5, 5.5], [3.5, 2.95], [0.5, 2.95]]],
  7: [[[0.5, 0.5], [3.5, 0.5], [3.5, 1.4], [2.2, 5.5]]],
  8: [[[0.5, 0.5], [3.5, 0.5], [3.5, 5.5], [0.5, 5.5], true], [[0.5, 2.95], [3.5, 2.95]]],
  9: [[[3.5, 2.95], [0.5, 2.95], [0.5, 0.5], [3.5, 0.5], [3.5, 5.5], [0.5, 5.5]]],
};
const glyphWidth = d => (d === '1' ? 3.0 : 4);

// Draws `text` centred at (cx, cy) with glyph height h (px). `squeeze` scales
// horizontally to compensate for the texture's unequal u/v densities.
export function drawNumber(ctx, text, cx, cy, h, color, squeeze = 1) {
  const unit = h / 6, gap = 0.55;
  const total = [...text].reduce((w, d, i) => w + glyphWidth(d) + (i ? gap : 0), 0);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(squeeze * unit, unit);
  ctx.translate(-total / 2, -3);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.06;
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;
  let x = 0;
  for (const d of text) {
    const shift = d === '1' ? -0.5 : 0;
    for (const line of GLYPHS[d]) {
      const closed = line[line.length - 1] === true, pts = closed ? line.slice(0, -1) : line;
      ctx.lineCap = closed ? 'butt' : 'square';
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(x + px + shift, py) : ctx.moveTo(x + px + shift, py)));
      if (closed) ctx.closePath();
      ctx.stroke();
    }
    x += glyphWidth(d) + gap;
  }
  ctx.restore();
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Faint knit texture so large jersey areas are not perfectly flat colour.
function fabricNoise(ctx, x, y, w, h, seed, strength) {
  let s = Math.floor(seed * 1e6) || 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  ctx.save();
  for (let i = 0; i < w * h / 40; i++) {
    ctx.fillStyle = rnd() < 0.5 ? `rgba(0,0,0,${strength})` : `rgba(255,255,255,${strength * 0.8})`;
    ctx.fillRect(x + rnd() * w, y + rnd() * h, 2, 1);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Jersey atlas: one 512 x 256 cell per player holding the unwrapped chest
// piece (u around the torso starting at the left side, back at u = 0.25,
// front at u = 0.75, so both numbers read left to right; v from the waist
// seam up to the collar). Each instance of
// the chest mesh looks up its own cell through a per-instance UV offset.

export const ATLAS = { cols: 4, rows: 6, cellW: 512, cellH: 256, pad: 4 };

// Measured from the chest loft in rig.js: perimeter at the number band and
// the vertical span of the mesh, in yards.
const CHEST_PERIMETER = 1.34, CHEST_SPAN = 0.42;

export function buildJerseyAtlas(players) {
  const { cols, rows, cellW, cellH, pad } = ATLAS;
  const c = canvas(cols * cellW, rows * cellH), ctx = c.getContext('2d');
  const pxPerYdU = cellW / CHEST_PERIMETER, pxPerYdV = cellH / CHEST_SPAN, squeeze = pxPerYdU / pxPerYdV;
  const offsets = new Map();
  players.forEach((spec, i) => {
    const col = i % cols, row = Math.floor(i / cols), x0 = col * cellW, y0 = row * cellH;
    const { jersey, number } = jerseyFor(spec);
    ctx.fillStyle = jersey;
    ctx.fillRect(x0, y0, cellW, cellH);
    fabricNoise(ctx, x0, y0, cellW, cellH, hashString(spec.id), spec.team === 'defense' && spec.role !== 'qb' ? 0.035 : 0.06);
    // Side seams and a slightly darker collar band.
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    for (const u of [0, 0.5]) ctx.fillRect(x0 + u * cellW - 1, y0, 3, cellH);
    ctx.fillRect(x0 + cellW - 2, y0, 2, cellH);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(x0, y0, cellW, cellH * 0.035);
    const text = String(spec.number);
    drawNumber(ctx, text, x0 + cellW * 0.75, y0 + cellH * 0.5, pxPerYdV * 0.2, number, squeeze);
    drawNumber(ctx, text, x0 + cellW * 0.25, y0 + cellH * 0.55, pxPerYdV * 0.25, number, squeeze);
    offsets.set(spec.id, [(x0 + pad) / c.width, 1 - (y0 + cellH - pad) / c.height]);
  });
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const scale = [(cellW - 2 * pad) / c.width, (cellH - 2 * pad) / c.height];
  return { texture, offsets, scale };
}

function helmetStripeTexture() {
  const c = canvas(256, 4), ctx = c.getContext('2d');
  ctx.fillStyle = TEAM.navy; ctx.fillRect(0, 0, 256, 4);
  ctx.fillStyle = TEAM.silver; ctx.fillRect(116, 0, 24, 4);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(126, 0, 4, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function leatherTexture() {
  const c = canvas(256, 256), ctx = c.getContext('2d');
  ctx.fillStyle = '#7a4223'; ctx.fillRect(0, 0, 256, 256);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 5000; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(40,18,6,0.25)' : 'rgba(150,90,50,0.18)';
    ctx.beginPath(); ctx.arc(rnd() * 256, rnd() * 256, 0.8 + rnd(), 0, Math.PI * 2); ctx.fill();
  }
  // Four panel seams from tip to tip (u = 0, .25, .5, .75).
  ctx.fillStyle = 'rgba(30,12,4,0.8)';
  for (const u of [0, 0.25, 0.5, 0.75, 1]) ctx.fillRect(u * 256 - 1.5, 0, 3, 256);
  // Practice-ball stripes near both tips, on the two panels either side of the laces.
  ctx.fillStyle = '#f2efe6';
  for (const v of [0.19, 0.81]) ctx.fillRect(0.25 * 256 + 3, v * 256 - 6, 0.5 * 256 - 6, 12);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Adds a per-instance UV offset to a standard material's map lookup.
function withAtlasOffset(material, scale) {
  material.onBeforeCompile = shader => {
    shader.uniforms.atlasScale = { value: new THREE.Vector2(...scale) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 atlasOffset;\nuniform vec2 atlasScale;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = atlasOffset + vMapUv * atlasScale;\n#endif');
  };
  material.customProgramCacheKey = () => 'athlete-jersey-atlas';
  return material;
}

// All athlete materials, shared by every rig. Colours that vary per player
// (jerseys, skin, gloves, cleats) come from instance colours on white bases.
export function createMaterials(players) {
  const atlas = buildJerseyAtlas(players);
  const std = (params) => new THREE.MeshStandardMaterial(params);
  const materials = {
    atlas,
    chest: withAtlasOffset(std({ map: atlas.texture, roughness: 0.8, vertexColors: true }), atlas.scale),
    cloth: std({ color: '#ffffff', roughness: 0.8, vertexColors: true }),
    pants: std({ color: TEAM.silver, roughness: 0.42, metalness: 0.18, vertexColors: true }),
    belt: std({ color: TEAM.belt, roughness: 0.6 }),
    sock: std({ color: TEAM.sock, roughness: 0.92, vertexColors: true }),
    skin: std({ color: '#ffffff', roughness: 0.56, vertexColors: true }),
    glove: std({ color: '#ffffff', roughness: 0.6 }),
    cleat: std({ color: '#ffffff', roughness: 0.42, vertexColors: true }),
    tape: std({ color: '#f3f2ec', roughness: 0.85 }),
    towel: std({ color: '#f5f5f2', roughness: 1 }),
    helmet: new THREE.MeshPhysicalMaterial({ map: helmetStripeTexture(), roughness: 0.34, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1 }),
    hardware: std({ color: '#ffffff', roughness: 0.45, metalness: 0.35, vertexColors: true }),
    strap: std({ color: '#f1f1ec', roughness: 0.35 }),
    visor: new THREE.MeshPhysicalMaterial({ color: '#0c1117', roughness: 0.06, metalness: 0.7, clearcoat: 1, side: THREE.DoubleSide }),
    leather: std({ map: leatherTexture(), roughness: 0.62 }),
    laces: std({ color: '#f4f1e8', roughness: 0.7 }),
  };
  materials.helmet.side = THREE.FrontSide;
  return materials;
}
