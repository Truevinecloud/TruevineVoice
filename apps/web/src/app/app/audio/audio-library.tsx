'use client';

import { useEffect, useRef, useState } from 'react';

import { messageFor, request, upload } from '../../../lib/api';

interface Asset {
  id: string;
  name: string;
  source: 'RECORDING' | 'TTS';
  mimeType: string;
  durationMs: number | null;
  byteSize: string;
  campaignCount: number;
}
interface Voice {
  id: string;
  label: string;
  language: string;
}

async function fetchLibrary(
  organizationId: string,
): Promise<{
  assets: Asset[];
  voiceInfo: { available: boolean; storageAvailable: boolean; voices: Voice[] };
}> {
  const [assets, voiceInfo] = await Promise.all([
    request<Asset[]>(`/organizations/${organizationId}/audio-assets`),
    request<{ available: boolean; storageAvailable: boolean; voices: Voice[] }>(
      `/organizations/${organizationId}/audio-assets/voices`,
    ),
  ]);
  return { assets, voiceInfo };
}

export function AudioLibrary({
  organizationId,
  canCreate,
}: {
  organizationId: string;
  canCreate: boolean;
}): React.JSX.Element {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(false);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  async function refresh(): Promise<void> {
    const { assets: items, voiceInfo } = await fetchLibrary(organizationId);
    setAssets(items);
    setVoices(voiceInfo.voices);
    setTtsAvailable(voiceInfo.available);
    setStorageAvailable(voiceInfo.storageAvailable);
    if (!voice && voiceInfo.voices[0]) setVoice(voiceInfo.voices[0].id);
  }
  useEffect(() => {
    let active = true;
    void fetchLibrary(organizationId)
      .then(({ assets: items, voiceInfo }) => {
        if (!active) return;
        setAssets(items);
        setVoices(voiceInfo.voices);
        setTtsAvailable(voiceInfo.available);
        setStorageAvailable(voiceInfo.storageAvailable);
        setVoice((current) => current || voiceInfo.voices[0]?.id || '');
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFor(cause));
      });
    return () => {
      active = false;
    };
  }, [organizationId]);

  async function saveRecording(blob: Blob, suggestedName: string): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await upload(
        `/organizations/${organizationId}/audio-assets/recordings`,
        blob,
        name.trim() || suggestedName,
        crypto.randomUUID(),
      );
      setNotice('Audio saved to this organization.');
      setName('');
      await refresh();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  async function startRecording(): Promise<void> {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      const instance = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      instance.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      instance.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks.current, { type: instance.mimeType });
        void saveRecording(blob, `Recording ${new Date().toISOString()}`);
      };
      recorder.current = instance;
      instance.start();
      setRecording(true);
    } catch {
      setError(
        'Microphone access is unavailable. Allow microphone access or choose an audio file.',
      );
    }
  }

  async function synthesize(): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(`/organizations/${organizationId}/audio-assets/tts`, {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: { name: name.trim(), text, voice },
      });
      setNotice('Generated audio saved to this organization.');
      setName('');
      setText('');
      await refresh();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  async function play(asset: Asset): Promise<void> {
    setError('');
    try {
      const result = await request<{ url: string }>(
        `/organizations/${organizationId}/audio-assets/${asset.id}/playback-link`,
        { method: 'POST', body: {} },
      );
      const audio = new Audio(result.url);
      await audio.play();
    } catch (cause) {
      setError(messageFor(cause));
    }
  }

  return (
    <section className="stack">
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {canCreate && (
        <>
          {!storageAvailable && (
            <p role="status">
              Audio storage is not configured for this environment; recording and uploads are
              unavailable.
            </p>
          )}
          <h2>Record or upload audio</h2>
          <label>
            Asset name
            <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="button-row">
            {!recording ? (
              <button
                type="button"
                disabled={busy || !storageAvailable || typeof MediaRecorder === 'undefined'}
                onClick={() => void startRecording()}
              >
                Start recording
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  recorder.current?.stop();
                  setRecording(false);
                }}
              >
                Stop and save recording
              </button>
            )}
            <label>
              Or choose audio file
              <input
                type="file"
                accept="audio/*"
                disabled={busy || !storageAvailable}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void saveRecording(file, file.name);
                }}
              />
            </label>
          </div>
          {recording && <p role="status">Recording. Stop to upload and save.</p>}
          <h2>Generate speech</h2>
          {!ttsAvailable && (
            <p className="field-hint">Text to speech is not configured for this environment.</p>
          )}
          <label>
            Text
            <textarea
              value={text}
              maxLength={3000}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <label>
            Voice
            <select value={voice} onChange={(event) => setVoice(event.target.value)}>
              {voices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {item.language}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={
              busy || !storageAvailable || !ttsAvailable || !text.trim() || !name.trim() || !voice
            }
            onClick={() => void synthesize()}
          >
            Generate and save
          </button>
        </>
      )}
      <h2>Audio assets</h2>
      {assets.length === 0 ? (
        <p>No audio assets are available.</p>
      ) : (
        <ul>
          {assets.map((asset) => (
            <li key={asset.id}>
              <strong>{asset.name}</strong> — {asset.source};{' '}
              {asset.durationMs === null
                ? 'duration unavailable'
                : `${Math.round(asset.durationMs / 1000)} sec`}
              ; {asset.campaignCount} campaigns{' '}
              <button type="button" onClick={() => void play(asset)}>
                Play
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="field-hint">
        Audio is available only within this organization. Campaign selection stores a reference;
        call execution is not connected.
      </p>
    </section>
  );
}
