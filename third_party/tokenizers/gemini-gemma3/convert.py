"""Recreate the pinned Gemma 3 JSON assets offline using SOURCE.json versions."""

import argparse
import gzip
import hashlib
import importlib.metadata
import json
from pathlib import Path


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Pinned original SentencePiece model")
    parser.add_argument("output", type=Path, help="Directory for the two generated gzip files")
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    source = json.loads((directory / "SOURCE.json").read_text(encoding="utf-8"))
    for package, expected in source["buildDependencies"].items():
        actual = importlib.metadata.version(package)
        if actual != expected:
            raise RuntimeError(f"{package} version mismatch: expected {expected}, got {actual}")

    import sentencepiece
    from sentencepiece import sentencepiece_model_pb2
    from tokenizers import AddedToken, Tokenizer, decoders, models, normalizers
    from transformers.convert_slow_tokenizer import generate_merges

    original = args.input.read_bytes()
    expected_input = next(item["sha256"] for item in source["upstreamSources"]
                          if item["name"] == "original.spiece.model")
    if sha256(original) != expected_input:
        raise RuntimeError("Input SHA256 does not match the pinned model in SOURCE.json")
    proto = sentencepiece_model_pb2.ModelProto()
    proto.ParseFromString(original)
    normalization = proto.normalizer_spec
    if (proto.trainer_spec.model_type != 2 or normalization.name != "identity"
            or normalization.add_dummy_prefix or normalization.remove_extra_whitespaces
            or normalization.precompiled_charsmap):
        raise RuntimeError("Unexpected SentencePiece model or normalization contract")

    vocab = {piece.piece: index for index, piece in enumerate(proto.pieces)}
    normal_vocab = {piece.piece: index for index, piece in enumerate(proto.pieces)
                    if piece.type == 1}
    scores = [(piece.piece, piece.score) for piece in proto.pieces if piece.type == 1]
    converted = Tokenizer(models.BPE(
        vocab=vocab, merges=generate_merges(normal_vocab, scores),
        unk_token=proto.trainer_spec.unk_piece, fuse_unk=True,
        byte_fallback=True, dropout=None,
    ))
    converted.normalizer = normalizers.Replace(" ", "▁")
    converted.decoder = decoders.Sequence([
        decoders.Replace("▁", " "), decoders.ByteFallback(), decoders.Fuse(),
    ])
    # SentencePiece whitespace pieces match after escaping spaces. CONTROL
    # literals remain ordinary text; only USER_DEFINED pieces become added tokens.
    converted.add_tokens([
        AddedToken(piece.piece, normalized=True, special=False)
        for piece in proto.pieces if piece.type == 4
    ])
    reference = sentencepiece.SentencePieceProcessor(model_proto=original)
    vectors = json.loads((directory / "reference-vectors.json").read_text(encoding="utf-8"))["vectors"]
    for vector in vectors:
        expected = reference.encode(vector["text"], out_type=int)
        actual = converted.encode(vector["text"], add_special_tokens=False).ids
        if expected != vector["ids"] or actual != expected:
            raise RuntimeError(f"Reference parity failed for {vector['text']!r}")

    outputs = {
        "tokenizer.json.gz": converted.to_str().encode("utf-8"),
        "tokenizer_config.json.gz": (
            b'{"tokenizer_class":"GemmaTokenizer","clean_up_tokenization_spaces":false}\n'
        ),
    }
    encoded = {}
    for name, raw in outputs.items():
        compressed = bytearray(gzip.compress(raw, compresslevel=9, mtime=0))
        compressed[9] = 10  # Preserve the shipped Windows gzip header across platforms.
        compressed = bytes(compressed)
        expected = next(item for item in source["assets"] if item["file"] == name)
        if (sha256(raw) != expected["uncompressedSha256"]
                or sha256(compressed) != expected["sha256"]):
            raise RuntimeError(f"Recreated bytes differ from SOURCE.json for {name}")
        encoded[name] = compressed

    args.output.mkdir(parents=True, exist_ok=True)
    for name, content in encoded.items():
        (args.output / name).write_bytes(content)
        print(f"{name}: {len(content)} bytes, SHA256 {sha256(content)}")
    print(f"Original SentencePiece and converted JSON parity: {len(vectors)} vectors PASS")


if __name__ == "__main__":
    main()
