"""Map text-analyzer findings through the canonical KWCAG 2.2 table.

The rule-based analyzer owns the canonical mapping in ``mapping.js``. This
module uses the shared Python bridge so the text analyzer cannot drift to a
second, hand-maintained KWCAG numbering scheme.
"""

from __future__ import annotations

from pathlib import Path
import sys
from typing import Any


AI_MODULE_DIR = Path(__file__).resolve().parents[1]
if str(AI_MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_MODULE_DIR))

from standard_mapping import kwcag_items_for_wcag


def classify_text_flag(flag: str, category: str) -> dict[str, Any]:
    """Return standards metadata for one text-engine flag."""
    if "문장 길이 과다" in flag:
        issue_type, wcag_id, wcag_name, priority = (
            "sentence_length", "3.1.5", "읽기 수준", "high"
        )
    elif "어려운 어휘 과다" in flag:
        issue_type, wcag_id, wcag_name, priority = (
            "hard_vocab_ratio", "3.1.5", "읽기 수준", "medium"
        )
    elif "위치 참조" in flag or "모호한 참조" in flag:
        issue_type, wcag_id, wcag_name, priority = (
            "location_dependency", "1.3.3", "감각적 특성", "high"
        )
    elif "텍스트 길이 과다" in flag:
        if category in {"link", "button"}:
            issue_type, wcag_id, wcag_name = "link_length", "2.4.4", "링크 목적"
            if category == "button":
                issue_type = "button_length"
            priority = "low" if category == "link" else "medium"
        elif category in {"form_guide", "label"}:
            issue_type = "form_guide_length" if category == "form_guide" else "label_length"
            wcag_id, wcag_name, priority = "3.3.2", "레이블 또는 설명", "low"
        elif category == "heading":
            issue_type, wcag_id, wcag_name, priority = (
                "heading_length", "2.4.6", "제목과 레이블", "low"
            )
        else:
            issue_type, wcag_id, wcag_name, priority = (
                "text_length", "3.1.5", "읽기 수준", "low"
            )
    else:
        issue_type, wcag_id, wcag_name, priority = (
            "text_analysis", "3.1.5", "읽기 수준", "low"
        )

    return {
        "type": issue_type,
        "flag": flag,
        "priority": priority,
        "wcag": {
            "id": wcag_id,
            "name": wcag_name,
            "standard": "WCAG",
            "version": "2.2",
        },
        "kwcag_items": kwcag_items_for_wcag(wcag_id),
    }


def classify_text_block(block: dict[str, Any]) -> list[dict[str, Any]]:
    category = str(block.get("category", ""))
    return [
        classify_text_flag(str(flag), category)
        for flag in block.get("flags", [])
        if str(flag).strip()
    ]
