export const CHROME_MAX_SURFACES = 8;

export const CHROME_SURFACE_KIND_INDEX = {
  panel: 0,
  sidebar: 1,
  composer: 2,
} as const;

// Landmarks in the chrome plate (assets/chrome-plate.webp), in its own pixels:
// the main panel's edges and the composer input's edges. The plate is the
// mockup's chrome with its interface painted out; these are where the shader
// pins it to the live layout.
export const CHROME_PLATE = {
  width: 1755,
  height: 896,
  panel: { left: 318, top: 20, right: 1746, bottom: 878 },
  composer: { left: 596, top: 710, right: 1458, bottom: 850 },
} as const;

export const CHROME_VERTEX_SHADER = /* glsl */ `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Everything is computed in CSS pixels with a top-left origin so surface
// rects from getBoundingClientRect can be passed through untouched.
//
// The chrome is baked: a plate of the mockup's liquid metal, mapped piecewise
// so its panel edges land on the live panel's edges at any window size, with
// the composer's ring nine-sliced onto wherever the composer sits. The shader
// animates it: the metal wobbles slowly like a liquid, a soft light sweeps
// across its highlights, the blue breathes, comets run the composer ring and
// navigation sends a pulse into the sidebar.
export const CHROME_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

#define MAX_SURFACES ${CHROME_MAX_SURFACES}

uniform vec2 uViewport;
uniform float uPixelRatio;
uniform vec4 uSurfaceRect[MAX_SURFACES];
uniform vec4 uSurfaceRadii[MAX_SURFACES]; // top-left, top-right, bottom-right, bottom-left
uniform float uSurfaceKind[MAX_SURFACES];
uniform int uSurfaceCount;
uniform float uTime;
uniform vec4 uComposer;      // primary composer rect, zero size when absent
uniform vec2 uComposerShape; // radius, focus 0..1
uniform vec2 uSettle;        // ripple phase in seconds, energy 0..1
uniform vec4 uPulse;
uniform vec3 uBase;
uniform sampler2D uPlate;
uniform vec4 uPanelBox;      // live content panels' bounds: left, top, right, bottom

out vec4 outColor;

const vec2 PLATE_SIZE = vec2(${CHROME_PLATE.width}.0, ${CHROME_PLATE.height}.0);
const vec4 PLATE_PANEL = vec4(
  ${CHROME_PLATE.panel.left}.0, ${CHROME_PLATE.panel.top}.0,
  ${CHROME_PLATE.panel.right}.0, ${CHROME_PLATE.panel.bottom}.0
);
const vec4 PLATE_COMPOSER = vec4(
  ${CHROME_PLATE.composer.left}.0, ${CHROME_PLATE.composer.top}.0,
  ${CHROME_PLATE.composer.right}.0, ${CHROME_PLATE.composer.bottom}.0
);
// How far past the composer's edges its ring and glow reach in the plate.
const float RING_REACH = 26.0;
// The nine-slice corners: the ring keeps its true shape inside these.
const float RING_CORNER = 64.0;

const vec3 BLUE = vec3(0.06, 0.36, 1.0);
const vec3 ICE = vec3(0.62, 0.8, 1.0);
const float TAU = 6.2831853;

float sdRoundRect(vec2 p, vec4 rect, vec4 radii) {
  vec2 halfSize = rect.zw * 0.5;
  vec2 q = p - (rect.xy + halfSize);
  float r = q.x < 0.0 ? (q.y < 0.0 ? radii.x : radii.w) : (q.y < 0.0 ? radii.y : radii.z);
  vec2 d = abs(q) - halfSize + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

struct Panels {
  float shell;   // nearest content panel edge, negative inside
  float composer;
};

Panels panels(vec2 p) {
  Panels result = Panels(1e5, 1e5);
  for (int i = 0; i < MAX_SURFACES; i++) {
    if (i >= uSurfaceCount) break;
    int kind = int(uSurfaceKind[i] + 0.5);
    float d = sdRoundRect(p, uSurfaceRect[i], uSurfaceRadii[i]);
    if (kind == 2) {
      result.composer = min(result.composer, d);
    } else if (kind == 0) {
      result.shell = min(result.shell, d);
    }
  }
  return result;
}

// Three linear pieces, pinning live0 and live1 to plate0 and plate1, so the
// plate stretches between the panel edges and outside them independently.
float pin(float x, float live0, float live1, float liveEnd, float plate0, float plate1, float plateEnd) {
  // With the sidebar collapsed the leading strip is a few pixels wide; it
  // shows the plate at its own scale beside the panel rather than the whole
  // sidebar artwork squeezed flat.
  float leadScale = mix(1.0, plate0 / max(live0, 1.0), smoothstep(120.0, 220.0, live0));
  if (x < live0) return plate0 - (live0 - x) * leadScale;
  if (x > live1) return plate1 + (x - live1) / max(liveEnd - live1, 1.0) * (plateEnd - plate1);
  return plate0 + (x - live0) / max(live1 - live0, 1.0) * (plate1 - plate0);
}

// Nine-slice along one axis: within RING_CORNER of either edge the plate keeps
// its scale, so the ring's rounded ends never stretch.
float slice(float x, float live0, float live1, float plate0, float plate1) {
  float corner = min(RING_CORNER, 0.5 * (live1 - live0));
  if (x < live0 + corner) return plate0 + (x - live0);
  if (x > live1 - corner) return plate1 + (x - live1);
  float t = (x - live0 - corner) / max(live1 - live0 - 2.0 * corner, 1.0);
  return mix(plate0 + corner, plate1 - corner, t);
}

vec3 plate(vec2 q) {
  return texture(uPlate, q / PLATE_SIZE).rgb;
}

// A slow liquid wobble in plate space, stirred harder for a moment after a
// layout change. Thin lines shimmer at full strength, so callers scale it.
vec2 wobble(vec2 q, float strength) {
  float t = uTime;
  float amount = (0.7 + 4.0 * uSettle.y) * strength;
  return q + amount * vec2(
    sin(q.y * 0.031 + t * 0.55) + 0.5 * sin(q.y * 0.077 - t * 0.83 + q.x * 0.011),
    cos(q.x * 0.027 + t * 0.47) + 0.5 * cos(q.x * 0.069 + t * 0.71 - q.y * 0.013)
  );
}

// Light play on baked chrome: a soft band sweeps across the highlights and
// the blue breathes. Only already-bright and already-blue pixels respond, so
// the dark metal stays dark.
vec3 animateLight(vec3 c, vec2 p) {
  float t = uTime;
  float lum = dot(c, vec3(0.3, 0.5, 0.2));
  float travel = mod(t * 90.0, uViewport.x + uViewport.y + 800.0) - 400.0;
  float band = exp(-pow((p.x * 0.8 + p.y * 0.6 - travel) / 140.0, 2.0));
  c += c * smoothstep(0.15, 0.7, lum) * band * 0.7;
  float blueness = max(c.b - max(c.r, c.g), 0.0);
  c += BLUE * blueness * 0.35 * (0.5 + 0.5 * sin(t * 0.8 + p.y * 0.004));
  return c;
}

vec3 pulse(vec2 p) {
  if (uPulse.w <= 0.0) return vec3(0.0);
  float t = uPulse.z;
  float radius = pow(1.0 - t, 1.6) * 300.0;
  float dist = length(p - uPulse.xy);
  float ring = exp(-pow((dist - radius) / 26.0, 2.0)) * sin(3.14159 * t);
  float core = exp(-dist / 44.0) * smoothstep(0.55, 0.9, t) * (1.0 - t) * 2.4;
  return BLUE * 0.35 * (ring + core) * uPulse.w;
}

// Two comets travelling the composer ring in opposite directions, brighter
// while the composer has focus.
vec3 comets(vec2 p, float d) {
  vec2 halfSize = uComposer.zw * 0.5;
  vec2 local = (p - uComposer.xy - halfSize) / max(halfSize, vec2(1.0));
  float angle = atan(local.y, local.x) / TAU;
  float t = uTime;
  float a = pow(0.5 + 0.5 * cos(TAU * (angle - t * 0.045)), 28.0);
  float b = pow(0.5 + 0.5 * cos(TAU * (angle + t * 0.032 + 0.37)), 40.0);
  float line = exp(-pow((d - 7.0) / 2.5, 2.0));
  float focus = uComposerShape.y;
  return mix(ICE, vec3(1.0), 0.4) * line * (a + 0.6 * b) * (0.25 + 0.45 * focus);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uViewport.y * uPixelRatio - gl_FragCoord.y) / uPixelRatio;
  float dither = (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  Panels d = panels(p);

  // Deep inside a content panel only the flat canvas shows, so most of the
  // screen skips the plate entirely.
  if (d.shell < -60.0 && d.composer > RING_REACH + 4.0) {
    outColor = vec4(uBase + dither, 1.0);
    return;
  }

  vec2 q = vec2(
    pin(p.x, uPanelBox.x, uPanelBox.z, uViewport.x, PLATE_PANEL.x, PLATE_PANEL.z, PLATE_SIZE.x),
    pin(p.y, uPanelBox.y, uPanelBox.w, uViewport.y, PLATE_PANEL.y, PLATE_PANEL.w, PLATE_SIZE.y)
  );
  // The panel floor holds still; everything around it is liquid.
  float floorDepth = smoothstep(-2.0, -14.0, d.shell);
  vec3 color = plate(wobble(q, 1.0 - floorDepth));

  // The plate's own composer belongs to the mockup's layout, so its floor
  // takes the canvas colour there; the live composer's ring is drawn below.
  vec2 plateComposer = max(
    PLATE_COMPOSER.xy - RING_REACH - 24.0 - q,
    q - PLATE_COMPOSER.zw - vec2(RING_REACH + 24.0, 6.0)
  );
  float onPlateComposer = smoothstep(4.0, -10.0, max(plateComposer.x, plateComposer.y));
  color = mix(color, uBase, onPlateComposer * floorDepth);

  // The live composer's ring, nine-sliced from the plate's.
  if (uComposer.z > 0.0 && d.composer < RING_REACH) {
    vec4 live = vec4(uComposer.xy, uComposer.xy + uComposer.zw);
    vec2 r = vec2(
      slice(p.x, live.x, live.z, PLATE_COMPOSER.x, PLATE_COMPOSER.z),
      slice(p.y, live.y, live.w, PLATE_COMPOSER.y, PLATE_COMPOSER.w)
    );
    float ringMask =
      smoothstep(RING_REACH, RING_REACH - 10.0, d.composer) * smoothstep(-4.0, -1.0, d.composer);
    vec3 ring = plate(wobble(r, 0.3)) * (1.0 + 0.2 * uComposerShape.y);
    color = mix(color, ring, ringMask);
    color += comets(p, d.composer) * ringMask;
  }

  color = mix(animateLight(color, p) + pulse(p), color, floorDepth);
  outColor = vec4(color + dither, 1.0);
}
`;
