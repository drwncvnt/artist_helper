function bandsFromFreqData(freqData) {
  const n = freqData.length;
  const avg = (from, to) => {
    let s = 0;
    for (let i = from; i < to; i++) s += freqData[i];
    return s / (to - from) / 255;
  };
  return {
    bass: avg(0, Math.floor(n * 0.08)),
    mid: avg(Math.floor(n * 0.08), Math.floor(n * 0.35)),
    treble: avg(Math.floor(n * 0.35), Math.floor(n * 0.9)),
  };
}

async function analyzeAudioOffline(buffer, fps) {
  const duration = buffer.duration;
  const frameCount = Math.ceil(duration * fps);
  const offlineCtx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  const analyser = offlineCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  analyser.connect(offlineCtx.destination);
  source.start(0);

  const bands = new Array(frameCount);
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  bands[0] = { bass: 0, mid: 0, treble: 0 };

  const schedule = [];
  for (let i = 1; i < frameCount; i++) {
    const t = i / fps;
    if (t >= duration) { bands[i] = bands[i - 1]; continue; }
    schedule.push(
      offlineCtx.suspend(t).then(() => {
        analyser.getByteFrequencyData(freqData);
        bands[i] = bandsFromFreqData(freqData);
        return offlineCtx.resume();
      })
    );
  }
  await offlineCtx.startRendering();
  await Promise.all(schedule);
  for (let i = 1; i < frameCount; i++) {
    if (!bands[i]) bands[i] = bands[i - 1];
  }
  return bands;
}

async function pickVideoCodec(width, height, fps) {
  const candidates = ['avc1.640033', 'avc1.4d4028', 'avc1.42E01F', 'vp09.00.10.08'];
  for (const codec of candidates) {
    const support = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 8_000_000, framerate: fps });
    if (support.supported) return codec;
  }
  return null;
}

async function pickAudioCodec(sampleRate, numberOfChannels) {
  const candidates = ['mp4a.40.2', 'opus'];
  for (const codec of candidates) {
    const support = await AudioEncoder.isConfigSupported({ codec, sampleRate, numberOfChannels, bitrate: 128_000 });
    if (support.supported) return codec;
  }
  return null;
}

function encodeQueueWait(encoder) {
  if (encoder.encodeQueueSize <= 2) return Promise.resolve();
  return new Promise((resolve) => { encoder.ondequeue = resolve; });
}

async function encodeAudioBuffer(audioEncoder, audioBuffer) {
  const chunkSize = 1024;
  const totalFrames = audioBuffer.length;
  const numberOfChannels = audioBuffer.numberOfChannels;
  for (let off = 0; off < totalFrames; off += chunkSize) {
    const frameSize = Math.min(chunkSize, totalFrames - off);
    const chData = new Float32Array(numberOfChannels * frameSize);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      chData.set(audioBuffer.getChannelData(ch).subarray(off, off + frameSize), ch * frameSize);
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: audioBuffer.sampleRate,
      numberOfFrames: frameSize,
      numberOfChannels,
      timestamp: Math.round((off / audioBuffer.sampleRate) * 1e6),
      data: chData,
    });
    await encodeQueueWait(audioEncoder);
    audioEncoder.encode(audioData);
    audioData.close();
  }
}

function muxDownload(muxer, filenamePrefix) {
  muxer.finalize();
  const { buffer } = muxer.target;
  const blob = new Blob([buffer], { type: 'video/mp4' });
  const randomIndex = Math.floor(1000 + Math.random() * 9000);
  const filename = filenamePrefix + '-' + randomIndex + '.mp4';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return filename;
}

async function decodeAudioFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buffer = await decodeCtx.decodeAudioData(arrayBuffer);
    return buffer;
  } finally {
    await decodeCtx.close();
  }
}
