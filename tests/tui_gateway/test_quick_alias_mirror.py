"""An alias quick command (``/kimi`` -> ``/model …``) has to reach the LIVE session.

A command the client has no native handler for goes to ``slash.exec`` first, whose worker runs the
alias in its own process: it switches there (and its output is printed) while the live session keeps
the old model. ``_mirror_slash_side_effects`` replays the alias target against the live session --
the only place the switch takes effect (TUI, Desktop and the web dashboard all ride this path).
"""

import contextlib

ALIAS_TARGET = "/model kimi-k3.1-pro --provider kimi-coding-cn"


def _patch_scopes(monkeypatch, server, entered=None):
    def _home_scope(session, *args, **kwargs):
        if entered is not None:
            entered.append(session)
        return contextlib.nullcontext()

    monkeypatch.setattr(server, "_session_home_scope", _home_scope)
    monkeypatch.setattr(server, "_session_profile_runtime_scope", lambda *a, **k: contextlib.nullcontext())


def _patch_config(monkeypatch, quick):
    import hermes_cli.config as config_mod

    monkeypatch.setattr(config_mod, "load_config_readonly", lambda: {"quick_commands": quick})


def _patch_model_switch(monkeypatch, server):
    calls = []

    def _switch(sid, session, arg, **kwargs):
        calls.append((sid, session, arg))
        return {}

    monkeypatch.setattr(server, "_apply_model_switch", _switch)
    return calls


def test_alias_quick_command_replays_model_switch_on_the_live_session(monkeypatch):
    """`/kimi` switches the live session even before its first build (no agent yet)."""
    from tui_gateway import server

    session = {"session_key": "sess-kimi", "profile_home": None, "running": False}
    entered = []
    _patch_scopes(monkeypatch, server, entered)
    _patch_config(monkeypatch, {"kimi": {"type": "alias", "target": ALIAS_TARGET}})
    calls = _patch_model_switch(monkeypatch, server)

    warning = server._mirror_slash_side_effects("sid-kimi", session, "/kimi")

    assert warning == ""
    assert calls == [("sid-kimi", session, "kimi-k3.1-pro --provider kimi-coding-cn")]
    assert entered == [session], "quick_commands must resolve in the session's own home"


def test_alias_args_are_appended_to_the_configured_target(monkeypatch):
    """`/kimi --global` re-dispatches as `/model <target> --global`, like the client-side expansion."""
    from tui_gateway import server

    session = {"session_key": "sess-kimi", "running": False}
    _patch_scopes(monkeypatch, server)
    _patch_config(monkeypatch, {"kimi": {"type": "alias", "target": ALIAS_TARGET}})
    calls = _patch_model_switch(monkeypatch, server)

    server._mirror_slash_side_effects("sid-kimi", session, "/kimi --global")

    assert calls[0][2] == "kimi-k3.1-pro --provider kimi-coding-cn --global"


def test_exec_quick_command_is_not_an_alias(monkeypatch):
    """Only `type: alias` entries re-dispatch; `exec` snippets keep their own handling."""
    from tui_gateway import server

    session = {"session_key": "sess-kimi", "running": False}
    _patch_scopes(monkeypatch, server)
    _patch_config(monkeypatch, {"kimi": {"type": "exec", "command": "echo hi"}})

    assert server._quick_alias_target(session, "kimi", "") is None


def test_busy_session_keeps_the_switch_for_the_next_turn(monkeypatch):
    """`/model` is in `_MUTATES_WHILE_RUNNING`: the alias must honour that guard, not swap the
    client under a running turn."""
    from tui_gateway import server

    session = {"session_key": "sess-kimi", "running": True}
    _patch_scopes(monkeypatch, server)
    _patch_config(monkeypatch, {"kimi": {"type": "alias", "target": ALIAS_TARGET}})
    calls = _patch_model_switch(monkeypatch, server)
    monkeypatch.setattr(server, "busy_message", lambda *a, **k: "busy")
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *a, **k: False)

    assert server._mirror_slash_side_effects("sid-kimi", session, "/kimi") == "busy"
    assert calls == []


def test_unknown_name_keeps_the_typed_mirror_path(monkeypatch):
    """A command that is not an alias still mirrors exactly as before (`/stop` here)."""
    from tui_gateway import server

    session = {"session_key": "sess-stop", "running": False}
    _patch_scopes(monkeypatch, server)
    _patch_config(monkeypatch, {})
    monkeypatch.setitem(server._SLASH_MIRRORS, "stop", lambda *a: "stopped")

    assert server._mirror_slash_side_effects("sid-stop", session, "/stop") == "stopped"


def test_unreadable_config_falls_back_to_the_typed_mirror_path(monkeypatch):
    """A config read failure must not swallow the command's own mirror."""
    from tui_gateway import server

    import hermes_cli.config as config_mod

    def _boom():
        raise RuntimeError("config unavailable")

    session = {"session_key": "sess-stop", "running": False}
    _patch_scopes(monkeypatch, server)
    monkeypatch.setattr(config_mod, "load_config_readonly", _boom)
    monkeypatch.setitem(server._SLASH_MIRRORS, "stop", lambda *a: "stopped")

    assert server._quick_alias_target(session, "stop", "") is None
    assert server._mirror_slash_side_effects("sid-stop", session, "/stop") == "stopped"
