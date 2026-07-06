// Served under the platform gateway at /beats/, so the API base is /beats/api.
// Auth (login/register/logout) is handled centrally by the platform, not here.
const BASE = '/beats/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

export function me() {
  return request('/me');
}

export function listTracks() {
  return request('/tracks');
}

export function registerPlay(trackId) {
  return request(`/tracks/${encodeURIComponent(trackId)}/play`, { method: 'POST' });
}

export function uploadTrack(file, { duration, waveform, title, description, isPublic } = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', BASE + '/upload');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let detail = `Upload failed: ${xhr.status}`;
        try { detail = JSON.parse(xhr.responseText).detail || detail; } catch { /* ignore */ }
        reject(new Error(detail));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    const form = new FormData();
    form.append('file', file);
    if (duration !== undefined) form.append('duration', String(duration));
    if (waveform !== undefined) form.append('waveform', JSON.stringify(waveform));
    if (title) form.append('title', title);
    if (description) form.append('description', description);
    form.append('is_public', isPublic ? '1' : '0');
    xhr.send(form);
  });
}

export function streamUrl(trackId) {
  return `${BASE}/stream/${encodeURIComponent(trackId)}`;
}

// Returns a public share link (the listen page) for a track. Anyone with the
// link can listen without an account, until the token expires.
export async function getShareLink(trackId) {
  const data = await request(`/tracks/${encodeURIComponent(trackId)}/share`);
  return {
    ...data,
    // data.path is "listen/<token>", relative to the /beats mount.
    url: `${window.location.origin}/beats/${data.path}`,
  };
}
