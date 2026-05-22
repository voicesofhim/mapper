# Ollama Embedding Provider PR

## Objective

Finish and verify the PR that adds a local Ollama embedding provider to the accelerator mapper pipeline.

## Original Request

Use GoalBuddy to implement, check, and push the PR for making the embedding part work with installed local models instead of only EmbeddingGemma.

## Intake Summary

- Input shape: `recovery`
- Audience: project maintainers and local research users
- Authority: `requested`
- Proof type: `test`
- Completion proof: the PR branch is pushed, the PR is open, focused tests/checks pass, and any known unrelated blocker is documented.
- Likely misfire: treating the PR as complete because the branch exists, while query embeddings, import embeddings, docs, or tests still have gaps.
- Blind spots considered: model/dimension mismatch, stale UMAP/vector indexes after model changes, live Ollama availability in CI, and existing unrelated build failures.
- Existing plan facts: preserve the already-open draft PR and push follow-up commits only if verification or audit finds issues.

## Goal Kind

`recovery`

## Current Tranche

Audit the existing PR implementation, apply any necessary narrow fixes, rerun focused verification, push the branch, and complete only after a final audit maps the result back to the user request.

## Non-Negotiable Constraints

- Keep the default EmbeddingGemma behavior working unless `ollama` is explicitly selected.
- Do not require a live Ollama daemon in tests.
- Do not mix embedding models or dimensions without documenting that embeddings and UMAP must be rebuilt.
- Do not include private data, vector blobs in frontend JSON, or credentials.
- Do not fix unrelated frontend build problems in this PR.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

## Canonical Board

Machine truth lives at:

`docs/goals/ollama-embedding-provider-pr/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/ollama-embedding-provider-pr/goal.md.
```
