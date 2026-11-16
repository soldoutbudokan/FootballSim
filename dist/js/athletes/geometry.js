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
// Pants. One piece for the left half of the body, from the waistband over the
// hip and the seat, down the thigh and over the knee to the cuff; the right
// half is its mirror image. Above the crotch each ring runs round the whole
// pelvis and is cut off flat at the midline, where the two halves meet along
// the fly and the seat seam; below it the ring closes round the thigh. So
// the seat runs into the leg as one surface: no shell hangs over another.
//
// Coordinates are the left thigh's: the hip joint at the origin, +X outward
// (the midline is at x = -PANTS.hip), +Z forward. The uv is the leg's (u
// round the ring from the outside seam, v from the hip to the cuff, running
// on above the hip); vertices above PANTS.split also carry `seat`, their
// place on the hips panel of the uniform atlas (u round the whole pelvis from
// the left side seam, v from the crotch to the waist), others (-1, -1). The
// split is the lowest ring that still runs round the whole pelvis: below it
// the inside of the thigh has no bearing round the body to map by.
export const PANTS = { hip: 0.112, split: 0.02, crotch: -0.078, top: 0.158, waist: 0.166, legTop: 0.075, cuff: -0.574 };

export function pants({ low = false, hero = false } = {}) {
  const radial = low ? 12 : hero ? 40 : 28, subdiv = low ? 1 : hero ? 3 : 2, H = PANTS.hip, cols = radial + 1;
  // [y, outer edge, inner edge (both from the midline), half depth, z]
  const rows = [
    // The waistband turns in under the jersey behind the belt.
    [PANTS.top, 0.15, -0.15, 0.103, 0], [0.14, 0.172, -0.172, 0.119, -0.003], [0.1, 0.188, -0.188, 0.124, -0.006], [0.06, 0.2026, -0.2026, 0.129, -0.013],
    [PANTS.split, 0.207, -0.207, 0.124, -0.013], [-0.02, 0.213, -0.12, 0.12, -0.008], [-0.05, 0.216, -0.04, 0.119, -0.003], [PANTS.crotch, 0.218, 0.004, 0.119, 0.001],
    [-0.105, 0.22, 0.008, 0.121, 0.003], [-0.2, 0.215, 0.009, 0.115, 0.006], [-0.3, 0.201, 0.023, 0.095, 0.005], [-0.39, 0.187, 0.037, 0.08, 0.002],
    [-0.45, 0.178, 0.046, 0.073, 0.008], [-0.5, 0.176, 0.048, 0.072, 0.011], [-0.545, 0.17, 0.054, 0.062, 0.004], [-0.566, 0.168, 0.056, 0.058, 0], [PANTS.cuff, 0.158, 0.066, 0.047, 0],
  ];
  const FRONT = Math.PI / 2, BACK = -Math.PI / 2, OUT = 0, IN = Math.PI, span = PANTS.top - PANTS.cuff, legSpan = PANTS.legTop - PANTS.cuff;
  const g = loft(rows.map(([y, outer, inner, d, z]) => ({ y, w: (outer - inner) / 2, d, x: (outer + inner) / 2 - H, z })), {
    radial, subdiv, capTop: false,
    // Shaded in the crotch and inside the thigh, under the jersey at the
    // waist, above the knee pad and at the tucked cuff.
    ao: (v, t) => {
      const y = PANTS.top - v * span, leg = (PANTS.legTop - y) / legSpan, front = smoothstep(-0.2, 0.6, Math.sin(t));
      return (1 - 0.26 * (1 - smoothstep(0.05, 0.3, leg)) * smoothstep(0.2, 1, -Math.cos(t)) * smoothstep(0.03, -0.02, y))
        * (1 - 0.24 * smoothstep(0.12, PANTS.top, y)) * (1 - 0.3 * smoothstep(0.95, 1, leg))
        * (1 - 0.2 * Math.exp(-(((leg - 0.74) / 0.03) ** 2)) * front) * (1 - 0.14 * Math.exp(-(((leg - 0.92) / 0.025) ** 2)) * front);
    },
    sculpt: mounds([
      { y: 0.03, t: BACK + 0.62, sy: 0.075, st: 0.5, a: 0.02 },                // glute
      { y: 0.115, t: OUT + 0.25, sy: 0.03, st: 0.4, a: 0.006, flat: 0.6 },     // hip pad
      { y: -0.2, t: FRONT - 0.15, sy: 0.085, st: 0.5, a: 0.013, flat: 0.7 },   // thigh pad
      { y: -0.27, t: OUT + 0.35, sy: 0.1, st: 0.45, a: 0.006 },               // outer quad
      { y: -0.37, t: IN - 0.5, sy: 0.04, st: 0.4, a: 0.006 },                 // teardrop above the knee
      { y: -0.2, t: BACK, sy: 0.11, st: 0.6, a: 0.009 },                      // hamstrings
      { y: -0.475, t: FRONT, sy: 0.036, st: 0.55, a: 0.013, flat: 0.5 },      // knee pad
      { y: -0.47, t: BACK, sy: 0.03, st: 0.5, a: -0.006 },                    // back of the knee
      { y: -0.562, t: 0, sy: 0.008, st: 0, a: 0.003 },                        // cuff band
    ]),
  });
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
  // Cut at the midline: what would lie across it is brought onto it, and the
  // faces that end up wholly in that plane (the wall between the two halves)
  // are dropped. The surface meets its mirror image there, so its normals
  // there lie in the plane.
  const flat = new Uint8Array(p.count);
  for (let i = 0; i < p.count; i++) {
    // The cleft of the seat and the crotch lie in shade.
    const deep = (1 - smoothstep(0, 0.03, p.getX(i) + H)) * smoothstep(0.12, 0.05, p.getY(i)) * (p.getZ(i) < 0.02 ? 1 : 0.5);
    if (deep > 0) col.setXYZ(i, col.getX(i) * (1 - 0.42 * deep), col.getY(i) * (1 - 0.42 * deep), col.getZ(i) * (1 - 0.42 * deep));
    if (p.getX(i) > -H) continue;
    flat[i] = 1;
    p.setX(i, -H);
    const ny = n.getY(i), nz = n.getZ(i), len = Math.hypot(ny, nz);
    if (len > 1e-4) n.setXYZ(i, 0, ny / len, nz / len); else n.setXYZ(i, 0, 0, p.getZ(i) < 0 ? -1 : 1);
  }
  // The ring at the split is doubled: the faces above it take the hips panel,
  // the faces below it the leg panel.
  const first = rows.findIndex(r => r[0] === PANTS.split) * subdiv * cols, extra = cols, total = p.count + extra;
  const position = new Float32Array(total * 3), normal = new Float32Array(total * 3), uvs = new Float32Array(total * 2), color = new Float32Array(total * 3), seat = new Float32Array(total * 2).fill(-1);
  const put = (to, from, hips) => {
    const x = p.getX(from), y = p.getY(from), z = p.getZ(from);
    position.set([x, y, z], to * 3); normal.set([n.getX(from), n.getY(from), n.getZ(from)], to * 3); color.set([col.getX(from), col.getY(from), col.getZ(from)], to * 3);
    uvs.set([uv.getX(from), (PANTS.legTop - y) / legSpan], to * 2);
    if (hips) {
      // (The ring closes on itself at the outside seam: u is 0 where it starts and 1 where it ends.)
      const around = uv.getX(from) > 0.999 ? 1 : Math.atan2(z, x + H) / (2 * Math.PI);
      seat.set([around < -1e-6 ? around + 1 : Math.max(0, around), (y - PANTS.crotch) / (PANTS.waist - PANTS.crotch)], to * 2);
    }
  };
  for (let i = 0; i < p.count; i++) put(i, i, i < first);
  for (let j = 0; j < cols; j++) put(p.count + j, first + j, true);
  const index = [];
  for (let i = 0; i < g.index.count; i += 3) {
    const tri = [g.index.getX(i), g.index.getX(i + 1), g.index.getX(i + 2)];
    if (tri.every(v => flat[v])) continue;
    const upper = tri.some(v => v < first);
    index.push(...tri.map(v => (upper && v >= first && v < first + cols ? p.count + v - first : v)));
  }
  g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.setAttribute('seat', new THREE.BufferAttribute(seat, 2));
  out.setIndex(index);
  return out;
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
const HELMET_COLUMNS = [0, 5, 10, 15, 20, 25, 30, 36, 40, 44, 48, 52, 60, 70, 82, 94, 106, 118, 130, 142, 154, 167, 180];
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
  const half = low ? HELMET_COLUMNS_LOW : HELMET_COLUMNS, rows = low ? 7 : 20;
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

// A head with a jaw, cheekbones, a brow ridge, a nose and lips. The face
// stays behind the facemask; it shows through the open cage on unvisored
// players and in every close view.
export function athleteFace({ low = false, hero = false } = {}) {
  const FRONT = Math.PI / 2;
  const head = loft([
    { y: -0.105, w: 0.035, d: 0.04, z: 0.018, n: 2.5 },
    { y: -0.088, w: 0.054, d: 0.055, z: 0.014, n: 2.8 },
    { y: -0.062, w: 0.064, d: 0.064, z: 0.009, n: 2.6 },
    { y: -0.04, w: 0.069, d: 0.07, z: 0.005, n: 2.5 },
    { y: 0.005, w: 0.078, d: 0.079, n: 2.1 },
    { y: 0.054, w: 0.074, d: 0.083, z: -0.005 },
    { y: 0.093, w: 0.061, d: 0.069, z: -0.011 },
    { y: 0.113, w: 0.028, d: 0.037, z: -0.011 },
  ], {
    radial: low ? 8 : hero ? 26 : 18, subdiv: low ? 1 : hero ? 3 : 2,
    // On the front of the head only: eye sockets under a brow ridge,
    // cheekbones, the muzzle and both lips, the chin, the hollow of each cheek.
    sculpt: low ? null : mounds([
      { y: 0.022, t: FRONT - 0.42, sy: 0.011, st: 0.19, a: -0.008 }, { y: 0.022, t: FRONT + 0.42, sy: 0.011, st: 0.19, a: -0.008 },
      { y: 0.04, t: FRONT - 0.4, sy: 0.008, st: 0.3, a: 0.006 }, { y: 0.04, t: FRONT + 0.4, sy: 0.008, st: 0.3, a: 0.006 },
      { y: -0.01, t: FRONT - 0.64, sy: 0.016, st: 0.24, a: 0.005 }, { y: -0.01, t: FRONT + 0.64, sy: 0.016, st: 0.24, a: 0.005 },
      { y: -0.045, t: FRONT, sy: 0.016, st: 0.34, a: 0.006 },
      { y: -0.046, t: FRONT, sy: 0.0055, st: 0.26, a: 0.0035 }, { y: -0.059, t: FRONT, sy: 0.006, st: 0.22, a: 0.004 },
      { y: -0.0525, t: FRONT, sy: 0.0022, st: 0.3, a: -0.003 },
      { y: -0.083, t: FRONT, sy: 0.013, st: 0.28, a: 0.007 },
      { y: -0.04, t: FRONT - 0.85, sy: 0.02, st: 0.22, a: -0.004 }, { y: -0.04, t: FRONT + 0.85, sy: 0.02, st: 0.22, a: -0.004 },
    ]),
    // The helmet shades the brow, the temples and everything behind them.
    ao: (v, t) => (0.74 + 0.26 * smoothstep(-0.2, 0.75, Math.sin(t))) * (1 - 0.28 * smoothstep(0.62, 0.86, v)),
  });
  if (low) return head;
  // The nose: a bridge widening to the tip, with a wing either side.
  const nose = loft([
    { y: 0.03, w: 0.0065, d: 0.006, z: 0.074 }, { y: 0.012, w: 0.0085, d: 0.01, z: 0.079 },
    { y: -0.008, w: 0.012, d: 0.0155, z: 0.083 }, { y: -0.019, w: 0.0135, d: 0.0165, z: 0.0835 }, { y: -0.027, w: 0.0105, d: 0.009, z: 0.079 },
  ], { radial: 8, subdiv: 2 });
  const wings = [-1, 1].map(s => ellipsoid(s * 0.0125, -0.02, 0.079, 0.0075, 0.007, 0.009, 6, 4));
  return mergeGeometries([head, shadeBy(nose, (x, y) => (y < -0.022 ? 0.72 : 1)), ...wings]);
}

export function faceDetails() {
  const parts = [];
  for (const s of [-1, 1]) {
    parts.push(tint(ellipsoid(s * 0.031, 0.0375, 0.0745, 0.02, 0.0042, 0.005, 6, 3), '#2a1f1a'));   // brow
    parts.push(tint(ellipsoid(s * 0.031, 0.0215, 0.0728, 0.0125, 0.0066, 0.004, 8, 4), '#ddd7cd')); // eye
    parts.push(tint(ellipsoid(s * 0.0305, 0.0212, 0.0748, 0.0056, 0.0056, 0.003, 8, 4), '#3a2416')); // iris
    parts.push(tint(ellipsoid(s * 0.0305, 0.0212, 0.0762, 0.0026, 0.0026, 0.002, 6, 3), '#0c0908')); // pupil
    parts.push(tint(ellipsoid(s * 0.031, 0.0283, 0.0734, 0.0135, 0.0016, 0.0042, 6, 3), '#2a1c16')); // the line of the upper lid
    // Eye-black strips are subdued and sit on the cheekbone, below the eye.
    parts.push(tint(ellipsoid(s * 0.035, 0.003, 0.0775, 0.019, 0.005, 0.003, 6, 3), '#23211e'));
  }
  // The line between the lips.
  parts.push(tint(ellipsoid(0, -0.0525, 0.0762, 0.02, 0.0018, 0.003, 6, 3), '#3b2620'));
  return mergeGeometries(parts);
}

// ---------------------------------------------------------------------------
// Hands and feet

// Left glove: palm faces +X, thumb on the -Z side, fingers along -Y. The
// wrist is at the origin and the fingertips about 0.19 yd below it. The palm
// (`glove`) and the five digits (`digits`) are separate pieces in the same
// coordinates, modelled flat and straight: each digit bends at its own three
// joints (rig.js), so the shape of the hand is a matter of pose. `low`: the
// distant-athlete mitten, one piece on the hand bone.
//
// HAND_DIGITS: where each digit springs from the palm (its first joint), how
// long it is and how far along it the two outer joints lie; the thumb also
// leans out of the palm (Euler x then z).
export const HAND_DIGITS = [
  { name: 'thumb', base: [0.008, -0.04, -0.036], lean: [0.5, 0.32], length: 0.078, joints: [0.44, 0.78], radius: 0.0152 },
  { name: 'index', base: [0.004, -0.106, -0.0345], length: 0.07, joints: [0.42, 0.78], radius: 0.0112 },
  { name: 'middle', base: [0.004, -0.102, -0.0115], length: 0.079, joints: [0.42, 0.78], radius: 0.0112 },
  { name: 'ring', base: [0.004, -0.105, 0.0115], length: 0.073, joints: [0.42, 0.78], radius: 0.0112 },
  { name: 'pinky', base: [0.004, -0.114, 0.0345], length: 0.057, joints: [0.42, 0.78], radius: 0.0098 },
];

// The palm (+X) side of the glove is a darker grip surface; the wrist closes
// with a darker strap.
const gripShade = g => shadeBy(g, (x, y) => (y < -0.02 && x > 0.008 ? 0.5 : y > -0.013 ? 0.62 : 1));

export function glove({ low = false, hero = false } = {}) {
  if (low) {
    const hand = loft([
      { y: 0.012, w: 0.026, d: 0.029 }, { y: -0.04, w: 0.024, d: 0.044 },
      { y: -0.1, w: 0.022, d: 0.048, x: 0.004, n: 2.5 }, { y: -0.15, w: 0.02, d: 0.04, x: 0.016 }, { y: -0.176, w: 0.009, d: 0.024, x: 0.026 },
    ], { radial: 6, subdiv: 1 });
    return hand;
  }
  // Wrist band, the back of the hand with its knuckle ridge, and the palm.
  return gripShade(loft([
    { y: 0.016, w: 0.0335, d: 0.0345 }, { y: -0.012, w: 0.029, d: 0.034 },
    { y: -0.04, w: 0.021, d: 0.042, n: 2.4 }, { y: -0.075, w: 0.019, d: 0.048, x: 0.001, n: 2.8 },
    { y: -0.098, w: 0.0185, d: 0.049, x: 0.003, n: 3 }, { y: -0.113, w: 0.0135, d: 0.0465, x: 0.005, n: 3 },
  ], { radial: hero ? 16 : 10, subdiv: hero ? 2 : 1 }));
}

// One geometry per digit of HAND_DIGITS, each with a ring on either side of
// its joints so a knuckle folds between two rings instead of across one.
export function digits({ hero = false } = {}) {
  return HAND_DIGITS.map(({ base, lean, length: L, joints: [j1, j2], radius: r }) => {
    const ring = (t, k, x = 0) => ({ y: -L * t, w: r * 0.92 * k, d: r * k, x });
    const g = loft([
      { y: 0.008, w: r * 0.9, d: r * 0.98 }, ring(0.1, 1), ring(j1 - 0.08, 0.97), ring(j1, 1.03, -0.0006), ring(j1 + 0.08, 0.95),
      ring(j2 - 0.06, 0.89), ring(j2, 0.92, -0.0005), ring(j2 + 0.07, 0.85), ring(0.95, 0.68), ring(1, 0.36),
    ], { radial: hero ? 10 : 6, subdiv: hero ? 2 : 1, capTop: false });
    if (lean) { g.rotateX(lean[0]); g.rotateZ(lean[1]); }
    g.translate(...base);
    return gripShade(g);
  });
}

// Cleat around the ankle joint: heel at -Z, toe at +Z, the outsole at about
// y = -0.086 and the studs just below it. A moulded upper with a padded
// collar, a darker outsole plate and (`studs`) seven studs.
export function cleat({ low = false, hero = false } = {}) {
  const detail = low ? { radial: 6, subdiv: 1 } : hero ? { radial: 16, subdiv: 2 } : { radial: 10, subdiv: 1 };
  // Authored along +Y (heel to toe), then laid down: z offsets are heights.
  const h = v => -v;
  const upper = loft([
    { y: -0.08, w: 0.02, d: 0.024, z: h(-0.054), n: 2.4 },
    { y: -0.064, w: 0.032, d: 0.036, z: h(-0.045), n: 2.6 },
    { y: -0.025, w: 0.037, d: 0.041, z: h(-0.04), n: 2.6 },
    { y: 0.02, w: 0.04, d: 0.038, z: h(-0.043), n: 2.6 },
    { y: 0.06, w: 0.043, d: 0.029, z: h(-0.051), n: 2.8 },
    { y: 0.11, w: 0.046, d: 0.022, z: h(-0.058), n: 2.8 },
    { y: 0.135, w: 0.0455, d: 0.0195, z: h(-0.06), n: 2.8 },
    { y: 0.16, w: 0.044, d: 0.017, z: h(-0.062), n: 2.6 },
    { y: 0.2, w: 0.035, d: 0.014, z: h(-0.064), n: 2.4 },
    { y: 0.222, w: 0.015, d: 0.008, z: h(-0.067) },
  ], detail);
  upper.rotateX(Math.PI / 2);
  // The outsole: a thin plate under the upper, a little wider than it.
  const sole = loft([
    { y: -0.084, w: 0.02, d: 0.007, z: h(-0.08), n: 3 }, { y: -0.066, w: 0.037, d: 0.007, z: h(-0.082), n: 3 },
    { y: -0.01, w: 0.044, d: 0.007, z: h(-0.083), n: 3 }, { y: 0.06, w: 0.049, d: 0.007, z: h(-0.083), n: 3 },
    { y: 0.11, w: 0.052, d: 0.007, z: h(-0.083), n: 3 }, { y: 0.135, w: 0.052, d: 0.007, z: h(-0.083), n: 3 },
    { y: 0.16, w: 0.0505, d: 0.007, z: h(-0.082), n: 3 },
    { y: 0.21, w: 0.039, d: 0.007, z: h(-0.079), n: 3 }, { y: 0.229, w: 0.015, d: 0.005, z: h(-0.075) },
  ], low ? { radial: 4, subdiv: 1 } : hero ? { radial: 12, subdiv: 2 } : { radial: 8, subdiv: 1 });
  sole.rotateX(Math.PI / 2);
  shadeBy(sole, () => 0.1);
  // Baked shading: darker down by the sole, a darker tongue under the laces.
  // The toe cap and the heel counter are a shade off the quarter panels.
  shadeBy(upper, (x, y, z) => (0.82 + 0.18 * smoothstep(-0.08, -0.04, y)) * (Math.abs(x) < 0.014 && z > 0.02 && z < 0.12 && y > -0.045 ? 0.55 : 1) * (z > 0.155 || z < -0.045 ? 0.86 : 1));
  if (low) return mergeGeometries([upper, sole]);
  // The padded collar around the ankle.
  const collar = loft([
    { y: -0.035, w: 0.039, d: 0.044, z: -0.016 }, { y: 0.012, w: 0.037, d: 0.042, z: -0.014 }, { y: 0.03, w: 0.0345, d: 0.039, z: -0.013 },
  ], { radial: hero ? 16 : 10, subdiv: 1, capBottom: false, capTop: false });
  const g = mergeGeometries([upper, sole, collar]);
  return g;
}

// The dark small parts of a cleat: the studs under the outsole and the laces
// across the instep.
export function cleatStuds() {
  const parts = [];
  for (const [z, y] of [[0.026, -0.006], [0.044, -0.014], [0.062, -0.021], [0.08, -0.027], [0.098, -0.032]]) {
    const lace = new THREE.BoxGeometry(0.036, 0.004, 0.0055, 2, 1, 1), p = lace.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) - 7 * p.getX(i) ** 2);
    lace.computeVertexNormals();
    lace.rotateX(0.42); lace.translate(0, y, z);
    parts.push(lace);
  }
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
