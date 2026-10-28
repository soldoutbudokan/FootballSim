// Uniform materials for a cloned player.
//  - "materials" mode: the model names its clothing (Jersey, Pants, Helmet,
//    Skin, Socks, Shoes, ...). Each named material is recoloured per slot.
//  - "regions" mode: a model without named clothing (one material, or names
//    like "Body") gets body regions painted into a per-player vertex colour
//    attribute from its skin weights (positions, normals and weights stay
//    shared). The colour's alpha carries the region's roughness so a glossy
//    helmet and a matte jersey can share one material.
// Textures are kept and tinted by their luminance, so a coloured texture
// still reads as the team colour. Materials are cached and shared.
import * as THREE from '../../vendor/three.module.js';
import { slotForMaterial, recolourMode, classifyRegions, regionColor, REGIONS } from './palette.js';

// Surface feel per slot / region.
export const FINISH = {
  jersey: { roughness: 0.84, metalness: 0 },
  pants: { roughness: 0.55, metalness: 0 },
  helmet: { roughness: 0.26, metalness: 0.12 },
  facemask: { roughness: 0.45, metalness: 0.5 },
  visor: { roughness: 0.1, metalness: 0.3 },
  socks: { roughness: 0.92, metalness: 0 },
  shoes: { roughness: 0.5, metalness: 0 },
  gloves: { roughness: 0.75, metalness: 0 },
  skin: { roughness: 0.6, metalness: 0 },
  number: { roughness: 0.8, metalness: 0 },
};

// Converts any loader material (FBX gives Phong/Lambert) to a standard one.
function toStandard(material) {
  if (material.isMeshStandardMaterial) return material.clone();
  const out = new THREE.MeshStandardMaterial({
    color: material.color ? material.color.clone() : new THREE.Color(1, 1, 1),
    map: material.map || null, normalMap: material.normalMap || null,
    transparent: material.transparent, opacity: material.opacity ?? 1, alphaTest: material.alphaTest || 0,
    side: material.side ?? THREE.FrontSide, roughness: 0.7, metalness: 0,
  });
  out.name = material.name;
  return out;
}

// Shader tweaks: texture luminance tint, and region colours with roughness
// in the vertex colour alpha.
function customise(material, { tint, regions }) {
  if (!tint && !regions) return material;
  material.onBeforeCompile = shader => {
    let fs = shader.fragmentShader;
    if (tint) {
      fs = fs.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          float luma = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          diffuseColor *= vec4( vec3( clamp( luma * 1.7, 0.0, 1.2 ) ), sampledDiffuseColor.a );
        #endif`);
    }
    if (regions) {
      fs = fs.replace('#include <color_fragment>', `
        #if defined( USE_COLOR_ALPHA )
          diffuseColor.rgb *= vColor.rgb;
        #endif`);
      fs = fs.replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness;
        #if defined( USE_COLOR_ALPHA )
          roughnessFactor = vColor.a;
        #endif`);
    }
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => `footballsim-uniform-${tint ? 't' : ''}${regions ? 'r' : ''}`;
  return material;
}

export class UniformMaterials {
  constructor(asset) {
    this.asset = asset;
    this.cache = new Map();
    const entries = asset.rig.meshes.flatMap(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(m => ({ materialName: m.name, meshName: mesh.name })));
    this.mode = recolourMode(entries);
    if (this.mode === 'regions') this.regions = this.computeRegions();
  }

  // One cached material per (source material, slot, colour).
  material(source, slot, color) {
    const key = source.uuid + '|' + slot + '|' + color + '|' + this.mode;
    if (!this.cache.has(key)) {
      const m = toStandard(source);
      if (this.mode === 'regions') {
        m.vertexColors = true; m.color.set('#ffffff'); m.metalness = 0;
        customise(m, { tint: !!m.map, regions: true });
      } else if (slot && slot !== 'keep') {
        m.color.set(color);
        Object.assign(m, FINISH[slot] || {});
        customise(m, { tint: !!m.map });
      }
      m.needsUpdate = true;
      this.cache.set(key, m);
    }
    return this.cache.get(key);
  }

  // Region index per vertex for each skinned mesh (computed once).
  computeRegions() {
    const { rig, vertices, joints } = this.asset;
    const out = new Map();
    for (const mesh of rig.meshes) {
      const g = mesh.geometry;
      const regions = classifyRegions({
        count: g.attributes.position.count,
        skinIndex: attributeArray(g.attributes.skinIndex), skinWeight: attributeArray(g.attributes.skinWeight, true),
        position: vertices.get(mesh), boneCanon: boneCanonicals(mesh.skeleton, rig), joints,
      });
      out.set(g.uuid, regions);
      // The reduced mesh keeps its representatives' regions.
      const lod = this.asset.lods?.get(g.uuid);
      if (lod) out.set(lod.geometry.uuid, Uint8Array.from(lod.source, v => regions[v]));
    }
    return out;
  }

  // Dresses one cloned player: every skinned mesh gets its uniform.
  dress(clone, uniform) {
    clone.traverse(node => {
      if (!node.isSkinnedMesh) return;
      const list = Array.isArray(node.material) ? node.material : [node.material];
      const dressed = list.map(m => {
        const slot = this.mode === 'regions' ? null : slotForMaterial(m.name, node.name);
        return this.material(m, slot, slot ? uniform[slot] || '#ffffff' : '#ffffff');
      });
      node.material = Array.isArray(node.material) ? dressed : dressed[0];
      if (this.mode === 'regions') node.geometry = this.paint(node.geometry, uniform);
    });
  }

  // A geometry sharing every attribute except a new RGBA vertex colour
  // (linear colour, alpha = roughness).
  paint(geometry, uniform) {
    const regions = this.regions.get(geometry.uuid);
    if (!regions) return geometry;
    const key = geometry.uuid + '|' + REGIONS.map(r => uniform[r]).join(',');
    if (this.cache.has(key)) return this.cache.get(key);
    const g = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) g.setAttribute(name, attribute);
    g.setIndex(geometry.index);
    for (const group of geometry.groups) g.addGroup(group.start, group.count, group.materialIndex);
    g.boundingBox = geometry.boundingBox; g.boundingSphere = geometry.boundingSphere;
    const palette = REGIONS.map(r => {
      const c = new THREE.Color(regionColor(uniform, r)); // sRGB hex -> linear working colour
      return [c.r, c.g, c.b, (FINISH[r] || FINISH.jersey).roughness];
    });
    const colors = new Uint16Array(regions.length * 4);
    for (let v = 0; v < regions.length; v++) {
      const c = palette[regions[v]];
      for (let k = 0; k < 4; k++) colors[v * 4 + k] = Math.round(c[k] * 65535);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 4, true));
    this.cache.set(key, g);
    return g;
  }
}

// Plain per-vertex values of an attribute (de-interleaved; weights
// de-normalised to 0..1 when stored as normalised integers).
function attributeArray(attribute, normalise = false) {
  const n = attribute.itemSize, count = attribute.count;
  if (!attribute.isInterleavedBufferAttribute && !(normalise && attribute.normalized)) return attribute.array;
  const out = new Float32Array(count * n);
  for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) out[i * n + k] = attribute.getComponent(i, k);
  return out;
}

// Canonical name (or nearest canonical ancestor) for each bone index.
function boneCanonicals(skeleton, rig) {
  const byBone = new Map(Object.entries(rig.canon).map(([c, b]) => [b, c]));
  return skeleton.bones.map(bone => {
    for (let b = bone; b; b = b.parent) if (byBone.has(b)) return byBone.get(b);
    return 'Hips';
  });
}
