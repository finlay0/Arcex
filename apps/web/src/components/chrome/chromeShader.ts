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
// rects from getBoundingClientRect can be passed through untouched. The
// surface is a height field: large folded ribbons that drift slowly, plus a
// raised bezel along every panel edge. Its normals reflect a procedural studio
// (softboxes, a horizon strip and two blue gels), which reads as polished metal.
export const CHROME_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

#define MAX_SURFACES ${CHROME_MAX_SURFACES}

uniform vec2 uViewport;
uniform float uPixelRatio;
uniform vec4 uSurfaceRect[MAX_SURFACES];
uniform vec2 uSurfaceShape[MAX_SURFACES];
uniform int uSurfaceCount;
uniform float uTime;
uniform vec4 uComposer;      // primary composer rect, zero size when absent
uniform vec2 uComposerShape; // radius, focus 0..1
uniform vec2 uSettle;        // ripple phase in seconds, energy 0..1
uniform vec4 uPulse;
uniform vec3 uBase;

out vec4 outColor;

const vec3 BLUE = vec3(0.06, 0.36, 1.0);
const vec3 BLUE_DEEP = vec3(0.02, 0.12, 0.85);
const vec3 ICE = vec3(0.62, 0.8, 1.0);
const float TAU = 6.2831853;

float sdRoundRect(vec2 p, vec4 rect, float radius) {
  vec2 halfSize = rect.zw * 0.5;
  vec2 q = abs(p - (rect.xy + halfSize)) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

vec2 rotate(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

struct Panels {
  float shell;   // nearest panel or sidebar edge, negative inside
  float sidebar; // nearest sidebar edge
  float composer;
};

Panels panels(vec2 p) {
  Panels result = Panels(1e5, 1e5, 1e5);
  for (int i = 0; i < MAX_SURFACES; i++) {
    if (i >= uSurfaceCount) break;
    float d = sdRoundRect(p, uSurfaceRect[i], uSurfaceShape[i].x);
    int kind = int(uSurfaceShape[i].y + 0.5);
    if (kind == 2) {
      result.composer = min(result.composer, d);
    } else {
      result.shell = min(result.shell, d);
      if (kind == 1) result.sidebar = min(result.sidebar, d);
    }
  }
  return result;
}

// Folded sheets: a domain-warped wave field whose smooth-abs creases give the
// thin, bright fold lines of bent ribbon metal. The warp phases drift by a few
// hundredths of a radian per second, so the metal flows without ever moving fast.
float ribbons(vec2 q) {
  float t = uTime;
  vec2 w = q;
  w += 0.24 * vec2(sin(q.y * 2.1 + 0.6 + t * 0.07), sin(q.x * 1.6 + 2.3 - t * 0.055));
  w += 0.09 * vec2(sin(w.y * 4.3 + 1.1 - t * 0.11), sin(w.x * 3.7 + 0.3 + t * 0.09));
  float a = sin(w.x * 2.4 - w.y * 1.8 + 0.4 + t * 0.035);
  float b = sin(-w.x * 1.3 - w.y * 3.4 + 1.9 - t * 0.045);
  float c = sin(w.x * 4.9 + w.y * 3.8 + 0.8 + t * 0.08);
  float folded = sqrt(a * a + 0.015);
  return 0.62 * folded + 0.34 * b + 0.1 * c;
}

float bezel(float d, float height, float outer, float inner) {
  return d > 0.0 ? height * exp(-d / outer) : height * exp(d / inner);
}

float surfaceHeight(vec2 p) {
  float minSide = min(uViewport.x, uViewport.y);
  float h = ribbons(p / minSide) * minSide * 0.3;
  Panels d = panels(p);
  h += bezel(d.shell, 16.0, 13.0, 2.5);
  h += bezel(d.composer, 9.0, 9.0, 2.0);
  // After a layout change the metal around the edges sloshes once and settles.
  float outside = max(d.shell, 0.0);
  h += sin(outside * 0.11 - uSettle.x * 11.0) * exp(-outside / 70.0) * 7.0 * uSettle.y;
  return h;
}

vec3 surfaceNormal(vec2 p, float eps) {
  float dx = surfaceHeight(p + vec2(eps, 0.0)) - surfaceHeight(p - vec2(eps, 0.0));
  float dy = surfaceHeight(p + vec2(0.0, eps)) - surfaceHeight(p - vec2(0.0, eps));
  return normalize(vec3(-dx, -dy, 2.0 * eps));
}

// The studio, addressed by the reflected ray's screen-plane direction: flat
// metal reflects the black ceiling, tilted metal picks up the lights.
vec3 studio(vec2 e, float soft) {
  float r = length(e);
  vec3 c = vec3(0.002, 0.0025, 0.0035) + vec3(0.02, 0.024, 0.032) * smoothstep(0.25, 1.0, r);

  float key = sdBox(rotate(e - vec2(-0.44, -0.54), 0.62), vec2(0.22, 0.03));
  c += vec3(1.0, 1.0, 1.03) * 3.2 * smoothstep(0.025 + soft, -0.01, key);

  float strip = sdBox(rotate(e - vec2(0.34, -0.6), -0.52), vec2(0.3, 0.01));
  c += vec3(0.92, 0.96, 1.0) * 2.0 * smoothstep(0.015 + soft, -0.005, strip);

  float horizon = exp(-pow((r - 0.9) / (0.02 + soft), 2.0)) * smoothstep(0.3, -0.5, e.y);
  c += vec3(0.85, 0.9, 1.0) * 1.3 * horizon;

  // Blue gels sit at grazing angles, so only steep folds and bezels catch them.
  c += BLUE * 2.6 * exp(-pow(length(e - vec2(0.74, 0.6)) / (0.2 + soft), 2.0));
  c += BLUE_DEEP * 1.6 * exp(-pow(length(e - vec2(-0.82, 0.28)) / (0.18 + soft), 2.0));
  c += BLUE * 1.2 * smoothstep(0.86, 1.0, r) * smoothstep(-0.6, 0.4, e.y);
  c += vec3(0.5, 0.62, 0.9) * 0.4 * exp(-pow(length(e - vec2(0.08, 0.86)) / (0.12 + soft), 2.0));
  return c;
}

vec3 shade(vec3 n, float soft) {
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
  return studio(r.xy, soft) * vec3(0.93, 0.96, 1.0);
}

vec3 pulse(vec2 p) {
  if (uPulse.w <= 0.0) return vec3(0.0);
  float t = uPulse.z;
  float radius = pow(1.0 - t, 1.6) * 300.0;
  float dist = length(p - uPulse.xy);
  float ring = exp(-pow((dist - radius) / 26.0, 2.0)) * sin(3.14159 * t);
  float core = exp(-dist / 44.0) * smoothstep(0.55, 0.9, t) * (1.0 - t) * 2.4;
  return BLUE * (ring + core) * uPulse.w;
}

// Light running around the composer: two comets travel the rim in opposite
// directions over a slow breathing glow. Focus brightens all of it.
vec3 composerLight(vec2 p, float d) {
  if (uComposer.z <= 0.0) return vec3(0.0);
  vec2 halfSize = uComposer.zw * 0.5;
  vec2 local = (p - uComposer.xy - halfSize) / max(halfSize, vec2(1.0));
  float angle = atan(local.y, local.x) / TAU;
  float t = uTime;
  float cometA = pow(0.5 + 0.5 * cos(TAU * (angle - t * 0.045)), 28.0);
  float cometB = pow(0.5 + 0.5 * cos(TAU * (angle + t * 0.032 + 0.37)), 40.0);
  float comets = cometA * 1.6 + cometB * 0.9;
  float focus = uComposerShape.y;
  float breathe = 0.82 + 0.18 * sin(t * 0.7);

  float rim = exp(-pow((d - 1.0) / 2.2, 2.0));
  float halo = exp(-max(d, 0.0) / (16.0 + 10.0 * focus)) * step(-0.5, d);

  vec3 light = ICE * rim * comets * (1.4 + 1.6 * focus);
  light += BLUE * halo * (0.16 + 0.3 * focus) * breathe;
  light += BLUE * halo * comets * (0.5 + 0.7 * focus);
  return light;
}

vec3 toneMap(vec3 c) {
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uViewport.y * uPixelRatio - gl_FragCoord.y) / uPixelRatio;
  float dither = (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  Panels d = panels(p);

  // Deep inside a content panel only the flat canvas shows, so most of the
  // screen skips the metal entirely. That is what keeps the ambient drift cheap.
  if (d.shell < -40.0 && d.sidebar > 0.0 && d.composer > 140.0) {
    outColor = vec4(uBase + dither, 1.0);
    return;
  }

  float minSide = min(uViewport.x, uViewport.y);
  float aa = 0.75 / uPixelRatio;
  vec3 metal = shade(surfaceNormal(p, 1.0), 0.0);
  float ribbon = ribbons(p / minSide);

  // Emissive blue bleeding out from under the panel edges, strongest where a
  // ribbon crest runs into the edge.
  float crest = smoothstep(0.35, 1.05, ribbon);
  vec3 edgeGlow = BLUE * (0.18 + 0.9 * crest) * exp(-max(d.shell, 0.0) / 22.0);
  vec3 frame = metal + edgeGlow + pulse(p);

  // The sidebar is smoked glass: the sharp metal stays legible behind it, just
  // dimmed far enough for text, with a narrow sheen where the glass meets the bezel.
  vec3 smoked = metal / (1.0 + metal) * 1.4;
  float sidebarEdge = exp(min(d.sidebar, 0.0) / 30.0);
  vec3 sidebar = smoked * (0.045 + 0.1 * sidebarEdge) + pulse(p) * 0.5;

  // Content panels show the metal only as a frosted sheen along their edges:
  // normals from a wide stencil and a softened studio stand in for a blur.
  // Both fade to exactly zero before the early-out above takes over; gamma
  // would otherwise turn their faint tails into a visible seam.
  vec3 panel = vec3(0.0);
  if (d.shell > -40.0) {
    vec3 frost = shade(surfaceNormal(p, 14.0), 0.22);
    float edgeFade = exp(min(d.shell, 0.0) / 12.0) * smoothstep(-36.0, -10.0, d.shell);
    panel = frost / (1.0 + frost) * 1.6 * 0.07 * edgeFade;
  }
  float composerFade = smoothstep(140.0, 70.0, d.composer);
  float composerHalo = exp(-max(d.composer, 0.0) / 26.0) * step(0.0, d.composer) * composerFade;
  vec3 composerRim = metal * 0.85 + BLUE * (0.25 + 0.75 * crest) * 0.6;
  panel = mix(panel, composerRim, composerHalo * 0.9);
  panel += composerLight(p, d.composer) * composerFade;

  float inSidebar = clamp(0.5 - d.sidebar / aa, 0.0, 1.0);
  vec3 interior = mix(panel, sidebar, inSidebar);
  float outside = clamp(0.5 + d.shell / aa, 0.0, 1.0);
  vec3 color = mix(interior, frame, outside);

  // A lit hairline just inside each panel edge keeps the glass crisp.
  float hairline = exp(-abs(d.shell + 0.6) * uPixelRatio * 1.4);
  color += hairline * (0.03 + 0.22 * clamp(dot(metal, vec3(0.33)), 0.0, 1.0));

  color = toneMap(color);
  // The base is sRGB so the panel interior matches the CSS canvas exactly.
  color += uBase * (1.0 - outside) * (1.0 - composerHalo * (1.0 - inSidebar));
  outColor = vec4(color + dither, 1.0);
}
`;
