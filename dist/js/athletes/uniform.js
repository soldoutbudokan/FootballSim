import * as THREE from '../../vendor/three.module.js';
import { hashString, smoothstep } from './math.js';

// Team identity (plan section 3.7): a fictional navy and silver club.
// Offense in navy jerseys, defense in white, the quarterback in a red
// non-contact jersey; silver pants with a navy stripe, navy socks over white,
// navy helmets with a silver centre stripe for everyone.
export const TEAM = {
  navy: '#0e2440',
  white: '#eeeeea',
  red: '#b9281f',
  silver: '#b4b9c0',
  pants: '#8e949d',
  numberLight: '#f2f2ee',
  numberDark: '#0e2440',
  belt: '#0a121d',
  sock: '#10233c',
};

export const SKIN_TONES = ['#e2b08d', '#c98f66', '#a86d47', '#855536', '#633d2b', '#48291d', '#b57f5b', '#70462f'];

// Jersey, number, outline and trim colours for one player.
export function jerseyFor(spec) {
  if (spec.role === 'qb') return { jersey: TEAM.red, number: TEAM.numberLight, outline: '#0b1522', trim: TEAM.numberLight, light: false };
  if (spec.team === 'offense') return { jersey: TEAM.navy, number: TEAM.numberLight, outline: TEAM.silver, trim: TEAM.silver, light: false };
  return { jersey: TEAM.white, number: TEAM.numberDark, outline: TEAM.silver, trim: TEAM.navy, light: true };
}

// Per-player look that does not depend on the jersey: skin, gloves, cleats,
// facemask, visor, tape. Derived from the id so it is stable between reps.
export function accessoriesFor(spec, index) {
  const h = hashString(spec.id + ':' + spec.number);
  const h2 = hashString(spec.number + spec.id);
  const h3 = (h * 13.37 + h2 * 7.77) % 1;
  const line = spec.role === 'ol' || spec.role === 'dl';
  const skilled = ['wr', 'cb', 's', 'rb', 'te'].includes(spec.role);
  return {
    skin: SKIN_TONES[(index * 5 + Math.floor(h * 8)) % SKIN_TONES.length],
    glove: line ? (h2 < 0.5 ? '#dcdddd' : '#16263c') : (h < 0.55 ? '#e6e6e3' : TEAM.navy),
    cleat: h2 < 0.55 ? '#e9e9e6' : '#17181b',
    // Linemen and linebackers wear the closed cage, everyone else the open mask.
    cage: line || spec.role === 'lb',
    visor: skilled && h > 0.62,
    tape: h2 > 0.35,
    // Compression arm sleeves on some players (mostly linemen).
    armSleeve: (h * 7.31) % 1 < (line ? 0.45 : 0.18) ? (h2 < 0.5 ? '#121720' : TEAM.navy) : null,
    towel: spec.role === 'qb' || spec.role === 'rb' || (spec.role === 'wr' && h3 < 0.4),
    // A back plate hanging below the pads on some skill players.
    backPlate: skilled && h3 > 0.45,
  };
}

// ---------------------------------------------------------------------------
// Athletic block numerals: filled outlines on a 10 x 14 grid with chamfered
// corners and square counters, like sewn tackle twill, independent of any
// font. Each glyph is a list of closed paths (the first is the outside, the
// rest are counters cut out with the even-odd rule).

const mirror = path => path.map(([x, y]) => [10 - x, y]).reverse();
const turn = path => path.map(([x, y]) => [10 - x, 14 - y]);
const TWO = [[1.5, 0], [8.5, 0], [10, 1.5], [10, 6.6], [8.5, 8.1], [3.1, 8.1], [3.1, 10.9], [10, 10.9], [10, 14], [0, 14], [0, 6.5], [1.5, 5], [6.9, 5], [6.9, 3.1], [3.1, 3.1], [3.1, 4.6], [0, 4.6], [0, 1.5]];
const SIX = [[[1.5, 0], [8.5, 0], [10, 1.5], [10, 4.4], [6.9, 4.4], [6.9, 3.1], [3.1, 3.1], [3.1, 5.2], [8.5, 5.2], [10, 6.7], [10, 12.5], [8.5, 14], [1.5, 14], [0, 12.5], [0, 1.5]], [[3.1, 8.2], [6.9, 8.2], [6.9, 10.9], [3.1, 10.9]]];
const GLYPHS = {
  0: [[[1.5, 0], [8.5, 0], [10, 1.5], [10, 12.5], [8.5, 14], [1.5, 14], [0, 12.5], [0, 1.5]], [[3.1, 3.1], [6.9, 3.1], [6.9, 10.9], [3.1, 10.9]]],
  1: [[[1.2, 2.9], [4.1, 0], [7.1, 0], [7.1, 10.9], [9.2, 10.9], [9.2, 14], [1.6, 14], [1.6, 10.9], [3.9, 10.9], [3.9, 4.4], [1.2, 4.4]]],
  2: [TWO],
  3: [[[1.5, 0], [8.5, 0], [10, 1.5], [10, 5.7], [8.7, 7], [10, 8.3], [10, 12.5], [8.5, 14], [1.5, 14], [0, 12.5], [0, 9.6], [3.1, 9.6], [3.1, 10.9], [6.9, 10.9], [6.9, 8.5], [3.6, 8.5], [3.6, 5.5], [6.9, 5.5], [6.9, 3.1], [3.1, 3.1], [3.1, 4.4], [0, 4.4], [0, 1.5]]],
  4: [[[0, 0], [3.1, 0], [3.1, 6.4], [6.3, 6.4], [6.3, 0], [9.4, 0], [9.4, 14], [6.3, 14], [6.3, 9.5], [0, 9.5]]],
  5: [mirror(TWO)],
  6: SIX,
  7: [[[0, 0], [10, 0], [10, 3.3], [5.9, 14], [2.5, 14], [6.5, 3.1], [3.1, 3.1], [3.1, 4.6], [0, 4.6]]],
  8: [[[1.5, 0], [8.5, 0], [10, 1.5], [10, 5.7], [8.7, 7], [10, 8.3], [10, 12.5], [8.5, 14], [1.5, 14], [0, 12.5], [0, 8.3], [1.3, 7], [0, 5.7], [0, 1.5]], [[3.1, 3.1], [6.9, 3.1], [6.9, 5.5], [3.1, 5.5]], [[3.1, 8.5], [6.9, 8.5], [6.9, 10.9], [3.1, 10.9]]],
  9: SIX.map(turn),
};
const GLYPH_GAP = 2.3;

// Draws `text` centred at (cx, cy) with glyph height h (px). `squeeze` scales
// horizontally to compensate for the texture's unequal u/v densities.
// `outlines` are [colour, width in glyph units] pairs drawn widest first
// under the fill: the twill border and its keyline.
export function drawNumber(ctx, text, cx, cy, h, color, squeeze = 1, outlines = []) {
  const unit = h / 14, digits = [...String(text)];
  const total = digits.length * 10 + (digits.length - 1) * GLYPH_GAP;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(squeeze * unit, unit);
  ctx.translate(-total / 2, -7);
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 3;
  const trace = () => {
    ctx.beginPath();
    digits.forEach((d, i) => {
      const x = i * (10 + GLYPH_GAP);
      for (const path of GLYPHS[d] || []) {
        path.forEach(([px, py], k) => (k ? ctx.lineTo(x + px, py) : ctx.moveTo(x + px, py)));
        ctx.closePath();
      }
    });
  };
  for (const [stroke, width] of outlines) {
    trace(); ctx.strokeStyle = stroke; ctx.lineWidth = width * 2; ctx.stroke();
    // The stroke also runs around the counters; fill them in under the number.
    trace(); ctx.fillStyle = stroke; ctx.fill('evenodd');
  }
  trace(); ctx.fillStyle = color; ctx.fill('evenodd');
  ctx.restore();
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// ---------------------------------------------------------------------------
// Jersey atlas: one 512 x 256 cell per player. A cell holds the unwrapped
// torso of his jersey (u around the body starting at the left side, back at
// u = 0.25, front at u = 0.75, so both numbers read left to right; v from the
// waist seam up to the collar) above his two sleeves (u around the arm with
// the outside of the shoulder in the middle, v from the top of the shoulder
// cap down to the cuff). The last cell is shared by everybody: plain white for
// the parts that take their colour from vertex colours, the pant leg and hips
// with their side stripes, and the sock. Eight rows (a 2048 px square) hold
// the offense and every defender who can come on in another personnel
// package, with room to spare.

export const ATLAS = { cols: 4, rows: 8, cellW: 512, cellH: 256, pad: 4 };

// Regions [x, y, w, h] as fractions of a cell inside its padding, y up.
export const REGIONS = {
  torso: [0, 0.38, 1, 0.62],
  sleeveL: [0.01, 0, 0.48, 0.35],
  sleeveR: [0.51, 0, 0.48, 0.35],
  // In the shared cell:
  white: [0.01, 0.8, 0.1, 0.19],
  leg: [0.15, 0, 0.34, 1],
  hips: [0.53, 0, 0.34, 1],
  sock: [0.91, 0, 0.08, 1],
};

// Measured from the lofts in rig.js: perimeter and height of the torso piece
// and of the sleeve, in yards.
const TORSO = { around: 1.36, span: 0.435 }, SLEEVE = { around: 0.62, span: 0.29 };

// A painter for one region of one cell: rect(u0, v0, u1, v1) fills in the
// region's own 0..1 coordinates (v up), `bleed` paints a little past the
// region's edge so filtering never picks up a neighbour.
function painter(ctx, x0, y0, name) {
  const { cellW, cellH, pad } = ATLAS, [rx, ry, rw, rh] = REGIONS[name];
  const X = x0 + pad + rx * (cellW - 2 * pad), W = rw * (cellW - 2 * pad);
  const H = rh * (cellH - 2 * pad), Y = y0 + pad + (1 - ry - rh) * (cellH - 2 * pad);
  return {
    X, Y, W, H,
    x: u => X + u * W, y: v => Y + (1 - v) * H,
    rect(u0, v0, u1, v1, color, bleed = 0) {
      ctx.fillStyle = color;
      ctx.fillRect(X + u0 * W - bleed, Y + (1 - v1) * H - bleed, (u1 - u0) * W + 2 * bleed, (v1 - v0) * H + 2 * bleed);
    },
  };
}

function paintJersey(ctx, x0, y0, spec) {
  const { cellW, cellH } = ATLAS, look = jerseyFor(spec);
  const shade = look.light ? 'rgba(24,38,56,' : 'rgba(0,0,0,', tintTo = look.light ? 'rgba(255,255,255,' : 'rgba(255,255,255,';
  ctx.fillStyle = look.jersey;
  ctx.fillRect(x0, y0, cellW, cellH);
  const t = painter(ctx, x0, y0, 'torso');
  const pxU = t.W / TORSO.around, pxV = t.H / TORSO.span, squeeze = pxU / pxV;
  // Ventilated side panels under the arms and their seams.
  for (const u of [0, 0.5, 1]) {
    t.rect(u - 0.045, 0, u + 0.045, 0.6, shade + (look.light ? '0.07)' : '0.16)'));
    for (const e of [-0.045, 0.045]) t.rect(u + e - 0.002, 0, u + e + 0.002, 0.6, shade + '0.2)');
  }
  // The yoke seam over the shoulder pads, front and back, and a faint
  // highlight on the panel above it.
  t.rect(0, 0.735, 1, 0.742, shade + '0.2)');
  t.rect(0, 0.742, 1, 0.93, tintTo + '0.035)');
  // Folds shaded into the cloth: pulled from under the arms towards the
  // middle of the body, and bunched where the jersey goes into the belt.
  const fold = (u0, v0, u1, v1, width, strength) => {
    ctx.lineCap = 'round';
    for (const [dy, color, k] of [[0, shade, 1], [-width * 0.55, tintTo, look.light ? 0 : 0.5]]) {
      for (const w of [1, 0.55]) {
        ctx.strokeStyle = color + (strength * k * 0.5) + ')'; ctx.lineWidth = width * w;
        ctx.beginPath(); ctx.moveTo(t.x(u0), t.y(v0) + dy);
        ctx.quadraticCurveTo(t.x((u0 + u1) / 2), t.y(Math.min(v0, v1) - 0.04) + dy, t.x(u1), t.y(v1) + dy); ctx.stroke();
      }
    }
  };
  const rnd = i => hashString(spec.id + 'fold' + i);
  for (const [centre, dir] of [[0.75, 1], [0.75, -1], [0.25, 1], [0.25, -1]]) {
    for (let i = 0; i < 3; i++) {
      const v = 0.5 - i * 0.13 - 0.06 * rnd(i + centre * 8 + dir);
      fold(centre + dir * 0.2, v, centre + dir * (0.05 + 0.05 * rnd(i + 20)), v - 0.12 - 0.08 * rnd(i + 40), 7, look.light ? 0.08 : 0.15);
    }
  }
  for (let i = 0; i < 9; i++) {
    const u = (i + rnd(i + 60)) / 9, len = 0.05 + 0.06 * rnd(i + 70), v = 0.03 + 0.12 * rnd(i + 80);
    fold(u, v, u + len, v + 0.03 * (rnd(i + 90) - 0.5), 5, look.light ? 0.08 : 0.15);
  }
  // Ribbed collar with a V at the front and the club's diamond under it.
  t.rect(0, 0.955, 1, 1.02, look.trim);
  t.rect(0, 0.948, 1, 0.956, shade + '0.3)');
  ctx.fillStyle = look.trim;
  ctx.beginPath();
  ctx.moveTo(t.x(0.75 - 0.04), t.y(0.96)); ctx.lineTo(t.x(0.75), t.y(0.875)); ctx.lineTo(t.x(0.75 + 0.04), t.y(0.96));
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = look.jersey === TEAM.navy ? '#0a1a30' : look.jersey;
  ctx.beginPath();
  ctx.moveTo(t.x(0.75 - 0.022), t.y(0.965)); ctx.lineTo(t.x(0.75), t.y(0.91)); ctx.lineTo(t.x(0.75 + 0.022), t.y(0.965));
  ctx.closePath(); ctx.fill();
  const dx = 0.009 * t.W, dy = 0.026 * t.H, cx = t.x(0.75), cy = t.y(0.815);
  ctx.fillStyle = look.light ? TEAM.navy : TEAM.silver;
  ctx.beginPath(); ctx.moveTo(cx, cy - dy); ctx.lineTo(cx + dx, cy); ctx.lineTo(cx, cy + dy); ctx.lineTo(cx - dx, cy); ctx.closePath(); ctx.fill();
  // Numbers: front and back.
  const outlines = look.light ? [[look.outline, 0.85]] : look.jersey === TEAM.red ? [[look.outline, 0.9]] : [['#081220', 1.2], [look.outline, 0.8]];
  for (const [u, v, height] of [[0.75, 0.42, 0.18], [0.25, 0.47, 0.23]]) {
    drawNumber(ctx, spec.number, t.x(u), t.y(v), pxV * height, look.number, squeeze, outlines);
  }
  // Sleeves: the number on the shoulder cap and two stripes above the hem.
  // On the left sleeve u runs from front to back, on the right back to front.
  for (const name of ['sleeveL', 'sleeveR']) {
    const s = painter(ctx, x0, y0, name), sqz = (s.W / SLEEVE.around) / (s.H / SLEEVE.span);
    drawNumber(ctx, spec.number, s.x(0.5), s.y(0.64), s.H / SLEEVE.span * 0.095, look.number, sqz, [[look.outline, 0.9]]);
    s.rect(-0.02, 0.30, 1.02, 0.315, shade + '0.25)');
    const stripe = look.light ? TEAM.navy : look.jersey === TEAM.red ? TEAM.numberLight : TEAM.silver;
    s.rect(-0.02, 0.07, 1.02, 0.13, stripe); s.rect(-0.02, 0.17, 1.02, 0.23, stripe);
    s.rect(-0.02, -0.03, 1.02, 0.035, look.light ? TEAM.navy : shade + '0.35)');
  }
}

// The shared cell: white, the pant leg, the hips and the sock.
function paintShared(ctx, x0, y0) {
  const { cellW, cellH } = ATLAS;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x0, y0, cellW, cellH);
  const stripes = (p, at, k = 1) => {
    for (const u of at) {
      p.rect(u - 0.055 * k, -0.02, u + 0.055 * k, 1.02, TEAM.navy, 0);
      p.rect(u - 0.019 * k, -0.02, u + 0.019 * k, 1.02, TEAM.white, 0);
    }
  };
  // Leg: u = 0 and 1 are the outside of the leg; v = 0 the cuff below the
  // knee, v = 1 the hip.
  const leg = painter(ctx, x0, y0, 'leg');
  leg.rect(0, 0, 1, 1, TEAM.pants, 5);
  stripes(leg, [0, 1]);
  leg.rect(-0.03, 0, 1.03, 0.03, 'rgba(0,0,0,0.3)');                    // hem
  // Hips: the stripes run on up both sides to the waist; a laced fly.
  const hips = painter(ctx, x0, y0, 'hips');
  hips.rect(0, 0, 1, 1, TEAM.pants, 5);
  stripes(hips, [0, 0.5, 1], 0.6);
  hips.rect(0.245, 0.55, 0.255, 0.9, 'rgba(30,38,50,0.4)');
  for (let i = 0; i < 4; i++) hips.rect(0.235, 0.6 + i * 0.07, 0.265, 0.615 + i * 0.07, 'rgba(240,240,240,0.8)');
  // Sock: v = 1 below the knee, v = 0 at the ankle. Navy with two silver
  // hoops over a white lower leg.
  const sock = painter(ctx, x0, y0, 'sock');
  sock.rect(0, 0, 1, 1, TEAM.white, 5);
  sock.rect(-0.2, 0.46, 1.2, 1.05, TEAM.sock);
  sock.rect(-0.2, 0.56, 1.2, 0.6, TEAM.silver); sock.rect(-0.2, 0.64, 1.2, 0.68, TEAM.silver);
}

export function buildJerseyAtlas(players) {
  const { cols, rows, cellW, cellH, pad } = ATLAS;
  if (players.length >= cols * rows) throw new Error('Jersey atlas holds ' + (cols * rows - 1) + ' players');
  const c = canvas(cols * cellW, rows * cellH), ctx = c.getContext('2d');
  const origin = (x0, y0) => [(x0 + pad) / c.width, 1 - (y0 + cellH - pad) / c.height];
  const offsets = new Map();
  players.forEach((spec, i) => {
    const x0 = (i % cols) * cellW, y0 = Math.floor(i / cols) * cellH;
    paintJersey(ctx, x0, y0, spec);
    offsets.set(spec.id, origin(x0, y0));
  });
  const last = cols * rows - 1, sx = (last % cols) * cellW, sy = Math.floor(last / cols) * cellH;
  paintShared(ctx, sx, sy);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const scale = [(cellW - 2 * pad) / c.width, (cellH - 2 * pad) / c.height], shared = origin(sx, sy);
  const [wx, wy, ww, wh] = REGIONS.white;
  const white = [shared[0] + (wx + ww / 2) * scale[0], shared[1] + (wy + wh / 2) * scale[1]];
  return { texture, offsets, scale, white, shared };
}

// ---------------------------------------------------------------------------
// Helmet texture, on the azimuthal disc the shell is unwrapped to
// (geometry.js helmetUV): the crown in the middle, the front of the shell at
// the top, the athlete's left on the right. Navy shell, a silver centre
// stripe from brow to nape, the club's silver diamond on both sides, vent
// slots, ear holes and bumper labels. The corners are outside the disc:
// bottom left is white (facemask, strap and visor take vertex colours),
// bottom right is the dark padding and edge trim.
function helmetTexture() {
  const S = 512, c = canvas(S, S), ctx = c.getContext('2d');
  const R = phi => 0.5 * phi / 152 * S, at = (thetaDeg, phiDeg) => {
    const th = thetaDeg * Math.PI / 180;
    return [S / 2 + R(phiDeg) * Math.sin(th), S / 2 - R(phiDeg) * Math.cos(th)];
  };
  ctx.fillStyle = TEAM.navy; ctx.fillRect(0, 0, S, S);
  // Centre stripe: silver with a white core and dark keylines.
  const w = 0.05 * S;
  ctx.fillStyle = '#081425'; ctx.fillRect(S / 2 - w / 2 - 2, 0, w + 4, S);
  ctx.fillStyle = TEAM.silver; ctx.fillRect(S / 2 - w / 2, 0, w, S);
  ctx.fillStyle = '#e9ebee'; ctx.fillRect(S / 2 - w * 0.17, 0, w * 0.34, S);
  // Vent slots either side of the spine, front and back.
  ctx.fillStyle = '#04080e';
  for (const [th, ph, rot] of [[38, 44, 0.5], [-38, 44, -0.5], [148, 52, -0.45], [-148, 52, 0.45], [70, 30, 1.2], [-70, 30, -1.2]]) {
    const [x, y] = at(th, ph);
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.beginPath(); ctx.ellipse(0, 0, 5, 15, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  for (const s of [-1, 1]) {
    // Ear hole with its rubber ring.
    const [ex, ey] = at(s * 92, 109);
    ctx.fillStyle = '#1a2230'; ctx.beginPath(); ctx.arc(ex, ey, 13, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#020305'; ctx.beginPath(); ctx.arc(ex, ey, 9, 0, Math.PI * 2); ctx.fill();
    // The club mark: two silver chevrons pointing forward (up the texture).
    const [lx, ly] = at(s * 90, 84);
    const chevron = (y, k, fill) => {
      ctx.fillStyle = fill; ctx.beginPath();
      for (const [px, py] of [[0, -46], [34, 4], [34, 26], [0, -22], [-34, 26], [-34, 4]]) ctx.lineTo(lx + px * k, ly + y + py * k);
      ctx.closePath(); ctx.fill();
    };
    chevron(-8, 1.12, '#eef0f2'); chevron(-8, 1, TEAM.silver); chevron(30, 0.92, '#eef0f2');
  }
  // Bumper labels: brow and nape.
  ctx.fillStyle = '#e4e6e9';
  const [bx, by] = at(0, 80); ctx.fillRect(bx - 24, by - 5, 48, 11);
  const [nx, ny] = at(180, 121); ctx.fillRect(nx - 30, ny - 6, 60, 12);
  ctx.fillStyle = TEAM.navy; ctx.fillRect(bx - 16, by - 1, 32, 3); ctx.fillRect(nx - 20, ny - 1, 40, 3);
  // Corners.
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, S - 56, 56, 56);
  ctx.fillStyle = '#0b0d11'; ctx.fillRect(S - 56, S - 56, 56, 56);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------------------
// Detail layers: small tiling micro-surfaces computed as height fields, one
// layer of a texture array each. Texel = (normal x, normal y, roughness
// variation, crease shading); 0.5 is neutral everywhere.

export const GRAIN = { none: 0, mesh: 1, knit: 2, skin: 3, rib: 4, leather: 5, weave: 6 };
// World size of one tile of each layer, yards.
export const GRAIN_TILE = [1, 0.026, 0.02, 0.035, 0.03, 0.03, 0.03];
const DETAIL_SIZE = 128;

const hash2 = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
// Distance to the nearest point of a jittered n x n grid, wrapping at the
// tile edge, in cells.
function cellular(u, v, n, jitter = 0.8) {
  const x = u * n, y = v * n, ix = Math.floor(x), iy = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j, wx = ((cx % n) + n) % n, wy = ((cy % n) + n) % n;
    const px = cx + 0.5 + (hash2(wx, wy) - 0.5) * jitter, py = cy + 0.5 + (hash2(wy + 17, wx + 5) - 0.5) * jitter;
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
}
const wave = x => Math.sin(x * Math.PI * 2);

const DETAIL_LAYERS = [
  { height: () => 0.5, gain: 0 },
  // Jersey mesh: staggered round perforations in a fine knit.
  { height(u, v) {
    const n = 6, row = Math.floor(v * n), uu = (u * n + 0.5 * (row % 2)) % 1, vv = (v * n) % 1;
    const hole = 1 - smoothstep(0.14, 0.3, Math.hypot(uu - 0.5, vv - 0.5));
    return 0.82 - 0.8 * hole + 0.09 * wave(u * 24) * wave(v * 24);
  }, gain: 1.0, crease: 0.7, rough: 0.5 },
  // Stretch knit of the pants: fine diagonal ribs.
  { height: (u, v) => 0.5 + 0.3 * wave(12 * (u + v)) + 0.2 * wave(24 * u) * wave(24 * v), gain: 0.55, crease: 0.35, rough: 0.5 },
  // Skin: pores and a little mottling.
  { height: (u, v) => 0.7 - 0.5 * Math.exp(-((cellular(u, v, 14) / 0.3) ** 2)) + 0.15 * wave(3 * u + 0.2) * wave(2 * v), gain: 0.35, crease: 0.5, rough: 0.8 },
  // Rib knit (socks, sleeves, collars): ribs along v.
  { height: (u, v) => Math.abs(Math.cos(u * Math.PI * 10)) ** 0.7 + 0.06 * wave(v * 40), gain: 0.9, crease: 0.6, rough: 0.4 },
  // Pebbled grain (gloves, cleats, belts).
  { height: (u, v) => 1 - smoothstep(0.1, 0.62, cellular(u, v, 12)), gain: 0.8, crease: 0.5, rough: 0.6 },
  // Plain weave (tape, towels).
  { height: (u, v) => 0.5 + 0.25 * wave(16 * u) + 0.25 * wave(16 * v) + 0.2 * (hash2(Math.floor(u * 64), Math.floor(v * 64)) - 0.5), gain: 0.7, crease: 0.6, rough: 0.5 },
];

let detailData = null;
function buildDetailData() {
  if (detailData) return detailData;
  const S = DETAIL_SIZE, data = new Uint8Array(S * S * 4 * DETAIL_LAYERS.length), e = 1 / S;
  const byte = v => Math.max(0, Math.min(255, Math.round(v * 255)));
  DETAIL_LAYERS.forEach((layer, index) => {
    const h = new Float32Array(S * S);
    let mean = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const k = layer.height((x + 0.5) * e, (y + 0.5) * e); h[y * S + x] = k; mean += k; }
    mean /= S * S;
    const at = (x, y) => h[((y + S) % S) * S + ((x + S) % S)];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const o = (index * S * S + y * S + x) * 4, here = at(x, y);
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5, dy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      data[o] = byte(0.5 - dx * layer.gain * 4);
      data[o + 1] = byte(0.5 - dy * layer.gain * 4);
      data[o + 2] = byte(0.5 - (here - mean) * (layer.rough || 0));
      data[o + 3] = byte(0.5 + (here - mean) * (layer.crease || 0) * 0.5);
    }
  });
  return (detailData = data);
}

export function detailTexture() {
  const t = new THREE.DataArrayTexture(buildDetailData(), DETAIL_SIZE, DETAIL_SIZE, DETAIL_LAYERS.length);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// The ball: tanned leather with a white stripe near each tip, four panel
// seams, and a pebble-grain normal map computed like the detail layers.

function leatherTexture() {
  const W = 512, H = 256, c = canvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#6f3a1f'; ctx.fillRect(0, 0, W, H);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // Wear: darker scuffs and lighter rubbed patches, then the pebble speckle.
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(38,16,6,0.10)' : 'rgba(150,92,54,0.08)';
    ctx.beginPath(); ctx.ellipse(rnd() * W, rnd() * H, 10 + rnd() * 40, 6 + rnd() * 18, rnd() * 3, 0, Math.PI * 2); ctx.fill();
  }
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(40,18,6,0.22)' : 'rgba(160,98,58,0.16)';
    ctx.beginPath(); ctx.arc(rnd() * W, rnd() * H, 0.7 + rnd() * 0.9, 0, Math.PI * 2); ctx.fill();
  }
  // Practice-ball stripes near both tips, on the two panels either side of
  // the laces (u = 0.5 is the lace seam).
  ctx.fillStyle = '#ece8dc';
  for (const v of [0.2, 0.8]) ctx.fillRect(0.25 * W + 4, v * H - 7, 0.5 * W - 8, 14);
  // Four panel seams from tip to tip (u = 0, .25, .5, .75), with stitches.
  for (const u of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.fillStyle = 'rgba(24,9,3,0.85)'; ctx.fillRect(u * W - 1.5, 0, 3, H);
    ctx.fillStyle = 'rgba(190,150,110,0.45)';
    for (let y = 4; y < H; y += 7) { ctx.fillRect(u * W - 5, y, 2.5, 2); ctx.fillRect(u * W + 2.5, y, 2.5, 2); }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

let leatherNormalData = null;
function leatherNormal() {
  const W = 512, H = 256;
  if (!leatherNormalData) {
    const h = new Float32Array(W * H), data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, v = (y + 0.5) / H;
      // Pebbles, and the grooves of the four seams.
      const pebble = 1 - smoothstep(0.12, 0.6, cellular(u, v * 0.5, 72, 0.9));
      const seam = Math.min(...[0, 0.25, 0.5, 0.75, 1].map(q => Math.abs(u - q)));
      h[y * W + x] = 0.35 * pebble - 1.2 * (1 - smoothstep(0, 0.006, seam));
    }
    const at = (x, y) => h[Math.max(0, Math.min(H - 1, y)) * W + ((x + W) % W)];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, dx = at(x + 1, y) - at(x - 1, y), dy = at(x, y + 1) - at(x, y - 1);
      const n = 1 / Math.hypot(dx * 2, dy * 2, 1);
      data[o] = Math.round(255 * (0.5 - dx * n)); data[o + 1] = Math.round(255 * (0.5 - dy * n)); data[o + 2] = Math.round(255 * (0.5 + 0.5 * n)); data[o + 3] = 255;
    }
    leatherNormalData = data;
  }
  const t = new THREE.DataTexture(leatherNormalData, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// Roughness, metalness and sheen per kind of surface; baked per vertex because
// the squad's cloth, skin, rubber and metal share one material.
export const SURFACE = {
  cloth: [0.74, 0, 0.22], pants: [0.46, 0, 0.3], belt: [0.5, 0, 0], sock: [0.86, 0, 0.2], skin: [0.6, 0, 0.12],
  sleeve: [0.55, 0, 0.3], glove: [0.6, 0, 0.1], grip: [0.82, 0, 0], cleat: [0.36, 0, 0], sole: [0.6, 0, 0], tape: [0.9, 0, 0.15], towel: [1, 0, 0.3],
  collar: [0.85, 0, 0.2], plate: [0.45, 0, 0],
  shell: [0.2, 0.08, 0], padding: [0.9, 0, 0], facemask: [0.36, 0.55, 0], strap: [0.5, 0, 0], visor: [0.05, 0.85, 0],
};

// The squad's materials: one for every body (vertex colours carry the skin,
// glove and cleat colours and baked occlusion; the atlas carries the jerseys,
// their numbers and the striped pants and socks; the detail array carries the
// weave of each fabric), one clear-coated material for the helmets, and the
// ball.
export function createMaterials(players) {
  const atlas = buildJerseyAtlas(players);
  return {
    atlas,
    detail: detailTexture(),
    body: new THREE.MeshPhysicalMaterial({ name: 'athlete-body', map: atlas.texture, vertexColors: true, roughness: 1, metalness: 1, sheen: 1, sheenRoughness: 0.5, sheenColor: '#ffffff' }),
    helmet: new THREE.MeshPhysicalMaterial({ name: 'athlete-helmet', map: helmetTexture(), vertexColors: true, roughness: 1, metalness: 1, clearcoat: 1, clearcoatRoughness: 0.07 }),
    leather: new THREE.MeshStandardMaterial({ name: 'ball-leather', map: leatherTexture(), normalMap: leatherNormal(), normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.56 }),
    laces: new THREE.MeshStandardMaterial({ name: 'ball-laces', color: '#efece2', roughness: 0.75 }),
  };
}
