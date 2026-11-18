/**
 * Bundled helper workspace scripts. They are written into each task workspace as ordinary
 * files, so the helper may run, read or adapt them; they are conveniences, not app operations.
 */
export const REPETITION_SCRIPT =
  String.raw`#!/usr/bin/env python3
"""Find phrases repeated across recent scenes of an exported chat.

Usage:
  uimori export '{"scope":"chats","id":"<chat-id>"}' >/dev/null
  python3 tools/repetition.py chats/<chat-id> [--target original|translation|both]
      [--scenes 20] [--n 4] [--min-scenes 3] [--top 20] [--ignore PHRASE ...]
      [--all-words] [--json]

Reads chats/<id>/scenes.json, scenes/*.txt and the read-only translations/*.txt copies.
Disabled scenes are skipped. A translation whose original working file was edited after
export is reported as stale and skipped. Fenced blocks (including uimori-ui), HTML tags,
{{macros}} and image markdown are removed before counting.

Phrases are word n-grams; overlapping n-grams that occur in the same scenes are merged
into one longer phrase. Korean words are also compared with their last syllable trimmed
(loose mode) so endings such as 흔들렸다/흔들렸고 match. By default an English phrase
needs at least two content words; --all-words keeps function-word phrases.
This is a signal for a writer to review, not a verdict: motifs, verbal tics and fixed
status lines repeat on purpose. Use --ignore for those.
"""
import argparse, hashlib, json, os, re, sys, unicodedata

STOP = set(
    "the a an of to in on at with and or but her his him she he it its they them their i you "
    "my your me we our is was were be been had has have that this from for by as into onto over "
    "under up down out off one than then there what which who not no so just like".split()
)
HANGUL = re.compile(r"[가-힣]")
WORD = re.compile(r"[\w'’]+", re.UNICODE)


def clean(text):
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"(?s)` +
  '```' +
  String.raw`.*?` +
  '```' +
  String.raw`", " ", text)
    text = re.sub(r"(?s)<a2ui>.*?</a2ui>", " ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\{\{[^}]*\}\}", " ", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    return text


def words(text, loose):
    tokens = [t for t in WORD.findall(clean(text).lower()) if not t.isdigit() or len(t) > 1]
    if loose:
        tokens = [t[:-1] if HANGUL.search(t) and len(t) > 2 else t for t in tokens]
    return tokens


def load(chat_dir, target):
    scenes = json.load(open(os.path.join(chat_dir, "scenes.json"), encoding="utf-8"))
    workspace = os.path.dirname(os.path.dirname(os.path.abspath(chat_dir)))
    translations = {}
    path = os.path.join(chat_dir, "translations.json")
    if os.path.exists(path):
        translations = {t["sourceId"]: t for t in json.load(open(path, encoding="utf-8"))}
    out, stale, missing = [], [], 0
    for scene in scenes:
        if not scene.get("sceneEnabled", True):
            continue
        original = open(os.path.join(workspace, scene["file"]), encoding="utf-8").read()
        if target == "original":
            out.append((scene["sceneNumber"], original))
            continue
        entry = translations.get(scene["sourceId"])
        if not entry:
            missing += 1
            continue
        if hashlib.sha256(original.encode("utf-8")).hexdigest() != entry["originalSha256"]:
            stale.append(scene["sceneNumber"])
            continue
        out.append((scene["sceneNumber"], open(os.path.join(workspace, entry["file"]), encoding="utf-8").read()))
    return out, stale, missing


def scan(scenes, n, min_scenes, top, ignore, all_words, loose):
    tokenized = [(number, words(text, loose)) for number, text in scenes]
    where = {}
    for number, tokens in tokenized:
        for gram in {tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1)}:
            where.setdefault(gram, set()).add(number)
    frequent = {g: s for g, s in where.items() if len(s) >= min_scenes}
    phrases = {}
    for number, tokens in tokenized:
        i = 0
        while i <= len(tokens) - n:
            gram = tuple(tokens[i:i + n])
            if gram not in frequent:
                i += 1
                continue
            scenes_of = frequent[gram]
            j = i
            while j + 1 <= len(tokens) - n and frequent.get(tuple(tokens[j + 1:j + 1 + n])) == scenes_of:
                j += 1
            phrase = " ".join(tokens[i:j + n])
            phrases[phrase] = scenes_of
            i = j + 1
    ignored = [unicodedata.normalize("NFC", p).lower() for p in ignore]
    ranked = []
    for phrase, scenes_of in phrases.items():
        if any(p in phrase for p in ignored):
            continue
        if not all_words and sum(1 for t in phrase.split() if t not in STOP) < 2:
            continue
        ranked.append({"phrase": phrase, "sceneCount": len(scenes_of), "scenes": sorted(scenes_of)})
    ranked.sort(key=lambda r: (-r["sceneCount"], -len(r["phrase"]), r["phrase"]))
    # A shorter phrase contained in a longer ranked one with the same scenes adds nothing.
    kept = []
    for r in ranked:
        if not any(r["phrase"] in k["phrase"] and r["scenes"] == k["scenes"] for k in kept):
            kept.append(r)
    return kept[:top]


def main():
    parser = argparse.ArgumentParser(description="Find phrases repeated across recent scenes.")
    parser.add_argument("chat_dir")
    parser.add_argument("--target", choices=["original", "translation", "both"], default="both")
    parser.add_argument("--scenes", type=int, default=20)
    parser.add_argument("--n", type=int, default=4)
    parser.add_argument("--min-scenes", type=int, default=3)
    parser.add_argument("--top", type=int, default=20)
    parser.add_argument("--ignore", nargs="*", default=[])
    parser.add_argument("--all-words", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if not os.path.exists(os.path.join(args.chat_dir, "scenes.json")):
        sys.exit("scenes.json not found: export the chat first with uimori export")
    report = []
    for target in (["original", "translation"] if args.target == "both" else [args.target]):
        scenes, stale, missing = load(args.chat_dir, target)
        scenes = scenes[-args.scenes:]
        section = {"target": target, "scenes": [s[0] for s in scenes], "staleTranslations": stale,
                   "untranslatedScenes": missing, "results": []}
        if len(scenes) >= args.min_scenes:
            loose_modes = [False, True] if any(HANGUL.search(t) for _, t in scenes) else [False]
            for loose in loose_modes:
                phrases = scan(scenes, args.n, args.min_scenes, args.top, args.ignore, args.all_words, loose)
                # Loose matching only adds information when it finds something different.
                if loose and phrases == section["results"][0]["phrases"]:
                    continue
                section["results"].append({"mode": "loose-korean" if loose else "exact", "phrases": phrases})
        report.append(section)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    for section in report:
        s = section["scenes"]
        print(f"## {section['target']}: {len(s)} scenes" + (f" ({s[0]}-{s[-1]})" if s else ""))
        if section["staleTranslations"]:
            print(f"stale translations skipped (original edited after export): {section['staleTranslations']}")
        if section["untranslatedScenes"]:
            print(f"scenes without a translation: {section['untranslatedScenes']}")
        if not section["results"]:
            print(f"fewer than {args.min_scenes} scenes; nothing to compare")
        for result in section["results"]:
            print(f"### {result['mode']}")
            if not result["phrases"]:
                print(f"no phrase appears in {args.min_scenes}+ scenes")
            for p in result["phrases"]:
                print(f"{p['sceneCount']:>3} scenes  \"{p['phrase']}\"  -> {','.join(map(str, p['scenes']))}")
        print()


if __name__ == "__main__":
    main()
`;
