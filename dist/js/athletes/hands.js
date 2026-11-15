// Hand shapes. A shape is eight numbers that the rig turns into the angles
// of a hand's fifteen finger joints (rig.js):
//   [knuckle, index, middle, ring, pinky, spread, thumbCurl, thumbOppose]
// knuckle bends all four fingers at the knuckles (0 flat, 1 a right angle
// and a bit); each finger's own number curls its two outer joints (0
// straight, 1 closed); spread fans the fingers apart (0 together, 1 wide);
// thumbCurl bends the thumb's joints and thumbOppose swings it across the
// palm (negative: out to the side). All zeros is the flat hand the glove is
// modelled in. Shapes blend number by number.

export const HAND = {
  FLAT: [0, 0, 0, 0, 0, 0, 0, 0],
  // Hanging loose: a little curl, more toward the little finger.
  RELAXED: [0.2, 0.24, 0.3, 0.36, 0.42, 0.12, 0.25, 0.2],
  FIST: [0.95, 1, 1, 1, 1, 0, 0.75, 0.9],
  // A catching hand: wide and open, thumb out.
  SPREAD: [0.08, 0.12, 0.1, 0.12, 0.16, 1, 0.05, -0.25],
  // A passer's hand on the ball: fingers apart over the laces, thumb under.
  GRIP: [0.36, 0.34, 0.4, 0.44, 0.5, 0.8, 0.35, 0.55],
  // The fingertips a lineman's stance rests on: knuckles bent, fingers straight.
  TRIPOD: [0.5, 0.05, 0.05, 0.05, 0.05, 0.55, 0.1, 0.05],
  // The claw over the point of a tucked ball.
  CARRY: [0.5, 0.45, 0.45, 0.5, 0.55, 0.45, 0.45, 0.6],
  // A tackler's grab at cloth or a leg.
  CLAMP: [0.7, 0.75, 0.75, 0.75, 0.75, 0.2, 0.6, 0.7],
  // A blocker's open hand: heel of the palm forward, fingers up and back.
  PUNCH: [0.04, 0.18, 0.18, 0.18, 0.2, 0.4, 0.1, -0.15],
  // A sprinter's blade hand: straight and together.
  BLADE: [0.06, 0.08, 0.08, 0.1, 0.12, 0, 0.1, 0.25],
  POINT: [0.9, 0, 1, 1, 1, 0, 0.7, 0.85],
};

// Moves hand i of a pose toward a shape by `weight` (0..1).
export function setHand(pose, i, shape, weight = 1) {
  if (weight <= 0) return;
  const f = pose.fingers[i];
  if (weight >= 1) { for (let k = 0; k < 8; k++) f[k] = shape[k]; return; }
  for (let k = 0; k < 8; k++) f[k] += (shape[k] - f[k]) * weight;
}

// Asks for a hand's attitude instead of leaving it to the forearm: `palm` is
// the direction the palm should face and `point` the direction the fingers
// should run, both in the chest frame (as the hand targets are). The rig
// turns the wrist as far as a wrist goes toward it. `weight` blends from the
// pose's current request.
export function aimHand(pose, i, palm, point, weight = 1) {
  if (weight <= 0) return;
  const a = pose.aim[i], t = a + weight > 0 ? weight / (a * (1 - weight) + weight) : 1;
  pose.palm[i].lerp(palm, t);
  pose.point[i].lerp(point, t);
  pose.aim[i] = a + (1 - a) * weight;
}
