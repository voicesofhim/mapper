import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LiveKitRoom,
  useDataChannel,
  useRoomContext,
} from '@livekit/components-react';

import { AgentAudioVisualizerAura } from '@/components/agents-ui/agent-audio-visualizer-aura';

const DEFAULT_TOKEN_ENDPOINT = 'http://127.0.0.1:8787/api/livekit-token';
const DEFAULT_ROOM = 'mapper-local';

export function mountAskVoiceMode(container, options = {}) {
  if (!container) return () => {};
  ensureVoiceStyles();

  const root = createRoot(container);
  root.render(<AskVoiceMode {...options} />);
  return () => root.unmount();
}

function AskVoiceMode({ onModeChange, onTranscript }) {
  const [mode, setMode] = useState('chat');
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('Local voice idle');
  const [error, setError] = useState('');
  const [heardText, setHeardText] = useState('');
  const [liveTranscript, setLiveTranscript] = useState([]);
  const [micLevel, setMicLevel] = useState(0);
  const [pushToTalkActive, setPushToTalkActive] = useState(false);
  const micMonitorRef = useRef(null);
  const sessionRef = useRef(null);
  const [micInfo, setMicInfo] = useState({
    label: 'Mic not checked',
    detail: 'Connect local voice to test the active browser input.',
    state: 'idle',
  });

  const setAskMode = useCallback((nextMode) => {
    setMode(nextMode);
    onModeChange?.(nextMode);
  }, [onModeChange]);

  const stopMicMonitor = useCallback(() => {
    micMonitorRef.current?.();
    micMonitorRef.current = null;
    setMicLevel(0);
  }, []);

  const startMicMonitor = useCallback(async () => {
    stopMicMonitor();
    const cleanup = await startMicLevelMonitor(setMicLevel);
    micMonitorRef.current = cleanup;
  }, [stopMicMonitor]);

  const refreshMicInfo = useCallback(async ({ requestPermission = false } = {}) => {
    try {
      const nextMicInfo = await getMicrophoneInfo({ requestPermission });
      setMicInfo(nextMicInfo);
      return nextMicInfo;
    } catch (err) {
      const detail = formatConnectionError(err);
      setMicInfo({
        label: 'No microphone detected',
        detail,
        state: 'error',
      });
      throw err;
    }
  }, []);

  useEffect(() => {
    if (mode !== 'voice') return undefined;
    refreshMicInfo({ requestPermission: false }).catch(() => {});

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return undefined;

    const handleDeviceChange = () => {
      refreshMicInfo({ requestPermission: false }).catch(() => {});
    };
    mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, [mode, refreshMicInfo]);

  useEffect(() => () => stopMicMonitor(), [stopMicMonitor]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const connectVoice = useCallback(async () => {
    setError('');
    setStatus('Checking local microphone');
    try {
      const checkedMic = await refreshMicInfo({ requestPermission: true });
      await startMicMonitor();
      setMicInfo({
        ...checkedMic,
        detail: 'Input test passed. Using browser default input.',
        state: 'ready',
      });
      setStatus('Preparing local LiveKit room');
      const endpoint = import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT || DEFAULT_TOKEN_ENDPOINT;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: DEFAULT_ROOM }),
      });
      if (!response.ok) throw new Error(formatTokenEndpointError(response.status));
      const payload = await response.json();
      setSession({
        token: payload.token,
        url: payload.url || import.meta.env.VITE_LIVEKIT_URL,
        room: payload.room || DEFAULT_ROOM,
      });
      setStatus('Connecting to local voice agent');
    } catch (err) {
      stopMicMonitor();
      setError(formatConnectionError(err));
      setStatus('Local voice unavailable');
    }
  }, [refreshMicInfo, startMicMonitor, stopMicMonitor]);

  useEffect(() => {
    if (mode !== 'voice') return undefined;

    const handleKeyDown = (event) => {
      if (!isPushToTalkKey(event) || event.repeat) return;
      event.preventDefault();
      setPushToTalkActive(true);
      if (!sessionRef.current) connectVoice();
    };
    const handleKeyUp = (event) => {
      if (!isPushToTalkKey(event)) return;
      event.preventDefault();
      setPushToTalkActive(false);
    };
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keyup', handleKeyUp, true);
      setPushToTalkActive(false);
    };
  }, [connectVoice, mode]);

  const disconnectVoice = useCallback(() => {
    setPushToTalkActive(false);
    setSession(null);
    setStatus('Local voice idle');
    setError('');
    setHeardText('');
    setLiveTranscript([]);
    stopMicMonitor();
  }, [stopMicMonitor]);

  const handlePushPointerDown = useCallback((event) => {
    event.preventDefault();
    setPushToTalkActive(true);
    if (!session) {
      connectVoice();
      return;
    }
  }, [connectVoice, session]);

  const releasePushToTalk = useCallback(() => {
    setPushToTalkActive(false);
  }, []);

  const displayedMicLevel = session && pushToTalkActive ? micLevel : 0;

  return (
    <div className="ask-voice-shell" data-mode={mode}>
      <div className="ask-mode-buttons" role="tablist" aria-label="Ask mode">
        <button
          type="button"
          className={mode === 'chat' ? 'active' : ''}
          aria-selected={mode === 'chat'}
          onClick={() => setAskMode('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          className={mode === 'voice' ? 'active' : ''}
          aria-selected={mode === 'voice'}
          onClick={() => setAskMode('voice')}
        >
          VOICE
        </button>
      </div>

      {mode === 'voice' ? (
        <div className="ask-voice-card">
          <div className="ask-voice-header">
            <span>VOICE // LOCAL</span>
            <details className="ask-voice-diagnostics">
              <summary>status</summary>
              <div className="ask-voice-diagnostics-menu">
                <div className="ask-voice-status" aria-live="polite">
                  <span>STATUS</span>
                  <b>{error || status}</b>
                </div>
                <div className="ask-voice-heard" aria-live="polite">
                  <span>HEARD</span>
                  <b>{heardText || 'Waiting for speech'}</b>
                </div>
                <div className={`ask-voice-mic ask-voice-mic-${micInfo.state || 'idle'}`} aria-live="polite">
                  <span>MIC</span>
                  <b>{micInfo.label}</b>
                  <small>{micInfo.detail}</small>
                </div>
                {session ? (
                  <button type="button" className="ask-voice-disconnect" onClick={disconnectVoice}>Disconnect</button>
                ) : null}
              </div>
            </details>
          </div>

          <div className="ask-voice-scope">
            {session?.token && session?.url ? (
              <LiveKitRoom
                serverUrl={session.url}
                token={session.token}
                connect
                audio={false}
                video={false}
                onConnected={() => setStatus(`Local room: ${session.room}`)}
                onDisconnected={() => setStatus('Local voice disconnected')}
                onError={(err) => {
                  setError(formatConnectionError(err));
                  setSession(null);
                  setStatus('Local voice unavailable');
                }}
              >
                <VoiceRoom
                  onTranscript={onTranscript}
                  setStatus={setStatus}
                  setHeardText={setHeardText}
                  setLiveTranscript={setLiveTranscript}
                  pushToTalkActive={pushToTalkActive}
                />
              </LiveKitRoom>
            ) : (
              <IdleAura />
            )}
          </div>

          <div className="ask-voice-meter" aria-label="Microphone input level">
            <span>SIGNAL</span>
            <div className="ask-voice-meter-track">
              <i style={{ transform: `scaleX(${Math.max(0.03, displayedMicLevel).toFixed(3)})` }} />
            </div>
            <b>{Math.round(displayedMicLevel * 100)}%</b>
          </div>

          <div className="ask-voice-mini-transcript" aria-live="polite">
            <div>
              {liveTranscript.length ? liveTranscript.map((entry) => (
                <p key={entry.id} data-final={entry.final ? 'true' : 'false'}>
                  {entry.text}
                </p>
              )) : <p data-final="false">live transcript...</p>}
            </div>
          </div>

          <div className="ask-voice-actions">
            <button
              type="button"
              className={pushToTalkActive ? 'is-hot' : ''}
              aria-pressed={pushToTalkActive}
              onPointerDown={handlePushPointerDown}
              onPointerUp={releasePushToTalk}
              onPointerCancel={releasePushToTalk}
              onPointerLeave={releasePushToTalk}
            >
              <span>Push to Talk</span>
              <small>{session ? 'Hold T or hold button' : 'Click to connect'}</small>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function IdleAura() {
  return (
    <AgentAudioVisualizerAura
      className="mapper-livekit-aura"
      state="idle"
      color="#1ff7ff"
      colorShift={0.03}
      themeMode="dark"
      aria-label="LiveKit Aura voice visualizer idle"
    />
  );
}

function VoiceRoom({ onTranscript, setStatus, setHeardText, setLiveTranscript, pushToTalkActive }) {
  const room = useRoomContext();
  const lastTranscriptRef = useRef('');
  const transcriptSeqRef = useRef(0);
  const [voiceState, setVoiceState] = useState('listening');

  useEffect(() => {
    setStatus('Local voice connected. Hold T to talk.');
  }, [setStatus]);

  useEffect(() => {
    let cancelled = false;
    room.localParticipant.setMicrophoneEnabled(Boolean(pushToTalkActive))
      .then(() => {
        if (cancelled) return;
        setStatus(pushToTalkActive ? 'Mic open. Listening while T is held.' : 'Mic closed. Hold T to talk.');
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus(formatConnectionError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [pushToTalkActive, room, setStatus]);

  useDataChannel((message) => {
    const voiceStatus = readVoiceStatus(message);
    if (voiceStatus) {
      setStatus(formatVoiceStatus(voiceStatus));
      if (voiceStatus.state === 'searching' && voiceStatus.detail) {
        setHeardText?.(voiceStatus.detail);
        appendMiniTranscript(setLiveTranscript, {
          id: `status-${transcriptSeqRef.current++}`,
          text: voiceStatus.detail,
          final: false,
        });
      }
      setVoiceState(mapVoiceStatusToAuraState(voiceStatus.state));
      window.dispatchEvent(new CustomEvent('mapper:voice-status', { detail: voiceStatus }));
      return;
    }

    const packet = readTranscriptPacket(message);
    if (packet.text) {
      appendMiniTranscript(setLiveTranscript, {
        id: packet.id || `transcript-${transcriptSeqRef.current++}`,
        text: packet.text,
        final: packet.final,
      });
    }

    if (!packet.final) return;
    const transcript = packet.text;
    if (!transcript || transcript === lastTranscriptRef.current) return;
    lastTranscriptRef.current = transcript;
    setHeardText?.(transcript);
    setStatus('Submitting voice question to map');
    setVoiceState('thinking');
    window.dispatchEvent(new CustomEvent('mapper:voice-transcript', {
      detail: { transcript, source: 'local-livekit-stt' },
    }));
    onTranscript?.(transcript);
  });

  return (
    <>
      <AgentAudioVisualizerAura
        className="mapper-livekit-aura"
        state={voiceState}
        color="#1ff7ff"
        colorShift={0.03}
        themeMode="dark"
        aria-label={`LiveKit Aura voice visualizer ${voiceState}`}
      />
    </>
  );
}

function readTranscriptPacket(message) {
  const topic = message?.topic || '';
  const decoded = decodePayload(message?.payload);
  if (!decoded) return { text: '', final: false, id: '' };

  const parsed = parseMaybeJson(decoded);
  const text = extractTranscriptText(parsed);
  return {
    text: text.trim(),
    final: extractFinalState(parsed, topic),
    id: extractTranscriptId(parsed),
  };
}

function readVoiceStatus(message) {
  const topic = message?.topic || '';
  if (topic !== 'mapper.voice_status') return null;
  const decoded = decodePayload(message?.payload);
  if (!decoded) return null;
  const parsed = parseMaybeJson(decoded);
  const state = parsed?.state || parsed?.status || parsed?.phase;
  if (!state) return null;
  return {
    state: String(state).toLowerCase(),
    detail: parsed.detail || parsed.message || parsed.text || '',
    local_only: parsed.local_only !== false,
  };
}

function decodePayload(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  try {
    return new TextDecoder().decode(payload);
  } catch {
    return '';
  }
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return { text: value, final: true };
  }
}

function extractTranscriptText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return payload.map(extractTranscriptText).filter(Boolean).join(' ');
  if (Array.isArray(payload.segments)) {
    return payload.segments.map(extractTranscriptText).filter(Boolean).join(' ');
  }
  return payload.text || payload.transcript || payload.query || payload.message || '';
}

function extractTranscriptId(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  return payload.id || payload.segment_id || payload.segmentId || payload.sid || '';
}

function extractFinalState(payload, topic) {
  if (topic === 'mapper.transcript') return true;
  if (!payload || typeof payload !== 'object') return true;
  if (Array.isArray(payload)) return payload.some((item) => extractFinalState(item, topic));
  if (Array.isArray(payload.segments)) return payload.segments.some((item) => extractFinalState(item, topic));
  if ('final' in payload) return Boolean(payload.final);
  if ('is_final' in payload) return Boolean(payload.is_final);
  if ('isFinal' in payload) return Boolean(payload.isFinal);
  return topic !== 'lk.transcription';
}

function appendMiniTranscript(setLiveTranscript, entry) {
  if (!entry?.text || !setLiveTranscript) return;
  setLiveTranscript((current) => {
    const nextEntry = {
      ...entry,
      text: entry.text.trim(),
      final: Boolean(entry.final),
    };
    const index = nextEntry.id
      ? current.findIndex((item) => item.id === nextEntry.id)
      : -1;
    const next = index >= 0
      ? current.map((item, itemIndex) => (itemIndex === index ? nextEntry : item))
      : [...current, nextEntry];
    return next.slice(-4);
  });
}

function formatAgentState(state) {
  return String(state || 'idle').replace(/-/g, ' ');
}

function formatVoiceStatus(status) {
  const state = formatAgentState(status?.state || 'idle');
  const detail = String(status?.detail || '').trim();
  if (!detail) return `Local voice ${state}`;
  if (detail.length > 48) return `Local voice ${state}: ${detail.slice(0, 45)}...`;
  return `Local voice ${state}: ${detail}`;
}

function mapVoiceStatusToAuraState(state) {
  if (state === 'transcribing' || state === 'searching' || state === 'thinking') return 'thinking';
  if (state === 'error' || state === 'failed') return 'failed';
  if (state === 'idle' || state === 'done') return 'idle';
  return 'listening';
}

function isPushToTalkKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.code === 'KeyT' || event.key?.toLowerCase() === 't';
}

function formatTokenEndpointError(status) {
  if (status === 404) return 'Token server offline. Start ask:server.';
  if (status === 400) return 'Token request rejected by local server.';
  if (status >= 500) return 'Local token server error.';
  return `Local token server returned ${status}.`;
}

function formatConnectionError(err) {
  const message = err?.message || '';
  if (/requested device not found|device not found|notfounderror|no media tracks/i.test(message)) {
    return 'No microphone found. Check input device, then reconnect.';
  }
  if (/not supported|unavailable/i.test(message)) {
    return 'Microphone access unavailable in this browser/session.';
  }
  if (/permission|notallowederror|denied/i.test(message)) {
    return 'Microphone permission blocked. Allow mic access, then reconnect.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Local token server offline. Start ask:server.';
  }
  return message || 'Could not connect to local LiveKit';
}

async function getMicrophoneInfo({ requestPermission = false } = {}) {
  if (!navigator.mediaDevices) {
    throw new Error('Browser microphone access is unavailable.');
  }

  let stream = null;
  let track = null;
  let settings = {};
  try {
    if (requestPermission) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      track = stream.getAudioTracks()[0] || null;
      if (!track) throw new Error('No microphone audio track returned.');
      settings = track.getSettings?.() || {};
    }

    const devices = navigator.mediaDevices.enumerateDevices
      ? await navigator.mediaDevices.enumerateDevices()
      : [];
    const audioInputs = devices.filter((device) => device.kind === 'audioinput');
    if (!audioInputs.length && !track) {
      throw new Error('No microphone found. Check input device, then reconnect.');
    }

    const selectedDevice = audioInputs.find((device) => (
      settings.deviceId && device.deviceId === settings.deviceId
    )) || audioInputs.find((device) => device.deviceId === 'default') || audioInputs[0];

    const label = cleanMicLabel(track?.label || selectedDevice?.label);
    const visibleLabel = label || (audioInputs.length ? 'Microphone available' : 'Microphone name hidden');
    const detail = requestPermission
      ? 'Input test passed.'
      : micDetailForDevices(audioInputs, label);

    return {
      label: visibleLabel,
      detail,
      state: requestPermission ? 'ready' : 'idle',
    };
  } catch (err) {
    throw new Error(formatConnectionError(err));
  } finally {
    if (stream) {
      for (const mediaTrack of stream.getTracks()) mediaTrack.stop();
    }
  }
}

function cleanMicLabel(label) {
  return String(label || '')
    .replace(/\s+\([0-9a-f-]{8,}\)$/i, '')
    .trim();
}

function micDetailForDevices(audioInputs, label) {
  if (!audioInputs.length) return 'No audio inputs reported by browser.';
  if (!label) return 'Allow mic access to reveal the input name.';
  if (audioInputs.length === 1) return 'Browser default input detected.';
  return `${audioInputs.length} audio inputs available. Browser default shown.`;
}

async function startMicLevelMonitor(setMicLevel) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Browser microphone access is unavailable.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error('Browser audio analysis is unavailable.');
  }

  const audioContext = new AudioContextCtor();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.72;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let rafId = 0;
  let active = true;

  const tick = () => {
    if (!active) return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / samples.length);
    setMicLevel(Math.min(1, rms * 5));
    rafId = window.requestAnimationFrame(tick);
  };

  tick();

  return () => {
    active = false;
    if (rafId) window.cancelAnimationFrame(rafId);
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    audioContext.close?.();
  };
}

function ensureVoiceStyles() {
  if (document.getElementById('ask-voice-mode-styles')) return;
  const style = document.createElement('style');
  style.id = 'ask-voice-mode-styles';
  style.textContent = `
    .ask-voice-shell {
      display: grid;
      justify-items: stretch;
      gap: 0.55rem;
    }
    .ask-mode-buttons {
      justify-self: end;
      display: grid;
      grid-template-columns: repeat(2, minmax(54px, 1fr));
      border: 1px solid rgba(31, 247, 255, 0.28);
      background: rgba(3, 12, 22, 0.72);
      min-width: 132px;
    }
    .ask-mode-buttons button,
    .ask-voice-actions button {
      border: 0;
      border-right: 1px solid rgba(31, 247, 255, 0.2);
      border-radius: 0;
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      font: 0.66rem/1 var(--font-heading);
      min-height: 30px;
      padding: 0.4rem 0.55rem;
      text-transform: uppercase;
      transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
    }
    .ask-mode-buttons button:focus,
    .ask-mode-buttons button:focus-visible,
    .ask-voice-actions button:focus,
    .ask-voice-actions button:focus-visible {
      outline: 1px solid rgba(31, 247, 255, 0.82) !important;
      outline-offset: 2px;
      box-shadow: 0 0 0 1px rgba(31, 247, 255, 0.24), inset 0 0 16px rgba(31, 247, 255, 0.08) !important;
    }
    .ask-mode-buttons button:last-child {
      border-right: 0;
    }
    .ask-mode-buttons button.active,
    .ask-mode-buttons button:hover,
    .ask-voice-actions button:hover {
      background: rgba(31, 247, 255, 0.16);
      color: var(--color-primary);
      box-shadow: inset 0 0 16px rgba(31, 247, 255, 0.09);
    }
    .ask-voice-card {
      justify-self: center;
      width: min(100%, 276px);
      border: 1px solid rgba(31, 247, 255, 0.22);
      background:
        linear-gradient(rgba(31, 247, 255, 0.035) 1px, transparent 1px),
        rgba(3, 9, 18, 0.58);
      background-size: 100% 18px, auto;
      box-shadow: inset 0 0 0 1px rgba(31, 247, 255, 0.035), 0 0 18px rgba(31, 247, 255, 0.04);
      padding: 0.5rem;
    }
    .ask-voice-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 0.5rem;
      border-bottom: 1px solid rgba(31, 247, 255, 0.18);
      color: var(--color-primary);
      font: 0.62rem/1 var(--font-heading);
      letter-spacing: 0;
      padding: 0 0 0.42rem;
    }
    .ask-voice-header > span {
      padding-top: 0.1rem;
    }
    .ask-voice-scope {
      display: grid;
      place-items: center;
      width: min(100%, 206px);
      aspect-ratio: 1 / 0.82;
      margin-top: 0.72rem;
      margin-left: auto;
      margin-right: auto;
      border: 1px solid rgba(31, 247, 255, 0.16);
      background:
        linear-gradient(90deg, rgba(31, 247, 255, 0.045) 1px, transparent 1px),
        linear-gradient(rgba(31, 247, 255, 0.035) 1px, transparent 1px),
        rgba(0, 0, 0, 0.28);
      background-size: 18px 100%, 100% 18px, auto;
      overflow: hidden;
      position: relative;
    }
    .ask-voice-scope::before,
    .ask-voice-scope::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .ask-voice-scope::before {
      background: linear-gradient(180deg, transparent 0 48%, rgba(31, 247, 255, 0.08) 50%, transparent 52% 100%);
    }
    .ask-voice-scope::after {
      background: linear-gradient(90deg, transparent 0 48%, rgba(31, 247, 255, 0.065) 50%, transparent 52% 100%);
    }
    .mapper-livekit-aura {
      width: 100%;
      height: 100%;
      display: block;
      overflow: hidden;
      background:
        radial-gradient(circle at center, rgba(31, 247, 255, 0.05), transparent 58%),
        transparent;
      transform: translateY(8%);
    }
    .ask-voice-status,
    .ask-voice-heard {
      color: var(--color-text-muted);
      font: 0.66rem/1.35 var(--font-body);
      margin-top: 0.5rem;
      min-height: 1.65rem;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.55rem;
      align-items: start;
      overflow-wrap: anywhere;
    }
    .ask-voice-meter {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) 2.4rem;
      gap: 0.45rem;
      align-items: center;
      margin-top: 0.5rem;
      color: var(--color-text-muted);
      font: 0.62rem/1 var(--font-heading);
    }
    .ask-voice-meter span,
    .ask-voice-diagnostics summary {
      color: var(--color-primary);
      font-family: var(--font-heading);
      text-transform: uppercase;
    }
    .ask-voice-meter-track {
      height: 8px;
      border: 1px solid rgba(31, 247, 255, 0.18);
      background:
        repeating-linear-gradient(90deg, rgba(31, 247, 255, 0.08) 0 1px, transparent 1px 7px),
        rgba(255, 255, 255, 0.025);
      overflow: hidden;
    }
    .ask-voice-meter-track i {
      display: block;
      width: 100%;
      height: 100%;
      transform-origin: left center;
      background: linear-gradient(90deg, rgba(31, 247, 255, 0.25), rgba(31, 247, 255, 0.86));
      box-shadow: 0 0 10px rgba(31, 247, 255, 0.22);
      transition: transform 0.08s linear;
    }
    .ask-voice-meter b {
      color: var(--color-text-muted);
      font-weight: 400;
      text-align: right;
      font-family: var(--font-body);
    }
    .ask-voice-mini-transcript {
      display: grid;
      margin-top: 0.5rem;
      padding: 0.45rem;
      border: 1px solid rgba(31, 247, 255, 0.14);
      background:
        linear-gradient(rgba(31, 247, 255, 0.035) 1px, transparent 1px),
        rgba(0, 0, 0, 0.16);
      background-size: 100% 16px, auto;
      min-height: 3.8rem;
    }
    .ask-voice-mini-transcript div {
      display: grid;
      gap: 0.3rem;
      max-height: 3.6rem;
      overflow-y: auto;
      scrollbar-width: thin;
    }
    .ask-voice-mini-transcript p {
      margin: 0;
      color: var(--color-text);
      font: 0.68rem/1.35 var(--font-body);
      overflow-wrap: anywhere;
    }
    .ask-voice-mini-transcript p[data-final="false"] {
      color: var(--color-text-muted);
      font-style: italic;
    }
    .ask-voice-heard {
      margin-top: 0.25rem;
      padding-top: 0.35rem;
      border-top: 1px solid rgba(31, 247, 255, 0.12);
    }
    .ask-voice-status span,
    .ask-voice-heard span {
      color: var(--color-primary);
    }
    .ask-voice-status b,
    .ask-voice-heard b {
      color: var(--color-text-muted);
      font-weight: 400;
    }
    .ask-voice-actions {
      display: grid;
      margin-top: 0.45rem;
    }
    .ask-voice-actions button {
      display: grid;
      justify-items: center;
      gap: 0.22rem;
      border: 1px solid rgba(31, 247, 255, 0.24);
      border-radius: 0 !important;
      min-height: 40px;
      color: var(--color-text);
      background: rgba(31, 247, 255, 0.045);
      text-align: center;
      touch-action: none;
      user-select: none;
    }
    .ask-voice-actions button small {
      color: var(--color-text-muted);
      font: 0.58rem/1.15 var(--font-body);
      text-transform: none;
    }
    .ask-voice-actions button.is-hot {
      border-color: rgba(31, 247, 255, 0.72);
      background: rgba(31, 247, 255, 0.16);
      color: var(--color-primary);
      box-shadow: 0 0 16px rgba(31, 247, 255, 0.18), inset 0 0 18px rgba(31, 247, 255, 0.08);
    }
    .ask-voice-diagnostics {
      position: relative;
      margin: 0;
      color: var(--color-text-muted);
      font: 0.62rem/1.35 var(--font-body);
    }
    .ask-voice-diagnostics summary {
      cursor: pointer;
      max-width: 8.8rem;
      text-align: right;
      list-style: none;
      white-space: nowrap;
    }
    .ask-voice-diagnostics summary::-webkit-details-marker {
      display: none;
    }
    .ask-voice-diagnostics summary::before {
      content: "[+] ";
      color: var(--color-primary);
    }
    .ask-voice-diagnostics[open] summary::before {
      content: "[-] ";
    }
    .ask-voice-diagnostics[open] {
      z-index: 3;
    }
    .ask-voice-diagnostics-menu {
      display: none;
      position: absolute;
      top: calc(100% + 0.35rem);
      right: 0;
      width: min(250px, 76vw);
      border: 1px solid rgba(31, 247, 255, 0.18);
      background: rgba(3, 9, 18, 0.94);
      box-shadow: 0 0 18px rgba(31, 247, 255, 0.08);
      padding: 0.55rem;
    }
    .ask-voice-diagnostics[open] .ask-voice-diagnostics-menu {
      display: block;
    }
    .ask-voice-disconnect {
      width: 100%;
      min-height: 28px;
      margin-top: 0.45rem;
      border: 1px solid rgba(255, 184, 92, 0.28);
      border-radius: 0;
      background: rgba(255, 184, 92, 0.06);
      color: var(--color-text-muted);
      font: 0.62rem/1 var(--font-heading);
      text-transform: uppercase;
      cursor: pointer;
    }
    .ask-voice-mic {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.25rem 0.55rem;
      margin-top: 0.45rem;
      padding-top: 0.45rem;
      border-top: 1px solid rgba(31, 247, 255, 0.12);
      color: var(--color-text-muted);
      font: 0.62rem/1.3 var(--font-body);
      overflow-wrap: anywhere;
    }
    .ask-voice-mic span {
      color: var(--color-primary);
      font-family: var(--font-heading);
      text-transform: uppercase;
    }
    .ask-voice-mic b {
      color: var(--color-text);
      font-weight: 600;
    }
    .ask-voice-mic small {
      grid-column: 2;
      color: var(--color-text-muted);
      font: inherit;
    }
    .ask-voice-mic-error b,
    .ask-voice-mic-error small {
      color: #ffb85c;
    }
    .ask-voice-mic-ready b {
      color: var(--color-primary);
    }
    @media (max-width: 720px) {
      .ask-voice-shell {
        justify-items: stretch;
      }
      .ask-mode-buttons,
      .ask-voice-card {
        width: 100%;
      }
      .ask-voice-scope {
        width: min(100%, 200px);
      }
    }
  `;
  document.head.appendChild(style);
}
