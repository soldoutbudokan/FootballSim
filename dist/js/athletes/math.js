// Small numeric helpers shared by the athlete modules. Units are yards,
// seconds and radians throughout.

export const TAU = Math.PI * 2;

// Limb index 0 is the athlete's left (+X in his root frame), 1 his right (-X).
export const SIDES = [1, -1];

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = v => clamp(v, 0, 1);
export const fract = v => v - Math.floor(v);

export function smoothstep(edge0, edge1, x) {
  const t = saturate((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// 0 -> 1 -> 0 bump over [a, b], peaking in the middle.
export function bump(a, b, x) {
  if (x <= a || x >= b) return 0;
  return Math.sin(Math.PI * (x - a) / (b - a));
}

export const easeOut = t => 1 - (1 - saturate(t)) ** 2;
export const easeInOut = t => smoothstep(0, 1, t);

// Frame-rate independent exponential approach toward `target`.
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

// Moves an angle toward a target by at most `maxStep`, taking the short way round.
export function approachAngle(current, target, maxStep) {
  const delta = wrapAngle(target - current);
  return Math.abs(delta) <= maxStep ? target : current + Math.sign(delta) * maxStep;
}

// Stable per-player variation without touching any random number generator.
export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

// Piecewise Catmull-Rom interpolation through keyed [time, x, y, z] rows.
// Used for hand-authored arm paths such as the throwing motion.
export function sampleTrack(track, t, out) {
  if (t <= track[0][0]) return out.set(track[0][1], track[0][2], track[0][3]);
  const last = track[track.length - 1];
  if (t >= last[0]) return out.set(last[1], last[2], last[3]);
  let i = 0;
  while (t > track[i + 1][0]) i++;
  const p0 = track[Math.max(0, i - 1)], p1 = track[i], p2 = track[i + 1], p3 = track[Math.min(track.length - 1, i + 2)];
  const u = (t - p1[0]) / (p2[0] - p1[0]);
  const spline = k => {
    const a = p0[k], b = p1[k], c = p2[k], d = p3[k];
    return 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  };
  return out.set(spline(1), spline(2), spline(3));
}
