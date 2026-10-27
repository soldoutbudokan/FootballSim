import * as THREE from '../vendor/three.module.js';
import { ContactShadows, FIELD, noiseTexture, sceneZ } from './env/common.js';
import { buildGoalPost, buildGround, buildPylons, createTurfMaterial, lineOverlay, setTurfQuality } from './env/field.js';
import { buildFence, buildFilmTower, buildLampGlow, buildLightPoles, buildTeamBuilding } from './env/facility.js';
import { buildSidelineProps } from './env/props.js';
import { GROUND_RADIUS, buildHorizonBuildings, buildParking, buildTerrain, buildTreeLine, buildTrees } from './env/landscape.js';
import { SkyDome } from './env/sky.js';
import { Lighting, PRESETS } from './env/lighting.js';
import { GrassTufts } from './env/grass.js';
import { rebuildPlayArt } from './env/playart.js';

// The outdoor practice facility: two natural-grass NFL fields, the team
// building, fence, light poles, film tower, sideline equipment, trees and
// horizon, plus sky, lighting, fog, exposure and pre-snap overlays.
// Scene units are yards; simulation +z maps to scene -z.
export class Environment {
  constructor(scene, renderer, assetManager) {
    this.scene = scene;
    this.renderer = renderer;
    this.assetManager = assetManager;
    this.root = new THREE.Group();
    this.root.name = 'facility';
    scene.add(this.root);
    scene.background = null;

    this.sky = new SkyDome(scene);
    this.lighting = new Lighting(scene, renderer, this.sky, assetManager);

    const textures = this.loadTextures();
    this.turf = createTurfMaterial(textures);
    buildGround(this.root, this.turf, GROUND_RADIUS);

    // Goal posts and pylons on both fields.
    this.ribbons = [];
    for (const centerX of [0, FIELD.secondFieldX]) {
      this.ribbons.push(...buildGoalPost(this.root, centerX, 0, -1).ribbons);
      this.ribbons.push(...buildGoalPost(this.root, centerX, 120, 1).ribbons);
      buildPylons(this.root, centerX);
    }

    const shadows = new ContactShadows();
    this.building = buildTeamBuilding(this.root, shadows);
    buildFence(this.root);
    const poles = buildLightPoles(this.root, shadows);
    this.lampLens = poles.lens;
    this.lampGlow = buildLampGlow(this.root, poles.heads);
    this.lighting.addPoleLights(poles.heads);
    buildFilmTower(this.root, shadows);
    this.sideline = buildSidelineProps(this.root, shadows);
    this.trees = buildTrees(this.root);
    buildTerrain(this.root);
    buildTreeLine(this.root);
    buildParking(this.root, shadows);
    buildHorizonBuildings(this.root);
    for (const [x, z] of [[0, 0], [0, 120], [FIELD.secondFieldX, 0], [FIELD.secondFieldX, 120]]) {
      shadows.add(x, sceneZ(z + (z ? 2 : -2)), 1.1, 1.1, { strength: 0.5 });
    }
    this.contactShadows = shadows.build(this.root);

    // Line of scrimmage and first-down line, painted-on style overlays.
    this.los = lineOverlay('#3e8fe6', 0.15, 0.78);
    this.firstDown = lineOverlay('#f2c230', 0.18, 0.85);
    this.firstDown.visible = false;
    this.root.add(this.los, this.firstDown);

    this.art = new THREE.Group();
    this.art.name = 'play-art';
    scene.add(this.art);

    this.grass = new GrassTufts(scene, this.turf.userData.uniforms);
    this.time = 0;
    this.shadowFocus = new THREE.Vector3(0, 0, -30);
    this.root.updateMatrixWorld(true);
    // Glass reflects the sky more strongly than the global environment level.
    this.lighting.onEnvironment = (texture, preset) => {
      const glass = this.building.glass;
      if (glass.envMap !== texture) {
        glass.envMap = texture;
        glass.needsUpdate = true;
      }
      glass.envMapIntensity = preset.environment.intensity * 2.4;
    };
    this.setLighting('day');
  }

  loadTextures() {
    const loader = new THREE.TextureLoader(this.assetManager);
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const tiled = (url, srgb) => {
      const texture = loader.load(url);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = anisotropy;
      if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    return {
      grass: tiled('./assets/grasslight-big.jpg', true),
      dirt: tiled('./assets/sparse_grass_diff_1k.jpg', true),
      normal: tiled('./assets/sparse_grass_nor_gl_1k.jpg', false),
      noise: noiseTexture(256, 1907, 8, 5),
    };
  }

  setLighting(mode) {
    this.lighting.setPreset(mode);
    const p = PRESETS[this.lighting.mode];
    this.lampLens.emissiveIntensity = p.lamps * 9;
    this.lampGlow.visible = p.lamps > 0.5;
    this.building.glass.emissiveIntensity = p.windows;
    this.lighting.followFocus(this.shadowFocus, true);
  }

  setQuality(profile) {
    this.profile = profile;
    this.lighting.setQuality(profile);
    const level = profile.props ?? 1;
    this.trees.setCount([0.35, 0.7, 1, 1][Math.min(3, level)]);
    this.sideline.detail.visible = level >= 1;
    setTurfQuality(this.turf, level >= 1);
    this.grass.setCount(profile.grass || 0);
  }

  setPlay(play, spot, flip, toGo = null) {
    rebuildPlayArt(this.art, play, spot, flip);
    this.los.position.z = sceneZ(spot);
    this.firstDown.visible = toGo !== null;
    this.firstDown.position.z = sceneZ(Math.min(110, spot + (toGo ?? 0)));
    this.spot = spot;
    this.shadowFocus.set(0, 0, sceneZ(spot + 6));
    this.lighting.followFocus(this.shadowFocus, true);
  }

  // Once per rendered frame: wind, clouds, the shadow frustum that follows the
  // ball, and the grass tile that follows the camera. `focus` (scene
  // coordinates) is where the camera looks; it defaults to the ball.
  update(state, dt, { menu = false, focus = null, grass = true } = {}) {
    this.time += dt;
    this.sky.update(dt);
    const wind = 0.6 + 0.4 * Math.sin(this.time * 0.37) * Math.sin(this.time * 0.13 + 1.7);

    // Shadow frustum: around the controlled player / ball, biased downfield so
    // receivers in their routes keep their shadows.
    const anchor = this.actionPoint(state);
    const target = new THREE.Vector3(anchor.x * 0.6, 0, sceneZ(anchor.z + 7));
    const k = 1 - Math.exp(-dt * 10);
    this.shadowFocus.lerp(target, menu ? 1 : k);
    this.lighting.followFocus(this.shadowFocus);

    if (this.grass.enabled) {
      this.grass.mesh.visible = grass;
      this.grass.update(dt, focus || target, wind);
    }
    if (this.profile?.detail !== false) this.animateRibbons(wind);
  }

  actionPoint(state) {
    if (state.phase === 'air') return state.ball;
    const id = state.carrier || state.selected;
    return state.players.find(p => p.id === id) || state.ball;
  }

  // Goal-post wind ribbons ripple downwind.
  animateRibbons(wind) {
    for (let r = 0; r < this.ribbons.length; r++) {
      const ribbon = this.ribbons[r], base = ribbon.userData.base, pos = ribbon.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3], y = base[i * 3 + 1];
        const wave = Math.sin(this.time * 7 + x * 5 + r) * 0.07 * x;
        pos.setXYZ(i, x * 0.96, y - x * (0.32 - wind * 0.22), wave);
      }
      pos.needsUpdate = true;
    }
  }
}
