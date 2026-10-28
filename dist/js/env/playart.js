import * as THREE from '../../vendor/three.module.js';
import { formationFor, RECEIVERS, ROUTE_COLORS, routeFor } from '../plays.js';
import { canvasTexture } from './common.js';

// Pre-snap route art painted on the grass: dashed ribbons with arrowheads in
// the five route colours.

const WIDTH = 0.2;
const DASH = 1.0;   // yards per dash period
let dashTexture = null;

function dashes() {
  if (!dashTexture) {
    dashTexture = canvasTexture(64, 4, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, w * 0.68, h);
    }, { srgb: false });
    dashTexture.wrapS = THREE.RepeatWrapping;
  }
  return dashTexture;
}

// A flat ribbon along a polyline (scene coordinates), uv.x = distance / DASH.
function ribbon(points) {
  const positions = [], uvs = [], index = [];
  let distance = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) distance += p.distanceTo(points[i - 1]);
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    const d0 = p.clone().sub(prev).setY(0), d1 = next.clone().sub(p).setY(0);
    if (d0.lengthSq() < 1e-6) d0.copy(d1);
    if (d1.lengthSq() < 1e-6) d1.copy(d0);
    d0.normalize(); d1.normalize();
    const tangent = d0.add(d1).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const miter = 1 / Math.max(0.35, normal.dot(new THREE.Vector3(-d1.z, 0, d1.x)));
    for (const side of [-1, 1]) {
      const v = p.clone().addScaledVector(normal, side * WIDTH * 0.5 * miter);
      positions.push(v.x, v.y, v.z);
      uvs.push(distance / DASH, side < 0 ? 0 : 1);
    }
    if (i > 0) {
      const a = (i - 1) * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}

function arrowhead(end, prev) {
  const d = end.clone().sub(prev).setY(0).normalize(), n = new THREE.Vector3(-d.z, 0, d.x);
  const tip = end.clone().addScaledVector(d, 0.25);
  const back = end.clone().addScaledVector(d, -0.55);
  const geometry = new THREE.BufferGeometry().setFromPoints([
    tip, back.clone().addScaledVector(n, 0.38), back.clone().addScaledVector(n, -0.38),
  ]);
  geometry.setIndex([0, 2, 1]);
  return geometry;
}

function material(color, map = null) {
  return new THREE.MeshBasicMaterial({
    color, map, transparent: true, opacity: 0.92, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: false,
  });
}

export function rebuildPlayArt(group, play, spot, flip) {
  while (group.children.length) {
    const child = group.children[0];
    group.remove(child);
    child.geometry?.dispose();
    child.material?.dispose();
  }
  RECEIVERS.forEach((id, i) => {
    const start = formationFor(play).find(p => p.id === id);
    const route = routeFor(play, id, spot, flip);
    const points = [
      new THREE.Vector3(flip ? -start.x : start.x, 0.03, -(spot + start.z)),
      ...route.map(p => new THREE.Vector3(p.x, 0.03, -p.z)),
    ];
    if (points.length < 2) return;
    const line = new THREE.Mesh(ribbon(points), material(ROUTE_COLORS[i], dashes()));
    line.renderOrder = 3;
    group.add(line);
    const head = new THREE.Mesh(arrowhead(points.at(-1), points.at(-2)), material(ROUTE_COLORS[i]));
    head.renderOrder = 3;
    group.add(head);
  });
}
