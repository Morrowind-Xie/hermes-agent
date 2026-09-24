"""ZAI / GLM provider profile.

GLM-4.5+ defaults to thinking ON, so ``reasoning_config`` is translated to
``extra_body.thinking``; GLM-5.2/5.3 also take a native ``reasoning_effort``.
"""

import re
from typing import Any

from agent import reasoning_effort as re_
from providers import register_provider
from providers.base import ProviderProfile

_GLM_VERSION_RE = re.compile(r"^glm-(\d+)(?:\.(\d+))?")
# Alias spellings seen on relays (Fireworks ``glm-5p2``, ``zai-org-glm-5-2``…).
_GLM_5_3_TOKENS = ("glm-5.3", "glm-5-3", "glm-5p3")
_GLM_5_2_TOKENS = ("glm-5.2", "glm-5-2", "glm-5p2") + _GLM_5_3_TOKENS


def _model_supports_thinking(model: str | None) -> bool:
    """GLM thinking-capable model families: glm-4.5 and later (4.5, 4.6, 5…)."""
    match = _GLM_VERSION_RE.match((model or "").strip().lower())
    return bool(match) and (int(match.group(1)), int(match.group(2) or 0)) >= (4, 5)


def _has_token(model: str | None, tokens: tuple[str, ...]) -> bool:
    m = (model or "").strip().lower()
    return any(token in m for token in tokens)


def _glm_5_2_reasoning_effort(reasoning_config: dict | None, *, model: str | None = None) -> str | None:
    """Hermes effort -> GLM vocabulary (5.2: high/max; 5.3: low/high/max). Below-floor
    efforts clamp to the floor; disabled/unset leaves the server default.

    GLM-5.3 is always-thinking, so it cannot honour an explicit "off": that request
    degrades to its floor (``low``) instead of emitting the 400-ing disable marker or
    silently leaving the higher server default in force. A config that never expressed
    an effort stays unset in both cases.
    """
    effort = re_.requested_effort(reasoning_config)
    if _has_token(model, _GLM_5_3_TOKENS):
        efforts, overrides, floor = re_.GLM53_EFFORTS, re_.GLM53_OVERRIDES, "low"
        explicitly_off = isinstance(reasoning_config, dict) and (
            reasoning_config.get("enabled") is False or effort == "none"
        )
        if explicitly_off:
            return floor
        if effort is None or effort == "none":
            return None
    else:
        efforts, overrides, floor = re_.GLM52_EFFORTS, re_.GLM52_OVERRIDES, "high"
        if effort is None or effort == "none":
            return None
    clamped = re_.clamp_effort(effort, efforts, overrides)
    return clamped if clamped in efforts else floor


class ZaiProfile(ProviderProfile):
    """Z.AI / GLM — extra_body.thinking on/off + GLM-5.2 reasoning_effort."""

    def build_api_kwargs_extras(
        self, *, reasoning_config: dict | None = None, model: str | None = None, **context
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        extra_body: dict[str, Any] = {}
        top_level: dict[str, Any] = {}
        is_5_2 = _has_token(model, _GLM_5_2_TOKENS)
        if not _model_supports_thinking(model) and not is_5_2:
            return extra_body, top_level
        # Only emit when the user expressed a preference (server default = enabled).
        if isinstance(reasoning_config, dict):
            enabled = reasoning_config.get("enabled") is not False
            # GLM-5.3 is always-thinking: ``thinking: {"type": "disabled"}`` 400s
            # ("该模型始终思考，不支持关闭思考"), so never emit the disable marker for
            # it — the effort knob below degrades an off request to its floor instead.
            if enabled or not _has_token(model, _GLM_5_3_TOKENS):
                extra_body["thinking"] = {"type": "enabled" if enabled else "disabled"}
        if is_5_2:
            effort = _glm_5_2_reasoning_effort(reasoning_config, model=model)
            if effort is not None:
                top_level["reasoning_effort"] = effort
        return extra_body, top_level


zai = ZaiProfile(
    name="zai", aliases=("glm", "z-ai", "z.ai", "zhipu"),
    env_vars=("GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"), display_name="Z.AI (GLM)",
    description="Z.AI / GLM — Zhipu AI models", signup_url="https://z.ai/",
    fallback_models=("glm-5.2", "glm-5", "glm-4-9b"), base_url="https://api.z.ai/api/paas/v4",
    default_aux_model="glm-4.5-flash",
)

register_provider(zai)
