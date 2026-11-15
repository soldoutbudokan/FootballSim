import * as THREE from '../../vendor/three.module.js';
import { smoothstep } from './math.js';

// GPU skinning for the whole squad.
//
// Every body part of every athlete is baked, in that athlete's own rest pose,
// into one merged geometry per material (the cloth/skin body and the glossy
// helmets). Each vertex follows up to four bones of its athlete, and the
// bones of all athletes live in one float texture, so the 22 bodies cost a
// single draw call (plus one per shadow-casting light) and joints bend
// smoothly instead of showing rigid seams at the knees, elbows and waist.
// Most vertices follow a single bone and fetch only that one.
//
// Bone matrices are skinning matrices: boneWorld x inverse(bindWorld).

const _m = new THREE.Matrix4(), _n = new THREE.Matrix3(), _v = new THREE.Vector3(), _c = new THREE.Color();
const NO_GRAIN = [0, 1, 1, 0];

// ---------------------------------------------------------------------------
// Bone texture: one row per athlete, `stride` matrices along it, each matrix
// 4 RGBA32F texels. Bone b of athlete a is matrix a * stride + b, and its 16
// floats start at that number times 16 in `data`.

export class BoneTexture {
  constructor(athletes, stride) {
    this.stride = stride;
    this.count = athletes * stride;
    this.data = new Float32Array(this.count * 16);
    for (let i = 0; i < this.count; i++) _m.identity().toArray(this.data, i * 16);
    this.texture = new THREE.DataTexture(this.data, 4 * stride, athletes, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.userData.stride = stride;
    this.texture.needsUpdate = true;
  }

  set(index, matrix) {
    matrix.toArray(this.data, index * 16);
  }

  commit() {
    this.texture.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Merged geometry builder. Parts arrive with their geometry in bone-local
// space; they are baked into the rest pose (bind space) of their athlete.

// Up to four influences per vertex: the four largest shares, renormalised.
// Shares are stored in 1/255 steps; the first bone takes what is left of one.
const _slots = [[0, 0], [0, 0], [0, 0], [0, 0]];
function packWeights(list, bones, weights) {
  let n = 0;
  if (typeof list[0] === 'number') {
    // The two-bone form [own, other, ownShare].
    _slots[0][0] = list[0]; _slots[0][1] = list[2];
    _slots[1][0] = list[1]; _slots[1][1] = 1 - list[2];
    n = 2;
  } else {
    for (const [bone, w] of list) {
      if (!(w > 0)) continue;
      let k = -1;
      for (let i = 0; i < n; i++) if (_slots[i][0] === bone) k = i;
      if (k >= 0) { _slots[k][1] += w; continue; }
      if (n < 4) { _slots[n][0] = bone; _slots[n][1] = w; n++; continue; }
      let least = 0;
      for (let i = 1; i < 4; i++) if (_slots[i][1] < _slots[least][1]) least = i;
      if (w > _slots[least][1]) { _slots[least][0] = bone; _slots[least][1] = w; }
    }
  }
  // Largest first, so the remainder (the unquantised share) is the main bone's.
  for (let i = 1; i < n; i++) for (let k = i; k > 0 && _slots[k][1] > _slots[k - 1][1]; k--) { const t = _slots[k]; _slots[k] = _slots[k - 1]; _slots[k - 1] = t; }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += _slots[i][1];
  const main = _slots[0][0];
  for (let i = 0; i < 4; i++) {
    const share = i < n && sum > 0 ? Math.round(_slots[i][1] / sum * 255) : 0;
    bones.push(i > 0 && share === 0 ? main : _slots[i][0]);
    if (i > 0) weights.push(share);
  }
}

export class SkinnedGeometryBuilder {
  constructor() {
    this.position = []; this.normal = []; this.uv = []; this.color = [];
    this.bones = []; this.weights = []; this.surface = []; this.grain = [];
    this.indices = []; this.detailIndices = [];
    this.vertexCount = 0;
    // Per owner (athlete index): where his triangles sit in the base and the
    // detail index lists. Each athlete's parts are added in one go.
    this.ranges = [];
  }

  // geometry: indexed BufferGeometry with position/normal (uv, color optional)
  // bind: Matrix4 part -> bind space (bone bind world x part local). A
  //   mirrored matrix (negative scale: the right-hand copy of a left limb)
  //   keeps its faces outwards.
  // weights(p, i) -> [[bone, share], ...] for a bind-space point (vertex i of
  //   the part), or the two-bone form [ownBone, otherBone, ownShare]
  // color: linear THREE.Color multiplied into the vertex colour (baked AO)
  // uv: function(u, v, i) -> [u, v] remapping the part's own uv (vertex i)
  // surface: [roughness, metalness, sheen]
  // grain: [layer, tilesU, tilesV, strength] in the detail texture array
  //   (uniform.js); the part's own uv times the tile counts is its detail uv
  // owner: the athlete index (per-athlete draw ranges, level of detail)
  // warp(v): reshapes a vertex of the part in place before it is placed
  add(geometry, { bind, weights, color, uv = null, surface = [0.8, 0, 0], grain = NO_GRAIN, detail = false, owner = 0, warp = null }) {
    const pos = geometry.attributes.position, nor = geometry.attributes.normal;
    const uvs = geometry.attributes.uv, col = geometry.attributes.color;
    _n.getNormalMatrix(bind);
    const base = this.vertexCount;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      if (warp) warp(_v);
      _v.applyMatrix4(bind);
      this.position.push(_v.x, _v.y, _v.z);
      packWeights(weights(_v, i), this.bones, this.weights);
      _v.fromBufferAttribute(nor, i).applyMatrix3(_n).normalize();
      this.normal.push(_v.x, _v.y, _v.z);
      const u0 = uvs ? uvs.getX(i) : 0.5, v0 = uvs ? uvs.getY(i) : 0.5;
      const [u1, v1] = uv ? uv(u0, v0, i) : [u0, v0];
      this.uv.push(u1, v1);
      const ao = col ? col.getX(i) : 1, g = col ? col.getY(i) : 1, bl = col ? col.getZ(i) : 1;
      this.color.push(color.r * ao, color.g * g, color.b * bl);
      this.surface.push(surface[0], surface[1], surface[2] || 0);
      this.grain.push(u0 * grain[1], v0 * grain[2], grain[0], grain[3]);
    }
    const target = detail ? this.detailIndices : this.indices;
    const range = this.ranges[owner] ||= { base: [this.indices.length, this.indices.length], detail: [this.detailIndices.length, this.detailIndices.length] };
    const index = geometry.index, mirrored = bind.determinant() < 0;
    const count = index ? index.count : pos.count, at = i => base + (index ? index.getX(i) : i);
    for (let i = 0; i < count; i += 3) target.push(at(i), at(mirrored ? i + 2 : i + 1), at(mirrored ? i + 1 : i + 2));
    range[detail ? 'detail' : 'base'][1] = target.length;
    this.vertexCount += pos.count;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    g.setAttribute('athBones', new THREE.Uint16BufferAttribute(this.bones, 4));
    g.setAttribute('athWeights', new THREE.Uint8BufferAttribute(this.weights, 3, true));
    g.setAttribute('athSurface', new THREE.Float32BufferAttribute(this.surface, 3));
    g.setAttribute('athDetail', new THREE.Float32BufferAttribute(this.grain, 4));
    const all = this.indices.concat(this.detailIndices);
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(all, 1) : new THREE.Uint16BufferAttribute(all, 1));
    g.userData.baseCount = this.indices.length;
    g.userData.totalCount = all.length;
    // [start, count] of each athlete's base and detail triangles in the index.
    g.userData.ranges = this.ranges.map(r => r && {
      base: [r.base[0], r.base[1] - r.base[0]],
      detail: [this.indices.length + r.detail[0], r.detail[1] - r.detail[0]],
    });
    // Bodies move anywhere on the field; the mesh is never frustum culled.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }
}

// What the vertex shader does, on the CPU: vertex i of a built geometry
// skinned by the matrices in `boneData` (BoneTexture.data). For tests and
// measurements.
export function skinVertex(geometry, boneData, i, out) {
  const p = geometry.attributes.position, b = geometry.attributes.athBones, w = geometry.attributes.athWeights;
  const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
  const w1 = w.getX(i), w2 = w.getY(i), w3 = w.getZ(i), share = [1 - w1 - w2 - w3, w1, w2, w3];
  out.set(0, 0, 0);
  for (let k = 0; k < 4; k++) {
    if (!(share[k] > 0)) continue;
    const o = b.getComponent(i, k) * 16, d = boneData;
    out.x += share[k] * (d[o] * x + d[o + 4] * y + d[o + 8] * z + d[o + 12]);
    out.y += share[k] * (d[o + 1] * x + d[o + 5] * y + d[o + 9] * z + d[o + 13]);
    out.z += share[k] * (d[o + 2] * x + d[o + 6] * y + d[o + 10] * z + d[o + 14]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Joint blending. A joint between a parent bone and its child sits at a point
// of bind space, with a direction that runs from the parent's side to the
// child's (down a limb, up the spine, forward along the foot). Vertices
// within `radius` of the joint's plane are shared between the two bones
// (50/50 exactly at the joint), so both sides deform as one surface. A hinge
// (knee, elbow, the front of the hip) folds on one side: there the blend
// narrows to `crease.radius` so the fold stays a tight crease instead of the
// parent's surface sticking out past the child's.
//
// A hinge may also name a `helper` bone, which turns half as far as the
// child. The ring at the joint then rides the helper alone and keeps its
// size, and each neighbouring ring blends two bones only half the bend apart,
// so a deep knee or elbow no longer collapses.
//
// joints: [{ x, y, z, dx, dy, dz, radius, ownIsChild, other, helper?, crease? }]
// Several joints multiply: each takes its share of what the earlier ones left
// to the part's own bone.

export function jointWeights(own, joints) {
  return p => {
    const out = [];
    let mine = 1;
    for (const j of joints) {
      const along = (p.x - j.x) * j.dx + (p.y - j.y) * j.dy + (p.z - j.z) * j.dz;   // > 0 on the child's side
      let r = j.radius;
      if (j.crease) {
        const cx = p.x - j.x, cz = p.z - j.z, len = Math.hypot(cx, cz) || 1;
        const facing = (cx * j.crease.x + cz * j.crease.z) / len;
        // Narrow on the fold side, full width on the outside, with a wide
        // transition around the limb so neighbouring vertices stay close.
        r += (j.crease.radius - r) * smoothstep(-0.6, 0.9, facing);
      }
      const child = along <= -r ? 0 : along >= r ? 1 : smoothstep(-r, r, along);
      const keep = j.ownIsChild ? child : 1 - child;
      if (keep >= 1) continue;
      if (j.helper === undefined) {
        out.push([j.other, mine * (1 - keep)]);
        mine *= keep;
      } else {
        const far = Math.max(0, 1 - 2 * keep), near = Math.max(0, 2 * keep - 1);
        out.push([j.other, mine * far], [j.helper, mine * (1 - far - near)]);
        mine *= near;
      }
    }
    out.push([own, mine]);
    return out;
  };
}

// Spreads a share over a chain of bones by how far along a bind-space segment
// the point lies: bones = [[bone, t], ...] with t rising from 0 at `a` to 1 at
// `b`; between two entries the share passes linearly from one to the next.
export function chainWeights(a, b, bones) {
  const ax = b.x - a.x, ay = b.y - a.y, az = b.z - a.z, len2 = ax * ax + ay * ay + az * az;
  return (p, share, out) => {
    const t = ((p.x - a.x) * ax + (p.y - a.y) * ay + (p.z - a.z) * az) / len2;
    let k = 0;
    while (k < bones.length - 1 && t > bones[k + 1][1]) k++;
    if (k === bones.length - 1 || t <= bones[k][1]) { out.push([bones[k][0], share]); return out; }
    const u = (t - bones[k][1]) / (bones[k + 1][1] - bones[k][1]);
    out.push([bones[k][0], share * (1 - u)], [bones[k + 1][0], share * u]);
    return out;
  };
}

// ---------------------------------------------------------------------------
// Material patch: skins position and normal from the bone texture and takes
// roughness, metalness and sheen per vertex (the body merges cloth, skin,
// rubber and metal into one draw call). With a detail map (a texture array of
// tiling micro-surfaces: mesh weave, stretch knit, skin, rib knit, grain) each
// part also picks a layer, which bends the normal and varies the roughness
// and the shade in the creases of the weave. `material.userData.athDetail =
// false` (and needsUpdate) compiles the patch without it: the lowest tier.

// The colour, depth and distance programs all skin with this.
const skinHeader = stride => `
attribute vec4 athBones;
attribute vec3 athWeights;
uniform highp sampler2D athBoneTexture;
mat4 athBone(float index) {
  int bone = int(index + 0.5), x = (bone % ${stride}) * 4, y = bone / ${stride};
  return mat4(
    texelFetch(athBoneTexture, ivec2(x, y), 0),
    texelFetch(athBoneTexture, ivec2(x + 1, y), 0),
    texelFetch(athBoneTexture, ivec2(x + 2, y), 0),
    texelFetch(athBoneTexture, ivec2(x + 3, y), 0));
}
mat4 athSkin() {
  mat4 m = athBone(athBones.x) * (1.0 - athWeights.x - athWeights.y - athWeights.z);
  if (athWeights.x > 0.0) m += athBone(athBones.y) * athWeights.x;
  if (athWeights.y > 0.0) m += athBone(athBones.z) * athWeights.y;
  if (athWeights.z > 0.0) m += athBone(athBones.w) * athWeights.z;
  return m;
}
`;

const SURFACE_HEADER = `
attribute vec3 athSurface;
attribute vec4 athDetail;
varying vec3 vAthSurface;
varying vec4 vAthDetail;
`;

const FRAGMENT_HEADER = `
varying vec3 vAthSurface;
varying vec4 vAthDetail;
uniform vec3 athFill;
uniform vec3 athBounce;
uniform vec3 athRim;
#ifdef ATH_DETAIL
uniform mediump sampler2DArray athDetailMap;
#endif
`;

// The detail layer's blue channel varies the roughness; its alpha darkens the
// creases of the weave.
const ROUGHNESS = `
roughnessFactor = vAthSurface.x;
#ifdef ATH_DETAIL
vec4 athGrain = texture(athDetailMap, vec3(vAthDetail.xy, floor(vAthDetail.z + 0.5)));
roughnessFactor = clamp(roughnessFactor + (athGrain.b - 0.5) * 0.6 * vAthDetail.w, 0.04, 1.0);
diffuseColor.rgb *= 1.0 + (athGrain.a - 0.5) * 1.2 * vAthDetail.w;
#endif
`;

// Tangent frame from screen-space derivatives of the detail uv (no tangent
// attribute), as three.js does for its own normal maps.
const NORMAL = `
#ifdef ATH_DETAIL
{
  vec3 athQ0 = dFdx(-vViewPosition), athQ1 = dFdy(-vViewPosition);
  vec2 athS = dFdx(vAthDetail.xy), athT = dFdy(vAthDetail.xy);
  vec3 athQ1p = cross(athQ1, normal), athQ0p = cross(normal, athQ0);
  vec3 athTan = athQ1p * athS.x + athQ0p * athT.x, athBit = athQ1p * athS.y + athQ0p * athT.y;
  float athDet = max(dot(athTan, athTan), dot(athBit, athBit));
  vec2 athXY = (athGrain.xy * 2.0 - 1.0) * vAthDetail.w * (athDet == 0.0 ? 0.0 : inversesqrt(athDet));
  normal = normalize(normal + athTan * athXY.x + athBit * athXY.y);
}
#endif
`;

// The players' own light, on top of the scene's: an outdoor scene lit by one
// sun leaves the shadow side of a body near black, where a real one is filled
// by the whole sky above and by the light off the grass below. A rim along
// the edges that face away from the camera keeps a dark jersey apart from a
// dark background. Shared by every athlete material; setCharacterLight sets
// it for the lighting preset.
const CHARACTER_LIGHT = { athFill: { value: new THREE.Color(0, 0, 0) }, athBounce: { value: new THREE.Color(0, 0, 0) }, athRim: { value: new THREE.Color(0, 0, 0) } };
const LIGHT = `
{
  vec3 athUp = inverseTransformDirection(normal, viewMatrix);
  reflectedLight.indirectDiffuse += mix(athBounce, athFill, athUp.y * 0.5 + 0.5) * BRDF_Lambert(material.diffuseColor);
  float athEdge = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
  reflectedLight.indirectSpecular += athRim * athEdge * athEdge * athEdge * (0.3 + 0.7 * saturate(athUp.y + 0.6));
}
`;

// light: { fill, bounce, rim }, each [colour, strength]; null turns it off.
export function setCharacterLight(light) {
  for (const [key, name] of [['fill', 'athFill'], ['bounce', 'athBounce'], ['rim', 'athRim']]) {
    const value = CHARACTER_LIGHT[name].value;
    if (light?.[key]) value.set(light[key][0]).multiplyScalar(light[key][1]); else value.setScalar(0);
  }
}

// boneTexture: BoneTexture.texture (it carries the stride of its rows).
export function skinMaterial(material, boneTexture, { depth = false, detailMap = null } = {}) {
  const detailed = () => !!detailMap && material.userData.athDetail !== false;
  const stride = boneTexture.userData.stride, header = skinHeader(stride);
  material.onBeforeCompile = shader => {
    shader.uniforms.athBoneTexture = { value: boneTexture };
    if (depth) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + header)
        .replace('#include <begin_vertex>', 'mat4 athM = athSkin();\nvec3 transformed = (athM * vec4(position, 1.0)).xyz;');
      return;
    }
    // Always present: three.js keeps one uniforms object per material, the
    // last compiled program's, so a program compiled with the detail layer
    // and reused after a plain one would otherwise never get its texture.
    if (detailMap) shader.uniforms.athDetailMap = { value: detailMap };
    Object.assign(shader.uniforms, CHARACTER_LIGHT);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + header + SURFACE_HEADER)
      .replace('#include <beginnormal_vertex>', 'mat4 athM = athSkin();\nvec3 objectNormal = normalize(mat3(athM) * normal);')
      .replace('#include <begin_vertex>', 'vec3 transformed = (athM * vec4(position, 1.0)).xyz;\nvAthSurface = athSurface;\nvAthDetail = athDetail;');
    shader.fragmentShader = (detailed() ? '#define ATH_DETAIL\n' : '') + shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAGMENT_HEADER)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + ROUGHNESS)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vAthSurface.y;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + NORMAL)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + LIGHT)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor *= vAthSurface.z;\n#endif');
  };
  material.customProgramCacheKey = () => 'athlete-skin-' + stride + '-' + material.type + (depth ? '-depth' : detailed() ? '-detail' : '');
  return material;
}

// A merged, skinned mesh ready for the scene, with shadow materials that skin
// the same way.
export function skinnedMesh(geometry, material, boneTexture, name, detailMap = null) {
  const mesh = new THREE.Mesh(geometry, skinMaterial(material, boneTexture, { detailMap }));
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.customDepthMaterial = skinMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), boneTexture, { depth: true });
  mesh.customDistanceMaterial = skinMaterial(new THREE.MeshDistanceMaterial(), boneTexture, { depth: true });
  return mesh;
}

// Linear colour from a CSS colour string, for baking into vertex colours.
export function linearColor(css) {
  return _c.set(css).clone();
}
