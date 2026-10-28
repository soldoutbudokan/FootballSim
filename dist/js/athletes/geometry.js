import * as THREE from '../../vendor/three.module.js';
import { TAU, smoothstep } from './math.js';

// Procedural geometry for the athletes and the ball. Every body part is built
// once and shared by all 22 rigs through instancing, so these builders favour
// smooth silhouettes over low triangle counts only where it shows.

// ---------------------------------------------------------------------------
// Lofts: tubes along +Y whose cross-sections are superellipses. Key rings are
// {y, w, d, n?, x?, z?}: half width (x), half depth (z), squareness exponent
// (2 = ellipse, higher = squarer) and an optional centre offset.

function superellipse(t, w, d, n) {
  const c = Math.cos(t), s = Math.sin(t), e = 2 / n;
  return [w * Math.sign(c) * Math.abs(c) ** e, d * Math.sign(s) * Math.abs(s) ** e];
}

function catmull(a, b, c, d, u) {
  return 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
}

function interpolateRings(keys, subdiv) {
  const full = keys.map(k => ({ x: 0, z: 0, n: 2, ...k }));
  const rings = [];
  for (let i = 0; i < full.length - 1; i++) {
    const k0 = full[Math.max(0, i - 1)], k1 = full[i], k2 = full[i + 1], k3 = full[Math.min(full.length - 1, i + 2)];
    for (let s = 0; s < subdiv; s++) {
      const u = s / subdiv;
      const ring = { y: k1.y + (k2.y - k1.y) * u };
      for (const key of ['w', 'd', 'n', 'x', 'z']) ring[key] = catmull(k0[key], k1[key], k2[key], k3[key], u);
      ring.w = Math.max(ring.w, 1e-4); ring.d = Math.max(ring.d, 1e-4); ring.n = Math.max(ring.n, 1.2);
      rings.push(ring);
    }
  }
  rings.push(full[full.length - 1]);
  return rings;
}

// Averages the duplicated normals along a UV seam so lofts shade smoothly.
function weldSeam(geometry, rows, cols) {
  const n = geometry.attributes.normal;
  for (let i = 0; i < rows; i++) {
    const a = i * cols, b = i * cols + cols - 1;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const len = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / len, y / len, z / len); n.setXYZ(b, x / len, y / len, z / len);
  }
}

// `ao(v, t)` optionally bakes ambient occlusion into vertex colours, with v
// running from the first key (0) to the last (1) and t the angle around the
// loft (0 = +X). Keys may run up or down (limbs are authored from the joint
// downwards); `capTop` and `capBottom` always mean the upper and lower end,
// and faces always point outwards.
export function loft(keys, { radial = 16, subdiv = 3, capTop = true, capBottom = true, flipU = false, ao = null } = {}) {
  const rings = interpolateRings(keys, subdiv);
  const positions = [], uvs = [], indices = [], colors = [];
  const cols = radial + 1, y0 = rings[0].y, y1 = rings[rings.length - 1].y, span = (y1 - y0) || 1;
  const shade = (v, t) => { const k = ao ? ao(v, t) : 1; colors.push(k, k, k); };
  for (const r of rings) {
    for (let j = 0; j <= radial; j++) {
      const t = j / radial * TAU, [px, pz] = superellipse(t, r.w, r.d, r.n), v = (r.y - y0) / span;
      positions.push(r.x + px, r.y, r.z + pz);
      uvs.push(flipU ? 1 - j / radial : j / radial, v);
      shade(v, t);
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * cols + j, b = (i + 1) * cols + j, c = a + 1, d = b + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const cap = (ring, rowStart, up) => {
    const centre = positions.length / 3;
    positions.push(ring.x, ring.y, ring.z);
    uvs.push(0.5, (ring.y - y0) / span);
    shade((ring.y - y0) / span, Math.PI / 2);
    for (let j = 0; j < radial; j++) {
      const a = rowStart + j, b = a + 1;
      if (up) indices.push(centre, b, a); else indices.push(centre, a, b);
    }
  };
  // Built as if the keys ascend; a descending loft is flipped inside out
  // afterwards, which turns its first-ring cap into the top one.
  const descending = y1 < y0;
  if (descending ? capTop : capBottom) cap(rings[0], 0, false);
  if (descending ? capBottom : capTop) cap(rings[rings.length - 1], (rings.length - 1) * cols, true);
  if (descending) {
    for (let i = 0; i < indices.length; i += 3) { const t = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = t; }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  weldSeam(geometry, rings.length, cols);
  return geometry;
}

// ---------------------------------------------------------------------------
// Utilities

export function mergeGeometries(list) {
  const positions = [], normals = [], uvs = [], colors = [], indices = [];
  let offset = 0;
  for (const g of list) {
    const geo = g.index ? g : g.toNonIndexed();
    const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv, col = geo.attributes.color;
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
      uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      colors.push(col ? col.getX(i) : 1, col ? col.getY(i) : 1, col ? col.getZ(i) : 1);
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) indices.push(geo.index.getX(i) + offset);
    else for (let i = 0; i < p.count; i++) indices.push(i + offset);
    offset += p.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  merged.setIndex(indices);
  return merged;
}

// Uniform vertex colour, so parts can be merged with differently tinted parts.
export function tint(geometry, color) {
  const c = new THREE.Color(color), count = geometry.attributes.position.count, data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { data[i * 3] = c.r; data[i * 3 + 1] = c.g; data[i * 3 + 2] = c.b; }
  geometry.setAttribute('color', new THREE.BufferAttribute(data, 3));
  return geometry;
}

// Mirror image across the YZ plane with corrected winding (left/right gloves).
export function mirrorX(geometry) {
  const g = geometry.clone();
  g.scale(-1, 1, 1);
  const index = g.index.array;
  for (let i = 0; i < index.length; i += 3) { const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t; }
  g.index.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function tube(points, radius, radial = 6, tubular = 20) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, tubular, radius, radial, false);
}

function ellipsoid(x, y, z, rx, ry, rz, w = 12, h = 8) {
  const g = new THREE.SphereGeometry(1, w, h);
  g.scale(rx, ry, rz); g.translate(x, y, z);
  return g;
}

// ---------------------------------------------------------------------------
// Helmet. Spherical parameterisation around the shell centre: theta runs
// around the vertical axis (0 = front, +PI/2 = the athlete's left, +X) and phi
// down from the crown. The lower edge depends on theta, which carves the face
// opening, the jaw flaps and the lower back of the shell in one surface.

export const HELMET = { rx: 0.128, ry: 0.135, rz: 0.152 };
const DEG = Math.PI / 180;

function helmetEdge(theta) {
  const a = Math.abs(theta);
  return (96 + 50 * smoothstep(36 * DEG, 72 * DEG, a) - 20 * smoothstep(112 * DEG, 165 * DEG, a)) * DEG;
}

function helmetPoint(theta, phi, scale, out) {
  const sx = Math.sin(phi) * Math.sin(theta), sy = Math.cos(phi), sz = Math.sin(phi) * Math.cos(theta);
  let x = HELMET.rx * sx, y = HELMET.ry * sy, z = HELMET.rz * sz;
  // Jaw flaps hug the face; the lower back flares out over the neck.
  x *= 1 - 0.13 * smoothstep(-0.25, -0.85, sy);
  if (sz < 0) z *= 1 + 0.07 * smoothstep(0, -0.7, sy) * -sz;
  // A slightly fuller, flatter crown than a pure ellipsoid.
  if (sy > 0) y *= 1 - 0.06 * sy * sy;
  out.push(x * scale, y * scale, z * scale);
}

export function helmetShell({ columns = 30, rows = 12, inner = 0.925 } = {}) {
  const positions = [], uvs = [], indices = [];
  const cols = columns + 1, layer = (rows + 1) * cols;
  for (const scale of [1, inner]) {
    for (let i = 0; i <= rows; i++) {
      for (let j = 0; j <= columns; j++) {
        const theta = -Math.PI + j / columns * TAU, phi = helmetEdge(theta) * i / rows;
        helmetPoint(theta, phi, scale, positions);
        const x = positions[positions.length - 3];
        // u across the shell (centre stripe), v down from the crown (edge trim).
        uvs.push(scale === 1 ? 0.5 + x / (2 * HELMET.rx) : 0.02, scale === 1 ? 1 - i / rows : 0.02);
      }
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < columns; j++) {
      const a = i * cols + j, b = a + cols, c = a + 1, d = b + 1;
      indices.push(a, b, c, b, d, c);
      indices.push(layer + a, layer + c, layer + b, layer + b, layer + c, layer + d);
    }
  }
  for (let j = 0; j < columns; j++) {
    const o = rows * cols + j, inn = layer + o;
    indices.push(o, inn, o + 1, inn, inn + 1, o + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  weldSeam(geometry, rows + 1, cols);
  const n = geometry.attributes.normal;
  for (let j = 0; j <= columns; j++) { n.setXYZ(j, 0, 1, 0); n.setXYZ(layer + j, 0, -1, 0); }
  return geometry;
}

// Facemask, clips and ear holes in one vertex-coloured mesh (shell-local).
// `low`: the distant-athlete version, thinner tubes with fewer segments and
// no clips or ear holes.
export function helmetHardware({ low = false } = {}) {
  const parts = [];
  const bar = (points, r = 0.0072, segments = 14) => parts.push(tint(low ? tube(points, r * 1.15, 3, Math.min(segments, 6)) : tube(points, r, 4, segments), '#8e949b'));
  bar([[-0.083, -0.022, 0.112], [-0.072, -0.034, 0.163], [0, -0.041, 0.19], [0.072, -0.034, 0.163], [0.083, -0.022, 0.112]]);
  bar([[-0.088, -0.074, 0.072], [-0.068, -0.086, 0.152], [0, -0.092, 0.18], [0.068, -0.086, 0.152], [0.088, -0.074, 0.072]]);
  bar([[-0.074, -0.102, 0.048], [-0.052, -0.133, 0.122], [0, -0.146, 0.147], [0.052, -0.133, 0.122], [0.074, -0.102, 0.048]]);
  for (const s of [-1, 1]) {
    bar([[s * 0.031, -0.041, 0.188], [s * 0.032, -0.092, 0.178], [s * 0.03, -0.145, 0.146]], 0.0065, 6);
    bar([[s * 0.083, -0.022, 0.112], [s * 0.089, -0.05, 0.095], [s * 0.088, -0.074, 0.072], [s * 0.074, -0.102, 0.048]], 0.0068, 6);
    if (low) continue;
    bar([[s * 0.052, -0.004, 0.148], [s * 0.058, -0.022, 0.163], [s * 0.062, -0.036, 0.168]], 0.0062, 4);
    parts.push(tint(ellipsoid(s * 0.052, -0.002, 0.146, 0.014, 0.01, 0.01, 6, 4), '#7d838a'));
    parts.push(tint(ellipsoid(s * 0.084, -0.036, 0.104, 0.011, 0.016, 0.012, 6, 4), '#7d838a'));
    const ear = new THREE.CylinderGeometry(0.019, 0.019, 0.01, 10, 1);
    ear.rotateZ(Math.PI / 2); ear.translate(s * 0.121, -0.04, 0.004);
    parts.push(tint(ear, '#15181c'));
  }
  return mergeGeometries(parts);
}

export function chinStrap() {
  const parts = [];
  for (const s of [-1, 1]) parts.push(tube([[s * 0.104, -0.09, 0.03], [s * 0.07, -0.142, 0.075], [s * 0.032, -0.165, 0.106]], 0.0058, 4, 8));
  parts.push(ellipsoid(0, -0.162, 0.112, 0.042, 0.028, 0.026, 10, 6));
  return mergeGeometries(parts);
}

export function helmetVisor({ low = false } = {}) {
  const positions = [], indices = [], cols = low ? 7 : 13, rows = low ? 2 : 4;
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      const theta = (-46 + 92 * j / cols) * DEG, phi = (94 + 22 * i / rows) * DEG;
      helmetPoint(theta, phi, 1.0, positions);
    }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const a = i * (cols + 1) + j, b = a + cols + 1;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices); g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Hands and feet

// Left glove: palm faces +X, thumb on the -Z side, fingers along -Y.
export function glove({ low = false } = {}) {
  const detail = low ? { radial: 6, subdiv: 1 } : { radial: 8, subdiv: 2 };
  const hand = loft([
    { y: 0.012, w: 0.02, d: 0.03 },
    { y: -0.02, w: 0.024, d: 0.039 },
    { y: -0.07, w: 0.024, d: 0.045, n: 2.4 },
    { y: -0.115, w: 0.02, d: 0.043, n: 2.6 },
    { y: -0.165, w: 0.016, d: 0.037, n: 2.4 },
    { y: -0.188, w: 0.009, d: 0.024 },
  ], detail);
  const thumb = loft([
    { y: 0, w: 0.014, d: 0.016 }, { y: -0.04, w: 0.012, d: 0.013 }, { y: -0.068, w: 0.006, d: 0.007 },
  ], detail);
  thumb.rotateX(-0.55); thumb.rotateZ(-0.25); thumb.translate(0.01, -0.035, -0.035);
  const g = mergeGeometries([hand, thumb]);
  g.computeVertexNormals();
  return g;
}

// Cleat around the ankle joint: heel at -Z, toe at +Z, sole at y = -0.092.
export function cleat({ low = false } = {}) {
  const g = loft([
    { y: -0.078, w: 0.028, d: 0.03, z: 0.052, n: 2.6 },
    { y: -0.06, w: 0.038, d: 0.043, z: 0.048, n: 2.6 },
    { y: -0.01, w: 0.045, d: 0.047, z: 0.045, n: 2.8 },
    { y: 0.06, w: 0.049, d: 0.03, z: 0.062, n: 2.8 },
    { y: 0.13, w: 0.047, d: 0.022, z: 0.07, n: 2.6 },
    { y: 0.19, w: 0.036, d: 0.016, z: 0.075, n: 2.4 },
    { y: 0.218, w: 0.014, d: 0.009, z: 0.078 },
  ], low ? { radial: 6, subdiv: 1 } : { radial: 10, subdiv: 2 });
  g.rotateX(Math.PI / 2);
  const p = g.attributes.position, colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const sole = p.getY(i) < -0.079 ? 0.14 : 1;
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = sole;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

// ---------------------------------------------------------------------------
// The practice football: 11 in long, 6.7 in across, long axis along +Z with
// the laces on top (+Y).

export const BALL = { length: 0.305, radius: 0.093 };

function ballRadiusAt(z) {
  const t = Math.min(1, Math.abs(2 * z / BALL.length));
  return BALL.radius * Math.max(0, 1 - t ** 2.05) ** 0.72;
}

export function football() {
  const points = [];
  for (let i = 0; i <= 28; i++) {
    const y = -BALL.length / 2 + BALL.length * i / 28;
    points.push(new THREE.Vector2(Math.max(ballRadiusAt(y), 0.0015), y));
  }
  const g = new THREE.LatheGeometry(points, 28);
  // Lathe axis Y -> ball axis Z; the lathe's phi = PI seam ends up on top.
  g.rotateX(Math.PI / 2);
  return g;
}

// Laces on top of the ball: a lace strip along the seam that follows the
// curve of the ball, crossed by eight stitches, each tilted to the surface.
export function footballLaces() {
  const parts = [], lift = 0.0025;
  const surface = z => ballRadiusAt(z) + lift;
  const points = [];
  for (let i = 0; i <= 12; i++) {
    const z = -0.07 + 0.14 * i / 12;
    points.push(new THREE.Vector3(0, surface(z), z));
  }
  const strip = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, 0.0042, 5, false);
  strip.scale(1.25, 0.8, 1);
  parts.push(strip);
  for (let i = 0; i < 8; i++) {
    const z = -0.056 + i * 0.016, slope = (surface(z + 0.002) - surface(z - 0.002)) / 0.004;
    const box = new THREE.BoxGeometry(0.032, 0.0055, 0.0055);
    // Bend the stitch around the ball's girth.
    const p = box.attributes.position;
    for (let k = 0; k < p.count; k++) p.setY(k, p.getY(k) - 2.6 * p.getX(k) ** 2);
    box.computeVertexNormals();
    box.rotateX(-Math.atan(slope));
    box.translate(0, surface(z) + 0.0012, z);
    parts.push(box);
  }
  return mergeGeometries(parts);
}
