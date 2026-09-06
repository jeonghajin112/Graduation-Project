"""Shared Python bridge to the canonical JavaScript KWCAG 2.2 mapping."""

from __future__ import annotations

import json
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Any


MAPPING_PATH = Path(__file__).resolve().parent / "rule-based-analyzer" / "mapping.js"


@lru_cache(maxsize=1)
def mapping_payload() -> dict[str, Any]:
    completed = subprocess.run(
        ["node", str(MAPPING_PATH)],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    payload = json.loads(completed.stdout)
    if payload.get("standard") != {"name": "KWCAG", "version": "2.2"}:
        raise RuntimeError("mapping.js did not expose the expected KWCAG 2.2 mapping")
    return payload


def kwcag_items_for_wcag(wcag_id: str) -> list[dict[str, str]]:
    payload = mapping_payload()
    item_ids = payload.get("wcagToKwcag", {}).get(wcag_id, [])
    definitions = payload.get("kwcagItems", {})
    return [
        {
            "id": item_id,
            "name": definitions[item_id]["name"],
            "standard": "KWCAG",
            "version": "2.2",
        }
        for item_id in item_ids
        if item_id in definitions
    ]
