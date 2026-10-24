"""Kimi (Moonshot) 联网搜索插件 — bundled, auto-loaded."""
from __future__ import annotations

from plugins.web.kimi.provider import KimiWebSearchProvider


def register(ctx) -> None:
    ctx.register_web_search_provider(KimiWebSearchProvider())
