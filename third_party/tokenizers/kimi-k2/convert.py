"""Convert pinned Kimi sources locally, without executing upstream Python.

Usage: python convert.py ranks_file wrapper_py config_json output_path
Output is compact UTF-8 JSON, or deterministic gzip when output_path ends in .gz.
The uncompressed SHA-256 is independent of the local zlib version.
"""

import argparse
import ast
import base64
import gzip
import hashlib
import json
from pathlib import Path


def class_constant(cls, name):
    return next(
        node.value for node in cls.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)
    )


def convert(ranks_file, wrapper_py, config_json):
    ranks = ranks_file.read_bytes().decode('utf-8')
    lines = ranks.splitlines()
    for expected_rank, line in enumerate(lines):
        token, rank = line.split()
        base64.b64decode(token, validate=True)
        if int(rank) != expected_rank:
            raise ValueError('Expected consecutive Kimi vocabulary ranks')
    if len(lines) != 163584:
        raise ValueError('Expected the pinned Kimi K2 vocabulary of 163584 tokens')

    tree = ast.parse(wrapper_py.read_text(encoding='utf-8'))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
               and node.name == 'TikTokenTokenizer')
    pattern = class_constant(cls, 'pat_str')
    if not (isinstance(pattern, ast.Call) and isinstance(pattern.func, ast.Attribute)
            and pattern.func.attr == 'join' and isinstance(pattern.func.value, ast.Constant)
            and pattern.func.value.value == '|' and len(pattern.args) == 1
            and not pattern.keywords):
        raise ValueError('Expected a literal pattern list joined with |')
    pieces = ast.literal_eval(pattern.args[0])
    if not isinstance(pieces, list) or len(pieces) != 8 or not all(isinstance(p, str) for p in pieces):
        raise ValueError('Expected eight literal Kimi regex strings')
    reserved = ast.literal_eval(class_constant(cls, 'num_reserved_special_tokens'))
    if reserved != 256:
        raise ValueError('Expected 256 reserved Kimi special tokens')

    config = json.loads(config_json.read_text(encoding='utf-8'))
    special = {
        config['added_tokens_decoder'].get(str(token_id), {}).get(
            'content', f'<|reserved_token_{token_id}|>'): token_id
        for token_id in range(len(lines), len(lines) + reserved)
    }
    if len(special) != reserved:
        raise ValueError('Duplicate Kimi special token spelling')
    data = {'bpe_ranks': ranks, 'pat_str': '|'.join(pieces), 'special_tokens': special}
    return (json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('ranks_file', 'wrapper_py', 'config_json', 'output_path'):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    raw = convert(args.ranks_file, args.wrapper_py, args.config_json)
    output = raw
    if args.output_path.suffix == '.gz':
        compressed = bytearray(gzip.compress(raw, compresslevel=9, mtime=0))
        compressed[9] = 3  # Stable gzip OS byte, matching the bundled Node gzip.
        output = bytes(compressed)
    args.output_path.write_bytes(output)
    print(json.dumps({'sha256': hashlib.sha256(output).hexdigest(),
                      'uncompressedSha256': hashlib.sha256(raw).hexdigest(),
                      'bytes': len(output), 'uncompressedBytes': len(raw)}))


if __name__ == '__main__':
    main()
