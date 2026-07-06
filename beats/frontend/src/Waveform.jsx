import { useEffect, useRef } from 'react';

// Static bars from stored peaks when idle; live reactive bars from the
// analyser when this card is the one currently playing.
export default function Waveform({ peaks, isLive, getLevels, color = '#4f8cff', bars = 32 }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    function resize() {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    }
    resize();

    function drawBars(values) {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const gap = w / values.length;
      const barWidth = gap * 0.6;
      for (let i = 0; i < values.length; i++) {
        const v = Math.max(0.04, values[i]);
        const barHeight = v * h;
        const x = i * gap + (gap - barWidth) / 2;
        const y = (h - barHeight) / 2;
        ctx.fillStyle = color;
        ctx.globalAlpha = isLive ? 1 : 0.55;
        const r = Math.min(barWidth / 2, 3 * dpr);
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, y, barWidth, barHeight, r) : ctx.rect(x, y, barWidth, barHeight);
        ctx.fill();
      }
    }

    if (isLive && getLevels) {
      const loop = () => {
        const data = getLevels();
        if (data) {
          const step = Math.floor(data.length / bars) || 1;
          const values = [];
          for (let i = 0; i < bars; i++) {
            values.push((data[i * step] || 0) / 255);
          }
          drawBars(values);
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      loop();
      return () => cancelAnimationFrame(rafRef.current);
    }

    const source = peaks && peaks.length ? peaks : new Array(bars).fill(0).map((_, i) => 0.15 + 0.15 * Math.sin(i));
    const resampled = [];
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor((i / bars) * source.length);
      resampled.push(source[idx] || 0.08);
    }
    drawBars(resampled);
    return undefined;
  }, [peaks, isLive, getLevels, color, bars]);

  return <canvas ref={canvasRef} className="waveform-canvas" />;
}
