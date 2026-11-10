import * as THREE from '../../vendor/three.module.js';
import { smoothstep } from './math.js';

// GPU skinning for the whole squad.
//
// Every body part of every athlete is baked, in that athlete's own rest pose,
// into one merged geometry per material (the cloth/skin body and the glossy
// helmets). Each vertex follows one or two bones of its athlete, and the
// bones of all athletes live in one float texture, so the 22 bodies cost a
// single draw call (plus one per shadow-casting light) and joints bend
// smoothly instead of showing rigid seams at the knees, elbows and waist.
//
// Bone matrices are skinning matrices: boneWorld x inverse(bindWorld).

const _m = new THREE.Matrix4(), _n = new THREE.Matrix3(), _v = new THREE.Vector3(), _c = new THREE.Color();
const NO_GRAIN = [0, 1, 1, 0];

// ---------------------------------------------------------------------------
// Bone texture: 4 RGBA32F texels (one matrix) per row, one row per bone.

export class BoneTexture {
  constructor(boneCount) {
    this.count = boneCount;
    this.data = new Float32Array(boneCount * 16);
    for (let i = 0; i < boneCount; i++) _m.identity().toArray(this.data, i * 16);
    this.texture = new THREE.DataTexture(this.data, 4, boneCount, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
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

export class SkinnedGeometryBuilder {
  constructor() {
    this.position = []; this.normal = []; this.uv = []; this.color = [];
    this.bones = []; this.mix = []; this.surface = []; this.grain = [];
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
  // weights(p) -> [ownBone, otherBone, ownWeight] for a bind-space point
  // color: linear THREE.Color multiplied into the vertex colour (baked AO)
  // uv: function(u, v) -> [u, v] remapping the part's own uv
  // surface: [roughness, metalness, sheen]
  // grain: [layer, tilesU, tilesV, strength] in the detail texture array
  //   (uniform.js); the part's own uv times the tile counts is its detail uv
  // owner: the athlete index (per-athlete draw ranges, level of detail)
  add(geometry, { bind, weights, color, uv = null, surface = [0.8, 0, 0], grain = NO_GRAIN, detail = false, owner = 0 }) {
    const pos = geometry.attributes.position, nor = geometry.attributes.normal;
    const uvs = geometry.attributes.uv, col = geometry.attributes.color;
    _n.getNormalMatrix(bind);
    const base = this.vertexCount;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(bind);
      this.position.push(_v.x, _v.y, _v.z);
      const [a, b, w] = weights(_v);
      this.bones.push(a, b);
      this.mix.push(w);
      _v.fromBufferAttribute(nor, i).applyMatrix3(_n).normalize();
      this.normal.push(_v.x, _v.y, _v.z);
      const u0 = uvs ? uvs.getX(i) : 0.5, v0 = uvs ? uvs.getY(i) : 0.5;
      const [u1, v1] = uv ? uv(u0, v0) : [u0, v0];
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
    g.setAttribute('athBones', new THREE.Float32BufferAttribute(this.bones, 2));
    g.setAttribute('athMix', new THREE.Float32BufferAttribute(this.mix, 1));
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

// ---------------------------------------------------------------------------
// Joint blending. A joint between an upper bone and a lower bone sits at a
// bind-space height; vertices within `radius` of it are shared between the
// two bones (50/50 exactly at the joint), so both sides deform as one surface.
// A hinge (knee, elbow, the front of the hip) folds on one side: there the
// blend narrows to `crease.radius` so the fold stays a tight crease instead of
// the upper bone's surface sticking out past the lower one.

export function jointWeights(own, joints) {
  return p => {
    for (const j of joints) {
      const s = j.y - p.y;                 // > 0 below the joint
      // Overhang past the joint (a pant leg reaching below the knee, a neck
      // reaching into the helmet) belongs to the other bone.
      const across = j.ownIsLower ? s < 0 : s > 0;
      if (Math.abs(s) >= j.radius) {
        if (across) return [own, j.other, 0];
        continue;
      }
      let r = j.radius;
      if (j.crease) {
        const dx = p.x - j.x, dz = p.z - j.z, len = Math.hypot(dx, dz) || 1;
        const facing = (dx * j.crease.x + dz * j.crease.z) / len;
        // Narrow on the fold side, full width on the outside, with a wide
        // transition around the limb so neighbouring vertices stay close.
        r += (j.crease.radius - r) * smoothstep(-0.6, 0.9, facing);
        if (Math.abs(s) >= r) return across ? [own, j.other, 0] : [own, own, 1];
      }
      const lower = smoothstep(-r, r, s);
      return j.ownIsLower ? [own, j.other, lower] : [own, j.other, 1 - lower];
    }
    return [own, own, 1];
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

const HEADER = `
attribute vec2 athBones;
attribute float athMix;
attribute vec3 athSurface;
attribute vec4 athDetail;
varying vec3 vAthSurface;
varying vec4 vAthDetail;
uniform highp sampler2D athBoneTexture;
mat4 athBone(float index) {
  int row = int(index + 0.5);
  return mat4(
    texelFetch(athBoneTexture, ivec2(0, row), 0),
    texelFetch(athBoneTexture, ivec2(1, row), 0),
    texelFetch(athBoneTexture, ivec2(2, row), 0),
    texelFetch(athBoneTexture, ivec2(3, row), 0));
}
mat4 athSkin() {
  return athBone(athBones.x) * athMix + athBone(athBones.y) * (1.0 - athMix);
}
`;

const DEPTH_HEADER = HEADER.replace('attribute vec3 athSurface;\nattribute vec4 athDetail;\nvarying vec3 vAthSurface;\nvarying vec4 vAthDetail;\n', '');

const FRAGMENT_HEADER = `
varying vec3 vAthSurface;
varying vec4 vAthDetail;
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

export function skinMaterial(material, boneTexture, { depth = false, detailMap = null } = {}) {
  const detailed = () => !!detailMap && material.userData.athDetail !== false;
  material.onBeforeCompile = shader => {
    shader.uniforms.athBoneTexture = { value: boneTexture };
    if (depth) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + DEPTH_HEADER)
        .replace('#include <begin_vertex>', 'mat4 athM = athSkin();\nvec3 transformed = (athM * vec4(position, 1.0)).xyz;');
      return;
    }
    // Always present: three.js keeps one uniforms object per material, the
    // last compiled program's, so a program compiled with the detail layer
    // and reused after a plain one would otherwise never get its texture.
    if (detailMap) shader.uniforms.athDetailMap = { value: detailMap };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + HEADER)
      .replace('#include <beginnormal_vertex>', 'mat4 athM = athSkin();\nvec3 objectNormal = normalize(mat3(athM) * normal);')
      .replace('#include <begin_vertex>', 'vec3 transformed = (athM * vec4(position, 1.0)).xyz;\nvAthSurface = athSurface;\nvAthDetail = athDetail;');
    shader.fragmentShader = (detailed() ? '#define ATH_DETAIL\n' : '') + shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAGMENT_HEADER)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + ROUGHNESS)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vAthSurface.y;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + NORMAL)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor *= vAthSurface.z;\n#endif');
  };
  material.customProgramCacheKey = () => 'athlete-skin-' + material.type + (depth ? '-depth' : detailed() ? '-detail' : '');
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
