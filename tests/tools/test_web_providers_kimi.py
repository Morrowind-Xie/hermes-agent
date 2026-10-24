"""Tests for the Kimi (Moonshot) web provider (``plugins/web/kimi/``).

Covers:
- ``is_available()`` gating on any of the three accepted key names
- Pro-by-default dispatch (``/v1/tools/search_pro``) and the Basic opt-in
  (``/v1/tools/search`` with ``include_content``)
- payload shape: ``text_query`` / ``limit`` clamp / ``sites`` sanitising / ``time_window``
- row normalisation: title fallbacks, scored ``chunks`` folded into the description
- error envelope ``{"error": {"type", "message"}}`` surfaced verbatim
- ``extract()``: ``/v1/tools/fetch`` documents plus per-URL failures (never raises)
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

import plugins.web.kimi.provider as kimi


def _resp(payload, status_code: int = 200):
    mock = MagicMock()
    mock.status_code = status_code
    mock.json.return_value = payload
    mock.text = json.dumps(payload)
    return mock


@pytest.fixture
def calls(monkeypatch):
    """Record every httpx.post call and answer with a per-path payload."""
    recorded: list[dict] = []
    answers: dict[str, object] = {}

    def _post(url, json=None, timeout=None, headers=None):
        recorded.append({"url": url, "payload": json, "timeout": timeout, "headers": headers or {}})
        for suffix, answer in answers.items():
            if url.endswith(suffix):
                # A MagicMock is callable too — only a real function builds a reply from the payload.
                return answer if isinstance(answer, MagicMock) else answer(payload=json)
        return _resp({"search_results": []})

    monkeypatch.setattr(kimi.httpx, "post", _post)
    calls = MagicMock()
    calls.recorded = recorded
    calls.answers = answers
    return calls


@pytest.fixture
def provider(monkeypatch, calls):
    monkeypatch.setattr(kimi, "provider_env", lambda name: {"MOONSHOT_API_KEY": "sk-test"}.get(name, ""))
    monkeypatch.setattr(kimi, "_load_cfg", dict)
    return kimi.KimiWebSearchProvider()


def _pro_result():
    return _resp({"search_results": [
        {
            "authority": "S", "title": "Kimi K3.1 Pro 发布", "url": "https://example.com/k31",
            "site_name": "Moonshot", "date": "2026-10-24", "snippet": "摘要",
            "chunks": [{"score": 0.4, "text": "低分片段"}, {"score": 0.9, "text": "高分正文"}],
        },
        {"url": "https://example.com/no-title", "snippet": "没有标题"},
    ]})


def test_identity_and_availability(provider, monkeypatch):
    assert provider.name == "kimi"
    assert provider.supports_search() is True
    assert provider.supports_extract() is True
    assert provider.is_available() is True
    monkeypatch.setattr(kimi, "provider_env", lambda name: "")
    assert provider.is_available() is False


def test_search_pro_is_the_default(provider, calls):
    calls.answers["/tools/search_pro"] = _pro_result()

    out = provider.search("Kimi K3.1 Pro", limit=3)

    assert out["success"] is True
    call = calls.recorded[-1]
    assert call["url"].endswith("/v1/tools/search_pro")
    assert call["payload"] == {"text_query": "Kimi K3.1 Pro", "limit": 3}
    assert call["headers"]["Authorization"] == "Bearer sk-test"

    first = out["data"]["web"][0]
    assert first["position"] == 1
    assert first["title"] == "Kimi K3.1 Pro 发布"
    assert first["url"] == "https://example.com/k31"
    # Highest-scoring chunk first, both folded in under the snippet.
    assert "高分正文" in first["description"] and "低分片段" in first["description"]
    assert first["description"].index("高分正文") < first["description"].index("低分片段")
    # Title falls back to the URL when the row has none.
    assert out["data"]["web"][1]["title"] == "https://example.com/no-title"


def test_basic_mode_and_include_content(provider, calls, monkeypatch):
    monkeypatch.setattr(kimi, "_load_cfg", lambda: {"search": "basic", "include_content": True})

    provider.search("q", limit=2)

    call = calls.recorded[-1]
    assert call["url"].endswith("/v1/tools/search")
    assert call["payload"] == {"text_query": "q", "limit": 2, "include_content": True}


def test_limit_is_clamped_and_sites_are_sanitised(provider, calls, monkeypatch):
    monkeypatch.setattr(kimi, "_load_cfg", lambda: {
        "sites": ["a.com", "b c.com", "d(e).com", "f.com", "g.com", "h.com", "i.com"],
        "time_window": {"start": "2026-10-01", "end": "2026-10-24"},
    })

    provider.search("q", limit=99)

    payload = calls.recorded[-1]["payload"]
    assert payload["limit"] == 20
    assert payload["sites"] == ["a.com", "f.com", "g.com", "h.com", "i.com"]
    assert payload["time_window"] == {"start": "2026-10-01", "end": "2026-10-24"}


def test_error_envelope_is_surfaced(provider, calls):
    calls.answers["/tools/search_pro"] = _resp(
        {"error": {"type": "invalid_request_error", "message": "text_query is required"}}, status_code=400
    )

    out = provider.search("q")

    assert out["success"] is False
    assert "invalid_request_error: text_query is required" in out["error"]


def test_missing_key_is_reported(provider, monkeypatch):
    monkeypatch.setattr(kimi, "provider_env", lambda name: "")

    out = provider.search("q")

    assert out["success"] is False
    assert "No Kimi credentials" in out["error"]


def test_extract_documents_and_per_url_failures(provider, calls):
    calls.answers["/tools/fetch"] = lambda payload: (
        _resp({"url": payload["url"], "title": "标题", "markdown": "# 正文"})
        if payload["url"].startswith("https://ok.")
        else _resp({"error": {"type": "forbidden", "message": "blocked"}}, status_code=403)
    )

    docs = provider.extract(["https://ok.example/page", "https://bad.example/page", "ftp://nope"])

    assert docs[0]["content"] == "# 正文"
    assert docs[0]["raw_content"] == "# 正文"
    assert docs[0]["title"] == "标题"
    assert docs[1]["error"] and "blocked" in docs[1]["error"]
    assert "http and https" in docs[2]["error"]


def test_setup_schema_names_the_env_var(provider):
    schema = provider.get_setup_schema()

    assert schema["name"].startswith("Kimi")
    assert schema["env_vars"][0]["key"] == "MOONSHOT_API_KEY"
