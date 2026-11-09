import * as THREE from '../../vendor/three.module.js';
import { TAU, smoothstep } from './math.js';

// Procedural geometry for the athletes and the ball. Every body part is built
// once and baked into the squad meshes by each rig (rig.js), so these builders
// spend their triangles where the silhouette shows: muscle and pad forms are
// sculpted into the lofts instead of being left to shading.

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

// Angular distance between two angles, in 0..PI.
export function angleBetween(a, b) {
  const d = Math.abs(a - b) % TAU;
  return d > Math.PI ? TAU - d : d;
}

// A sculpt function for `loft`: a sum of soft mounds on the surface of the
// tube. Each mound is {y, t, sy, st, a}: centre height and angle (0 = +X,
// PI/2 = +Z), half sizes along and around, and height in yards (negative for
// a groove). `flat` (0..1) squares the mound off into a plate with soft
// edges: a pad under the cloth instead of a muscle belly.
export function mounds(list) {
  return (y, t) => {
    let h = 0;
    for (const m of list) {
      const dy = (y - m.y) / m.sy, dt = m.st ? angleBetween(t, m.t) / m.st : 0;
      const r2 = dy * dy + dt * dt;
      if (r2 > 6) continue;
      const g = Math.exp(-r2);
      h += m.a * (m.flat ? Math.min(1, g * (1 + 1.6 * m.flat)) : g);
    }
    return h;
  };
}

// `ao(v, t)` optionally bakes ambient occlusion into vertex colours, with v
// running from the first key (0) to the last (1) and t the angle around the
// loft (0 = +X). `sculpt(y, t)` pushes the surface out (yards) along the
// ring's radius: muscle bellies, pads under the cloth, wrinkles. Keys may run
// up or down (limbs are authored from the joint downwards); `capTop` and
// `capBottom` always mean the upper and lower end, and faces always point
// outwards. A partial arc builds a fitted cloth panel; unlike a full tube,
// its two edges are not welded.
export function loft(keys, { radial = 16, subdiv = 3, capTop = true, capBottom = true, flipU = false, ao = null, sculpt = null, arcStart = 0, arcLength = TAU } = {}) {
  const rings = interpolateRings(keys, subdiv);
  const positions = [], uvs = [], indices = [], colors = [];
  const cols = radial + 1, y0 = rings[0].y, y1 = rings[rings.length - 1].y, span = (y1 - y0) || 1;
  const shade = (v, t) => { const k = ao ? ao(v, t) : 1; colors.push(k, k, k); };
  for (const r of rings) {
    for (let j = 0; j <= radial; j++) {
      const t = arcStart + (j === radial && arcLength === TAU ? 0 : j / radial * arcLength), v = (r.y - y0) / span;
      let [px, pz] = superellipse(t, r.w, r.d, r.n);
      if (sculpt) {
        const h = sculpt(r.y, t), len = Math.hypot(px, pz) || 1;
        px += px / len * h; pz += pz / len * h;
      }
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
  if (Math.abs(arcLength - TAU) < 1e-6) weldSeam(geometry, rings.length, cols);
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

// Multiplies the vertex colours by shade(x, y, z): baked occlusion or a
// second tone on part of a mesh.
export function shadeBy(geometry, shade) {
  const p = geometry.attributes.position;
  if (!geometry.attributes.color) tint(geometry, '#ffffff');
  const c = geometry.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const k = shade(p.getX(i), p.getY(i), p.getZ(i));
    c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
  }
  return geometry;
}

// Mirror image across the YZ plane with corrected winding.
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

function box(x, y, z, sx, sy, sz, rot = null) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (rot) { g.rotateX(rot[0]); g.rotateY(rot[1]); g.rotateZ(rot[2]); }
  g.translate(x, y, z);
  return g;
}

// ---------------------------------------------------------------------------
// Helmet. Spherical parameterisation around the shell centre: theta runs
// around the vertical axis (0 = front, +PI/2 = the athlete's left, +X) and phi
// down from the crown. The lower edge depends on theta, which carves the face
// opening, the long jaw flaps and the lower back of the shell in one surface.
// The shell is a modern one: longer than it is wide, with a raised centre
// spine from the brow over the crown, a brow bumper, cheek flaps that reach
// forward along the jaw, and a flared rear bumper over the neck.

export const HELMET = { rx: 0.128, ry: 0.135, rz: 0.156 };
const DEG = Math.PI / 180;
const HELMET_PHI_MAX = 152 * DEG;
// Texels of the helmet texture (uniform.js) for parts that take their colour
// from vertex colours, and for the dark padding and edge trim.
export const HELMET_UV = { white: [0.03, 0.03], dark: [0.97, 0.03] };

// The face opening is a rounded rectangle: a level brow, then the front edge
// of the cheek flap dropping almost straight down to the jaw line, which runs
// level back past the ear before the edge climbs to the nape.
function helmetEdge(theta) {
  const a = Math.abs(theta);
  return (85 + 63 * smoothstep(35 * DEG, 49 * DEG, a) - 19 * smoothstep(100 * DEG, 150 * DEG, a)) * DEG;
}

// Column angles (degrees, one side): close together across the corner of the
// face opening, where the edge turns.
const HELMET_COLUMNS = [0, 10, 20, 29, 36, 40, 44, 48, 52, 60, 70, 82, 94, 106, 118, 130, 142, 154, 167, 180];
const HELMET_COLUMNS_LOW = [0, 18, 36, 43, 50, 70, 95, 120, 150, 180];

function helmetPoint(theta, phi, scale, out) {
  // A dome down to the widest line; below it the shell is no longer a ball
  // but drops as a wall past the ears and the jaw, tucking in only slightly.
  const below = Math.max(0, (phi - Math.PI / 2) / (HELMET_PHI_MAX - Math.PI / 2));
  const girth = below > 0 ? 1 - 0.17 * below * below : Math.sin(phi), sy = below > 0 ? -0.95 * below : Math.cos(phi);
  const sx = girth * Math.sin(theta), sz = girth * Math.cos(theta);
  let x = HELMET.rx * sx, y = HELMET.ry * sy, z = HELMET.rz * sz;
  const a = Math.abs(theta), edge = helmetEdge(theta), rim = phi / edge;
  // The sides are flatter than an ellipsoid; the cheek flaps hug the face
  // and reach forward along the jaw.
  x *= 1 - 0.05 * smoothstep(0.5, 1, Math.abs(sx)) - 0.1 * smoothstep(-0.2, -0.9, sy);
  if (sz > 0) z += 0.012 * smoothstep(-0.2, -0.75, sy) * smoothstep(0.1, 0.5, Math.abs(sx));
  // The back is longer and fuller low down, then tucks in over the neck.
  if (sz < 0) z *= 1 + 0.1 * -sz * (1 - 0.9 * smoothstep(-0.2, -0.7, sy));
  // A slightly flatter crown than a pure ellipsoid.
  if (sy > 0) y *= 1 - 0.05 * sy * sy;
  // Raised centre spine, fading out towards the nape.
  let lift = 0.05 * Math.exp(-((x / 0.036) ** 2)) * smoothstep(-0.2, 0.45, sy) * (sz > 0 ? 1 : 1 - 0.6 * smoothstep(0, 0.8, -sz));
  // Shallow channels either side of the spine.
  lift -= 0.022 * Math.exp(-(((Math.abs(x) - 0.066) / 0.02) ** 2)) * smoothstep(0.1, 0.5, sy) * smoothstep(-0.6, 0.2, sz);
  // Brow bumper above the face opening and the rear bumper at the nape.
  lift += 0.055 * smoothstep(0.84, 1, rim) * (1 - smoothstep(28 * DEG, 38 * DEG, a));
  lift += 0.05 * smoothstep(0.86, 1, rim) * smoothstep(125 * DEG, 155 * DEG, a);
  const k = scale * (1 + lift);
  out.push(x * k, y * k, z * k);
}

// u, v on an azimuthal disc seen from above: the centre stripe is the line
// u = 0.5, the front of the shell is the top of the texture.
function helmetUV(theta, phi, out) {
  const r = 0.5 * phi / HELMET_PHI_MAX;
  out.push(0.5 + r * Math.sin(theta), 0.5 + r * Math.cos(theta));
}

export function helmetShell({ low = false, inner = 0.93 } = {}) {
  const half = low ? HELMET_COLUMNS_LOW : HELMET_COLUMNS, rows = low ? 7 : 14;
  // All the way round, from the back (-180) by the right side to the back.
  const ring = h => [...h.slice(1).reverse().map(d => -d), ...h].map(d => d * DEG);
  const outer = ring(half), padded = ring(half.filter((d, i) => i % 2 === 0 || i === half.length - 1));
  const positions = [], uvs = [], indices = [];
  const grid = (angles, rws, scale, uv, flip) => {
    const base = positions.length / 3, stride = angles.length;
    for (let i = 0; i <= rws; i++) {
      for (const theta of angles) {
        const phi = helmetEdge(theta) * i / rws;
        helmetPoint(theta, phi, scale, positions);
        if (uv) uvs.push(...uv); else helmetUV(theta, phi, uvs);
      }
    }
    for (let i = 0; i < rws; i++) {
      for (let j = 0; j < stride - 1; j++) {
        const a = base + i * stride + j, b = a + stride, c = a + 1, d = b + 1;
        if (flip) indices.push(a, c, b, b, c, d); else indices.push(a, b, c, b, d, c);
      }
    }
    return base;
  };
  grid(outer, rows, 1, null, false);
  const innerBase = grid(padded, Math.max(4, rows >> 1), inner, HELMET_UV.dark, true);
  // The edge trim: a dark band from the outer edge to the padding inside.
  const rim = positions.length / 3;
  for (const theta of outer) {
    const phi = helmetEdge(theta);
    helmetPoint(theta, phi, 1.005, positions); uvs.push(...HELMET_UV.dark);
    helmetPoint(theta, phi, inner, positions); uvs.push(...HELMET_UV.dark);
  }
  for (let j = 0; j < outer.length - 1; j++) {
    const o = rim + j * 2, inn = o + 1;
    indices.push(o, inn, o + 2, inn, inn + 2, o + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  weldSeam(geometry, rows + 1, outer.length);
  const n = geometry.attributes.normal;
  for (let j = 0; j < outer.length; j++) n.setXYZ(j, 0, 1, 0);
  for (let j = 0; j < padded.length; j++) n.setXYZ(innerBase + j, 0, -1, 0);
  return geometry;
}

// Facemask and its clips in one vertex-coloured mesh (shell-local). The bars
// spring from the front edges of the cheek flaps. `cage`: the lineman's mask,
// with an extra bar across the eyes and three uprights to the brow; otherwise
// the open skill-position mask. `low`: the distant-athlete version, thicker
// tubes with fewer segments and no clips.
export function helmetHardware({ low = false, cage = false } = {}) {
  const parts = [], steel = '#a3a8ae', clip = '#14171b';
  const bar = (points, r = 0.0068, segments = 10) => parts.push(tint(low ? tube(points, r * 1.25, 3, Math.max(2, segments >> 1)) : tube(points, r, 5, segments), steel));
  const across = (side, mid, front, r, segments) => bar([[-side[0], side[1], side[2]], [-mid[0], mid[1], mid[2]], [0, front[1], front[2]], [mid[0], mid[1], mid[2]], side], r, segments);
  const sides = [[0.093, 0.0, 0.11], [0.097, -0.05, 0.107], [0.096, -0.094, 0.101], [0.088, -0.13, 0.09]];
  // The frame: a brow bar tucked under the bumper, bars under the eyes, at
  // the mouth and at the chin, tied together down both sides.
  across(sides[0], [0.07, 0.004, 0.154], [0, 0.006, 0.174]);
  across(sides[1], [0.08, -0.056, 0.162], [0, -0.06, 0.202]);
  across(sides[2], [0.077, -0.101, 0.158], [0, -0.106, 0.198]);
  across(sides[3], [0.062, -0.141, 0.14], [0, -0.148, 0.17]);
  if (cage) across([0.096, -0.025, 0.109], [0.078, -0.027, 0.16], [0, -0.028, 0.192], 0.0058);
  for (const s of [-1, 1]) {
    bar(sides.map(([x, y, z]) => [s * x, y, z]), 0.0062, 6);
    bar([[s * 0.03, -0.059, 0.197], [s * 0.031, -0.105, 0.193], [s * 0.029, -0.146, 0.165]], 0.0058, 4);
    if (cage) bar([[s * 0.05, 0.005, 0.163], [s * 0.053, -0.027, 0.177], [s * 0.054, -0.058, 0.186]], 0.0058, 3);
    if (low) continue;
    // Clips that hold the mask to the cheek flaps.
    parts.push(tint(box(s * 0.099, -0.024, 0.098, 0.005, 0.013, 0.017, [0, s * 0.7, 0]), clip));
    parts.push(tint(box(s * 0.098, -0.096, 0.093, 0.005, 0.013, 0.017, [0, s * 0.7, 0]), clip));
  }
  if (cage) bar([[0, 0.006, 0.174], [0, -0.028, 0.192], [0, -0.06, 0.202]], 0.0058, 3);
  return mergeGeometries(parts);
}

// Chin cup with a high and a low strap to each side of the shell.
export function chinStrap() {
  const parts = [];
  for (const s of [-1, 1]) {
    parts.push(tube([[s * 0.108, -0.035, 0.045], [s * 0.094, -0.108, 0.078], [s * 0.04, -0.158, 0.11]], 0.005, 4, 6));
    parts.push(tube([[s * 0.104, -0.1, 0.005], [s * 0.084, -0.143, 0.06], [s * 0.036, -0.17, 0.102]], 0.005, 4, 6));
  }
  parts.push(ellipsoid(0, -0.166, 0.112, 0.043, 0.025, 0.026, 10, 6));
  return mergeGeometries(parts);
}

// The tinted shield between the brow bar and the bar under the eyes.
export function helmetVisor({ low = false } = {}) {
  const positions = [], indices = [], cols = low ? 6 : 12, rows = low ? 1 : 3;
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      const theta = (-84 + 168 * j / cols) * DEG, s = i / rows;
      positions.push(0.092 * Math.sin(theta), 0.006 - 0.062 * s, 0.103 + (0.064 + 0.027 * s) * Math.cos(theta));
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

// A compact head with a jaw, cheekbones and brow. The face stays behind the
// facemask; its profile is visible through the open cage on unvisored players.
export function athleteFace({ low = false } = {}) {
  const head = loft([
    { y: -0.105, w: 0.035, d: 0.04, z: 0.018, n: 2.5 },
    { y: -0.084, w: 0.057, d: 0.057, z: 0.013, n: 2.8 },
    { y: -0.04, w: 0.069, d: 0.07, z: 0.005, n: 2.5 },
    { y: 0.005, w: 0.078, d: 0.079, n: 2.1 },
    { y: 0.054, w: 0.074, d: 0.083, z: -0.005 },
    { y: 0.093, w: 0.061, d: 0.069, z: -0.011 },
    { y: 0.113, w: 0.028, d: 0.037, z: -0.011 },
  ], {
    radial: low ? 8 : 12, subdiv: low ? 1 : 2,
    // Eye sockets, cheekbones and the mouth, on the front of the head only.
    sculpt: low ? null : mounds([
      { y: 0.022, t: Math.PI / 2 - 0.42, sy: 0.012, st: 0.2, a: -0.007 }, { y: 0.022, t: Math.PI / 2 + 0.42, sy: 0.012, st: 0.2, a: -0.007 },
      { y: -0.012, t: Math.PI / 2 - 0.62, sy: 0.016, st: 0.24, a: 0.004 }, { y: -0.012, t: Math.PI / 2 + 0.62, sy: 0.016, st: 0.24, a: 0.004 },
      { y: 0.045, t: Math.PI / 2, sy: 0.012, st: 0.7, a: 0.004 },
      { y: -0.075, t: Math.PI / 2, sy: 0.014, st: 0.3, a: 0.005 },
    ]),
    // The helmet shades the brow, the temples and everything behind them.
    ao: (v, t) => (0.62 + 0.38 * smoothstep(-0.2, 0.75, Math.sin(t))) * (1 - 0.35 * smoothstep(0.6, 0.85, v)),
  });
  if (low) return head;
  const nose = ellipsoid(0, -0.006, 0.08, 0.014, 0.027, 0.021, 6, 4);
  return mergeGeometries([head, nose]);
}

export function faceDetails() {
  const parts = [];
  for (const s of [-1, 1]) {
    parts.push(tint(ellipsoid(s * 0.031, 0.036, 0.073, 0.02, 0.0045, 0.005, 6, 3), '#2a1f1a'));   // brow
    parts.push(tint(ellipsoid(s * 0.031, 0.022, 0.0722, 0.012, 0.0046, 0.004, 6, 3), '#cfc9c0')); // eye
    parts.push(tint(ellipsoid(s * 0.031, 0.022, 0.074, 0.0052, 0.0046, 0.003, 6, 3), '#20140d')); // iris
    // Eye-black strips are subdued and sit on the cheekbone, below the eye.
    parts.push(tint(ellipsoid(s * 0.035, 0.003, 0.0765, 0.019, 0.005, 0.003, 6, 3), '#23211e'));
  }
  parts.push(tint(ellipsoid(0, -0.052, 0.0745, 0.022, 0.0035, 0.003, 6, 3), '#5a3c33'));
  return mergeGeometries(parts);
}

// ---------------------------------------------------------------------------
// Hands and feet

// Left glove: palm faces +X, thumb on the -Z side, fingers along -Y. The
// wrist is at the origin and the fingertips about 0.18 yd below it. The four
// fingers are separate and slightly curled, the thumb angles forward. `low`:
// the distant-athlete mitten.
export function glove({ low = false } = {}) {
  if (low) {
    const hand = loft([
      { y: 0.012, w: 0.026, d: 0.029 }, { y: -0.04, w: 0.024, d: 0.044 },
      { y: -0.1, w: 0.022, d: 0.048, x: 0.004, n: 2.5 }, { y: -0.15, w: 0.02, d: 0.04, x: 0.016 }, { y: -0.176, w: 0.009, d: 0.024, x: 0.026 },
    ], { radial: 6, subdiv: 1 });
    return hand;
  }
  const parts = [];
  // Wrist band, the back of the hand with its knuckle ridge, and the palm.
  parts.push(loft([
    { y: 0.014, w: 0.028, d: 0.031 }, { y: -0.012, w: 0.026, d: 0.032 },
    { y: -0.04, w: 0.021, d: 0.042, n: 2.4 }, { y: -0.075, w: 0.019, d: 0.048, x: 0.001, n: 2.8 },
    { y: -0.098, w: 0.0185, d: 0.049, x: 0.003, n: 3 }, { y: -0.111, w: 0.013, d: 0.046, x: 0.006, n: 3 },
  ], { radial: 10, subdiv: 1 }));
  const lengths = [0.07, 0.079, 0.073, 0.057], drop = [-0.004, 0, -0.003, -0.012];
  lengths.forEach((L, i) => {
    const r = i === 3 ? 0.0098 : 0.0112;
    const f = loft([
      { y: 0.006, w: r, d: r, x: 0.004 }, { y: -L * 0.42, w: r, d: r * 0.98, x: 0.009 },
      { y: -L * 0.78, w: r * 0.9, d: r * 0.9, x: 0.02 }, { y: -L, w: r * 0.6, d: r * 0.62, x: 0.03 },
    ], { radial: 5, subdiv: 1, capTop: false });
    f.translate(0, -0.102 + drop[i], -0.0345 + i * 0.023);
    parts.push(f);
  });
  const thumb = loft([
    { y: 0.004, w: 0.016, d: 0.017 }, { y: -0.034, w: 0.0135, d: 0.0145 },
    { y: -0.06, w: 0.0105, d: 0.0115 }, { y: -0.074, w: 0.006, d: 0.0065 },
  ], { radial: 6, subdiv: 1, capTop: false });
  thumb.rotateX(0.5); thumb.rotateZ(0.32); thumb.translate(0.008, -0.04, -0.036);
  parts.push(thumb);
  const g = mergeGeometries(parts);
  // The palm (+X) and the insides of the fingers are a darker grip surface.
  shadeBy(g, (x, y) => (y < -0.02 && x > 0.008 ? 0.5 : 1));
  return g;
}

// Cleat around the ankle joint: heel at -Z, toe at +Z, the outsole at about
// y = -0.086 and the studs just below it. A moulded upper with a padded
// collar, a darker outsole plate and (`studs`) seven studs.
export function cleat({ low = false } = {}) {
  const detail = low ? { radial: 6, subdiv: 1 } : { radial: 10, subdiv: 1 };
  // Authored along +Y (heel to toe), then laid down: z offsets are heights.
  const h = v => -v;
  const upper = loft([
    { y: -0.08, w: 0.02, d: 0.024, z: h(-0.054), n: 2.4 },
    { y: -0.064, w: 0.032, d: 0.036, z: h(-0.045), n: 2.6 },
    { y: -0.025, w: 0.037, d: 0.041, z: h(-0.04), n: 2.6 },
    { y: 0.02, w: 0.04, d: 0.038, z: h(-0.043), n: 2.6 },
    { y: 0.06, w: 0.043, d: 0.029, z: h(-0.051), n: 2.8 },
    { y: 0.11, w: 0.046, d: 0.022, z: h(-0.058), n: 2.8 },
    { y: 0.16, w: 0.044, d: 0.017, z: h(-0.062), n: 2.6 },
    { y: 0.2, w: 0.035, d: 0.014, z: h(-0.064), n: 2.4 },
    { y: 0.222, w: 0.015, d: 0.008, z: h(-0.067) },
  ], detail);
  upper.rotateX(Math.PI / 2);
  // The outsole: a thin plate under the upper, a little wider than it.
  const sole = loft([
    { y: -0.084, w: 0.02, d: 0.007, z: h(-0.08), n: 3 }, { y: -0.066, w: 0.037, d: 0.007, z: h(-0.082), n: 3 },
    { y: -0.01, w: 0.044, d: 0.007, z: h(-0.083), n: 3 }, { y: 0.06, w: 0.049, d: 0.007, z: h(-0.083), n: 3 },
    { y: 0.12, w: 0.052, d: 0.007, z: h(-0.083), n: 3 }, { y: 0.17, w: 0.05, d: 0.007, z: h(-0.082), n: 3 },
    { y: 0.21, w: 0.039, d: 0.007, z: h(-0.079), n: 3 }, { y: 0.229, w: 0.015, d: 0.005, z: h(-0.075) },
  ], low ? { radial: 4, subdiv: 1 } : { radial: 8, subdiv: 1 });
  sole.rotateX(Math.PI / 2);
  shadeBy(sole, () => 0.1);
  // Baked shading: darker down by the sole, a darker tongue under the laces.
  shadeBy(upper, (x, y, z) => (0.82 + 0.18 * smoothstep(-0.08, -0.04, y)) * (Math.abs(x) < 0.014 && z > 0.02 && z < 0.12 && y > -0.045 ? 0.55 : 1));
  if (low) return mergeGeometries([upper, sole]);
  // The padded collar around the ankle.
  const collar = loft([
    { y: -0.035, w: 0.039, d: 0.044, z: -0.016 }, { y: 0.012, w: 0.037, d: 0.042, z: -0.014 }, { y: 0.03, w: 0.0345, d: 0.039, z: -0.013 },
  ], { radial: 10, subdiv: 1, capBottom: false, capTop: false });
  const g = mergeGeometries([upper, sole, collar]);
  return g;
}

export function cleatStuds() {
  const parts = [];
  for (const [x, z] of [[0.024, 0.165], [-0.024, 0.165], [0.03, 0.105], [-0.03, 0.105], [0, 0.2], [0.02, -0.045], [-0.02, -0.045]]) {
    const s = new THREE.CylinderGeometry(0.0075, 0.0045, 0.011, 5, 1);
    s.translate(x, -0.0925, z);
    parts.push(s);
  }
  return mergeGeometries(parts);
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
  for (let i = 0; i <= 32; i++) {
    const y = -BALL.length / 2 + BALL.length * i / 32;
    points.push(new THREE.Vector2(Math.max(ballRadiusAt(y), 0.0015), y));
  }
  const g = new THREE.LatheGeometry(points, 32);
  // Lathe axis Y -> ball axis Z; the lathe's phi = PI seam ends up on top.
  g.rotateX(Math.PI / 2);
  return g;
}

// Laces on top of the ball: two lace strips along the seam that follow the
// curve of the ball, crossed by eight raised stitches, each bent around the
// girth and tilted to the surface.
export function footballLaces() {
  const parts = [], lift = 0.0022;
  const surface = z => ballRadiusAt(z) + lift;
  for (const x of [-0.0052, 0.0052]) {
    const points = [];
    for (let i = 0; i <= 12; i++) {
      const z = -0.068 + 0.136 * i / 12;
      points.push(new THREE.Vector3(x, surface(z) - 0.0004, z));
    }
    const strip = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, 0.0034, 5, false);
    parts.push(strip);
  }
  for (let i = 0; i < 8; i++) {
    const z = -0.056 + i * 0.016, slope = (surface(z + 0.002) - surface(z - 0.002)) / 0.004;
    const stitch = new THREE.BoxGeometry(0.034, 0.0058, 0.0062, 4, 1, 1);
    // Bend the stitch around the ball's girth and round its ends down.
    const p = stitch.attributes.position;
    for (let k = 0; k < p.count; k++) p.setY(k, p.getY(k) - 2.9 * p.getX(k) ** 2 - (Math.abs(p.getX(k)) > 0.016 && p.getY(k) > 0 ? 0.002 : 0));
    stitch.computeVertexNormals();
    stitch.rotateX(-Math.atan(slope));
    stitch.translate(0, surface(z) + 0.0018, z);
    parts.push(stitch);
  }
  return mergeGeometries(parts);
}
