// Small helpers for the bench. The bench keeps its own random stream so the
// scripted players never draw from the simulation's seeded generator: a
// change to the bench must not shift the defense's dice.

// A 32-bit generator (mulberry32): the same seed gives the same sequence.
export function generator(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One seed from several integers, well mixed, never zero.
export function mix(...parts) {
  let h = 0x811C9DC5;
  for (const part of parts) {
    h = Math.imul(h ^ (part >>> 0), 0x01000193);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12;
  }
  return (h >>> 0) || 1;
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const lerp = (a, b, t) => a + (b - a) * t;
export const topSpeed = p => p.top ?? p.speed ?? 8.5;

// Whether a defender is tied up in a block. A player can see this on the
// field; if the simulation stops exposing it the bench treats him as free.
export const blocked = d => !!(d.engaged || d.lock);

// The nearest defender to a point, and how far.
export function nearest(defense, p, skipBlocked = false) {
  let best = null, far = Infinity;
  for (const d of defense) {
    if (skipBlocked && blocked(d)) continue;
    const g = Math.hypot(d.x - p.x, d.z - p.z);
    if (g < far) { far = g; best = d; }
  }
  return { d: best, gap: far };
}

// How fast `d` closes on `p` (yd/s, positive while the gap shrinks).
export function closing(d, p) {
  const g = Math.max(1e-6, Math.hypot(p.x - d.x, p.z - d.z));
  return ((d.vx - p.vx) * (p.x - d.x) + (d.vz - p.vz) * (p.z - d.z)) / g;
}

// Yards covered in `t` s from speed `v`, accelerating at `accel` up to `top`.
export function travel(v, top, t, accel = 6) {
  if (v >= top) return top * t;
  const ramp = (top - v) / accel;
  if (t <= ramp) return v * t + 0.5 * accel * t * t;
  return v * ramp + 0.5 * accel * ramp * ramp + top * (t - ramp);
}

// The inverse: seconds to cover `s` yards from speed `v`.
export function timeFor(s, v, top, accel = 6) {
  v = Math.min(v, top);
  const ramp = (top - v) / accel, rampDist = v * ramp + 0.5 * accel * ramp * ramp;
  if (s >= rampDist) return ramp + (s - rampDist) / top;
  return (-v + Math.sqrt(v * v + 2 * accel * s)) / accel;
}
