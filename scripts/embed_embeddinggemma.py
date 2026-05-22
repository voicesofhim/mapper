#!/usr/bin/env python3
"""Local EmbeddingGemma sidecar for the accelerator importer.

Reads JSON from stdin:

    {"items": [{"id": "chunk-id", "text": "anonymized evidence text"}]}

Writes JSON to stdout:

    {"model": "...", "dimensions": 768, "items": [{"id": "chunk-id", "embedding": [...]}]}

This script is intentionally local-only. It sends no text to a remote embedding
API. Model download/auth is handled by Hugging Face/Sentence Transformers in the
developer's local environment.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any


DEFAULT_MODEL = "google/embeddinggemma-300M"
DEFAULT_PROMPT_NAME = "Retrieval-document"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Embed anonymized map chunks with local EmbeddingGemma.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Sentence Transformers model id.")
    parser.add_argument("--prompt-name", default=DEFAULT_PROMPT_NAME, help="EmbeddingGemma prompt name for documents.")
    parser.add_argument("--dimensions", type=int, default=None, help="Optional truncated embedding dimension.")
    parser.add_argument("--batch-size", type=int, default=16, help="Encode batch size.")
    parser.add_argument("--device", default="auto", help="auto, cpu, cuda, mps, etc.")
    parser.add_argument("--no-normalize", action="store_true", help="Disable output vector normalization.")
    return parser.parse_args()


def load_sentence_transformer(model_id: str, dimensions: int | None, device: str):
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise SystemExit(
            "Missing sentence-transformers. Create a local venv and run: "
            "pip install -r requirements-embeddinggemma.txt"
        ) from exc

    kwargs: dict[str, Any] = {}
    if dimensions:
        kwargs["truncate_dim"] = dimensions

    try:
        model = SentenceTransformer(model_id, **kwargs)
    except TypeError:
        model = SentenceTransformer(model_id)

    if device and device != "auto":
        model = model.to(device=device)
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


def encode(model: Any, texts: list[str], args: argparse.Namespace):
    encode_kwargs: dict[str, Any] = {
        "batch_size": args.batch_size,
        "convert_to_numpy": True,
        "normalize_embeddings": not args.no_normalize,
        "show_progress_bar": False,
    }
    prompt_name = None if args.prompt_name in ("", "none", "None", "null") else args.prompt_name
    if prompt_name:
        encode_kwargs["prompt_name"] = prompt_name

    try:
        return model.encode(texts, **encode_kwargs)
    except TypeError:
        encode_kwargs.pop("prompt_name", None)
        return model.encode(texts, **encode_kwargs)


def main() -> int:
    args = parse_args()
    payload = json.load(sys.stdin)
    items = payload.get("items", [])
    if not isinstance(items, list):
        raise ValueError("stdin JSON must contain an items array.")

    texts = [str(item.get("text", "")) for item in items]
    model = load_sentence_transformer(args.model, args.dimensions, args.device)
    embeddings = encode(model, texts, args)

    output_items = []
    first_dimensions = 0
    for item, embedding in zip(items, embeddings):
        vector = coerce_vector(embedding, args.dimensions, not args.no_normalize)
        first_dimensions = first_dimensions or len(vector)
        output_items.append({
            "id": item.get("id"),
            "embedding": vector,
        })

    json.dump({
        "model": args.model,
        "dimensions": first_dimensions,
        "items": output_items,
    }, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
