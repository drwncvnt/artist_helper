export function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function coverGradient(id) {
  const h = hashString(id);
  const hue1 = h % 360;
  const hue2 = (hue1 + 55 + (h % 50)) % 360;
  const hue3 = (hue2 + 40 + (h % 30)) % 360;
  return `linear-gradient(135deg, hsl(${hue1}, 75%, 58%), hsl(${hue2}, 80%, 48%) 55%, hsl(${hue3}, 70%, 38%))`;
}

export function avatarColor(name) {
  const h = hashString(name || '?');
  return `hsl(${h % 360}, 60%, 50%)`;
}

export function initials(name) {
  if (!name) return '?';
  return name.slice(0, 2).toUpperCase();
}

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Decode an audio file client-side to extract duration and a low-res peak
// waveform, so cards can show a shape for the track without the server
// needing to understand audio codecs at all.
export async function analyzeAudioFile(file, samples = 80) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioContextCls = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContextCls();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(channelData.length / samples));
    const peaks = [];
    for (let i = 0; i < samples; i++) {
      let max = 0;
      const start = i * blockSize;
      for (let j = 0; j < blockSize; j++) {
        const v = Math.abs(channelData[start + j] || 0);
        if (v > max) max = v;
      }
      peaks.push(Math.round(max * 100) / 100);
    }
    return { duration: audioBuffer.duration, peaks };
  } finally {
    await ctx.close();
  }
}
