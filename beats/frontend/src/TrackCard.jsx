import { useState } from 'react';
import * as api from './api.js';
import { useToast } from './Toast.jsx';
import Waveform from './Waveform.jsx';
import { avatarColor, formatDuration, formatSize, initials } from './utils.js';

export default function TrackCard({ track, isPlaying, isCurrent, onPlay, getLevels }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  async function share(e) {
    e.stopPropagation();
    try {
      const { url } = await api.getShareLink(track.id);
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast('Share link copied - anyone with it can listen', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const displayName = track.title || track.original_name || track.id;

  return (
    <li
      className={`track-row ${isCurrent ? 'current' : ''} ${isPlaying ? 'playing' : ''}`}
      onClick={() => onPlay(track)}
    >
      <button className="play-toggle" onClick={(e) => { e.stopPropagation(); onPlay(track); }}>
        {isPlaying ? (
          <svg viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 4.5v15l13-7.5z" fill="currentColor" /></svg>
        )}
      </button>

      <div className="track-body">
        <div className="track-top">
          <span className="track-name" title={displayName}>{displayName}</span>
          <span className="badges">
            {track.mine && <span className="badge">mine</span>}
            <span className={`badge ${track.is_public ? 'badge-pro' : ''}`}>
              {track.is_public ? 'public' : 'private'}
            </span>
          </span>
          <span className="track-duration">{formatDuration(track.duration_seconds)}</span>
        </div>

        {track.description && <div className="track-desc">{track.description}</div>}

        <Waveform
          peaks={track.waveform}
          isLive={isCurrent && isPlaying}
          getLevels={getLevels}
          color={isCurrent ? '#0a246a' : '#4a6ea9'}
        />

        <div className="track-meta">
          <span className="uploader" style={{ '--avatar-color': avatarColor(track.uploader) }}>
            <span className="avatar">{initials(track.uploader)}</span>
            {track.uploader || 'unknown'}
          </span>
          <span className="meta-dot" />
          <span>{formatSize(track.size_bytes)}</span>
          <span className="meta-dot" />
          <span>{track.play_count || 0} plays</span>
        </div>
      </div>

      <button className="btn small share-btn" onClick={share}>{copied ? 'Copied' : 'Share'}</button>
    </li>
  );
}
