#!/usr/bin/env python3
"""Local-only LiveKit microphone-to-transcript bridge for Mapper.

This process joins the local LiveKit room, subscribes to browser microphone
audio, transcribes speech with a local faster-whisper model, and publishes final
question text back to the frontend over a LiveKit data channel.

It does not call cloud STT, does not answer questions, and does not persist
audio. The existing local Ask-the-Map server handles retrieval and evidence.
"""

from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import math
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import numpy as np


TRANSCRIPT_TOPIC = "mapper.transcript"
VOICE_STATUS_TOPIC = "mapper.voice_status"
DEFAULT_TOKEN_ENDPOINT = "http://127.0.0.1:8787/api/livekit-token"
DEFAULT_ROOM = "mapper-local"
DEFAULT_IDENTITY = "mapper-stt-bridge"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Local LiveKit STT bridge for Mapper voice questions."
    )
    parser.add_argument("--token-endpoint", default=os.getenv("MAPPER_LIVEKIT_TOKEN_ENDPOINT", DEFAULT_TOKEN_ENDPOINT))
    parser.add_argument("--room", default=os.getenv("MAPPER_LIVEKIT_ROOM", DEFAULT_ROOM))
    parser.add_argument("--identity", default=os.getenv("MAPPER_LIVEKIT_IDENTITY", DEFAULT_IDENTITY))
    parser.add_argument("--model", default=os.getenv("MAPPER_STT_MODEL", "base.en"))
    parser.add_argument("--device", default=os.getenv("MAPPER_STT_DEVICE", "auto"))
    parser.add_argument("--compute-type", default=os.getenv("MAPPER_STT_COMPUTE_TYPE", "int8"))
    parser.add_argument("--language", default=os.getenv("MAPPER_STT_LANGUAGE", "en"))
    parser.add_argument("--vad-filter", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--speech-threshold", type=float, default=float(os.getenv("MAPPER_STT_SPEECH_THRESHOLD", "0.012")))
    parser.add_argument("--min-utterance-ms", type=int, default=int(os.getenv("MAPPER_STT_MIN_UTTERANCE_MS", "450")))
    parser.add_argument("--silence-ms", type=int, default=int(os.getenv("MAPPER_STT_SILENCE_MS", "850")))
    parser.add_argument("--max-utterance-ms", type=int, default=int(os.getenv("MAPPER_STT_MAX_UTTERANCE_MS", "15000")))
    parser.add_argument("--stdin", action="store_true", help="Manual test mode: publish each stdin line as a final transcript.")
    return parser.parse_args()


def require_livekit():
    try:
        from livekit import rtc  # type: ignore
    except Exception as exc:  # pragma: no cover - only hit when deps are missing locally.
        raise SystemExit(
            "Missing LiveKit Python SDK. Run `npm run setup:voice` first."
        ) from exc
    return rtc


def require_whisper():
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:  # pragma: no cover - only hit when deps are missing locally.
        raise SystemExit(
            "Missing faster-whisper. Run `npm run setup:voice` first."
        ) from exc
    return WhisperModel


def fetch_livekit_token(endpoint: str, room: str, identity: str) -> dict[str, Any]:
    body = json.dumps({"room": room, "identity": identity}).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise SystemExit(
            f"Could not reach Mapper token endpoint at {endpoint}. "
            "Start `npm run ask:server` first."
        ) from exc


async def maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def publish_json(room: Any, topic: str, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    published = room.local_participant.publish_data(data, reliable=True, topic=topic)
    await maybe_await(published)


async def publish_status(room: Any, state: str, detail: str = "") -> None:
    await publish_json(
        room,
        VOICE_STATUS_TOPIC,
        {
            "state": state,
            "detail": detail,
            "ts": round(time.time(), 3),
            "local_only": True,
        },
    )


async def publish_transcript(room: Any, text: str) -> None:
    await publish_json(
        room,
        TRANSCRIPT_TOPIC,
        {
            "text": text,
            "final": True,
            "source": "local-livekit-stt",
            "local_only": True,
        },
    )


@dataclass
class SpeechSegmenter:
    threshold: float
    min_utterance_ms: int
    silence_ms: int
    max_utterance_ms: int
    target_rate: int = 16000
    active: bool = False
    silence_samples: int = 0
    buffer: list[np.ndarray] = field(default_factory=list)

    def push(self, samples: np.ndarray, sample_rate: int) -> np.ndarray | None:
        samples = resample_mono(samples, sample_rate, self.target_rate)
        if samples.size == 0:
            return None

        rms = float(math.sqrt(float(np.mean(np.square(samples)))))
        speech = rms >= self.threshold

        if speech:
            self.active = True
            self.silence_samples = 0
            self.buffer.append(samples)
        elif self.active:
            self.silence_samples += samples.size
            self.buffer.append(samples)

        if not self.active:
            return None

        total_samples = sum(part.size for part in self.buffer)
        silence_limit = int(self.target_rate * self.silence_ms / 1000)
        min_samples = int(self.target_rate * self.min_utterance_ms / 1000)
        max_samples = int(self.target_rate * self.max_utterance_ms / 1000)

        should_flush = (
            (self.silence_samples >= silence_limit and total_samples >= min_samples)
            or total_samples >= max_samples
        )
        if not should_flush:
            return None
        return self.flush()

    def flush(self) -> np.ndarray | None:
        if not self.buffer:
            self.active = False
            self.silence_samples = 0
            return None
        segment = np.concatenate(self.buffer).astype(np.float32, copy=False)
        self.buffer.clear()
        self.active = False
        self.silence_samples = 0
        return segment


def frame_to_mono_float32(frame: Any) -> tuple[np.ndarray, int]:
    data = getattr(frame, "data", b"")
    sample_rate = int(getattr(frame, "sample_rate", 48000) or 48000)
    channels = max(1, int(getattr(frame, "num_channels", 1) or 1))
    pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1 and pcm.size >= channels:
        pcm = pcm[: pcm.size - (pcm.size % channels)].reshape(-1, channels).mean(axis=1)
    return pcm, sample_rate


def resample_mono(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate:
        return samples.astype(np.float32, copy=False)
    if samples.size < 2:
        return samples.astype(np.float32, copy=False)
    duration = samples.size / float(source_rate)
    target_size = max(1, int(duration * target_rate))
    old_x = np.linspace(0.0, duration, num=samples.size, endpoint=False)
    new_x = np.linspace(0.0, duration, num=target_size, endpoint=False)
    return np.interp(new_x, old_x, samples).astype(np.float32)


def is_audio_track(rtc: Any, track: Any) -> bool:
    kind = getattr(track, "kind", None)
    audio_kind = getattr(getattr(rtc, "TrackKind", object), "KIND_AUDIO", None)
    return kind == audio_kind or "audio" in str(kind).lower()


def transcribe_segment(model: Any, audio: np.ndarray, language: str, vad_filter: bool) -> str:
    segments, _info = model.transcribe(
        audio,
        language=language or None,
        vad_filter=vad_filter,
        beam_size=1,
        condition_on_previous_text=False,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    return " ".join(text.split())


async def process_audio_track(
    rtc: Any,
    track: Any,
    participant_identity: str,
    queue: asyncio.Queue[tuple[str, np.ndarray]],
    args: argparse.Namespace,
) -> None:
    segmenter = SpeechSegmenter(
        threshold=args.speech_threshold,
        min_utterance_ms=args.min_utterance_ms,
        silence_ms=args.silence_ms,
        max_utterance_ms=args.max_utterance_ms,
    )
    stream = rtc.AudioStream(track)
    try:
        async for event in stream:
            frame = getattr(event, "frame", event)
            samples, sample_rate = frame_to_mono_float32(frame)
            segment = segmenter.push(samples, sample_rate)
            if segment is not None:
                await queue.put((participant_identity, segment))
    except asyncio.CancelledError:
        segment = segmenter.flush()
        if segment is not None:
            await queue.put((participant_identity, segment))
        raise


async def transcription_worker(
    room: Any,
    model: Any,
    queue: asyncio.Queue[tuple[str, np.ndarray]],
    args: argparse.Namespace,
) -> None:
    last_text = ""
    while True:
        participant_identity, audio = await queue.get()
        try:
            await publish_status(room, "transcribing", participant_identity)
            text = await asyncio.to_thread(
                transcribe_segment,
                model,
                audio,
                args.language,
                args.vad_filter,
            )
            if not text or text == last_text:
                await publish_status(room, "listening", "No final speech detected")
                continue
            last_text = text
            await publish_status(room, "searching", text)
            await publish_transcript(room, text)
            print(f"[voice] transcript: {text}", flush=True)
        except Exception as exc:
            await publish_status(room, "error", str(exc))
            print(f"[voice] transcription error: {exc}", file=sys.stderr, flush=True)
        finally:
            queue.task_done()


async def publish_stdin_lines(room: Any) -> None:
    await publish_status(room, "listening", "stdin test mode")
    print("[voice] stdin mode. Type a question and press return.", flush=True)
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    while True:
        line_bytes = await reader.readline()
        line = line_bytes.decode("utf-8", errors="replace")
        if not line:
            return
        text = line.strip()
        if not text:
            continue
        await publish_status(room, "searching", text)
        await publish_transcript(room, text)


async def main() -> None:
    args = parse_args()
    rtc = require_livekit()
    token_info = fetch_livekit_token(args.token_endpoint, args.room, args.identity)
    room = rtc.Room()
    stop_event = asyncio.Event()
    tasks: set[asyncio.Task[Any]] = set()
    audio_queue: asyncio.Queue[tuple[str, np.ndarray]] = asyncio.Queue()

    def stop() -> None:
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop)
        except NotImplementedError:
            pass

    if not args.stdin:
        WhisperModel = require_whisper()
        print(f"[voice] Loading local STT model: {args.model}", flush=True)
        model = await asyncio.to_thread(
            WhisperModel,
            args.model,
            device=args.device,
            compute_type=args.compute_type,
        )
        tasks.add(asyncio.create_task(transcription_worker(room, model, audio_queue, args)))

    @room.on("track_subscribed")
    def on_track_subscribed(track: Any, _publication: Any, participant: Any) -> None:
        if not is_audio_track(rtc, track):
            return
        identity = getattr(participant, "identity", "remote-participant")
        print(f"[voice] Subscribed to audio from {identity}", flush=True)
        task = loop.create_task(process_audio_track(rtc, track, identity, audio_queue, args))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    url = token_info.get("url")
    token = token_info.get("token")
    if not url or not token:
        raise SystemExit("Token endpoint did not return a LiveKit url and token.")

    print(f"[voice] Connecting to {url} room={token_info.get('room', args.room)}", flush=True)
    await room.connect(url, token)
    await publish_status(room, "listening", "Ready for local microphone audio")
    print("[voice] Connected. Waiting for microphone audio.", flush=True)

    stdin_task = None
    if args.stdin:
        stdin_task = asyncio.create_task(publish_stdin_lines(room))
        tasks.add(stdin_task)

    try:
        await stop_event.wait()
    finally:
        for task in list(tasks):
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await maybe_await(room.disconnect())
        except Exception:
            pass
        print("[voice] Disconnected.", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
