import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useAgent,
  useDataChannel,
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

  const setAskMode = useCallback((nextMode) => {
    setMode(nextMode);
    onModeChange?.(nextMode);
  }, [onModeChange]);

  const connectVoice = useCallback(async () => {
    setError('');
    setStatus('Preparing local LiveKit room');
    try {
      const endpoint = import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT || DEFAULT_TOKEN_ENDPOINT;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: DEFAULT_ROOM }),
      });
      if (!response.ok) throw new Error(`Token endpoint returned ${response.status}`);
      const payload = await response.json();
      setSession({
        token: payload.token,
        url: payload.url || import.meta.env.VITE_LIVEKIT_URL,
        room: payload.room || DEFAULT_ROOM,
      });
      setStatus('Connecting to local voice agent');
    } catch (err) {
      setError(err?.message || 'Could not connect to local LiveKit');
      setStatus('Local voice unavailable');
    }
  }, []);

  const disconnectVoice = useCallback(() => {
    setSession(null);
    setStatus('Local voice idle');
    setError('');
  }, []);

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
          {session?.token && session?.url ? (
            <LiveKitRoom
              serverUrl={session.url}
              token={session.token}
              connect
              audio
              video={false}
              onConnected={() => setStatus(`Local room: ${session.room}`)}
              onDisconnected={() => setStatus('Local voice disconnected')}
              onError={(err) => {
                setError(err?.message || 'LiveKit connection error');
                setStatus('Local voice unavailable');
              }}
            >
              <VoiceRoom onTranscript={onTranscript} setStatus={setStatus} />
            </LiveKitRoom>
          ) : (
            <IdleAura />
          )}

          <div className="ask-voice-status" aria-live="polite">
            {error || status}
          </div>
          <div className="ask-voice-actions">
            {session ? (
              <button type="button" onClick={disconnectVoice}>Disconnect</button>
            ) : (
              <button type="button" onClick={connectVoice}>Connect local</button>
            )}
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

function VoiceRoom({ onTranscript, setStatus }) {
  const agent = useAgent();
  const lastTranscriptRef = useRef('');
  const agentState = agent?.state || 'connecting';
  const audioTrack = agent?.microphoneTrack;

  useEffect(() => {
    setStatus(`Local voice: ${formatAgentState(agentState)}`);
  }, [agentState, setStatus]);

  useDataChannel((message) => {
    const transcript = readFinalTranscript(message);
    if (!transcript || transcript === lastTranscriptRef.current) return;
    lastTranscriptRef.current = transcript;
    onTranscript?.(transcript);
  });

  return (
    <>
      <AgentAudioVisualizerAura
        className="mapper-livekit-aura"
        state={agentState}
        audioTrack={audioTrack}
        color="#1ff7ff"
        colorShift={0.03}
        themeMode="dark"
        aria-label={`LiveKit Aura voice visualizer ${agentState}`}
      />
      <RoomAudioRenderer />
    </>
  );
}

function readFinalTranscript(message) {
  const topic = message?.topic || '';
  const decoded = decodePayload(message?.payload);
  if (!decoded) return '';

  const parsed = parseMaybeJson(decoded);
  const text = extractTranscriptText(parsed);
  const isFinal = extractFinalState(parsed, topic);
  return isFinal ? text.trim() : '';
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

function formatAgentState(state) {
  return String(state || 'idle').replace(/-/g, ' ');
}

function ensureVoiceStyles() {
  if (document.getElementById('ask-voice-mode-styles')) return;
  const style = document.createElement('style');
  style.id = 'ask-voice-mode-styles';
  style.textContent = `
    .ask-voice-shell {
      display: grid;
      justify-items: end;
      gap: 0.45rem;
    }
    .ask-mode-buttons {
      display: grid;
      grid-template-columns: repeat(2, minmax(54px, 1fr));
      border: 1px solid rgba(31, 247, 255, 0.28);
      background: rgba(31, 247, 255, 0.055);
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
      transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
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
      width: min(100%, 292px);
      border: 1px solid rgba(31, 247, 255, 0.26);
      background: rgba(3, 9, 18, 0.76);
      box-shadow: 0 0 26px rgba(31, 247, 255, 0.06);
      padding: 0.55rem;
    }
    .mapper-livekit-aura {
      width: 100%;
      height: 172px;
      display: block;
      overflow: hidden;
      background:
        radial-gradient(circle at center, rgba(31, 247, 255, 0.08), transparent 55%),
        rgba(0, 0, 0, 0.4);
    }
    .ask-voice-status {
      color: var(--color-text-muted);
      font: 0.66rem/1.35 var(--font-body);
      margin-top: 0.45rem;
      min-height: 1.75rem;
    }
    .ask-voice-actions {
      display: grid;
      margin-top: 0.45rem;
    }
    .ask-voice-actions button {
      border: 1px solid rgba(31, 247, 255, 0.24);
      min-height: 32px;
    }
    @media (max-width: 720px) {
      .ask-voice-shell {
        justify-items: stretch;
      }
      .ask-mode-buttons,
      .ask-voice-card {
        width: 100%;
      }
      .mapper-livekit-aura {
        height: 150px;
      }
    }
  `;
  document.head.appendChild(style);
}
