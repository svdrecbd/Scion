"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { fetchVolumeEngine } from "./volume-client";

type CachedSlice = {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  dtype: string;
  byteLength: number;
  loadedAt: number;
};

export type VoxelPoint = {
  x: number;
  y: number;
  z: number;
};

export type MeasurementOverlay = {
  id: string;
  label: string;
  note?: string;
  axis: "z" | "y" | "x";
  slice: number;
  start: VoxelPoint;
  end: VoxelPoint;
  distanceUm: number;
};

export type RoiOverlay = {
  id: string;
  label: string;
  kind: "point" | "box";
  category: string;
  axis: "z" | "y" | "x";
  slice: number;
  start: VoxelPoint;
  end?: VoxelPoint;
  color?: string;
};

type VolumetricViewerProps = {
  dataset: string;
  asset: string;
  zMax: number;
  yMax: number;
  xMax: number;
  physicalVoxelSizeNm: {
    z?: number | string;
    y?: number | string;
    x?: number | string;
  };
  axis: "z" | "y" | "x";
  slice: number;
  minContrast: number;
  maxContrast: number;
  logScale: boolean;
  colormap: number; // 0 = grayscale, 1 = heat, 2 = viridis
  viewMode: "2d" | "3d";
  downsample: number;
  alphaScale: number;
  pitch: number;
  yaw: number;
  onRotationChange?: (pitch: number, yaw: number) => void;
  onLoadedMetadata?: (info: { width: number; height: number; dtype: string; maxPossible: number }) => void;
  onProbeChange?: (probe: { px: number; py: number; pz: number; xUm: number; yUm: number; zUm: number; val: number } | null) => void;
  onSliceLoaded?: (data: Uint8Array | Uint16Array) => void;
  onPlanePointSelect?: (point: { x: number; y: number; z: number }) => void;
  onMeasurementPoint?: (point: VoxelPoint, context: { axis: "z" | "y" | "x"; slice: number }) => void;
  onLoadingChange?: (loading: boolean) => void;
  crosshair?: { x: number; y: number; z: number };
  measurementMode?: boolean;
  measurements?: MeasurementOverlay[];
  measurementDraftPoint?: VoxelPoint | null;
  roiTool?: "off" | "point" | "box";
  rois?: RoiOverlay[];
  roiDraftPoint?: VoxelPoint | null;
  onRoiPoint?: (point: VoxelPoint, context: { axis: "z" | "y" | "x"; slice: number }) => void;
  title?: string;
  variant?: "stage" | "tile";
};

const SLICE_CACHE_MAX_BYTES = 160 * 1024 * 1024;
const SLICE_CACHE_MAX_ENTRIES = 48;
const sliceCache = new Map<string, CachedSlice>();
let sliceCacheBytes = 0;

const getSliceCacheKey = (dataset: string, asset: string, axis: "z" | "y" | "x", slice: number) =>
  `${dataset}::${asset}::${axis}::${slice}`;

const getSliceUrl = (dataset: string, asset: string, axis: "z" | "y" | "x", slice: number) =>
  `http://127.0.0.1:8080/api/volume/slice?dataset=${encodeURIComponent(
    dataset
  )}&asset=${encodeURIComponent(asset)}&axis=${axis}&slice=${slice}`;

const formatMeasurementDistance = (distanceUm: number) => {
  if (!Number.isFinite(distanceUm)) return "";
  if (distanceUm < 1) return `${(distanceUm * 1000).toFixed(1)} nm`;
  if (distanceUm < 100) return `${distanceUm.toFixed(3)} µm`;
  return `${distanceUm.toFixed(1)} µm`;
};

const clampVoxelIndex = (value: number, size: number) =>
  Math.max(0, Math.min(Math.round(value), Math.max(0, size - 1)));

const touchCachedSlice = (key: string, entry: CachedSlice) => {
  sliceCache.delete(key);
  sliceCache.set(key, { ...entry, loadedAt: Date.now() });
};

const pruneSliceCache = () => {
  while (sliceCache.size > SLICE_CACHE_MAX_ENTRIES || sliceCacheBytes > SLICE_CACHE_MAX_BYTES) {
    const oldestKey = sliceCache.keys().next().value as string | undefined;
    if (!oldestKey) return;
    const oldest = sliceCache.get(oldestKey);
    if (oldest) {
      sliceCacheBytes -= oldest.byteLength;
    }
    sliceCache.delete(oldestKey);
  }
};

const putCachedSlice = (key: string, entry: CachedSlice) => {
  const existing = sliceCache.get(key);
  if (existing) {
    sliceCacheBytes -= existing.byteLength;
  }
  sliceCache.set(key, entry);
  sliceCacheBytes += entry.byteLength;
  pruneSliceCache();
};

const fetchSlicePayload = async (
  dataset: string,
  asset: string,
  axis: "z" | "y" | "x",
  slice: number,
  signal?: AbortSignal
) => {
  const key = getSliceCacheKey(dataset, asset, axis, slice);
  const cached = sliceCache.get(key);
  if (cached) {
    touchCachedSlice(key, cached);
    return { ...cached, fromCache: true };
  }

  const res = await fetchVolumeEngine(getSliceUrl(dataset, asset, axis, slice), { signal });
  if (!res.ok) {
    throw new Error(`Volumetric sidecar returned status: ${res.status}`);
  }

  const buffer = await res.arrayBuffer();
  const entry: CachedSlice = {
    buffer,
    width: Number(res.headers.get("x-width") || 0),
    height: Number(res.headers.get("x-height") || 0),
    dtype: res.headers.get("x-dtype") || "uint8",
    byteLength: buffer.byteLength,
    loadedAt: Date.now(),
  };
  putCachedSlice(key, entry);
  return { ...entry, fromCache: false };
};

// Simple full-screen quad vertex shader
const VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
}`;

// Fragment shader that performs slice rendering in 2D
const FRAGMENT_SHADER_2D_SOURCE = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp usampler2D;

in vec2 v_texCoord;
out vec4 outColor;

uniform sampler2D u_texture;
uniform usampler2D u_texture_u16;
uniform int u_isUint16;

uniform float u_minThreshold;
uniform float u_maxThreshold;
uniform int u_logScale;
uniform int u_colormap;

void main() {
    float rawVal = 0.0;
    if (u_isUint16 == 1) {
        rawVal = float(texture(u_texture_u16, v_texCoord).r);
    } else {
        rawVal = texture(u_texture, v_texCoord).r * 255.0;
    }

    if (u_logScale == 1) {
        rawVal = log(rawVal + 1.0);
    }

    float normalized = 0.0;
    if (u_maxThreshold > u_minThreshold) {
        normalized = (rawVal - u_minThreshold) / (u_maxThreshold - u_minThreshold);
    }
    normalized = clamp(normalized, 0.0, 1.0);

    if (u_colormap == 1) {
        // Heat colormap (black -> red -> yellow -> white)
        vec3 color = vec3(0.0);
        if (normalized < 0.33) {
            color.r = normalized / 0.33;
        } else if (normalized < 0.66) {
            color.r = 1.0;
            color.g = (normalized - 0.33) / 0.33;
        } else {
            color.r = 1.0;
            color.g = 1.0;
            color.b = (normalized - 0.66) / 0.34;
        }
        outColor = vec4(color, 1.0);
    } else if (u_colormap == 2) {
        // Viridis approximation colormap
        vec3 color = vec3(0.0);
        color.r = clamp(3.0 * normalized - 1.5, 0.0, 1.0);
        color.g = clamp(2.0 * normalized, 0.0, 0.9);
        color.b = clamp(1.0 - 1.5 * normalized, 0.0, 0.8) + clamp(1.5 * normalized - 0.5, 0.0, 0.5);
        outColor = vec4(color, 1.0);
    } else {
        // Grayscale
        outColor = vec4(vec3(normalized), 1.0);
    }
}`;

// Fragment shader that performs 3D volume raymarching
const FRAGMENT_SHADER_3D_SOURCE = `#version 300 es
precision highp float;
precision highp sampler3D;
precision highp usampler3D;

in vec2 v_texCoord;
out vec4 outColor;

uniform sampler3D u_texture3d;
uniform usampler3D u_texture3d_u16;
uniform int u_isUint16;

uniform float u_minThreshold;
uniform float u_maxThreshold;
uniform int u_logScale;
uniform int u_colormap;
uniform float u_alphaScale;

uniform vec3 u_boxScale;
uniform mat3 u_rotationMatrix;

// Ray-box intersection: intersects ray (ro, rd) with box scaled by u_boxScale
bool intersectBox(vec3 ro, vec3 rd, vec3 boxMin, vec3 boxMax, out float t0, out float t1) {
    vec3 invR = 1.0 / (rd + vec3(1e-6));
    vec3 tbot = invR * (boxMin - ro);
    vec3 ttop = invR * (boxMax - ro);
    
    vec3 tmin = min(tbot, ttop);
    vec3 tmax = max(tbot, ttop);
    
    float tempNear = max(max(tmin.x, tmin.y), tmin.z);
    float tempFar = min(min(tmax.x, tmax.y), tmax.z);
    
    t0 = tempNear;
    t1 = tempFar;
    
    return tempNear < tempFar && tempFar > 0.0;
}

void main() {
    // Camera ray in bounding space
    vec2 p = v_texCoord * 2.0 - 1.0;
    vec3 ro = vec3(0.0, 0.0, -1.8);
    vec3 rd = normalize(vec3(p * 0.7, 1.0)); // Narrowed focal point for perspective feel

    // Apply rotation matrix
    vec3 rotatedRo = u_rotationMatrix * ro;
    vec3 rotatedRd = u_rotationMatrix * rd;

    // Bounding limits of physical dimension scale
    vec3 boxMin = -0.5 * u_boxScale;
    vec3 boxMax = 0.5 * u_boxScale;

    float t_near = 0.0;
    float t_far = 0.0;
    
    if (!intersectBox(rotatedRo, rotatedRd, boxMin, boxMax, t_near, t_far)) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    t_near = max(t_near, 0.0);

    // Dynamic steps balance performance and resolution
    const int MAX_STEPS = 128;
    float stepSize = (t_far - t_near) / float(MAX_STEPS);
    
    vec3 accumColor = vec3(0.0);
    float accumAlpha = 0.0;

    for (int i = 0; i < MAX_STEPS; i++) {
        float t = t_near + (float(i) + 0.5) * stepSize;
        vec3 pos = rotatedRo + t * rotatedRd;
        
        // Map pos inside rotated box [-0.5*scale, 0.5*scale]^3 to texture space [0.0, 1.0]^3
        vec3 texCoord = (pos / u_boxScale) + vec3(0.5);

        // Strict clamp check to prevent edge bleed
        if (texCoord.x < 0.0 || texCoord.x > 1.0 ||
            texCoord.y < 0.0 || texCoord.y > 1.0 ||
            texCoord.z < 0.0 || texCoord.z > 1.0) {
            continue;
        }

        float rawVal = 0.0;
        if (u_isUint16 == 1) {
            rawVal = float(texture(u_texture3d_u16, texCoord).r);
        } else {
            rawVal = float(texture(u_texture3d, texCoord).r) * 255.0;
        }

        if (u_logScale == 1) {
            rawVal = log(rawVal + 1.0);
        }

        float normalized = 0.0;
        if (u_maxThreshold > u_minThreshold) {
            normalized = (rawVal - u_minThreshold) / (u_maxThreshold - u_minThreshold);
        }
        normalized = clamp(normalized, 0.0, 1.0);

        if (normalized > 0.01) {
            vec3 sampleColor = vec3(0.0);
            if (u_colormap == 1) {
                // Heat
                if (normalized < 0.33) {
                    sampleColor.r = normalized / 0.33;
                } else if (normalized < 0.66) {
                    sampleColor.r = 1.0;
                    sampleColor.g = (normalized - 0.33) / 0.33;
                } else {
                    sampleColor.r = 1.0;
                    sampleColor.g = 1.0;
                    sampleColor.b = (normalized - 0.66) / 0.34;
                }
            } else if (u_colormap == 2) {
                // Viridis
                sampleColor.r = clamp(3.0 * normalized - 1.5, 0.0, 1.0);
                sampleColor.g = clamp(2.0 * normalized, 0.0, 0.9);
                sampleColor.b = clamp(1.0 - 1.5 * normalized, 0.0, 0.8) + clamp(1.5 * normalized - 0.5, 0.0, 0.5);
            } else {
                // Grayscale
                sampleColor = vec3(normalized);
            }

            // Blend voxel density
            float sampleAlpha = normalized * u_alphaScale;
            accumColor += (1.0 - accumAlpha) * sampleColor * sampleAlpha;
            accumAlpha += (1.0 - accumAlpha) * sampleAlpha;

            // Early ray termination
            if (accumAlpha >= 0.95) {
                accumAlpha = 1.0;
                break;
            }
        }
    }

    // Output composited color over black background
    outColor = vec4(accumColor, accumAlpha);
}`;

export function VolumetricViewer({
  dataset,
  asset,
  zMax,
  yMax,
  xMax,
  physicalVoxelSizeNm,
  axis,
  slice,
  minContrast,
  maxContrast,
  logScale,
  colormap,
  viewMode,
  downsample,
  alphaScale,
  pitch,
  yaw,
  onRotationChange,
  onLoadedMetadata,
  onProbeChange,
  onSliceLoaded,
  onPlanePointSelect,
  onMeasurementPoint,
  onLoadingChange,
  crosshair,
  measurementMode = false,
  measurements = [],
  measurementDraftPoint = null,
  roiTool = "off",
  rois = [],
  roiDraftPoint = null,
  onRoiPoint,
  title,
  variant = "stage",
}: VolumetricViewerProps) {
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  
  // Shaders references
  const program2DRef = useRef<WebGLProgram | null>(null);
  const program3DRef = useRef<WebGLProgram | null>(null);
  const vertexBufferRef = useRef<WebGLBuffer | null>(null);
  
  // 2D Texture references
  const textureRef = useRef<WebGLTexture | null>(null);
  const textureU16Ref = useRef<WebGLTexture | null>(null);

  // 3D Texture references
  const texture3DRef = useRef<WebGLTexture | null>(null);
  const texture3DU16Ref = useRef<WebGLTexture | null>(null);

  // Loading states
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamRetryNonce, setStreamRetryNonce] = useState(0);
  const onLoadingChangeRef = useRef(onLoadingChange);
  
  // 2D Dimensions
  const [sliceWidth, setSliceWidth] = useState(0);
  const [sliceHeight, setSliceHeight] = useState(0);
  const [dtype, setDtype] = useState("uint8");

  // 3D Dimensions
  const [volumeWidth, setVolumeWidth] = useState(0);
  const [volumeHeight, setVolumeHeight] = useState(0);
  const [volumeDepth, setVolumeDepth] = useState(0);

  // Mouse interaction state
  const isDraggingRef = useRef(false);
  const lastMousePosRef = useRef({ x: 0, y: 0 });

  // 2D pixel inspection variables
  const sliceDataRef = useRef<Uint8Array | Uint16Array | null>(null);
  const [inspectCoords, setInspectCoords] = useState<{ x: number; y: number } | null>(null);
  const [inspectVal, setInspectVal] = useState<number | null>(null);

  // Observer client size
  const [canvasDisplay, setCanvasDisplay] = useState({ width: 0, height: 0 });
  const [stageDisplay, setStageDisplay] = useState({ width: 0, height: 0 });
  const [drawRevision, setDrawRevision] = useState(0);

  useEffect(() => {
    onLoadingChangeRef.current = onLoadingChange;
  }, [onLoadingChange]);

  useEffect(() => {
    onLoadingChangeRef.current?.(loading);
    return () => onLoadingChangeRef.current?.(false);
  }, [loading]);

  // Helper compiler
  const compileShader = (gl: WebGL2RenderingContext, type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const typeStr = type === gl.VERTEX_SHADER ? "Vertex" : "Fragment";
      console.error(`${typeStr} Shader compilation error:`, log);
      setError(`WebGL ${typeStr} Shader Compilation Error: ${log}`);
      gl.deleteShader(s);
      return null;
    }
    return s;
  };

  // Compile shaders on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) {
      setError("WebGL2 is not supported or enabled in this browser.");
      return;
    }
    glRef.current = gl;

    // 1. Compile 2D shader program
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    const fs2D = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_2D_SOURCE);
    if (vs && fs2D) {
      const prog = gl.createProgram();
      if (prog) {
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs2D);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          const log = gl.getProgramInfoLog(prog);
          console.error("Link error 2D:", log);
          setError(`WebGL Program Link Error (2D): ${log}`);
        } else {
          program2DRef.current = prog;
        }
      }
    }

    // 2. Compile 3D shader program
    const fs3D = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_3D_SOURCE);
    if (vs && fs3D) {
      const prog = gl.createProgram();
      if (prog) {
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs3D);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          const log = gl.getProgramInfoLog(prog);
          console.error("Link error 3D:", log);
          setError(`WebGL Program Link Error (3D): ${log}`);
        } else {
          program3DRef.current = prog;
        }
      }
    }

    // Create quad positions and UV coordinates
    const quadVertices = new Float32Array([
      -1.0,  1.0,     0.0, 0.0, 
      -1.0, -1.0,     0.0, 1.0,
       1.0,  1.0,     1.0, 0.0,
       1.0, -1.0,     1.0, 1.0,
    ]);

    vertexBufferRef.current = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBufferRef.current);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

    // Create textures
    textureRef.current = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, textureRef.current);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));

    textureU16Ref.current = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, textureU16Ref.current);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array([0]));

    texture3DRef.current = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture3DRef.current);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));

    texture3DU16Ref.current = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture3DU16Ref.current);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R16UI, 1, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array([0]));

    // Clean shaders
    return () => {
      if (vs) gl.deleteShader(vs);
      if (fs2D) gl.deleteShader(fs2D);
      if (fs3D) gl.deleteShader(fs3D);
      if (program2DRef.current) gl.deleteProgram(program2DRef.current);
      if (program3DRef.current) gl.deleteProgram(program3DRef.current);
      if (vertexBufferRef.current) gl.deleteBuffer(vertexBufferRef.current);
      if (textureRef.current) gl.deleteTexture(textureRef.current);
      if (textureU16Ref.current) gl.deleteTexture(textureU16Ref.current);
      if (texture3DRef.current) gl.deleteTexture(texture3DRef.current);
      if (texture3DU16Ref.current) gl.deleteTexture(texture3DU16Ref.current);
    };
  }, []);

  // Fetch 2D slice
  useEffect(() => {
    if (viewMode !== "2d") return;
    let cancelled = false;
    let retryTimeout: number | null = null;
    const controller = new AbortController();
    const cacheKey = getSliceCacheKey(dataset, asset, axis, slice);
    const cached = sliceCache.get(cacheKey);

    async function fetchSlice() {
      setLoading(!cached);
      setError(null);
      setInspectCoords(null);
      setInspectVal(null);
      if (!cached) {
        sliceDataRef.current = null;
        setSliceWidth(0);
        setSliceHeight(0);
      }

      try {
        const payload = await fetchSlicePayload(dataset, asset, axis, slice, controller.signal);
        if (cancelled) return;

        const hWidth = payload.width;
        const hHeight = payload.height;
        const hDtype = payload.dtype;

        setSliceWidth(hWidth);
        setSliceHeight(hHeight);
        setDtype(hDtype);

        let typedArray: Uint8Array | Uint16Array;
        let maxPossible = 255;

        if (hDtype.includes("16") || hDtype === "uint16") {
          typedArray = new Uint16Array(payload.buffer);
          maxPossible = 65535;
        } else {
          typedArray = new Uint8Array(payload.buffer);
          maxPossible = 255;
        }
        sliceDataRef.current = typedArray;

        if (onLoadedMetadata) {
          onLoadedMetadata({ width: hWidth, height: hHeight, dtype: hDtype, maxPossible });
        }

        if (onSliceLoaded) {
          onSliceLoaded(typedArray);
        }

        const gl = glRef.current;
        if (gl) {
          if (hDtype.includes("16") || hDtype === "uint16") {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, textureU16Ref.current);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.R16UI,
              hWidth,
              hHeight,
              0,
              gl.RED_INTEGER,
              gl.UNSIGNED_SHORT,
              typedArray
            );
          } else {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, textureRef.current);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.R8,
              hWidth,
              hHeight,
              0,
              gl.RED,
              gl.UNSIGNED_BYTE,
              typedArray
            );
          }
        }
        setDrawRevision((prev) => prev + 1);
        const axisMax = axis === "z" ? zMax : axis === "y" ? yMax : xMax;
        for (const nextSlice of [slice - 1, slice + 1]) {
          if (nextSlice < 0 || nextSlice >= axisMax) continue;
          const nextKey = getSliceCacheKey(dataset, asset, axis, nextSlice);
          if (sliceCache.has(nextKey)) continue;
          void fetchSlicePayload(dataset, asset, axis, nextSlice).catch(() => {
            // Prefetch is opportunistic and should never surface as viewer error.
          });
        }
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return;
        }
        if (!cancelled) {
          setError(err.message || "Failed to load voxel slice from the sidecar.");
          retryTimeout = window.setTimeout(() => {
            if (!cancelled) {
              setStreamRetryNonce((value) => value + 1);
            }
          }, 1500);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchSlice();

    return () => {
      cancelled = true;
      if (retryTimeout !== null) {
        window.clearTimeout(retryTimeout);
      }
      controller.abort();
    };
  }, [dataset, asset, axis, slice, viewMode, zMax, yMax, xMax, streamRetryNonce]);

  // Fetch 3D Downsampled Volume
  useEffect(() => {
    if (viewMode !== "3d") return;
    let cancelled = false;
    let retryTimeout: number | null = null;
    const controller = new AbortController();

    async function fetch3DVolume() {
      setLoading(true);
      setError(null);

      try {
        const url = `http://127.0.0.1:8080/api/volume/3d?dataset=${encodeURIComponent(
          dataset
        )}&asset=${encodeURIComponent(asset)}&downsample=${downsample}`;

        const res = await fetchVolumeEngine(url, { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`Volumetric sidecar returned status: ${res.status}`);
        }

        const buffer = await res.arrayBuffer();
        if (cancelled) return;

        const hWidth = Number(res.headers.get("x-width") || 0);
        const hHeight = Number(res.headers.get("x-height") || 0);
        const hDepth = Number(res.headers.get("x-depth") || 0);
        const hDtype = res.headers.get("x-dtype") || "uint8";

        setVolumeWidth(hWidth);
        setVolumeHeight(hHeight);
        setVolumeDepth(hDepth);
        setDtype(hDtype);

        let maxPossible = 255;
        const gl = glRef.current;
        if (gl) {
          if (hDtype.includes("16") || hDtype === "uint16") {
            const typedArray = new Uint16Array(buffer);
            maxPossible = 65535;
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_3D, texture3DU16Ref.current);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
            gl.texImage3D(
              gl.TEXTURE_3D,
              0,
              gl.R16UI,
              hWidth,
              hHeight,
              hDepth,
              0,
              gl.RED_INTEGER,
              gl.UNSIGNED_SHORT,
              typedArray
            );
          } else {
            const typedArray = new Uint8Array(buffer);
            maxPossible = 255;
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_3D, texture3DRef.current);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage3D(
              gl.TEXTURE_3D,
              0,
              gl.R8,
              hWidth,
              hHeight,
              hDepth,
              0,
              gl.RED,
              gl.UNSIGNED_BYTE,
              typedArray
            );
          }
        }

        if (onLoadedMetadata) {
          onLoadedMetadata({ width: hWidth, height: hHeight, dtype: hDtype, maxPossible });
        }

        if (onSliceLoaded) {
          if (hDtype.includes("16") || hDtype === "uint16") {
            onSliceLoaded(new Uint16Array(buffer));
          } else {
            onSliceLoaded(new Uint8Array(buffer));
          }
        }
        setDrawRevision((prev) => prev + 1);
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return;
        }
        if (!cancelled) {
          setError(err.message || "Failed to stream 3D volume buffer.");
          retryTimeout = window.setTimeout(() => {
            if (!cancelled) {
              setStreamRetryNonce((value) => value + 1);
            }
          }, 1500);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetch3DVolume();

    return () => {
      cancelled = true;
      if (retryTimeout !== null) {
        window.clearTimeout(retryTimeout);
      }
      controller.abort();
    };
  }, [dataset, asset, downsample, viewMode, streamRetryNonce]);

  // Compute rotation matrix for col-major uniform transmission
  const rotationMatrix = useMemo(() => {
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);

    // Column-major order:
    return new Float32Array([
      cosY, 0, -sinY,
      sinY * sinP, cosP, cosY * sinP,
      sinY * cosP, -sinP, cosY * cosP
    ]);
  }, [pitch, yaw]);

  // Voxel size bounding scales for corrected aspect ratio in 3D
  const boxScale = useMemo(() => {
    const vx = Number(physicalVoxelSizeNm.x || 1.0);
    const vy = Number(physicalVoxelSizeNm.y || 1.0);
    const vz = Number(physicalVoxelSizeNm.z || 1.0);

    const sizeX = xMax * vx;
    const sizeY = yMax * vy;
    const sizeZ = zMax * vz;

    const maxDim = Math.max(sizeX, sizeY, sizeZ);
    return [sizeX / maxDim, sizeY / maxDim, sizeZ / maxDim];
  }, [physicalVoxelSizeNm, xMax, yMax, zMax]);

  // Draw viewport loop
  useEffect(() => {
    const gl = glRef.current;
    const canvas = canvasRef.current;
    if (!gl || !canvas) return;

    // Resize canvas backbuffer to match display container bounds before drawing
    const w = canvasDisplay.width || canvas.clientWidth || 512;
    const h = canvasDisplay.height || canvas.clientHeight || 512;
    const targetWidth = Math.floor(w * window.devicePixelRatio);
    const targetHeight = Math.floor(h * window.devicePixelRatio);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);

    if (viewMode === "2d") {
      const program = program2DRef.current;
      if (!program || sliceWidth === 0 || sliceHeight === 0) return;

      gl.useProgram(program);

      // Re-setup quad positions attributes
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBufferRef.current);
      const aPos = gl.getAttribLocation(program, "a_position");
      const aTex = gl.getAttribLocation(program, "a_texCoord");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(aTex);
      gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

      const isU16 = dtype.includes("16") || dtype === "uint16";
      gl.uniform1i(gl.getUniformLocation(program, "u_isUint16"), isU16 ? 1 : 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textureRef.current);
      gl.uniform1i(gl.getUniformLocation(program, "u_texture"), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, textureU16Ref.current);
      gl.uniform1i(gl.getUniformLocation(program, "u_texture_u16"), 1);

      gl.uniform1f(gl.getUniformLocation(program, "u_minThreshold"), minContrast);
      gl.uniform1f(gl.getUniformLocation(program, "u_maxThreshold"), maxContrast);
      gl.uniform1i(gl.getUniformLocation(program, "u_logScale"), logScale ? 1 : 0);
      gl.uniform1i(gl.getUniformLocation(program, "u_colormap"), colormap);

      gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    } else {
      const program = program3DRef.current;
      if (!program || volumeWidth === 0) return;

      gl.useProgram(program);

      // Re-setup quad positions attributes
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBufferRef.current);
      const aPos = gl.getAttribLocation(program, "a_position");
      const aTex = gl.getAttribLocation(program, "a_texCoord");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(aTex);
      gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

      const isU16 = dtype.includes("16") || dtype === "uint16";
      gl.uniform1i(gl.getUniformLocation(program, "u_isUint16"), isU16 ? 1 : 0);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, texture3DRef.current);
      gl.uniform1i(gl.getUniformLocation(program, "u_texture3d"), 2);

      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_3D, texture3DU16Ref.current);
      gl.uniform1i(gl.getUniformLocation(program, "u_texture3d_u16"), 3);

      gl.uniform1f(gl.getUniformLocation(program, "u_minThreshold"), minContrast);
      gl.uniform1f(gl.getUniformLocation(program, "u_maxThreshold"), maxContrast);
      gl.uniform1i(gl.getUniformLocation(program, "u_logScale"), logScale ? 1 : 0);
      gl.uniform1i(gl.getUniformLocation(program, "u_colormap"), colormap);
      gl.uniform1f(gl.getUniformLocation(program, "u_alphaScale"), alphaScale);

      // Set aspect ratio box scaling bounds
      gl.uniform3f(gl.getUniformLocation(program, "u_boxScale"), boxScale[0], boxScale[1], boxScale[2]);

      // Set 3D rotation matrix
      gl.uniformMatrix3fv(gl.getUniformLocation(program, "u_rotationMatrix"), false, rotationMatrix);

      gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      console.error("WebGL Draw Error Code:", err);
    }
  }, [
    viewMode,
    sliceWidth,
    sliceHeight,
    volumeWidth,
    dtype,
    minContrast,
    maxContrast,
    logScale,
    colormap,
    alphaScale,
    rotationMatrix,
    boxScale,
    canvasDisplay,
    dataset,
    asset,
    axis,
    slice,
    downsample,
    drawRevision,
  ]);

  useEffect(() => {
    const element = stageWrapRef.current;
    if (!element) return;

    const updateSize = () => {
      setStageDisplay({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setStageDisplay({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(element);
    updateSize();

    return () => {
      observer.disconnect();
    };
  }, []);

  // Size listener to update observed display size
  useEffect(() => {
    const element = surfaceRef.current || canvasRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === element) {
          const w = entry.contentRect.width || element.clientWidth;
          const h = entry.contentRect.height || element.clientHeight;
          setCanvasDisplay({ width: w, height: h });
        }
      }
    });

    observer.observe(element);
    setCanvasDisplay({ width: element.clientWidth, height: element.clientHeight });

    return () => {
      observer.disconnect();
    };
  }, []);

  const resolveSlicePoint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const data = sliceDataRef.current;
    if (!canvas || !data || sliceWidth === 0 || sliceHeight === 0) return null;

    const rect = surfaceRef.current?.getBoundingClientRect() || canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;

    if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) return null;

    const px = Math.min(sliceWidth - 1, Math.floor(xRatio * sliceWidth));
    const py = Math.min(sliceHeight - 1, Math.floor(yRatio * sliceHeight));

    const idx = py * sliceWidth + px;
    if (idx >= data.length) return null;

    let xVal = 0;
    let yVal = 0;
    let zVal = 0;

    if (axis === "z") {
      xVal = px;
      yVal = py;
      zVal = slice;
    } else if (axis === "y") {
      xVal = px;
      zVal = py;
      yVal = slice;
    } else {
      yVal = px;
      zVal = py;
      xVal = slice;
    }

    return {
      px,
      py,
      val: data[idx],
      point: { x: xVal, y: yVal, z: zVal },
    };
  };

  // Pixel inspection mouse coordinates handler
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (viewMode === "3d") {
      if (!isDraggingRef.current || !onRotationChange) return;
      const dx = e.clientX - lastMousePosRef.current.x;
      const dy = e.clientY - lastMousePosRef.current.y;
      
      const newYaw = yaw + dx * 0.007;
      // Clamp pitch to avoid flipping view upside down
      const newPitch = Math.max(-1.4, Math.min(1.4, pitch - dy * 0.007));
      
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
      onRotationChange(newPitch, newYaw);
      return;
    }

    const resolved = resolveSlicePoint(e);
    if (!resolved) return;

    setInspectCoords({ x: resolved.px, y: resolved.py });
    setInspectVal(resolved.val);

    if (onProbeChange) {
      const vx = Number(physicalVoxelSizeNm.x || 1.0);
      const vy = Number(physicalVoxelSizeNm.y || 1.0);
      const vz = Number(physicalVoxelSizeNm.z || 1.0);
      const xUm = (resolved.point.x * vx) / 1000.0;
      const yUm = (resolved.point.y * vy) / 1000.0;
      const zUm = (resolved.point.z * vz) / 1000.0;

      onProbeChange({
        px: resolved.point.x,
        py: resolved.point.y,
        pz: resolved.point.z,
        xUm,
        yUm,
        zUm,
        val: resolved.val,
      });
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (viewMode === "3d") {
      isDraggingRef.current = true;
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (viewMode !== "2d") return;
    const resolved = resolveSlicePoint(e);
    if (!resolved) return;

    if (measurementMode && onMeasurementPoint) {
      onMeasurementPoint(resolved.point, { axis, slice });
      return;
    }

    if (roiTool !== "off" && onRoiPoint) {
      onRoiPoint(resolved.point, { axis, slice });
      return;
    }

    if (onPlanePointSelect) {
      onPlanePointSelect(resolved.point);
    }
  };

  const handleMouseLeave = () => {
    isDraggingRef.current = false;
    setInspectCoords(null);
    setInspectVal(null);
    if (onProbeChange) {
      onProbeChange(null);
    }
  };

  // Compute exact physical aspect ratio mapping voxels to scale space (2D)
  const aspect2D = useMemo(() => {
    if (!sliceWidth || !sliceHeight) return 1.0;
    const vx = Number(physicalVoxelSizeNm.x || 1.0);
    const vy = Number(physicalVoxelSizeNm.y || 1.0);
    const vz = Number(physicalVoxelSizeNm.z || 1.0);

    const horizontalVoxelNm = axis === "x" ? vy : vx;
    const verticalVoxelNm = axis === "z" ? vy : vz;
    const widthNm = sliceWidth * horizontalVoxelNm;
    const heightNm = sliceHeight * verticalVoxelNm;

    return widthNm > 0 && heightNm > 0 ? widthNm / heightNm : 1.0;
  }, [physicalVoxelSizeNm, axis, sliceWidth, sliceHeight]);

  const fittedCanvasSize = useMemo(() => {
    if (viewMode !== "2d") {
      return { width: "100%", height: "100%" };
    }

    const boundsWidth = stageDisplay.width;
    const boundsHeight = stageDisplay.height;
    const aspect = Number.isFinite(aspect2D) && aspect2D > 0 ? aspect2D : 1;
    if (boundsWidth <= 0 || boundsHeight <= 0) {
      return { width: "100%", height: "100%" };
    }

    let width = boundsWidth;
    let height = width / aspect;
    if (height > boundsHeight) {
      height = boundsHeight;
      width = height * aspect;
    }

    return {
      width: `${Math.max(1, Math.floor(width))}px`,
      height: `${Math.max(1, Math.floor(height))}px`,
    };
  }, [viewMode, stageDisplay.width, stageDisplay.height, aspect2D]);

  // Compute scale bar details based on actual voxel metadata, displayed width, and physical scale steps
  const scaleBar = useMemo(() => {
    if (viewMode === "3d") return null;

    let scaleNm = 1.0;
    if (axis === "z") {
      scaleNm = Number(physicalVoxelSizeNm.x || 1.0);
    } else if (axis === "y") {
      scaleNm = Number(physicalVoxelSizeNm.x || 1.0);
    } else {
      scaleNm = Number(physicalVoxelSizeNm.y || 1.0);
    }

    if (canvasDisplay.width === 0 || sliceWidth === 0) {
      return { widthCss: 80, label: "Scale" };
    }

    const targetNm = 100 * (sliceWidth / canvasDisplay.width) * scaleNm;

    const allowedSteps = [
      1, 2, 5, 10, 20, 50, 100, 200, 500, 
      1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000
    ];

    let chosenNm = allowedSteps[0];
    let minDiff = Math.abs(Math.log(targetNm / chosenNm));
    for (const step of allowedSteps) {
      const diff = Math.abs(Math.log(targetNm / step));
      if (diff < minDiff) {
        minDiff = diff;
        chosenNm = step;
      }
    }

    const widthCss = (chosenNm / scaleNm) * (canvasDisplay.width / sliceWidth);

    let label = `${chosenNm} nm`;
    if (chosenNm >= 1000) {
      label = `${(chosenNm / 1000).toFixed(chosenNm % 1000 === 0 ? 0 : 1)} µm`;
    }

    return { widthCss, label };
  }, [physicalVoxelSizeNm, axis, sliceWidth, canvasDisplay.width, viewMode]);

  const planeDimensions = useMemo(() => {
    const fallback =
      axis === "z"
        ? { width: xMax, height: yMax }
        : axis === "y"
        ? { width: xMax, height: zMax }
        : { width: yMax, height: zMax };
    return {
      width: sliceWidth || fallback.width,
      height: sliceHeight || fallback.height,
    };
  }, [axis, xMax, yMax, zMax, sliceWidth, sliceHeight]);

  const pointPlaneIndices = (point: VoxelPoint) => {
    if (axis === "z") {
      return { x: point.x, y: point.y };
    }
    if (axis === "y") {
      return { x: point.x, y: point.z };
    }
    return { x: point.y, y: point.z };
  };

  const projectPointToPlane = (point: VoxelPoint) => {
    const indices = pointPlaneIndices(point);
    const width = Math.max(1, planeDimensions.width);
    const height = Math.max(1, planeDimensions.height);
    const displayWidth = Math.max(1, canvasDisplay.width);
    const displayHeight = Math.max(1, canvasDisplay.height);
    const x = clampVoxelIndex(indices.x, width);
    const y = clampVoxelIndex(indices.y, height);
    return {
      x: ((x + 0.5) / width) * displayWidth,
      y: ((y + 0.5) / height) * displayHeight,
    };
  };

  const overlayWidth = Math.max(1, canvasDisplay.width);
  const overlayHeight = Math.max(1, canvasDisplay.height);

  const crosshairPosition = useMemo(() => {
    if (!crosshair || viewMode !== "2d") return null;
    return projectPointToPlane(crosshair);
  }, [crosshair, viewMode, axis, planeDimensions.width, planeDimensions.height, canvasDisplay.width, canvasDisplay.height]);

  const visibleMeasurements = useMemo(() => {
    if (viewMode !== "2d") return [];
    return measurements
      .filter((measurement) => measurement.axis === axis && measurement.slice === slice)
      .map((measurement) => ({
        ...measurement,
        startPlane: projectPointToPlane(measurement.start),
        endPlane: projectPointToPlane(measurement.end),
      }));
  }, [measurements, viewMode, axis, slice, planeDimensions.width, planeDimensions.height, canvasDisplay.width, canvasDisplay.height]);

  const visibleRois = useMemo(() => {
    if (viewMode !== "2d") return [];
    return rois
      .filter((roi) => roi.axis === axis && roi.slice === slice)
      .map((roi) => ({
        ...roi,
        startPlane: projectPointToPlane(roi.start),
        endPlane: roi.end ? projectPointToPlane(roi.end) : null,
      }));
  }, [rois, viewMode, axis, slice, planeDimensions.width, planeDimensions.height, canvasDisplay.width, canvasDisplay.height]);

  const draftPlanePoint = useMemo(() => {
    if (!measurementDraftPoint || viewMode !== "2d") return null;
    const onPlane =
      (axis === "z" && measurementDraftPoint.z === slice) ||
      (axis === "y" && measurementDraftPoint.y === slice) ||
      (axis === "x" && measurementDraftPoint.x === slice);
    return onPlane ? projectPointToPlane(measurementDraftPoint) : null;
  }, [measurementDraftPoint, viewMode, axis, slice, planeDimensions.width, planeDimensions.height, canvasDisplay.width, canvasDisplay.height]);

  const roiDraftPlanePoint = useMemo(() => {
    if (!roiDraftPoint || viewMode !== "2d") return null;
    const onPlane =
      (axis === "z" && roiDraftPoint.z === slice) ||
      (axis === "y" && roiDraftPoint.y === slice) ||
      (axis === "x" && roiDraftPoint.x === slice);
    return onPlane ? projectPointToPlane(roiDraftPoint) : null;
  }, [roiDraftPoint, viewMode, axis, slice, planeDimensions.width, planeDimensions.height, canvasDisplay.width, canvasDisplay.height]);

  const planeReadoutLabels = useMemo(() => {
    if (axis === "z") return { horizontal: "X", vertical: "Y" };
    if (axis === "y") return { horizontal: "X", vertical: "Z" };
    return { horizontal: "Y", vertical: "Z" };
  }, [axis]);

  const interactionCursor =
    viewMode === "3d"
      ? "grab"
      : measurementMode
      ? "cell"
      : roiTool !== "off"
      ? "copy"
      : "crosshair";

  return (
    <div
      className="workbench-stage panel"
      style={{
        background: "#050505",
        border: variant === "tile" ? "1px solid rgba(251, 248, 239, 0.16)" : "none",
        position: "relative",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        padding: 0,
      }}
    >
      {loading ? (
        <div className="stage-load-serial">
          <span>STREAM</span>
        </div>
      ) : null}

      {error ? (
        <div className="stage-overlay error" style={{ position: "absolute", inset: 0, zIndex: 10, background: "rgba(0,0,0,0.9)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
          <strong style={{ color: "var(--atlas-orange)" }}>Volume Stream Error</strong>
          <p className="muted" style={{ margin: "8px 0", fontSize: 13 }}>{error}</p>
          <div style={{ fontSize: 11, fontStyle: "italic", opacity: 0.7 }}>
            Is the Rust sidecar running at <code>http://127.0.0.1:8080</code>?
          </div>
        </div>
      ) : null}

      <div ref={stageWrapRef} className="stage-canvas-wrap" style={{ position: "relative", width: "100%", flex: 1, display: "flex", justifyContent: "center", alignItems: "center", minHeight: 0 }}>
        {/* Render centered relative container with corrected aspect ratios */}
        <div
          ref={surfaceRef}
          style={{
            position: "relative",
            maxWidth: "100%",
            maxHeight: "100%",
            width: fittedCanvasSize.width,
            height: fittedCanvasSize.height,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
            style={{
              width: "100%",
              height: "100%",
              cursor: interactionCursor,
              imageRendering: "pixelated",
            }}
          />

          {title ? (
            <div
              className="viewer-overlay-label"
              style={{
                position: "absolute",
                top: 10,
                left: 10,
                background: "rgba(0,0,0,0.68)",
                border: "1px solid rgba(251, 248, 239, 0.2)",
                color: "#fbf8ef",
                fontFamily: "var(--font-display)",
                fontSize: variant === "tile" ? 10 : 11,
                fontWeight: 600,
                letterSpacing: 0,
                padding: "4px 7px",
                pointerEvents: "none",
                textTransform: "uppercase",
              }}
            >
              {title}
            </div>
          ) : null}

          {crosshairPosition && !error && !loading ? (
            <div className="viewer-crosshair-overlay" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              <div
                className="viewer-crosshair-line"
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: crosshairPosition.x,
                  width: 1,
                  background: "rgba(198, 111, 45, 0.86)",
                  boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
                }}
              />
              <div
                className="viewer-crosshair-line"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: crosshairPosition.y,
                  height: 1,
                  background: "rgba(198, 111, 45, 0.86)",
                  boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
                }}
              />
            </div>
          ) : null}

          {(visibleMeasurements.length > 0 || draftPlanePoint || visibleRois.length > 0 || roiDraftPlanePoint) && !error ? (
            <svg
              className="viewer-annotation-overlay"
              viewBox={`0 0 ${overlayWidth} ${overlayHeight}`}
              preserveAspectRatio="none"
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            >
              {visibleRois.map((roi) => {
                const color = roi.color || "rgba(31, 111, 135, 0.96)";
                if (roi.kind === "box" && roi.endPlane) {
                  const x = Math.min(roi.startPlane.x, roi.endPlane.x);
                  const y = Math.min(roi.startPlane.y, roi.endPlane.y);
                  const width = Math.abs(roi.endPlane.x - roi.startPlane.x);
                  const height = Math.abs(roi.endPlane.y - roi.startPlane.y);
                  const safeWidth = Math.max(1, width);
                  const safeHeight = Math.max(1, height);
                  return (
                    <g key={roi.id}>
                      <rect x={x} y={y} width={safeWidth} height={safeHeight} fill="rgba(31, 111, 135, 0.08)" stroke="rgba(255, 255, 255, 0.95)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                      <rect x={x} y={y} width={safeWidth} height={safeHeight} fill="none" stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                      <text
                        x={x + safeWidth / 2}
                        y={Math.max(12, y - 8)}
                        fill="#fbf8ef"
                        stroke="rgba(0, 0, 0, 0.82)"
                        strokeWidth={3}
                        paintOrder="stroke"
                        fontSize={11}
                        fontFamily="var(--font-display)"
                        fontWeight={700}
                        letterSpacing={0}
                        textAnchor="middle"
                        vectorEffect="non-scaling-stroke"
                      >
                        {roi.label}
                      </text>
                    </g>
                  );
                }
                return (
                  <g key={roi.id}>
                    <circle cx={roi.startPlane.x} cy={roi.startPlane.y} r={7} fill={color} stroke="rgba(255,255,255,0.95)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                    <line x1={roi.startPlane.x - 12} y1={roi.startPlane.y} x2={roi.startPlane.x + 12} y2={roi.startPlane.y} stroke="rgba(255,255,255,0.9)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    <line x1={roi.startPlane.x} y1={roi.startPlane.y - 12} x2={roi.startPlane.x} y2={roi.startPlane.y + 12} stroke="rgba(255,255,255,0.9)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    <text
                      x={roi.startPlane.x}
                      y={roi.startPlane.y - 16}
                      fill="#fbf8ef"
                      stroke="rgba(0, 0, 0, 0.82)"
                      strokeWidth={3}
                      paintOrder="stroke"
                      fontSize={11}
                      fontFamily="var(--font-display)"
                      fontWeight={700}
                      letterSpacing={0}
                      textAnchor="middle"
                      vectorEffect="non-scaling-stroke"
                    >
                      {roi.label}
                    </text>
                  </g>
                );
              })}
              {visibleMeasurements.map((measurement) => (
                <g key={measurement.id}>
                  <line
                    x1={measurement.startPlane.x}
                    y1={measurement.startPlane.y}
                    x2={measurement.endPlane.x}
                    y2={measurement.endPlane.y}
                    stroke="rgba(255, 255, 255, 0.95)"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={measurement.startPlane.x}
                    y1={measurement.startPlane.y}
                    x2={measurement.endPlane.x}
                    y2={measurement.endPlane.y}
                    stroke="rgba(198, 111, 45, 0.92)"
                    strokeWidth={1.2}
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle cx={measurement.startPlane.x} cy={measurement.startPlane.y} r={5} fill="rgba(198, 111, 45, 0.95)" vectorEffect="non-scaling-stroke" />
                  <circle cx={measurement.endPlane.x} cy={measurement.endPlane.y} r={5} fill="rgba(198, 111, 45, 0.95)" vectorEffect="non-scaling-stroke" />
                  <text
                    x={(measurement.startPlane.x + measurement.endPlane.x) / 2}
                    y={(measurement.startPlane.y + measurement.endPlane.y) / 2}
                    dx={8}
                    dy={-8}
                    fill="#fbf8ef"
                    stroke="rgba(0, 0, 0, 0.82)"
                    strokeWidth={3}
                    paintOrder="stroke"
                    fontSize={11}
                    fontFamily="var(--font-display)"
                    fontWeight={700}
                    letterSpacing={0}
                    textAnchor="middle"
                    vectorEffect="non-scaling-stroke"
                  >
                    {measurement.label || formatMeasurementDistance(measurement.distanceUm)}
                  </text>
                </g>
              ))}
              {draftPlanePoint ? (
                <g>
                  <circle cx={draftPlanePoint.x} cy={draftPlanePoint.y} r={6} fill="rgba(31, 111, 135, 0.95)" vectorEffect="non-scaling-stroke" />
                  <circle cx={draftPlanePoint.x} cy={draftPlanePoint.y} r={11} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                </g>
              ) : null}
              {roiDraftPlanePoint ? (
                <g>
                  <circle cx={roiDraftPlanePoint.x} cy={roiDraftPlanePoint.y} r={6} fill="rgba(31, 111, 135, 0.95)" vectorEffect="non-scaling-stroke" />
                  <rect x={roiDraftPlanePoint.x - 10} y={roiDraftPlanePoint.y - 10} width={20} height={20} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                </g>
              ) : null}
            </svg>
          ) : null}

          {/* Scale bar display only in 2D Slicing mode */}
          {viewMode === "2d" && scaleBar && sliceWidth > 0 && !error && !loading ? (
            <div
              className="scale-bar-wrap"
              style={{
                position: "absolute",
                bottom: 16,
                left: 16,
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                pointerEvents: "none",
              }}
            >
              <div
                className="scale-bar-line"
                style={{
                  width: scaleBar.widthCss,
                  height: 3,
                  background: "#ffffff",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.8)",
                }}
              />
              <span
                style={{
                  color: "#ffffff",
                  fontSize: 10,
                  textShadow: "0 1px 3px rgba(0,0,0,0.8)",
                  marginTop: 4,
                  fontFamily: "var(--font-display)",
                }}
              >
                {scaleBar.label}
              </span>
            </div>
          ) : null}

          {/* 3D rotation overlay instructions */}
          {viewMode === "3d" && !error && !loading ? (
            <div
              className="viewer-overlay-label viewer-3d-instruction"
              style={{
                position: "absolute",
                top: 16,
                right: 16,
                background: "rgba(0,0,0,0.6)",
                border: "1px solid rgba(251, 248, 239, 0.22)",
                padding: "4px 8px",
                borderRadius: 0,
                fontSize: 10,
                fontFamily: "var(--font-display)",
                color: "#fbf8ef",
                pointerEvents: "none",
                letterSpacing: 0,
                textTransform: "uppercase"
              }}
            >
              Drag mouse to rotate 3D
            </div>
          ) : null}
        </div>
      </div>

      <div
        className="workbench-stage-readout"
        style={{
          borderTop: "1px solid var(--border)",
          padding: variant === "tile" ? "7px 10px" : "10px 14px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          fontSize: variant === "tile" ? 10 : 12,
          fontFamily: "var(--font-display)",
          background: "rgba(251, 248, 239, 0.94)",
          color: "#171511",
        }}
      >
        <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {variant === "tile" && viewMode === "2d" ? (
            <>
              <span>
                {sliceWidth} x {sliceHeight} ({dtype})
              </span>
              <span style={{ margin: "0 8px", color: "#7a7569" }}>|</span>
              <span>
                {axis === "z" ? "XY" : axis === "y" ? "XZ" : "YZ"} {slice + 1}
              </span>
            </>
          ) : viewMode === "2d" ? (
            <>
              <span>
                Grid: {sliceWidth} x {sliceHeight} ({dtype})
              </span>
              <span style={{ margin: "0 12px", color: "#7a7569" }}>|</span>
              <span>
                {axis === "z" ? "Plane XY" : axis === "y" ? "Plane XZ" : "Plane YZ"} Slice {slice + 1}
              </span>
            </>
          ) : (
            <>
              <span>
                3D Volume: {volumeWidth} x {volumeHeight} x {volumeDepth} ({dtype})
              </span>
              <span style={{ margin: "0 12px", color: "#7a7569" }}>|</span>
              <span style={{ color: "#075f83" }}>
                Preview Downscale: {downsample}x
              </span>
            </>
          )}
        </div>
        <div style={{ color: "#171511", fontWeight: "bold", whiteSpace: "nowrap" }}>
          {viewMode === "2d" ? (
            inspectCoords && inspectVal !== null ? (
              <span>
                {planeReadoutLabels.horizontal}:{inspectCoords.x} {planeReadoutLabels.vertical}:{inspectCoords.y} ➔ Value: {inspectVal}
              </span>
            ) : (
              <span className="muted" style={{ fontStyle: "italic", fontWeight: "normal", color: "#5c5a52" }}>
                {measurementMode
                  ? "Click two points to measure calibrated distance"
                  : roiTool !== "off"
                  ? roiTool === "box"
                    ? "Click two corners to define a region"
                    : "Click to place a point ROI"
                  : "Hover canvas to inspect raw voxels"}
              </span>
            )
          ) : (
            <span style={{ color: "#a6561c" }}>
              Rot: P:{pitch.toFixed(2)} Y:{yaw.toFixed(2)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

type OrthogonalViewerProps = Omit<
  VolumetricViewerProps,
  "axis" | "slice" | "viewMode" | "downsample" | "alphaScale" | "pitch" | "yaw" | "onRotationChange" | "title" | "variant" | "crosshair" | "onPlanePointSelect"
> & {
  xSlice: number;
  ySlice: number;
  zSlice: number;
  onSliceChange: (next: { x?: number; y?: number; z?: number }) => void;
  onLoadingChange?: (loading: boolean) => void;
};

export function OrthogonalViewer({
  xSlice,
  ySlice,
  zSlice,
  onSliceChange,
  onLoadedMetadata,
  onSliceLoaded,
  onLoadingChange,
  ...sharedProps
}: OrthogonalViewerProps) {
  const crosshair = { x: xSlice, y: ySlice, z: zSlice };
  const handlePlaneSelect = (point: { x: number; y: number; z: number }) => {
    onSliceChange(point);
  };
  const [planeLoading, setPlaneLoading] = useState({ xy: false, xz: false, yz: false });
  const orthogonalLoadingChangeRef = useRef(onLoadingChange);

  useEffect(() => {
    orthogonalLoadingChangeRef.current = onLoadingChange;
  }, [onLoadingChange]);

  const setPlaneLoadingState = (plane: "xy" | "xz" | "yz", loading: boolean) => {
    setPlaneLoading((prev) => (prev[plane] === loading ? prev : { ...prev, [plane]: loading }));
  };

  useEffect(() => {
    orthogonalLoadingChangeRef.current?.(Object.values(planeLoading).some(Boolean));
  }, [planeLoading]);

  useEffect(() => {
    return () => orthogonalLoadingChangeRef.current?.(false);
  }, []);

  if (sharedProps.zMax <= 1) {
    return (
      <div
        className="orthogonal-viewer"
        style={{
          height: "100%",
          width: "100%",
          background: "#050505",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 260px",
          gap: 1,
          padding: 1,
        }}
      >
        <div style={{ minHeight: 0, minWidth: 0 }}>
          <VolumetricViewer
            {...sharedProps}
            axis="z"
            slice={zSlice}
            viewMode="2d"
            downsample={4}
            alphaScale={0.15}
            pitch={0}
            yaw={0}
            title={`XY · single plane`}
            variant="tile"
            crosshair={crosshair}
            onPlanePointSelect={handlePlaneSelect}
            onLoadedMetadata={onLoadedMetadata}
            onSliceLoaded={onSliceLoaded}
            onLoadingChange={(loading) => setPlaneLoadingState("xy", loading)}
          />
        </div>
        <div
          style={{
            border: "1px solid rgba(251, 248, 239, 0.16)",
            background: "#080808",
            color: "#fbf8ef",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 10,
          }}
        >
          <div style={{ fontFamily: "var(--font-display)", fontSize: 10, fontWeight: 700, letterSpacing: 0, textTransform: "uppercase", color: "var(--atlas-orange)" }}>
            Single-Plane Asset
          </div>
          <p style={{ margin: 0, fontFamily: "var(--font-body)", fontSize: 13, lineHeight: 1.45, color: "rgba(251, 248, 239, 0.78)" }}>
            This source has one indexed Z plane, so orthogonal XZ and YZ planes are not available for this asset.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="orthogonal-viewer"
      style={{
        height: "100%",
        width: "100%",
        background: "#050505",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.35fr) minmax(260px, 0.9fr)",
        gridTemplateRows: "1fr 1fr",
        gap: 1,
        padding: 1,
      }}
    >
      <div style={{ gridRow: "1 / span 2", minHeight: 0, minWidth: 0 }}>
        <VolumetricViewer
          {...sharedProps}
          axis="z"
          slice={zSlice}
          viewMode="2d"
          downsample={4}
          alphaScale={0.15}
          pitch={0}
          yaw={0}
          title={`XY · Z ${zSlice + 1}/${sharedProps.zMax}`}
          variant="tile"
            crosshair={crosshair}
            onPlanePointSelect={handlePlaneSelect}
            onLoadedMetadata={onLoadedMetadata}
            onSliceLoaded={onSliceLoaded}
            onLoadingChange={(loading) => setPlaneLoadingState("xy", loading)}
          />
      </div>
      <div style={{ minHeight: 0, minWidth: 0 }}>
        <VolumetricViewer
          {...sharedProps}
          axis="y"
          slice={ySlice}
          viewMode="2d"
          downsample={4}
          alphaScale={0.15}
          pitch={0}
          yaw={0}
          title={`XZ · Y ${ySlice + 1}/${sharedProps.yMax}`}
          variant="tile"
          crosshair={crosshair}
          onPlanePointSelect={handlePlaneSelect}
          onLoadingChange={(loading) => setPlaneLoadingState("xz", loading)}
        />
      </div>
      <div style={{ minHeight: 0, minWidth: 0 }}>
        <VolumetricViewer
          {...sharedProps}
          axis="x"
          slice={xSlice}
          viewMode="2d"
          downsample={4}
          alphaScale={0.15}
          pitch={0}
          yaw={0}
          title={`YZ · X ${xSlice + 1}/${sharedProps.xMax}`}
          variant="tile"
          crosshair={crosshair}
          onPlanePointSelect={handlePlaneSelect}
          onLoadingChange={(loading) => setPlaneLoadingState("yz", loading)}
        />
      </div>
    </div>
  );
}
