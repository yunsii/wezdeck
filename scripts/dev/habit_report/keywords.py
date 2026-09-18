"""User-feed keyword frequency (jieba + stopwords + synonym merge).

Open-source core: jieba (seg / posseg). Pipeline:
  cleaned user text → jieba.posseg → drop stopwords/助词 → synonym map → Counter

Privacy: only keyword→count in summaries; never stores raw utterances.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_./-]{1,}|[\u4e00-\u9fff]{2,}")
# Language/syntax paste noise only — keep product verbs (via synonyms) like
# commit→提交, test→测试. Domain names (coco, next, server) stay countable.
_CODE_NOISE = frozenset(
    {
        "const",
        "let",
        "var",
        "tmp",
        "sha",
        "null",
        "true",
        "false",
        "undefined",
        "nan",
        "nil",
        "func",
        "def",
        "import",
        "export",
        "return",
        "async",
        "await",
        "class",
        "void",
        "int",
        "str",
        "bool",
        "this",
        "new",
        "typeof",
        "instanceof",
        "argv",
        "kwargs",
        "stdin",
        "stdout",
        "stderr",
        "idx",
        "len",
        "ptr",
        "ref",
        "val",
        "ctx",
        "req",
        "res",
        "dto",
        "orm",
        "uuid",
        "localhost",
        "undefined",
        "nullish",
        "todo",
        "fixme",
        "xxx",
        "asdf",
        "qwer",
        "lorem",
        "ipsum",
        "fake",
        "unknown",
        "nullish",
        "undefined",
        "side",
        "name",
        "value",
        "string",
        "number",
        "object",
        "array",
        "boolean",
    }
)

_JIEBA = None
_JIEBA_POS = None
_JIEBA_OK: bool | None = None


def _load_jieba():
    global _JIEBA, _JIEBA_POS, _JIEBA_OK
    if _JIEBA_OK is not None:
        return _JIEBA_OK
    try:
        import jieba
        import jieba.posseg as posseg

        jieba.setLogLevel(20)  # quiet INFO
        _JIEBA = jieba
        _JIEBA_POS = posseg
        _JIEBA_OK = True
    except ImportError:
        _JIEBA_OK = False
    return _JIEBA_OK


def _default_stopwords() -> set[str]:
    path = Path(__file__).with_name("stopwords_zh.txt")
    out: set[str] = set()
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            out.add(s.lower())
    return out


def _config_path() -> Path:
    import os

    env = os.environ.get("HABIT_KEYWORDS_CONFIG", "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / ".config/habit-weekly/keywords.json"


def load_keywords_config() -> dict[str, Any]:
    cfg: dict[str, Any] = {
        "enabled": True,
        "top_n": 40,
        "min_len": 2,
        "min_count": 2,
        "allow_pos": ["n", "nr", "ns", "nt", "nz", "v", "vn", "eng"],
        "extra_stopwords": [],
        "synonyms": {},
    }
    example = Path(__file__).with_name("keywords.example.json")
    if example.is_file():
        try:
            raw = json.loads(example.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                cfg.update({k: raw[k] for k in raw if k in cfg or k == "synonyms"})
        except (OSError, json.JSONDecodeError):
            pass
    path = _config_path()
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                cfg.update(raw)
                cfg["config_path"] = str(path)
        except (OSError, json.JSONDecodeError):
            pass
    return cfg


def _synonym_lookup(synonyms: dict[str, list[str]]) -> dict[str, str]:
    """Map variant → canonical."""
    out: dict[str, str] = {}
    for canon, variants in (synonyms or {}).items():
        canon_l = str(canon).strip().lower()
        if not canon_l:
            continue
        out[canon_l] = canon_l
        for v in variants or []:
            vl = str(v).strip().lower()
            if vl:
                out[vl] = canon_l
    return out


def _normalize_token(tok: str, syn: dict[str, str]) -> str:
    t = tok.strip().lower()
    if not t:
        return ""
    return syn.get(t, t)


def tokenize(text: str, cfg: dict[str, Any] | None = None) -> list[str]:
    """Return normalized content tokens (stopwords removed, synonyms merged)."""
    cfg = cfg or load_keywords_config()
    if not cfg.get("enabled", True):
        return []
    if not text or not text.strip():
        return []

    stop = _default_stopwords()
    for w in cfg.get("extra_stopwords") or []:
        stop.add(str(w).strip().lower())
    syn = _synonym_lookup(cfg.get("synonyms") or {})
    min_len = int(cfg.get("min_len") or 2)
    allow_pos = set(cfg.get("allow_pos") or [])

    tokens: list[str] = []
    if _load_jieba() and _JIEBA_POS is not None:
        for wp in _JIEBA_POS.cut(text, HMM=True):
            word = str(wp.word).strip()
            flag = str(getattr(wp, "flag", "") or "")
            if len(word) < min_len:
                continue
            if word.lower() in stop:
                continue
            # Keep English / numbers-ish identifiers even if POS odd
            is_latin = bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9_./+-]*", word))
            if is_latin and (len(word) < 3 or word.lower() in _CODE_NOISE):
                continue
            if allow_pos and flag and flag not in allow_pos and not is_latin:
                # jieba eng tag is often 'eng'
                if flag != "eng":
                    continue
            norm = _normalize_token(word, syn)
            if not norm or norm in stop or norm in _CODE_NOISE or len(norm) < min_len:
                continue
            if re.fullmatch(r"[a-z][a-z0-9_./+-]*", norm) and len(norm) < 3:
                continue
            tokens.append(norm)
    else:
        # Fallback: regex CJK chunks + latin tokens (no POS)
        for m in _WORD_RE.finditer(text):
            word = m.group(0)
            if len(word) < min_len:
                continue
            if word.lower() in stop or word.lower() in _CODE_NOISE:
                continue
            # Drop pure punctuation-ish
            if not _CJK_RE.search(word) and not re.search(r"[A-Za-z]", word):
                continue
            is_latin = bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9_./+-]*", word))
            if is_latin and len(word) < 3:
                continue
            norm = _normalize_token(word, syn)
            if not norm or norm in stop or norm in _CODE_NOISE or len(norm) < min_len:
                continue
            tokens.append(norm)
    return tokens


def accumulate_keywords(acc: dict[str, Any], text: str, cfg: dict[str, Any] | None = None) -> None:
    cfg = cfg or load_keywords_config()
    if not cfg.get("enabled", True):
        return
    if "keywords" not in acc or not isinstance(acc["keywords"], Counter):
        acc["keywords"] = Counter()
    for tok in tokenize(text, cfg):
        acc["keywords"][tok] += 1


def summarize_keywords(
    acc: dict[str, Any], cfg: dict[str, Any] | None = None
) -> dict[str, Any]:
    cfg = cfg or load_keywords_config()
    raw = acc.get("keywords") or Counter()
    if not isinstance(raw, Counter):
        raw = Counter(raw)
    min_count = int(cfg.get("min_count") or 2)
    top_n = int(cfg.get("top_n") or 40)
    filtered = [(w, c) for w, c in raw.most_common() if c >= min_count]
    top = filtered[:top_n]
    # Keep a capped raw map so multi-provider merge does not only see top_n.
    merge_cap = max(top_n * 5, 200)
    return {
        "engine": "jieba" if _JIEBA_OK else "regex_fallback",
        "unique": len(raw),
        "kept_unique": len(filtered),
        "top": [{"term": w, "count": c} for w, c in top],
        "counts": dict(raw.most_common(merge_cap)),
        "config_path": cfg.get("config_path"),
        "notes": [
            "jieba posseg + stopwords_zh + synonyms; report stores counts only",
            "tune via ~/.config/habit-weekly/keywords.json (see keywords.example.json)",
        ],
    }


def ensure_default_keywords_config() -> Path | None:
    dest = _config_path()
    if dest.is_file():
        return dest
    example = Path(__file__).with_name("keywords.example.json")
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if example.is_file():
            dest.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
        return dest
    except OSError:
        return None
