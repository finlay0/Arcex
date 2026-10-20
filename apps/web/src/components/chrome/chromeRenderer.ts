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
  readonly radius: number;
}

export interface ChromeFrame {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly surfaces: ReadonlyArray<ChromeSurfaceRect>;
  readonly pointer: { readonly x: number; readonly y: number; readonly strength: number };
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

export function createChromeRenderer(canvas: HTMLCanvasElement): ChromeRenderer | null {
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
    surfaceShape: uniform("uSurfaceShape"),
    surfaceCount: uniform("uSurfaceCount"),
    pointer: uniform("uPointer"),
    pulse: uniform("uPulse"),
    base: uniform("uBase"),
  };
  const rects = new Float32Array(CHROME_MAX_SURFACES * 4);
  const shapes = new Float32Array(CHROME_MAX_SURFACES * 2);

  return {
    render(frame) {
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
        shapes.set([surface.radius, CHROME_SURFACE_KIND_INDEX[surface.kind]], index * 2);
      }

      gl.viewport(0, 0, deviceWidth, deviceHeight);
      gl.useProgram(program);
      gl.bindVertexArray(vertexArray);
      gl.uniform2f(locations.viewport, frame.width, frame.height);
      gl.uniform1f(locations.pixelRatio, frame.pixelRatio);
      gl.uniform4fv(locations.surfaceRect, rects);
      gl.uniform2fv(locations.surfaceShape, shapes);
      gl.uniform1i(locations.surfaceCount, count);
      gl.uniform3f(locations.pointer, frame.pointer.x, frame.pointer.y, frame.pointer.strength);
      gl.uniform4f(
        locations.pulse,
        frame.pulse.x,
        frame.pulse.y,
        frame.pulse.progress,
        frame.pulse.strength,
      );
      gl.uniform3f(locations.base, ...frame.base);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteVertexArray(vertexArray);
      gl.deleteProgram(program);
    },
  };
}
