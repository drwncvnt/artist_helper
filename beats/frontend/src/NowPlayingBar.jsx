import { useEffect, useState } from 'react';
import Waveform from './Waveform.jsx';
import { coverGradient, formatDuration } from './utils.js';

export default function NowPlayingBar({ track, audioRef, isPlaying, onTogglePlay, getLevels }) {
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const onTime = () => setProgress(audio.currentTime);
    const onMeta = () => setDuration(audio.duration || 0);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
    };
  }, [audioRef, track]);

  if (!track) return null;

  function seek(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    if (audioRef.current && duration) {
      audioRef.current.currentTime = ratio * duration;
    }
  }

  const pct = duration ? (progress / duration) * 100 : 0;

  return (
    <div className="now-playing">
      <div className="np-cover" style={{ background: coverGradient(track.id) }} />
      <div className="np-info">
        <div className="np-name">{track.original_name || track.id}</div>
        <div className="np-seekbar" onClick={seek}>
          <div className="np-seek-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="np-times">
          <span>{formatDuration(progress)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>
      <div className="np-wave">
        <Waveform peaks={track.waveform} isLive={isPlaying} getLevels={getLevels} color="#7ab8ff" bars={40} />
      </div>
      <button className="np-toggle" onClick={onTogglePlay}>
        {isPlaying ? (
          <svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 4.5v15l13-7.5z" fill="currentColor" /></svg>
        )}
      </button>
    </div>
  );
}
