import plateUrl from "~/assets/chrome-plate.webp";

import {
  CHROME_FRAGMENT_SHADER,
  CHROME_MAX_SURFACES,
  CHROME_SURFACE_KIND_INDEX,
  CHROME_VERTEX_SHADER,
} from "./chromeShader";
import type { ChromeSurfaceKind } from "./chromeSurfaces";

export interface ChromeSurfaceRect {
  readonly kind: ChromeSurfaceKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Corner radii: top-left, top-right, bottom-right, bottom-left. */
  readonly radii: readonly [number, number, number, number];
}

export interface ChromeFrame {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly surfaces: ReadonlyArray<ChromeSurfaceRect>;
  /** Seconds of ambient drift; frozen while motion is paused. */
  readonly time: number;
  /** 0..1, how strongly the composer rim glows. */
  readonly composerFocus: number;
  /** Ripple phase in seconds and its remaining energy after a layout change. */
  readonly settle: { readonly phase: number; readonly energy: number };
  readonly pulse: {
    readonly x: number;
    readonly y: number;
    readonly progress: number;
    readonly strength: number;
  };
  /** sRGB panel interior, matched to the CSS canvas colour. */
  readonly base: readonly [number, number, number];
}

export interface ChromeRenderer {
  readonly render: (frame: ChromeFrame) => void;
  readonly dispose: () => void;
}

// The plate is decoded once and shared, so a restored context or a remount
// uploads it again without another fetch.
let plateImage: Promise<HTMLImageElement> | null = null;

function loadPlate(): Promise<HTMLImageElement> {
  if (!plateImage) {
    const image = new Image();
    image.src = plateUrl;
    plateImage = image.decode().then(
      () => image,
      (error: unknown) => {
        plateImage = null;
        throw error;
      },
    );
  }
  return plateImage;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Chrome shader failed to compile.", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Draws nothing until the plate has loaded, then calls onReady so the caller
 * can schedule a frame.
 */
export function createChromeRenderer(
  canvas: HTMLCanvasElement,
  onReady: () => void,
): ChromeRenderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;

  const vertex = compile(gl, gl.VERTEX_SHADER, CHROME_VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, CHROME_FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Chrome shader failed to link.", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  // The fullscreen triangle is generated from gl_VertexID, but WebGL2 still
  // wants a vertex array bound to draw.
  const vertexArray = gl.createVertexArray();
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const locations = {
    viewport: uniform("uViewport"),
    pixelRatio: uniform("uPixelRatio"),
    surfaceRect: uniform("uSurfaceRect"),
    surfaceRadii: uniform("uSurfaceRadii"),
    surfaceKind: uniform("uSurfaceKind"),
    surfaceCount: uniform("uSurfaceCount"),
    time: uniform("uTime"),
    composer: uniform("uComposer"),
    composerShape: uniform("uComposerShape"),
    settle: uniform("uSettle"),
    pulse: uniform("uPulse"),
    base: uniform("uBase"),
    plate: uniform("uPlate"),
    panelBox: uniform("uPanelBox"),
  };

  let disposed = false;
  let plateTexture: WebGLTexture | null = null;
  void loadPlate().then(
    (image) => {
      if (disposed || gl.isContextLost()) return;
      plateTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, plateTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
      onReady();
    },
    (error: unknown) => console.error(error),
  );
  const rects = new Float32Array(CHROME_MAX_SURFACES * 4);
  const radii = new Float32Array(CHROME_MAX_SURFACES * 4);
  const kinds = new Float32Array(CHROME_MAX_SURFACES);

  return {
    render(frame) {
      if (!plateTexture) return;
      const deviceWidth = Math.max(1, Math.round(frame.width * frame.pixelRatio));
      const deviceHeight = Math.max(1, Math.round(frame.height * frame.pixelRatio));
      if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
        canvas.width = deviceWidth;
        canvas.height = deviceHeight;
      }

      const count = Math.min(frame.surfaces.length, CHROME_MAX_SURFACES);
      for (let index = 0; index < count; index++) {
        const surface = frame.surfaces[index]!;
        rects.set([surface.x, surface.y, surface.width, surface.height], index * 4);
        radii.set(surface.radii, index * 4);
        kinds[index] = CHROME_SURFACE_KIND_INDEX[surface.kind];
      }

      gl.viewport(0, 0, deviceWidth, deviceHeight);
      gl.useProgram(program);
      gl.bindVertexArray(vertexArray);
      gl.uniform2f(locations.viewport, frame.width, frame.height);
      gl.uniform1f(locations.pixelRatio, frame.pixelRatio);
      gl.uniform4fv(locations.surfaceRect, rects);
      gl.uniform4fv(locations.surfaceRadii, radii);
      gl.uniform1fv(locations.surfaceKind, kinds);
      gl.uniform1i(locations.surfaceCount, count);
      const composer = frame.surfaces.find((surface) => surface.kind === "composer");
      gl.uniform1f(locations.time, frame.time);
      gl.uniform4f(
        locations.composer,
        composer?.x ?? 0,
        composer?.y ?? 0,
        composer?.width ?? 0,
        composer?.height ?? 0,
      );
      gl.uniform2f(locations.composerShape, composer?.radii[0] ?? 0, frame.composerFocus);
      gl.uniform2f(locations.settle, frame.settle.phase, frame.settle.energy);
      gl.uniform4f(
        locations.pulse,
        frame.pulse.x,
        frame.pulse.y,
        frame.pulse.progress,
        frame.pulse.strength,
      );
      gl.uniform3f(locations.base, ...frame.base);
      let panelBox: [number, number, number, number] | null = null;
      for (const surface of frame.surfaces) {
        if (surface.kind !== "panel") continue;
        const right = surface.x + surface.width;
        const bottom = surface.y + surface.height;
        panelBox = panelBox
          ? [
              Math.min(panelBox[0], surface.x),
              Math.min(panelBox[1], surface.y),
              Math.max(panelBox[2], right),
              Math.max(panelBox[3], bottom),
            ]
          : [surface.x, surface.y, right, bottom];
      }
      gl.uniform4f(locations.panelBox, ...(panelBox ?? [0, 0, frame.width, frame.height]));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, plateTexture);
      gl.uniform1i(locations.plate, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      disposed = true;
      gl.deleteTexture(plateTexture);
      gl.deleteVertexArray(vertexArray);
      gl.deleteProgram(program);
    },
  };
}
