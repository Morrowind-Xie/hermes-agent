# 本 fork 的操作规则 · 运行环境与 PM 迁移

## R8 · 同步合并 ≠ 安装迁移（2026-09-26 事故）

上游把安装/依赖所有权交给了 `pm/`（统一包管理器）。本 fork 用 `git merge` 同步、**从未跑过 `hermes update`**，所以 `~/.hermes/installs/<key>/` 里**没有提交依赖环境**。

后果：任何**走 PM launcher 的启动路径**（systemd unit → `.hermes/bin/hermes`、`hermes` shim、桌面端）会立刻失败：

```
hermes: no dependency environment is committed for this install; run `hermes pm repair`
```

根因代码 `pm/environments.py::_require_own_dependencies()`：

- `sys.prefix != sys.base_prefix`（**venv 解释器**，如 `.venv`/`venv`）→ 放行（"a venv interpreter carries its own packages"）
- 跑在 **store Python**（`~/.hermes/tools/python-3.14.*`）且无已提交环境 → `raise RuntimeError(...)`

这解释了为什么 `.venv/bin/python -m hermes_cli.main …` 一直好用，而 PM shim 一用就死。

**规则**：`git merge` 之后若要恢复 PM 启动路径，必须补一步 **`hermes pm install`**（建 3.14 依赖环境）。在那之前**不要让 systemd unit 指向 PM shim**。

## R9 · gateway 服务现状与保护性 drop-in

- 触发点：`hermes gateway restart` 会把 unit 的 ExecStart **重写为 PM shim**（日志里是 `↻ Updated gateway user service definition to match the current Hermes install`）；在无 PM 环境时 → `Restart=always / RestartSec=5` 崩溃循环（实测 5 秒一次，`NRestarts` 冲到 34）。
- 现有保护（**不要删**，除非满足下条条件）：`~/.config/systemd/user/hermes-gateway.service.d/10-fork-legacy-interpreter.conf`，把 ExecStart / ExecStop / ExecStopPost 覆盖回 `.venv/bin/python …`（后两条用 `-c "sys.path.insert(...); runpy.run_module(...)"` 复刻 shim 行为，不依赖 PM）。
- **只要该 drop-in 存在，unit 被重写也无害**；代价是 `hermes gateway status` 会一直提示 `⚠ Installed gateway service definition is outdated`（可忽略）。
- **删除条件**：`hermes pm install` 成功 **且** `~/.hermes/bin/hermes --version` 能跑 → 删 drop-in → `daemon-reload` → `restart`。
- 重启 gateway 的标准动作与**必做复核**（`hermes gateway restart` 可能报 `⚠ User service did not become active within 155s`）：

  ```bash
  systemctl --user show hermes-gateway.service -p ActiveState -p SubState -p NRestarts -p MainPID
  journalctl --user -u hermes-gateway --since '3 min ago' --no-pager | tail -40
  ```

  若 `SubState=auto-restart` 或 `NRestarts` 在涨：**先 `systemctl --user stop` 掐断**，再查 `ExecStart` 指向，不要空等。

## R10 · Python 环境与测试

- 官方激活：`source ./activate`（bash/zsh）或 `. .\activate.ps1`；`deactivate` 精确还原。
- **禁止**用裸 `pip`/`uv` 改 Hermes 环境（上游 AGENTS.md 规则）；PM 拥有依赖，改 `pyproject.toml` 后跑 `hermes pm lock`。
- 上游要求 Python **3.14**（`.python-version`）；`[tool.uv] environments = ["python_version >= '3.14'"]`。
- **本机 PM 测试环境尚未建**（`~/.hermes/installs/<key>/test-environment` 不存在），所以定向 pytest 目前走遗留 venv：`./venv/bin/python -m pytest …` —— 这是**已知偏差（CI 等价性未覆盖）**，要在日志里注明。补建方式：`setup-hermes.sh` 或首次 `scripts/run_tests.sh`（会下载 CPython 3.14 并装 extras=`all`，有体量）。
- 新 `scripts/run_tests.sh` 不再探测 `.venv`/`venv`，而是激活 PM 测试环境；测试环境建好前直接用它可能失败。

## R11 · 记录义务

- 每轮同步、每次事故/修复，都在 `DEVELOPMENT_LOG.md` **顶部**新增条目（倒序，最新在上），必含：背景（数字）、流程、冲突与取舍、验证结果、**下次同步的注意点**、**待办**。pre-commit 钩子会自动备份到 `~/.hermes/doc-backups/`。
- 数字要写可复算的原始量（behind/ahead 的节点数、文件数、`+N/−M`、测试通过/跳过数），不要只写结论。
- 「待办」里未执行的动作要标明**为什么没自动做**（例：微信桥是用户正在用的通道，不自动重启）。
