"""Text shown to people: degree and inequality signs instead of their ASCII stand-ins.

Numbers keep their ASCII minus so anything that reads a value back still parses it."""
from __future__ import annotations

_SYMBOLS = ((" deg", "°"), ("<=", "≤"), (">=", "≥"), ("+-", "±"))


def sym(text):
    if not isinstance(text, str):
        return text
    for a, b in _SYMBOLS:
        text = text.replace(a, b)
    return text
