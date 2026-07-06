import { useEffect, useRef, useState } from 'react';
import * as api from './api.js';
import NowPlayingBar from './NowPlayingBar.jsx';
import TrackCard from './TrackCard.jsx';
import { useToast } from './Toast.jsx';
import { analyzeAudioFile } from './utils.js';
import { useAudioEngine } from './useAudioEngine.js';

function UploadPanel({ onUpload, progress }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const inputRef = useRef(null);
  const busy = progress !== null;

  function pick(f) {
    if (!f) return;
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  }

  async function submit() {
    if (!file) return;
    await onUpload(file, { title: title.trim(), description: description.trim(), isPublic });
    setFile(null);
    setTitle('');
    setDescription('');
    setIsPublic(false);
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <section className="groupbox upload-panel">
      <div className="groupbox-title">Add a track</div>

      <div
        className={`dropzone ${file ? 'has-file' : ''}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => pick(e.target.files[0])}
        />
        {file ? <span>{file.name}</span> : <span>Drop an audio file here, or click to choose</span>}
      </div>

      <div className="field">
        <label className="field-label" htmlFor="up-title">Title</label>
        <input id="up-title" type="text" value={title} maxLength={120}
          placeholder="e.g. untitled beat 04" onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="up-desc">Description <span className="hint">(optional)</span></label>
        <textarea id="up-desc" rows={2} value={description} maxLength={2000}
          placeholder="notes, BPM, key, mood…" onChange={(e) => setDescription(e.target.value)} />
      </div>

      <label className="checkline">
        <span className="switch"><input type="checkbox" checked={isPublic}
          onChange={(e) => setIsPublic(e.target.checked)} /><span /></span>
        <span>Public - show in everyone's library</span>
      </label>
      <p className="hint" style={{ margin: '2px 0 10px' }}>
        {isPublic
          ? 'Anyone signed in can find this track.'
          : 'Private - only you see it here. You can still share it with a link.'}
      </p>

      {busy ? (
        <div className="progress"><div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      ) : (
        <button className="btn primary block" disabled={!file} onClick={submit}>Upload</button>
      )}
    </section>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [tracks, setTracks] = useState([]);
  const [current, setCurrent] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const audioRef = useRef(null);
  const toast = useToast();
  const { ensureStarted, getLevels } = useAudioEngine(audioRef);

  useEffect(() => {
    api.me()
      .then((u) => setUser(u))
      .catch(() => { window.location.href = '/login'; })
      .finally(() => setCheckingAuth(false));
  }, []);

  async function refreshTracks() {
    try {
      const { tracks } = await api.listTracks();
      setTracks(tracks);
    } catch {
      window.location.href = '/login';
    }
  }

  useEffect(() => {
    if (user) refreshTracks();
  }, [user]);

  function playTrack(track) {
    ensureStarted();
    if (current?.id === track.id) {
      if (audioRef.current.paused) {
        audioRef.current.play().catch(() => toast('Playback was blocked - try again', 'error'));
      } else {
        audioRef.current.pause();
      }
      return;
    }
    setCurrent(track);
    api.registerPlay(track.id).then(refreshTracks).catch(() => {});
  }

  useEffect(() => {
    if (current && audioRef.current) {
      audioRef.current.src = api.streamUrl(current.id);
      audioRef.current.play().catch(() => toast('Playback was blocked - try again', 'error'));
    }
  }, [current]);

  async function handleUpload(file, meta) {
    setUploadProgress(0);
    try {
      let analyzed = {};
      try { analyzed = await analyzeAudioFile(file); } catch { analyzed = {}; }
      await api.uploadTrack(
        file,
        { duration: analyzed.duration, waveform: analyzed.peaks, ...meta },
        setUploadProgress,
      );
      toast('Track uploaded', 'success');
      await refreshTracks();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setUploadProgress(null);
    }
  }

  if (checkingAuth || !user) {
    return <div className="boot-screen" />;
  }

  return (
    <div className="window window--full beats">
      <div className="titlebar">
        <div className="titlebar-icon" />
        <span className="titlebar-text">Beat Share - your private audio cloud</span>
        <div className="titlebar-buttons">
          <a className="status-link hub-link" href="/">&#8592; Hub</a>
        </div>
      </div>

      <div className="menubar">
        <span>File</span><span>View</span><span>Help</span>
        <div className="menubar-right">signed in as <b>{user.username}</b></div>
      </div>

      <div className="beats-body">
        <UploadPanel onUpload={handleUpload} progress={uploadProgress} />

        <section className="groupbox library">
          <div className="groupbox-title">Library</div>
          {tracks.length === 0 ? (
            <p className="hint" style={{ padding: '8px 2px' }}>
              No tracks yet. Add a demo, beat or instrumental above - keep it private, or
              share it with a link.
            </p>
          ) : (
            <ul className="track-list">
              {tracks.map((t) => (
                <TrackCard
                  key={t.id}
                  track={t}
                  isCurrent={current?.id === t.id}
                  isPlaying={current?.id === t.id && isPlaying}
                  onPlay={playTrack}
                  getLevels={current?.id === t.id ? getLevels : null}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <audio ref={audioRef} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} hidden />
      <NowPlayingBar
        track={current}
        audioRef={audioRef}
        isPlaying={isPlaying}
        onTogglePlay={() => (audioRef.current.paused ? audioRef.current.play().catch(() => {}) : audioRef.current.pause())}
        getLevels={getLevels}
      />
    </div>
  );
}

export default App;
