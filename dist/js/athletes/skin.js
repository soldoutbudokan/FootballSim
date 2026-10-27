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
    this.bones = []; this.mix = []; this.surface = [];
    this.indices = []; this.detailIndices = [];
    this.vertexCount = 0;
  }

  // geometry: indexed BufferGeometry with position/normal (uv, color optional)
  // bind: Matrix4 part -> bind space (bone bind world x part local)
  // weights(p) -> [ownBone, otherBone, ownWeight] for a bind-space point
  // color: linear THREE.Color multiplied into the vertex colour (baked AO)
  // uv: function(u, v) -> [u, v] remapping the part's own uv
  // surface: [roughness, metalness]
  add(geometry, { bind, weights, color, uv = null, surface = [0.8, 0], detail = false }) {
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
      this.surface.push(surface[0], surface[1]);
    }
    const target = detail ? this.detailIndices : this.indices;
    const index = geometry.index;
    if (index) for (let i = 0; i < index.count; i++) target.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i++) target.push(base + i);
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
    g.setAttribute('athSurface', new THREE.Float32BufferAttribute(this.surface, 2));
    const all = this.indices.concat(this.detailIndices);
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(all, 1) : new THREE.Uint16BufferAttribute(all, 1));
    g.userData.baseCount = this.indices.length;
    g.userData.totalCount = all.length;
    // Bodies move anywhere on the field; the mesh is never frustum culled.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }
}

// ---------------------------------------------------------------------------
// Joint blending. A joint between an upper bone and a lower bone sits at a
// bind-space height; vertices within `radius` of it are shared between the
// two bones (50/50 exactly at the joint), so both sides deform as one surface.

export function jointWeights(own, joints) {
  return p => {
    for (const j of joints) {
      const s = j.y - p.y;                 // > 0 below the joint
      if (Math.abs(s) >= j.radius) continue;
      const lower = smoothstep(-j.radius, j.radius, s);
      const other = j.other;
      return j.ownIsLower ? [own, other, lower] : [own, other, 1 - lower];
    }
    return [own, own, 1];
  };
}

// ---------------------------------------------------------------------------
// Material patch: skins position and normal from the bone texture and takes
// roughness and metalness per vertex (the body merges cloth, skin, rubber and
// metal into one draw call).

const HEADER = `
attribute vec2 athBones;
attribute float athMix;
attribute vec2 athSurface;
varying vec2 vAthSurface;
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

export function skinMaterial(material, boneTexture, { depth = false } = {}) {
  material.onBeforeCompile = shader => {
    shader.uniforms.athBoneTexture = { value: boneTexture };
    let vs = shader.vertexShader.replace('#include <common>', '#include <common>\n' + HEADER);
    if (depth) {
      vs = vs.replace('#include <begin_vertex>', 'mat4 athM = athSkin();\nvec3 transformed = (athM * vec4(position, 1.0)).xyz;');
    } else {
      vs = vs
        .replace('#include <beginnormal_vertex>', 'mat4 athM = athSkin();\nvec3 objectNormal = normalize(mat3(athM) * normal);')
        .replace('#include <begin_vertex>', 'vec3 transformed = (athM * vec4(position, 1.0)).xyz;\nvAthSurface = athSurface;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vAthSurface;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vAthSurface.x;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vAthSurface.y;');
    }
    shader.vertexShader = vs;
  };
  material.customProgramCacheKey = () => 'athlete-skin-' + material.type;
  return material;
}

// A merged, skinned mesh ready for the scene, with shadow materials that skin
// the same way.
export function skinnedMesh(geometry, material, boneTexture, name) {
  const mesh = new THREE.Mesh(geometry, skinMaterial(material, boneTexture));
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
