import * as THREE from '../../vendor/three.module.js';

// Aerial perspective for every fogged material in the scene (the facility and
// the athletes alike): three.js's exponential-squared distance fog is replaced
// by analytic height fog. Haze is densest at ground level and thins with a
// scale height of FOG_SCALE_HEIGHT yards, so the far end zone, the tree belts
// and the hills step back in distinct layers while tree tops and light poles
// stay clearer than their bases. Extinction also grows with distance (by
// FOG_DISTANCE_GAIN per yard), which keeps the play itself clear while the
// horizon still dissolves into the sky. It still reads scene.fog
// (THREE.FogExp2): `fogDensity` is the extinction per yard at ground level
// next to the camera and `fogColor` the colour the distance fades to, which
// is also the sky's horizon haze.
//
// The fog chunks are shared by all built-in materials, so they are patched
// once, before any material is compiled.

export const FOG_SCALE_HEIGHT = 55;   // yards
export const FOG_DISTANCE_GAIN = 0.0025;

const PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogRay;   // camera to fragment, world axes
#endif
`;

const VERTEX = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogRay = transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif
`;

const PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogRay;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;

const FRAGMENT = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    // Optical depth of an exponential atmosphere along the view ray.
    float fogRise = vFogRay.y * ${(1 / FOG_SCALE_HEIGHT).toFixed(6)};
    float fogColumn = abs( fogRise ) > 0.001 ? ( 1.0 - exp( - fogRise ) ) / fogRise : 1.0 - 0.5 * fogRise;
    float fogLength = length( vFogRay );
    float fogFactor = 1.0 - exp( - fogDensity * fogLength * ( 1.0 + fogLength * ${FOG_DISTANCE_GAIN.toFixed(6)} ) * fogColumn * exp( - max( cameraPosition.y, 0.0 ) * ${(1 / FOG_SCALE_HEIGHT).toFixed(6)} ) );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;

let installed = false;

export function installHeightFog() {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.fog_pars_vertex = PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FRAGMENT;
}

// The fraction of light from `distance` yards away, at height `y`, that the
// haze replaces for a camera at height `cameraY` (the shader's formula; used
// by tests and to place the sky's horizon haze).
export function fogAmount(density, distance, y = 0, cameraY = 0) {
  const rise = (y - cameraY) / FOG_SCALE_HEIGHT;
  const column = Math.abs(rise) > 0.001 ? (1 - Math.exp(-rise)) / rise : 1 - 0.5 * rise;
  return 1 - Math.exp(-density * distance * (1 + distance * FOG_DISTANCE_GAIN) * column * Math.exp(-Math.max(cameraY, 0) / FOG_SCALE_HEIGHT));
}
