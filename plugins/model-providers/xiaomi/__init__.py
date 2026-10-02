"""Xiaomi MiMo provider profile."""

from typing import Any

from agent.reasoning_effort import XIAOMI_MIMO_EFFORTS, clamp_effort
from providers import register_provider
from providers.base import ProviderProfile


class XiaomiProfile(ProviderProfile):
    """Xiaomi MiMo — a *strict* reasoning-effort wire.

    Live probe 2026-10-01 (token-plan-cn.xiaomimimo.com, mimo-v2.6-pro): ``reasoning_effort``
    accepts ONLY lowercase ``none``/``low``/``medium``/``high``. ``minimal``/``xhigh``/``max``/
    ``ultra``/``default``, any case variant, a bool, ``""``, ``0`` or ``{"enabled": false}`` are
    all rejected with HTTP 400 "Invalid request parameters" — which Hermes treats as an
    unretryable BadRequest and answers with a silent fallback to the next provider (#126509).
    Payload size is not the issue: 280 KB payloads, complex tool schemas, tool_calls-shaped
    histories all pass; the effort vocabulary is the whole contract.
    """

    def supported_reasoning_efforts(self, model: str | None) -> tuple[str, ...]:
        return XIAOMI_MIMO_EFFORTS

    def default_reasoning_config(self, model: str | None = None) -> dict | None:
        # Unset effort -> medium: never leave the route's own default in charge (a ceiling
        # default here would burn ~3x the reasoning tokens of medium).
        return {"enabled": True, "effort": "medium"}

    def build_api_kwargs_extras(
        self, *, reasoning_config: dict | None = None, **ctx: Any
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        top_level: dict[str, Any] = {}
        if reasoning_config and isinstance(reasoning_config, dict):
            effort = str(reasoning_config.get("effort") or "").strip().lower()
            if effort == "none" or reasoning_config.get("enabled", True) is False:
                top_level["reasoning_effort"] = "none"
            elif effort:
                clamped = clamp_effort(effort, XIAOMI_MIMO_EFFORTS)
                if clamped in XIAOMI_MIMO_EFFORTS:
                    top_level["reasoning_effort"] = clamped
        return {}, top_level


xiaomi = XiaomiProfile(
    name="xiaomi", aliases=("mimo", "xiaomi-mimo"), env_vars=("XIAOMI_API_KEY",),
    base_url="https://api.xiaomimimo.com/v1",
    supports_health_check=False,  # /v1/models returns 401 even with valid key
    supports_vision=True,  # mimo-v2-omni is vision-capable
    supports_vision_tool_messages=False,  # rejects list-type tool content (400 "text is not set")
)

register_provider(xiaomi)
