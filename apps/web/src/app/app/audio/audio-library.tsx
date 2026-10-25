'use client';

import { useEffect, useRef, useState } from 'react';

import { messageFor, request, upload } from '../../../lib/api';
import { EmptyState, SectionCard } from '../AppUI';

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

async function fetchLibrary(organizationId: string): Promise<{
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
    <div className="audio-library">
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice notice-success" role="status">
          {notice}
        </p>
      )}
      {canCreate && (
        <>
          {!storageAvailable && (
            <p className="notice notice-info" role="status">
              Audio storage is not configured for this environment; recording and uploads are
              unavailable.
            </p>
          )}
          <SectionCard
            title="Record or upload"
            description="Create an organization audio asset. Secure storage must be configured before recording is enabled."
          >
            <div className="field">
              <label htmlFor="audio-asset-name">Asset name</label>
              <input
                id="audio-asset-name"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
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
              <label className="file-picker">
                <span>Or choose an audio file</span>
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
          </SectionCard>
          <SectionCard
            title="Generate speech"
            description="Use the configured text-to-speech provider to create a reusable audio asset."
          >
            {!ttsAvailable && (
              <p className="notice notice-info">
                Text to speech is not configured for this environment.
              </p>
            )}
            <div className="field">
              <label htmlFor="audio-tts-text">Text</label>
              <textarea
                id="audio-tts-text"
                value={text}
                maxLength={3000}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="audio-tts-voice">Voice</label>
              <select
                id="audio-tts-voice"
                value={voice}
                onChange={(event) => setVoice(event.target.value)}
              >
                {voices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} · {item.language}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={
                busy || !storageAvailable || !ttsAvailable || !text.trim() || !name.trim() || !voice
              }
              onClick={() => void synthesize()}
            >
              Generate and save
            </button>
          </SectionCard>
        </>
      )}
      <SectionCard
        title="Audio assets"
        description="Assets are private to this organization and can be selected in a campaign draft."
      >
        {assets.length === 0 ? (
          <EmptyState title="No audio assets available">
            When secure storage is configured, recordings and generated audio will appear here.
          </EmptyState>
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
      </SectionCard>
    </div>
  );
}
