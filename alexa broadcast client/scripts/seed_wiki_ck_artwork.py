"""Seed bundled wiki-common-knowledge-artwork from upside-news / trivia packs."""
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "assets" / "wiki-common-knowledge-artwork"
UPSIDE = ROOT / "assets" / "upside-news-artwork"
TRIVIA = ROOT / "assets" / "trivia-artwork"

TOPIC_IDS = [
    "space", "film", "music", "sports", "politics", "science", "technology",
    "history", "people", "geography", "nature", "culture", "business", "health",
    "gaming", "food", "transport", "architecture", "religion", "misc",
]

UPSIDE_MAP = {
    "space": "science",
    "film": "culture",
    "music": "culture",
    "sports": "sport",
    "politics": "society",
    "science": "science",
    "technology": "technology",
    "history": "society",
    "people": "society",
    "geography": "environment",
    "nature": "environment",
    "culture": "culture",
    "business": "society",
    "health": "science",
    "gaming": "technology",
    "food": "culture",
    "transport": "technology",
    "architecture": "culture",
    "religion": "society",
    "misc": "misc",
}

TRIVIA_MAP = {
    "film": "film",
    "music": "music",
    "sports": "sports",
    "politics": "politics",
    "science": "science-nature",
    "technology": "computers",
    "history": "history",
    "geography": "geography",
    "culture": "society-culture",
    "health": "science-nature",
    "gaming": "video-games",
    "food": "food-drink",
    "transport": "vehicles",
    "misc": "general-knowledge",
}


def find_source(name: str, base: Path) -> Path | None:
    if not base.is_dir():
        return None
    for pattern in (f"{name}.jpg", f"{name}-landscape.jpg", f"{name}-portrait.jpg"):
        candidate = base / pattern
        if candidate.exists():
            return candidate
    return None


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    copied = 0
    for topic_id in TOPIC_IDS:
        dest = DEST / f"{topic_id}.jpg"
        if dest.exists():
            continue
        src_name = UPSIDE_MAP.get(topic_id, "misc")
        source = find_source(src_name, UPSIDE)
        if source is None:
            trivia_name = TRIVIA_MAP.get(topic_id, "general-knowledge")
            source = find_source(trivia_name, TRIVIA)
        if source is None:
            continue
        shutil.copy2(source, dest)
        copied += 1
        print(f"copied {source.name} -> {dest.name}")
    print(f"done ({copied} new files, {len(list(DEST.glob('*.jpg')))} total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
