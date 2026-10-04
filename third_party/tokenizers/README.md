# Local tokenizer assets

These vocabularies are bundled for offline token estimation. Uimori does not
download tokenizer files or call a provider's token-counting API at runtime.
Model weights, Python and Transformers are not runtime dependencies.

Each family directory owns its upstream license/notice, pinned revision, source
URLs and SHA-256 hashes in `SOURCE.json`. JSON/rank assets are gzip-compressed;
the server reads only a selected family when it is first needed. The tokenizer
registry retains at most three recently used instances. The separate bounded
text cache stores hashes and counts rather than entire manuscripts or token IDs.

| Directory | Upstream | License | Runtime |
| --- | --- | --- | --- |
| `gemini-gemma3` | Google's pinned Gemma 3 SentencePiece file, used by the Google Gen AI SDK | Apache-2.0 | Converted HF BPE JSON |
| `gemini-gemma4` | `google/gemma-4-E4B-it`, used by the Google Gen AI SDK | Apache-2.0 | HF JSON |
| `deepseek-v3` | `deepseek-ai/DeepSeek-V3.2` | MIT | HF JSON |
| `deepseek-v4` | `deepseek-ai/DeepSeek-V4-Pro` | MIT | HF JSON |
| `deepseek-v4.1` | `deepseek-ai/DeepSeek-V4.1-Flash` | MIT | HF JSON |
| `glm-4.7` | `zai-org/GLM-4.7` | Model-card MIT declaration; see the accompanying notice provenance | HF JSON |
| `glm-5` | `zai-org/GLM-5.2` | MIT | HF JSON |
| `kimi-k2` | `moonshotai/Kimi-K2.5` | Modified MIT; preserve its additional attribution conditions | tiktoken ranks and pattern |
| `claude-legacy` | `anthropics/anthropic-tokenizer-typescript` | MIT | tiktoken ranks and NFKC |

OpenAI's `o200k_base`/`cl100k_base` data comes from the existing MIT-licensed
`tiktoken` package. Its lite WASM runtime is also loaded on demand. HF JSON files
use Apache-2.0 `@huggingface/tokenizers`, a tokenizer-only package with no runtime
dependencies. Package licenses remain in their installed distributions.

Claude's public legacy tokenizer is only an approximation for Claude 3 and later.
Grok's current API models have no verified bundled local tokenizer; their explicit
approximate profile uses o200k. Unknown model IDs also use this generic estimate.
Automatic model mapping is reviewed code, not an assertion that a provider alias
will always retain the same tokenizer. Manual selection is available in model
settings without changing the remote model or its generation options.

## Updating and verification

Updates are deliberate source changes. Fetch the exact upstream revision, retain
its license and record original byte hashes before changing a bundled asset.
Ordinary HF JSON files are compressed unchanged. Gemma 3 and Kimi have explicit
conversion steps in their manifests; their converters take local inputs only.
Do not execute a model repository's Python wrappers or download model weights.

The checked-in reference vectors were generated independently with the pinned
Python SentencePiece/tokenizers/tiktoken versions listed in each manifest. Those
tools are development-only. `tests/local-tokenizers.test.ts` compares counts with
the reference vectors, verifies bundled file hashes and checks lazy loading,
bounded instance retention and offline fallback.

The request estimator counts serialized request JSON in bounded 4,096 UTF-16-unit
pieces and retains the existing 10% admission headroom. Chunk boundaries, chat
templates, provider overhead and media processing can differ from server-side
accounting. A local tokenizer match is not an exact billed-token guarantee.
Provider-reported usage stays separate and is preferred for displayed request
usage when it represents one request. Older frozen snapshots keep their recorded
estimator instead of acquiring a different counting policy on replay.
