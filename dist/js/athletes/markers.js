import * as THREE from '../../vendor/three.module.js';
import { smoothstep } from './math.js';

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function blobTexture() {
  return canvasTexture(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2 - 1);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.65)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

// A thin silver ring with a brighter arc and a small notch on the side the
// player faces (the canvas bottom maps to the player's front).
function ringTexture() {
  return canvasTexture(256, (ctx, s) => {
    const c = s / 2, r = s * 0.4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(214,218,224,0.5)';
    ctx.lineWidth = s * 0.016;
    ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(240,242,245,0.95)';
    ctx.lineWidth = s * 0.026;
    ctx.beginPath(); ctx.arc(c, c, r, Math.PI / 2 - 0.55, Math.PI / 2 + 0.55); ctx.stroke();
    ctx.fillStyle = 'rgba(240,242,245,0.95)';
    ctx.beginPath();
    ctx.moveTo(c - s * 0.045, c + r + s * 0.03);
    ctx.lineTo(c + s * 0.045, c + r + s * 0.03);
    ctx.lineTo(c, c + r + s * 0.075);
    ctx.closePath(); ctx.fill();
  });
}

function flatPlane() {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

// Contact shadows (a soft blob under each body, each foot and the ball) and
// the control indicator under the controlled player.
export class Markers {
  constructor(scene, count) {
    const blob = blobTexture(), plane = flatPlane();
    const shadowMaterial = opacity => new THREE.MeshBasicMaterial({
      map: blob, transparent: true, depthWrite: false, opacity, color: '#000000',
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.count = count;
    this.bodies = new THREE.InstancedMesh(plane, shadowMaterial(0.32), count + 1);
    this.feet = new THREE.InstancedMesh(plane, shadowMaterial(0.3), count * 2);
    for (const mesh of [this.bodies, this.feet]) {
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.name = 'athletes:contact-shadows';
      scene.add(mesh);
    }
    const ringPlane = new THREE.PlaneGeometry(1.5, 1.5);
    ringPlane.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringPlane, new THREE.MeshBasicMaterial({
      map: ringTexture(), transparent: true, depthWrite: false, opacity: 0.8,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    this.ring.name = 'athletes:control-ring';
    this.ring.renderOrder = 2;
    scene.add(this.ring);
    this.controlId = null;
    this.pop = 1;
  }

  setQuality(profile) {
    const noShadowMaps = !profile.shadow;
    this.bodies.material.opacity = noShadowMaps ? 0.55 : 0.3;
    this.feet.material.opacity = noShadowMaps ? 0.45 : 0.32;
  }

  update(ctx, athletes, controlled, ball, menu) {
    let i = 0, f = 0;
    for (const p of ctx.state.players) {
      const rig = athletes.rigs.get(p.id);
      if (!rig) continue;
      const W = rig.world;
      // Body blob stretched along the body when it is lying down.
      const fx = (W.feet[0].x + W.feet[1].x) / 2, fz = (W.feet[0].z + W.feet[1].z) / 2;
      const dx = W.head.x - fx, dz = W.head.z - fz, along = Math.hypot(dx, dz);
      const yaw = along > 0.25 ? Math.atan2(dx, dz) : rig.root.rotation.y;
      const width = 0.78 * rig.dims.torso;
      _p.set((W.pelvis.x + W.head.x + fx) / 3, 0.014, (W.pelvis.z + W.head.z + fz) / 3);
      _s.set(width, 1, Math.max(0.7, along + 0.7));
      this.bodies.setMatrixAt(i++, _m.compose(_p, _q.setFromAxisAngle(UP, yaw), _s));
      // Foot blobs shrink as the foot leaves the ground.
      for (let k = 0; k < 2; k++) {
        const lift = smoothstep(0.08, 0.35, W.feet[k].y), size = 1 - lift;
        _p.set(W.feet[k].x + Math.sin(rig.root.rotation.y) * 0.05, 0.016, W.feet[k].z + Math.cos(rig.root.rotation.y) * 0.05);
        _s.set(0.2 * size + 1e-4, 1, 0.36 * size + 1e-4);
        this.feet.setMatrixAt(f++, _m.compose(_p, _q.setFromAxisAngle(UP, rig.root.rotation.y), _s));
      }
    }
    // Ball shadow fades out with height.
    const by = ball.position.y, bs = 0.34 * (1 - smoothstep(0.2, 4, by)) + 1e-4;
    _p.set(ball.position.x, 0.015, ball.position.z);
    _s.set(bs * 0.7, 1, bs);
    this.bodies.setMatrixAt(i++, _m.compose(_p, _q.setFromAxisAngle(UP, ball.flightYaw), _s));
    this.bodies.count = i;
    this.feet.count = f;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.feet.instanceMatrix.needsUpdate = true;

    // Control indicator: hidden in menus and after the whistle; pops gently
    // when control moves to another player.
    const rig = controlled && athletes.rigs.get(controlled.id);
    this.ring.visible = !!rig && !menu && !ctx.dead;
    if (!this.ring.visible) return;
    if (controlled.id !== this.controlId) { this.controlId = controlled.id; this.pop = 0; }
    this.pop = Math.min(1, this.pop + ctx.realDt / 0.3);
    const scale = 1 + 0.35 * (1 - smoothstep(0, 1, this.pop));
    this.ring.position.set(controlled.x, 0.02, -controlled.z);
    this.ring.rotation.set(0, rig.root.rotation.y, 0);
    this.ring.scale.set(scale, 1, scale);
    this.ring.material.opacity = 0.8 * (0.4 + 0.6 * smoothstep(0, 1, this.pop));
    this.ring.updateMatrixWorld(true);
  }
}
