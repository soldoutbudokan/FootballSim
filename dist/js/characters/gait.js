// Gait analysis and stride timing. Pure math on sampled foot tracks, so it is
// unit-testable without a renderer.
//
// At load the animation layer samples each locomotion clip (foot heights and
// fore-aft positions in character space, yards) and asks analyseGait for its
// step count, cadence and natural ground speed. At run time strideRate turns
// the simulation's speed into a playback rate so cadence follows speed.

// samples: {times[], leftY[], leftZ[], rightY[], rightZ[], hipsZ[]}, evenly
// spaced over one play-through of a looping clip (the last sample is NOT a
// repeat of the first). Returns null when the clip is not a gait (no
// alternating feet), else
//   {steps, cycles, duration, cadence (steps/s), speed (yd/s), stride (yd/step),
//    leftStrike (0..1 phase where the left foot is furthest forward), rootMotion}
export function analyseGait(samples, duration) {
  const n = samples.times.length;
  if (n < 8 || !(duration > 0)) return null;
  const fwdL = samples.leftZ.map((z, i) => z - samples.hipsZ[i]);
  const fwdR = samples.rightZ.map((z, i) => z - samples.hipsZ[i]);
  const diff = fwdL.map((l, i) => l - fwdR[i]);

  // Count alternations of which foot is ahead, with hysteresis so jitter in a
  // standing clip is not mistaken for steps.
  const amplitude = Math.max(...diff) - Math.min(...diff);
  if (amplitude < 0.08) return null; // feet never separate by ~3 inches: not a gait
  const band = amplitude * 0.2;
  let state = 0, start = 0;
  for (let i = 0; i < n; i++) { if (Math.abs(diff[i]) > band) { state = Math.sign(diff[i]); start = i; break; } }
  if (!state) return null;
  let steps = 0;
  for (let k = 1; k <= n; k++) {
    const v = diff[(start + k) % n];
    if (state > 0 && v < -band) { state = -1; steps++; }
    else if (state < 0 && v > band) { state = 1; steps++; }
  }
  if (steps < 2 || steps % 2) steps = Math.max(2, steps + (steps % 2)); // a loop holds whole cycles
  const cycles = steps / 2;
  const cadence = steps / duration;

  // Natural speed: root motion if the hips travel, else how fast the planted
  // foot slides backward under the body.
  const travel = samples.hipsZ[n - 1] - samples.hipsZ[0];
  const dt = duration / n;
  let speed;
  const rootMotion = Math.abs(travel) > 0.25; // in-place clips only sway a few inches
  if (rootMotion) speed = Math.abs(travel) / (dt * (n - 1));
  else speed = (plantedSpeed(samples.leftY, fwdL, dt) + plantedSpeed(samples.rightY, fwdR, dt)) / 2;
  if (!(speed > 0)) speed = 0;

  // Phase of the left foot's furthest-forward point: a sync marker so
  // walk/run/sprint blend with their feet in step.
  let best = 0;
  for (let i = 1; i < n; i++) if (diff[i] > diff[best]) best = i;
  return {
    steps, cycles, duration, cadence, speed,
    stride: cadence > 0 ? speed / cadence : 0,
    leftStrike: best / n,
    rootMotion,
  };
}

// Speed of a foot while it is low (planted): it slides under the body at the
// ground speed. The median ignores swing frames that graze the threshold;
// the sign is dropped so backpedal clips measure too.
function plantedSpeed(height, forward, dt) {
  const n = height.length;
  const min = Math.min(...height), max = Math.max(...height);
  const limit = min + (max - min) * 0.2;
  const v = [];
  for (let i = 0; i < n; i++) {
    if (height[i] <= limit) v.push(-(forward[(i + 1) % n] - forward[(i - 1 + n) % n]) / (2 * dt));
  }
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return Math.abs(v[Math.floor(v.length / 2)]);
}

// Human running cadence (steps/s) for a ground speed (yd/s): ~1.8 at a walk,
// 3.2 at 5 yd/s, 4.5 at a 9 yd/s sprint (plan 4.6).
export function targetCadence(speed) {
  const table = [[0, 1.6], [1.5, 1.8], [3, 2.6], [5, 3.2], [9, 4.5], [11, 4.9]];
  const s = Math.max(0, speed);
  for (let i = 1; i < table.length; i++) {
    const [s1, c1] = table[i], [s0, c0] = table[i - 1];
    if (s <= s1) return c0 + ((s - s0) / (s1 - s0)) * (c1 - c0);
  }
  return table[table.length - 1][1];
}

// Playback for one locomotion clip at a ground speed.
//   gait: analyseGait result (or {cadence, speed, steps, duration} nominal)
// Returns {timeScale, cycleRate (cycles/s), stretch}. The clip's cadence is
// matched to its natural stride when that is plausible, clamped toward the
// human cadence curve; `stretch` > 1 means the stride must be exaggerated
// (procedurally) because the clip's natural stride is too short.
export function strideRate(gait, speed) {
  if (!gait || !(gait.cadence > 0)) return { timeScale: 1, cycleRate: 0, stretch: 1 };
  const human = targetCadence(speed);
  // Cadence that keeps the planted foot still: speed / natural stride.
  const matched = gait.stride > 0 ? speed / gait.stride : human;
  const cadence = Math.min(human * 1.25, Math.max(human * 0.8, matched));
  const timeScale = cadence / gait.cadence;
  const stretch = gait.stride > 0 && speed > 0 ? Math.min(1.6, Math.max(1, speed / (cadence * gait.stride))) : 1;
  return { timeScale, cycleRate: cadence / gait.steps, stretch };
}

// Linear blend weights across a 1D blend space.
//   points: [{slot, speed}] sorted by speed (only available slots)
// Returns [{slot, weight}] with at most two non-zero entries.
export function blendSpace1D(points, value) {
  if (!points.length) return [];
  if (points.length === 1 || value <= points[0].speed) return [{ slot: points[0].slot, weight: 1 }];
  const last = points[points.length - 1];
  if (value >= last.speed) return [{ slot: last.slot, weight: 1 }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (value <= b.speed) {
      const t = (value - a.speed) / Math.max(1e-6, b.speed - a.speed);
      return [{ slot: a.slot, weight: 1 - t }, { slot: b.slot, weight: t }];
    }
  }
  return [{ slot: last.slot, weight: 1 }];
}
