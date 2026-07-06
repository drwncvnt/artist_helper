(async () => {
  const { Muxer, ArrayBufferTarget } = await import('./vendor/mp4-muxer.js');
  const FPS = 30;
  const ASPECTS = {
    '1:1': [1080, 1080],
    '4:3': [1440, 1080],
    '16:9': [1920, 1080],
    '9:16': [1080, 1920],
  };

  const canvas = document.getElementById('videoCanvas');
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) {
    document.getElementById('videoStatus').textContent = 'WebGL2 is not available in this browser.';
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

  const vs = compileShader(gl.VERTEX_SHADER, VIDEO_VERTEX_SRC);
  const fs = compileShader(gl.FRAGMENT_SHADER, VIDEO_FRAGMENT_SRC);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const uniforms = {};
  function u(name) {
    if (!(name in uniforms)) uniforms[name] = gl.getUniformLocation(program, name);
    return uniforms[name];
  }

  const state = {
    aspect: '16:9',
    particlesOn: true,
    glowOn: true,
    colorCycleOn: true,
    scanlinesOn: true,
  };

  function drawFrame(time, bass, mid, treble) {
    gl.uniform2f(u('u_resolution'), canvas.width, canvas.height);
    gl.uniform1f(u('u_time'), time);
    gl.uniform1f(u('u_bass'), bass);
    gl.uniform1f(u('u_mid'), mid);
    gl.uniform1f(u('u_treble'), treble);
    gl.uniform1f(u('u_particlesOn'), state.particlesOn ? 1 : 0);
    gl.uniform1f(u('u_glowOn'), state.glowOn ? 1 : 0);
    gl.uniform1f(u('u_colorCycleOn'), state.colorCycleOn ? 1 : 0);
    gl.uniform1f(u('u_scanlinesOn'), state.scanlinesOn ? 1 : 0);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function applyAspect() {
    const [w, h] = ASPECTS[state.aspect];
    canvas.width = w;
    canvas.height = h;
    const wrap = document.getElementById('videoCanvasWrap');
    const maxW = wrap.clientWidth - 40;
    const maxH = wrap.clientHeight - 40;
    const scale = Math.min(1, maxW / w, maxH / h);
    canvas.style.width = Math.round(w * scale) + 'px';
    canvas.style.height = Math.round(h * scale) + 'px';
    gl.viewport(0, 0, w, h);
  }

  document.querySelectorAll('.aspect-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.aspect = btn.dataset.aspect;
      document.querySelectorAll('.aspect-btn').forEach((b) => b.classList.toggle('active', b === btn));
      applyAspect();
    });
  });
  document.querySelector('.aspect-btn[data-aspect="16:9"]').classList.add('active');

  ['particlesOn', 'glowOn', 'colorCycleOn', 'scanlinesOn'].forEach((key) => {
    const el = document.getElementById(key);
    el.checked = state[key];
    el.addEventListener('input', () => { state[key] = el.checked; });
  });

  // ---- Idle preview loop (no audio, time-only animation) ----
  let previewMode = 'idle';
  let previewStart = performance.now();
  let liveAnalyser = null;
  let liveData = null;
  let audioBuffer = null;
  let audioCtx = null;
  let sourceNode = null;

  function previewLoop() {
    const time = (performance.now() - previewStart) / 1000;
    let bass = 0, mid = 0, treble = 0;
    if (previewMode === 'playing' && liveAnalyser) {
      liveAnalyser.getByteFrequencyData(liveData);
      const b = bandsFromFreqData(liveData);
      bass = b.bass; mid = b.mid; treble = b.treble;
    }
    drawFrame(time, bass, mid, treble);
    requestAnimationFrame(previewLoop);
  }

  applyAspect();
  requestAnimationFrame(previewLoop);
  window.addEventListener('resize', applyAspect);

  // ---- Audio loading ----
  const audioInput = document.getElementById('videoAudioInput');
  const previewPlayBtn = document.getElementById('videoPreviewPlayBtn');
  const previewStopBtn = document.getElementById('videoPreviewStopBtn');
  const renderBtn = document.getElementById('videoRenderBtn');
  const statusEl = document.getElementById('videoStatus');

  audioInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    statusEl.textContent = 'Decoding audio...';
    audioBuffer = await decodeAudioFile(file);
    previewPlayBtn.disabled = false;
    previewStopBtn.disabled = false;
    renderBtn.disabled = false;
    statusEl.textContent = 'Loaded: ' + file.name + ' (' + audioBuffer.duration.toFixed(1) + 's)';
  });

  function stopPreviewAudio() {
    if (sourceNode) {
      try { sourceNode.stop(); } catch (e) { /* already stopped */ }
      sourceNode = null;
    }
    previewMode = 'idle';
  }

  previewPlayBtn.addEventListener('click', () => {
    if (!audioBuffer) return;
    stopPreviewAudio();
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    liveAnalyser = audioCtx.createAnalyser();
    liveAnalyser.fftSize = 512;
    liveData = new Uint8Array(liveAnalyser.frequencyBinCount);
    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(liveAnalyser);
    liveAnalyser.connect(audioCtx.destination);
    sourceNode.start(0);
    previewStart = performance.now();
    previewMode = 'playing';
    sourceNode.onended = () => { previewMode = 'idle'; };
  });

  previewStopBtn.addEventListener('click', () => {
    stopPreviewAudio();
  });

  renderBtn.addEventListener('click', async () => {
    if (!audioBuffer) return;
    if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
      statusEl.textContent = 'WebCodecs is unavailable. Requires Chrome/Edge over HTTPS (or localhost).';
      return;
    }

    stopPreviewAudio();
    renderBtn.disabled = true;
    audioInput.disabled = true;

    const [width, height] = ASPECTS[state.aspect];
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);

    statusEl.textContent = 'Analyzing audio...';
    const bands = await analyzeAudioOffline(audioBuffer, FPS);
    const frameCount = bands.length;

    const videoCodec = await pickVideoCodec(width, height, FPS);
    const audioCodec = await pickAudioCodec(audioBuffer.sampleRate, audioBuffer.numberOfChannels);
    if (!videoCodec || !audioCodec) {
      statusEl.textContent = 'No supported codec found on this browser/GPU.';
      renderBtn.disabled = false;
      audioInput.disabled = false;
      return;
    }

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: videoCodec.startsWith('vp09') ? 'vp9' : 'avc', width, height },
      audio: {
        codec: audioCodec === 'opus' ? 'opus' : 'aac',
        numberOfChannels: audioBuffer.numberOfChannels,
        sampleRate: audioBuffer.sampleRate,
      },
      fastStart: 'in-memory',
    });

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { console.error(e); statusEl.textContent = 'Video encode error: ' + e.message; },
    });
    videoEncoder.configure({ codec: videoCodec, width, height, bitrate: 8_000_000, framerate: FPS });

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { console.error(e); statusEl.textContent = 'Audio encode error: ' + e.message; },
    });
    audioEncoder.configure({
      codec: audioCodec,
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioBuffer.numberOfChannels,
      bitrate: 128_000,
    });

    for (let i = 0; i < frameCount; i++) {
      const t = i / FPS;
      const b = bands[i];
      drawFrame(t, b.bass, b.mid, b.treble);

      const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6) });
      await encodeQueueWait(videoEncoder);
      videoEncoder.encode(frame, { keyFrame: i % 150 === 0 });
      frame.close();

      if (i % 10 === 0) {
        statusEl.textContent = 'Rendering frame ' + i + ' / ' + frameCount + '...';
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    statusEl.textContent = 'Encoding audio track...';
    await encodeAudioBuffer(audioEncoder, audioBuffer);

    statusEl.textContent = 'Finalizing MP4...';
    await videoEncoder.flush();
    await audioEncoder.flush();
    const filename = muxDownload(muxer, 'music-video');

    statusEl.textContent = 'Done - ' + filename + ' downloaded.';
    renderBtn.disabled = false;
    audioInput.disabled = false;
  });
})();
