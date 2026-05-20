"use client";

import { useEffect, useRef, useState, useMemo } from "react";

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
}: VolumetricViewerProps) {
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
  const [drawRevision, setDrawRevision] = useState(0);

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

    const gl = canvas.getContext("webgl2");
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

    async function fetchSlice() {
      setLoading(true);
      setError(null);
      setInspectCoords(null);
      setInspectVal(null);

      try {
        const url = `http://127.0.0.1:8080/api/volume/slice?dataset=${encodeURIComponent(
          dataset
        )}&asset=${encodeURIComponent(asset)}&axis=${axis}&slice=${slice}`;

        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Volumetric sidecar returned status: ${res.status}`);
        }

        const buffer = await res.arrayBuffer();
        if (cancelled) return;

        const hWidth = Number(res.headers.get("x-width") || 0);
        const hHeight = Number(res.headers.get("x-height") || 0);
        const hDtype = res.headers.get("x-dtype") || "uint8";

        setSliceWidth(hWidth);
        setSliceHeight(hHeight);
        setDtype(hDtype);

        let typedArray: Uint8Array | Uint16Array;
        let maxPossible = 255;

        if (hDtype.includes("16") || hDtype === "uint16") {
          typedArray = new Uint16Array(buffer);
          maxPossible = 65535;
        } else {
          typedArray = new Uint8Array(buffer);
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
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || "Failed to load voxel slice from the sidecar.");
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
    };
  }, [dataset, asset, axis, slice, viewMode]);

  // Fetch 3D Downsampled Volume
  useEffect(() => {
    if (viewMode !== "3d") return;
    let cancelled = false;

    async function fetch3DVolume() {
      setLoading(true);
      setError(null);

      try {
        const url = `http://127.0.0.1:8080/api/volume/3d?dataset=${encodeURIComponent(
          dataset
        )}&asset=${encodeURIComponent(asset)}&downsample=${downsample}`;

        const res = await fetch(url);
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
        if (!cancelled) {
          setError(err.message || "Failed to stream 3D volume buffer.");
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
    };
  }, [dataset, asset, downsample, viewMode]);

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

  // Size listener to update observed display size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === canvas) {
          const w = entry.contentRect.width || canvas.clientWidth;
          const h = entry.contentRect.height || canvas.clientHeight;
          setCanvasDisplay({ width: w, height: h });
        }
      }
    });

    observer.observe(canvas);
    setCanvasDisplay({ width: canvas.clientWidth, height: canvas.clientHeight });

    return () => {
      observer.disconnect();
    };
  }, []);

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

    const canvas = canvasRef.current;
    const data = sliceDataRef.current;
    if (!canvas || !data || sliceWidth === 0 || sliceHeight === 0) return;

    const rect = canvas.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;

    const px = Math.floor(xRatio * sliceWidth);
    const py = Math.floor(yRatio * sliceHeight);

    if (px >= 0 && px < sliceWidth && py >= 0 && py < sliceHeight) {
      setInspectCoords({ x: px, y: py });
      const idx = py * sliceWidth + px;
      if (idx < data.length) {
        const val = data[idx];
        setInspectVal(val);

        if (onProbeChange) {
          const vx = Number(physicalVoxelSizeNm.x || 1.0);
          const vy = Number(physicalVoxelSizeNm.y || 1.0);
          const vz = Number(physicalVoxelSizeNm.z || 1.0);

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

          const xUm = (xVal * vx) / 1000.0;
          const yUm = (yVal * vy) / 1000.0;
          const zUm = (zVal * vz) / 1000.0;

          onProbeChange({ px: xVal, py: yVal, pz: zVal, xUm, yUm, zUm, val });
        }
      }
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

    if (axis === "z") {
      return (xMax * vx) / (yMax * vy);
    } else if (axis === "y") {
      return (xMax * vx) / (zMax * vz);
    } else {
      return (yMax * vy) / (zMax * vz);
    }
  }, [physicalVoxelSizeNm, axis, zMax, yMax, xMax, sliceWidth, sliceHeight]);

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

  return (
    <div className="workbench-stage panel" style={{ background: "#050505", border: "none", position: "relative", flex: 1, display: "flex", flexDirection: "column", height: "100%", padding: 0 }}>
      {loading ? (
        <div className="stage-overlay" style={{ position: "absolute", inset: 0, zIndex: 10, background: "rgba(0,0,0,0.85)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontSize: 13, gap: 10 }}>
          <span className="pulsing-text" style={{ color: "var(--atlas-blue-dark)" }}>
            {viewMode === "3d" ? "Streaming and downsampling 3D volume..." : "Streaming binary array slice..."}
          </span>
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

      <div className="stage-canvas-wrap" style={{ position: "relative", width: "100%", flex: 1, display: "flex", justifyContent: "center", alignItems: "center", minHeight: 0 }}>
        {/* Render centered relative container with corrected aspect ratios */}
        <div
          style={{
            position: "relative",
            maxWidth: "100%",
            maxHeight: "100%",
            width: "100%",
            height: "100%",
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
            style={{
              width: "100%",
              height: "100%",
              cursor: viewMode === "3d" ? "grab" : "crosshair",
              imageRendering: "pixelated",
              objectFit: "contain",
            }}
          />

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
                  fontFamily: "monospace",
                }}
              >
                {scaleBar.label}
              </span>
            </div>
          ) : null}

          {/* 3D rotation overlay instructions */}
          {viewMode === "3d" && !error && !loading ? (
            <div
              style={{
                position: "absolute",
                top: 16,
                right: 16,
                background: "rgba(0,0,0,0.6)",
                border: "1px solid var(--border)",
                padding: "4px 8px",
                borderRadius: 0,
                fontSize: 10,
                fontFamily: "monospace",
                color: "var(--foreground)",
                pointerEvents: "none",
                letterSpacing: "0.05em",
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
          padding: "10px 14px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 12,
          fontFamily: "monospace",
          background: "#080808",
        }}
      >
        <div>
          {viewMode === "2d" ? (
            <>
              <span>
                Grid: {sliceWidth} x {sliceHeight} ({dtype})
              </span>
              <span style={{ margin: "0 12px", color: "#333" }}>|</span>
              <span>
                {axis === "z" ? "Plane XY" : axis === "y" ? "Plane XZ" : "Plane YZ"} Slice {slice + 1}
              </span>
            </>
          ) : (
            <>
              <span>
                3D Volume: {volumeWidth} x {volumeHeight} x {volumeDepth} ({dtype})
              </span>
              <span style={{ margin: "0 12px", color: "#333" }}>|</span>
              <span style={{ color: "var(--atlas-blue-dark)" }}>
                Raymarching Downscale: {downsample}x
              </span>
            </>
          )}
        </div>
        <div style={{ color: "var(--accent)", fontWeight: "bold" }}>
          {viewMode === "2d" ? (
            inspectCoords && inspectVal !== null ? (
              <span>
                X:{inspectCoords.x} Y:{inspectCoords.y} ➔ Value: {inspectVal}
              </span>
            ) : (
              <span className="muted" style={{ fontStyle: "italic", fontWeight: "normal", color: "#666" }}>
                Hover canvas to inspect raw voxels
              </span>
            )
          ) : (
            <span style={{ color: "var(--atlas-orange)" }}>
              Rot: P:{pitch.toFixed(2)} Y:{yaw.toFixed(2)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
