export const CHROME_MAX_SURFACES = 8;

export const CHROME_SURFACE_KIND_INDEX = {
  panel: 0,
  sidebar: 1,
  composer: 2,
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
// The window is sculpted black glass-metal. Under the sidebar it is a set of
// rounded slabs: an upper slab behind the navigation, a sweep that leaves the
// window's left edge low down and rises into the channel, a ribbon under the
// sweep and a pillow beside the channel. The content panels and the composer
// sit in thin rolled frames. Every edge is a broad bevel, lit in screen space:
// a key light from the upper right paints wide white highlights on the edges
// that face it and a soft sheen on gently tilted faces, a top light catches
// upward edges, and blue light comes from below. The forms drift slowly.
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

out vec4 outColor;

const vec3 BLUE = vec3(0.1, 0.45, 1.0);
const vec3 WHITE = vec3(0.92, 0.96, 1.0);
const float TAU = 6.2831853;
const float WINDOW_RADIUS = 18.0;

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

float gauss(float x, float mean, float width) {
  return exp(-pow((x - mean) / width, 2.0));
}

// Polynomial smooth minimum: a rounded union with no crease where the two
// distances meet.
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Wide enough to close the gap between neighbouring panels, so the frame runs
// around them as one ring.
const float OUTER_BLEND = 48.0;

struct Panels {
  float shell; // nearest content panel edge, negative inside
  float outer; // content panels fused into one block, negative inside
  float composer;
};

Panels panels(vec2 p) {
  Panels result = Panels(1e5, 1e5, 1e5);
  for (int i = 0; i < MAX_SURFACES; i++) {
    if (i >= uSurfaceCount) break;
    int kind = int(uSurfaceKind[i] + 0.5);
    float d = sdRoundRect(p, uSurfaceRect[i], uSurfaceRadii[i]);
    if (kind == 2) {
      result.composer = min(result.composer, d);
    } else if (kind == 0) {
      result.shell = min(result.shell, d);
      result.outer = smin(result.outer, d, OUTER_BLEND);
    }
  }
  return result;
}

// A rounded bevel rising from a boundary: steepest at the boundary and level
// by the radius, so each edge carries a broad band of changing normals.
float bevel(float d, float height, float radius) {
  float t = clamp(d / radius, 0.0, 1.0);
  return height * (1.0 - (1.0 - t) * (1.0 - t));
}

// The sculpted forms are laid out across the sidebar, in u from the window's
// left edge to the channel, and down the window in v. Set once per pixel.
float gSculptX = 0.0;

// The sidebar's edge along the channel: it bulges toward the panel beside
// the navigation and runs straight beside the pillow.
float channelEdge(float v) {
  float bulge = pow(max(sin(clamp(v / 0.56, 0.0, 1.0) * 3.14159), 0.0), 0.8);
  return gSculptX + 16.0 * bulge + 10.0 * smoothstep(0.85, 1.0, v);
}

// Signed distances into the slabs, positive inside: x the upper slab, y the
// ribbon under the sweep, z the pillow.
vec3 slabDistances(vec2 p) {
  float H = uViewport.y;
  float u = p.x / gSculptX;
  float v = p.y / H;
  float drift = 0.008 * sin(uTime * 0.09 + u * 2.4);
  float pxPerU = gSculptX / H;
  // The sweep: the upper slab's lower edge, an S-curve fitted to the mockup,
  // and the ribbon's top just below it.
  float vA = 0.78 - 0.05 * u - 0.35 * u * u + 0.2 * u * u * u + drift;
  float slopeA = (-0.05 - 0.7 * u + 0.6 * u * u) / pxPerU;
  float scaleA = 1.0 / sqrt(1.0 + slopeA * slopeA);
  float dA = (vA - v) * H * scaleA;
  float vB = vA + 0.03;
  float dB = (v - vB) * H * scaleA;
  // The pillow's flank: it leaves the sweep partway along and runs down to
  // the window's bottom-left corner.
  float vF = 0.647 + 0.348 * (0.79 - u) / 0.69 + 0.006 * sin(uTime * 0.07 + u * 3.0);
  float slopeF = -0.504 / pxPerU;
  float dF = (v - vF) * H / sqrt(1.0 + slopeF * slopeF);
  float dEdge = channelEdge(v) - p.x;
  float dTop = p.y - 1.0;
  // The sweep and the ribbon run on out of the window's left edge; only the
  // upper slab's top corner rounds there.
  float dLeft = p.x + 6.0;
  float upper = smin(smin(dA, dEdge, 90.0), smin(dTop, dLeft, 40.0), 30.0);
  float ribbon = smin(smin(dB, -dF, 30.0), dEdge, 30.0);
  float pillow = smin(smin(dB, dF, 50.0), dEdge, 50.0);
  return vec3(upper, ribbon, pillow);
}

float sculpt(vec2 p) {
  if (gSculptX < 40.0) return 0.0;
  vec3 s = slabDistances(p);
  float v = p.y / uViewport.y;
  float u = p.x / gSculptX;
  float h = bevel(s.x, 22.0, 26.0) + bevel(s.y, 18.0, 14.0) + bevel(s.z, 20.0, 18.0);
  // The pillow domes up, so the side of it toward the sweep and the channel
  // turns to the key in a broad sheen.
  h += bevel(s.z, 50.0, 80.0);
  // A second, much wider roll on each slab's edge: the glass thickening
  // toward its rim, which turns broad bands of each face toward the light.
  h += bevel(s.x, 26.0, 90.0) + bevel(s.z, 14.0, 60.0);
  // The upper slab bows gently.
  h += 18.0 * smoothstep(0.0, 160.0, s.x) * sin(clamp(v / 0.75, 0.0, 1.0) * 3.14159);
  return h;
}

float surfaceHeight(vec2 p) {
  Panels d = panels(p);
  float h = sculpt(p);
  // The frame around the content panels rolls up from their edges.
  h += bevel(d.outer, 8.0, 12.0) * step(0.0, d.outer);
  // The composer's ring: a rounded glass tube around the input.
  h += 9.0 * sqrt(max(1.0 - pow((d.composer - 8.0) / 8.0, 2.0), 0.0));
  // The metal rolls over at the window edge.
  float inset = -sdRoundRect(p, vec4(vec2(0.0), uViewport), vec4(WINDOW_RADIUS));
  h -= 6.0 * (1.0 - smoothstep(0.0, 8.0, inset));
  // After a layout change the metal around the edges sloshes once and settles.
  float outside = max(d.outer, 0.0);
  h += sin(outside * 0.11 - uSettle.x * 11.0) * exp(-outside / 70.0) * 7.0 * uSettle.y;
  return h;
}

vec3 surfaceNormal(vec2 p, float eps) {
  float dx = surfaceHeight(p + vec2(eps, 0.0)) - surfaceHeight(p - vec2(eps, 0.0));
  float dy = surfaceHeight(p + vec2(0.0, eps)) - surfaceHeight(p - vec2(0.0, eps));
  return normalize(vec3(-dx, -dy, 2.0 * eps));
}

// Screen-space lighting for the glass-metal. steep is 0 on a level face and
// 1 on a vertical wall; dir is the way the surface faces on screen. Every
// bevel draws a thin white rim where it passes a set steepness, brightest
// toward the key; gently tilted faces that lean toward the key carry a broad
// sheen; the steepest walls turn blue.
vec3 shade(vec3 n) {
  float steep = 1.0 - n.z;
  vec2 dir = normalize(n.xy + vec2(1e-5));
  float key = 0.5 + 0.5 * dot(dir, normalize(vec2(0.92, -0.4)));
  float low = max(dot(dir, normalize(vec2(-0.5, 0.86))), 0.0);
  vec3 c = uBase * 0.9;
  c += vec3(0.55, 0.6, 0.68) * 0.42 * smoothstep(0.0, 0.32, steep) * pow(key, 2.2);
  float rim = exp(-pow((steep - 0.42) / 0.06, 2.0));
  c += WHITE * rim * (0.3 + 1.0 * pow(key, 4.0));
  float wall = smoothstep(0.55, 0.9, steep);
  c += BLUE * wall * (0.25 + 0.9 * low + 0.6 * pow(key, 4.0));
  return c;
}

vec3 pulse(vec2 p) {
  if (uPulse.w <= 0.0) return vec3(0.0);
  float t = uPulse.z;
  float radius = pow(1.0 - t, 1.6) * 300.0;
  float dist = length(p - uPulse.xy);
  float ring = exp(-pow((dist - radius) / 26.0, 2.0)) * sin(3.14159 * t);
  float core = exp(-dist / 44.0) * smoothstep(0.55, 0.9, t) * (1.0 - t) * 2.4;
  return BLUE * 0.4 * (ring + core) * uPulse.w;
}

// Two comets travelling the composer ring in opposite directions, brighter
// while the composer has focus, and blue pooled at its ends.
vec3 composerLight(vec2 p, float d) {
  if (uComposer.z <= 0.0) return vec3(0.0);
  vec2 halfSize = uComposer.zw * 0.5;
  vec2 local = (p - uComposer.xy - halfSize) / max(halfSize, vec2(1.0));
  float angle = atan(local.y, local.x) / TAU;
  float t = uTime;
  float a = pow(0.5 + 0.5 * cos(TAU * (angle - t * 0.045)), 28.0);
  float b = pow(0.5 + 0.5 * cos(TAU * (angle + t * 0.032 + 0.37)), 40.0);
  float focus = uComposerShape.y;
  // A white line along the ring's outer edge, brightest along the top, and
  // blue pooled at its lower corners.
  float topLit = 0.35 + 0.65 * smoothstep(0.3, -0.9, local.y);
  float outerLine = gauss(d, 15.0, 1.3);
  float corners = smoothstep(0.75, 1.0, abs(local.x)) * smoothstep(-0.2, 0.8, local.y);
  vec3 light = WHITE * outerLine * (0.25 * topLit + (a + 0.6 * b) * (0.3 + 0.5 * focus));
  light += BLUE * corners * gauss(d, 10.0, 8.0) * (0.5 + 0.3 * focus);
  return light;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uViewport.y * uPixelRatio - gl_FragCoord.y) / uPixelRatio;
  float dither = (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  Panels d = panels(p);

  // Deep inside a content panel only the flat canvas shows, so most of the
  // screen skips the metal entirely.
  if (d.shell < -24.0 && d.composer > 40.0) {
    outColor = vec4(uBase + dither, 1.0);
    return;
  }

  float panelLeft = uViewport.x;
  for (int i = 0; i < MAX_SURFACES; i++) {
    if (i >= uSurfaceCount) break;
    if (int(uSurfaceKind[i] + 0.5) == 0) panelLeft = min(panelLeft, uSurfaceRect[i].x);
  }
  gSculptX = panelLeft - 14.0;

  vec3 metal = shade(surfaceNormal(p, 1.0));
  float u = p.x / max(gSculptX, 1.0);
  float v = p.y / uViewport.y;

  // Electric glints pooled on the slab edges, each with a white-hot core:
  // at the top of the channel, along the sweep, where the sweep meets the
  // channel and down the window's left edge.
  vec3 glow = vec3(0.0);
  if (gSculptX > 40.0) {
    vec3 s = slabDistances(p);
    float rimUpper = exp(-abs(s.x) / 6.0);
    float rimPillow = exp(-abs(s.z) / 6.0);
    float pools = gauss(v, 0.09, 0.05) * smoothstep(0.75, 1.0, u) * rimUpper
      + gauss(u, 0.42, 0.12) * gauss(v, 0.69, 0.05) * rimUpper
      + gauss(v, 0.52, 0.03) * smoothstep(0.85, 1.0, u) * rimUpper
      + gauss(v, 0.72, 0.1) * smoothstep(0.9, 1.05, u) * rimPillow;
    glow += BLUE * 2.6 * pools + WHITE * 1.2 * pools * pools * pools;
    glow += BLUE * 0.9 * gauss(v, 0.45, 0.2) * exp(-p.x / 8.0);
    // Bloom: the rims glow softly into the glass around them, white where
    // they face the key and blue elsewhere.
    float near = exp(-abs(s.x) / 14.0) + exp(-abs(s.z) / 14.0) + 0.6 * exp(-abs(s.y) / 12.0);
    float facing = smoothstep(0.6, 1.0, u);
    glow += (BLUE * 0.16 + WHITE * 0.05 * facing) * near;
    // Light trapped in the channel between the sidebar's edge and the panel.
    float channel = exp(-abs(p.x - 0.5 * (channelEdge(v) + panelLeft)) / 4.0);
    glow += BLUE * channel * (0.06 + 1.1 * gauss(v, 0.08, 0.05) + 0.7 * gauss(v, 0.55, 0.05) + 0.5 * gauss(v, 0.8, 0.1));
  }

  // The panel floor: the flat canvas with a lit lip at its edge.
  float lip = gauss(d.shell, -1.0, 1.0);
  vec3 floorColor = uBase + WHITE * lip * 0.12;
  float inPanel = clamp(0.5 - d.shell * uPixelRatio, 0.0, 1.0);
  vec3 color = mix(metal + glow, floorColor, inPanel);

  // The composer sits on the floor in its own frame.
  if (uComposer.z > 0.0 && d.composer < 40.0) {
    float inComposer = clamp(0.5 - d.composer * uPixelRatio, 0.0, 1.0);
    float frame = smoothstep(18.0, 15.0, d.composer) * (1.0 - inComposer);
    // A clear glass ring: its walls keep their white, not the blue the
    // sidebar's walls pick up.
    vec3 glass = vec3(dot(metal, vec3(0.35, 0.45, 0.2))) * vec3(0.88, 0.94, 1.0);
    color = mix(color, glass, frame * inPanel);
    color += composerLight(p, d.composer) * inPanel;
    color = mix(color, uBase, inComposer);
  }

  color += pulse(p) * (1.0 - inPanel);
  outColor = vec4(color + dither, 1.0);
}
`;
