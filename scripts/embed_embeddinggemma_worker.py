#!/usr/bin/env python3
"""Persistent local EmbeddingGemma worker.

The Node Ask server uses this process to avoid reloading the model for every
typed question. Protocol is JSON lines over stdin/stdout:

Input:
  {"id":"request-1","items":[{"id":"query","text":"..."}],"prompt_name":"Retrieval-query"}

Output:
  {"id":"request-1","items":[{"id":"query","embedding":[...]}]}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any


DEFAULT_MODEL = "google/embeddinggemma-300M"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent local EmbeddingGemma JSONL worker.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--dimensions", type=int, default=None)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--no-normalize", action="store_true")
    return parser.parse_args()


def load_model(args: argparse.Namespace):
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise SystemExit(
            "Missing sentence-transformers. Run: pip install -r requirements-embeddinggemma.txt"
        ) from exc

    kwargs: dict[str, Any] = {}
    if args.dimensions:
        kwargs["truncate_dim"] = args.dimensions

    try:
        model = SentenceTransformer(args.model, **kwargs)
    except TypeError:
        model = SentenceTransformer(args.model)

    if args.device and args.device != "auto":
        model = model.to(device=args.device)
    return model


def normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def coerce_vector(raw_vector: Any, dimensions: int | None, normalize_output: bool) -> list[float]:
    if hasattr(raw_vector, "tolist"):
        raw_vector = raw_vector.tolist()
    vector = [float(value) for value in raw_vector]
    if dimensions and len(vector) > dimensions:
        vector = vector[:dimensions]
    if normalize_output:
        vector = normalize(vector)
    if not vector or any(not math.isfinite(value) for value in vector):
        raise ValueError("EmbeddingGemma returned an empty or non-finite vector.")
    return vector


def encode(model: Any, texts: list[str], args: argparse.Namespace, prompt_name: str | None):
    encode_kwargs: dict[str, Any] = {
        "batch_size": args.batch_size,
        "convert_to_numpy": True,
        "normalize_embeddings": not args.no_normalize,
        "show_progress_bar": False,
    }
    if prompt_name and prompt_name not in ("none", "None", "null"):
        encode_kwargs["prompt_name"] = prompt_name

    try:
        return model.encode(texts, **encode_kwargs)
    except TypeError:
        encode_kwargs.pop("prompt_name", None)
        return model.encode(texts, **encode_kwargs)


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    args = parse_args()
    model = load_model(args)
    emit({"type": "ready", "model": args.model, "dimensions": args.dimensions})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = request.get("id")
            items = request.get("items") or []
            texts = [str(item.get("text", "")) for item in items]
            embeddings = encode(model, texts, args, request.get("prompt_name"))
            output_items = []
            for item, embedding in zip(items, embeddings):
                output_items.append({
                    "id": item.get("id"),
                    "embedding": coerce_vector(embedding, args.dimensions, not args.no_normalize),
                })
            emit({"id": request_id, "items": output_items})
        except Exception as exc:
            emit({"id": request.get("id") if "request" in locals() else None, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
