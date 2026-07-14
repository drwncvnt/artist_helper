(() => {
  const canvas = document.getElementById('glcanvas');
  const sortCanvas = document.getElementById('sortcanvas');
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) {
    alert('Your browser does not support WebGL2. Please update Chrome/Firefox.');
    throw new Error('no webgl2');
  }

  function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(sh));
      throw new Error('Shader compile error: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function linkProgram(vertSrc, fragSrc) {
    const v = compileShader(gl.VERTEX_SHADER, vertSrc);
    const f = compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(p));
      throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  const program = linkProgram(VERTEX_SRC, FRAGMENT_SRC);
  const datamoshProgram = linkProgram(VERTEX_SRC, DATAMOSH_SRC);
  gl.useProgram(program);

  // fullscreen quad (shared by both programs via attrib location 0)
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const uniforms = {};
  function u(name) {
    if (!(name in uniforms)) uniforms[name] = gl.getUniformLocation(program, name);
    return uniforms[name];
  }

  const dmUniforms = {};
  function dmu(name) {
    if (!(name in dmUniforms)) dmUniforms[name] = gl.getUniformLocation(datamoshProgram, name);
    return dmUniforms[name];
  }

  // ---- ASCII font atlas (generated on a 2D canvas, uploaded as texture unit 1) ----
  const ASCII_CHARS = ' .:-=+*#%@';
  const asciiCellPx = 32;
  const asciiAtlasCanvas = document.createElement('canvas');
  asciiAtlasCanvas.width = ASCII_CHARS.length * asciiCellPx;
  asciiAtlasCanvas.height = asciiCellPx;
  const actx = asciiAtlasCanvas.getContext('2d');
  actx.fillStyle = '#000';
  actx.fillRect(0, 0, asciiAtlasCanvas.width, asciiAtlasCanvas.height);
  actx.fillStyle = '#fff';
  actx.font = `bold ${Math.floor(asciiCellPx * 0.85)}px monospace`;
  actx.textAlign = 'center';
  actx.textBaseline = 'middle';
  for (let i = 0; i < ASCII_CHARS.length; i++) {
    actx.fillText(ASCII_CHARS[i], i * asciiCellPx + asciiCellPx / 2, asciiCellPx / 2 + 2);
  }
  const asciiTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, asciiTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, asciiAtlasCanvas);
  gl.activeTexture(gl.TEXTURE0);

  // ---- Datamosh feedback framebuffers (ping-pong) ----
  let fboA = null, fboB = null, fboTexA = null, fboTexB = null;
  let datamoshSeeded = false;

  function makeFbo(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  function recreateDatamoshBuffers(w, h) {
    const a = makeFbo(w, h);
    const b = makeFbo(w, h);
    fboA = a.fbo; fboTexA = a.tex;
    fboB = b.fbo; fboTexB = b.tex;
    datamoshSeeded = false;
  }

  function drawQuad() {
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function seedDatamoshBuffers() {
    gl.useProgram(datamoshProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(dmu('u_image'), 0);
    gl.uniform1i(dmu('u_prevFrame'), 0);
    gl.uniform1f(dmu('u_amount'), 0.0);
    gl.uniform1f(dmu('u_driftSpeed'), 0.0);
    gl.uniform1f(dmu('u_keyframeRate'), 1.0);
    gl.uniform1f(dmu('u_time'), 0.0);
    gl.uniform2f(dmu('u_resolution'), canvas.width, canvas.height);
    [fboA, fboB].forEach((fbo) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, canvas.width, canvas.height);
      drawQuad();
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(program);
    datamoshSeeded = true;
  }

  const state = {
    pixelateOn: false, pixelSize: 1,
    ditherOn: false, ditherLevels: 4, ditherAmount: 0.5, ditherMono: false,
    posterizeOn: false, posterizeLevels: 4,
    crtOn: false, crtScanline: 0.4, crtCurvature: 0.25, crtShift: 0.3, crtVignette: 0.5,
    fisheyeOn: false, fisheyeAmount: 0.5,
    vhsOn: false, vhsJitter: 0.35, vhsBleed: 0.4, vhsTracking: 0.3, vhsSaturation: 0.7,
    glitchOn: false, glitchAmount: 0.4, glitchBlock: 0.08,
    blockOn: false, blockAmount: 0.5, blockSize: 12,
    rgbSplitOn: false, rgbSplitAmount: 0.4,
    halftoneOn: false, halftoneSize: 8, halftoneAngle: 15,
    oscOn: false, oscThickness: 0.5, oscColor: '#39ff6a',
    bloomOn: false, bloomThreshold: 0.6, bloomAmount: 0.5,
    lightLeakOn: false, lightLeakAmount: 0.5,
    deepFryOn: false, deepFryAmount: 0.6,
    asciiOn: false, asciiCellSize: 9, asciiColorMode: false, asciiTermColor: '#39ff6a',
    datamoshOn: false, datamoshAmount: 0.75, datamoshDrift: 0.4, datamoshKeyframe: 0.02,
    duotoneOn: false, duotoneShadow: '#1a0b2e', duotoneHighlight: '#ff7ac6', duotoneMix: 1.0,
    grainOn: false, grainAmount: 0.25,
    vignetteOn: false, vignetteAmount: 0.4,
  };

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  let imgWidth = 1280, imgHeight = 800;
  let startTime = performance.now();
  let hasImage = false;

  function resizeCanvasToImage() {
    const wrap = document.getElementById('canvasWrap');
    const maxW = wrap.clientWidth - 40;
    const maxH = wrap.clientHeight - 40;
    const scale = Math.min(1, maxW / imgWidth, maxH / imgHeight);
    const cssW = Math.round(imgWidth * scale) + 'px';
    const cssH = Math.round(imgHeight * scale) + 'px';
    canvas.style.width = cssW;
    canvas.style.height = cssH;
    canvas.width = imgWidth;
    canvas.height = imgHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);

    sortCanvas.style.width = cssW;
    sortCanvas.style.height = cssH;
    sortCanvas.width = imgWidth;
    sortCanvas.height = imgHeight;

    recreateDatamoshBuffers(imgWidth, imgHeight);
  }

  function render() {
    const time = (performance.now() - startTime) / 1000;
    gl.clearColor(0.05, 0.04, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (hasImage) {
      // --- Datamosh feedback pre-pass: writes into fboB using fboA as previous frame ---
      let mainImageTexture = texture;
      if (state.datamoshOn) {
        if (!datamoshSeeded) seedDatamoshBuffers();
        gl.useProgram(datamoshProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(dmu('u_image'), 0);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, fboTexA);
        gl.uniform1i(dmu('u_prevFrame'), 2);
        gl.uniform2f(dmu('u_resolution'), canvas.width, canvas.height);
        gl.uniform1f(dmu('u_time'), time);
        gl.uniform1f(dmu('u_amount'), state.datamoshAmount);
        gl.uniform1f(dmu('u_driftSpeed'), state.datamoshDrift);
        gl.uniform1f(dmu('u_keyframeRate'), state.datamoshKeyframe);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
        gl.viewport(0, 0, canvas.width, canvas.height);
        drawQuad();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        const tmpFbo = fboA; fboA = fboB; fboB = tmpFbo;
        const tmpTex = fboTexA; fboTexA = fboTexB; fboTexB = tmpTex;
        mainImageTexture = fboTexA;
        gl.useProgram(program);
      } else {
        datamoshSeeded = false;
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, mainImageTexture);
      gl.uniform1i(u('u_image'), 0);
      gl.uniform1i(u('u_asciiAtlas'), 1);

      gl.uniform2f(u('u_resolution'), canvas.width, canvas.height);
      gl.uniform1f(u('u_time'), time);

      gl.uniform1f(u('u_pixelateOn'), state.pixelateOn ? 1 : 0);
      gl.uniform1f(u('u_pixelSize'), state.pixelSize);

      gl.uniform1f(u('u_ditherOn'), state.ditherOn ? 1 : 0);
      gl.uniform1f(u('u_ditherLevels'), state.ditherLevels);
      gl.uniform1f(u('u_ditherAmount'), state.ditherAmount);
      gl.uniform1f(u('u_ditherMono'), state.ditherMono ? 1 : 0);

      gl.uniform1f(u('u_posterizeOn'), state.posterizeOn ? 1 : 0);
      gl.uniform1f(u('u_posterizeLevels'), state.posterizeLevels);

      gl.uniform1f(u('u_crtOn'), state.crtOn ? 1 : 0);
      gl.uniform1f(u('u_crtScanline'), state.crtScanline);
      gl.uniform1f(u('u_crtCurvature'), state.crtCurvature);
      gl.uniform1f(u('u_crtShift'), state.crtShift);
      gl.uniform1f(u('u_crtVignette'), state.crtVignette);

      gl.uniform1f(u('u_fisheyeOn'), state.fisheyeOn ? 1 : 0);
      gl.uniform1f(u('u_fisheyeAmount'), state.fisheyeAmount);

      gl.uniform1f(u('u_vhsOn'), state.vhsOn ? 1 : 0);
      gl.uniform1f(u('u_vhsJitter'), state.vhsJitter);
      gl.uniform1f(u('u_vhsBleed'), state.vhsBleed);
      gl.uniform1f(u('u_vhsTracking'), state.vhsTracking);
      gl.uniform1f(u('u_vhsSaturation'), state.vhsSaturation);

      gl.uniform1f(u('u_glitchOn'), state.glitchOn ? 1 : 0);
      gl.uniform1f(u('u_glitchAmount'), state.glitchAmount);
      gl.uniform1f(u('u_glitchBlock'), state.glitchBlock);

      gl.uniform1f(u('u_blockOn'), state.blockOn ? 1 : 0);
      gl.uniform1f(u('u_blockAmount'), state.blockAmount);
      gl.uniform1f(u('u_blockSize'), state.blockSize);

      gl.uniform1f(u('u_rgbSplitOn'), state.rgbSplitOn ? 1 : 0);
      gl.uniform1f(u('u_rgbSplitAmount'), state.rgbSplitAmount);

      gl.uniform1f(u('u_halftoneOn'), state.halftoneOn ? 1 : 0);
      gl.uniform1f(u('u_halftoneSize'), state.halftoneSize);
      gl.uniform1f(u('u_halftoneAngle'), state.halftoneAngle);

      gl.uniform1f(u('u_oscOn'), state.oscOn ? 1 : 0);
      gl.uniform1f(u('u_oscThickness'), state.oscThickness);
      gl.uniform3fv(u('u_oscColor'), hexToRgb(state.oscColor));

      gl.uniform1f(u('u_bloomOn'), state.bloomOn ? 1 : 0);
      gl.uniform1f(u('u_bloomThreshold'), state.bloomThreshold);
      gl.uniform1f(u('u_bloomAmount'), state.bloomAmount);

      gl.uniform1f(u('u_lightLeakOn'), state.lightLeakOn ? 1 : 0);
      gl.uniform1f(u('u_lightLeakAmount'), state.lightLeakAmount);

      gl.uniform1f(u('u_deepFryOn'), state.deepFryOn ? 1 : 0);
      gl.uniform1f(u('u_deepFryAmount'), state.deepFryAmount);

      gl.uniform1f(u('u_asciiOn'), state.asciiOn ? 1 : 0);
      gl.uniform1f(u('u_asciiCellSize'), state.asciiCellSize);
      gl.uniform1f(u('u_asciiCount'), ASCII_CHARS.length);
      gl.uniform1f(u('u_asciiColorMode'), state.asciiColorMode ? 1 : 0);
      gl.uniform3fv(u('u_asciiTermColor'), hexToRgb(state.asciiTermColor));

      gl.uniform1f(u('u_duotoneOn'), state.duotoneOn ? 1 : 0);
      gl.uniform3fv(u('u_duotoneShadow'), hexToRgb(state.duotoneShadow));
      gl.uniform3fv(u('u_duotoneHighlight'), hexToRgb(state.duotoneHighlight));
      gl.uniform1f(u('u_duotoneMix'), state.duotoneMix);

      gl.uniform1f(u('u_grainOn'), state.grainOn ? 1 : 0);
      gl.uniform1f(u('u_grainAmount'), state.grainAmount);

      gl.uniform1f(u('u_vignetteOn'), state.vignetteOn ? 1 : 0);
      gl.uniform1f(u('u_vignetteAmount'), state.vignetteAmount);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    requestAnimationFrame(render);
  }

  function loadImage(file) {
    const img = new Image();
    img.onload = () => {
      imgWidth = img.naturalWidth;
      imgHeight = img.naturalHeight;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      resizeCanvasToImage();
      hasImage = true;
      document.getElementById('dropHint').classList.add('hidden');
      sortCanvas.classList.add('hidden');
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  }

  // ---- UI binding ----
  const bindings = [
    ['pixelateOn', 'pixelateOn', 'checked'],
    ['pixelSize', 'pixelSize', 'value:number'],
    ['ditherOn', 'ditherOn', 'checked'],
    ['ditherLevels', 'ditherLevels', 'value:number'],
    ['ditherAmount', 'ditherAmount', 'value:number'],
    ['ditherMono', 'ditherMono', 'checked'],
    ['posterizeOn', 'posterizeOn', 'checked'],
    ['posterizeLevels', 'posterizeLevels', 'value:number'],
    ['crtOn', 'crtOn', 'checked'],
    ['crtScanline', 'crtScanline', 'value:number'],
    ['crtCurvature', 'crtCurvature', 'value:number'],
    ['crtShift', 'crtShift', 'value:number'],
    ['crtVignette', 'crtVignette', 'value:number'],
    ['fisheyeOn', 'fisheyeOn', 'checked'],
    ['fisheyeAmount', 'fisheyeAmount', 'value:number'],
    ['vhsOn', 'vhsOn', 'checked'],
    ['vhsJitter', 'vhsJitter', 'value:number'],
    ['vhsBleed', 'vhsBleed', 'value:number'],
    ['vhsTracking', 'vhsTracking', 'value:number'],
    ['vhsSaturation', 'vhsSaturation', 'value:number'],
    ['glitchOn', 'glitchOn', 'checked'],
    ['glitchAmount', 'glitchAmount', 'value:number'],
    ['glitchBlock', 'glitchBlock', 'value:number'],
    ['blockOn', 'blockOn', 'checked'],
    ['blockAmount', 'blockAmount', 'value:number'],
    ['blockSize', 'blockSize', 'value:number'],
    ['rgbSplitOn', 'rgbSplitOn', 'checked'],
    ['rgbSplitAmount', 'rgbSplitAmount', 'value:number'],
    ['halftoneOn', 'halftoneOn', 'checked'],
    ['halftoneSize', 'halftoneSize', 'value:number'],
    ['halftoneAngle', 'halftoneAngle', 'value:number'],
    ['oscOn', 'oscOn', 'checked'],
    ['oscThickness', 'oscThickness', 'value:number'],
    ['oscColor', 'oscColor', 'value:string'],
    ['bloomOn', 'bloomOn', 'checked'],
    ['bloomThreshold', 'bloomThreshold', 'value:number'],
    ['bloomAmount', 'bloomAmount', 'value:number'],
    ['lightLeakOn', 'lightLeakOn', 'checked'],
    ['lightLeakAmount', 'lightLeakAmount', 'value:number'],
    ['deepFryOn', 'deepFryOn', 'checked'],
    ['deepFryAmount', 'deepFryAmount', 'value:number'],
    ['asciiOn', 'asciiOn', 'checked'],
    ['asciiCellSize', 'asciiCellSize', 'value:number'],
    ['asciiColorMode', 'asciiColorMode', 'checked'],
    ['asciiTermColor', 'asciiTermColor', 'value:string'],
    ['datamoshOn', 'datamoshOn', 'checked'],
    ['datamoshAmount', 'datamoshAmount', 'value:number'],
    ['datamoshDrift', 'datamoshDrift', 'value:number'],
    ['datamoshKeyframe', 'datamoshKeyframe', 'value:number'],
    ['duotoneOn', 'duotoneOn', 'checked'],
    ['duotoneShadow', 'duotoneShadow', 'value:string'],
    ['duotoneHighlight', 'duotoneHighlight', 'value:string'],
    ['duotoneMix', 'duotoneMix', 'value:number'],
    ['grainOn', 'grainOn', 'checked'],
    ['grainAmount', 'grainAmount', 'value:number'],
    ['vignetteOn', 'vignetteOn', 'checked'],
    ['vignetteAmount', 'vignetteAmount', 'value:number'],
  ];

  function syncUiFromState() {
    for (const [elId, key, mode] of bindings) {
      const el = document.getElementById(elId);
      if (!el) continue;
      if (mode === 'checked') el.checked = state[key];
      else el.value = state[key];
    }
  }

  for (const [elId, key, mode] of bindings) {
    const el = document.getElementById(elId);
    if (!el) continue;
    el.addEventListener('input', () => {
      if (mode === 'checked') state[key] = el.checked;
      else if (mode === 'value:number') state[key] = parseFloat(el.value);
      else state[key] = el.value;
    });
  }

  // ---- file input / drag&drop ----
  const fileInput = document.getElementById('fileInput');
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadImage(e.target.files[0]);
  });

  const wrap = document.getElementById('canvasWrap');
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.style.outline = '2px dashed #ff5fb4'; });
  wrap.addEventListener('dragleave', () => { wrap.style.outline = 'none'; });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.style.outline = 'none';
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) loadImage(file);
  });

  window.addEventListener('paste', (e) => {
    const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
    if (item) loadImage(item.getAsFile());
  });

  // ---- presets ----
  const TOGGLE_KEYS = [
    'pixelateOn', 'ditherOn', 'posterizeOn', 'crtOn', 'fisheyeOn', 'vhsOn',
    'glitchOn', 'blockOn', 'rgbSplitOn', 'halftoneOn', 'oscOn', 'bloomOn',
    'lightLeakOn', 'deepFryOn', 'asciiOn', 'datamoshOn',
    'duotoneOn', 'grainOn', 'vignetteOn',
  ];

  const PRESETS = {
    vhs: {
      vhsOn: true, vhsJitter: 0.45, vhsBleed: 0.55, vhsTracking: 0.35, vhsSaturation: 0.6,
      grainOn: true, grainAmount: 0.3,
      vignetteOn: true, vignetteAmount: 0.35,
    },
    crt: {
      crtOn: true, crtScanline: 0.5, crtCurvature: 0.35, crtShift: 0.4, crtVignette: 0.55,
      grainOn: true, grainAmount: 0.12,
    },
    gameboy: {
      pixelateOn: true, pixelSize: 4,
      ditherOn: true, ditherLevels: 4, ditherAmount: 0.9, ditherMono: false,
      duotoneOn: true, duotoneShadow: '#0f380f', duotoneHighlight: '#9bbc0f', duotoneMix: 0.85,
    },
    glitch: {
      vhsOn: true, vhsJitter: 0.2, vhsBleed: 0.3, vhsTracking: 0.1, vhsSaturation: 0.9,
      glitchOn: true, glitchAmount: 0.55, glitchBlock: 0.05,
      blockOn: true, blockAmount: 0.35, blockSize: 14,
      rgbSplitOn: true, rgbSplitAmount: 0.3,
      grainOn: true, grainAmount: 0.2,
    },
    halftone: {
      halftoneOn: true, halftoneSize: 7, halftoneAngle: 15,
      duotoneOn: true, duotoneShadow: '#101010', duotoneHighlight: '#f5efe6', duotoneMix: 1.0,
    },
    cctv: {
      fisheyeOn: true, fisheyeAmount: 0.7,
      blockOn: true, blockAmount: 0.25, blockSize: 16,
      duotoneOn: true, duotoneShadow: '#001a00', duotoneHighlight: '#bfffcf', duotoneMix: 0.35,
      grainOn: true, grainAmount: 0.3,
      vignetteOn: true, vignetteAmount: 0.6,
    },
    oscilloscope: {
      oscOn: true, oscThickness: 0.55, oscColor: '#39ff6a',
    },
    deepfry: {
      deepFryOn: true, deepFryAmount: 0.75,
      duotoneOn: false,
      grainOn: true, grainAmount: 0.2,
    },
    ascii: {
      asciiOn: true, asciiCellSize: 9, asciiColorMode: false, asciiTermColor: '#39ff6a',
    },
    datamosh: {
      datamoshOn: true, datamoshAmount: 0.8, datamoshDrift: 0.5, datamoshKeyframe: 0.015,
      rgbSplitOn: true, rgbSplitAmount: 0.15,
    },
    clean: {},
  };

  function applyPreset(preset) {
    TOGGLE_KEYS.forEach((k) => { state[k] = false; });
    Object.assign(state, preset);
    syncUiFromState();
  }

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyPreset(PRESETS[btn.dataset.preset]);
    });
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    applyPreset(PRESETS.clean);
  });

  const JITTER_EXCLUDE = new Set([
    'ditherLevels', 'posterizeLevels', 'pixelSize', 'blockSize',
    'halftoneSize', 'halftoneAngle', 'glitchBlock', 'asciiCellSize',
  ]);

  document.getElementById('randomizeBtn').addEventListener('click', () => {
    startTime = performance.now() - Math.random() * 1000;
    const keys = Object.keys(PRESETS).filter((k) => k !== 'clean');
    const pick = keys[Math.floor(Math.random() * keys.length)];
    applyPreset(PRESETS[pick]);
    // add some jitter to numeric params for variety
    for (const k in state) {
      if (typeof state[k] === 'number' && !JITTER_EXCLUDE.has(k)) {
        state[k] = Math.min(1, Math.max(0, state[k] + (Math.random() - 0.5) * 0.15));
      }
    }
    syncUiFromState();
  });

  document.getElementById('downloadBtn').addEventListener('click', () => {
    if (!hasImage) return;
    const sourceCanvas = sortCanvas.classList.contains('hidden') ? canvas : sortCanvas;
    sourceCanvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'retrofx-' + Date.now() + '.png';
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  });

  // ---- Datamosh: clear feedback trail ----
  document.getElementById('datamoshResetBtn').addEventListener('click', () => {
    datamoshSeeded = false;
  });

  // ---- Pixel Sorting (one-shot JS pass over the current rendered frame) ----
  function luminance(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  function sortSegment(data, indices, order) {
    const px = indices.map((i) => ({
      r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3],
      lum: luminance(data[i], data[i + 1], data[i + 2]),
    }));
    px.sort((a, b) => (order === 'asc' ? a.lum - b.lum : b.lum - a.lum));
    indices.forEach((i, k) => {
      data[i] = px[k].r; data[i + 1] = px[k].g; data[i + 2] = px[k].b; data[i + 3] = px[k].a;
    });
  }

  function applyPixelSort() {
    if (!hasImage) return;
    const w = canvas.width, h = canvas.height;
    sortCanvas.width = w;
    sortCanvas.height = h;
    const sctx = sortCanvas.getContext('2d');
    sctx.drawImage(canvas, 0, 0, w, h);
    const imgData = sctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const threshold = parseFloat(document.getElementById('sortThreshold').value);
    const mode = document.getElementById('sortMode').value;
    const direction = document.getElementById('sortDirection').value;
    const passesMask = (i) => {
      const lum = luminance(data[i], data[i + 1], data[i + 2]) / 255;
      return mode === 'above' ? lum > threshold : lum < threshold;
    };

    if (direction === 'horizontal') {
      for (let y = 0; y < h; y++) {
        let x = 0;
        while (x < w) {
          const i0 = (y * w + x) * 4;
          if (passesMask(i0)) {
            const run = [];
            let xx = x;
            while (xx < w && passesMask((y * w + xx) * 4)) {
              run.push((y * w + xx) * 4);
              xx++;
            }
            sortSegment(data, run, 'desc');
            x = xx;
          } else {
            x++;
          }
        }
      }
    } else {
      for (let x = 0; x < w; x++) {
        let y = 0;
        while (y < h) {
          const i0 = (y * w + x) * 4;
          if (passesMask(i0)) {
            const run = [];
            let yy = y;
            while (yy < h && passesMask((yy * w + x) * 4)) {
              run.push((yy * w + x) * 4);
              yy++;
            }
            sortSegment(data, run, 'desc');
            y = yy;
          } else {
            y++;
          }
        }
      }
    }

    sctx.putImageData(imgData, 0, 0);
    sortCanvas.classList.remove('hidden');
  }

  document.getElementById('sortApplyBtn').addEventListener('click', applyPixelSort);
  document.getElementById('sortClearBtn').addEventListener('click', () => {
    sortCanvas.classList.add('hidden');
  });

  window.addEventListener('resize', () => { if (hasImage) resizeCanvasToImage(); });

  syncUiFromState();
  requestAnimationFrame(render);
})();
