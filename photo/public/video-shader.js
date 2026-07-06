const VIDEO_VERTEX_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const VIDEO_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

uniform float u_particlesOn;
uniform float u_glowOn;
uniform float u_colorCycleOn;
uniform float u_scanlinesOn;

const float PI = 3.14159265359;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec3 hsl2rgb(float h, float s, float l) {
  vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
}

float sdSphere(vec3 p, float r) {
  return length(p) - r;
}

float sceneSDF(vec3 p) {
  float r = 1.0 + u_bass * 0.5;
  float displace = sin(p.x * 5.0 + u_time * 1.5) * sin(p.y * 5.0 - u_time) * sin(p.z * 5.0 + u_time * 0.7);
  displace *= 0.12 + u_treble * 0.35;
  return sdSphere(p, r) + displace;
}

vec3 estimateNormal(vec3 p) {
  float e = 0.0015;
  return normalize(vec3(
    sceneSDF(p + vec3(e, 0.0, 0.0)) - sceneSDF(p - vec3(e, 0.0, 0.0)),
    sceneSDF(p + vec3(0.0, e, 0.0)) - sceneSDF(p - vec3(0.0, e, 0.0)),
    sceneSDF(p + vec3(0.0, 0.0, e)) - sceneSDF(p - vec3(0.0, 0.0, e))
  ));
}

float particleField(vec2 uv) {
  vec2 grid = uv * 22.0;
  vec2 cell = floor(grid);
  vec2 local = fract(grid) - 0.5;
  float seed = hash(cell);
  float twinkle = sin(u_time * (1.5 + seed * 3.0) + seed * 30.0) * 0.5 + 0.5;
  float d = length(local);
  float dot_ = smoothstep(0.08 + seed * 0.05, 0.0, d);
  return dot_ * twinkle * step(0.82, seed);
}

void main() {
  vec2 uv = (v_uv * 2.0 - 1.0);
  uv.x *= u_resolution.x / u_resolution.y;

  vec3 ro = vec3(0.0, 0.0, 3.2);
  vec3 rd = normalize(vec3(uv, -1.6));

  float t = 0.0;
  float hitDist = -1.0;
  for (int i = 0; i < 80; i++) {
    vec3 p = ro + rd * t;
    float d = sceneSDF(p);
    if (d < 0.001) { hitDist = t; break; }
    t += d * 0.7;
    if (t > 10.0) break;
  }

  vec3 bgTop = vec3(0.03, 0.02, 0.08);
  vec3 bgBottom = vec3(0.08, 0.02, 0.12);
  vec3 color = mix(bgBottom, bgTop, v_uv.y);

  if (u_particlesOn > 0.5) {
    float p = particleField(v_uv + vec2(u_time * 0.01, 0.0));
    color += vec3(0.8, 0.9, 1.0) * p * (0.4 + u_treble * 0.6);
  }

  if (hitDist > 0.0) {
    vec3 p = ro + rd * hitDist;
    vec3 n = estimateNormal(p);
    vec3 lightDir = normalize(vec3(0.6, 0.7, 0.8));
    float diff = max(dot(n, lightDir), 0.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);

    float hue = u_colorCycleOn > 0.5 ? fract(u_time * 0.05 + u_mid * 0.2) : 0.78;
    vec3 base = hsl2rgb(hue, 0.75, 0.5 + u_bass * 0.15);
    vec3 surfaceColor = base * (0.3 + diff * 0.9) + rim * vec3(1.0, 0.9, 1.0) * (0.6 + u_treble * 0.8);
    color = surfaceColor;
  }

  if (u_glowOn > 0.5 && hitDist < 0.0) {
    vec3 p = ro + rd * max(t, 0.001);
    float d = abs(sceneSDF(p));
    float glow = exp(-d * 2.2) * (0.5 + u_bass * 1.2);
    float hue = u_colorCycleOn > 0.5 ? fract(u_time * 0.05 + u_mid * 0.2) : 0.78;
    color += hsl2rgb(hue, 0.8, 0.6) * glow * 0.6;
  }

  if (u_scanlinesOn > 0.5) {
    float scan = sin(v_uv.y * u_resolution.y * PI) * 0.5 + 0.5;
    color *= mix(1.0, 0.55 + scan * 0.45, 0.5);
    vec2 cc = v_uv - 0.5;
    float vig = smoothstep(0.9, 0.25, length(cc) * 1.4);
    color *= mix(0.55, 1.0, vig);
  }

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;
