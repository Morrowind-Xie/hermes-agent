"""TUI ↔ messaging-platform bridge.

Mirrors the interactive TUI conversation into a messaging-platform chat (currently
WeChat/`weixin`) and, in takeover mode, lets a message that arrived on that
platform be answered by the TUI instead of the gateway — so one person can drive a
single conversation from both ends without getting double replies.

State lives in three files under HERMES_HOME, which is the whole integration
surface between the two processes:

  bridge_subscription.json  persisted attach (platform + chat_id); restored at
                            startup so a TUI restart keeps the mirror.
  bridge_heartbeat.json     TUI liveness, refreshed every 2s by the watcher.
                            gateway/run_turn.py refuses to take over (falls back
                            to the gateway's own AI) when this is >10s stale, so
                            an offline TUI can never silently swallow a message.
  bridge_inbox.jsonl        append-only exchange both sides tail.

Landed as a mixin (not inline in cli.py) because upstream split the 19k-line CLI
god-file into CLI*Mixins modules; keeping the bridge beside that structure is what
keeps future upstream syncs from re-conflicting the whole file.
"""

import logging
from pathlib import Path

from hermes_constants import get_hermes_home

logger = logging.getLogger("cli")


class CLIBridgeMixin:
    """Bridge methods for :class:`HermesCLI` (expects _console_print, _pending_input)."""

    # ------------------------------------------------------------------
    # Bridge: mirror TUI conversations to a messaging-platform session
    # ------------------------------------------------------------------

    def _bridge_subscription_path(self) -> "Path":
        """Return path to the bridge subscription file (persists across restarts)."""
        return get_hermes_home() / "bridge_subscription.json"

    def _bridge_heartbeat_path(self) -> "Path":
        """Return path to the bridge heartbeat file (TUI liveness signal for gateway)."""
        return get_hermes_home() / "bridge_heartbeat.json"

    def _bridge_write_heartbeat(self) -> None:
        """Write/refresh the heartbeat file so gateway knows TUI is alive."""
        import json as _json
        import time as _time
        import os as _os
        try:
            self._bridge_heartbeat_path().write_text(
                _json.dumps({
                    "platform": self._bridge_platform or "",
                    "chat_id": self._bridge_chat_id or "",
                    "last_seen": _time.time(),
                    "pid": _os.getpid(),
                }),
                encoding="utf-8",
            )
        except Exception as _e:
            logger.debug("bridge: failed to write heartbeat: %s", _e)

    def _bridge_attach(self, platform: str, chat_id: str) -> None:
        """Activate bridge, persist subscription, and start inbox watcher."""
        import json as _json
        self._bridge_platform = platform.strip().lower()
        self._bridge_chat_id = chat_id.strip()
        try:
            sub_path = self._bridge_subscription_path()
            sub_path.write_text(
                _json.dumps({"platform": self._bridge_platform, "chat_id": self._bridge_chat_id}),
                encoding="utf-8",
            )
        except Exception as _e:
            logger.debug("bridge: failed to persist subscription: %s", _e)
        # Write initial heartbeat immediately so gateway doesn't see a stale-or-missing
        # heartbeat during the brief window before the watcher thread starts.
        self._bridge_write_heartbeat()
        self._bridge_start_inbox_watcher()

    def _bridge_detach(self) -> None:
        """Deactivate bridge, remove subscription file, and stop inbox watcher."""
        self._bridge_platform = None
        self._bridge_chat_id = None
        if self._bridge_inbox_stop is not None:
            self._bridge_inbox_stop.set()
            self._bridge_inbox_stop = None
        try:
            sub_path = self._bridge_subscription_path()
            if sub_path.exists():
                sub_path.unlink()
        except Exception as _e:
            logger.debug("bridge: failed to remove subscription: %s", _e)
        # Remove heartbeat file immediately so gateway stops takeover without waiting
        # for the 10-second timeout.
        try:
            hb_path = self._bridge_heartbeat_path()
            if hb_path.exists():
                hb_path.unlink()
        except Exception as _e:
            logger.debug("bridge: failed to remove heartbeat: %s", _e)
        # Remove inbox file so old entries don't replay next time
        try:
            _inbox = get_hermes_home() / "bridge_inbox.jsonl"
            if _inbox.exists():
                _inbox.unlink()
        except Exception:
            pass

    def _bridge_start_inbox_watcher(self) -> None:
        """Start background thread that polls bridge_inbox.jsonl and displays notifications."""
        import threading as _threading
        # Stop any existing watcher first
        if self._bridge_inbox_stop is not None:
            self._bridge_inbox_stop.set()
        stop_event = _threading.Event()
        self._bridge_inbox_stop = stop_event

        def _watch() -> None:
            import json as _json
            import time as _time
            _inbox = get_hermes_home() / "bridge_inbox.jsonl"
            # Truncate any pre-existing inbox so we start fresh
            try:
                if _inbox.exists():
                    _inbox.write_text("", encoding="utf-8")
            except Exception:
                pass
            _pos = 0
            while not stop_event.is_set():
                try:
                    if _inbox.exists():
                        with _inbox.open("r", encoding="utf-8") as _f:
                            _f.seek(_pos)
                            for _line in _f:
                                _line = _line.strip()
                                if not _line:
                                    continue
                                try:
                                    _entry = _json.loads(_line)
                                    _plat = _entry.get("platform", "")
                                    _cid = _entry.get("chat_id", "")
                                    _user = _entry.get("user_msg", "").strip()
                                    _resp = _entry.get("response", "").strip()
                                    _takeover = _entry.get("tui_takeover", False)
                                    # Only handle messages from the bridged chat
                                    if (
                                        _plat == self._bridge_platform
                                        and _cid == self._bridge_chat_id
                                        and (_user or _resp)
                                    ):
                                        if _takeover and _user:
                                            # TUI takeover mode: inject into AI loop
                                            # The AI reply will be bridge_send back to WeChat
                                            self._console_print(
                                                f"\n[bold cyan][{_plat} → TUI][/] {_user}"
                                            )
                                            if hasattr(self, '_pending_input'):
                                                # Reset progress notified flag so the first
                                                # tool call in this new turn sends a notification
                                                self._bridge_progress_notified = False
                                                self._pending_input.put(
                                                    f"[来自微信的消息] {_user}"
                                                )
                                        else:
                                            # Notification-only mode (gateway handled it)
                                            if _user:
                                                self._console_print(
                                                    f"\n[bold cyan][{_plat}][/] 用户：{_user}"
                                                )
                                            if _resp:
                                                self._console_print(
                                                    f"[bold cyan][{_plat}][/] Hermes：{_resp}"
                                                )
                                except Exception:
                                    pass
                            _pos = _f.tell()
                except Exception:
                    pass
                # Refresh heartbeat so gateway knows TUI is still alive
                self._bridge_write_heartbeat()
                stop_event.wait(timeout=2.0)

        _t = _threading.Thread(target=_watch, daemon=True, name="bridge-inbox-watcher")
        _t.start()

    def _bridge_send(self, text: str) -> None:
        """Send *text* to the currently bridged platform chat (fire-and-forget)."""
        if not self._bridge_platform or not self._bridge_chat_id or not text:
            return
        platform = self._bridge_platform
        chat_id = self._bridge_chat_id

        def _do_send() -> None:
            import asyncio as _asyncio
            import os as _os
            try:
                if platform == "weixin":
                    from gateway.platforms.weixin import send_weixin_direct
                    # Read token/account_id from config.yaml first, fall back to env vars.
                    _token = ""
                    _account_id = ""
                    _base_url = ""
                    try:
                        from hermes_cli.config import load_config_readonly
                        _cfg = load_config_readonly()
                        _wx_cfg = (
                            ((_cfg.get("gateway") or {}).get("platforms") or {}).get("weixin")
                            or ((_cfg.get("platforms") or {}).get("weixin"))
                            or {}
                        )
                        _token = str(_wx_cfg.get("token") or "").strip()
                        _account_id = str((_wx_cfg.get("extra") or {}).get("account_id") or "").strip()
                        _base_url = str((_wx_cfg.get("extra") or {}).get("base_url") or "").strip()
                    except Exception as _ce:
                        logger.debug("bridge: failed to read weixin config: %s", _ce)
                    # Fall back to environment variables
                    if not _token:
                        _token = _os.getenv("WEIXIN_TOKEN", "")
                    if not _account_id:
                        _account_id = _os.getenv("WEIXIN_ACCOUNT_ID", "")
                    if not _base_url:
                        _base_url = _os.getenv("WEIXIN_BASE_URL", "")
                    extra = {"account_id": _account_id, "base_url": _base_url}
                    _asyncio.run(
                        send_weixin_direct(
                            extra=extra,
                            token=_token,
                            chat_id=chat_id,
                            message=text,
                        )
                    )
                else:
                    logger.debug("bridge: unsupported platform %s", platform)
            except Exception as _e:
                logger.debug("bridge send error (%s): %s", platform, _e)

        import threading as _threading
        _t = _threading.Thread(target=_do_send, daemon=True)
        _t.start()

    def _handle_bridge_command(self, cmd: str) -> None:
        """Handle /bridge [<platform> <chat_id> | off | status]."""
        parts = cmd.strip().split(None, 2)
        # parts[0] is '/bridge'
        if len(parts) < 2 or parts[1].lower() in ("off", "detach", "none"):
            if self._bridge_platform:
                old = f"{self._bridge_platform}:{self._bridge_chat_id}"
                self._bridge_detach()
                self._console_print(f"  Bridge detached (was {old})")
            else:
                self._console_print("  No bridge active.")
            return

        sub = parts[1].lower()
        if sub == "status":
            if self._bridge_platform:
                self._console_print(
                    f"  Bridge active → {self._bridge_platform}:{self._bridge_chat_id}"
                )
            else:
                self._console_print("  No bridge active.")
            return

        # /bridge <platform> <chat_id>
        if len(parts) < 3:
            self._console_print("  Usage: /bridge <platform> <chat_id>  |  /bridge off  |  /bridge status")
            return

        platform = parts[1].lower()
        chat_id = parts[2].strip()
        self._bridge_attach(platform, chat_id)
        self._console_print(f"  Bridge activated → {platform}:{chat_id}")
        self._console_print("  TUI conversations will be mirrored to that chat. Use /bridge off to detach.")


