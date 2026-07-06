import { useRef, useCallback } from 'react';

// Single shared AudioContext/Analyser wired to one <audio> element.
// createMediaElementSource can only be called once per element, so the graph
// is built lazily on first playback (needs a user gesture) and reused after.
export function useAudioEngine(audioRef) {
  const ctxRef = useRef(null);
  const analyserRef = useRef(null);
  const dataRef = useRef(null);

  const ensureStarted = useCallback(() => {
    if (!ctxRef.current) {
      const AudioContextCls = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContextCls();
      const source = ctx.createMediaElementSource(audioRef.current);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      ctxRef.current = ctx;
      analyserRef.current = analyser;
      dataRef.current = new Uint8Array(analyser.frequencyBinCount);
    }
    if (ctxRef.current.state === 'suspended') ctxRef.current.resume();
  }, [audioRef]);

  const getLevels = useCallback(() => {
    if (!analyserRef.current) return null;
    analyserRef.current.getByteFrequencyData(dataRef.current);
    return dataRef.current;
  }, []);

  return { ensureStarted, getLevels };
}
