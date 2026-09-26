# 本 fork 的操作规则 · 运行环境与 PM 迁移

## R8 · 同步合并 ≠ 安装迁移（2026-09-26 事故）

上游把安装/依赖所有权交给了 `pm/`（统一包管理器）。本 fork 用 `git merge` 同步、**从未跑过 `hermes install` / `hermes update`**。2026-09-26 12:20 实测本机状态（区分两层，别把"目录不存在"当判据）：

| 层 | 状态 | 证据 |
|---|---|---|
| 引导层 | **已就位** | `~/.hermes/tools/` 有 `python-3.14.7+20260901-linux-x64`、`uv-0.12.3`、`tirith-0.4.2`；`~/.hermes/installs/<key>/bootstrap/default.json` 记 `bootstrappedAt` / `identity=<HEAD>`；仓库内 shim `<repo>/.hermes/bin/hermes` 存在（`~/.hermes/bin/hermes` 不存在，`expose_cli written: []`） |
| 依赖层 | ~~未提交~~ → **2026-09-26 12:23 已提交** | 落点是 `installs/<key>/environments/<hash>/venv`（**384 MB / 215 包**），旁边有 `inputs/{pyproject.toml,uv.lock,pm/lock.json}` + `facts.json`；是 editable 安装，`hermes_constants` 解析到**活的 git 检出**（改代码不需重装，只有依赖变化才要）。**判据别搞错**：`pm-runtime/generations/<hash>/` 那个 2.5 MB 的目录是 **PM 自举环境**（`site-packages` 只有 `_virtualenv` `packaging` `ruamel.yaml` `tomli_w` `truststore`），**不是** Hermes 依赖树，它对不对与迁移是否完成无关 |

判据：`du -sh <generation>` + 数 `site-packages` 项数。只有引导包 = 依赖层未提交。

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

- **现状（2026-09-26 12:33 起，已收口）**：drop-in 已删除（备份在 `/tmp/rb/dropin.conf.disabled`），unit 的 `ExecStart = "<repo>/.hermes/bin/hermes" "gateway" "run"`（PM shim），网关跑在 **PM 运行时**（store Python 3.14.7），`served_profiles` = 7 个。
- 触发点（历史）：`hermes gateway restart` 会把 unit 的 ExecStart **重写为 PM shim**（日志 `↻ Updated gateway user service definition to match the current Hermes install`）；在无 PM 环境时 → `Restart=always / RestartSec=5` 崩溃循环（实测 5 秒一次，`NRestarts` 冲到 34）。
- 历史保护（现已废，仅作回滚材料）：`10-fork-legacy-interpreter.conf` 曾把 ExecStart/ExecStop/ExecStopPost 覆盖回 `.venv/bin/python …`。**回滚时不要再用 `.venv`** —— 它是 **Python 3.11.14**：缺 `mcp`（4 个 MCP server 全挂 `tools.mcp_tool has no attribute 'StdioServerParameters'`）、缺 `_cffi_backend`（插件 `wecom-platform` 加载失败）、SQLite 3.50.4 有 WAL 缺陷、`Weixin: aiohttp/cryptography not installed`。要用 `venv`(3.12) 或 PM 环境。
- **`hermes gateway status` 的 `⚠ Installed gateway service definition is outdated` 是假警报**：`systemd_unit_is_current()` 的 diff 实测只有一行 `LD_LIBRARY_PATH`（installed = 生成 unit 时的 shell 值，expected = **执行 status 的那个 shell** 的值）—— `generate_systemd_unit` 会把调用者 shell 的 `LD_LIBRARY_PATH` 烘进 unit。**不要为消警告去 refresh**（会把 `miniconda3/lib` 换成 `/usr/lib/wsl/lib`）。
- **判活永远不用 `gateway list` / `gateway stop`**：`gateway/status.py:609-613` **有意**把 `python -c <src> … gateway run` 判为"非网关进程"（#107002），而 PM shim 正是这种形式，且 `~/.hermes/gateway.pid` 不存在 → `gateway list` 会误报全部 profile「not running」。**改用**：

  ```bash
  systemctl --user show hermes-gateway.service -p ActiveState -p SubState -p MainPID -p NRestarts
  python3 -c "import json;d=json.load(open('$HOME/.hermes/gateway_state.json'));print(d['pid'],d['gateway_state'],d['served_profiles'])"
  ```

  同理**不要**用 `gateway run --replace`：它不认正在跑的实例 → 可能双实例抢同一 bot token → flap loop。
- **删除条件**：`hermes pm install` 成功 **且** **`<repo>/.hermes/bin/hermes --version`** 能跑（注意：unit 指的是**仓库内** shim，不是 `~/.hermes/bin/`；后者不存在）→ 删 drop-in → `daemon-reload` → `restart`。若 shim 仍报 `no dependency environment is committed`，说明依赖层仍未提交，**保留 drop-in**。
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
- **测试环境已建（2026-09-26 16:24）**：`~/.hermes/installs/<key>/test-environment`（Python 3.14 + `dev`+`test` 组 + pytest）。**直接跑 `scripts/run_tests.sh <paths>` 即可** —— 它会在环境缺失/过期时自动激活构建（实测：一次运行同时建好 PM 环境与测试环境）。
- **不要再用遗留 venv 跑测试**（`venv` 3.12 / `.venv` 3.11）：R13 的 3.14 site-packages 注入会让它们崩在二进制扩展上。
- 实测基线（2026-09-26）：desktop 相关 6 个文件 **105 passed / 0 failed / 15 skipped**（跳过项为 macos/windows lane，属预期）；runner 自报 CI 等价形态 `(TZ=UTC LANG=C.UTF-8 PYTHONHASHSEED=0; clean env)`、`-j 12`、per-file subprocess 隔离。
- **跑整目录 / 整套测试必须用隔离 dev home**：本机 PM store 与测试环境都落在真实 `~/.hermes` 下，而 `tests/home_io_guard.py` 拒绝对真实 home 的任何文件 I/O → 会产生 **~95 个假失败**（`TEST BUG: file I/O against the REAL hermes home`）。正确命令：

  ```bash
  HERMES_HOME="$HOME/hermes-dev-data" HERMES_RUNTIME_DIR="$HOME/hermes-dev-data/tools" \
    scripts/run_tests.sh tests/hermes_cli/
  ```

  实测对照（同日、同代码、同机器）：生产 home **12935 passed / 95 failed** → 隔离 dev home **13034 passed / 4 failed**。dev home 占 ~2.2 GB。
  单文件/小范围定向测试直接在生产 home 跑即可（不触碰 store 的测试不受影响，如 desktop 那 6 个文件 105 全绿）。

## R11 · 记录义务

- 每轮同步、每次事故/修复，都在 `DEVELOPMENT_LOG.md` **顶部**新增条目（倒序，最新在上），必含：背景（数字）、流程、冲突与取舍、验证结果、**下次同步的注意点**、**待办**。pre-commit 钩子会自动备份到 `~/.hermes/doc-backups/`。
- 数字要写可复算的原始量（behind/ahead 的节点数、文件数、`+N/−M`、测试通过/跳过数），不要只写结论。
- 「待办」里未执行的动作要标明**为什么没自动做**（例：微信桥是用户正在用的通道，不自动重启）。

## R12 · 环境变更必须先建回滚包

任何会动**运行中的网关 / systemd unit / 凭据作用域 / PM 依赖树**的操作之前，先建回滚包（保存到 `/tmp/rb/<ts>/`，并把路径写入 `/tmp/rb/LATEST`）：

```bash
D=/tmp/rb/$(date +%Y%m%d-%H%M%S); mkdir -p $D
cp -a ~/.hermes/.env $D/env.default; cp -a ~/.hermes/config.yaml $D/config.yaml
cp -a ~/.hermes/gateway_state.json $D/ 2>/dev/null
for p in <每个 sub-profile>; do cp -a ~/.hermes/profiles/$p/.env $D/env.$p; cp -a ~/.hermes/profiles/$p/config.yaml $D/config.$p.yaml; done
cp -a ~/.config/systemd/user/hermes-gateway.service $D/unit.service
cp -a ~/.config/systemd/user/hermes-gateway.service.d/10-fork-legacy-interpreter.conf $D/dropin.conf
systemctl --user show hermes-gateway.service -p ActiveState -p SubState -p MainPID -p NRestarts | tee $D/state.txt
```

回滚三条路径（从轻到重）：
1. **配置级**：还原 `.env`/`config.yaml` → `hermes config set gateway.multiplex_profiles false` → 重启 gateway。
2. **启动级**：还原 drop-in → `systemctl --user daemon-reload` → `systemctl --user restart hermes-gateway`。
3. **兜底**：`systemctl --user stop hermes-gateway`，再手工 `<repo>/.venv/bin/python -m hermes_cli.main gateway run` 保活（它是 venv 解释器，天然绕过 PM 检查），排查后再交还 systemd。

⚠ 每步之后**立刻验活**：`systemctl --user show hermes-gateway.service -p ActiveState -p SubState -p NRestarts -p MainPID` + `journalctl --user -u hermes-gateway --since '3 min ago' --no-pager | tail -40`；`SubState=auto-restart` 或 `NRestarts` 在涨就先 stop。
⚠ 唯一不可自动回滚的是**成功执行后的 multiplex 折叠**（官方无 rollback 命令）——但它等价于"还原 6 个 profile 的 .env + `multiplex_profiles: false` + 重启"，属路径 1。

## R13 · 本机一切 Hermes 入口必须走 PM shim（3.14）

**根因**：`hermes_bootstrap` 在进程启动时把**已提交的 PM 环境**（`installs/<key>/environments/<hash>/venv/lib/python3.14/site-packages`）注入 `sys.path`。于是**任何非 3.14 解释器跑 `hermes_cli.main`，一碰二进制扩展就崩**：`No module named 'pydantic_core._pydantic_core'`（fastapi/pydantic）、缺 `mcp`、缺 `_cffi_backend`。仓库里遗留的 `venv`(3.12) / `.venv`(3.11) 都在此列。

**规则**：凡是启动 Hermes 的表面（systemd unit、桌面端后端、菜单项），一律用 **`<repo>/.hermes/bin/hermes`**：

```bash
# 桌面端（`main_desktop.py` 已自动设置 HERMES_DESKTOP_HERMES 为 shim；显式覆盖仍优先）
<repo>/.hermes/bin/hermes desktop --skip-build
# 任何 unit 的 ExecStart
ExecStart=<repo>/.hermes/bin/hermes dashboard --port 9119 --no-open
```

**已收口的四处（2026-09-26）**：`hermes-gateway.service`、`hermes-webui.service`、桌面端后端（两处代码补丁：`main_desktop.py` 默认 `HERMES_DESKTOP_HERMES`、`linux_desktop_entry.py` 优先进程内 shim）、应用菜单项 `hermes.desktop`。

**排查口诀**：看到 `pydantic_core._pydantic_core` / `mcp` / `_cffi_backend` 缺失的报错，**先查启动命令的解释器版本**，不要去 pip 装包。

**不要点桌面端的 "Install Hermes locally"**：它跑官方 `install.sh` 分阶段流程，会克隆**上游**仓库到 `~/.hermes/hermes-agent`（不是本 fork），留成半成品后会让桌面端一直卡在首次运行界面（2026-09-26 已发生一次，清除见第九轮日志）。
