(async () => {
  const { Muxer, ArrayBufferTarget } = await import('./vendor/mp4-muxer.js');
  const FPS = 30;
  const ASPECTS = {
    '1:1': [1080, 1080],
    '4:3': [1440, 1080],
    '16:9': [1920, 1080],
    '9:16': [1080, 1920],
  };

  const EFFECT_GROUPS = [
    { toggle: 'pixelateOn', label: 'Pixelate', controls: [
      { id: 'pixelSize', label: 'Block size', type: 'range', min: 1, max: 40, step: 1, value: 1 },
    ] },
    { toggle: 'ditherOn', label: 'Dithering', controls: [
      { id: 'ditherLevels', label: 'Color levels', type: 'range', min: 2, max: 16, step: 1, value: 4 },
      { id: 'ditherAmount', label: 'Pattern strength', type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 },
      { id: 'ditherMono', label: 'Monochrome', type: 'checkbox-inline', value: false },
    ] },
    { toggle: 'crtOn', label: 'CRT', controls: [
      { id: 'crtScanline', label: 'Scanlines', type: 'range', min: 0, max: 1, step: 0.01, value: 0.4 },
      { id: 'crtCurvature', label: 'Screen curvature', type: 'range', min: 0, max: 1, step: 0.01, value: 0.25 },
      { id: 'crtShift', label: 'Color shift (RGB)', type: 'range', min: 0, max: 1, step: 0.01, value: 0.3 },
      { id: 'crtVignette', label: 'Vignette', type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 },
    ] },
    { toggle: 'vhsOn', label: 'VHS', controls: [
      { id: 'vhsJitter', label: 'Line jitter', type: 'range', min: 0, max: 1, step: 0.01, value: 0.35 },
      { id: 'vhsBleed', label: 'Color bleed', type: 'range', min: 0, max: 1, step: 0.01, value: 0.4 },
      { id: 'vhsTracking', label: 'Tracking band', type: 'range', min: 0, max: 1, step: 0.01, value: 0.3 },
      { id: 'vhsSaturation', label: 'Saturation', type: 'range', min: 0, max: 1, step: 0.01, value: 0.7 },
    ] },
    { toggle: 'glitchOn', label: 'Glitch (line shift)', controls: [
      { id: 'glitchAmount', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, value: 0.4 },
      { id: 'glitchBlock', label: 'Block size', type: 'range', min: 0.01, max: 0.3, step: 0.01, value: 0.08 },
    ] },
    { toggle: 'blockOn', label: 'Block Corruption (JPEG)', controls: [
      { id: 'blockAmount', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 },
      { id: 'blockSize', label: 'Macroblock size', type: 'range', min: 2, max: 40, step: 1, value: 12 },
    ] },
    { toggle: 'rgbSplitOn', label: 'RGB Split', controls: [
      { id: 'rgbSplitAmount', label: 'Channel offset', type: 'range', min: 0, max: 1, step: 0.01, value: 0.4 },
    ] },
    { toggle: 'posterizeOn', label: 'Posterize', controls: [
      { id: 'posterizeLevels', label: 'Color levels', type: 'range', min: 2, max: 16, step: 1, value: 4 },
    ] },
    { toggle: 'fisheyeOn', label: 'Fisheye / CCTV', controls: [
      { id: 'fisheyeAmount', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 },
    ] },
    { toggle: 'lightLeakOn', label: 'Light Leaks', controls: [
      { id: 'lightLeakAmount', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 },
    ] },
    { toggle: 'bloomOn', label: 'Bloom / Glow', controls: [
      { id: 'bloomThreshold', label: 'Brightness threshold', type: 'range', min: 0, max: 1, step: 0.01, value: 0.6 },
      { id: 'bloomAmount', label: 'Glow amount', type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 },
    ] },
    { toggle: 'oscOn', label: 'Oscilloscope', controls: [
      { id: 'oscThickness', label: 'Line thickness', type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 },
      { id: 'oscColor', label: 'Color', type: 'color', value: '#39ff6a' },
    ] },
    { toggle: 'halftoneOn', label: 'Halftone', controls: [
      { id: 'halftoneSize', label: 'Dot size', type: 'range', min: 2, max: 30, step: 1, value: 8 },
      { id: 'halftoneAngle', label: 'Angle', type: 'range', min: 0, max: 90, step: 1, value: 15 },
    ] },
    { toggle: 'duotoneOn', label: 'Duotone', controls: [
      { id: 'duotoneShadow', label: 'Shadow', type: 'color', value: '#1a0b2e' },
      { id: 'duotoneHighlight', label: 'Highlight', type: 'color', value: '#ff7ac6' },
      { id: 'duotoneMix', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, value: 1.0 },
    ] },
    { toggle: 'grainOn', label: 'Grain', controls: [
      { id: 'grainAmount', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, value: 0.25 },
    ] },
    { toggle: 'vignetteOn', label: 'Vignette (standalone)', controls: [
      { id: 'vignetteAmount', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, value: 0.4 },
    ] },
    { toggle: 'deepFryOn', label: 'Deep Fryer', controls: [
      { id: 'deepFryAmount', label: 'Fry amount', type: 'range', min: 0, max: 1, step: 0.01, value: 0.6 },
    ] },
    { toggle: 'asciiOn', label: 'ASCII Art', controls: [
      { id: 'asciiCellSize', label: 'Character size', type: 'range', min: 4, max: 24, step: 1, value: 9 },
      { id: 'asciiColorMode', label: 'Color (not terminal)', type: 'checkbox-inline', value: false },
      { id: 'asciiTermColor', label: 'Terminal color', type: 'color', value: '#39ff6a' },
    ] },
    { toggle: 'datamoshOn', label: 'Datamosh (I-frame destruction)', controls: [
      { id: 'datamoshAmount', label: 'Effect amount', type: 'range', min: 0, max: 1, step: 0.01, value: 0.75 },
      { id: 'datamoshDrift', label: 'Drift speed', type: 'range', min: 0, max: 1, step: 0.01, value: 0.4 },
      { id: 'datamoshKeyframe', label: 'Keyframe rate', type: 'range', min: 0, max: 0.3, step: 0.005, value: 0.02 },
    ] },
  ];

  const P = 'vfx_';

  function buildEffectsPanel(container) {
    for (const group of EFFECT_GROUPS) {
      const section = document.createElement('section');
      section.className = 'fx-group';

      const header = document.createElement('div');
      header.className = 'fx-header';
      const switchLabel = document.createElement('label');
      switchLabel.className = 'switch';
      const toggleInput = document.createElement('input');
      toggleInput.type = 'checkbox';
      toggleInput.id = P + group.toggle;
      const switchSpan = document.createElement('span');
      switchLabel.appendChild(toggleInput);
      switchLabel.appendChild(switchSpan);
      header.appendChild(switchLabel);
      const titleSpan = document.createElement('span');
      titleSpan.textContent = group.label;
      header.appendChild(titleSpan);
      section.appendChild(header);

      const controls = document.createElement('div');
      controls.className = 'fx-controls';
      for (const ctrl of group.controls) {
        const label = document.createElement('label');
        if (ctrl.type === 'checkbox-inline') {
          label.className = 'checkline';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.id = P + ctrl.id;
          label.appendChild(input);
          label.appendChild(document.createTextNode(' ' + ctrl.label));
        } else if (ctrl.type === 'color') {
          label.textContent = ctrl.label;
          const input = document.createElement('input');
          input.type = 'color';
          input.id = P + ctrl.id;
          input.value = ctrl.value;
          label.appendChild(input);
        } else {
          label.textContent = ctrl.label;
          const input = document.createElement('input');
          input.type = 'range';
          input.id = P + ctrl.id;
          input.min = ctrl.min;
          input.max = ctrl.max;
          input.step = ctrl.step;
          input.value = ctrl.value;
          label.appendChild(input);
        }
        controls.appendChild(label);
      }

      if (group.toggle === 'datamoshOn') {
        const resetBtn = document.createElement('button');
        resetBtn.id = 'vfxDatamoshResetBtn';
        resetBtn.className = 'btn small';
        resetBtn.textContent = 'Reset trail';
        controls.appendChild(resetBtn);
      }

      section.appendChild(controls);
      container.appendChild(section);
    }
  }

  const effectsContainer = document.getElementById('vfxEffectsContainer');
  buildEffectsPanel(effectsContainer);

  const canvas = document.getElementById('vfxCanvas');
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
  const statusEl = document.getElementById('vfxStatus');
  if (!gl) {
    statusEl.textContent = 'WebGL2 is not available in this browser.';
    return;
  }

  function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
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
      throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  const program = linkProgram(VERTEX_SRC, FRAGMENT_SRC);
  const datamoshProgram = linkProgram(VERTEX_SRC, DATAMOSH_SRC);
  gl.useProgram(program);

  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const videoTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
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

  // ---- ASCII font atlas ----
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

  // Flip uploaded video frames vertically. WebGL's texture origin is bottom-left
  // while <video> frames are top-left, so without this the preview/export comes
  // out upside down. Set after the ASCII atlas upload (which must stay unflipped)
  // so it only affects the per-frame video texture uploads below.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  // ---- Datamosh feedback framebuffers ----
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

  function seedDatamoshBuffers(sourceTex) {
    gl.useProgram(datamoshProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
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

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  const state = {
    aspect: '16:9',
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
    audioReactOn: false, audioSensitivity: 0.6,
  };

  for (const group of EFFECT_GROUPS) {
    const toggleEl = document.getElementById(P + group.toggle);
    toggleEl.checked = state[group.toggle];
    toggleEl.addEventListener('input', () => { state[group.toggle] = toggleEl.checked; });
    for (const ctrl of group.controls) {
      const el = document.getElementById(P + ctrl.id);
      if (ctrl.type === 'checkbox-inline') {
        el.checked = state[ctrl.id];
        el.addEventListener('input', () => { state[ctrl.id] = el.checked; });
      } else {
        el.value = state[ctrl.id];
        el.addEventListener('input', () => {
          state[ctrl.id] = ctrl.type === 'range' ? parseFloat(el.value) : el.value;
        });
      }
    }
  }

  document.getElementById('vfxDatamoshResetBtn').addEventListener('click', () => {
    datamoshSeeded = false;
  });

  const audioReactCheckbox = document.getElementById('vfxAudioReactOn');
  const audioSensitivityInput = document.getElementById('vfxAudioSensitivity');
  audioReactCheckbox.addEventListener('input', () => { state.audioReactOn = audioReactCheckbox.checked; });
  audioSensitivityInput.addEventListener('input', () => { state.audioSensitivity = parseFloat(audioSensitivityInput.value); });

  function applyAspect() {
    const [w, h] = ASPECTS[state.aspect];
    canvas.width = w;
    canvas.height = h;
    const wrap = document.getElementById('vfxCanvasWrap');
    const maxW = wrap.clientWidth - 40;
    const maxH = wrap.clientHeight - 40;
    const scale = Math.min(1, maxW / w, maxH / h);
    canvas.style.width = Math.round(w * scale) + 'px';
    canvas.style.height = Math.round(h * scale) + 'px';
    gl.viewport(0, 0, w, h);
    recreateDatamoshBuffers(w, h);
  }

  document.querySelectorAll('.vfx-aspect-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.aspect = btn.dataset.aspect;
      document.querySelectorAll('.vfx-aspect-btn').forEach((b) => b.classList.toggle('active', b === btn));
      applyAspect();
    });
  });
  document.querySelector('.vfx-aspect-btn[data-aspect="16:9"]').classList.add('active');
  applyAspect();

  function drawEffects(sourceTex, time, bass, mid, treble) {
    let mainTex = sourceTex;

    if (state.datamoshOn) {
      if (!datamoshSeeded) seedDatamoshBuffers(sourceTex);
      gl.useProgram(datamoshProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
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
      mainTex = fboTexA;
      gl.useProgram(program);
    } else {
      datamoshSeeded = false;
    }

    const sens = state.audioReactOn ? state.audioSensitivity : 0;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mainTex);
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
    gl.uniform1f(u('u_glitchAmount'), Math.min(1, state.glitchAmount + bass * sens));
    gl.uniform1f(u('u_glitchBlock'), state.glitchBlock);

    gl.uniform1f(u('u_blockOn'), state.blockOn ? 1 : 0);
    gl.uniform1f(u('u_blockAmount'), state.blockAmount);
    gl.uniform1f(u('u_blockSize'), state.blockSize);

    gl.uniform1f(u('u_rgbSplitOn'), state.rgbSplitOn ? 1 : 0);
    gl.uniform1f(u('u_rgbSplitAmount'), Math.min(1, state.rgbSplitAmount + treble * sens));

    gl.uniform1f(u('u_halftoneOn'), state.halftoneOn ? 1 : 0);
    gl.uniform1f(u('u_halftoneSize'), state.halftoneSize);
    gl.uniform1f(u('u_halftoneAngle'), state.halftoneAngle);

    gl.uniform1f(u('u_oscOn'), state.oscOn ? 1 : 0);
    gl.uniform1f(u('u_oscThickness'), state.oscThickness);
    gl.uniform3fv(u('u_oscColor'), hexToRgb(state.oscColor));

    gl.uniform1f(u('u_bloomOn'), state.bloomOn ? 1 : 0);
    gl.uniform1f(u('u_bloomThreshold'), state.bloomThreshold);
    gl.uniform1f(u('u_bloomAmount'), Math.min(1, state.bloomAmount + mid * sens));

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

    gl.viewport(0, 0, canvas.width, canvas.height);
    drawQuad();
  }

  // ---- Video loading ----
  const videoInput = document.getElementById('vfxVideoInput');
  const playBtn = document.getElementById('vfxPlayBtn');
  const pauseBtn = document.getElementById('vfxPauseBtn');
  const renderBtn = document.getElementById('vfxRenderBtn');
  const audioNote = document.getElementById('vfxAudioNote');
  const dropHint = document.getElementById('vfxDropHint');

  const videoEl = document.createElement('video');
  videoEl.playsInline = true;
  videoEl.crossOrigin = 'anonymous';

  const customAudioInput = document.getElementById('vfxCustomAudioInput');
  const removeCustomAudioBtn = document.getElementById('vfxRemoveCustomAudioBtn');
  const customAudioNote = document.getElementById('vfxCustomAudioNote');

  let hasVideo = false;
  let videoAudioBuffer = null;
  let customAudioBuffer = null;
  let audioCtx = null;
  let mediaSource = null;
  let liveAnalyser = null;
  let liveData = null;
  let videoGain = null;
  let customGain = null;
  let customSourceNode = null;
  let startTime = performance.now();

  function updateAudioReactAvailability() {
    const available = !!(videoAudioBuffer || customAudioBuffer);
    audioReactCheckbox.disabled = !available;
    if (!available) {
      audioReactCheckbox.checked = false;
      state.audioReactOn = false;
    }
  }

  async function loadVideoFile(file) {
    statusEl.textContent = 'Loading video...';
    videoEl.src = URL.createObjectURL(file);
    await new Promise((resolve) => { videoEl.onloadedmetadata = resolve; });
    hasVideo = true;
    dropHint.classList.add('hidden');
    playBtn.disabled = false;
    pauseBtn.disabled = false;
    renderBtn.disabled = false;
    statusEl.textContent = 'Loaded: ' + file.name + ' (' + videoEl.duration.toFixed(1) + 's, ' + videoEl.videoWidth + 'x' + videoEl.videoHeight + ')';

    audioNote.textContent = 'Checking for audio track...';
    try {
      videoAudioBuffer = await decodeAudioFile(file);
      audioNote.textContent = 'Audio track detected (' + videoAudioBuffer.duration.toFixed(1) + 's).';
    } catch (err) {
      videoAudioBuffer = null;
      audioNote.textContent = 'No audio track detected in this video.';
    }
    updateAudioReactAvailability();
  }

  videoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadVideoFile(file);
  });

  customAudioInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    customAudioNote.textContent = 'Decoding custom audio...';
    try {
      customAudioBuffer = await decodeAudioFile(file);
      removeCustomAudioBtn.disabled = false;
      customAudioNote.textContent = 'Custom audio loaded: ' + file.name + ' (' + customAudioBuffer.duration.toFixed(1) + 's) - replaces original audio in the export.';
      if (audioCtx) { videoGain.gain.value = 0; }
      videoEl.muted = true;
    } catch (err) {
      customAudioBuffer = null;
      customAudioNote.textContent = 'Could not decode that audio file.';
    }
    updateAudioReactAvailability();
  });

  removeCustomAudioBtn.addEventListener('click', () => {
    customAudioBuffer = null;
    stopCustomAudioPlayback();
    removeCustomAudioBtn.disabled = true;
    customAudioNote.textContent = 'None loaded - export keeps the video\'s own audio.';
    if (audioCtx) { videoGain.gain.value = 1; }
    videoEl.muted = false;
    updateAudioReactAvailability();
  });

  const wrap = document.getElementById('vfxCanvasWrap');
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) loadVideoFile(file);
  });

  function ensureAudioGraph() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      mediaSource = audioCtx.createMediaElementSource(videoEl);
      liveAnalyser = audioCtx.createAnalyser();
      liveAnalyser.fftSize = 512;
      liveData = new Uint8Array(liveAnalyser.frequencyBinCount);
      videoGain = audioCtx.createGain();
      customGain = audioCtx.createGain();
      mediaSource.connect(videoGain);
      videoGain.connect(liveAnalyser);
      videoGain.connect(audioCtx.destination);
      customGain.connect(liveAnalyser);
      customGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    videoGain.gain.value = customAudioBuffer ? 0 : 1;
  }

  function startCustomAudioPlayback() {
    if (!customAudioBuffer || !audioCtx) return;
    stopCustomAudioPlayback();
    customSourceNode = audioCtx.createBufferSource();
    customSourceNode.buffer = customAudioBuffer;
    customSourceNode.connect(customGain);
    const offset = Math.min(videoEl.currentTime, Math.max(customAudioBuffer.duration - 0.01, 0));
    customSourceNode.start(0, offset);
  }

  function stopCustomAudioPlayback() {
    if (customSourceNode) {
      try { customSourceNode.stop(); } catch (e) { /* already stopped */ }
      customSourceNode = null;
    }
  }

  playBtn.addEventListener('click', () => {
    if (!hasVideo) return;
    ensureAudioGraph();
    if (customAudioBuffer) startCustomAudioPlayback();
    videoEl.muted = !!customAudioBuffer;
    videoEl.play();
  });
  pauseBtn.addEventListener('click', () => {
    videoEl.pause();
    stopCustomAudioPlayback();
  });
  videoEl.addEventListener('ended', () => {
    stopCustomAudioPlayback();
  });

  function previewLoop() {
    const time = (performance.now() - startTime) / 1000;
    if (hasVideo && videoEl.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);

      let bass = 0, mid = 0, treble = 0;
      if (state.audioReactOn && liveAnalyser && !videoEl.paused) {
        liveAnalyser.getByteFrequencyData(liveData);
        const b = bandsFromFreqData(liveData);
        bass = b.bass; mid = b.mid; treble = b.treble;
      }
      drawEffects(videoTexture, time, bass, mid, treble);
    }
    requestAnimationFrame(previewLoop);
  }
  requestAnimationFrame(previewLoop);
  window.addEventListener('resize', applyAspect);

  // ---- Render & export ----
  function seekTo(video, t) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      const onSeeked = () => finish();
      video.addEventListener('seeked', onSeeked);
      video.currentTime = t;
      setTimeout(finish, 800);
    });
  }

  renderBtn.addEventListener('click', async () => {
    if (!hasVideo) return;
    if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
      statusEl.textContent = 'WebCodecs is unavailable. Requires Chrome/Edge over HTTPS (or localhost).';
      return;
    }

    videoEl.pause();
    renderBtn.disabled = true;
    videoInput.disabled = true;

    const [width, height] = ASPECTS[state.aspect];
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    recreateDatamoshBuffers(width, height);

    const duration = videoEl.duration;
    const frameCount = Math.ceil(duration * FPS);
    const exportAudioBuffer = customAudioBuffer || videoAudioBuffer;

    let bands = null;
    if (state.audioReactOn && exportAudioBuffer) {
      statusEl.textContent = 'Analyzing audio...';
      bands = await analyzeAudioOffline(exportAudioBuffer, FPS);
    }

    const videoCodec = await pickVideoCodec(width, height, FPS);
    const audioCodec = exportAudioBuffer
      ? await pickAudioCodec(exportAudioBuffer.sampleRate, exportAudioBuffer.numberOfChannels)
      : null;
    if (!videoCodec || (exportAudioBuffer && !audioCodec)) {
      statusEl.textContent = 'No supported codec found on this browser/GPU.';
      renderBtn.disabled = false;
      videoInput.disabled = false;
      return;
    }

    const muxerConfig = {
      target: new ArrayBufferTarget(),
      video: { codec: videoCodec.startsWith('vp09') ? 'vp9' : 'avc', width, height },
      fastStart: 'in-memory',
    };
    if (exportAudioBuffer) {
      muxerConfig.audio = {
        codec: audioCodec === 'opus' ? 'opus' : 'aac',
        numberOfChannels: exportAudioBuffer.numberOfChannels,
        sampleRate: exportAudioBuffer.sampleRate,
      };
    }
    const muxer = new Muxer(muxerConfig);

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { console.error(e); statusEl.textContent = 'Video encode error: ' + e.message; },
    });
    videoEncoder.configure({ codec: videoCodec, width, height, bitrate: 8_000_000, framerate: FPS });

    let audioEncoder = null;
    if (exportAudioBuffer) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => { console.error(e); statusEl.textContent = 'Audio encode error: ' + e.message; },
      });
      audioEncoder.configure({
        codec: audioCodec,
        sampleRate: exportAudioBuffer.sampleRate,
        numberOfChannels: exportAudioBuffer.numberOfChannels,
        bitrate: 128_000,
      });
    }

    for (let i = 0; i < frameCount; i++) {
      const t = Math.min(i / FPS, Math.max(duration - 0.01, 0));
      await seekTo(videoEl, t);

      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);

      const b = bands ? bands[i] : { bass: 0, mid: 0, treble: 0 };
      drawEffects(videoTexture, t, b.bass, b.mid, b.treble);

      const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6) });
      await encodeQueueWait(videoEncoder);
      videoEncoder.encode(frame, { keyFrame: i % 150 === 0 });
      frame.close();

      if (i % 10 === 0) {
        statusEl.textContent = 'Rendering frame ' + i + ' / ' + frameCount + '...';
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (exportAudioBuffer && audioEncoder) {
      statusEl.textContent = 'Encoding audio track...';
      await encodeAudioBuffer(audioEncoder, exportAudioBuffer);
    }

    statusEl.textContent = 'Finalizing MP4...';
    await videoEncoder.flush();
    if (audioEncoder) await audioEncoder.flush();
    const filename = muxDownload(muxer, 'video-effects');

    statusEl.textContent = 'Done - ' + filename + ' downloaded.';
    renderBtn.disabled = false;
    videoInput.disabled = false;
  });
})();
