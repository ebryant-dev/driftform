import type { CharacterDef } from '../characters';
import type { Settings } from './options';
import { Camera } from './camera';
import { hexToRgb } from './math';

// Contour renderer (ADR 0003). The sculpted mesh is drawn on the GPU and a
// fragment shader draws a ring wherever the baked flow coordinate crosses a
// whole number (times the density). Solid: a depth-only pass first, then
// lines only where they're the frontmost surface. Ghost: lines everywhere.

const VERT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec3 aPos;      // normalized -1..1 within the bbox
in vec4 aAttach;   // node a1, b1, a2, b2
in vec3 aWeights;  // t1, t2, w (0..1)
in float aFlow;    // 0..1 of flowMax
in vec2 aEye;      // -1..1 of eyeRadius (≈1.02 = not near an eye)

uniform sampler2D uNodes; // rows: rest pos, rest tangent, pos + scale, tangent
uniform vec3 uBboxMin, uBboxMax;
uniform float uFlowMax, uEyeRadius;
uniform vec3 uCenter;
uniform vec3 uRot0, uRot1, uRot2;   // view rotation rows
uniform float uDist, uNear, uFar;
uniform vec2 uClip;                   // clip-space scale for x, y at unit depth
uniform float uTime, uShimmer;

out float vFlow;
out vec2 vEye;
out vec3 vView;

invariant gl_Position;

vec4 node(int row, float i) { return texelFetch(uNodes, ivec2(int(i + 0.5), row), 0); }

// Place a rest-pose point relative to one chain segment, as that segment has moved.
vec3 skin(float a, float b, float t, vec3 p) {
  vec3 rp = mix(node(0, a).xyz, node(0, b).xyz, t);
  vec3 rt = normalize(mix(node(1, a).xyz, node(1, b).xyz, t));
  vec4 ca = node(2, a), cb = node(2, b);
  vec3 cp = mix(ca.xyz, cb.xyz, t);
  float sc = mix(ca.w, cb.w, t);
  vec3 ct = normalize(mix(node(3, a).xyz, node(3, b).xyz, t));
  vec3 off = p - rp;
  // Smallest rotation taking the rest tangent to the current one.
  vec3 k = cross(rt, ct);
  float c = dot(rt, ct);
  off = off * c + cross(k, off) + k * (dot(k, off) / max(1.0 + c, 1e-4));
  // Breathing scales the cross-section, not the length.
  float ax = dot(off, ct);
  return cp + ct * ax + (off - ct * ax) * sc;
}

void main() {
  vec3 rest = uBboxMin + (aPos * 0.5 + 0.5) * (uBboxMax - uBboxMin);
  vec3 p = mix(skin(aAttach.z, aAttach.w, aWeights.y, rest), skin(aAttach.x, aAttach.y, aWeights.x, rest), aWeights.z);

  // Shimmer: the surface never quite holds still.
  float f = aFlow * uFlowMax;
  p += uShimmer * vec3(
    sin(f * 0.37 + uTime * 0.9 + rest.y * 9.0),
    sin(f * 0.29 + uTime * 0.7 + rest.z * 9.0),
    sin(f * 0.33 + uTime * 0.8 + rest.x * 9.0));

  vec3 r = p - uCenter;
  vec3 v = vec3(dot(uRot0, r), dot(uRot1, r), dot(uRot2, r));
  float w = uDist - v.z; // distance in front of the camera
  float zc = (uFar + uNear) / (uFar - uNear) * w - 2.0 * uFar * uNear / (uFar - uNear);
  gl_Position = vec4(v.x * uClip.x, v.y * uClip.y, zc, w);

  vFlow = f;
  vEye = aEye * uEyeRadius * (32767.0 / 32000.0);
  vView = v;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;

in float vFlow;
in vec2 vEye;
in vec3 vView;

uniform float uDensity;     // rings per flow unit
uniform float uHalfWidth;   // half line width, device px
uniform float uEyeRadius;
uniform float uDist, uExtent, uDepthFade;
uniform vec3 uNearColor, uFarColor;
uniform float uBackFade;    // ghost: how faint back-facing lines are (1 = same)
uniform float uBackPass;    // 1 while drawing the hidden far side as a faint glow
uniform float uBackGlow;    // strength of that glow

out vec4 outColor;

// Antialiased line where v crosses a whole number, constant width in pixels.
float ringsAt(float v, float fw, float halfw) {
  float d = abs(fract(v + 0.5) - 0.5) / max(fw, 1e-5);
  return 1.0 - smoothstep(halfw - 0.5, halfw + 0.5, d);
}

// Rings with level of detail: where they'd crowd closer than a few pixels
// (thin tips, grazing angles), keep every 2nd, 4th, ... ring instead, blending
// between levels, so the form stays drawn instead of fading to moire or nothing.
float rings(float v, float halfw) {
  float fw = fwidth(v);
  float l = log2(max(fw / 0.22, 1.0));
  float l0 = floor(l);
  float s0 = exp2(l0), s1 = s0 * 2.0;
  float a0 = ringsAt(v / s0, fw / s0, halfw);
  float a1 = ringsAt(v / s1, fw / s1, halfw);
  return mix(a0, a1, smoothstep(0.0, 1.0, fract(l)));
}

void main() {
  // Depth 0 (near) .. 1 (far) across the character.
  float depth = clamp((-vView.z + uExtent) / (2.0 * uExtent), 0.0, 1.0);
  float halfw = uHalfWidth * mix(1.0, 0.6, depth);

  float a = rings(vFlow * uDensity, halfw);

  // Eyes: concentric rings on the turret and a slit pupil; body rings give way there.
  // Almond-shaped: wider than tall, like the reference's lids.
  float er = length(vEye / vec2(1.0, 0.62)) / uEyeRadius;
  if (er < 1.0) {
    float inEye = 1.0 - smoothstep(0.7, 1.0, er);
    float eyeRings = rings(er * 3.0, halfw) * step(0.6, er * 3.0);
    float slit = length(vEye / vec2(0.36 * uEyeRadius, 0.08 * uEyeRadius));
    float pupil = rings(slit, halfw) * step(slit, 1.5);
    a = mix(a, max(eyeRings, pupil), inEye);
  }

  // Facing, from the surface's screen-space normal. Lines that face you read
  // cream; toward the silhouette and in the depths they turn blue, like the reference.
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 toEye = normalize(vec3(0.0, 0.0, uDist) - vView);
  float facing = abs(dot(n, toEye));
  float rim = pow(1.0 - facing, 1.6);
  if (!gl_FrontFacing) a *= uBackFade;

  // A soft light from the upper left and in front: lit surfaces read white,
  // turned-away ones deepen to blue.
  vec3 L = normalize(vec3(-0.45, 0.6, 0.65));
  float lit = clamp(dot(n * sign(dot(n, toEye)), L), 0.0, 1.0);
  float blue = clamp(rim * 0.9 + (1.0 - lit) * 0.75 + depth * 0.2 - 0.25, 0.0, 1.0);
  vec3 col = mix(uNearColor, uFarColor, blue);
  float alpha = a * (1.0 - uDepthFade * depth);
  if (uBackPass > 0.5) {
    // The far side, seen through the body: a faint blue glow.
    col = uFarColor;
    alpha = a * uBackGlow * (1.0 - 0.5 * depth);
  }
  outColor = vec4(col * alpha, alpha);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Driftform shader: ' + gl.getShaderInfoLog(s));
  return s;
}

/** Owns the canvas pixels and the GL context; never the page. */
export class GLRenderer {
  readonly camera = new Camera();
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject | null = null;
  private buffers: WebGLBuffer[] = [];
  private tex: WebGLTexture | null = null;
  private texData = new Float32Array(0);
  private indexCount = 0;
  private indexType = 0;
  private nodeCount = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private width = 0;
  private height = 0;
  private dpr = 1;
  private character: CharacterDef | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true });
    if (!gl) throw new Error('Driftform: WebGL 2 is not available.');
    this.gl = gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aAttach');
    gl.bindAttribLocation(prog, 2, 'aWeights');
    gl.bindAttribLocation(prog, 3, 'aFlow');
    gl.bindAttribLocation(prog, 4, 'aEye');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Driftform shader link: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    for (const name of [
      'uNodes', 'uBboxMin', 'uBboxMax', 'uFlowMax', 'uEyeRadius', 'uCenter', 'uRot0', 'uRot1', 'uRot2', 'uDist', 'uNear', 'uFar',
      'uClip', 'uTime', 'uShimmer', 'uDensity', 'uHalfWidth', 'uExtent', 'uDepthFade', 'uNearColor', 'uFarColor', 'uBackFade',
      'uBackPass', 'uBackGlow',
    ]) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
  }

  /** Match the backing store to the container's CSS size × devicePixelRatio. Returns true if it changed. */
  resize(cssWidth: number, cssHeight: number, maxDpr: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (w === this.canvas.width && h === this.canvas.height && dpr === this.dpr) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = cssWidth;
    this.height = cssHeight;
    this.dpr = dpr;
    return true;
  }

  setCharacter(character: CharacterDef) {
    const { gl } = this;
    this.releaseMesh();
    this.character = character;
    const m = character.mesh;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const attrib = (loc: number, data: ArrayBufferView, size: number, type: number, normalized: boolean) => {
      const b = gl.createBuffer()!;
      this.buffers.push(b);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
    };
    attrib(0, m.position, 3, gl.SHORT, true);
    attrib(1, m.attach, 4, gl.UNSIGNED_BYTE, false);
    attrib(2, m.weights, 3, gl.UNSIGNED_BYTE, true);
    attrib(3, m.flow, 1, gl.UNSIGNED_SHORT, true);
    attrib(4, m.eye, 2, gl.SHORT, true);
    const ib = gl.createBuffer()!;
    this.buffers.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    this.indexCount = m.indices.length;
    this.indexType = m.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.bindVertexArray(null);

    // Node texture: width = nodes, rows = rest pos, rest tangent, pos + scale, tangent.
    const n = character.nodes.length;
    this.nodeCount = n;
    this.texData = new Float32Array(n * 4 * 4);
    const rest = character.rest;
    const tangents = this.tangents(character, rest);
    for (let i = 0; i < n; i++) {
      this.texData.set([rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2], 1], i * 4);
      this.texData.set([tangents[i * 3], tangents[i * 3 + 1], tangents[i * 3 + 2], 0], (n + i) * 4);
    }
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 4, 0, gl.RGBA, gl.FLOAT, this.texData);
  }

  /** Per-node tangent along its part: toward the next node, from the previous one. */
  private tangents(character: CharacterDef, pos: Float32Array, out = new Float32Array(character.nodes.length * 3)) {
    const nodes = character.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const prev = i > 0 && nodes[i - 1].part === nodes[i].part ? i - 1 : i;
      const next = i < nodes.length - 1 && nodes[i + 1].part === nodes[i].part ? i + 1 : i;
      const x = pos[next * 3] - pos[prev * 3], y = pos[next * 3 + 1] - pos[prev * 3 + 1], z = pos[next * 3 + 2] - pos[prev * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
    }
    return out;
  }

  private scratchT = new Float32Array(0);

  draw(pos: Float32Array, scale: Float32Array, settings: Settings, transparent: boolean, time: number) {
    const { gl, character } = this;
    if (!character || !this.tex) return;
    const n = this.nodeCount;

    // Upload this frame's node positions, scales and tangents.
    if (this.scratchT.length !== n * 3) this.scratchT = new Float32Array(n * 3);
    const tan = this.tangents(character, pos, this.scratchT);
    for (let i = 0; i < n; i++) {
      const o = (2 * n + i) * 4, q = (3 * n + i) * 4;
      this.texData[o] = pos[i * 3]; this.texData[o + 1] = pos[i * 3 + 1]; this.texData[o + 2] = pos[i * 3 + 2]; this.texData[o + 3] = scale[i];
      this.texData[q] = tan[i * 3]; this.texData[q + 1] = tan[i * 3 + 1]; this.texData[q + 2] = tan[i * 3 + 2];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 2, n, 2, gl.RGBA, gl.FLOAT, this.texData.subarray(2 * n * 4));

    const cam = this.camera;
    cam.update(settings.camera, this.width, this.height, character.center, character.extent);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (transparent) gl.clearColor(0, 0, 0, 0);
    else {
      const bg = hexToRgb(settings.colors.background);
      gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, 1);
    }
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const u = this.u;
    const m = character.mesh;
    const E = character.extent;
    gl.uniform1i(u.uNodes, 0);
    gl.uniform3fv(u.uBboxMin, m.bboxMin);
    gl.uniform3fv(u.uBboxMax, m.bboxMax);
    gl.uniform1f(u.uFlowMax, m.flowMax);
    gl.uniform1f(u.uEyeRadius, m.eyeRadius);
    gl.uniform3fv(u.uCenter, character.center);
    const [r0, r1, r2] = cam.rows();
    gl.uniform3fv(u.uRot0, r0);
    gl.uniform3fv(u.uRot1, r1);
    gl.uniform3fv(u.uRot2, r2);
    gl.uniform1f(u.uDist, cam.distance);
    gl.uniform1f(u.uNear, Math.max(cam.distance - 2 * E, 0.01));
    gl.uniform1f(u.uFar, cam.distance + 2 * E);
    gl.uniform2f(u.uClip, (cam.ppu * cam.distance) / (this.width / 2), (cam.ppu * cam.distance) / (this.height / 2));
    gl.uniform1f(u.uTime, time);
    gl.uniform1f(u.uShimmer, settings.motion.looseness * 0.004 * E);
    gl.uniform1f(u.uDensity, settings.density);
    gl.uniform1f(u.uHalfWidth, (settings.strokeWeight * this.dpr) / 2);
    gl.uniform1f(u.uExtent, E);
    gl.uniform1f(u.uDepthFade, settings.depthFade);
    const nc = hexToRgb(settings.colors.near), fc = hexToRgb(settings.colors.far);
    gl.uniform3f(u.uNearColor, nc[0] / 255, nc[1] / 255, nc[2] / 255);
    gl.uniform3f(u.uFarColor, fc[0] / 255, fc[1] / 255, fc[2] / 255);

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (settings.solid) {
      // Pass 1: depth only. Pass 2: lines where they're the frontmost surface.
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.colorMask(false, false, false, false);
      gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
      gl.colorMask(true, true, true, true);
      gl.depthMask(false);
      gl.uniform1f(u.uBackFade, 1);
      if (settings.backGlow > 0) {
        // The hidden far side, faintly, behind everything in front.
        gl.depthFunc(gl.GREATER);
        gl.uniform1f(u.uBackPass, 1);
        gl.uniform1f(u.uBackGlow, settings.backGlow);
        gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
      }
      gl.depthFunc(gl.LEQUAL);
      gl.uniform1f(u.uBackPass, 0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
      gl.depthMask(true);
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.uniform1f(u.uBackPass, 0);
      gl.uniform1f(u.uBackFade, 0.45);
      gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
    }
    gl.bindVertexArray(null);
  }

  private releaseMesh() {
    const { gl } = this;
    for (const b of this.buffers) gl.deleteBuffer(b);
    this.buffers = [];
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = null;
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = null;
  }

  /** Free everything on the GPU and give the context back. */
  dispose() {
    this.releaseMesh();
    this.gl.deleteProgram(this.prog);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
