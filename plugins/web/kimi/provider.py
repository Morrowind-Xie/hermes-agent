"""Kimi (Moonshot) 联网搜索 + 网页抓取 — bundled fork provider.

Three endpoints (https://platform.kimi.com/docs/api/overview), all ``POST`` with
``Authorization: Bearer``, on the same OpenAI-compatible host as the models:

``/v1/tools/search``
    Basic. Body: ``text_query``, ``limit`` (1-20, default 5), ``include_content``.
    Returns ``search_results[]`` with title/url/snippet/text/site_name/date.
``/v1/tools/search_pro``
    Pro. Body: ``text_query``, ``limit``, optional ``sites`` (<=5) and
    ``time_window {start,end}``. Returns ``search_results[]`` with ``chunks``
    (scored body text) on top of the basic fields.
``/v1/tools/fetch``
    Body: ``url``. Returns ``{url, markdown, title}``.

Selection: ``web.search_backend: kimi`` / ``web.extract_backend: kimi``.
Optional ``web.kimi`` config: ``search`` (``pro`` default, or ``basic``),
``include_content`` (basic only), ``sites``, ``time_window``, ``timeout``.

Auth: ``MOONSHOT_API_KEY`` first (the name the Kimi docs use), then
``KIMI_CN_API_KEY`` (the key Hermes' ``kimi-coding-cn`` model provider reads),
then ``KIMI_API_KEY``. ``MOONSHOT_BASE_URL`` / ``KIMI_BASE_URL`` override the host.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx

from plugins.web._common import (
    SEARCH_LIMIT_CAP,
    BaseWebSearchProvider,
    document,
    http_status_detail,
    page_error,
    provider_env,
    run_extract,
    run_search,
    search_ok,
    setup_schema,
    title_hit,
)

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.moonshot.cn/v1"
DEFAULT_TIMEOUT = 60
MAX_SITES = 5
# The docs cap a snippet/chunk payload loosely; keep one row readable for the model.
_MAX_CHUNK_CHARS = 1200

_KEY_ENVS = ("MOONSHOT_API_KEY", "KIMI_CN_API_KEY", "KIMI_API_KEY")


def _api_key() -> str:
    for name in _KEY_ENVS:
        value = provider_env(name)
        if value:
            return value
    return ""


def _load_cfg() -> dict[str, Any]:
    """Read ``web.kimi`` from the *profile-scoped* config ({} on any miss)."""
    try:
        from hermes_cli.config import load_config_readonly

        cfg: Any = load_config_readonly()
    except Exception:
        try:
            from hermes_cli.config import load_config

            cfg = load_config()
        except Exception as exc:  # pragma: no cover - config layer unavailable
            logger.debug("Could not load web.kimi config: %s", exc)
            return {}
    for key in ("web", "kimi"):
        cfg = cfg.get(key) if isinstance(cfg, dict) else None
    return cfg if isinstance(cfg, dict) else {}


def _base_url() -> str:
    override = provider_env("MOONSHOT_BASE_URL") or provider_env("KIMI_BASE_URL")
    return (override or DEFAULT_BASE_URL).strip().rstrip("/")


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _max_chars_chunks(chunks: Any) -> str:
    """Join scored chunk texts, highest score first, trimmed to a readable budget."""
    if not isinstance(chunks, list):
        return ""
    scored: list[tuple[float, str]] = []
    for chunk in chunks:
        if isinstance(chunk, dict):
            text = str(chunk.get("text") or "").strip()
            try:
                score = float(chunk.get("score") or 0.0)
            except (TypeError, ValueError):
                score = 0.0
        else:
            text, score = str(chunk or "").strip(), 0.0
        if text:
            scored.append((score, text))
    joined = "\n\n".join(text for _, text in sorted(scored, key=lambda pair: pair[0], reverse=True))
    return joined[:_MAX_CHUNK_CHARS].strip()


def _rows(results: Any) -> list[dict[str, Any]]:
    """Basic/Pro results → the fixed ``{title,url,description,position}`` rows."""
    rows: list[dict[str, Any]] = []
    for idx, item in enumerate(results if isinstance(results, list) else []):
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        title = str(item.get("title") or "").strip() or str(item.get("site_name") or "").strip() or url
        description = str(item.get("snippet") or "").strip() or str(item.get("text") or "").strip()
        chunk_text = _max_chars_chunks(item.get("chunks"))
        if chunk_text:
            description = f"{description}\n\n{chunk_text}".strip() if description else chunk_text
        site = str(item.get("site_name") or "").strip()
        date = str(item.get("date") or "").strip()
        meta = " · ".join(part for part in (site, date) if part)
        if meta and meta not in title:
            description = f"[{meta}] {description}".strip()
        rows.append(title_hit(title, url, description, idx + 1))
    return rows



def _clean_sites(value: Any) -> list[str]:
    """Docs: max 5 entries, no whitespace or parentheses in a single entry."""
    if not isinstance(value, list):
        return []
    sites = []
    for item in value:
        site = str(item or "").strip()
        if site and not any(ch.isspace() or ch in "()" for ch in site):
            sites.append(site)
    return sites[:MAX_SITES]


def _time_window(value: Any) -> Optional[dict[str, str]]:
    """``{start, end}`` (both required by the Pro endpoint), else None."""
    if not isinstance(value, dict):
        return None
    start, end = str(value.get("start") or "").strip(), str(value.get("end") or "").strip()
    return {"start": start, "end": end} if start and end else None


def _error_text(response: httpx.Response) -> str:
    """``{"error": {"message", "type"}}`` → ``type: message``; else the raw body."""
    try:
        payload = response.json()
    except Exception:
        return http_status_detail(response)
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        kind = str(error.get("type") or "").strip()
        message = str(error.get("message") or "").strip()
        if message:
            return f"{kind}: {message}" if kind else message
    return http_status_detail(response)


class KimiWebSearchProvider(BaseWebSearchProvider):
    """Kimi 联网搜索 (Basic/Pro) + 网页抓取 (``/v1/tools/fetch``)."""

    NAME = "kimi"
    DISPLAY_NAME = "Kimi 联网搜索 (Moonshot)"
    KEY_ENV = "KIMI_CN_API_KEY"
    EXTRACT = True

    def is_available(self) -> bool:
        """Any of the three accepted key names lights this provider up."""
        return bool(_api_key())

    def _post(self, path: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
        api_key = _api_key()
        if not api_key:
            raise ValueError(
                "No Kimi credentials found. Set MOONSHOT_API_KEY (or KIMI_CN_API_KEY) "
                "from https://platform.kimi.com/console."
            )
        response = httpx.post(
            f"{_base_url()}{path}", json=payload, timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )
        if response.status_code >= 400:
            raise ValueError(_error_text(response))
        return response.json()

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        def _body() -> dict[str, Any]:
            cfg = _load_cfg()
            timeout = _coerce_int(cfg.get("timeout"), DEFAULT_TIMEOUT) or DEFAULT_TIMEOUT
            limit_ = max(1, min(_coerce_int(limit, 5), SEARCH_LIMIT_CAP))
            mode = str(cfg.get("search") or "pro").strip().lower()
            payload: dict[str, Any] = {"text_query": query, "limit": limit_}
            if mode == "basic":
                payload["include_content"] = bool(cfg.get("include_content", False))
                path = "/tools/search"
            else:
                path = "/tools/search_pro"
                sites = _clean_sites(cfg.get("sites"))
                if sites:
                    payload["sites"] = sites
                window = _time_window(cfg.get("time_window"))
                if window:
                    payload["time_window"] = window
            logger.info("Kimi %s search: '%s' (limit=%d)", mode, query, limit_)
            return search_ok(_rows(self._post(path, payload, timeout).get("search_results")))

        return run_search("Kimi", logger, _body)

    def extract(self, urls: list[str], **kwargs: Any) -> list[dict[str, Any]]:
        def _body() -> list[dict[str, Any]]:
            cfg = _load_cfg()
            timeout = _coerce_int(cfg.get("timeout"), DEFAULT_TIMEOUT) or DEFAULT_TIMEOUT
            out: list[dict[str, Any]] = []
            for url in urls:
                parsed = urlparse(url)
                if parsed.scheme not in ("http", "https") or not parsed.netloc:
                    out.append(page_error(url, "Only http and https URLs can be fetched"))
                    continue
                try:
                    logger.info("Kimi fetch: %s", url)
                    payload = self._post("/tools/fetch", {"url": url}, timeout)
                except Exception as exc:  # per-URL failure never fails the batch
                    out.append(page_error(url, str(exc)))
                    continue
                out.append(document(
                    str(payload.get("url") or url).strip() or url,
                    str(payload.get("title") or "").strip(),
                    str(payload.get("markdown") or ""),
                    source_url=url,
                ))
            return out

        return run_extract("Kimi", logger, urls, _body)

    def get_setup_schema(self) -> dict[str, Any]:
        return setup_schema(
            "Kimi 联网搜索 (Moonshot)", "paid · API key",
            "联网搜索 Basic/Pro + 网页抓取（Markdown）。用 MOONSHOT_API_KEY 或 KIMI_CN_API_KEY。",
            "MOONSHOT_API_KEY", "Moonshot / Kimi API key",
            "https://platform.kimi.com/console/api-keys",
        )
