"""Xiaomi MiMo wire contract: ``reasoning_effort`` is a 4-value enum (#126509).

Live probe 2026-10-01 (token-plan-cn.xiaomimimo.com, mimo-v2.6-pro) — accepted values are
ONLY lowercase ``none``/``low``/``medium``/``high``. Everything else (``minimal``/``xhigh``/
``max``/``ultra``/``default``, case variants, bool, ``""``, ``0``, ``{"enabled": false}``)
returns HTTP 400 "Invalid request parameters", which Hermes answers with a silent provider
fallback. The generic custom/OpenAI-compat ladder ships ``max``/``minimal``/``xhigh``, so both
the xiaomi profile and the custom profile's per-host clamp must fold those onto the mimo
vocabulary before they reach the wire.
"""

from __future__ import annotations

import pytest

from agent.reasoning_effort import OPENAI_COMPAT_WIRE_EFFORTS, XIAOMI_MIMO_EFFORTS

MIMO_URL = "https://token-plan-cn.xiaomimimo.com/v1"


@pytest.fixture
def xiaomi_profile():
    import model_tools  # noqa: F401  (plugin discovery registers the profile)
    import providers

    profile = providers.get_provider_profile("xiaomi")
    assert profile is not None, "xiaomi provider profile must be registered"
    return profile


@pytest.fixture
def custom_profile():
    import model_tools  # noqa: F401
    import providers

    profile = providers.get_provider_profile("custom")
    assert profile is not None, "custom provider profile must be registered"
    return profile


@pytest.mark.parametrize(
    "reasoning_config, expected",
    [
        ({"enabled": True, "effort": "medium"}, "medium"),
        ({"enabled": True, "effort": "high"}, "high"),
        ({"enabled": True, "effort": "low"}, "low"),
        ({"enabled": True, "effort": "max"}, "high"),  # never ships `max` — 400s on mimo
        ({"enabled": True, "effort": "ultra"}, "high"),  # Hermes-internal tier folds down
        ({"enabled": True, "effort": "xhigh"}, "high"),
        ({"enabled": True, "effort": "minimal"}, "low"),
        ({"enabled": False}, "none"),  # disable is legal vocabulary, not a bool
        ({"enabled": True, "effort": "none"}, "none"),
    ],
)
def test_xiaomi_clamps_effort_into_mimo_vocabulary(xiaomi_profile, reasoning_config, expected):
    _, top_level = xiaomi_profile.build_api_kwargs_extras(reasoning_config=reasoning_config)
    assert top_level == {"reasoning_effort": expected}
    assert top_level["reasoning_effort"] in XIAOMI_MIMO_EFFORTS


@pytest.mark.parametrize(
    "reasoning_config",
    [
        {"enabled": True, "effort": "bogus"},  # unknown name: omit, never forward verbatim
        {"enabled": True, "effort": True},  # bool must not reach the wire
        {"enabled": True, "effort": ""},  # empty string is the exact 400 the wire rejects
        {"enabled": True, "effort": 0},
    ],
)
def test_xiaomi_drops_values_outside_the_vocabulary(xiaomi_profile, reasoning_config):
    _, top_level = xiaomi_profile.build_api_kwargs_extras(reasoning_config=reasoning_config)
    assert top_level == {}


def test_xiaomi_default_and_supported_efforts(xiaomi_profile):
    assert xiaomi_profile.default_reasoning_config("mimo-v2.6-pro") == {"enabled": True, "effort": "medium"}
    assert xiaomi_profile.supported_reasoning_efforts("mimo-v2.6-pro") == XIAOMI_MIMO_EFFORTS


def test_custom_profile_uses_mimo_vocabulary_for_mimo_hosts(custom_profile):
    for raw, expected in (("max", "high"), ("ultra", "high"), ("minimal", "low")):
        _, top_level = custom_profile.build_api_kwargs_extras(
            reasoning_config={"enabled": True, "effort": raw}, base_url=MIMO_URL
        )
        assert top_level["reasoning_effort"] in XIAOMI_MIMO_EFFORTS
        assert top_level["reasoning_effort"] == expected


def test_custom_profile_keeps_wide_vocabulary_elsewhere(custom_profile):
    # Regression guard: the per-host clamp must not shrink other custom endpoints
    # (#114249 — ``max`` passes through the OpenAI-compat wire unchanged).
    for raw in ("max", "minimal", "xhigh"):
        _, top_level = custom_profile.build_api_kwargs_extras(
            reasoning_config={"enabled": True, "effort": raw}, base_url="https://relay.example.com/v1"
        )
        assert top_level["reasoning_effort"] == raw
        assert top_level["reasoning_effort"] in OPENAI_COMPAT_WIRE_EFFORTS
