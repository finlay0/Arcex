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
// The window is black chrome. Under the sidebar it is sculpted into rounded
// slabs that drift slowly; elsewhere it is a narrow frame around the content
// panels. Faces mirror a dark studio and rolled edges sweep across its ring
// light, so the metal reads as dark surfaces drawn with thin white lines, blue
// fringes and a few pooled electric glints. The sidebar's smoked glass covers
// the slab faces, and the composer is ringed by a chrome band.
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

const vec3 BLUE = vec3(0.06, 0.36, 1.0);
const vec3 BLUE_DEEP = vec3(0.02, 0.12, 0.85);
const vec3 ICE = vec3(0.62, 0.8, 1.0);
const float TAU = 6.2831853;
const float WINDOW_RADIUS = 18.0;

float sdRoundRect(vec2 p, vec4 rect, vec4 radii) {
  vec2 halfSize = rect.zw * 0.5;
  vec2 q = p - (rect.xy + halfSize);
  float r = q.x < 0.0 ? (q.y < 0.0 ? radii.x : radii.w) : (q.y < 0.0 ? radii.y : radii.z);
  vec2 d = abs(q) - halfSize + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

float gauss(float x, float mean, float width) {
  return exp(-pow((x - mean) / width, 2.0));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// Polynomial smooth minimum: a rounded union with no crease where the two
// distances meet.
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Wide enough to close the gap between neighbouring panels, so the rim runs
// around them as one ring.
const float OUTER_BLEND = 48.0;

struct Panels {
  float shell;   // nearest content panel edge, negative inside
  float outer;   // content panels fused into one block, negative inside
  float sidebar; // the sidebar glass, negative inside
  float composer;
};

Panels panels(vec2 p) {
  Panels result = Panels(1e5, 1e5, 1e5, 1e5);
  for (int i = 0; i < MAX_SURFACES; i++) {
    if (i >= uSurfaceCount) break;
    vec4 rect = uSurfaceRect[i];
    int kind = int(uSurfaceKind[i] + 0.5);
    float d = sdRoundRect(p, rect, uSurfaceRadii[i]);
    if (kind == 2) {
      result.composer = min(result.composer, d);
    } else if (kind == 1) {
      result.sidebar = min(result.sidebar, d);
    } else {
      result.shell = min(result.shell, d);
      result.outer = smin(result.outer, d, OUTER_BLEND);
    }
  }
  return result;
}

// Where the sculpted slabs meet the channel, just short of the main panel's
// left edge. Set once per pixel in main().
float gSculptX = 0.0;

// The sidebar's rolled edge along the channel: it leans out toward the panel
// near the top and bottom and tucks in where the sweep joins it.
float sidebarEdge(float v) {
  float bulge = sqrt(max(sin(clamp(v / 0.6, 0.0, 1.0) * 3.14159), 0.0));
  return gSculptX - 22.0 + 18.0 * bulge + 16.0 * smoothstep(0.55, 0.78, v)
    + 8.0 * smoothstep(0.85, 1.0, v);
}

// A rounded slab: steep where it rises from its boundary, flattening inside,
// so each edge sweeps the ring light once and draws a single crisp line.
float slab(float d, float height, float radius) {
  return height * (1.0 - exp(-max(d, 0.0) / radius));
}

// Distance in px from p to the curve v = c(u), given the curve's slope dc/du,
// positive below it.
float belowCurve(float v, float c, float slope) {
  float pxSlope = slope * uViewport.y / gSculptX;
  return (v - c) * uViewport.y / sqrt(1.0 + pxSlope * pxSlope);
}

// Signed distances into each slab, positive inside: the upper slab, the
// pillow and the corner slab.
vec3 slabDistances(vec2 p) {
  float u = p.x / gSculptX;
  float v = p.y / uViewport.y;
  float drift = 0.01 * sin(uTime * 0.09 + u * 2.0);
  float vA = 0.78 - 0.1 * u - 0.12 * u * u + drift;
  float vB = vA + 0.038 * (1.0 - 0.4 * u);
  float vC = 0.86 + 1.2 * u;
  float dA = -belowCurve(v, vA, -0.1 - 0.24 * u);
  float dB = belowCurve(v, vB, -0.125 - 0.24 * u);
  float dC = -belowCurve(v, vC, 1.2);
  float dEdge = sidebarEdge(v) - p.x;
  // Smooth minimums round each slab's corners instead of mitring them. Every
  // slab also rolls over at the window's left edge, and the upper one at its
  // top, mostly out of view.
  float windowSide = p.x - 3.0;
  float upper = smin(smin(dA, dEdge, 40.0), smin(p.y + 4.0, windowSide, 50.0), 30.0);
  float pillow = smin(smin(smin(dB, dEdge, 40.0), dC, 60.0), windowSide, 24.0);
  float corner = smin(smin(-dC, dEdge, 40.0), windowSide, 24.0);
  return vec3(upper, pillow, corner);
}

// The sculpted metal under the sidebar: rounded slabs separated by dark
// grooves. The upper slab fills the sidebar down to a sweep that leaves the
// window's left edge low down and rises into the channel; under it sit a
// pillow and a corner slab. Coordinates run across the sidebar and down the
// window, so the forms follow the sidebar when it is resized.
float sculpt(vec2 p) {
  if (gSculptX < 40.0) return 0.0;
  float u = p.x / gSculptX;
  float v = p.y / uViewport.y;
  vec3 slabs = slabDistances(p);
  float h = slab(slabs.x, 12.0, 6.0) + slab(slabs.y, 18.0, 7.0) + slab(slabs.z, 12.0, 6.0);
  // Slow swells across the faces, so they carry gradients rather than
  // reading flat: the upper slab bows, the pillow rises toward the channel.
  h += 34.0 * sin(clamp(v / 0.75, 0.0, 1.0) * 3.14159) * smoothstep(0.0, 1.0, slabs.x / 40.0);
  h += 40.0 * u * u * smoothstep(0.0, 1.0, slabs.y / 50.0);
  return h;
}

float bezel(float d, float height, float outer, float inner) {
  return d > 0.0 ? height * exp(-d / outer) : height * exp(d / inner);
}

// Distance in from the window edge, positive inside.
float windowInset(vec2 p) {
  return -sdRoundRect(p, vec4(vec2(0.0), uViewport), vec4(WINDOW_RADIUS));
}

float surfaceHeight(vec2 p) {
  float h = sculpt(p);
  Panels d = panels(p);
  // A thick rolled rim around the content panels; on their left it is the
  // ribbon running down the channel beside the sidebar.
  h += bezel(d.outer, 12.0, 6.0, 2.0);
  // The channel between neighbouring content panels is a shallow groove.
  h += bezel(d.shell, 3.0, 4.0, 2.0) * smoothstep(0.0, -4.5, d.outer);
  h += bezel(d.composer, 10.0, 5.0, 2.0);
  // The metal rolls over at the window edge, lighting a thin outer rim.
  h -= 10.0 * exp(-max(windowInset(p), 0.0) / 4.0);
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

// The studio, addressed by the reflected ray's screen-plane direction: flat
// metal reflects the black ceiling, tilted metal picks up the lights. The
// lights are narrow, so they come back as streaks rather than broad washes.
vec3 studio(vec2 e, float soft) {
  float r = length(e);
  float a = atan(e.y, e.x);
  // Faces that barely tilt see a dark grey falloff and a dim softbox, which
  // gives the broad surfaces their slow gradients.
  vec3 c = vec3(0.003, 0.004, 0.006) + vec3(0.012, 0.015, 0.02) * smoothstep(0.1, 0.9, r);
  c += vec3(0.6, 0.66, 0.78) * 0.1 * exp(-pow(length(e - vec2(-0.22, -0.3)) / 0.26, 2.0));
  // A ring light: every rolled edge sweeps across it and draws a thin white
  // line, brightest where it faces the key up and to the left.
  float key = 0.5 + 0.5 * cos(a + 2.2);
  float fill = 0.5 + 0.5 * cos(a - 0.7);
  float ring = exp(-pow((r - 0.62) / (0.07 + soft), 2.0));
  c += vec3(0.95, 0.97, 1.0) * ring * (0.8 + 3.0 * pow(key, 3.0) + 2.2 * pow(fill, 4.0));
  // Past it a broad blue gel, so each white line carries a blue fringe.
  float gel = exp(-pow((r - 0.8) / (0.06 + soft), 2.0));
  c += BLUE * gel * (0.03 + 1.2 * pow(fill, 6.0) + 0.9 * pow(key, 6.0));
  c += BLUE_DEEP * 0.05 * smoothstep(0.95, 1.0, r);
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

// The composer's chrome band: a hairline of light on its outer edge, blue
// where it turns the ends, two comets travelling it in opposite directions
// and a slow breathing glow. Focus brightens all of it.
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
  // Brightest along the top edge, like the studio key catching the rim.
  float topLit = 0.5 + 0.5 * smoothstep(0.4, -0.9, local.y);
  float ends = smoothstep(0.78, 1.0, abs(local.x));

  float outerLip = exp(-pow((d - 9.0) / 1.0, 2.0));
  float innerLip = exp(-pow((d - 0.7) / 0.8, 2.0));
  float halo = exp(-max(d - 9.0, 0.0) / (6.0 + 4.0 * focus)) * smoothstep(6.0, 9.0, d);

  vec3 ringWhite = mix(ICE, vec3(1.0), 0.55);
  vec3 light = ringWhite * outerLip * (0.1 + 0.32 * topLit * topLit + comets * 0.25);
  light += ringWhite * innerLip * (0.15 + 0.15 * topLit);
  light += BLUE * halo * (0.01 + 0.3 * ends * ends) * breathe;
  light += BLUE * halo * comets * 0.08;
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
  if (d.shell < -40.0 && d.composer > 140.0) {
    outColor = vec4(uBase + dither, 1.0);
    return;
  }

  float panelLeft = uViewport.x;
  float sidebarRight = -1e5;
  for (int i = 0; i < MAX_SURFACES; i++) {
    if (i >= uSurfaceCount) break;
    vec4 rect = uSurfaceRect[i];
    int kind = int(uSurfaceKind[i] + 0.5);
    if (kind == 0) panelLeft = min(panelLeft, rect.x);
    if (kind == 1) sidebarRight = max(sidebarRight, rect.x + rect.z);
  }
  gSculptX = panelLeft - 14.0;

  float aa = 0.75 / uPixelRatio;
  vec3 metal = shade(surfaceNormal(p, 1.0), 0.0);

  // A faint blue welling out of the gap around the panels.
  float rimDistance = d.outer;
  vec3 edgeGlow = BLUE * 0.125 * exp(-max(rimDistance, 0.0) / 14.0);
  // A lit lip on each rim's inner edge keeps the panel outlines crisp.
  float lip = exp(-pow((rimDistance - 1.0) / 1.0, 2.0));
  float sheen = clamp(dot(metal / (1.0 + metal), vec3(0.6)), 0.0, 1.0);
  vec3 lipLight = mix(ICE, vec3(1.0), 0.6) * lip;
  vec3 frame = metal + edgeGlow + lipLight * (0.2 + 0.6 * sheen) + pulse(p);
  // Light welling up in the groove between the sidebar's edge and the panel
  // rim, pooling where the sweep runs into it and near the window's ends.
  if (gSculptX > 40.0) {
    float v = p.y / uViewport.y;
    float along = 0.2 + exp(-pow((v - 0.58) / 0.07, 2.0)) + 0.8 * exp(-pow((v - 0.12) / 0.06, 2.0))
      + 0.7 * exp(-pow((v - 0.9) / 0.06, 2.0));
    float groove = 0.5 * (sidebarEdge(v) + panelLeft);
    frame += BLUE * 1.1 * (along - 0.15) * exp(-abs(p.x - groove) / 6.0);
  }

  // The outer rim: a thin line of light where the metal rolls over the
  // window edge.
  float rimLine = exp(-pow((windowInset(p) - 1.5) / 1.0, 2.0));
  frame += mix(ICE, vec3(1.0), 0.6) * rimLine * (0.25 + 0.75 * sheen);

  // The sidebar is smoked glass laid over the slabs. It covers each face,
  // clear of the lit rims, and fades out past the layout box. Behind the
  // navigation it is nearly opaque; behind the footer it lets the lower
  // slabs' gradients through.
  vec3 sidebarGlass = vec3(0.0);
  vec3 slabs = gSculptX < 40.0 ? vec3(-1.0) : slabDistances(p);
  vec3 cover = smoothstep(9.0, 22.0, slabs);
  float inSidebar = max(cover.x, max(cover.y, cover.z)) * smoothstep(0.0, -20.0, p.x - sidebarRight);
  if (inSidebar > 0.0) {
    float clarity = mix(0.04, 0.4, max(cover.y, cover.z));
    vec3 seen = metal + edgeGlow * 0.5;
    // Behind the text the highlights are capped, so no streak crosses a label.
    sidebarGlass = mix(min(seen, vec3(0.06)), seen, smoothstep(0.2, 0.6, clarity)) * clarity;
  }

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
  // The band is the same black chrome, pressed up out of the panel floor.
  float composerBand = smoothstep(11.0, 8.0, d.composer) * step(0.0, d.composer) * composerFade;
  // Neutral, so the band's steep normals don't mirror the blue gels all the
  // way round; the blue belongs to its ends.
  vec3 bandMetal = vec3(dot(metal, vec3(0.3, 0.4, 0.3))) * vec3(0.9, 0.95, 1.0);
  panel = mix(panel, bandMetal * 0.7, composerBand);
  panel += composerLight(p, d.composer) * composerFade;

  // Between panels: dimmed metal and a soft blue line, which hand back to the
  // full border where the channel meets the window edge.
  vec3 smoked = metal / (1.0 + metal) * 1.4;
  float channelDepth = smoothstep(0.0, 4.5, -d.outer);
  vec3 channel = mix(frame, smoked * 0.3 + BLUE * 0.08, channelDepth);

  float inPanel = clamp(0.5 - d.shell / aa, 0.0, 1.0);
  vec3 shell = mix(channel, panel, inPanel);
  float outside = clamp(0.5 + d.outer / aa, 0.0, 1.0);
  vec3 color = mix(shell, frame, outside);
  color = mix(color, sidebarGlass, inSidebar);

  // Electric glints pooled on the slab rims: at the top of the sidebar's edge,
  // where the sweep meets the channel, along the middle of the sweep and down
  // the window's left edge. Each has a white-hot core.
  if (gSculptX > 40.0) {
    float u = p.x / gSculptX;
    float v = p.y / uViewport.y;
    float rim = exp(-abs(slabs.x) / 2.5) + 0.7 * exp(-abs(slabs.y) / 2.5);
    float pools = gauss(v, 0.12, 0.045) * smoothstep(0.7, 0.95, u)
      + gauss(v, 0.57, 0.03) * smoothstep(0.75, 0.95, u)
      + gauss(u, 0.42, 0.08) * smoothstep(0.55, 0.62, v) * (1.0 - smoothstep(0.75, 0.82, v))
      + 0.6 * gauss(v, 0.9, 0.04) * smoothstep(0.85, 1.0, u);
    float glint = rim * pools;
    color += BLUE * 2.2 * glint + vec3(0.9, 0.95, 1.0) * 0.9 * glint * glint * glint;
    color += BLUE * 0.6 * gauss(v, 0.5, 0.16) * exp(-p.x / 5.0);
  }

  // A lit hairline just inside each panel edge keeps the glass crisp.
  float hairline = exp(-abs(d.shell + 0.6) * uPixelRatio * 1.4);
  color += hairline * (0.05 + 0.3 * clamp(dot(metal, vec3(0.33)), 0.0, 1.0));

  color = toneMap(color);
  // The base is sRGB so the panel interior matches the CSS canvas exactly.
  color += uBase * max(inPanel * (1.0 - composerBand), inSidebar * 0.5);
  outColor = vec4(color + dither, 1.0);
}
`;
