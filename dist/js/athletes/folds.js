import * as THREE from '../../vendor/three.module.js';
import { REGIONS } from './uniform.js';

// The folds of the uniform, as a normal map. The jersey atlas only shades
// folds into the colour; this layer bends the light on them: cloth bunched
// where the jersey goes into the belt and pulled from under the arms, rings
// round the sleeve, creases behind the knee and at the front of the hip, the
// pockets of the thigh and knee pads standing proud of the pants, the seat
// seam. One map serves every player: two atlas cells side by side, a jersey's
// (torso and sleeves) and the shared one (leg, hips), each laid out exactly as
// in the uniform atlas (REGIONS), so a part's place in it follows from its
// place in the atlas.
//
// Folds are written as heights in yards over each panel measured in yards;
// the map stores the slope (red, green: the tangent-space normal's x and y)
// and how deep in a crease the point lies (blue: 1 on open cloth).

export const FOLD_MAP = { width: 1024, height: 256 };

// A panel's size in yards: round the body, and along it.
const SIZE = { torso: [1.36, 0.435], sleeveL: [0.62, 0.29], sleeveR: [0.62, 0.29], leg: [0.62, 0.649], hips: [1.2, 0.244] };
const CELL = { torso: 0, sleeveL: 0, sleeveR: 0, leg: 1, hips: 1 };

// ridge(u0, v0, u1, v1, height, width): a fold along a line of the panel (uv
// 0..1; height and width in yards; a negative height is a crease), fading out
// toward both ends. pad(u0, v0, u1, v1, height): a raised pocket with soft edges.
const ridge = (u0, v0, u1, v1, h, w) => ({ u0, v0, u1, v1, h, w });
const pad = (u0, v0, u1, v1, h) => ({ u0, v0, u1, v1, h, pad: true });
const mm = 0.0011;   // a millimetre, in yards

function torsoFolds() {
  const list = [];
  // Bunched into the belt: short upright folds all the way round.
  [0.035, 0.1, 0.165, 0.22, 0.3, 0.37, 0.445, 0.53, 0.6, 0.67, 0.735, 0.8, 0.875, 0.95].forEach((u, i) => {
    list.push(ridge(u, -0.02, u + (i % 3 - 1) * 0.012, 0.1 + (i % 4) * 0.012, (i % 2 ? -2.6 : 3.2) * mm, 0.013 + (i % 3) * 0.003));
  });
  // Pulled from under each arm toward the middle of the chest and the back.
  for (const side of [0, 0.5, 1]) {
    for (const way of [-1, 1]) {
      list.push(ridge(side + way * 0.05, 0.37, side + way * 0.175, 0.11, 3 * mm, 0.016));
      list.push(ridge(side + way * 0.075, 0.38, side + way * 0.2, 0.16, -2.2 * mm, 0.012));
      list.push(ridge(side + way * 0.035, 0.27, side + way * 0.12, 0.09, 2 * mm, 0.012));
    }
  }
  // The cloth hanging off the edge of the pads, front and back.
  for (const centre of [0.25, 0.75]) {
    list.push(ridge(centre - 0.16, 0.405, centre + 0.16, 0.405, 2.4 * mm, 0.011));
    list.push(ridge(centre - 0.055, 0.32, centre - 0.045, 0.1, 1.6 * mm, 0.02));
    list.push(ridge(centre + 0.06, 0.34, centre + 0.05, 0.12, -1.4 * mm, 0.018));
  }
  return list;
}

const FOLDS = {
  torso: torsoFolds(),
  // v = 0 at the cuff, 1 at the top of the cap.
  sleeveL: [ridge(0.08, 0.17, 0.46, 0.15, 2 * mm, 0.008), ridge(0.52, 0.25, 0.94, 0.22, 1.8 * mm, 0.008), ridge(0.3, 0.09, 0.82, 0.11, -1.6 * mm, 0.007), ridge(0.2, 0.5, 0.72, 0.47, 1.4 * mm, 0.012)],
  sleeveR: [ridge(0.54, 0.17, 0.92, 0.15, 2 * mm, 0.008), ridge(0.06, 0.25, 0.48, 0.22, 1.8 * mm, 0.008), ridge(0.18, 0.09, 0.7, 0.11, -1.6 * mm, 0.007), ridge(0.28, 0.5, 0.8, 0.47, 1.4 * mm, 0.012)],
  // u = 0 and 1 the outside of the leg, 0.25 the front, 0.75 the back; v = 0
  // the cuff, 1 the hip.
  leg: [
    pad(0.14, 0.52, 0.36, 0.78, 2.6 * mm), pad(0.16, 0.11, 0.34, 0.24, 2.6 * mm),
    ridge(0.61, 0.15, 0.89, 0.155, -2.6 * mm, 0.007), ridge(0.62, 0.185, 0.88, 0.18, 2 * mm, 0.007), ridge(0.64, 0.215, 0.86, 0.21, -2 * mm, 0.007),
    ridge(0.06, 0.2, 0.13, 0.13, 1.4 * mm, 0.008), ridge(0.44, 0.2, 0.37, 0.13, 1.4 * mm, 0.008),
    ridge(0.14, 0.975, 0.38, 0.9, -2.6 * mm, 0.01), ridge(0.12, 0.93, 0.36, 0.85, 2 * mm, 0.011), ridge(0.42, 0.95, 0.58, 0.9, -1.6 * mm, 0.009),
  ],
  // u = 0.25 the fly, 0.75 the seat seam, 0 the left side; v = 0 the crotch, 1 the waist.
  hips: [
    ridge(0.245, 0.05, 0.12, 0.46, 2 * mm, 0.012), ridge(0.24, 0.1, 0.05, 0.3, -2 * mm, 0.011), ridge(0.245, 0.16, 0.16, 0.62, 1.5 * mm, 0.012),
    ridge(0.752, 0.02, 0.752, 0.92, -2.2 * mm, 0.006), ridge(0.78, 0.1, 0.94, 0.21, -2.6 * mm, 0.012),
    ridge(-0.1, 0.9, 1.1, 0.9, 2 * mm, 0.007),
  ],
};

// Height (yards) of a panel's folds at (x, y) yards.
function heightAt(folds, sx, sy, x, y) {
  let h = 0;
  for (const f of folds) {
    const ax = f.u0 * sx, ay = f.v0 * sy, bx = f.u1 * sx, by = f.v1 * sy;
    if (f.pad) {
      // Distance inside the rounded rectangle, eased over 12 mm.
      const d = Math.min(x - ax, bx - x, y - ay, by - y) / (12 * mm);
      if (d > 0) h += f.h * (d >= 1 ? 1 : d * d * (3 - 2 * d));
      continue;
    }
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    const px = x - ax - t * dx, py = y - ay - t * dy, r2 = (px * px + py * py) / (f.w * f.w);
    if (r2 < 9) h += f.h * Math.exp(-r2) * Math.sin(Math.PI * Math.min(1, Math.max(0, t * 1.04 - 0.02))) ** 0.6;
  }
  return h;
}

// The map's pixels (RGBA8, first row = v 0).
export function buildFoldData() {
  const { width: W, height: H } = FOLD_MAP, data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([128, 128, 255, 255], i * 4);
  const cellW = W / 2;
  for (const [name, folds] of Object.entries(FOLDS)) {
    const [rx, ry, rw, rh] = REGIONS[name], [sx, sy] = SIZE[name];
    const x0 = Math.round(CELL[name] * cellW + rx * cellW), y0 = Math.round(ry * H), w = Math.round(rw * cellW), h = Math.round(rh * H);
    const stepX = sx / w, stepY = sy / h, field = new Float32Array((w + 2) * (h + 2));
    // Panels wrap round the body: a fold that runs off one edge comes back on the other.
    const at = (x, y) => heightAt(folds, sx, sy, x, y) + heightAt(folds, sx, sy, x + sx, y) + heightAt(folds, sx, sy, x - sx, y);
    for (let j = 0; j < h + 2; j++) for (let i = 0; i < w + 2; i++) field[j * (w + 2) + i] = at((i - 0.5) * stepX, (j - 0.5) * stepY);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const c = (j + 1) * (w + 2) + i + 1;
        const nx = -(field[c + 1] - field[c - 1]) / (2 * stepX), ny = -(field[c + w + 2] - field[c - w - 2]) / (2 * stepY), len = Math.hypot(nx, ny, 1);
        const o = ((y0 + j) * W + x0 + i) * 4;
        data[o] = Math.round(127.5 + 127.5 * nx / len);
        data[o + 1] = Math.round(127.5 + 127.5 * ny / len);
        data[o + 2] = Math.round(255 * (1 - 0.4 * Math.min(1, Math.max(0, -field[c] / (2.5 * mm)))));
      }
    }
  }
  return data;
}

export function foldTexture() {
  const t = new THREE.DataTexture(buildFoldData(), FOLD_MAP.width, FOLD_MAP.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.name = 'athlete-folds';
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// Where a point of a panel lies in the fold map: `cell` 0 for a player's own
// cell, 1 for the shared one; (u, v) the point's place in the cell (0..1).
export const foldUV = (cell, u, v) => [(cell + u) / 2, v];
