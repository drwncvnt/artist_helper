const VERTEX_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_time;

uniform float u_pixelateOn;
uniform float u_pixelSize;

uniform float u_ditherOn;
uniform float u_ditherLevels;
uniform float u_ditherAmount;
uniform float u_ditherMono;

uniform float u_posterizeOn;
uniform float u_posterizeLevels;

uniform float u_crtOn;
uniform float u_crtScanline;
uniform float u_crtCurvature;
uniform float u_crtShift;
uniform float u_crtVignette;

uniform float u_fisheyeOn;
uniform float u_fisheyeAmount;

uniform float u_vhsOn;
uniform float u_vhsJitter;
uniform float u_vhsBleed;
uniform float u_vhsTracking;
uniform float u_vhsSaturation;

uniform float u_glitchOn;
uniform float u_glitchAmount;
uniform float u_glitchBlock;

uniform float u_blockOn;
uniform float u_blockAmount;
uniform float u_blockSize;

uniform float u_rgbSplitOn;
uniform float u_rgbSplitAmount;

uniform float u_halftoneOn;
uniform float u_halftoneSize;
uniform float u_halftoneAngle;

uniform float u_oscOn;
uniform float u_oscThickness;
uniform vec3 u_oscColor;

uniform float u_bloomOn;
uniform float u_bloomThreshold;
uniform float u_bloomAmount;

uniform float u_lightLeakOn;
uniform float u_lightLeakAmount;

uniform float u_deepFryOn;
uniform float u_deepFryAmount;

uniform sampler2D u_asciiAtlas;
uniform float u_asciiOn;
uniform float u_asciiCellSize;
uniform float u_asciiCount;
uniform float u_asciiColorMode;
uniform vec3 u_asciiTermColor;

uniform float u_duotoneOn;
uniform vec3 u_duotoneShadow;
uniform vec3 u_duotoneHighlight;
uniform float u_duotoneMix;

uniform float u_grainOn;
uniform float u_grainAmount;

uniform float u_vignetteOn;
uniform float u_vignetteAmount;

const float PI = 3.14159265359;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);

const float BAYER[16] = float[16](
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0
);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float bayerValue(vec2 fragCoord) {
  int x = int(mod(fragCoord.x, 4.0));
  int y = int(mod(fragCoord.y, 4.0));
  int idx = y * 4 + x;
  return BAYER[idx] / 16.0;
}

vec2 applyCurvature(vec2 uv, float amount) {
  vec2 cc = uv - 0.5;
  float dist = dot(cc, cc) * amount;
  return uv + cc * dist;
}

void main() {
  vec2 uv = v_uv;
  float inBounds = 1.0;

  // --- Fisheye / CCTV lens distortion ---
  if (u_fisheyeOn > 0.5 && u_fisheyeAmount > 0.0) {
    uv = applyCurvature(uv, u_fisheyeAmount * 1.1);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) inBounds = 0.0;
    uv = clamp(uv, 0.0, 1.0);
  }

  // --- CRT curvature (distorts sampling coords) ---
  if (u_crtOn > 0.5 && u_crtCurvature > 0.0) {
    uv = applyCurvature(uv, u_crtCurvature * 0.6);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) inBounds = 0.0;
    uv = clamp(uv, 0.0, 1.0);
  }

  // --- Pixelation ---
  if (u_pixelateOn > 0.5 && u_pixelSize > 1.0) {
    vec2 grid = u_resolution / u_pixelSize;
    uv = floor(uv * grid) / grid + (0.5 / grid);
  }

  // --- Glitch blocks ---
  if (u_glitchOn > 0.5) {
    float blockIndex = floor(uv.y / max(u_glitchBlock, 0.005));
    float t = floor(u_time * 6.0);
    float seedVal = hash(vec2(blockIndex, t));
    if (seedVal < u_glitchAmount * 0.6) {
      float xOffset = (hash(vec2(blockIndex, t + 1.0)) - 0.5) * 0.25 * u_glitchAmount;
      uv.x += xOffset;
    }
  }

  // --- Block corruption: corrupted macroblock reference (displaced block) ---
  if (u_blockOn > 0.5) {
    float bSize = max(u_blockSize, 2.0);
    vec2 blockCoordA = floor(gl_FragCoord.xy / bSize);
    float hA = hash(blockCoordA + 7.0);
    if (hA < u_blockAmount * 0.15) {
      vec2 blocksTotal = max(u_resolution / bSize, vec2(1.0));
      vec2 targetBlock = floor(hash(blockCoordA * 1.7 + 3.0) * blocksTotal);
      uv = (targetBlock * bSize + bSize * 0.5) / u_resolution;
    }
  }

  // --- VHS jitter per scanline ---
  if (u_vhsOn > 0.5) {
    float lineSeed = hash(vec2(floor(uv.y * u_resolution.y * 0.5), floor(u_time * 12.0)));
    uv.x += (lineSeed - 0.5) * 0.01 * u_vhsJitter;
  }

  uv = clamp(uv, 0.0, 1.0);

  // --- Sample with optional channel split (CRT rgb shift / VHS color bleed) ---
  float shiftAmt = 0.0;
  if (u_crtOn > 0.5) shiftAmt += u_crtShift * 0.006;
  if (u_vhsOn > 0.5) shiftAmt += u_vhsBleed * 0.008;

  vec3 color;
  if (shiftAmt > 0.0001) {
    float r = texture(u_image, clamp(uv + vec2(shiftAmt, 0.0), 0.0, 1.0)).r;
    float g = texture(u_image, uv).g;
    float b = texture(u_image, clamp(uv - vec2(shiftAmt, 0.0), 0.0, 1.0)).b;
    color = vec3(r, g, b);
  } else {
    color = texture(u_image, uv).rgb;
  }

  // --- RGB Split / Chromatic Aberration (radial from center) ---
  if (u_rgbSplitOn > 0.5 && u_rgbSplitAmount > 0.0) {
    vec2 dir = v_uv - 0.5;
    float dlen = length(dir);
    vec2 dirN = dlen > 0.0001 ? dir / dlen : vec2(0.0);
    float amt = u_rgbSplitAmount * 0.03;
    float r = texture(u_image, clamp(uv + dirN * amt, 0.0, 1.0)).r;
    float g = texture(u_image, uv).g;
    float b = texture(u_image, clamp(uv - dirN * amt, 0.0, 1.0)).b;
    color = vec3(r, g, b);
  }

  // --- VHS tracking band + saturation ---
  if (u_vhsOn > 0.5) {
    float lum = dot(color, LUMA);
    color = mix(color, vec3(lum), (1.0 - u_vhsSaturation) * 0.6);

    float trackY = fract(u_time * 0.04 + 0.35);
    float bandDist = abs(uv.y - trackY);
    float band = smoothstep(0.04, 0.0, bandDist) * u_vhsTracking;
    float noise = hash(uv * u_resolution + u_time);
    color = mix(color, vec3(noise), band * 0.8);
  }

  // --- Duotone ---
  if (u_duotoneOn > 0.5) {
    float lum = dot(color, LUMA);
    vec3 duo = mix(u_duotoneShadow, u_duotoneHighlight, lum);
    color = mix(color, duo, u_duotoneMix);
  }

  // --- Posterize / hard color banding (no dither pattern) ---
  if (u_posterizeOn > 0.5) {
    float levels = max(u_posterizeLevels, 2.0);
    color = floor(color * (levels - 1.0) + 0.5) / (levels - 1.0);
  }

  // --- Dithering (ordered, Bayer 4x4) ---
  if (u_ditherOn > 0.5) {
    float levels = max(u_ditherLevels, 2.0);
    float bayer = bayerValue(gl_FragCoord.xy) - 0.5;
    if (u_ditherMono > 0.5) {
      float lum = dot(color, LUMA);
      lum = floor(lum * (levels - 1.0) + u_ditherAmount * bayer + 0.5) / (levels - 1.0);
      color = vec3(lum);
    } else {
      color = floor(color * (levels - 1.0) + u_ditherAmount * bayer + 0.5) / (levels - 1.0);
    }
  }

  // --- Light Leaks ---
  if (u_lightLeakOn > 0.5) {
    vec2 leak1 = vec2(0.05, 0.92) + 0.03 * vec2(sin(u_time * 0.1), cos(u_time * 0.13));
    vec2 leak2 = vec2(0.95, 0.1) + 0.03 * vec2(cos(u_time * 0.09), sin(u_time * 0.11));
    float d1 = length(v_uv - leak1);
    float d2 = length(v_uv - leak2);
    vec3 leakColor1 = vec3(1.0, 0.55, 0.18);
    vec3 leakColor2 = vec3(1.0, 0.18, 0.32);
    float l1 = smoothstep(0.75, 0.0, d1);
    float l2 = smoothstep(0.6, 0.0, d2);
    vec3 leak = leakColor1 * l1 + leakColor2 * l2 * 0.8;
    color += leak * u_lightLeakAmount;
  }

  // --- Block corruption: blocky chroma / quantization (JPEG-style artifacts) ---
  if (u_blockOn > 0.5) {
    float bSize = max(u_blockSize, 2.0);
    vec2 blockCenterUv = (floor(gl_FragCoord.xy / bSize) + 0.5) * bSize / u_resolution;
    vec3 blockColor = texture(u_image, clamp(blockCenterUv, 0.0, 1.0)).rgb;
    float fineY = dot(color, LUMA);
    float blockY = dot(blockColor, LUMA);
    vec3 blockChroma = blockColor - blockY;
    vec3 corrupted = vec3(fineY) + blockChroma;
    corrupted = floor(corrupted * 6.0) / 6.0;
    color = mix(color, corrupted, u_blockAmount);
  }

  // --- Halftone (overrides shading with dot pattern) ---
  if (u_halftoneOn > 0.5) {
    float ang = radians(u_halftoneAngle);
    vec2 fc = gl_FragCoord.xy;
    vec2 rot = vec2(
      cos(ang) * fc.x - sin(ang) * fc.y,
      sin(ang) * fc.x + cos(ang) * fc.y
    );
    float cell = max(u_halftoneSize, 2.0);
    vec2 cellUv = mod(rot, cell) - cell * 0.5;
    float dist = length(cellUv);
    float lum = dot(color, LUMA);
    float radius = (1.0 - lum) * cell * 0.72;
    float dotMask = 1.0 - smoothstep(radius - 1.2, radius + 1.2, dist);

    vec3 bg = u_duotoneOn > 0.5 ? u_duotoneHighlight : vec3(1.0);
    vec3 fg = u_duotoneOn > 0.5 ? u_duotoneShadow : vec3(0.0);
    color = mix(bg, fg, dotMask);
  }

  // --- Oscilloscope render: Sobel edge-detect, neon lines on black ---
  if (u_oscOn > 0.5) {
    vec2 t = 1.0 / u_resolution;
    float l00 = dot(texture(u_image, clamp(uv + vec2(-t.x, -t.y), 0.0, 1.0)).rgb, LUMA);
    float l10 = dot(texture(u_image, clamp(uv + vec2(0.0, -t.y), 0.0, 1.0)).rgb, LUMA);
    float l20 = dot(texture(u_image, clamp(uv + vec2(t.x, -t.y), 0.0, 1.0)).rgb, LUMA);
    float l01 = dot(texture(u_image, clamp(uv + vec2(-t.x, 0.0), 0.0, 1.0)).rgb, LUMA);
    float l21 = dot(texture(u_image, clamp(uv + vec2(t.x, 0.0), 0.0, 1.0)).rgb, LUMA);
    float l02 = dot(texture(u_image, clamp(uv + vec2(-t.x, t.y), 0.0, 1.0)).rgb, LUMA);
    float l12 = dot(texture(u_image, clamp(uv + vec2(0.0, t.y), 0.0, 1.0)).rgb, LUMA);
    float l22 = dot(texture(u_image, clamp(uv + vec2(t.x, t.y), 0.0, 1.0)).rgb, LUMA);
    float gx = -l00 - 2.0 * l01 - l02 + l20 + 2.0 * l21 + l22;
    float gy = -l00 - 2.0 * l10 - l20 + l02 + 2.0 * l12 + l22;
    float edge = sqrt(gx * gx + gy * gy);
    edge = smoothstep(0.0, max(1.0 - u_oscThickness, 0.02), edge);
    color = mix(vec3(0.0), u_oscColor, edge);
  }

  // --- Bloom / Glow (cheap multi-tap approximation) ---
  if (u_bloomOn > 0.5) {
    vec2 texel = 1.0 / u_resolution;
    vec3 bloom = vec3(0.0);
    float radii[2] = float[2](3.0, 7.0);
    for (int ring = 0; ring < 2; ring++) {
      float rad = radii[ring];
      for (int i = 0; i < 8; i++) {
        float ang = float(i) * (PI * 2.0 / 8.0);
        vec2 offset = vec2(cos(ang), sin(ang)) * rad * texel;
        vec3 s = texture(u_image, clamp(uv + offset, 0.0, 1.0)).rgb;
        float lum = dot(s, LUMA);
        float w = smoothstep(u_bloomThreshold, 1.0, lum);
        bloom += s * w;
      }
    }
    bloom /= 16.0;
    color += bloom * u_bloomAmount * 1.6;
  }

  // --- Deep Fryer: crunchy over-saturated meme compression ---
  if (u_deepFryOn > 0.5) {
    float amt = u_deepFryAmount;
    float lum = dot(color, LUMA);
    color = mix(vec3(lum), color, 1.0 + amt * 2.5);
    color = (color - 0.5) * (1.0 + amt * 1.5) + 0.5;
    color += vec3(0.09, 0.03, -0.06) * amt;
    vec3 blurSample = texture(u_image, uv + vec2(1.5, 1.5) / u_resolution).rgb;
    color += (color - blurSample) * amt * 1.3;
    float n = hash(gl_FragCoord.xy * 1.7 + fract(u_time) * 50.0) - 0.5;
    color += n * amt * 0.3;
  }

  // --- ASCII Art / terminal render (overrides shading with glyph atlas) ---
  if (u_asciiOn > 0.5) {
    float cell = max(u_asciiCellSize, 4.0);
    vec2 cellCoord = floor(gl_FragCoord.xy / cell);
    vec2 cellUv = (cellCoord + 0.5) * cell / u_resolution;
    vec3 cellColor = texture(u_image, clamp(cellUv, 0.0, 1.0)).rgb;
    float clum = dot(cellColor, LUMA);
    float charIndex = floor(clum * (u_asciiCount - 1.0) + 0.5);
    vec2 localUv = fract(gl_FragCoord.xy / cell);
    vec2 atlasUv = vec2((charIndex + localUv.x) / u_asciiCount, localUv.y);
    float glyph = texture(u_asciiAtlas, atlasUv).r;
    vec3 fg = u_asciiColorMode > 0.5 ? cellColor * 1.4 : u_asciiTermColor;
    color = mix(vec3(0.0), fg, glyph);
  }

  // --- Grain ---
  if (u_grainOn > 0.5) {
    float n = hash(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5;
    color += n * u_grainAmount * 0.35;
  }

  // --- Vignette (standalone) ---
  if (u_vignetteOn > 0.5) {
    vec2 cc = v_uv - 0.5;
    float d = length(cc) * 1.4;
    float v = smoothstep(0.8, 0.2, d);
    color *= mix(1.0 - u_vignetteAmount, 1.0, v);
  }

  // --- CRT scanlines + vignette + bezel ---
  if (u_crtOn > 0.5) {
    float scan = sin(uv.y * u_resolution.y * PI * 1.0) * 0.5 + 0.5;
    color *= mix(1.0, scan, u_crtScanline * 0.6);

    vec2 cc = v_uv - 0.5;
    float d = length(cc) * 1.4;
    float v = smoothstep(0.9, 0.25, d);
    color *= mix(1.0 - u_crtVignette, 1.0, v);
  }

  if (u_crtOn > 0.5 || u_fisheyeOn > 0.5) {
    color *= inBounds;
  }

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

const DATAMOSH_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_image;
uniform sampler2D u_prevFrame;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_amount;
uniform float u_driftSpeed;
uniform float u_keyframeRate;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = v_uv;
  float blockSize = 10.0;
  vec2 blockCoord = floor(gl_FragCoord.xy / blockSize);
  float t = floor(u_time * 10.0);
  float keySeed = hash(blockCoord + t * 0.37);

  float angle = hash(blockCoord * 1.3) * 6.2831853;
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 motion = dir * (u_driftSpeed * 0.004);

  vec3 freshColor = texture(u_image, uv).rgb;
  vec3 prevColor = texture(u_prevFrame, clamp(uv + motion, 0.0, 1.0)).rgb;

  float refresh = step(1.0 - u_keyframeRate, keySeed);
  vec3 predicted = mix(prevColor, freshColor, 0.04);
  vec3 result = mix(predicted, freshColor, refresh);
  result = mix(freshColor, result, u_amount);

  outColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}`;
