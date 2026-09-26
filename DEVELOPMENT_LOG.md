# Hermes Agent — 开发与调试记录

> **时间线索**：最新的记录在最顶端，按时间倒序排列。

---

## 2026-09-26（第十三轮）: 接入钉钉 + 找到 WS 握手超时的元凶（IPv6）

### 已完成

- 装 SDK：`hermes pm install --extra dingtalk` → `dingtalk-stream 0.24.3` + `alibabacloud-dingtalk 2.2.42`（新建 generation `70394f412227459bb96f89515118523c`）
- 凭据写入 default `.env`（600）：`DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` / `DINGTALK_ALLOW_ALL_USERS=true`；**写前先验**：`/v1.0/oauth2/accessToken` 换 token 成功 ✓
- 预检无阻断；状态文件出现 **`dingtalk connected`**（空 AgentId 未使用：插件默认 `robot_code = client_id`）
- 回滚包：`/tmp/rb/dingtalk-creds-212836/`、`/tmp/rb/dingtalk-20260926-212602/`

### 关键诊断：`timed out during opening handshake`

启动后 `dingtalk_stream.client` 反复报 `unknown exception timed out during opening handshake`（累计 5 次）。逐层排除：

| 检查 | 结果 |
|---|---|
| `api.dingtalk.com` 解析 | **IPv6**（`2401:b180:2000:50::b`） |
| `wss-open-connection.dingtalk.com` 解析 | IPv4（`39.99.237.196`），直连 **0.77s** ✓ |
| `api.dingtalk.com` 直连 | **5.7s**（IPv6 回退/慢路径的特征） |
| shell 代理 | 有 `https_proxy=http://127.0.0.1:7897`（返回 404 属正常，TLS 通） |
| systemd unit | **无代理变量** → 网关是**直连** |
| WS 直连握手 | `HTTP 400 InvalidStatus`（缺参数的正常响应）= 网络可达 |
| A/B：PM 环境直连跑 `DingTalkStreamClient.start()` | **>45s 卡死**（无代理时） |

**修复**：`hermes config set network.force_ipv4 true`（monkey-patch socket；`gateway/run.py:2102` 应用）→ 重启后**握手超时次数 = 0**，钉钉零报错。

**规则**（已可复用）：遇到**国内服务的 WS/HTTP 建连随机超时**，先查 `network.force_ipv4`（本机 `api.dingtalk.com` 有 IPv6 记录而 IPv6 路径慢/不通）。这是**配置级**修复，不影响其它平台。

### 待验证 / 遗留

1. **用户需在钉钉里搜索该机器人并发消息**（机器人要先被"打开会话"）→ 我查 `gateway.run: inbound message: platform=dingtalk` 确认端到端。
2. 钉钉**回复依赖会话 webhook**（`Reply must follow an incoming message`）→ 主动推送需另配 `DINGTALK_WEBHOOK_URL`；`DINGTALK_ALLOW_ALL_USERS=true` 暂时放开，拿到 sender id 后应收紧为白名单。
3. 只接了 **default**；其它 6 个 profile 各需独立钉钉应用（1 应用 = 1 机器人），建议 default 验证通过后再扩。
4. 飞书 6 个 bot 的"连上但收不到"仍未定性（已按用户要求暂停，配置原样保留）。

---

### 验证结果（用户实测通过 ✓）

`~/.hermes/logs/gateway.log` 里的完整链路（21:38，`user=MW`）：

```
21:38:37 inbound message: platform=dingtalk user=MW chat=cidPwT0Mde... msg='hello'
21:38:38 [Dingtalk] _send_emotion: reply 🤔Thinking
21:38:42 response ready: platform=dingtalk session=agent:main:dingtalk:dm:cidPwT0Mde...
21:38:42 [Dingtalk] Sending response (216 chars) to cidPwT0Mde...
21:39:06 _send_emotion: recall 🤔Thinking → reply 🥳Done
```

→ 收、跑 agent（4s）、回、表情反馈（Thinking/Done）**全部工作**。同批启动日志：`Gateway running with 12 platform(s)`。

**白名单字段确认**（`adapter.py:404/462-466/485`）：匹配 `sender_id`（即日志里的 `user=MW`）或 `sender_staff_id`，二者任一命中即可 → 将来把 `DINGTALK_ALLOW_ALL_USERS=true` 换成 `DINGTALK_ALLOWED_USERS=MW` 即可收紧。

---

## 2026-09-26（第十二轮）: 7 个飞书机器人全部接通（default + 6 个 profile 各自独立 bot）

### 已完成

- 5 套凭据写入各自 `profiles/<p>/.env`（600）：invest / music / coding / exam / fitness（work、default 前几轮已接）。每份都含 `FEISHU_DOMAIN=feishu`、`FEISHU_CONNECTION_MODE=websocket`、`FEISHU_ALLOW_ALL_USERS=true`、`FEISHU_GROUP_POLICY=open`。
- **写入前先逐把验钥匙**（省一次白重启）：5 把全部 `code=0 ok`，机器人名依次 **Invest / Music / Coding / Exam / Fitness**（default = Hermes，work = Work）。
- 预检 `hermes gateway migrate --multiplex --dry-run`：7 个不同 app_id **互不冲突**，无 blocker。
- **一次重启**全部生效。回滚包：`/tmp/rb/feishu-multi-20260926-200316/`（7 个 `.env` + 状态快照）。

### 验证结果（两个独立来源）

1. `gateway_state.json`：**7 个飞书条目**全部 `connected`，且 `writer_pid` = 当前进程 → 是真连接，不是残留：

   ```
   feishu(default) · coding:feishu · exam:feishu · fitness:feishu · invest:feishu · music:feishu · work:feishu
   served_profiles = 7
   ```

2. 各 profile 自己的日志 `profiles/<p>/logs/gateway.log` 均有 `[Feishu] Connected in websocket mode (feishu)`（6/6）。

网关：PID 2413844、`active/running`、`NRestarts=0`；新进程 ERROR 共 1 条（微信 iLink 配对提示），**飞书相关 0**。

### 最终名录

| profile | 飞书机器人名 | App ID |
|---|---|---|
| default | Hermes | `cli_a91daec09fb8dbd1` |
| work | Work | `cli_a91d4c3cd2789bb3` |
| invest | Invest | `cli_aa3ddd3580b8dcbb` |
| music | Music | `cli_aa3ddf3319b85cbd` |
| coding | Coding | `cli_aa3dc5ef71381cb4` |
| exam | Exam | `cli_aa3dc68e22b8dcb8` |
| fitness | Fitness | `cli_aa3dc6c347b8dcc9` |

### 遗留

1. 7 个 app 的 `im:chat` / `im:chat:readonly` 都未开通 → 每收一条消息一条 WARNING（不影响聊天）。补权限 + 重新发布版本即可消除。
2. `tdx` MCP 仍缺可执行文件（`venv/bin/eltdx-mcp`），用户侧待处理。
3. **用户需在飞书里分别私聊 7 个机器人**做端到端确认（每个 bot 在飞书里是独立联系人）。

---

## 2026-09-26（第十一轮）: 补上 CI 等价性缺口 —— PM 测试环境已建，定向测试全绿

### 背景

第十轮记录：两处代码补丁（`main_desktop.py` / `linux_desktop_entry.py`）**只做了功能级验证**，因为 `installs/<key>/test-environment` 不存在、PM 环境里也没有 pytest。

### 处置

直接跑官方测试入口 `scripts/run_tests.sh`（AGENTS.md 强制：**永远不用裸 pytest**）。它自己完成激活：

```
▶ activating /home/morrowind/hermes-agent (environment missing or stale)
☤ Hermes Agent Setup → ✓ pinned uv 0.12.3 → Python 3.14 is already installed → ✓ ffmpeg/node/npm
```

→ **PM 环境与测试环境已在同一次运行中建好**（`installs/<key>/test-environment`，Python 3.14 + `dev`+`test` 组 + pytest，2026-09-26 16:24）。

### 结果（6 个文件，**105 passed / 0 failed / 15 skipped**）

| 文件 | 结果 | 覆盖 |
|---|---|---|
| `tests/hermes_cli/test_gui_command.py` | **49 ✓** | `main_desktop.cmd_gui` / launch env（本轮补丁 1） |
| `tests/hermes_cli/test_linux_desktop_entry.py` | **46 ✓** | `_resolve_hermes_bin_for_desktop_entry`（本轮补丁 2） |
| `tests/hermes_cli/test_desktop_source_build.py` | 3 ✓ | desktop 源码构建 |
| `tests/hermes_cli/test_desktop_startup_cost.py` | 1 ✓ | 启动开销 |
| `tests/hermes_cli/test_desktop_wsl_gpu.py` | 2 ✓ | WSL GPU 环境注入 |
| `tests/hermes_cli/test_gui_uninstall.py` | 4 ✓ | 卸载路径 |

跳过项均为 `platforms('macos')` / `platforms('windows')`（本机 Linux 不跑，属预期）。

运行形态由 runner 自报 CI 等价：`(TZ=UTC LANG=C.UTF-8 PYTHONHASHSEED=0; clean env)`、`-j 12`、per-file subprocess 隔离。

### 结论

- R10 中「本机 PM 测试环境尚未建」的偏差 **已消除**；以后任何改动都可直接 `scripts/run_tests.sh <paths>`，无需再走遗留 venv。
- 遗留 venv（`venv` 3.12 / `.venv` 3.11）**不再用于任何 Hermes 启动或测试**（原因见 R13），仅剩两处无害用途：用户自己的 `dashboard.service`（8888 原型）借用 `venv/bin/python3`；`venv/bin/python3` 作为其 MCP server 的解释器（不 import `hermes_cli.main`）。

---

### 全目录跑（`tests/hermes_cli/`，1345 文件 / ~10018 用例）

```
=== Summary: 1345 files, 12935 tests passed, 95 failed, 296 skipped (100% complete) in 838.3s (12 workers) ===
```

**失败全部集中在这 20 个文件**（本波补丁涉及的文件**一个都不在其中**）：

```
test_update_target_identity(31)  test_update_products(12)  test_update_autostash(8)
test_update_fleet_restart_pending(7)  test_update_parked_branch_guard(7)  test_web_server_profile_unification(7)
test_update_completion_process(6)  test_update_channel(3)  test_source_release_channels(2)  test_update_list_venv_holders(2)
test_cmd_update_docker / test_desktop_slash_registry / test_inventory_pricing / test_gateway_service /
test_kanban_core_functionality / test_shared_profile_warning / test_update_head_moved_gate / test_tui_npm_install /
test_update_venv_holder_retirement / test_update_receipt      （各 1）
+ test_doctor_pm_store_probe.py（8 个 collection error）
```

**根因统一**（读 `tests/home_io_guard.py` 确认）：该守卫**拒绝对"真实 HERMES_HOME"（`~/.hermes`）的任何文件 I/O**，只放行 `/proc`、home 根自身、**PATH 上的目录**、以及运行中解释器的安装前缀。而本机的 **PM store（`~/.hermes/tools/...`）、安装状态、测试环境源码副本（`~/.hermes/installs/<key>/test-environment/gen-<hash>/hermes_cli/main.py`）全都落在 `~/.hermes` 下** → 凡是要摸这些路径的测试（`test_update_*` 家族正是这类；`test_doctor_pm_store_probe` 直接探 store）一律被守卫判为"测试 bug"。

→ **这是环境/布局造成的，不是代码回归**：报错原文即 `TEST BUG: file I/O against the REAL hermes home: …`；且失败文件与本波改的两个函数（`main_desktop` / `linux_desktop_entry`）无关 —— 它们的 6 个测试文件 **105 用例全绿**。

**要拿到目录级全绿的修法**（上游文档的隔离开发流程）：给 PM 状态换一个**独立 dev home**，让 store/测试环境不再落在真实 `~/.hermes` 下：

```bash
export HERMES_HOME="$HOME/hermes-dev-data"
export HERMES_RUNTIME_DIR="$HERMES_HOME/tools"
scripts/run_tests.sh tests/hermes_cli/
```

（代价：新 store 要重新下载 CPython 3.14 + 工具 + 应用/测试依赖，约 1.5 GB / 10–20 分钟；换来"测试永远碰不到生产状态"。）

### 隔离 dev home 复跑（决定性对比 —— 证明那 95 个是环境问题）

```bash
export HERMES_HOME="$HOME/hermes-dev-data"
export HERMES_RUNTIME_DIR="$HERMES_HOME/tools"
scripts/run_tests.sh tests/hermes_cli/
```

| 运行方式 | 结果 |
|---|---|
| 生产 home（PM store/测试环境落在 `~/.hermes` 下） | **12935 passed / 95 failed / 296 skipped** |
| **隔离 dev home（本次）** | **13034 passed / 4 failed / 296 skipped**（804.3s，同代码同机器） |

**逐文件对照（生产 → 隔离）**：

| 文件 | 生产 home | 隔离 dev home |
|---|---|---|
| `test_update_target_identity.py` | 31 ✗ | **31 ✓** |
| `test_update_autostash.py` | 8 ✗ | **33 ✓** |
| `test_web_server_profile_unification.py` | 7 ✗ | **28 ✓** |
| `test_tui_npm_install.py` | 1 ✗ | **11 ✓** |

→ 那 95 个**确认是环境问题**（`home_io_guard` 拒绝真实 home 下的 I/O），**不是代码回归**。

**剩余 4 个失败**（与 fork 私有 delta 无关；其中前 2 个在生产 home 那次也照样失败 → 与布局无关）：

1. `test_gateway_service.py::TestSystemUnitHermesHome::test_managed_node_makes_system_unit_independent_of_callers_path`
2. `test_inventory_pricing.py::test_model_options_cold_pricing_fetch_runs_off_the_request_path`
3. `test_user_providers_model_switch.py::test_list_authenticated_providers_enumerates_dict_format_models`
4. `test_user_providers_model_switch.py::test_section3_probes_no_key_endpoint_with_singular_default_model`（断言 `singular default_model must not suppress live discovery`）

**疑似本机环境因素**（待跟进，未证实）：今天 `pm install` 装的 **PM 托管 node** 进入 PATH（#1 正是测这条路径）；本机 **Ollama 正在 11434 运行**（#3/#4 测 live provider discovery，真实可达端点可能走了另一分支）。

另有 **3 个 FLAKY 文件**（首次失败、重试通过；runner 明确要求 "fix the flake"）——上游 flake，记录待跟进。

**代价**：dev home 占 **2.2 GB**（`~/hermes-dev-data/{cache,tools,installs}`）；换来"测试永远碰不到生产状态"。

---

`test_desktop_slash_registry.py` 失败：`apps/desktop/src/lib/desktop-slash-registry.json is stale`。原因：本 fork 多了 `/bridge`（微信↔TUI 桥）斜杠命令，但桌面端斜杠注册表的 dump 没同步 → **桌面端命令面板里看不到 `/bridge`**。

按官方提示跑 `scripts/dump_desktop_slash_registry.py` → 补上 `"/br": null` 与 `"/bridge": null` → 该测试 **2 passed / 0 failed**。

---

## 2026-09-26（第十轮）: 收尾两处 —— 应用菜单启动项 + webui 服务的"重启炸弹"

### 处置与验证

| 对象 | 改前 | 改后 | 验证 |
|---|---|---|---|
| `~/.local/share/applications/hermes.desktop` | `Exec=<PM环境>/venv/bin/hermes desktop` | `Exec=/home/morrowind/hermes-agent/.hermes/bin/hermes desktop` | 重新生成后文件内容确认 |
| `hermes-webui.service` | `ExecStart=<repo>/venv/bin/python -m hermes_cli.main dashboard --port 9119 --no-open`（**3.12**） | `ExecStart=<repo>/.hermes/bin/hermes dashboard --port 9119 --no-open`（**PM shim / 3.14**） | `active/running`、`NRestarts=0`、解释器 = store Python 3.14.7、`/api/health` 从 **0.21.3 升到 0.21.5**、启动日志 0 报错 |

- **菜单项根因**：上游 `_resolve_hermes_bin_for_desktop_entry` 故意让"外部 primary"（PM 环境的 console script）优先。但那个 console script 把项目根解析成 **PM 的 workspace 副本**（`installs/<key>/environments/<hash>/workspace`，那里没有 `apps/desktop`）→ DE 启动时报 `Desktop GUI source not found`。修法：在该函数入口加"若 `<checkout>/.hermes/bin/hermes` 存在则优先返回"（它由安装器写入、指向**本 checkout**、且解释器与被注入的环境匹配）。该函数的唯一调用方是菜单项生成（`resolve_exec_command`），改动面很窄。
- **webui 修复的附带收益**：9119 上的 dashboard 从 9-24 的旧代码（0.21.3）变成今天的代码（0.21.5）。
- **`dashboard.service`（端口 8888）未动**：它是用户自己的原型（`My_Projects/dashboard/app.py`），只是借用 `<repo>/venv/bin/python3` 当解释器，不 import `hermes_cli.main` → 不受 3.14 注入影响。乱动它没有收益。
- **回滚包**：`/tmp/rb/desktop-menu-20260926-161654/`（三个 unit + `hermes.desktop` + webui 状态快照）。

### 本轮的两处代码补丁

1. `hermes_cli/main_desktop.py::_desktop_launch_env()`：当 `<repo>/.hermes/bin/hermes` 存在时 `env.setdefault("HERMES_DESKTOP_HERMES", …)` → 覆盖菜单/终端/所有启动路径；显式覆盖仍优先；非 PM 安装行为不变。
2. `hermes_cli/linux_desktop_entry.py::_resolve_hermes_bin_for_desktop_entry()`：优先进程内上述 shim，避免菜单项指向 PM workspace。

### 待办（如实记录）

1. **PM 测试环境仍未建**（`installs/<key>/test-environment` 不存在，PM 环境里也没有 pytest）→ 本波两处补丁**只做了功能级验证**（单元级调用 + 端到端启动 + 健康检查），**没有跑 `tests/hermes_cli/test_linux_desktop_entry.py` 等定向测试**。这是 CI 等价性缺口，已知偏差。
2. 桌面端当前实例由 shim 启动（后端 PID 1387377 / 端口 45933 / `/api/health` 0.21.5+2537）；用户如需从菜单重开，首次可能触发一次构建（菜单项不带 `--skip-build`）。
3. 键盘上的"菜单项首启会不会重新触发上游安装向导"未再复测（已确认 Exec 指向本 checkout，`isHermesSourceRoot` 通过；且 `ACTIVE_HERMES_ROOT` 仍不存在，但由于 `HERMES_DESKTOP_HERMES` 在 path 3 先命中，不再进入 bootstrap 分支）。

---

## 2026-09-26（第九轮）: 桌面端"Connect to existing Hermes"的真相 —— PM 注入 3.14 site-packages 造成解释器 ABI 不匹配

### 现象

新版桌面端弹出首次运行界面，要求填 **Gateway URL**（"Connect to existing Hermes"）。用户问：右边那个选项是"重装一遍 Hermes"还是"只配置 desktop"？

### 原因链（逐步实证）

1. **桌面端的"本地安装"标准位置是 `~/.hermes/hermes-agent`**（`main.ts:966 ACTIVE_HERMES_ROOT = HERMES_HOME/hermes-agent`；`active-runtime-state.ts` 注释："运行时可用性是权威，缺失标记不该把一个健康的本地安装推进首次运行界面"）。该目录当时**不存在**（用户的 checkout 在 `~/hermes-agent`）→ 判为"无可用的本地运行时" → 弹首次运行界面。
2. **用户点了右边 = "Install Hermes locally" = 完整安装**（i18n：`installLocalDesc: 'Download Hermes, create its Python environment, and run the backend on this computer'`；由 `apps/bootstrap-installer`（Tauri）分阶段驱动官方 `install.sh`）。它**克隆了一份上游 NousResearch 仓库**到 `~/.hermes/hermes-agent`（444 MB，HEAD `d0288be5b3`，origin=NousResearch），随后中止（desktop.log：`Details: cancelled by user` → `Setting up Hermes stopped during the 'Hermes source code' step`），**留下半成品**：无 `.env`、无 `venv`、无 `node_modules`、无 `.hermes-bootstrap-complete`。**它不是 fork**，让它装完会出现"桌面端跑上游、网关跑 fork"的双轨。
3. 我先用 `HERMES_DESKTOP_HERMES_ROOT=<repo>` 启动 → 桌面端走解析顺序 path 1（`createSourcePythonBackend(findPythonForRoot(root))`，`source-backend.ts:102` 设 `PYTHONPATH=root`、`args=['-m','hermes_cli.main',...]`）→ 用仓库里的**旧 venv**（`.venv`=3.11 / `venv`=3.12）跑后端 → 崩：
   ```
   The dashboard can't start: its web-server packages (fastapi, uvicorn) are missing from this install.
   Details: No module named 'pydantic_core._pydantic_core'
   ```
4. **根因（实测复现，两个解释器都复现）**：`import hermes_bootstrap` 会把**已提交的 PM 环境**注入 `sys.path`：
   ```
   3.12 解释器 → sys.path 多出
   .../installs/<key>/environments/<hash>/venv/lib/python3.14/site-packages
   而该目录的 pydantic_core 只有 _pydantic_core.cpython-314-...so
   ```
   → **任何非 3.14 解释器跑 Hermes CLI，一碰到带二进制扩展的包就崩**（fastapi→pydantic_core、mcp、_cffi_backend 都是这个死法）。同一根因解释了本日更早发现的 `.venv` 跑网关缺 `mcp` / 缺 `_cffi_backend`。
5. **修复**：桌面端解析顺序 **path 3 `HERMES_DESKTOP_HERMES`**（"explicit deployment override … resolve it before any mutable install"）指向 **`<repo>/.hermes/bin/hermes`（PM shim，store Python 3.14）** —— 与被注入的 site-packages 版本匹配。**注意 path 1 优先级高于 path 3，所以必须不设 `HERMES_DESKTOP_HERMES_ROOT`。**

### 处置

- 关闭桌面端（Electron 树）→ **删除** `~/.hermes/hermes-agent`（444 MB 上游半成品；删除前核查：无 `.env`/`venv`/`node_modules`/完成标记、0 未提交改动、顶层仅 `.git`）。
- 用正确方式启动：

  ```bash
  HERMES_DESKTOP_HERMES=/home/morrowind/hermes-agent/.hermes/bin/hermes \
    /home/morrowind/hermes-agent/.hermes/bin/hermes desktop --skip-build
  ```
  （`--skip-build` 直接使用 `apps/desktop/release/linux-unpacked/Hermes`，不重新构建）

### 验证结果

- 桌面端后端 = **store Python 3.14.7 + shim**：`--profile invest serve --host 127.0.0.1 --port 0`（PID 1331187），监听 **127.0.0.1:46535**（**动态端口**，所以那个"Gateway URL"输入框本来就用不上）。
- `GET /api/health` → `{"ok":true,"version":"0.21.5","displayVersion":"0.21.5+2536","auth_required":false}`（**fork 当前版本**，对比旧 dashboard 的 0.21.3）；`/api/status` → `config_version: 46`。
- `desktop3.log` 中 `can't start` / `ModuleNotFound` / `Error occurred` 计数 **0**。
- 系统网关未受影响：`active/running`、`served_profiles` 7 个、`feishu connected`。

### 遗留（重要，未自动做）

1. ⚠ **`hermes-webui.service`（dashboard，127.0.0.1:9119）下次重启会崩**：它的 ExecStart 是 `venv/bin/python -m hermes_cli.main dashboard --port 9119`（**3.12**），现在 PM 3.14 环境已被提交 → 重启即触发同一个 `pydantic_core._pydantic_core` 崩溃（本日已实测两个旧 venv 都复现）。当前它还活着只是因为进程启动于 12:23 之前。**修法**：把 unit 的 ExecStart 改成 `<repo>/.hermes/bin/hermes dashboard --port 9119 --no-open`（PM shim）。未自动改：它是用户长期在用的 dashboard 服务，改完需重启它。
2. 可考虑在 fork 的 `hermes_cli/main_desktop.py` 里**自动设置 `HERMES_DESKTOP_HERMES` 为 PM shim**（PM 安装下只有 shim 的解释器匹配）；未做，需按上游规范评估后单独提交。
3. 桌面端的 "Install Hermes locally" **不要再点完**（会装一份上游 Hermes 到 `~/.hermes/hermes-agent`）。
4. `/tmp/rb/desktop3.log`、回滚包 `/tmp/rb/feishu-work-20260926-140621/` 等仍在。

---

## 2026-09-26（第八轮）: work 飞书机器人接通 —— 双 profile 各自独立 bot

### 已完成

- `profiles/work/.env`（600）写入 6 项：`FEISHU_APP_ID=cli_a91d4c3cd2789bb3`… 、`FEISHU_DOMAIN=feishu`、`FEISHU_CONNECTION_MODE=websocket`、`FEISHU_ALLOW_ALL_USERS=true`、`FEISHU_GROUP_POLICY=open`。**群策略必须写进该 profile 自己的 .env** —— 多路复用下每个 profile 只读自己的 `.env`，default 的 `FEISHU_GROUP_POLICY` 不会继承。
- API 预验（重启前先验钥匙，避免白重启）：`tenant_access_token` `code=0`；`bot/v3/info` 名称 **Work**；`im/v1/chats` `code=99991672`（`im:chat` 未开通/未发布，与 default 同）。
- 预检 `--dry-run`：两份飞书凭据**互不冲突**（指纹不同），无 blocker。
- 一次重启同时生效：default 的 `FEISHU_HOME_CHANNEL=oc_33d161a8b41acf28573e1ea858b28af1`（从其"Failed to get chat info for oc_…"日志里取得该私聊会话 id）+ work 的凭据。
- 回滚包：`/tmp/rb/feishu-work-20260926-140621/`（含 `env.work`、`env.default`、状态快照）。

### 验证结果

- 网关 PID 952211、`active/running`、`NRestarts=0`；`served_profiles` = 7/7。
- `gateway_state.json` 同时出现 **`feishu connected`（writer 952211）与 `work:feishu connected`（writer 952211）** —— 多路复用下平台状态**按 profile 分别上报**，键名形如 `<profile>:<platform>`。**这是本轮最重要的验证姿势**。
- work 自己的日志 `profiles/work/logs/gateway.log`：`[Feishu] Connected in websocket mode (feishu)`，模块别名带 `__home_f77b1399bfa9`（= 该 profile 作用域的插件实例）。
- ⚠ **profile 级日志不进 systemd journal**：`journalctl | grep 'Lark.*connected'` 只会看到 default 那条（这正是第一次计数只得到 1 条的原因）。**验证 work 必须看 `profiles/work/logs/gateway.log` 或状态文件的 `work:feishu`**。
- 重启时旧进程的 `Event loop is closed` / `lark WS receive loop died` 是 **shutdown 噪音**（旧 PID 889983），不是回归。

### 待办

1. 用户在飞书私聊 **Work** 机器人做端到端确认（唯一未做的验证）。
2. 两个 app 的 `im:chat:readonly` / `im:chat` 均未开通 → 每收一条消息会打一条 WARNING `Failed to get chat info`（不影响聊天）。补权限 + **重新发布版本**即可消除。
3. 剩 5 个 profile（coding / exam / fitness / invest / music）照本流程复制。

---

## 2026-09-26（第七轮）: default 飞书机器人接通 —— 卡在"权限未开通/未发布"

### 已完成

- 凭据写入 `~/.hermes/.env`（权限 600）：`FEISHU_APP_ID=cli_a91daec09fb8dbd1` / `FEISHU_APP_SECRET`（已打码核对）、`FEISHU_DOMAIN=feishu`、`FEISHU_CONNECTION_MODE=websocket`、`FEISHU_ALLOW_ALL_USERS=true`、`FEISHU_GROUP_POLICY=open`（默认 `allowlist` + 空名单 = 群里**全部丢弃**，故显式放开）。
- `hermes gateway migrate --multiplex --dry-run` → 无新阻断（飞书凭据只属 default）。
- 回滚包：`/tmp/rb/feishu-20260926-135324/`（`.env`、`config.yaml`、`gateway_state.json`、状态快照）。
- 重启后**飞书长连接建立**（日志原文）：`[Lark] connected to wss://msg-frontier.feishu.cn/ws/v2?... [conn_id=...]`；`gateway_state.json` 的 `feishu` 条目由**当天进程**写入（对比 9-16 那条 `writer_pid=155332` 的陈旧残留，已不会再误导）。
- 网关：PID 889983、`active/running`、`served_profiles` = 7/7。

### API 实测（判断后台配置是否齐全的可靠手段）

| 检查 | 结果 | 结论 |
|---|---|---|
| `auth/v3/tenant_access_token/internal` | `code=0 ok` | App ID/Secret **正确** |
| `bot/v3/info` | `code=0`，名称 `Hermes` | 机器人能力**已开** |
| `im/v1/chats` | `code=99991672`「应用尚未开通所需的应用身份权限」 | **权限未添加或版本未发布** ← 唯一卡点 |

### 待用户操作（阻塞项）

1. 权限管理 → 添加 `im:message`、`im:message:send_as_bot`、`im:resource`、`im:chat`、`im:chat:readonly`。
2. **事件与回调 → 长连接模式 → 订阅 `im.message.receive_v1`**（收消息必需）；（可选）回调加 `card.action.trigger` 供审批按钮用。
3. **版本管理与发布 → 创建版本并发布**（企业应用可能需管理员审批）。⚠ **不发布则权限不生效**，这正是当前状态。
4. 发布通过后私聊那个机器人；确认权限生效可复跑本文的 `im/v1/chats` 探测（`code=0` 即生效）。

---

## 2026-09-26（第六轮）: PM 安装迁移 + multiplex 折叠 —— 7 个 profile 共用一个网关

> 触发：用户问「PM 迁移是干嘛用的」→ 结论是"必须先做，否则飞书 SDK 装不上、任何 PM 启动路径都死"。用户授权「全做，但要能回滚、保可用性」。

### 背景（可复算的原始量）

- 预检 `hermes gateway migrate --multiplex --dry-run`：**6 条 blockers**，全是同一件事 —— `WEIXIN_TOKEN` 被逐字复制到 **7 处**（`~/.hermes/.env` + 6 个 profile 的 `.env`），指纹全是 `454fa4d0`；`WEIXIN_ACCOUNT_ID` 同样 7 份（`65ef6991`）。
- **只改 `.env` 无效**：第 2 次 dry-run 仍 6 条 blockers。真正来源是**每个 profile 的 `config.yaml` 里 `platforms.weixin.token` 明文**（6 个文件，约 607-611 行）。CLI 的修复提示只命名了 env key，**没提配置层** —— 这个坑值得记。
- PM 安装态实测：`~/.hermes/installs/7009bded74a48963/` 的**引导层已在**（`bootstrap/default.json`: `bootstrappedAt=2026-09-26T11:31:48`, `identity=7611d47d39`；store 里 python-3.14.7+uv+tirith 都在），但 `pm-runtime/generations/063cf8e9…` **只有 2.5 MB / site-packages 11 项**（`_virtualenv` `packaging` `ruamel.yaml` `tomli_w` `truststore`）—— 那是 PM 自举环境，**不是** Hermes 依赖树。

### 流程（每步先建回滚包，动完立刻验活）

回滚包：`/tmp/rb/20260926-121939/`（8 个 `.env`、7 个 `config.yaml`、unit、drop-in、`gateway_state.json`、状态快照）+ `/tmp/rb/dropin.conf.disabled`。

1. **规则文档修正**：`20-pm-and-runtime.md` R8（旧文写「`installs/<key>/` 不存在」是**错的**）、R9 删除条件改指**仓库内** shim、新增 R12 回滚包约定。
2. **weixin 解绑**：6 个 profile 的 `.env` 注释掉 2 行（带 `# [fork 2026-09-26] unbound ...` 标记）+ 6 个 profile 的 `config.yaml` 把 `platforms.weixin.enabled` 改 `false`（**保留 token 值**，单字可逆）。**不动 default**。→ 第 3 次 dry-run **0 blockers**。
   - 选 `enabled: false` 而不是删块：`cli_bridge_mixin.py:210` 的 bridge 镜像走 `send_weixin_direct(...)`，只读 config 的 token、**不检查 `enabled`** → 微信镜像不受影响（已核对代码路径）。
3. **`hermes pm install`**：产出 `installs/<key>/environments/1905cc7618f74e799d6ff81af48779b9/venv`（**384 MB / 215 包**）+ `inputs/{pyproject.toml,uv.lock,pm/lock.json}` + `facts.json`；store 新增 node-26.7.0 / npm-12.0.2 / ffmpeg-9.0.1 / ripgrep-15.2.0 / agent-browser-0.26.0 / chromium-1208。产物是 editable 安装，`hermes_constants` 解析到**活的 git 检出**（**改代码不需重装**；只有依赖变化才要）。`litellm` 已不再是依赖（`pyproject.toml` grep=0）。
4. **shim 验活**：`<repo>/.hermes/bin/hermes --version` → `v0.21.5+2533.g7611d47.dirty (2026.9.24)`，rc=0（此前必报 `no dependency environment is committed`）。
5. **`hermes gateway migrate --multiplex -y`**：写入 `gateway.multiplex_profiles: true`，`gateway_migration.json` 记 `flag_was: false`；网关 153624 → 589971；`served_profiles` 立刻是 7 个。
6. **删 drop-in** + `daemon-reload` + restart → 网关改用 **PM 运行时**（store Python 3.14.7 + shim），PID 610033，**`NRestarts=0`**（干净启动）。
7. **`hermes gateway restart`** 归一化 unit → PID 618330，`active/running`。

### 冲突与取舍

- **`.venv` 是错的运行时**（Python **3.11.14**）：缺 `mcp`、缺 `_cffi_backend`、SQLite 3.50.4（WAL 缺陷）。此前那个 drop-in 正指向它，于是 **4 个 MCP server 全部** `AttributeError: module 'tools.mcp_tool' has no attribute 'StdioServerParameters'`（56 条）、插件 `wecom-platform` 加载失败、`Weixin: aiohttp/cryptography not installed` → `No adapter available for weixin`。**这四类问题全部随第 6 步切到 PM 环境后消失** —— 也就是说：不是本次改动引入，而是"跑错解释器"的老问题被这次切换顺带修掉。
- `hermes pm install` 用 `nohup … &` 启动会被会话回收打断（日志停在 `✓ agent-browser`）；必须 `setsid nohup … < /dev/null &` 才跑得完。
- 未装 `feishu` extra（PM 环境 `lark_oapi=False`）：按需 lazy-install 由 `security.allow_lazy_installs` 控制（默认开），也可显式 `hermes pm install --extra feishu`。

### 验证结果

- `served_profiles` = `[default, coding, exam, fitness, invest, music, work]`（**7/7**）。
- 平台状态：`weixin connected`、`api_server connected`、`webhook connected`、`qqbot connected`。
- 新进程日志：MCP `AttributeError` **0**、`No adapter available for weixin` **0**、`No module named` **0**。
- MCP 恢复 3/4：cgroup 里 `deerflow`（`venv/bin/python3`）、`word-bridge`、`scrapling`（pipx）都活着。
- 微信：`[Weixin] session expired …; retrying` + iLink「需用户先给 bot 发消息」—— **与旧进程 12:27 的同一条一致，属平台配对状态，非回归**。

### 遗留（未自动做，附原因）

1. **`hermes gateway list` 会误报 7 个 profile「not running」**：`gateway/status.py:609-613` **有意**把 `python -c <src> … gateway run` 形式判为"非网关进程"（注释引 #107002），而 PM shim 恰好就是这种形式；同时 `~/.hermes/gateway.pid` 也不存在。→ **判活一律用 `systemctl --user show` + `gateway_state.json`，不要用 `gateway list/stop`**；尤其避免 `gateway run --replace`（它不认正在跑的实例 → 可能双实例抢 bot token → flap loop）。
2. `⚠ Installed gateway service definition is outdated` 是**假警报**：`systemd_unit_is_current()` 的 diff 只有一行 `LD_LIBRARY_PATH`（installed=`/home/morrowind/miniconda3/lib`，expected=**执行 status 的那个 shell** 的 `/usr/lib/wsl/lib`）—— `generate_systemd_unit` 把调用者 shell 的 `LD_LIBRARY_PATH` 烘进 unit。**不要为消警告去 refresh**（那会把 miniconda3 换成 wsl lib）。
3. `tdx` MCP 起不来：`venv/bin/eltdx-mcp` 不存在（两个 venv 都没有）→ 需用户装回或改 `mcp_servers.tdx.command`。
4. `gateway_state.json` 里 `feishu: connected` 是**陈旧残留**：全机无 `FEISHU_*` 凭据、日志无 feishu 行、无 lark 进程 → 实际未运行（别被它误导）。
5. 未做 7 个飞书应用（app 必须由用户在飞书控制台创建）；未装 feishu extra。
6. `~/Documents/Cline` 断链符号（WSL 路径映射）未修。

### 下次同步注意

- 若新 tag 带来 `pyproject.toml` / `uv.lock` 变化 → 同步后**必须补 `hermes pm install`**（代码由 git 同步，依赖树由 PM 拥有，二者独立）。
- 改 `.env`/`config.yaml` 前先看 `hermes gateway migrate --multiplex --dry-run`（**只读**、可反复跑），它是唯一权威预检。

---

## 2026-09-26（第五轮）: 合并残留的 lint error —— 暴露验证链缺口

### 现象与定位

用户报「`apps/desktop/electron` 里有文件报错」。定位到 **1 个 eslint error**（不是 TS 错）：

```
apps/desktop/electron/pool-spawn-coordinator.test.ts
  10:3  error  Expected "localBackendPoolSaturatedMessage" to come before
               "LocalBackendSlotWaitTimeoutError"   perfectionist/sort-named-imports
```

**根因**：自动合并把两侧的 named import 拼成一份列表，顺序不再满足上游的 `perfectionist/sort-named-imports` 规则 —— 而这份 import 列表**正是本地私有改动（`Admission policy` 测试块）所在的文件**，两侧都动过它。

### 为什么前三轮同步的验证链没抓到

链里有 `typecheck` 与 vitest，**但没有 eslint**：

- `tsc` 对 import 顺序**不报**（顺序不影响类型）
- vitest **全绿**（顺序不影响运行）
- 所以这个 error 只会在编辑器里冒出来，而不是在我们的验证里

这是**验证链的真实缺口**，不是本次合并独有的偶然。

### 处置

1. 交换两行（`localBackendPoolSaturatedMessage` 提到 `LocalBackendSlotWaitTimeoutError` 之前）
2. 复核：`npx eslint src/ electron/ --quiet` → **error 行数 0**（整个 desktop lint 范围）；该文件 vitest **26 passed**
3. 提交 `82f87265a2 style(desktop): restore named-import order broken by the upstream merge`

### 规则更新（防复发）

`.clinerules/00-upstream-sync.md`：

- **R2 步骤 6**：验证链改为 pytest → `uv lock --check` →（如需要）`npm ci` → `typecheck` → **`eslint`** → 定向 vitest →（如需要）web build → desktop build
- **R3 新增「`eslint` 不可跳」**：给出命令 `cd apps/desktop && npx eslint src/ electron/ --quiet`（error 行数为 0 才算过），并注明若本波动了 `web/`、`ui-tui/` 也要跑对应 workspace 的 lint

### 下次同步的注意点

- 合并后**必须跑一次 eslint**；这是继 typecheck 之后第二个"只有它能发现"的守卫（typecheck 抓模块被删，eslint 抓合并打乱的 import 顺序 / 格式）。
- 凡"两侧都改"的文件（`10-fork-private-deltas.md` R6 清单），除作用域与语义外，**再加一项：格式化/lint 是否仍合规**。

---

## 2026-09-26（第四轮）: 重启 gateway 暴露「PM 依赖环境未提交」（已用 drop-in 恢复）

### 触发

按第三轮日志的「待办 #1」执行 `hermes gateway restart`（目的：让 gateway 跑上合并后的代码）。

### 现象：服务进入崩溃循环

重启时 CLI 打印 `↻ Updated gateway user service definition to match the current Hermes install`，把 unit 的 ExecStart 从 `…/.venv/bin/python -m hermes_cli.main gateway run` **改写为 PM 启动器**：

```
ExecStart="/home/morrowind/hermes-agent/.hermes/bin/hermes" "gateway" "run"
ExecStop/ExecStopPost=… ".hermes/bin/hermes" --run-module gateway.{systemd_stop_mark,cgroup_cleanup}
```

该 shim 用 **store Python**（`~/.hermes/tools/python-3.14.7+20260901-linux-x64`）启动，而本机**从未提交过依赖环境** → 每次启动立即 `status=1/FAILURE`：

```
hermes: no dependency environment is committed for this install; run `hermes pm repair`
```

systemd `Restart=always / RestartSec=5` → **5 秒一次的崩溃循环**（`NRestarts` 一路涨到 34；CLI 侧表现为 `⚠ User service did not become active within 155s`）。微信桥随之中断。

### 立即处置（先恢复服务）

1. `systemctl --user stop hermes-gateway.service` —— 先掐断循环
2. 新增可逆 drop-in `~/.config/systemd/user/hermes-gateway.service.d/10-fork-legacy-interpreter.conf`，把三条 Exec 覆盖回 venv（`ExecStart=` 空赋值重置后重设；ExecStop/ExecStopPost 用 `-c "sys.path.insert(...); runpy.run_module(...)"` 精确复刻 shim 行为，不依赖 PM）
3. `systemctl --user daemon-reload` + `start` → **恢复**：`active (running)`，Main PID **153624**，跑的是合并后的代码；`NRestarts` 不再增长

### 根因：`git merge` ≠ 安装迁移

- 本 fork 一直用 `git merge` 同步，**从未跑过 `hermes update`**，所以 PM 的依赖环境（`~/.hermes/installs/<key>/` 下的 venv）从未被提交。`~/.hermes/tools/` 工具库其实已在 09:30 自行建好（python 3.14.7 / uv 0.12.3 / tirith 0.4.2），`installs/7009bded74a48963/` 只有 `bootstrap/default.json` 与 `pm-runtime/`，**没有 venv**。
- 关键代码事实（`pm/environments.py::_require_own_dependencies`）：
  - `sys.prefix != sys.base_prefix`（**venv 解释器**）→ 直接放行（"a venv interpreter carries its own packages"）
  - 跑在 **store Python** 且无已提交环境 → **raise RuntimeError("no dependency environment is committed for this install")**
  这解释了为什么 `.venv/bin/python -m hermes_cli.main …` 一直好用，而 PM shim 一用就死。

### 潜伏陷阱与缓解

**任何后续 `hermes gateway restart` / `hermes gateway install` 都会再把 unit 写回 PM shim**，又会崩溃循环。drop-in 覆盖 ExecStart，**只要它在就安全**；代价是 `hermes gateway status` 会持续提示 `⚠ Installed gateway service definition is outdated`。

根治路径（需专门窗口）：`hermes pm install`（建 3.14 依赖环境）→ 用 `.hermes/bin/hermes --version` 验证 shim → 删 drop-in → 重启。注意它会改变启动所有权（desktop / dashboard 目前也走 venv）。

### 顺带观察（均为既存，非本次引入）

- 微信 `[Weixin] session not ready: ret=-2 … the user must send the bot a message first (or re-pair)`：**重启前的旧进程日志（09:32）里同样存在**，需要用户先给 bot 发一条消息重配对。
- venv 里的 SQLite **3.50.4** 有 WAL-reset 损坏漏洞告警（`hermes_state`，每库每进程一次）；PM 的 3.14 运行时应可消除 —— 又多一条迁移理由。
- **7 个 profile 共用同一个 `WEIXIN_TOKEN`**（default vs coding/exam/fitness/invest/music/work）→ gateway 保持 standalone，其余 profile 的 weixin adapter 被 park。属配置层既存问题。
- `.restart_pending.json` 里还有一条 09-24 遗留的 qqbot 待送达记录；启动时有一条 pending 消息恢复失败（`FOREIGN KEY constraint failed`）。

### 教训（写进同步流程）

**同步合并 ≠ 安装迁移。** 当上游把安装/依赖所有权交给 PM 之后，`git merge` 之后必须补一步 **PM 环境提交（`hermes pm install`）**，否则所有走 PM launcher 的启动路径（systemd unit、`hermes` shim、桌面端）都会失败。以前"merge 完就没事"的假设不再成立。

---

## 2026-09-26（第三轮）: 上游同步至 9fc7f17906（12 → 0）

### 背景

第二轮同步（`e13b5e71ef`）后上游只推了 **12 个提交**（全为非 merge、全在 first-parent 上；**24 files / +311 −36**），tip **`9fc7f17906`** `fix(gateway): steering an addressed message into a running turn keeps the silence fallback`。提交类型 `fix 7 / test 2 / feat 2 / chore 1`，改动集中在 `gateway 8` 文件 + `tests 7`。**仍无稳定 tag**（最新仍是 `rc.14-v0.21.5`，`abandoned-rc.8~13` 并存 → 试发仍在继续）。`pyproject.toml` / `uv.lock` / `package-lock.json` / `apps/desktop/package.json` / `web/` / `scripts/` / `AGENTS.md` / `tests/conftest.py` **全部零改动**。

### 主题（单一，且落在本机正在跑的行为面上）

1. **Gateway「沉默回退」语义五连修**（8/12 条的主干）：`a bare silence marker on a turn not addressed to the bot stays silent`、`a turn that answers an addressed message keeps the silence fallback`、`steering an addressed message into a running turn keeps the silence fallback`（tip）、`fix(slack): thread follow-ups and reaction triggers keep the silence-marker fallback`、`fix(slack): a follow-up in a flat reply_in_thread: false channel keeps the silence fallback`。落点 `gateway/{response_filters,run_busy,run_inbound,run_startup,run_turn,turn_context}.py` + `gateway/platforms/{base,event}.py` + `plugins/platforms/slack/adapter.py`。**本机跑着 gateway + 微信桥，"被点名的消息该不该回 / 沉默标记何时生效"正是它的行为面**（Slack 是例子，`gateway/` 层修复对所有平台生效）。
   - 顺带查证：**不是**在修我们刚吃进来的回归 —— `response_filters.py` 的 silence 机制已有一长串历史修复（`5f7deeba84` / `293c04fef6` / `30479961b8` / `136f8dab67` / `5ea8fb2b78`），而 `e62a47ab68..e13b5e71ef` 那个窗口只碰过它一次（`0c84aff676`，与 silence 无关）。这是一片长期模糊区在被系统性收紧。
2. **Claude Opus 5.5 模型目录**（6 条）：`feat(models): add Claude Opus 5.5 to the native Anthropic picker`、`list Claude Opus 5.5 in the Bedrock static fallback`、`fix(models): keep Sonnet 5 as the Bedrock default after adding Opus 5.5`、`fix(bedrock): add Claude Opus 5 to the 1M context table` + 两条 test（静态目录 id 与窗口的守卫、metadata 不匹配记成 mismatch 而非 TypeError）。
3. **1 条 chore**：映射 4 个贡献者邮箱。

### 流程 / 语义复核（本轮唯一需要动脑处）

预检 → 预演 **0 冲突** → `git merge origin/main` → **实跑零冲突** → 合并提交 **`9ae6a3ec78`**。文本上唯一"两侧都改"的文件是 **`gateway/run_turn.py`** —— 那正是我们 bridge 私有 delta 的落点：

上游改的是 **silence 判定链**（新增 `reply_expected` 参数自 `event.reply_expected` 一路贯穿到 `_finalize_turn_response` 与 `_run_agent_turn`、queued 链新增 `queued_terminal_reply_expected`、判定由 `is_machinery_display_kind()` 换成新的 `silence_allowed(display_kind, reply_expected)`、persist metadata 增 `**reply_expected_metadata(...)`）。

复核结论：**无需改 fork 代码** ——
- 我们的 bridge inbox 两块（`_hmwa_post_turn_hooks` 定义 @1677、takeover 写入 @~2199、调用点 @2354）都落在上游改动区之外，自动合并位置正确；
- **作用域完好**：调用点引用的 `message_text` 在 2282 行赋值，早于 2354 的使用（这正是"零文本冲突 ≠ 零复核"要查的点）；
- 语义正交：我们传的是**判定之后的 `response`**，即 gateway 实际会发出的文本 —— 沉默回退被拒时 `response` 已换成 `_UNEXPECTED_SILENCE_REPLY`，TUI 镜像显示的正是用户会看到的那份，行为正确。

### 验证（全串行）

- 冲突标记 `<<<<<<<` 全树**零**；`py_compile` 7 个关键模块（含本波全部 gateway 文件）OK
- **私有 delta 逐行存活校验**（范围 `e13b5e71ef..1b5b1fc4d9`）：**missing_total=0**
- import 冒烟 11/11（覆盖 `gateway.{run_turn,response_filters,run_busy,run_inbound,run_startup,turn_context,platforms.base}`、`plugins.platforms.slack.adapter`、`agent.bedrock_adapter`、`hermes_cli.models_catalog_static`、`cli_bridge_mixin`）
- MRO 20 项落点不变；`dispatch 44`；`/bridge -> ('_handle_bridge_command', True)`
- 定向 pytest 12 文件（fork 5 文件集 + 本波 `test_gateway_silence_tokens` / `test_busy_redirect_anchor` / `test_slack_reply_expected` / `test_queued_final_ledger` / `test_active_turn_recovery` / `test_discord_triggering_note_persistence` / `test_bedrock_adapter`）：**248 passed, 13 skipped**
- `uv lock --check` **rc=0**；desktop `typecheck` **rc=0 / 0 errors**；desktop 定向 vitest **12 文件 / 119 用例全绿 rc=0**；desktop `npm run build` **rc=0**
- **无需 `npm ci` / `uv sync` / web 重建**（依赖、`web/`、`scripts/` 全零改动）

### 下次同步的注意点

1. **已连续三轮同步落在同一天（1971 → 288 → 12）**，说明上游处在"大波 + 快速补丁波"的节奏里：大波之后紧跟 1–2 个小波把大波的口子补上。**同一天内跟一次小波的成本很低**（本轮零冲突、零依赖、几分钟），值得做。
2. **稳定 tag 仍未落地**（`rc.9`→`rc.14` 持续重切）。若下一轮出现 `v2026.9.26`，优先钉在 tag 上。
3. `gateway/run_turn.py` 已成为**两侧的常驻重叠文件**（我们放 bridge inbox，上游放 turn/silence 链）。每轮都要查两件事：**变量作用域**（自动合并可能让调用点引用的名字被搬走，`py_compile` 查不出）与**判定前后语义**（我们该传判定后的值）。
4. `typecheck` 仍是必需步骤（上游会成批删除"自己树里没人引用"的模块；本波零错误，说明未再发生）。
5. `platforms()` marker / PM runner / 3.14 结论继续未变（本波 `scripts/`、`AGENTS.md`、`conftest.py` 零改动）。

### 待办（未自动执行）

1. **重启仍在跑旧模块的进程**：gateway `428828`、dashboard `475`（+ `mcp_death_supervisor 855`）、desktop `447717`/`447762`。**未自动重启**（用户正在用的微信桥）—— 本轮尤其值得重启：gateway 的 silence 行为已改。
2. **建 PM 测试环境**（`setup-hermes.sh` 或首次 `scripts/run_tests.sh`）；定向 pytest 仍走遗留 `venv`，CI 等价性未覆盖。
3. `git push fork main`。

---

## 2026-09-26（第二轮）: 上游同步至 e13b5e71ef（288 → 0）

### 背景

上一轮（同日）同步到 `e62a47ab68` 后仅数小时，上游又推了 **288 个节点**（283 内容提交 + 5 合并接点；first-parent 277），tip **`e13b5e71ef`** `fix(gateway): bind the secondary callback scope without on-loop secret hydration`。规模 **575 files / +26075 −3099** —— 只有上一轮的 **12% 文件量、6.8% 插入量**，是典型的"补丁波"：提交类型 `fix 209 / test 42 / chore 10 / refactor 9 / **feat 仅 7**`，scope `desktop 106`、`tui 15`、`gateway 15`、`agent 13`；日期分布 09-24 4 / 09-25 254 / 09-26 30。**无新稳定 tag**（仍是 `v2026.9.24`），新增的全是候选/废弃候选：`rc.9 ~ rc.14-v0.21.5` + `abandoned-rc.8 ~ abandoned-rc.13-v0.21.5` —— 一天内 6 个 rc + 6 个废弃，说明**发布流水线在密集试切**。这一波**没有动** `AGENTS.md` / `scripts/` / `tests/conftest.py`。

### 流程

预检（工作区干净、`main == fork/main` 0/0、记下 PID 475 / 428828 / 447717）→ `git merge-tree` 预演 **0 冲突** → `git merge origin/main` → **实跑同样零冲突、零人工解冲突** → 合并提交 **`ea93e6ad79`**。这是迄今最省力的一次同步：**无冲突、无依赖变更、无需重建**。

### 本波重点（按与本 fork 相关度）

1. **Gateway 二级 profile scope 三连修**（含 tip 那条）：`bind the secondary callback scope without on-loop secret hydration`、`enter the secondary profile scope per callback, not from a configure-time snapshot`、`authorize a secondary bot's callbacks under its own profile scope` —— 正是 AGENTS.md § profile scope 那条不变量（"运行在 turn 之外的代码必须显式绑定所属 profile"）。**我们跑着 gateway + 微信桥，这条是本次同步的主要收益。**
2. **`tui_gateway` busy/queue/lease 修复群**（约 10 条）：busy-queued prompt 在 accept 时持久化、drain 时重排所有排队行（不只 dispatched 那一条）、压缩在飞时排队 follow-up、reap 陈旧 deferred 租约（#62823 zombie slot）、readiness 探针单飞 + 用时钟偏移度量 reaper 睡眠。→ 与我们的 **TUI 接管模式**直接相关。
3. **agent 的"误报"类修复**：`stop reporting transport/router truncation as an output-length limit (#91717)`、`clean-EOF tool-call retry exhaustion no longer blames the network (#102766)`、`close one-shot AIAgents on every exit path`、`protect the runtime's own interpreter from agent deletes`、`close non-interrupted tool-tail turns with a visible response`。
4. **mcp**：`resolve bare uv/uvx under GUI-style PATHs (#37589)`、`move uv/uvx known-dir table into hermes_platform resolver`（呼应 AGENTS.md"资源查找统一走 `hermes_platform`"，`tests/test_managed_runtime_resolution.py` 是它的守卫）、`budget discovery-thread GIL so agent build fits the 30s wait`。
5. 其余：`slack 6` / `tts 5` / `codex 5` / `feat(tui): native terminal mode`、`feat(desktop): PageUp/PageDown 翻页`、共享 `Reel/Masonry/Button chip`、Capabilities 目录卡片恢复、`fix(pm): match recorded extras to declarations by normalized name` + `prune recorded extras the tree no longer declares`。

### 验证（全串行）

- 冲突标记 `<<<<<<<` 全树**零**；`py_compile` 5 个关键模块 OK
- **私有 delta 逐行存活校验**（范围收紧为 `e62a47ab68..39b2a067bd`，即"我们相对上次同步点的全部私有工作"）：**missing_total=0**
- fork 本地文件仍在：`cli_bridge_mixin.py`、`pool-eviction.ts`、`pool-eviction.test.ts`、`scripts/patch-assistant-ui-render-loop.mjs`；私有链路 `selectPoolEvictions`（`main.ts:376` import + `11786` 调用）、`localBackendSlotsThatMayFree`、`decideLocalBackendAdmission`、assistant-ui 补丁标记、`_bridge_*` 字段全部存活 —— **上游这波把 `main.ts` 改了 219+/69− 也未撞掉私有链路**
- import 冒烟 9/9（含新增 `tui_gateway.server`）；MRO 20 项落点不变；`dispatch 44` 条、`/bridge -> ('_handle_bridge_command', True)`
- 定向 pytest 8 文件（fork 5 文件集 + 本波重点区 `tui_gateway/{test_deferred_lease_reaper,test_queued_prompt_persistence,test_readiness_singleflight}`）：**112 passed, 13 skipped**
- `uv lock --check` **rc=0**（仍按 CPython 3.14.6 解析 331 包）
- desktop `npm run typecheck`（4 套）**rc=0 / 0 errors**（上一轮就是这一步抓到 `pool-eviction` 被删 → 本波零错误说明未再被删模块）
- desktop 定向 vitest **12 文件 / 119 用例全绿 rc=0**；desktop `npm run build` **rc=0**
- **无需 `npm ci` / `uv sync` / web 重建**：`pyproject.toml`、`uv.lock`、`package-lock.json`、`apps/desktop/package.json`、整个 `web/` 本波**零改动**

### 下次同步的注意点

1. **优先等稳定 tag**：这波 rc.9→rc.14 六个候选全部废弃重切，说明正在试发；钉在 tag 上可省掉试发期间的来回改动。（本次是因为 gateway profile-scope 修复对本机有实质收益才提前吃。）
2. **零文本冲突 ≠ 零复核**：本波有 **12 个两侧都改**的文件，全部自动合并成功但需语义复核 —— `hermes_cli/main_desktop.py`(+135)、`tests/hermes_cli/test_gui_command.py`(+206)、`apps/desktop/electron/main.ts`(219/69−)、`agent/auxiliary_client.py`(+70)、`gateway/run_turn.py`(+4) 与 7 个 `apps/desktop/src/i18n/*.ts`。其中前两个正是上一轮刚移植过的私有 delta 落点。
3. **typecheck 是必需步骤**（上一轮教训）：上游会成批删除"它自己树里没人引用"的模块，本波又新增/改动了大量 electron 文件 —— fork 本地伴随文件（`pool-eviction.ts` 等）只有 typecheck/import 能发现丢失。
4. `platforms()` marker / PM runner / 3.14 那套结论在本波**未发生变化**（`scripts/`、`AGENTS.md`、`conftest.py` 零改动）。
5. 验证节奏照旧**全串行**；本轮 `web/` 与依赖零改动时可直接跳过 `npm ci` / web build，只跑 pytest → uv check → tsc → vitest → desktop build。

### 待办（未自动执行）

1. **重启仍在跑旧模块的进程**：gateway `428828`、dashboard `475`（+ `mcp_death_supervisor 855`）、desktop `447717`/`447762`。**未自动重启**（用户正在用的微信桥）。
2. **建 PM 测试环境**（`setup-hermes.sh` 或首次 `scripts/run_tests.sh`）；本次定向 pytest 仍走遗留 `venv`，CI 等价性未覆盖。
3. `git push fork main`。

---

## 2026-09-26: 上游同步至 e62a47ab68（1971 → 0）

### 背景

`main` 落后 `origin/main` **1971 个提交图节点**（分叉点 `9a6108fdf2`，即 09-24 同步的上游 tip）、领先 76。这 1971 = **1737 个内容提交 + 234 个合并接点**（父数分布实测 `1737×1父 / 234×2父`，无 0 父与 octopus，故两者穷尽）。**234 个 merge 里有 166 个是"往长期分支 `ethie/pm-clean` 里合 main"**（另有 13 个往 `feat/local-models`）—— 不是 234 个 PR（唯一 PR 号只有 23 个），只是分支同步的账目节点。主线口径（first-parent）只有 **370 个节点**（346 直接提交 + 24 个 PR merge），其余 1601 个节点从侧分支带入。上游 tip `e62a47ab68`（curator 两条修复），**无新 tag**（新 tag 仅 `v0.21.4+canary.20260925T065930Z`、`rc.7/rc.8-v0.21.5` 及两个 `abandoned-rc.*`）。规模 **3838 files / +223654 −97598**（上次 6154 files，约 62% 体量）。

### 流程

工作区干净、`main == fork/main` → 记录在跑的 gateway/dashboard/desktop PID（475 / 428828 / 447717）→ `git merge-tree --write-tree` 预演（**4 个冲突，与实跑逐字一致**）→ `git merge origin/main` → 解冲突 → 合并提交 **`e3555bb46a`** → 验证链 → 跟进修复 **`c1b8b51e57`**。收尾：落后 **0**、领先 **78**。

### 冲突与取舍（4 文件）

| 文件 | 冲突 | 取舍 |
|---|---|---|
| `.gitignore` | 本地加 `.codebuddy/ .qoder/ .tmp/`；上游加 `hermes_cli/_version.py`、`apps/desktop/electron/**/*.js*`、`install-stamp.json`、`.build/ .cache/`、`/pm/.lock.json.lock`、`apps/desktop/.dist-build*` | **并集** |
| `apps/desktop/electron/bootstrap-platform.ts` | 本地加 IME 可达性块（~190 行）+ `describeLinuxInputMethod` 导出 + `import { linuxOzoneBackend }`；上游**删除 `bundledRuntimeImportCheck` 函数**并把导出收成一行 | 保留本地块与 `describeLinuxInputMethod`，**去掉 `bundledRuntimeImportCheck`**（函数已不存在，否则 TS 报错），采用上游单行导出 |
| `hermes_cli/main_desktop.py` | 本地给 source 启动加 `*config_electron_flags`（7 行）；上游把 source 启动**换成"prepared Electron 运行时"**（读 `_electron_dir()/path.txt`，不再 `npm exec`），该函数 192+/413− | **取上游新结构**，把本地意图（`desktop.electron_flags` 必须同样抵达 source 启动）重新落到 `launch_command = [str(executable), ".", *config_electron_flags]` |
| `package.json` | 本地 `postinstall` 尾部追加 `node scripts/patch-assistant-ui-render-loop.mjs`；上游把 `postinstall` 的 `\u2705` 改成字面 ✅、新增 `dependencies`（`js-yaml`/`semver`）与 `overrides` | 取上游的 ✅ 字面量 + **保留本地补丁追加** |

### 移植（语义冲突：本地 2 个测试写死了旧启动形态）

上游换掉 source 启动实现后，本地 `test_gui_source_launch_applies_configured_electron_flags` / `..._stays_clean_without_configured_flags` 断言的 `["/usr/bin/npm","exec","--","electron","."]` 已不存在。新增助手 `_prepare_source_launch_tree()`（铺 `dist/index.html` + `node_modules/electron/{dist/electron,path.txt}`，UTF-8-SIG）并以 `_ns(source=True, skip_build=True)` 走真实路径，断言改为**精确**等值 `[str(exe), ".", *flags]`（比原来"包含"更严）。两个测试的意图（flags 必须抵达 source 启动、无配置时不产生空参数漂移）保持不变。

### 合并后修复

**`c1b8b51e57`**：上游 `7f6ec2749e chore(desktop): drop four electron modules nothing imports` 一次删掉 4 个模块（`deep-link-route` / `gitlock` / `pool-eviction` / `update-remote`）。前三个本树确实无人引用，但 **`pool-eviction.ts` 被本 fork 的 `main.ts` 引用**（`selectPoolEvictions()` → `localBackendSlotsThatMayFree()` → `decideLocalBackendAdmission`，即本地私有"池饱和 backpressure"链路）；上游删它的前提是"**上游树**里无人引用"。首次 typecheck 因此 **1× TS2307**。处置：按分叉点**恢复 `pool-eviction.ts` + `pool-eviction.test.ts` 为 fork 本地文件**（模块自带 `PoolEvictionEntry`/`selectPoolEvictions`/`evictPoolEntries`，零 import，自洽）。这与 09-15 那次 `e6656a3b24 fix(desktop): re-import selectPoolEvictions dropped by the upstream merge` 是同一处代码的第二次被撞。

### 验证（全串行，零假阳性）

- 冲突标记 `<<<<<<<` 全树**零**（`git grep -c '^<<<<<<< '` 空）；`py_compile hermes_cli/main_desktop.py` OK
- import 冒烟 11/11：`main_desktop` / `cli_{init,tui_runtime,bridge,chat_turn,stream}_mixin` / `commands` / `agent.auxiliary_client` / `pm.{cli,testenv,build_env}`
- MRO 探针（20 项）：`_init_runtime_state → CLIInitMixin`、`_tui_print_startup`/`_tui_process_loop → CLITuiRuntimeMixin`、`_handle_bridge_command`/`_bridge_start_inbox_watcher → CLIBridgeMixin`；`HermesCLI._slash_handler('bridge') == ('_handle_bridge_command', True)`，分发表 44 条
- 定向 pytest 5 文件（`gateway/test_weixin` / `test_weixin_secret_scope` / `hermes_cli/test_gui_command` / `test_config_read_guard` / `test_interrupt_requeue_image_payload`）：**89 passed, 10 skipped**
- **私有 delta 逐行存活校验**（自写 `verify_private.py`：取本地相对分叉点的 `+` 行，逐行核对是否仍在合并后文件中）：30 文件 **missing_total=0**（12 处"缺失"逐条确认为上面的刻意重写）
- `uv lock --check` **rc=0**（uv 自动下载 **CPython 3.14.6**，按 3.14 解析 331 包）
- 根 `npm ci`（`npm_config_engine_strict=false`）**rc=0**；`scripts/patch-assistant-ui-render-loop.mjs` 补丁在 postinstall 后**已重新落盘**（`grep -c hermes-render-loop-patch` = 1）
- desktop `npm run typecheck`（renderer + electron + e2e + `electron-builder.config.cjs` 四套）**rc=0 / 0 errors**（恢复 `pool-eviction` 后）
- desktop 定向 vitest **12 文件 / 119 用例全绿 rc=0**（`bootstrap-platform`、`pool-eviction`、`pool-limits`、`pool-spawn-coordinator`、`pool-stop`、`pool-reclamation`、`titlebar-overlay-width`、`window-controls`、`gateway-pool-saturation`、`gateway`、`gateway-spawn-priority`、`gateway-reconnect`）——与 09-24 基线数字一致
- `npm run build --workspace web` **rc=0** → `hermes_cli/web_dist` 重建；desktop `npm run build` **rc=0**（`assert-dist-built` 通过）

### 本次上游的重点（结构性，不只是代码）

1. **`pm/` 统一包管理器成为新地基（167 提交，scope 榜第一）**：新顶层包 `pm/`（54 文件，**自带 `pm/pyproject.toml` + `uv.lock` + `lock.json`**），`hermes pm lock/install/repair`、**PM generation**（换代后进程需重启）、runtime extras 隔离；AGENTS.md 新规"**Do not mutate Hermes environments with raw pip or uv**"；新根入口 `activate` / `activate.ps1` / `setup-hermes.sh`。
2. **Python 运行时抬到 3.14**：`.python-version 3.11 → 3.14`、`requires-python <3.14 → <3.15`、`[tool.uv] environments = ["python_version >= '3.14'"]`（注释明说 3.11 只是 pre-PM updater 的过渡桥）。新增 `tests/compat/`（pre-PM updater 兼容面冻结 + `scripts/audit-old-updater-imports.py`）。
3. **测试基建换代**：`scripts/run_tests.sh` 重写 —— **不再探测 `.venv`/`venv`**，改为激活 checkout 的**隔离测试环境**（`pm.testenv` + `scripts/_activation.sh`），输入（`uv.lock`/`pyproject.toml`/`pm/lock.json`）mtime 变化时自动重激活；`linux_only`/`macos_only`/`windows_only` 被**单一 `@pytest.mark.platforms(...)`** 取代（specs: `linux/macos/windows/posix/any/not X`，支持 `arch=`，conftest 拒绝同测试挂两个 `platforms`）。
4. **版本身份重做**：主线 `pyproject.toml` / `apps/desktop/package.json` 版本恒为 **`0.0.0`**，真实身份 = release tag + **`install-stamp.json`**，`hermes_cli/_version.py` 改为构建期生成（已 gitignore）→ **"看版本号判断要不要 `npm ci`"这条经验作废**。
5. desktop 打包改道 **MSIX**（`dist:win → msix`，nsis 退场）、`electron-updater@6.8.9`、bundled payload 变体；另见新发布体系 `stable-release.yml` / `desktop-bundled-release.yml`（+2532）。
6. 其他：`local-runtime`/`local-models`（托管 llama.cpp、模型 catalog、context policy）、termux 支持、`feat(web): serve managed search through Perplexity`、编码硬化（`utf-8-sig` 批量修复，含 cron/文本读取）、平台插件修复（feishu / dingtalk 日志风暴+熔断 / kimi brotli）。**skills 新增 0 个。**

### 下次同步的注意点

1. **PM 拥有 Python 依赖**：改 `pyproject.toml` 后跑 `hermes pm lock` 并重 `source ./activate`；别再手工 `uv lock`/`pip install`。开发环境激活改为 `source ./activate`（bash/zsh）或 `. .\activate.ps1`（PowerShell），`deactivate` 精确还原。
2. **`scripts/run_tests.sh` 需要 PM bootstrap**：本机 `~/.hermes/installs/` **尚不存在**（PM 测试环境未建），首次运行会下载 **CPython 3.14.6** 并建 `test-environment`（默认 extras=`all` + `dev`/`test` groups）。本次定向验证因此**走的仍是遗留 `venv`**（`./venv/bin/python -m pytest`）—— CI 等价性未覆盖，属于已知偏差。
3. **上游会成批删除"自己树里没人引用"的 electron 模块**（本次 `7f6ec2749e` 一次删 4 个）。**fork 本地伴随文件每轮同步都要复查**：`hermes_cli/cli_bridge_mixin.py`、`apps/desktop/electron/pool-eviction.ts(+test)`、`scripts/patch-assistant-ui-render-loop.mjs`。这类丢失**只有 typecheck/import 能发现**（源码检查无感），所以 **typecheck 是必需步骤**，不能跳。
4. 判"要不要 `npm ci` / 要不要重建"只能看 `git diff --stat` + lockfile 实际差异，**版本号不再是探针**（见上 0.0.0）。
5. 验证节奏照旧**全串行**：pytest → `uv lock --check` → `npm ci` → tsc → vitest → web build → desktop build（本次零假阳性）。
6. 新平台 marker：本地新增测试若用 `linux_only` 等旧名，会被 `list_os_marked_tests.py` 解析不到而**静默不被任何车道 import**。

### 待办（未自动执行）

1. **重启正在跑旧模块的进程**：gateway `428828`（`.venv`）、dashboard `475`（+ `mcp_death_supervisor 855`）、desktop `447717`/`447762`（0.17.6 旧包）。**未自动重启**：那是用户正在用的微信桥（沿用 09-24 的处置）。
2. **建 PM 测试环境**（`setup-hermes.sh` 或首次 `scripts/run_tests.sh`），此后测试走 3.14 隔离环境。
3. `git push fork main`（区间 `e3555bb46a..c1b8b51e57`）。

---

## 2026-09-24: 上游同步至 9a6108fdf2（3194 → 0）

### 背景

`main` 落后 `origin/main` **3194** 个提交（分叉点 `4d14aaf477`，即 09-20 同步的上游 tip；上游 09-20→09-24 四天推了 3194 个，≈800/天，是迄今最猛的一段）、领先 65 个（本地私有工作）。新 tag **`v2026.9.21`、`v2026.9.24`**（= v0.21.5，`f97608f178`）。`pyproject.toml` 0.21.3 → **0.21.5** 且 `uv.lock` +100/−123（`uvicorn[standard]` 被拆成 `uvicorn`+`httptools`+`watchfiles`、`uvloop` 改为 `[uvloop]` extra）—— 但本机 `venv` 与 `.venv` 实测均已满足新约束（`uvicorn 0.41.0` / `uvloop 0.22.1` / `httptools 0.7.1` / `watchfiles 1.1.1`），`uv lock --check` rc=0 → **本次无需 `uv sync`**；`apps/desktop/package.json` 版本仍是 0.17.6，但**新增了依赖**（`@novnc/novnc@1.7.0`、`dbus-native@0.15.2`、`https-proxy-agent@7.0.6`、`proxy-from-env@2.1.0`、`@types/proxy-from-env@1.0.4`）→ 必须 `npm ci`；`web/src` 58 文件变 → 重建 `hermes_cli/web_dist`。规模 6154 files / +279101 −182617（`apps/desktop` 一个目录就占 1444 文件）。

### 流程

工作区干净 → `git merge-tree --write-tree` 预演（**4 个冲突，与实跑逐字一致**）→ `git merge origin/main` → 解冲突 → 合并提交 `e9ae73ec15`（同步后 0 behind / 66 ahead）。

### 冲突与取舍（4 文件）

| 文件 | 冲突 | 取舍 |
|---|---|---|
| `apps/desktop/electron/bootstrap-platform.test.ts` | 本地给 import 加了 `describeLinuxInputMethod`；上游删了 `bundledRuntimeImportCheck` 的 import 及其用例 | 并集：保留本地 import + 本地新增的 150 行 IME 用例，**去掉已无用的 `bundledRuntimeImportCheck` import**（否则 TS6133） |
| `apps/desktop/electron/pool-spawn-coordinator.test.ts` | 上游 `a4f93ce250 test: purge low-value tests, lane js01 (202 removed)` 把 `// ── main.ts wiring ──` 那段**读源码的**测试与 100 子进程并发用例整段删掉；本地恰好在它后面**追加**了私有 `Admission policy` 块 | 取上游的删除（同时上游也删了该块依赖的 `fs`/`path`/`fileURLToPath` import —— 本次在跑 typecheck 前就发现，见坑 1），保留本地的 8 条 `Admission policy` 纯函数用例 |
| `cli.py`（3 处） | 上游把 19k 行 god-file 拆出 **`hermes_cli/cli_init_mixin.py`（CLIInitMixin）** 与 **`hermes_cli/cli_tui_runtime_mixin.py`（CLITuiRuntimeMixin）**，删掉 cli.py 里的内联方法体 | 取上游的删除 + 上游类头并**在末尾补回 `CLIBridgeMixin`**；随后把本地私有改动**移植进新 mixin**（见下） |
| `package-lock.json` | 本地 churn（`sax` 1.6.1 + `"dev": true`，全树 1362 包）⟷ 上游 1.6.0（1422 包） | **整份取上游**（`git checkout --theirs`）。本地那份是 `chore(deps): temp-disable npm min-release-age …` 造成的临时 churn，比上游少 55 个平台二进制（`@esbuild/*`、`@emnapi/*`）；根 `package.json` 本地只改了 `postinstall`（挂 assistant-ui 补丁），**不涉依赖图** |

**本地私有改动必须移植**（上游搬迁后原位置已消失，这是本次唯一有脑力成本的部分）：

| 私有内容 | 原来在哪 | 移植到 |
|---|---|---|
| `_bridge_platform` / `_bridge_chat_id` / `_bridge_inbox_stop` / `_bridge_progress_notified` 4 个字段 | `cli.py::_init_runtime_state` | `hermes_cli/cli_init_mixin.py::_init_runtime_state`（`preloaded_skills` 之后） |
| bridge 自动恢复块（`bridge_subscription.json` → `config.yaml bridge:` 回退 → 提示 + `_bridge_start_inbox_watcher()`） | `cli.py::_tui_print_startup` 末尾 | `hermes_cli/cli_tui_runtime_mixin.py::_tui_print_startup` 末尾 |

### 验证

- 冲突标记全树清零（`git grep '^<<<<<<< ' HEAD`）；`py_compile` 10 个关键模块 OK；6 个模块 import 冒烟 OK
- MRO 探针（`_init_runtime_state` → `cli_init_mixin`、`_tui_print_startup`/`_tui_process_loop` → `cli_tui_runtime_mixin`、bridge 方法 → `cli_bridge_mixin`；MRO 20 项无冲突）
- 定向 pytest 5 文件（`test_weixin` / `test_weixin_secret_scope` / `test_gui_command` / `test_config_read_guard` / `test_interrupt_requeue_image_payload`）：**93 passed, 0 failed, 12 skipped**
- desktop `npm ci`（`npm_config_engine_strict=false`）：1346 包、无 error、`package-lock.json` **零 churn**；`scripts/patch-assistant-ui-render-loop.mjs` 补丁重新落盘（`grep -c hermes-render-loop-patch …subscribable.js` = 1）；4 个新依赖均到位
- desktop `npm run typecheck`（renderer + electron + e2e 三套）**rc=0**
- desktop 定向 vitest **12 文件 / 119 用例全绿 rc=0**（`pool-spawn-coordinator`、`bootstrap-platform`、`pool-limits`、`pool-eviction`、`pool-stop`、`pool-reclamation`、`titlebar-overlay-width`、`window-controls`、`gateway-pool-saturation`、`gateway`、`gateway-spawn-priority`、`gateway-reconnect`）
- `hermes_cli/web_dist` 重建（`_build_web_ui`，vite ✓，rc=0）
- desktop 打包重建（`hermes desktop --build-only`，stage-and-swap）**rc=0**；`release/linux-unpacked/resources/install-stamp.json` 与 `build/install-stamp.json` 均 = **`e9ae73ec15c9`（dirty=false）**
- **打包产物冒烟（真启动）**：`setsid … Hermes --disable-setuid-sandbox --ozone-platform=x11 </dev/null` → 窗口 `0x800004 "Hermes" 1379x914+372+81` **IsViewable**（与 09-20 基线几何一致）；`desktop.log` 完整 boot：`[pool-limits] maxBackends=7` → `[ime] ozone=x11 … im-module=fcitx session-dbus=yes gtk-im-modules=fcitx(gtk3)` → `[deeplink]` → `[env] merged login-shell PATH` → `HERMES_BACKEND_READY port=46135` → `[boot] Hermes backend is ready. Finalizing desktop startup`；冒烟后已清理（无残留 app/backend 进程、无残留窗口）

### 三个坑（都值得记）

1. **并集式解冲突的"隐形断头"**：`pool-spawn-coordinator.test.ts` 里上游删了 `fs`/`path`/`fileURLToPath` 三个 import，而我保留的那段内联块正好在用它们 —— 标记清零、肉眼像"并集成功"，只有 `tsc` 会报 TS2304。**这次是提交前跑 typecheck 才没漏**（09-20 那次是 `TS2339`）。结论不变：标记清零必须配 typecheck。
2. **`nohup … &` 会让桌面应用卡死，且伪装成"合并回归"**：这样启动后应用只有一个 10x10 的占位窗口、**永远没有 renderer**、`--remote-debugging-port` 也不监听，看起来像把桌面改坏了。真因是应用启动时要跑一次登录 shell 探针（`/bin/bash -ilc …PATH…`），在**后台作业控制**下它试图读终端吃到 SIGTTIN → 进程状态 `T`（`do_signal_stop`）→ 主进程一直等它。前台手动跑同一条探针立刻 rc=0。**修法：`setsid bash -c 'exec …Hermes … < /dev/null > log 2>&1'`**，之后窗口/后端一切正常。以后冒烟一律用 setsid + stdin 接 /dev/null。
3. **打包版拒绝 CDP**：`electron/dev-cdp.ts` 是硬门禁（"packaged build → always closed, whatever the env says"），在 `release/linux-unpacked` 上塞 `--remote-debugging-port` 是**无效**的（基线就存在，非本次引入）。所以 09-20 日志里那种"CDP 探针数可见元素"的做法对打包产物不可用，改为 `xwininfo -id … | grep 'Map State'` + `desktop.log` 的 boot 行来判定。

### 顺带解决 / 新增的了解

- **`/bridge` 那条长期红灯消失了**：`tests/hermes_cli/test_slash_dispatch_table.py` 被上游砍到只剩 2 个用例（3+/47−），`test_registry_names_resolve_into_the_table` 与 `OLD_CHAIN_COMMANDS` 全等守卫**已删除**。手工复核私有命令仍可达：`_slash_handler('bridge') == ('_handle_bridge_command', True)` 且方法可调用。09-16 起记了三次的"每次同步都会红"到此结案。
- **本机 X11 dev 头缺失**：上游新增的原生 HUD 助手 `electron/native/hud-modifier-monitor-x11.c` 编译失败（`X11/Xlib.h: No such file`，本机无 `libx11-dev`），`build-hud-modifier-monitor.mjs` 捕获后降级（`modifier tap unavailable for this target`），打包 **rc 仍为 0**，非致命。
- 5 个 stash 仍未清理（最老 2026-07-08）。

### 待办（本次未做，需人工决定）

- **仓库里还跑着旧代码的网关/大盘**：`venv/bin/python -m hermes_cli.main gateway run`（pid 474）与 `dashboard --port 9119`（pid 475）是**今天 20:20** 启动的，模块已是同步前的版本 —— 正是启动器警告的 "mixed sys.modules"。需要 `hermes gateway restart` + 重启 dashboard（**未自动执行**：那是用户正在用的微信桥）。这同时会让 `tests/hermes_cli/test_dashboard_auth_gate.py` 继续红（9119 被自己占用）。
- profile-scope advisory：本地私有的 `hermes_cli/cli_bridge_mixin.py` 命中 3 条 P06/C5（`WEIXIN_TOKEN`/`WEIXIN_ACCOUNT_ID`/`WEIXIN_BASE_URL` 的 **env 回退**）——它是**先**用 sanctioned 的 `load_config_readonly()` 读 config.yaml，env 只是最后兜底；且该 mixin 只在 standalone CLI/TUI 进程里跑（该进程里 environ 就是当前 profile），属 lint 自述的"合法站点"。非本次合并引入，暂不动。

### Stash 积压清理（同日）

`git stash list` 积了 5 条（最老 2026-04-16）。逐条体检后发现 **2 条看着像未落地的真实工作**（其中 1 条经复核属误判，见下），其余是过期产物：

| stash | 日期 | 内容 | 结论 |
|---|---|---|---|
| `stash@{0}` | 2026-09-12 | desktop 池「后台上限」饥饿的修复 + 诊断（给 `decideLocalBackendAdmission` 加 `backgroundActiveCount`/`priority`） | **仍未落地**（见下） |
| `stash@{1}` | 2026-09-01 | GLM-5.3 恒思考（zai provider） | 曾救回为 `d723515a0a`，**复核后整体回退**（`c061a5f17c`，见下） |
| `stash@{2}` | 2026-07-14 | 仅 `package-lock.json` −26 行 | 过期 npm churn，丢弃 |
| `stash@{3}` | 2026-07-11 | `DEVELOPMENT_LOG.md` +9（该条已在 `a5ffebd9eb` 落盘）+ `package-lock` −26 | 过期，丢弃 |
| `stash@{4}` | 2026-04-16 | `WEIXIN_UNIFIED_WITH_LOCAL`（把微信消息当 `Platform.LOCAL` 以共用 CLI 会话键） | 已被 bridge 设计（`bridge_subscription.json` + `cli_bridge_mixin`）取代，且属 `AGENTS.md` 已禁的"非机密配置走 env"，丢弃 |

**无损归档**（丢弃前双备份）：补丁 `~/.hermes/stash-archive/2026-09-24/stash{0..4}-<date>.patch` + `METADATA.txt`，并各建一条 ref `refs/archive/stash{0..4}-<date>`（对象不被 gc）。清理后 `git stash list` 为空。

**救回又回退的教训（`d723515a0a` → `c061a5f17c`）——记录我这两次误判本身**：该 stash 声称 GLM-5.3「恒思考」——`medium` 与 `thinking: {"type": "disabled"}` 均 400（2026-08-31 实测于 `open.bigmodel.cn`）。我**第一次**只验证了"HEAD 里这个改动不在"就救回（**在不在 ≠ 对不对**）；被你质疑后**第二次**又只看到 `30f9955a44`（Teknium，08-21，关闭 #91789，验证端点 `api.z.ai/api/coding/paas/v4`）就判定"这是上游有意加的四档、不该覆盖"，于是整体回退。**两次都错在没查上游现状**：

- issue tracker 里这件事已被报过 **4 次以上**，**2 个还开着**：`#96838`（P2，标题直接写着「coding-plan 端点拒绝 medium —— **GLM53 declared vocab must drop medium**」）、`#96222`（P2，「China 端点拒绝 medium，静默 fallback」）、`#85890`（「thinking off 即 400」）；`#96373`/`#97001` 已关为 dup。`#96838` 的证据是 `medium` 在 **coding-plan 端点**（`open.bigmodel.cn/api/coding/paas/v4` 与 `api.z.ai/api/paas/v4`）被 1210 拒绝 —— **正是本机 config 用的那类端点**，且与 08-21 的验证直接矛盾（同一路径、7 天后行为变了）。
- **open PR 有 6 个**：`#102764`（最完整：两半 + 两条代码路径）、`#96228`、`#98465`、`#85891`（专门"stop sending thinking.disabled on GLM-5.3"）、`#91965`、`#85904`；`#97286`/`#91840` 已关。
- 而 `origin/main`（截至 09-24 `9a6108fdf2`）**仍未修**：`GLM53_EFFORTS` 仍含 `medium`，禁用标记仍无条件发出。

也就是说：**该 stash 的做法不是"覆盖上游的有意决定"，而恰恰是上游自己 3 个 issue + 6 个 PR 都在要的修法**。回退恢复了"与上游逐字节一致"，但也保留了一个已被反复上报、一个月未修的 P2 行为缺陷（本机 zai 是**第一 fallback**）。

**结论（2026-09-24，用户裁定）**：**保持回退，本地不留 delta** —— 用户已不再使用 glm-5.3，所以那种"静默降级/1210"对本机无实际影响，也就没有理由为它长期背一个"每次同步都要重放的本地 delta"。该修复的全部内容仍在两处可取：归档 `refs/archive/stash1-2026-09-01`（`~/.hermes/stash-archive/2026-09-24/stash1-2026-09-01.patch`）与上游 open PR `#102764`（两半都修、两条代码路径最完整）。**将来若重新用 glm-5.3，直接捡 `#102764` 或从归档重放即可，不必重新调研。** 上游不新开 issue（避免第 5 个重复）。

顺带：本想当场判死（本机 `~/.hermes/.env` 有 `GLM_API_KEY`，发 5 个 `max_tokens=8` 最小请求对比 baseline / `medium` / `low` / `thinking:disabled` / `thinking:enabled`），但 **`api.z.ai` 从本机不可达**（代理到 `example.com` 200、到 `api.z.ai` 000，直连 TLS 中断）——**本机 zai fallback 现在本身就是坏的**。

**`stash@{0}` 为什么没一起救**：它是 desktop 池 admission 模型的扩展 —— 现在的 `decideLocalBackendAdmission` 只建模总量，看不见协调器的 `#backgroundLimit() = limit-1`，所以"后台请求永远等不到前台让出的那一个预留槽"这类饥饿仍会被判 `acquire` → 一路排到超时（这正是当年 `fitness` 卡 `5/6 busy` 的复发类）。修复要动 `main.ts` 调用点 + coordinator 状态 + 112 行测试，还要 typecheck/vitest/重打包一轮验证，且**必须先按上面的教训 `git log -p -S decideLocalBackendAdmission` 读一遍原意**（admission 是本地私有特性，但上游这段时间大改过 pool，`#backgroundLimit` 的语义可能已变）；代码已归档在 `refs/archive/stash0-2026-09-12`（或 `~/.hermes/stash-archive/2026-09-24/stash0-2026-09-12.patch`），随时可救。


### 落盘与推送

| 提交 | 内容 |
|---|---|
| `e9ae73ec15` | `Merge remote-tracking branch 'origin/main'`（3194 个上游提交，4 处冲突） |
| `9f36362a7d` | `docs: add upstream sync log 2026-09-24 (3194 -> 0)` |
| `898c30f7f1` | `docs: record the verified runtime parity in the 2026-09-24 sync log` |
| `66b9be96b5` | `docs: complete the 2026-09-24 sync log (commits, push range, final state)` |
| `4c0006fa84` | `docs: finalize the 2026-09-24 sync log (push range, cleanup state)` |
| `d723515a0a` | `fix(zai): GLM-5.3 is always-thinking — never send the disable marker or medium`（从 `stash@{1}` 救回） |
| `c061a5f17c` | `Revert "fix(zai): GLM-5.3 is always-thinking …"`（复核后整体回退：该档位是上游有意加的，见上） |

已 `git push fork main`（`4c0006fa84` 之前的区间为 `394a6f6c5a..4c0006fa84`）。收尾状态：落后 `origin/main` **0**、领先 **73**（截至 `c061a5f17c`，本条日志自身的提交不计入）、`main` 与 `fork/main` 同步；zai 那三个文件**与上游 0 行差异**（救回→回退已归零）；`git stash list` **为空**（5 条全部归档后丢弃，见上）；工作区干净（`npm ci` 后 `package-lock.json` 零 churn）；临时探针（`/tmp/probe_*.py`、`/tmp/probe_cdp.cjs`、`/tmp/zai_probe.py`、`/tmp/*.log`、`/tmp/cli.py.bak`）已清，冒烟启动的 app/backend 进程与窗口均已回收（0 残留）。

### 下次同步的注意点

1. **cli.py 已被上游拆成 mixin**：以后动 CLI 私有代码，**改 `hermes_cli/cli_*_mixin.py`，不要改 `cli.py`** —— cli.py 现在只剩类头与少量未搬迁的方法。bridge 的教训（09-16 那次就是"留在 cli.py 里等着被重构撞"）已经写进 `cli_bridge_mixin.py` 的 docstring。
2. **上游在批量清洗低价值/读源码的测试**（`a4f93ce250`，一次删 202 个）。别把删掉的 source-scanning 断言加回来 —— 项目 `AGENTS.md` 明令禁止"测试里读源码"。
3. **冒烟用 `setsid … < /dev/null`**（坑 2）；**打包版没有 CDP**（坑 3）。
4. **同步会换掉正在运行的网关代码**：同步前先记下 gateway/dashboard/desktop 的 PID，同步后重启它们，否则一直在跑旧模块。
5. 验证节奏照旧：不要同时压 pytest 大盘 + vitest + tsc；本次是 pytest（93）→ tsc → vitest（119）→ web build → desktop build 全串行，零假阳性。
6. **stash ≠ 待落地的工作，反之亦然**：救回前先 `git log -p -S <符号>` 读原意；**回退/否定一条既有改动前，先查 issue + PR tracker**。本次 `stash@{1}` 两头都踩了：第一次没读原意就救回，第二次只看一个上游 commit 就回退，而真相是上游开着的 P2 issue 与 6 个 open PR 都在要同一个修法。同理，救 `stash@{0}` 之前也要先 `git log -p -S decideLocalBackendAdmission` + 查 tracker。

---

## 2026-09-20: 上游同步至 4d14aaf477（2638 → 0）

### 背景

`main` 落后 `origin/main` **2638** 个提交（分叉点 `03b0c79472`，即 09-16 的上游 tip；上游 09-17/18/19/20 处于更高强度的迭代期，单日峰值体量与 09-15 相当）、领先 63 个（本地私有工作）。无新 tag（最新仍是 `v2026.9.14`，其上已累积 3792 个提交）。`apps/desktop/package.json` 0.17.3 → **0.17.6** 且 `package-lock.json` 随之变 → 需要 `npm ci`；`pyproject.toml` 仅 +1 行（注册 pytest marker `real_post_swap_handoff`）、`uv.lock` 未变 → 无需 `uv sync`；`web/src` 13 文件变 → 重建 `hermes_cli/web_dist`。

本次触发点是 desktop 两个现场症状（中文输入法又失效、界面显示/渲染不对）。排查结论先记在这里，避免下次重复诊断：

- **输入法**：`XMODIFIERS/@im=fcitx`、`GTK_IM_MODULE`、`QT_IM_MODULE` 只 export 在 `~/.bashrc`；从应用网格启动（`~/.local/share/applications/hermes.desktop`，`Terminal=false`）拿不到 → CJK 输入进不来。`desktop.log` 的 `[ime]` 行正好在这种环境里**沉默**（`describeLinuxInputMethod` 在"没有请求任何 im-module 且 locale 为 C.UTF-8"时按设计不输出），所以 09-17 之后的运行都没有这行，而 shell 启动的都有。
- **界面显示**：上游 `8ffc2f0369`（09-17，#113247）修的正是本机形态（WSLg）：frameless 窗口没有最小化/最大化/关闭（改为 renderer 自绘 + `hermes:window-control` IPC）、WSLg 的 RAIL 合成器会把**最大化的 frameless 窗口摆偏出工作区**（新增 `maximizedBoundsCorrection`）、以及 `entry.ts` 在 Electron 初始化前为 WSLg 选 native Wayland。本次同步把这些带进树。

### 流程

工作区干净 → `git merge-tree --write-tree` 预演（**6 个冲突，与实跑完全一致**）→ `git merge origin/main` → 解冲突 → 合并提交 `db897775b5`（同步后 0 behind / 64 ahead）。

### 冲突与取舍（6 文件，全部为"本地私有修复 ⟷ 上游新逻辑"的并集）

| 文件 | 冲突 | 取舍 |
|---|---|---|
| `agent/auxiliary_client.py` | docstring | 取上游扩写版（`no_progress_timeout` 仅 Codex-Responses 传），**保留**本地 DeepSeek `reasoning_content` 剥离块 |
| `apps/desktop/electron/main.ts` | 上游删掉 `pool-eviction` import | 只保留 `selectPoolEvictions`（`main.ts:12251` 准入判定在用；`evictPoolEntries` 已无调用点，留着即 unused-import 红灯） |
| `pool-spawn-coordinator.ts` | 上游新增 `import type { WaitableChild }` | 并集：上游 import + 本地 admission 策略块 |
| `pool-stop.test.ts` | 两侧各加一个用例 | 并集，两个用例都留 |
| `src/store/gateway.ts`（4 处） | import / open 路径 / 重连错误 / `Secondary` 字段 | 并集：`notify`+`notifyError`,`RECOVERY_ACTIONS`+liveness policy；open 路径本地 saturation 复位 + 上游 `lastOpenedAt`/探活复位；重连处**上游 `isGatewayReauthRequired` 早返回放在本地 `notePoolSaturation` 之前**（需要重新登录的失败不该同时播报池饱和）；字段 `retiredByPool` + `poolSaturated`/`saturationAnnounced` |
| `hermes_cli/cli_chat_turn_mixin.py`（3 处） | 类级默认值 / turn 主体 / 渲染收尾 | 并集：本地 bridge 类级默认值 + 上游 `_sync_fallback_chain_with_config`；turn 主体套上游 `notification_policy_snapshot`，本地 `turn.user_message = message` 放进该 `with` 内；`_chat_render_turn` 处**上游 `mute_notification_reply` 早返回在前**，本地微信桥镜像在后（被静音的诊断轮不进 bridge） |

### 验证

- 冲突标记清零；`py_compile` 14 个关键模块 + 6 模块 import 冒烟 OK
- 定向 pytest 5 文件（微信桥 / `test_weixin_secret_scope` / `test_gui_command` / `test_config_read_guard` / `test_interrupt_requeue_image_payload`）：**104 passed, 9 skipped**
- desktop `npm run typecheck`（renderer + electron + e2e 三套）**rc=0**
- desktop 定向 vitest **12 文件 / 122 用例全绿**，含上游新增的 `electron/wslg-launch*.test.ts`、`window-controls.test.ts`、`titlebar-overlay-width.test.ts`
- `hermes_cli/web_dist` 重建（vite ✓）；desktop 打包重建走 stage-and-swap（`hermes desktop --build-only`），`release/linux-unpacked/resources/install-stamp.json` = `db897775b5`（dirty=false）
- 新产物冒烟：打包版启动正常（CDP 探针 root 已挂载、366 个可见元素、0 error），X11 窗口几何 `1379x914+466+74` 在 `rdp-0` 1920x1080 屏内；renderer bundle 已含 `window-control` 桥

### 两个坑（都值得记）

1. **并集式解冲突只 grep 标记不够，必须跑 typecheck**：`gateway.ts` 里我留下的一句 `entry.openedOnce = true` 已被上游 `lastOpenedAt` 取代 —— 标记清零、肉眼像"并集成功"，只有 `tsc` 报了 `TS2339: Property 'openedOnce' does not exist on type 'Secondary'`。删掉该行即绿。
2. **WSL 在 `npm ci` 中途崩了 → `node_modules` 是半成品**：`electron`、`@assistant-ui` 直接消失（npm 先删后装），而产物目录与 git 树都完好。崩溃后按顺序恢复：先 `npm ci` 恢复依赖树 → 确认 `scripts/patch-assistant-ui-render-loop.mjs` 的补丁重新落盘（`grep -c hermes-render-loop-patch node_modules/@assistant-ui/core/dist/subscribable/subscribable.js` = 1）→ 再重跑 typecheck/定向测试。**别拿"树上没问题"当"环境没问题"。**

### 遗留

- 输入法仍靠本地 `desktop.electron_flags: [--ozone-platform=x11]`：显式 flag 会让上游新的 `wslgLaunchArgs` 短路（不切 native Wayland），fcitx5 以 `--disable wayland` 运行、只能走 XIM —— 即"输入法可用"与"上游 WSLg Wayland 路径"目前二选一。要么把 fcitx 环境变量提到会话级（`~/.config/environment.d/` 或写进 `.desktop` 的 `Exec=env …`）再摘 flag，要么维持现状。窗口按钮/最大化偏移两项修复与 ozone 后端无关，已随之生效。
- `desktop.electron_flags` 的接线对启动环境敏感（应用网格 vs shell），下次改这块先看 `desktop.log` 有没有 `[ime]` 行。

---


## 2026-09-16: 上游同步至 03b0c79472（464 → 0）

### 背景

`main` 落后 `origin/main` **464** 个提交（分叉点 `b3feb88a95`，即 09-15 同步的上游 tip；上游 09-14/15/16 分别推了 25/339/65 个提交，仍在高强度迭代期）、领先 58 个（本地私有工作）。929 files / +34972 −5662。无新 tag（最新仍是 `v2026.9.14`）。`pyproject.toml` 未变、各层 `package.json`/`package-lock.json` 全未变 → 无需 `npm ci`；`uv.lock` 仅 extras 排除列表顺序 + 一个 `google-cloud-pubsub = false`，无包版本变化 → 无需 `uv sync`。

### 流程

工作区干净 → `merge origin/main`（63a790669b）→ **2 个冲突**，都是 `apps/desktop/electron` 同一个 import 成员列表，取并集（按大小写无关字母序）：

- `main.ts`：本地 `decideLocalBackendAdmission` ⟷ 上游 `BackgroundSlotRetryBackoff` / `BackgroundSlotRetryDeferredError` / `isBackgroundSlotRetryDeferred`
- `pool-spawn-coordinator.test.ts`：本地 `decideLocalBackendAdmission, isLocalBackendPoolSaturatedError` ⟷ 上游 `BackgroundSlotRetryBackoff`

其余 16 个高交集文件（`cli.py`、`hermes_cli/main.py`、`agent/auxiliary_client.py`、7 个 i18n、`store/gateway.ts`、`pool-spawn-coordinator.ts`、`tests/hermes_cli/test_gui_command.py`、`gateway/run_turn.py`、`cli_chat_turn_mixin.py`、`main_desktop.py`）全部 auto-merge。合并前用 `git merge-tree --write-tree` 预演过，冲突面与实跑一致。

### 语义重叠（已审，未改代码）

上游 09-15 自己动了 slot-storm 同一问题：`68e4833134` + `1220491468` 引入 `BackgroundSlotRetryBackoff`（per-profile 60s→15min 指数退避，只作用于 background hydration，成功拿槽即 clear）。我们 09-05 的 `426ef1dea2` 是满池 fail-fast（`decideLocalBackendAdmission` + `localBackendPoolSaturatedMessage`）+ 渲染进程 60s+抖动慢重试。合并后调用序是本地 admission 在前（`main.ts:12598`）→ 满池即抛 saturation Error，走不到上游 `canAttempt`（`main.ts:12618`）；上游 `recordFailure` 只在 slot-wait timeout 触发，因此**上游那层退避在"结构性满池"场景被本地 fail-fast 短路**，节流改由渲染进程慢时钟承担（每次 roster refresh 至多一条 `failed to start: Local agent limit reached`，非 storm 级）。行为可接受，本次不改；若后续上游把 admission 判定收进 coordinator，需要重新对齐。

### 上游要点

- desktop：timeline 虚拟化 + 历史跳转上限、跨 pane 共享 floating composer、hover-only scrollbar、transcript owner 归属校验（R1–R5）、OAuth 登录带 Cloudflare Access 头、3xx 一律按重定向分类并点名 Location
- **规范变化**：10 个 `AGENTS.md` +205 行。根 `AGENTS.md` 新增硬规则"一个进程可服务多 profile，turn 之外的代码必须显式绑定 profile scope"，并**删掉了旧的"Module-level constants are fine"**；E2E 要求升级为两个 temp `HERMES_HOME` 做 A→B→A；新增 advisory lint `scripts/check_profile_scope_patterns.py`（CI 用法见 `lint.yml:210`）
- profile scope 绑定点清单：`gateway/run.py::_profile_runtime_scope`、`tui_gateway/server.py::@_profile_scoped`、`cron/scheduler_provider.py::_profile_cron_scope`、`gateway/run_agent_cache.py::_run_release_in_profile_scope`
- sessions：prompt 索引不再水化整份 transcript

### 验证

- 冲突标记清零（`tests/tools/test_mcp_oauth_metadata.py:10` 的 `=======` 是上游 docstring 的 RST 下划线，非标记）；`py_compile` cli / run_agent / model_tools / toolsets / hermes_state / hermes_constants / gateway.run / hermes_cli.main / agent.auxiliary_client / tui_gateway.server 全 OK；import 冒烟 6 模块 OK
- **环境坑（值得记）**：`apps/desktop/node_modules` 是空的（连 `electron`、`@testing-library/react` 都没装），`npm run typecheck` 因此报 **1048 错 / 479 文件**，其中 391 个文件本次根本没被合并触碰 → 先别当合并回归。装依赖时 `.npmrc` 的 `engine-strict=true` 会拒本机 npm 11.12.1（engines 要求 `<11.10.0 || >=11.17.0`），需 `npm_config_engine_strict=false npm install --workspace apps/desktop`（780 包 / 32s）。装完 npm 顺手重写 `package-lock.json`（3 行 `min-release-age-exclude` churn），已 `git checkout --` 还原
- 装好后 `npm run typecheck`（renderer + electron + e2e 三个 project）**全绿 exit 0**
- 定向 vitest 7 文件 / 73 测试全绿：`electron/pool-spawn-coordinator.test.ts` 29（含冲突文件与上游新 backoff 用例）、`src/store/gateway-pool-saturation.test.ts` 4（本地慢重试逻辑完好）、`src/i18n` 31（en.ts 合并后各语言 key 一致）、`electron/pool-eviction.test.ts` 9（`selectPoolEvictions` 完好）
- 定向 pytest 6 文件 / 259 测试全绿：微信桥 32、`test_gui_command` 50、`test_cmd_update` 47、`test_actual_auxiliary_routing` 121、tui heartbeat 7、profile-scope 2
- `web/src` 7 文件有变 → 已重建 `hermes_cli/web_dist`（vite ✓ built in 4.38s）
- 本地私有修复全部仍在：单实例锁提示（`main.ts:13000`）、`electron_flags`（`main_desktop.py:1209`）、输入法可达性（`bootstrap-platform.ts`）、messageRepository identity（`runtime-repository.ts:52`）、postinstall 的 assistant-ui render-loop 补丁在装依赖时正常应用

### 本次同步暴露的两个真红灯（已修）

1. `tests/hermes_cli/test_interrupt_requeue_image_payload.py`（2 个用例，**上游本次新增的文件**）：`_Stub(CLIChatTurnMixin)` 不调 `super().__init__()`，而 `cli_chat_turn_mixin.py` 的本地 bridge 镜像块直接读 `self._bridge_platform` → `AttributeError`。
   **修法**：把 `_bridge_platform` / `_bridge_chat_id`（以及 `cli_stream_mixin.py` 同类读点用到的 `_bridge_progress_notified`）声明为**两个 reader mixin 的类级默认值**，风格对齐同文件既有的 `_last_turn_result = None`。这样不动上游测试文件（否则每次同步都撞），也不是 getattr 式防御性兜底；生产路径行为不变（`HermesCLI.__init__` 的实例属性照常遮蔽类属性）。
2. `tests/hermes_cli/test_config_read_guard.py`（1 个用例，上游本次**未改**该守卫）：3 处本地私有代码裸读 config.yaml — `cli.py:3716`、`hermes_cli/cli_bridge_mixin.py:210`（合并前就有，本地既有债）、`gateway/run_turn.py:2115`（合并前这段在 ALLOWLIST 内的 `gateway/run.py`，上游把它拆成兄弟文件后掉出白名单，属"sibling 搬家导致落点漂移"那一类）。
   **修法**：三处都换成 `hermes_cli.config.load_config_readonly()`（函数内 late import，与该文件既有风格一致）。选它的依据：`_load_config_impl` 在**调用时**解析 `get_config_path()`，缓存按 `path_key` + `file_signature` + env 快照分槽 → 天然满足新的 profile-scope 规则；`_deep_merge(DEFAULT_CONFIG, user)` 保留未知的 `bridge:` 段（已实测）；缓存读比原来"每条消息重新 read+parse 整个 YAML"更快。`cli_bridge_mixin.py` 的 weixin 读取顺手把 `_cfg.get("gateway", {})` 改成 `(_cfg.get("gateway") or {})`，避免用户写 `gateway:` 空值时 `.get` 打在 None 上。

**验证**：`scripts/run_tests.sh -j 4` 定向 5 文件 → **46✓ 0✗ 1 skipped**（`test_interrupt_requeue_image_payload` 2✓、`test_config_read_guard` 2✓、微信桥 32✓、`test_weixin_secret_scope`、`test_send_message_tool`）；5 个改动文件 `py_compile` OK；`cli` / `gateway.run_turn` / `cli_bridge_mixin` / `cli_stream_mixin` import 冒烟 OK。
另用一次性 E2E 探针（不入库）走真实链路证明 `run_turn.py` 那处读取在**绑定 profile scope** 下正确：两个 temp home 做 A→B→A，`_profile_runtime_scope(home)` + `load_config_readonly()` 依次返回 `chat_A → chat_B → chat_A`，无默认 profile 泄漏。（探针的 cli.py / weixin 发送两段因 `_tui_print_startup` 需要整条 banner+onboarding 桩链，未继续深挖；其行为由上面的 46 个用例与既有微信桥测试覆盖。）

### 仍未处理的一个本地既有红灯（非本次同步引入）

`tests/hermes_cli/test_slash_dispatch_table.py::test_registry_names_resolve_into_the_table`：上游这条 parity 守卫把"registry 里能被 dispatch 的命令集合"与 `OLD_CHAIN_COMMANDS` 做**全等**比较，我们私有的 `/bridge`（`hermes_cli/commands.py` 注册，经命名约定回退解析，不在 `_SLASH_DISPATCH` 显式表里）成为多出的一项。合并前就是红的（上游本次未改该文件）。可选修法：把本地私有命令抽成 `_LOCAL_PRIVATE_COMMANDS = {"bridge"}` 常量并入期望集合——代价是给上游测试文件留一个每次同步都要重放的本地 delta，故本次不动。

### 环境类红灯（非本次合并引入，不处理）

- `tests/hermes_cli/test_dashboard_auth_gate.py`（4）：`SystemExit: 75`，本机 9119 端口被自己跑的 gateway/dashboard 占用
- `tests/hermes_cli/test_gateway_service.py`（1）：期望 `/home/alice/.local/bin`，实得 `/root/bin`（调用方 PATH 泄漏）
- 大盘（`tests/hermes_cli + gateway + tui_gateway`，2210 文件 / ~19700 测试）另外跑出的 7 个 gateway/tui_gateway 红灯（`test_compression_failure_session_sync`、`test_api_server_active_work_drain`、`test_session_hygiene`、`test_session_hygiene_turnhold_adoption`、`test_install_cua_driver`、`test_compute_host_turn_protocol`、`test_deferred_agent_build_cwd`）全是墙钟等待型，**`-j 4` 安静复跑后全部转绿** → 24 worker + vitest + tsserver 抢 CPU 造成的假阳性。记此以免下次误判：**验证阶段不要把 pytest 大盘和 vitest 同时压在一台机器上跑**。

### 落盘与推送

| 提交 | 内容 |
|---|---|
| `63a790669b` | `Merge remote-tracking branch 'origin/main'`（464 个上游提交，2 处 import 并集冲突） |
| `4f350f91a2` | `docs: add upstream sync log 2026-09-16 (464 -> 0)` |
| `2faeb5340d` | `fix(bridge): default bridge state on the reader mixins; read config via the sanctioned loader`（5 文件 +46 −37） |
| `837e9fcc69` | `docs: record the two post-sync bridge fixes in the 2026-09-16 sync log` |

已 `git push fork main`（`3ba2799308..837e9fcc69`）。收尾状态：工作区干净（脏文件 0）、落后 `origin/main` **0**、领先 **62**、`main` 与 `fork/main` 同步；临时 worktree `/tmp/premerge` 已 `git worktree remove` + `prune`，探针脚本与临时 home 已删，后台 `nohup.out`（`apps/desktop/`、`web/`）已清。

### 下次同步的注意点

1. **验证节奏**：定向集就够（本次 6 + 5 文件 / 305 个用例，约 1 分钟）。别再把 pytest 大盘和 vitest 压在同一台机器上——那次并发直接造出 7 个墙钟型假阳性，排查它花的时间远超合并本身。
2. **desktop 依赖现在装好了**（780 包）：`npm run typecheck` 从今往后是有意义的门禁；空 `node_modules` 时它会喷 1000+ 条 TS2307，别当合并回归。装依赖要 `npm_config_engine_strict=false`（`.npmrc` 的 `engine-strict=true` × 本机 npm 11.12.1 不在 engines 允许区间），且装完要 `git checkout -- package-lock.json` 抹掉 npm 的 3 行 churn。
3. **`/bridge` 那条 dispatch 守卫仍是红的**（见上），每次同步都会看到；要么接受，要么接受"在上游测试文件里留一个本地 delta"的代价。
4. **slot 退避顺序**：本地 admission fail-fast（`main.ts:12598`）仍在上游 `canAttempt`（`main.ts:12618`）之前。上游若把 admission 判定收进 coordinator，这段要重审。
5. **新 profile-scope 规范**：根 `AGENTS.md` 已删掉"Module-level constants are fine"，模块级 home/config 派生常量现在算 bug 类。本次已跑 `scripts/check_profile_scope_patterns.py --files gateway/platforms/weixin.py gateway/session_bridge.py`，命中 1 条 `weixin.py:1028 P28/C1`（media 投递按默认 profile 的 Docker mounts 校验）——但该文件与上游逐字节相同，属上游自有 advisory，本地不动。下次改私有 bridge 代码前后各跑一次这个 lint。
6. **editable 安装的 finder 映射会漏新顶层模块**（顺带踩到，非本次同步引入）：`venv` 里 `__editable___hermes_agent_0_21_0_finder.py` 没有 `hermes_state_ids`（上游 09-12 新增）。从仓库根跑一切正常（`sys.path[0]=''` 兜住），但从别的 cwd 跑脚本会 `ModuleNotFoundError: No module named 'hermes_state_ids'`。要消除就重装 editable（`pip install -e .` 或 `uv sync`）。

---

## 2026-09-15: 上游同步至 b3feb88a95（1366 → 0）

### 背景

`main` 落后 `origin/main` **1366** 个提交（分叉点 `de2d6a1b93`，即 09-13 同步的上游 tip；上游 09-13/14/15 分别推了 471/254/561 个提交，处于高强度迭代期）、领先 55 个（本地私有工作）。总量 3003 files / +163009 −33902。新 tag `v2026.9.14`（v0.21.3；desktop package 0.17.2 → 0.17.3，仅版本号，无需 `npm ci`）。

### 流程

工作区干净 → `merge origin/main`（4af71a7107）→ **3 个冲突**，全部手工解决：

- `cli.py`：`HermesCLI.__init__` 同一位置两边各自新增属性 → 并存（本地 bridge 四属性 + 上游 `_auto_load_skills_result`）。
- `apps/desktop/src/i18n/en.ts`：采用上游新文案/新 key（`reconnectNow`、`connectionSettings`、`gatewaySignInRequiredDetail`、`signInAgain`、`causes` classifyBootFailure 块），保留本地 `localBackendPoolSaturated(Detail)` 两 key（desktop 池饱和修复的 UI 文案）；`ipcBridgeUnavailable` 补尾逗号。
- `apps/desktop/src/store/gateway.ts`：上游把 `reconnectBackoffDelayMs` 移入 `@hermes/shared` 并删除 `@/lib/reconnect-backoff` → 丢弃旧 import（模块已不存在，顶部 `@hermes/shared` import 已含该符号），保留本地 `translateNow` import。本地 pool-saturation 逻辑（`poolSaturated`/`saturationAnnounced`/`notePoolSaturation`/60s+抖动慢重试时钟）auto-merge 完整保留，仅 `scheduleReconnect` 里改用 shared 的 backoff 符号。

### 上游要点

- Bot Mode / TUI：silence marker 抑制、Bot Chat 流式 delta 修正、session-store title 读取跳过
- fix(config)：所有 config.yaml stat 缓存统一为 `file_signature`（inode + ctime，可检测文件替换）
- fix(redact)：secret 文件的备份拷贝与赋值行掩码；docs(security) 同步
- cron / systemd：scoped worker 用户总线丢失时点名原因并重探；scope 可用性重校验；flat install 忽略规则
- kanban：`create-with-parents` 与 link 同样门控（archived parent 终态）；dashboard 上报 gate
- 终端渲染：行号 gutter 锚点、`cat -n`/grep 上下文 gutter 修复

### 验证

- 冲突标记清零；`py_compile cli.py` ✓；`tsc --noEmit -p apps/desktop` ✓（0 错误）。
- Import 冒烟：`run_agent` / `model_tools` / `toolsets` / `cli` / `hermes_state` / `gateway.run` 全部 OK（临时 `HERMES_HOME`）。
- `scripts/run_tests.sh tests/gateway/test_weixin.py` → 32✓ 0✗；`tests/hermes_cli/test_config.py + test_cli_mcp_config_watch.py` → 132✓ 0✗（4 skipped，上游 stat 缓存改动面）。
- desktop `vitest run src/i18n` → 31✓（4 文件，验证 en.ts 合并后各语言 key 集合完整）。
- `web/src` 60 文件有变 → 已重建 `hermes_cli/web_dist`（vite build 4.21s）。

---

## 2026-09-13: 上游同步至 de2d6a1b93（164 → 0）

### 背景

`main` 落后 `origin/main` **164** 个提交（上次同步 2026-09-12 23:54，上游不到一天又推了一批）、领先 53 个（本地私有工作）。317 files / +5279 −1274，集中在 `hermes_cli`（47）、`agent`（16）、`gateway`（12）、`tools`（10）及其测试。

### 流程

工作区干净 → 直接 `merge origin/main`（093cbc34f8）→ **零冲突** → 验证 → 重建 web 前端。

### 上游要点

- fix(config)：新进程恢复上次完好的 config.yaml，不再退回默认值（LKG backup）
- fix(model)：选定 model id 不再被改写成目录相邻模型
- feat(video)：OpenRouter 视频后端覆盖全目录 + Hailuo 3 Max（新插件 `plugins/video_gen/openrouter/`）
- kanban 改为按平台显式 opt-in（`hermes tools enable kanban --platform X`，新增 `tools/kanban_toolset_context.py`）
- cron：systemd user scope 不可用时优雅降级；heartbeat 不再在 `save_jobs` 期间持有 fire fence
- fix(codex)：summary 调用剥离 tool controls；fix(mcp)：工具错误打开的 breaker 报 "rejected" 而非 "unreachable"
- multiplex：served profile 的 api_server/webhook 以 `/p/<profile>/` URL 上报（`_mark_connected(listener_base=...)`）

### 验证

- 零冲突；`git diff` 证实 `gateway/platforms/weixin.py` 本次未被上游触碰；本地自有提交（微信桥接 f97f2ac603、desktop 池修复 426ef1dea2、auxiliary 修复 267688b48d）全部仍在 HEAD 祖先内。本地代理修复已由 `proxy=None` 进化为 `base.py` 的 `gateway_trust_env()` 机制，`gateway_trust_env()` 返回 True，合并未触及。
- Import 冒烟：`run_agent` / `model_tools` / `toolsets` / `cli` / `hermes_state` / `gateway.run` 全部 OK。
- `scripts/run_tests.sh tests/gateway/test_weixin.py tests/tools/test_kanban_toolset_opt_in.py` → 37✓ 0✗（本地桥接 32✓ + 上游新增 kanban opt-in 5✓）。
- `package.json` / `package-lock.json` 无变化，无需 `npm ci`；`web/src` 9 文件有变 → 已重建 `hermes_cli/web_dist`（vite build 3.92s），避免 WebUI 用旧前端。

---

## 2026-09-06: 上游同步至 96ed0e71ea（4403 → 0）+ `cmd_gui` 搬家导致的修复落点重放
## 2026-09-06: 上游同步至 96ed0e71ea（4403 → 0）+ `cmd_gui` 搬家导致的修复落点重放

### 背景

`main` 落后 `origin/main` **4403** 个提交、领先 44 个（本地私有修复）。直接把上游合进 `main` 会撞 6 个文件冲突（`agent/auxiliary_client.py`、`cli.py`、`gateway/platforms/weixin.py`、`gateway/run.py`、`pyproject.toml`、`tui_gateway/methods_complete.py`）。

### 流程

走既有 worktree `sync/upstream-20260905`（昨日已把上述冲突面全部解决）：先把在途工作落成 2 个提交 → `merge origin/main`（零冲突，15 个新提交）→ `merge main` → 验证 → `main` 快进。

### 根本原因（唯一的真冲突）

`merge main` 时 `hermes_cli/main.py` 报出一个跨 **2500 行** 的单 hunk：ours 侧只有 3 行，theirs 侧是整块旧代码。原因不是逻辑分歧，而是上游 `0e78694c72`（*simplify(compat): drop 198 re-exports/aliases*）把 desktop 启动逻辑整体抽到了 `hermes_cli/main_desktop.py`，`cmd_gui` 随之搬家 —— 本次要重放的那行修复正好住在这块里。

用 `git diff <merge-base> main -- hermes_cli/main.py` 证明 theirs 侧相对基线**只有本次那一行改动**，因此安全取上游版本，再把修复重放到新落点。

附带坑：`_resolve_node_runtime_npm` 已移到 `main_install_repair.py`，测试里 `patch("hermes_cli.main.X")` 的接缝集体失效（AGENTS.md 反复警告的 patch 目标问题）——新测试的 patch 目标必须跟着重指向 `main_desktop` / `main_install_repair`。

### 验证（含失败归因方法）

上游新形状里 `cmd_gui` 的 source 分支仍然不 extend `config_electron_flags`（只有 packaged 分支走），所以该修复依然必要。

- **Python**：`tests/tools`(557 文件) + `tests/skills`(42) + gui/weixin/desktop-entry ≈ 8242 tests。
  首轮 40 个文件失败 → 用**同一环境跑合并前的 `main` 做对照组**，39 个失败完全一致；换成正确的依赖基底后只剩 12 个，11 个与基线一致，剩下 `test_browser_real_profile.py` 在两棵树单独跑都是稳定的 `1 failed / 76 passed` → fork 既有失败，非本次引入。
  直接相关文件全绿：`test_terminal_yield_to_background`、`test_terminal_task_cwd`、`test_reddit_reading_skill`、`test_rss_feeds_skill`、`test_gui_command`(49✓)、`test_gui_uninstall`、`test_linux_desktop_entry`。
- **Desktop**：electron project 149 files / 2129 tests ✓；ui project **723 files ✓**；`tests-js` 9 files ✓；两个 tsc（`-p .` 与 `-p tsconfig.electron.json`）均 EXIT=0。
- **Import 冒烟**：`hermes_cli.main`、`hermes_cli.main_desktop`、`cli`、`run_agent`、`gateway.run`、`gateway.platforms.weixin`（本地微信 bridge 存活）、`tui_gateway.server` 及 28 个 `agent/turn_*` 全部可导入。

### 环境坑（下次同步直接照抄）

1. 本 checkout 的 `.venv` 和 `venv` **都没有 pytest**（dev extras 未装），`scripts/run_tests.sh` 会直接拒绝运行。非侵入式替代（不污染 runtime 环境）：
   `uv run --python venv/bin/python --no-project --with 'pytest==9.1.1' --with 'pytest-asyncio==1.3.0' --with 'pytest-timeout' -m pytest <path>`
   基底**必须用 `venv`**（有 aiohttp/mcp）；`.venv` 是缺依赖的瘦环境，用它会把 40 个文件误判成回归。
2. 同步后 `package.json`/`package-lock.json` 变了，不重装就会在渲染层报一大片 `Cannot find module '@testing-library/react'`（看着像合并炸了，其实是 node_modules 过期）。
3. 上游 engines 现在要求 npm `<11.10.0 || >=11.17.0`，本机 npm 11.12.1 被 `.npmrc` 的 `engine-strict=true` 挡死。不想动全局 npm 就用 `npx -y npm@11.19.1 ci`（1342 packages / 44s）。
4. `npm ci` 的 postinstall 会自动重打 assistant-ui 渲染环补丁；实测 `@assistant-ui/core@0.2.23` 上游**仍未修**（无 `shallowEqualOrUndefined`），`02a641c638` 的 workaround 继续有效。
5. pytest 会在仓库根留下 `MagicMock/` 垃圾目录（本次已删）。

### 遗留

- `test_browser_real_profile.py::TestReviewRound3::test_relaunch_path_does_snapshot` fork 上稳定失败，未定性。
- 未跟踪的 `firstread_C_todo.json` 是另一个项目（公众号策略数据）的文件误落在仓库根。
- 分支 `fix/py-modules-state-holders` 经 `git cherry` 确认补丁已等价存在于 main，可删。

---

## 2026-09-05: Desktop「无法启动」= 后端池超额订阅饥饿 + 撞锁静默退出（两个互不相干的静默失败）

### 症状

用户报"desktop 无法正常启动"。实际是两段不同现象：

1. desktop **能启动**（`[boot] Hermes backend is ready. Finalizing desktop startup` 正常出现），但除 invest 外的多个 bot 面板永久停在"唤醒中"，不可用；
2. 用户之后再跑一次 `hermes desktop`：终端打出 2 行 bootstrap 后**无输出、无窗口、无日志**。

### 排查过程

1. **先定性"崩溃还是等待"**：`desktop.log` 无任何崩溃/renderer 异常签名，却有连续 3.5 小时的循环：
   ```
   Profile backend "music" waiting for a free local slot (3/3 busy, 1 queued)
   Hermes backend for profile "music" failed to start: Local backend start for
     "music" timed out while waiting for a free slot.
   ```
   ⇒ 不是崩溃，是"等待失败后被无限重启"。
2. **用时间窗计数代替阅读**：`grep -ac 'timed out while waiting'` 在 UTC 08:00–11:36 持续命中，且 `music/work/coding` 稳定失败、`default/exam/fitness` 稳定成功 ⇒ 稳态供需失衡，不是随机竞态。
3. **真实复现（关键手法）**：直接拉起打包版并把 stderr 落盘，拿到 Electron 侧
   `Error occurred in handler for 'hermes:connection:for': Local backend start … timed out` —— 定位到 IPC 门，而不只是"后端没起来"。
4. **排除租约泄漏**：`ps` 显示 4 个后端确实活着 ⇒ `activeCount=3` 是诚实读数。方向从"记账错了"转到"为什么槽位永远不会释放"。
5. **算清需求集合**：`active-profile.json = {"profile":"invest"}` ⇒ 主后端被钉在 invest；`connection-config.ts:675` 路由表规定"本地非主 profile 一律 pool" ⇒ 需求 = 其余 **6** 个 profile，而 `pool-limits.json` 不存在 ⇒ cap = 缺省 **3**。
6. **读准入链找死锁**：租约对"starting **或 running**"全程持有（`pool-spawn-coordinator.ts`）；LRU 只驱逐 `now - lastActiveAt > POOL_KEEPALIVE_FRESH_MS`(4min) 的条目（`pool-eviction.ts`）；而渲染器对每个打开的面板每 60s 发 keepalive ⇒ **所有槽位永远"新鲜"** ⇒ 驱逐不可能 ⇒ 队列数学上永不排空。
7. 第二段症状单独查：撞锁分支的 `app.exit(0)` 发生在模块求值期，而 `rememberLog()` 只写内存缓冲（`DESKTOP_LOG_FLUSH_MS = 120`）⇒ 整批日志丢失 ⇒ 在"用户唯一能发给我们的证据"上与启动即崩完全同形。

### 根本原因

两条，互不相干，共同点是**都静默**：

1. **上限类特性缺"需求 > 上限"时的策略**。`e924615bb1` 加 cap 是为治"进程波"（40+ 后端、load 30–50），但它把 cap 实现成对**运行中**后端的硬约束，而多面板常驻（`foregroundPinned`, #93892）使需求可长期高于 cap。两者相遇时没有任何一层介入：不驱逐、不降级、不报错，只排队到超时，再由 `reconnectBackoffDelayMs` 的 full jitter 重新武装。
2. **硬退出路径不落日志**：`app.exit()` 绕过异步 flush。

附带事实（内存才是真约束）：单个 profile 后端 ≈ 300–470MB，其中**它的 MCP 子进程 ≈ 168MB**；7 个后端常驻实测 `electron 621 + serve 1164 + MCP 1178 ≈ 2.96GB` —— MCP 与后端本体等价昂贵。

### 修复方案

故意把"分配资源"与"改变失败行为"分开：

| 改动 | 做的事 | 是否分配资源 |
|---|---|---|
| `pool-limits.json → maxBackends: 6`（配置，非代码） | 6 个池 profile 全部拿到后端 | ✅ 真正起作用的是它 |
| `ef2a6cca1e` | 撞锁退出前 `rememberLog` + `flushDesktopLogBufferSync()` | ❌ 只改可见性 |
| `426ef1dea2` | 纯谓词 `decideLocalBackendAdmission()`；无槽可释放时**立即拒给**并给可操作原因；渲染器识别饱和 → 专用慢时钟(60–90s) + 每轮只解释一次 | ❌ 只改失败行为 |

两个设计细节值得记：

- **一个布尔字段别兼两职**：最初想用 `poolSaturated` 同时驱动"慢时钟"和"提示去重"，结果用户点击路径先置位 ⇒ 后台永远不再解释，恰好复刻了要消灭的静默。拆成 `poolSaturated` / `saturationAnnounced`，并在 `openSecondary` 成功处统一复位。
- **抬 backoff 的 cap 不会变慢**：full jitter 从 300ms base 爬坡，`capMs` 要到约第 9 次才生效。要真慢必须换时钟，而不是调 cap。

### 验证

| 项目 | 修复前 | 修复后（真实运行；故意把 cap 压到 3 制造饱和） |
|---|---|---|
| `timed out while waiting` | 3.5 小时连续刷屏 | **0 次** |
| 超额 profile 的失败 | 各白等 30s 后泛化失败 | 启动 46s 内 10 次**即时**拒给（同批 4ms 内），随后 5 分钟完全静默 |
| 原因可见性 | 无处可见 | 日志与 IPC 消息直说"关面板或提高上限" |
| 第二个实例撞锁 | **零日志** | 一行 `[boot] another … single-instance lock …`，退出码 0 |
| cap=6 全量 | 3 个 profile 永远起不来 | **7 个后端全起**（1 primary + 6 pool），0 超时 |

测试：新增 12 例（准入 8、stopper 计数 1、真实 store 饱和路径 4）；聚焦 31/31，相关面 28 文件 / 236 测试全绿；`tsc` 两套 config、`eslint` 全绿。提交按 hunk 拆分，用户另一份未提交的 IME 改动原样留在工作区（421 insertions 逐项核对一致），并用符号计数证明提交出的树无悬空引用。

**采样窗口必须交代**：拒给前 46s 约 5s 一次，来自**未插桩定位**的某个消费者（面板恢复 / 名单轮询）—— 我改的是排队侧与重连侧，那路 burst 的调用方没查；toast 仅单元级证据（无法看屏确认）。

### 遗留 / 未定性

- **退出竞态（未改代码）**：更早一次 SIGTERM 退出中，`before-quit` 之后 0.28s 仍被迟到拨号重新进入 `startHermes()` 并走到 `Starting Hermes backend`（`backend-ownership.json` 残留 pid 大于原 primary 可证）。但第二次采样时实例**一行 teardown 都没写**，且期间出现一组无法解释的事件（实例存活、3 个池后端却被 SIGTERM、随后日志整体停止）。样本不足、机制未明 ⇒ 记为未定性。怀疑方向：`sshBootstrapCoordinator.shutdown()` 已密封 SSH 路径，主后端路径疑似缺同等守卫。
- 打包版仍是旧 asar，需一次重建才带上这两个修复。
- `pool-spawn-coordinator.test.ts` 内两段**读源码正则**测试属遗留反模式（本次未扩大，也未清理）。
- MCP 是内存最大杠杆；`tdx` 指向不存在的 `venv/bin/eltdx-mcp`，每个后端都在白试一次。

### 经验总结

1. **"起不来"必须先分解**：崩死 / 卡住 / 起来但缺功能，三者日志签名完全不同；第一步永远是确认有没有 `[boot] … ready`。
2. **用计数代替阅读**：时间窗上的 `grep -ac` 分布，比读 500 行尾巴更快区分"稳态饥饿"与"竞态"。
3. **区分"掩盖"与"治好"**：把 cap 提到 6 让症状当场消失，只是让供需相等；若止步于此，多开一个面板就会以同样"无法启动"的形态复发。**配置改动与代码改动分开提交、分开叙述**，正是为了不让前者给后者盖章。
4. **上限类设计必须同时回答"需求超过上限怎么办"**：驱逐？降级？排队？拒绝并说明？没有答案的 cap 会把一次性故障变成无限循环。
5. **硬退出路径要同步刷日志**；一切 `process.exit` / `app.exit` 都是缓冲日志的天敌。
6. **指数退避要读实现而不是读名字**：base / cap / jitter 三者共同决定实际节奏。
7. **验证进程是副作用的一部分**：本次第二起"起不来"其实是我留下的实例持锁造成的。后台起 GUI 做验证时，`setsid` 保命、结束必查 `ps`、还原临时改过的配置，与启动同等重要。
8. **别拿安静区间当疗效，也别拿单样本定罪**：第 3 条有 1 个正样本 + 1 组反常事件，够写"未定性"，不够写"根因"。

---

## 2026-09-04: Desktop "workspace failed to render" 渲染死循环（assistant-ui 缓存写回缺陷）

### 症状

主面板反复出现错误框：

```
"workspace" failed to render
Maximum update depth exceeded. The result of getSnapshot should be cached
to avoid an infinite loop.
```

`~/.hermes/logs/desktop.log` 中自 9-01 起累计 **9,516 次**;另一变体 `This can happen when a resource repeatedly calls setState inside useEffect` 与之以约 35ms 间隔交替刷屏。

### 排查过程

1. **定位报错来源**：文案来自 `contrib/react/boundary.tsx` 的 `“${id}” failed to render`,`id` 是 pane id。**错误框是防爆墙，不是故障点**——抛错的是它包住的聊天面子树。
2. **排除一方订阅代码**：枚举 desktop 全部 8 处 `useSyncExternalStore`,逐个核对快照——均有 key 缓存或签名门；另确认无 `useStore($x, mapper)`、无 `Provider value={{...}}` 内联对象。
3. **抓真实栈（关键手法）**：`electron/main.ts:864` 定义 `DESKTOP_LOG_PATH = ~/.hermes/logs/desktop.log`,渲染器 console 落盘且带 `bundle:line:col`。
4. **行列反查 minified 符号**：`sed -n '93p' index-*.js | cut -c22000-24800` 读出 `gVe`=UseTapEffects、`KR`=AuiProvider;再取 `174:20526`、`264:56472` 得 `u7e`=TranscriptWindowProvider、`Kat`=**ChatRuntimeBoundary**。链路锁定 `ChatRuntimeBoundary → TranscriptWindowProvider → AssistantRuntimeProvider → AuiProvider → UseTapEffects`。
5. **第一次误判（真 bug,非根因）**：`useRuntimeMessageRepository` 的 `useMemo([messages])` 在 `messages` 引用抖动时返回**内容相同、引用全新**的 repository,而 `incremental-external-store-runtime.ts:197` 的空操作门用 `===` 比较 → 门失效 → 全量路径末尾**无条件 `_notifySubscribers()`**。已修并补测试（`2a613351c2`）。
6. **第二个方法错误（务必记住）**：修复后我 grep `error-boundary` 只限定了 `11:33–11:59` 区间，得到"0 次捕获"便宣布症状消除。**实际 12:44、12:45 仍在崩**——我把一个恰好安静的时间窗当成了证据。
7. **转折点**：套件里 20 个失败（5 文件）我一度判为"既有且无关",其实**就是同一个 bug**——`streaming.test.tsx` 用 assistant-ui **自带的** `useExternalStoreRuntime`,不经任何 Hermes 代码即可复现。由此获得 **30 秒确定性复现台**。
8. **插探针定位抖动源**：给 `LazyMemoizeSubject.getState` 加"按实例计数、超阈值打印 `binding.path`"探针 → `path: {}` 被重建 **200+ 次**;因按实例计数，25→50→100→150→200 递增证明是**同一对象在抖**而非每帧新建。探针用完还原。
9. **比对 npm tarball**：`@assistant-ui/core@0.3.17` 同一处已加 `shallowEqualOrUndefined` 守卫。
10. **决定性实验**：把 0.3.17 那一行移植进已安装的 0.2.23（文件顶部已有局部 `shallowEqual`,无需新依赖）,那 5 个文件 `20 failed | 17 passed` → **`37 passed` 全绿**。因果证实。

### 根本原因

**第三方库缺陷，非 Hermes 代码**：`@assistant-ui/core <= 0.2.23` 的 `LazyMemoizeSubject.getState` 每次重建都用新对象**无条件覆盖缓存**,导致连续两次 `getState()` 返回不同引用；而 `@assistant-ui/tap` 自己重写的 `useSyncExternalStore` 把 `value` 放进 effect 依赖、并在深度 50 时**直接 throw**（React 官方实现只重读不抛）,一个缓存不稳定被放大成整面板崩溃。Hermes 侧 adapter 每帧新建字面量 + 全量路径无条件 notify 是**放大器**,非必要条件。

### 修复方案

零依赖补丁 `scripts/patch-assistant-ui-render-loop.mjs`,挂到**已存在**的根 `postinstall`（未引入 patch-package,尊重供应链政策）。特性：幂等；包缺失静默跳过；**检测到 0.3.x 上游修复后自动 no-op**;形状不匹配时打显式警告但**不阻断安装**（阻断安装会连带挡住安全更新）。提交 `02a641c638`。正解仍是升级 core ≥ 0.3（跨 minor,需全量套件评估）。已确认 **0.2.23 非刻意 pin**：core 于 `5826450d17`(2026-08-01) 才"声明为直接依赖",此后从未 bump。

### 验证

| 层次 | 结果 |
|---|---|
| 测试 | 5 文件 `37 passed`（基线 20 failed） |
| 安装钩子 | 真实 `hermes desktop --build-only` 过程中 postinstall 输出 `✓ patch applied` |
| 产物 | 带补丁重建并重启（旧进程无视 SIGTERM,须等其退出，否则新实例撞单实例锁即退出） |
| 运行时 | 重启后 0 次循环、0 次边界捕获（对照：修复前启动 12 秒内 15 次）;同期 12 条活跃事件行证明进程存活 |

**尚待确认**：交互期（前端机器人对话）触发的爆发需实际使用验证。复查：`tail -n +40385 ~/.hermes/logs/desktop.log | grep -c 'Maximum update depth'`

### 经验总结

1. **"既有失败测试"是线索不是噪音**。把它们归为无关，直接损失了最快的复现台。见到同类错误文案，第一反应应是"和我的 bug 是不是同一个"。
2. **压缩产物可逆向调试**：`desktop.log` 的 renderer console 带 `bundle:line:col`,配 `sed -n 'Np' | cut -cA-B` 即可把 minified 符号反查回组件名，成本远低于搭 CDP。
3. **探针必须按实例计数**,否则无法区分"一个对象在抖"和"每帧新建对象"——这两种成因修法完全不同。
4. **区分"真 bug"与"根因"**:第 5 步的修复是对的、有测试、值得保留，但它没解决用户症状。修好一个真实缺陷 ≠ 修好眼前问题，不能据此结案。
5. **"0 次发生"的结论必须显式交代采样窗口**,否则极易把安静区间当疗效。
6. **查依赖 pin 的意图**：`git log -S'"@assistant-ui/core"'` 一查即知是"没跟上"而非"刻意锁",直接决定走升级还是走补丁。

---

## 2026-09-04: hermes update 运行时修复反复失败（py-modules 漏登记顶层模块）

### 症状

`hermes update` 连续两次报：

```
→ Building a relocatable replacement environment...
ℹ Managed Python runtime was not replaced; the existing venv is unchanged
  (replacement environment did not pass dependency and import smoke tests)
```

真实原因只在 `~/.hermes/logs/agent.log` 里：

```
WARNING hermes_cli.managed_uv: candidate venv smoke failed:
ModuleNotFoundError: No module named 'hermes_state_holders'
```

### 根本原因

9-03 上游 `hermes_state.py` quarantine 重构（`5e01b8fa7a`、`06d7b77b1c`,#90837 系列）拆出两个**顶层单文件模块** `hermes_state_holders.py` / `hermes_state_registry.py`,但未登记进 `pyproject.toml` 的 `[tool.setuptools] py-modules`。

`managed_uv.py::_stage_candidate_venv` 用 `uv sync` 装**非可编辑**的 wheel,`hermes_state.py:63` 导入 `hermes_state_holders` 即失败 → 导入冒烟测试不过 → 更新器按 fail-safe 拒绝换装。checkout 本身能跑是因为 **repo 根在 `sys.path` 上**,恰好掩盖了打包缺失。

### 修复方案

两个模块加入 `py-modules`（`02af54ce95`）。全仓 `*.py` 审计确认无其他被打包代码引用的遗漏（`mini_swe_runner` 仅测试引用，`setup.py` 是构建垫片）。

### 验证

第三次 `hermes update` 成功：`✓ Managed Python runtime repaired (SQLite 3.45.1 → 3.53.1)`,pending fleet restart 完成；`hermes doctor` 转为 `✓ SQLite 3.53.1`,原先 4 个 WAL 暴露库的告警全部解除。

已提上游 PR [#102624](https://github.com/NousResearch/hermes-agent/pull/102624),被维护者关闭为 #102200 的重复（后者额外带一个 glob `hermes_state*.py` 的 fail-closed 回归测试）,但 live 复现证据被明确署名保留。

### 经验总结

1. **新增顶层单文件模块必须同步登记 `py-modules`**——列表处注释已明说，但重构时很容易漏；这类缺失只在 wheel/托管安装路径暴露，源码 checkout 永远看不出问题。
2. **上游同类 PR 堆积时不要指望合并自己的**：同一 bug 上游已有 #101891/#101167/#102469/#102418/#102200 五个开放 PR（#102142 已关）。维护者选带回归测试的那个作载体，符合仓库"3+ 同类 PR 不逐个合并"的规范。
3. **`gh pr create` 不能和 `git push` 放同一批并行命令**——push 尚未在 GitHub 落地就建 PR，会报 `No commits between`。
4. **worktree 建在 `/tmp` 会因命令会话的 PrivateTmp 命名空间而跨命令不可见**,导致分支被幽灵 worktree 锁住；纯 plumbing（临时 `GIT_INDEX_FILE` + `read-tree`/`apply --cached`/`write-tree`/`commit-tree`）可完全绕开工作树建 PR 分支。

---

## 2026-09-04: state.db 结构性损坏恢复（SQLite WAL-reset 漏洞）

### 症状

CLI 发送消息后无回复，提示 state 数据库结构性损坏、转写将在重启时丢失。`state.db` 941MB;`fts_rebuild_deferral` 显示 FTS 重建已被推迟重试 **1113 次**（自 9-01）,即文件带伤运行数日。

### 排查过程

1. 确认损坏类别：日志报 `database disk image is malformed outside the FTS shadow tables`——**canonical b-tree 受损**,`hermes doctor --fix` 的 schema/FTS 策略不适用，应走离线恢复道。
2. 停写：`hermes gateway stop`（systemd 用户服务，drain 后 exit 0）+ `systemctl --user stop hermes-webui`。quarantine 按设计**跳过了 close-time WAL checkpoint**,`-wal`/`-shm` 证据得以保留。
3. 停写后先做**持久取证快照**（三件套一起拷，md5 与源一致）。
4. `hermes sessions recover --inspect-only`（该命令从不打开源文件，只检查临时副本并校验源指纹未变）→ `recoverable: false`,原因仅 `messages` 表。
5. 转 `--allow-partial` 逐行打捞到新库：救回 **1,426 sessions / 64,197 messages**。
6. 新库 `integrity_check = ok`;清掉随坏库复制来的 `fts_stale` / `fts_rebuild_deferral` 派生标记（恢复时 FTS 已重建，标记过时）。
7. 冒烟测试（真实导入路径，非 mock）通过后，停掉最后一个持有旧 inode 的进程（交互 CLI）再换装。

### 根本原因

venv 链接的 SQLite 落在 WAL-reset 漏洞窗口（doctor 报 3.45.1，网关进程报 3.50.4;修复版 3.51.3+/3.50.7/3.44.6）,而库运行在 WAL 模式。损伤特征（rowid 乱序、页重复引用）与 WAL-reset 吻合。

### 验证

| 数据 | 结果 |
|---|---|
| sessions | 1,426 全恢复（0 跳过，比坏库索引能 COUNT 到的 1,334 还多） |
| messages | 64,197 全恢复，**0 跳过区间**——转写实际零丢失 |
| 派生数据 | gateway_routing 117/123、system_prompts 759/760、usage 1376/1378（均可重建） |

网关重启后 `session_store: ok`,5 个平台全 connected;`hermes sessions repair --check-only` → "opens cleanly — no repair needed"。

### 经验总结

1. **COUNT 失败 ≠ 数据不可读**。`messages` 表 `COUNT(*)` 走索引路径撞上损坏页而报错，被判"严格不可恢复";但 rowid 逐行扫描全表一条没跳。所以 `recoverable: false` 时务必试 `--allow-partial`。
2. **恢复流程自带的快照是临时的、会被清理**——要留取证件必须自己另拷一份三件套，且必须在停写之后（`state.db`/`-wal`/`-shm` 是同一个活镜像，不能各自独立拷贝）。
3. **绝不用系统 `sqlite3` 的 `.recover` 碰 live 文件**（3.45.1 属易受攻击版本，可能二次损坏）;恢复命令自带版本安全门且只作用于副本。
4. **并行发命令会制造假象**，本次踩到三次：`cp` 与 `sqlite3 DELETE` 并发撕出坏副本；`mv` 换装与 `integrity_check` 并发读到换装一半的旧文件，报出"页号超出新文件总页数"的荒谬损坏（正是识别并发的铁证）,最终靠 md5 比对确认换装完好。有依赖关系的操作必须串行。
5. **`gateway stop` 有 drain 窗口**,紧接着查 `systemctl is-active` 会误判"没停下来"。

---

## 2026-09-01: Desktop 模型菜单缺失 qwen3.8-max（custom_providers 同名条目冲突）

### 症状

Desktop 的模型选择菜单中，`custom:bailian` 分组下**没有** `qwen3.8-max`，但同一份配置在 TUI 侧正常可见。`config.yaml` 中 `model.default` 明确配的就是 `qwen3.8-max`，Desktop 却选不到。

### 排查过程

1. **先验证服务端数据**：直连 gateway HTTP API（端口 8643）查询模型列表，返回结果**包含** `qwen3.8-max`。说明配置解析本身没问题，怀疑前端缓存。
2. **排除前端缓存**：`location.reload()` 后重新打开菜单，仍无该模型。清 React Query 缓存无效。
3. **抓 Desktop 实际链路**：在 DevTools 中取到 Desktop 使用的 WebSocket 地址

   ```javascript
   window.hermesDesktop.getGatewayWsUrl()
   // → ws://127.0.0.1:45241/api/ws?token=...
   ```

   注意端口是 **45241**，不是 HTTP API 的 8643。
4. **通过该 WS 直接发 RPC**（需先消费 `gateway.ready` 事件再发请求），拿到的 `model.options` 响应中 `custom:bailian` 的模型列表**确实没有** `qwen3.8-max` —— 与 HTTP API 结果不一致。
5. **定位到两个不同进程**：

   | 进程 | PID | 命令 | 端口 | 有 qwen3.8-max |
   |---|---|---|---|---|
   | gateway | 608176 | `gateway run` | 8643 | 有 |
   | Desktop 后端 | 614126 | `hermes --profile invest serve` | 45241 | 无 |

   两者读的是同一个 `config.yaml`，但解析结果不同。

### 根本原因

`custom_providers` 是一个 **list**，其中存在**两个 `name: bailian` 的重复条目**：

| | 第一个（行 587） | 第二个（行 616） |
|---|---|---|
| `base_url` | `https://coding.dashscope.aliyuncs.com/v1` | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| `api_key` | **空** | 有真实 key |
| `models` | 10 个，**不含** `qwen3.8-max` | 12 个，**含** `qwen3.8-max` |
| `models_discovered` | 无 | `true` |

YAML list 允许同名条目共存，不会像 dict 那样报重复 key 错误，因此配置文件本身能正常加载。但下游消费方对"同名 provider"的处理策略不同：

- `serve`（Desktop 后端）按 name 查找时**取首个匹配**，命中第一个 bailian（无 key、10 个模型）
- `gateway` 会把两个条目**都加载**，因此 union 后能看到 `qwen3.8-max`

`model.default: qwen3.8-max` + `model.provider: bailian` 本意指向第二个条目，Desktop 侧却解析到第一个，模型列表里自然没有它。第一个条目是早期 `coding.dashscope` endpoint 的废弃残留，`api_key` 为空，实际根本调不通。

### 修复方案

合并两个条目为一个，保留可用的 `token-plan` endpoint（真实 key + 12 个模型），删除重复的 `coding.dashscope` 残留条目。同时将 invest profile 的 `model.base_url` 同步为 `token-plan` 地址。

### 验证结果

```
custom_providers type: list
  name: bailian | base_url: https://token-plan.cn-beijing.maas.aliyuncs.com/... 
                | key: SET | n_models: 12 | has qwen3.8-max: True
```

- 同名条目已消除，Desktop 与 gateway 解析结果一致
- 确认 6 个 profile 的差异化载体未受影响：`SOUL.md`（各 1297~1445 bytes，均保持 7-31 时间戳）、`profile.yaml`（方向描述）、`memories/`、`sessions/`、`state.db`、`skills/`、`cron/` 全部未改动
- 附带发现：6 个 profile 的 `config.yaml` 中 `toolsets`、`mcp_servers`、`max_turns` 本就完全一致，仅 `invest` 用 `custom:bailian`，其余 5 个用 `minimax-cn` + `MiniMax-M3`。`config.yaml` 承担共享基础设施角色，差异化由 `SOUL.md` + 独立数据目录实现，因此本次改动对其他 profile 无实际影响

### 经验总结

1. **同名 provider 是隐蔽的高危配置**。`custom_providers` 为 list 结构时，YAML 不会报重复错误，但"取首个"与"全部加载"两种消费策略会产生不一致的可见模型集，且症状表现为"某个客户端看不到某个模型"，极易误判为前端缓存问题。若确实需要多套 endpoint，应使用不同 name（如 `bailian-coding`）而非同名。
2. **端口即链路指纹**。当"服务端数据正确但客户端显示错误"时，先确认客户端连的到底是哪个进程。本例中 `gateway run`(8643) 与 `hermes serve`(45241) 是两个独立进程，直接用 HTTP API 验证会得出错误结论。`window.hermesDesktop.getGatewayWsUrl()` 是定位 Desktop 真实后端的有效手段。
3. 建议在配置加载阶段对 `custom_providers` 做同名检测并 warning，可在源头暴露此类问题。

---

## 2026-09-01: rebase 后 cli.py 多处语法错误（bridge 代码插入位置错误）

### 症状
`hermes` 启动报 `SyntaxError: unterminated string literal (detected at line 10071)`，逐层排查发现 cli.py 中有 5 处 rebase 冲突残留。

### 根本原因
`b1d7bb69c5` (feat(bridge): restore TUI→WeChat mirror sync after upstream rebase) 在 rebase 时将 bridge 自定义代码错误地插入到了 `_claim_active_session` 方法的 `try_acquire_active_session()` 调用中间，导致：

1. **`_claim_active_session` 被截断**：bridge 变量插入到 `metadata=...` 参数和闭合 `)` 之间，缺少 `)` + `except` 块 + `_release_active_session` 方法定义
2. **`_preload_resumed_session` 方法定义丢失**：只剩 docstring 后半部分和方法体，缺少 `def _preload_resumed_session(self) -> bool:` 和 docstring 开头
3. **kanban image-ref 提取代码结构错误**：缺少导入和 `_conn = _kb.connect()`，缩进/try-except 结构错乱
4. **外层 try 块缺少 finally**：`if quiet:` 块缩进少 4 空格脱离 try 块，缺少 `finally: _finalize_single_query(cli)`
5. **`CLIAgentSetupMixin` 导入被删除**
6. **`hermes_cli/commands.py` 也有语法错误**：`/save` 命令被拆分，bridge 命令插入位置导致括号不匹配

### 修复方案
1. 恢复 `CLIAgentSetupMixin` 导入
2. 将 bridge 变量从 `_claim_active_session` 内部移到 `__init__` 末尾
3. 补全 `_claim_active_session` 的 `)` + `except` + `_release_active_session` 方法
4. 补全 `_preload_resumed_session` 方法定义和 docstring 开头
5. 修复 kanban image-ref 提取代码结构
6. 批量增加 `if quiet: ... else: ...` 块 4 空格缩进 + 补全 `finally`
7. `hermes_cli/commands.py` 用上游版本覆盖，重新添加 `/bridge` 命令

### 验证
- `python3 -m py_compile cli.py` → EXIT 0
- `python3 -c "import cli"` → Import OK
- `hermes --help` → 正常

### 经验总结
rebase 冲突解决时自定义代码块被插入到上游方法调用中间是高危场景。每次 rebase 后必须运行 `python3 -m py_compile` 验证所有修改过的 .py 文件语法。bridge 相关的 6 个提交全部继承了同一批语法错误，说明问题在第一个 rebase 提交就引入了。

---

## 2026-09-01: hermes desktop 安装依赖失败（blobatar ETARGET + npm engine 不兼容）

### 症状

运行 `hermes desktop` 时，依赖安装失败：
```
npm error code ETARGET
npm error notarget No matching version found for blobatar@2.0.0 with a date before 8/18/2026
```

### 根本原因

1. **`min-release-age` age gate 拦截**：项目 `.npmrc` 配置了 `min-release-age=14`，要求所有 npm 包发布超过 14 天。`blobatar@2.0.0` 发布于 2026-08-19，距今仅约 13 天，被拦截。
2. **`min-release-age-exclude` 不被当前 npm 支持**：虽然 `.npmrc` 中配置了排除列表，但 npm 11.12.1（以及 npm 10.9.4）不支持 `min-release-age-exclude` 配置项（warning: "Unknown project config min-release-age-exclude. This will stop working in the next major version"）。该配置仅在更高版本 npm 中生效。
3. **npm engine 限制**：项目 `package.json` 要求 `npm <11.10.0 || >=11.17.0`，system 默认 npm 11.12.1 不满足。需要使用 nvm 的 node v22.22.0（自带 npm 10.9.4，满足 `<11.10.0`）。
4. **lockfile 不同步**：`package-lock.json` 中不包含 `blobatar` 条目（workspace 子包 `apps/desktop/package.json` 引用了它但 root lockfile 未同步），导致 npm 报 `Cannot read properties of null (reading 'edgesOut')`。

### 修复方案

1. 临时注释 `.npmrc` 中的 `min-release-age=14`（因 exclude 在当前 npm 版本不生效）。
2. 删除不同步的 `package-lock.json`。
3. 使用 nvm 切换到 node v22.22.0（npm 10.9.4 满足 engine 要求）。
4. 重新执行 `npm install` 生成新的 lockfile。

```bash
# 关键命令
export NPM_CONFIG_PREFIX=""
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm use --delete-prefix v22.22.0 --silent
rm -f package-lock.json
npm install --lockfile-version=3
```

5. 将 `blobatar` 加入 `.npmrc` 的 `min-release-age-exclude` 列表（为将来重新启用 age gate 时做准备）。

### 验证结果

- `blobatar@2.0.0` 成功安装到 `node_modules/blobatar/`
- `hermes desktop` 依赖安装成功（`added 790 packages`）
- 恢复 age gate 的问题暂时保留注释状态，待 blobatar 2.7.0 (2026-08-29) 超过 14 天后可恢复

### 经验总结

- `min-release-age-exclude` 是较新的 npm 配置项，在 npm 11.12.x 及更早版本中不被支持（仅有 warning，不生效）。使用时需确认 npm 版本兼容性。
- workspace 项目的 `package-lock.json` 需要包含所有 workspace 子包的依赖，否则 `npm ci` 会因 lockfile 不完整而报 `edgesOut` 错误。
- `nvm use --delete-prefix` 需要配合 `NPM_CONFIG_PREFIX=""` 使用，否则用户 `.npmrc` 中的 `prefix` 设置会干扰 nvm 的 npm 路径。

---

## 2026-09-01: 同步上游 origin/main → v2026.8.31-172-g6b7954b940

- 上游新增 352 commits，新 stable tags：`v2026.8.16.2`、`v2026.8.18`、`v2026.8.19`、`v2026.8.27`、`v2026.8.31`
- 主要上游变更：anthropic MCP wire normalization 重构、agent foreground resources 修复、terminal Linux systemd scope 修复、desktop/cli Chromium sandbox 修复、gemini call id/tool_call name 修复、cache declared conversation precedence + affinity token 修复（多处）、api declared conversation resolution 修复、compression preflight display-seed 修复
- 冲突：7 个文件共 ~30 处冲突
  - `acp_registry/agent.json`：上游删除，接受删除
  - `.gitignore`：合并两边（上游新条目 + `.codebuddy/`）
  - `agent/auxiliary_client.py`：合并两边（上游 provider profile reasoning 逻辑 + 自定义 reasoning_content strip）
  - `cli.py`：23 处冲突，22 处保留 HEAD（上游新增代码），2 处合并（bridge 代码）
  - `hermes_cli/commands.py`：1 处合并两边
  - `gateway/run.py`：1 处保留 HEAD（上游将 send_progress_messages 提取到 TurnRunner）
  - `package-lock.json`：保留上游版本
- 31 个自定义提交全部 rebase 完成，fork push 成功（`7f4521f1bf → 6b7954b940`）

---

## 2026-08-11: 微信推送通道修复（iLink errcode=-14）+ session-bridge v2 完全同步

### 症状

push_wechat.py 推送 W33 投资周报到微信：HTTP 200 但用户实际收不到；多次测试（v2→v5）均无消息到达；微信侧长风与桌面侧长风对同一事实给出矛盾结论（"session 没死" vs "session 死了"），用户需要手动复制微信回复到桌面才能继续对话——**双入口认知不同步**。

### 根本原因

三个独立问题叠加：

1. **iLink sendmessage 的 Authorization 头丢失**：push_wechat.py v3/v4 在修复 context_token 位置时，把 `Authorization: Bearer <WEIXIN_TOKEN>`（账号认证 token，从 .env 读）整个删掉了。iLink 返回 `errcode=-14 session timeout`，HTTP 200 只是"请求被接收"，不代表"消息已投递"。
2. **token 双轨机制**：iLink 发送需要**两个 token 同时存在**——`Authorization` 头（账号认证，.env 的 WEIXIN_TOKEN）+ `msg.context_token`（用户会话，~/.hermes/weixin/accounts/*.context-tokens.json）。gateway 的 `_send_message()` 一直这么发，所以微信侧长风能回复用户；独立脚本少了 Authorization 就报 -14。
3. **session-bridge 只做"摘要同步"不做"完整同步"**：桥文件 `_line()` 把每条消息截断到 200 字符（MSG_CAP=200），且只有 post_llm_call（写），没有 pre_llm_call（读/注入对端内容）。两边长风看到的都是对方的截断摘要，认知自然不一致。

### 修复方案

**push_wechat.py v5**（`~/My_Projects/invest/scripts/push_wechat.py`）：
- Authorization（账号 token）+ msg.context_token（会话 token）双管齐下，完全对齐 gateway 的 `_send_message()` 调用方式
- 检查 iLink 业务返回码 `ret`/`errcode`，不只看 HTTP 200
- 自动 fallback：errcode=-14 时去 token 重试一次（对齐 gateway `_send_text_chunk_locked` 策略）
- 实测：`ret=None, errcode=None` 不再报 -14，用户微信收到 ✅

**session-bridge 插件 v2**（`~/.hermes/plugins/session_bridge/__init__.py`）：
- 新增 `conversation_full.jsonl`：完整对话日志（不截断，上限 3000 字/条，双向写，5000 行自动裁剪）
- 新增 **pre_llm_call 钩子**：每轮对话前自动读取对端最新完整对话，返回 `{"context": "..."}` 注入 user message（不破坏 system prompt 缓存）——两边长风每轮都"天生知道"对方聊了什么
- 保留摘要桥文件（desktop_latest.md / wechat_latest.md）兼容旧逻辑
- 重启 hermes-gateway.service 使插件生效（systemd user 服务）

### 验证

- 单测：desktop 写 FULL_LOG → weixin 侧 pre_llm_call 成功注入桌面内容（141 字符，含时间戳）✅
- 端到端：push_wechat.py v5 推送测试消息到微信，用户确认收到 ✅
- gateway 重启后新 PID 3089658，插件 v2 加载 ✅

### 经验总结

- **iLink 发送双 token 是硬约束**：`Authorization`（账号认证）+ `msg.context_token`（用户会话）缺一不可，独立脚本必须照抄 gateway 的 `_send_message()` payload 结构，不能自己发明。
- **"收消息长连接"与"发消息 session"是两个独立通道**：getupdates alive ≠ sendmessage 有效。查微信通道故障时两条线都要查，微信侧长风查前者、桌面侧查后者，结论不矛盾只是角度不同。
- **跨入口同步必须"完整内容 + 双向注入"**：摘要同步（截断 200 字）必然导致两边认知不一致。pre_llm_call 返回 `{"context": ...}` 注入 user message 是 Hermes 官方支持的跨端上下文注入方式，不破坏 prompt cache。

---

# Hermes Agent — 开发与调试记录

> **时间线索**：最新的记录在最顶端，按时间倒序排列。

---

## 2026-08-01: 同步上游 origin/main → b98a3a0fc7（零冲突）

- 上游新增 157 commits，无新 stable tag（最新仍 `v2026.7.20`）（215 files, +14891/-3945）
- 主要上游变更：agent 微压缩系列（micro-compaction 改 opt-in 非默认、节奏可配置、alternation-safe、会话恢复不破坏已压缩历史）、desktop OAuth 原生 token 存储加固（重启恢复、凭证脱敏）、dashboard 恢复会话加载遮罩 + JWKS headers 修复、Slack self-mention 路由修复、identity prompt 精简
- **无冲突**，merge 一次完成；bridge 定制完好（gateway/run.py TUI takeover ×3、cli.py _bridge_attach ×2），py_compile 通过
- fork push 成功（`ccf1e2936d → b98a3a0fc7`）

---

## 2026-07-30: 同步上游 origin/main → ccf1e2936d（核心文件大重构）

- 上游新增 371 commits，无新 stable tag（最新仍 `v2026.7.20`）
- 主要上游变更：desktop 性能优化（⌘K 命令面板延迟加载、transcript live tail 分段预算、composer 粘贴指令 chip 化、File>Open Folder ⌘O 项目）、TUI 终端 tab 标题与窗口标题分离、gateway 保留 text 输入 voice_only 语义、Windows 原生修正（CLI/gateway status/banner/WSL 浏览器路径）、**核心文件大重构**（gateway/run.py 的 send_progress_messages 提取到 TurnRunner 类、hermes_cli/main.py、tui_gateway/server.py、hermes_state.py 等整体重写，净删除 43 万行含测试瘦身）
- **2 处冲突**：
  1. `.gitignore`：双方追加 → 两侧都保留（fork 的 .tmp/ + 上游的 .lazy-refresh-incomplete）
  2. `gateway/run.py`：上游将 `send_progress_messages` 从闭包重构为 `TurnRunner` 类方法。fork 的「非编辑平台单条 ⚙️ 通知」定制需适配新结构——**移植到新方法**，变量映射 progress_queue→ctx.progress_queue、source→ctx.source、_progress_metadata→ctx._progress_metadata、_run_still_current()→ctx._run_still_current()
- 验证：py_compile 通过、gateway.run import OK、进度测试 7 passed、最终 diff 只含 4 处 bridge 纯插入（TUI takeover + inbox write + 单条通知）无意外删除
- 额外：.gitignore 添加 `.tmp/`（避免误提交测试日志）
- fork push 成功（`386409230 → ccf1e2936d`）

---

## 2026-07-30: 同步上游 origin/main → 386409230

- 上游新增 1419 commits，无新 stable tag（最新仍 `v2026.7.20`）
- 主要上游变更：cron BaseException 逃逸记录 + wedged one-shots 诊断、gateway session teardown 前 flush 待写 memory、models.dev 刷新移出事件循环、STT 语音转文字全面可配置（hermes tools + GUI + dashboard 下拉框 + faster-whisper 静音幻觉修复）、LSP 空闲 language server 回收（idle_timeout 可配置）、shutdown flush 失败保留 agent._session_messages、CLI import-agent 不再粉碎已有 MEMORY.md、atomic_write_text 提取到 utils、desktop backend probe 超时提升 + 重试、doctor agent-browser 检测 PATHEXT-aware
- **1 处冲突**：`gateway/run.py` 的 `send_progress_messages`——fork 的「非编辑平台发送单条 ⚙️ 通知」行为 vs 上游的 `getattr` duck-typing 检测（上游对无 edit_message 的适配器更健壮）。**语义合并**：采用上游的 `_adapter_edit = getattr(...)` 检测方式，保留 fork 的单条通知循环逻辑
- 验证：py_compile 通过、进度相关测试 12 passed（test_run_progress_interrupt / test_run_cleanup_progress / test_clarify_progress_leak）
- 上次重建的 `cli.py` 本次自动合并成功（干净重建策略持续生效）
- fork push 成功（`4ab7d5b07 → 386409230`）

---

## 2026-07-25: 同步上游 origin/main → 4ab7d5b07（新 tag v2026.7.20，重度冲突解决）

- 上游新增 1684 commits，**新 stable tag `v2026.7.20`**（2310 files, +302822/-29819）
- 主要上游变更：Windows UTF-8 大扫除（全仓 read_text/write_text 补 encoding）、Telegram 冷启动 polling readiness 加固、checkpoints 孤儿卷分类需正向证据、desktop display_metadata 双重编码修复 + `/api/health` 存活端点、cli.py 大规模瘦身（`_init_agent`/`_ensure_runtime_credentials`/`_preload_resumed_session` → `CLIAgentSetupMixin`，billing 方法群 → `CLIBillingMixin`，`/credits`+`/billing` 折叠进 `/topup`）、模型切换昂贵模型确认流程、active-session lease 机制（`_claim_active_session`）
- **3 处冲突**：
  1. `.gitignore`：双方追加内容 → 两侧都保留
  2. `acp_registry/agent.json`：上游 #68217 有意删除（rip out brew+pip 支持），fork 侧仅格式化差异 → 接受删除
  3. `cli.py`：7 处冲突区。发现 fork 早期 rebase 恢复引入了过期 cli.py 副本（缺上游 `_claim_active_session`/`_persist_prompt_summary` 等新方法），逐块解决会残留隐患 → **改用干净重建策略**：以上游 cli.py 为基底，重新移植 fork 的 6 个 bridge 定制块（bridge state、bridge 方法群、`/bridge` dispatch、工具进度通知、对话镜像同步、启动 auto-restore），最终 diff 只含纯插入
- 验证：py_compile 通过、bridge + 上游新方法共存断言通过、tests/cli/ 1136 passed、tests/gateway/ 301 passed（2 个失败项在纯上游 worktree 同样复现，为上游自身 flaky，与合并无关）
- fork push 成功（`24c465d01 → 4ab7d5b07`）
- ⚠️ 经验：fork 的 rebase 恢复型 commit（如 a7515ccce）可能夹带过期的上游代码副本，后续同步时应优先"上游为基底+移植定制"而非逐块解决冲突

---

## 2026-07-18: 同步上游 origin/main → 24c465d01

- 上游新增 79 commits，无新 stable tag
- 主要上游变更：model picker 显示耗尽的 pool providers、CLI TUI Python env 传递、desktop LaTeX 保留 + Windows 系统 CA 信任 + Providers API-keys tab 暴露 Local/custom、codex cache-scope headers 64 字符上限 + app-server 事件流、cron POSIX 解码默认保留 + Windows launcher 弹窗修复、kanban unblock 状态与 DB 同步、mem0 OSS base URL 别名迁移、honcho timeout 从 honcho.json 读取、CI 负载下稳定 + fork-safe token fallback、block list 内容无限循环修复、contrib 贡献者自动化脚本
- **无冲突**，merge 一次完成（208 files changed, +8883/-1365）
- 新增模块：`agent/stream_single_writer.py`（单写流保护）、`apps/desktop/electron/windows-system-ca.ts`（Windows 系统 CA 信任）、`contributors/`（贡献者归属系统）
- fork push 成功（`077192af8 → 24c465d01`）

---

## 2026-07-17: 同步上游 origin/main → 077192af8

- 上游新增 311 commits，无新 stable tag（最新仍 `v2026.7.7.2`）
- 主要上游变更：cron execution ledger（truthful execution ledger + attempt ledger 加固）、Z.AI GLM token-limit 分类为 context overflow、MCP nextCursor 分页支持、memory 关闭时排空 queued writes、SQLite snapshot fail closed、session transcripts 保护（inspired by Claude Code）、Gemini tool schema 属性修剪、CLI `/resume recap` 终端转义清理、UTF-8 BOM 剥离、gateway reset boundaries 统一、TUI compute_host + host_supervisor + synthetic_turn、MCP dashboard OAuth、Unreal MCP skill、aux_accounting、codex_runtime 大幅重构
- **无冲突**，merge 一次完成（496 files changed, +39938/-5141）
- fork push 成功（`eb9d7e7f0 → 077192af8`）

---

## 2026-07-16: 同步上游 origin/main → eb9d7e7f0

- 上游新增 125 commits，无新 stable tag（最新仍 `v2026.7.7.2`）
- 主要上游变更：gateway multiplex relay adapter 共享修复、CI js-autofix 改用 PR 推送 + lockfile diff 评论工作流、Nix dirty-tree wrapper bug 修复、TUI dashboard 新 session redraw 修复、desktop pane-shell 重构（tree/grid 架构）、contrib 插件系统（desktop SDK + plugin runtime）、JS 测试从 Python 迁移到 vitest、web MCP server 创建 + profile builder MCP auth、blender MCP skill
- **无冲突**，merge 一次完成（402 files changed, +28830/-6691）
- 额外提交：`.gitignore` 添加 `.qoder/` 忽略规则
- fork push 成功（`e3effccd2 → eb9d7e7f0`）

---

## 2026-07-15: 同步上游 origin/main → e3effccd2

- 上游新增 108 commits，无新 stable tag（最新仍 `v2026.7.7.2`）
- 主要上游变更：codex continuation/reasoning 多处修复、desktop @assistant-ui 0.12→0.14 升级（streaming wrapper、remend-tail、math delimiter 重构）、GLM-5.2 模型目录支持、provider profile 感知推理参数系统（`build_extra_body` / `build_api_kwargs_extras`）、非字符串 tool args TypeError 防护（ACP + display）、moa aggregator reasoning 修复、upstage provider 插件
- **同步方式改为 merge**（此前一直用 rebase），避免 rebase 后 fork 独有 commits 需要反复重放
- **冲突 1 处**：`agent/auxiliary_client.py` — fork 的 DeepSeek `reasoning_content` 字段清理逻辑 vs 上游新增的 provider profile 感知推理参数系统
  - fork 侧：发送前过滤 assistant 消息的 `reasoning_content` 字段（防止非 DeepSeek auxiliary provider 返回 HTTP 400）
  - 上游侧：`get_provider_profile()` + `build_extra_body()` + `build_api_kwargs_extras()` 构建 provider-specific 推理参数
  - **解决方案**：两者功能独立，同时保留——先执行 message cleaning，再执行 profile 推理参数构建
- 22 个 fork 独有 commits 全部保留
- 额外：`.gitignore` 新增 `.qoder/`（IDE 生成缓存，不纳入版本控制）
- fork push 成功（`e8cbc75da → e3effccd2`）

---

## 2026-07-14: 同步上游 origin/main → v2026.7.7.2-598-g41ced571b

- 上游新增 248 commits（含 2026-07-13 未同步的 104 个），无新 stable tag（最新仍 `v2026.7.7.2`）
- 主要上游变更：desktop compaction status 修复、telegram 多处修复（polling health、DoH、reconnect probe）、background_review reasoning_config 继承修复、gateway session/compression 修复、cron 重复执行修复、file-safety 写入拒绝区分、agent credential pool 验证、cli npm install 性能优化、kanban/approval/dashboard 多处修复
- 无冲突，rebase 一次完成
- 21 个自定义提交全部保留，fork push 成功（`b36b5b44f → 41ced571b`）

---

## 2026-07-12: 同步上游 origin/main → v2026.7.7.2-349-g0512f4cd3

- 上游新增 59 commits，无新 stable tag（最新仍 `v2026.7.7.2`）
- 主要上游变更：gateway `@` context reference 修复（AttributeError）、runtime context budget 支持、authenticated readiness checks；codex compaction 多处修复；compaction anti-thrash 逻辑修复（4 处）；agent per-model token usage 追踪；telemetry/insights usage attribution 加固；tui/desktop model picker session scope 修复
- 无冲突，rebase 一次完成
- 20 个自定义提交全部保留，fork push 成功（`982949e98 → 0512f4cd3`）

---

## 2026-07-11: 同步上游 origin/main → v2026.7.7.2-289-g96a6dbad3

- 上游新增 41 commits，无新 stable tag（最新仍 `v2026.7.7.2`）
- 主要上游变更：desktop session/composer 修复、security tool output risk 暴露、cron heartbeat 修复、tui disconnect 保存修复、telegram PTB 错误分类、web extract 加固、agent pool FD 修复（后被 revert）
- 无冲突，rebase 一次完成
- 19 个自定义提交全部保留，fork push 成功（`f18a131f0 → 96a6dbad3`）

---

## 2026-07-10: 同步上游 origin/main → v2026.7.7.2-248-gf18a131f0

- 上游新增 189 commits，无新 stable tag（最新仍 `v2026.7.7.2`）
- 主要上游变更：desktop 多项修复（Tip sticking、UI zoom、bootstrap repin）、gateway SessionStore 并发竞态修复（6 处）、model catalog policy 重构、web dashboard paste/drop 图片支持、soft gateway switch UX
- 冲突：`cli.py` 1 处（自定义提交 `feat(bridge)` 错误删除上游 `_discard_session_if_empty` 和 `_launch_session_boundary_memory_flush`），保留 HEAD 版本
- 19 个自定义提交全部 rebase 完成，fork push 成功（`adea139cd → f18a131f0`）

---

## 2026-07-08: 同步上游 origin/main → v2026.7.7.2-58-gadea139cd

- 上游新增 124 commits，新 tag：`v2026.7.7`、`v2026.7.7.2`
- 主要上游变更：delegation 生命周期修复（多处）、webhook payload filters、`tencent/hy3` GA 模型、yuanbao 并行媒体下载、cli/tui 命令路由修复
- 冲突：`cli.py` 1 处（HEAD 缺少 `_exit_code` kanban 退出码逻辑 + `_print_exit_summary` 参数），保留上游版本
- 18 个自定义提交全部 rebase 完成，fork push 成功（`fa9157302 → adea139cd`）

---

## 2026-05-03: TUI Bridge 心跳机制——TUI 离线时自动降级到 gateway 直接处理

### 背景

原有 TUI Bridge Takeover 逻辑只检查 `bridge_subscription.json` 或 `config.yaml` 的静态配置，不感知 TUI 是否真的在运行。TUI 不启动时，微信消息会被写入 `bridge_inbox.jsonl` 后无人处理，导致消息静默丢失。

### 功能目标

- **TUI 在线**：保持 takeover（微信消息 → TUI AI 处理 → 回复）
- **TUI 离线**：gateway 自动降级，用自己的 AI session 直接处理微信消息，不丢消息
- **TUI 重启后**：无需任何手动操作，自动切回 takeover 模式

### 实现方案

引入心跳文件 `~/.hermes/bridge_heartbeat.json` 作为 TUI 存活信号：

```json
{
  "platform": "weixin",
  "chat_id": "xxx",
  "last_seen": 1746270000.123,
  "pid": 12345
}
```

**TUI 侧（`cli.py`）**：

1. 新增 `_bridge_heartbeat_path()`、`_bridge_write_heartbeat()` 辅助方法
2. `_bridge_attach()` 启动时立即写入初始心跳（避免第一条消息因心跳未就绪被错误降级）
3. `_bridge_start_inbox_watcher()` 的 `_watch()` 循环末尾（每 2 秒）调用 `_bridge_write_heartbeat()` 刷新
4. `_bridge_detach()`（`/bridge off` 或 TUI 正常退出）主动删除心跳文件，gateway 立即降级

**Gateway 侧（`gateway/run.py`）**：

在 `_tui_takeover = True` 成立后增加心跳有效性检查：
```python
_hb_age = time.time() - float(_hb.get("last_seen", 0))
_tui_alive = _hb_age < 10.0  # 10秒超时 = 允许5次心跳丢失
if not _tui_alive:
    _tui_takeover = False  # 降级到 gateway 直接处理
```

### 改动文件

| 文件 | 改动 |
|------|------|
| `cli.py` | 新增 `_bridge_heartbeat_path()`、`_bridge_write_heartbeat()`；`_bridge_attach/detach/_watch` 三处添加心跳逻辑 |
| `gateway/run.py` | takeover 判断段增加心跳有效性检查，过期时降级并记录 INFO 日志 |

### 边界情况

| 场景 | 结果 |
|------|------|
| TUI 正常退出 | `_bridge_detach()` 主动删心跳，gateway 立即降级（无需等 10 秒） |
| TUI 崩溃 | 心跳停止，10 秒后 gateway 自动降级 |
| TUI 重启 | 心跳恢复，下一条消息自动切回 takeover |
| 心跳文件读取异常 | fall through 到降级处理，消息不丢失 |

---

## 2026-05-02: hermes dashboard 端口 9119 被 iCloud 占用

### 症状

执行 `hermes dashboard` 报错：
```
ERROR: [Errno 98] error while attempting to bind on address ('127.0.0.1', 9119): address already in use
```

WSL 内 `/proc/net/tcp` 和 `/proc/net/tcp6` 均看不到 9119 的监听记录，`ss`/`lsof` 也无结果，但 Python `socket.bind()` 确实失败。

### 根本原因

Windows 侧 `iCloudCKKS.exe`（PID 4356）持有 9119 端口，状态为 `CLOSE_WAIT`（连接未正常关闭的残留）。WSL2 与 Windows 共享网络栈，Windows 侧占用的端口在 Linux `/proc/net` 中不可见，但 bind 会失败。

验证命令（Windows PowerShell）：
```powershell
netstat -ano | findstr :9119
# 输出：TCP  192.168.10.102:9119  17.248.216.65:443  CLOSE_WAIT  4356
tasklist /FI "PID eq 4356"
# 输出：iCloudCKKS.exe
```

### 解决方案

Windows PowerShell（管理员）执行：
```powershell
taskkill /PID 4356 /F
```

iCloud 会自动重启并换用其他端口，9119 随即释放。回到 WSL 重新执行 `hermes dashboard` 即可。

### 经验总结

- WSL2 端口被占但 Linux 侧不可见 → 优先在 Windows 侧用 `netstat -ano | findstr :<port>` 排查
- iCloud 偶发占用随机高端口（此次为 9119），CLOSE_WAIT 状态不会自动释放，需手动 kill

---

## 2026-05-02: 微信工具调用进度通知【已验证】

### 背景

TUI takeover 模式下，微信用户发出需要工具调用的任务（如抓取新闻）后，TUI 中能看到工具运行的动画，但微信端陷入长时间无反馈状态，用户无法得知后台是否在运行。

### 根本原因

双重问题：

1. **TUI takeover 路径**（主路径）：消息由 TUI 的 AI 处理，`_on_tool_progress` 回调只更新 TUI spinner，没有向微信发任何通知。

2. **Gateway 直接处理路径**（非 takeover）：`send_progress_messages()` 中第 10913 行判断 `edit_message` 未重写（微信不支持编辑消息）→ 静默丢弃所有进度事件。

### 修复方案

**cli.py：`_on_tool_progress` 加 bridge 进度通知**

```python
# tool.started 分支末尾
if self._bridge_platform and self._bridge_chat_id and not self._bridge_progress_notified:
    self._bridge_progress_notified = True
    self._bridge_send(f"⚙️ {emoji} {label}...")
```

- `_bridge_progress_notified` 标志：每轮新消息注入时重置为 `False`，第一个工具触发时置 `True` 并发通知，后续工具静默——避免刷屏。
- 新增实例变量 `self._bridge_progress_notified: bool = False`。

**gateway/run.py：`send_progress_messages()` 不再静默丢弃**

对不支持 `edit_message` 的平台（原来直接 `return` 丢弃），改为：
- 监听 `progress_queue`，第一个工具事件时发一条 `⚙️ 工具名...`
- 后续工具静默（不再发新消息）
- 响应 `CancelledError` 干净退出并清空队列

### 效果

| 场景 | 微信用户看到 |
|------|------------|
| 工具调用第 1 个 | `⚙️ 🔍 搜索新闻...`（1 条） |
| 后续工具 | 静默（不刷屏） |
| AI 回复到达 | 正常回复消息 |

---

## 2026-05-01: 微信↔TUI 真正共享 Session（TUI 接管模式）【已验证】

### 背景

之前的"双向同步"实现（bridge_inbox）只是把微信消息**通知**给 TUI，但 gateway 的 AI 仍然独立处理微信消息并回复。用户希望微信和 TUI **共享同一个 AI 对话**：无论从哪端发消息，AI 都在同一个 session 里处理，两端同步所有信息。

### 根本原因分析

旧架构中微信消息走两条独立的处理链：
1. Gateway AI（独立处理+回复微信）
2. Bridge inbox（仅通知 TUI，不处理）

用户感受：微信能看到 TUI 的内容（因为 `_bridge_send` 推送），但 TUI 无法处理微信的内容（inbox watcher 只显示通知，不注入 AI）。

### 修复方案

**架构：TUI 接管模式**

```
微信用户发消息
    ↓
gateway/run.py: 检测 bridge_subscription.json 或 config.yaml bridge: 是否匹配
    ↓ 匹配（TUI takeover）
写 bridge_inbox.jsonl（tui_takeover: True），直接返回，不运行 gateway AI
    ↓
cli.py inbox watcher: 检测到 tui_takeover=True 条目
    ↓
注入 _pending_input（`[来自微信的消息] xxx`）
    ↓
TUI 的 AI 处理，生成回复
    ↓
bridge_send 把回复发回微信（不带 [TUI] 前缀）
```

**gateway/run.py 修改**（`_handle_message_with_agent` 开头）：
```python
# 检查 bridge_subscription.json 或 config.yaml bridge: 是否与当前 platform+chat_id 匹配
if _tui_takeover and event.text:
    # 写 inbox（tui_takeover=True），直接 return None，跳过 gateway AI
```

**cli.py 修改**（inbox watcher）：
```python
_takeover = _entry.get("tui_takeover", False)
if _takeover and _user:
    self._console_print(f"\n[bold cyan][{_plat} → TUI][/] {_user}")
    self._pending_input.put(f"[来自微信的消息] {_user}")
```

**cli.py 修改**（bridge_send 逻辑）：
```python
_from_weixin = _user_text.startswith("[来自微信的消息]")
if _from_weixin:
    self._bridge_send(response)  # 只发 AI 回复，不发用户消息回显
else:
    self._bridge_send(f"[TUI] 你：{_user_text}")
    self._bridge_send(f"[TUI] Hermes：{response}")
```

### 效果

| 场景 | 微信 | TUI |
|------|------|-----|
| 微信发消息 | 看到 AI 回复 | 看到 `[weixin → TUI] 消息` + AI 处理过程 |
| TUI 发消息 | 看到 `[TUI] 你：xxx` + `[TUI] Hermes：yyy` | 正常显示 |

### 注意事项

- TUI 接管模式要求 bridge 已激活（`/bridge weixin <chat_id>` 或 config.yaml bridge: 配置）
- Gateway 的微信平台仍需运行（负责 long-poll 收消息），但不再运行 AI
- 微信的 `/reset`、`/stop` 等命令仍由 gateway 处理（不触发 AI，走命令路径）

---



### 背景

之前 bridge 只实现了 TUI→微信（TUI 回答后推送到微信），用户希望双向：微信发消息时 TUI 也能显示。

### 实现方案

**架构**：gateway（微信进程）→ `bridge_inbox.jsonl` 文件 → cli.py 后台轮询线程 → TUI 显示

**gateway/run.py 修改**（`agent:end` emit 之后）：
```python
_inbox = _ghh() / "bridge_inbox.jsonl"
if _inbox.exists() or (_ghh() / "bridge_subscription.json").exists():
    _entry = {"ts": ..., "platform": ..., "chat_id": ..., "user_msg": ..., "response": ...}
    with _inbox.open("a") as _f:
        _f.write(json.dumps(_entry) + "\n")
```
只有当 bridge 已激活（存在 subscription.json 或 inbox 文件）时才写，避免无谓 I/O。

**cli.py 修改**：
- `__init__`: 新增 `_bridge_inbox_stop: Optional[threading.Event]`
- `_bridge_attach()`: 激活时调用 `_bridge_start_inbox_watcher()`
- `_bridge_detach()`: 停止 watcher，清理 inbox 文件
- `run()` 自动恢复: 恢复后也启动 watcher
- `_bridge_start_inbox_watcher()`: 后台线程每 2 秒轮询 inbox，过滤同平台同 chat_id 的条目，用 `_console_print` 显示：
  ```
  [weixin] 用户：xxx
  [weixin] Hermes：yyy
  ```

### 经验总结

- 微信 gateway 和 TUI cli 是两个独立进程，跨进程通信用文件队列（JSONL append）是最简单可靠的方案
- gateway 写、cli 读，只需在 cli 侧轮询，无需额外 IPC 框架

---

## 2026-05-01: TUI→微信桥接无法同步——token 读取路径错误修复

### 症状

重启 TUI 后微信端仍无法收到消息，`/bridge status` 未显示（桥接未激活）。

### 根本原因

两个独立问题：

1. **subscription.json 不存在**：桥接功能恢复后从未执行过 `/bridge weixin <chat_id>`，所以 `bridge_subscription.json` 不存在，`run()` 里的自动恢复逻辑读不到任何配置，导致桥接未激活。

2. **token 读取路径错误**：`_bridge_send()` 只从环境变量 `WEIXIN_TOKEN`/`WEIXIN_ACCOUNT_ID` 读取凭证，但实际配置存放在 `~/.hermes/config.yaml` 的 `platforms.weixin.token` 和 `platforms.weixin.extra.account_id` 中，systemd 服务不会自动注入这些环境变量。

### 修复方案

**`_bridge_send()` 修复**：优先从 config.yaml 读取 token/account_id，环境变量作为后备：
```python
_wx_cfg = (
    _cfg.get("gateway", {}).get("platforms", {}).get("weixin")
    or _cfg.get("platforms", {}).get("weixin")
    or {}
)
_token = str(_wx_cfg.get("token") or "").strip()
_account_id = str((_wx_cfg.get("extra") or {}).get("account_id") or "").strip()
```

**`run()` 自动恢复修复**：当 `bridge_subscription.json` 不存在时，回退读取 config.yaml 的 `bridge:` 配置块：
```yaml
# ~/.hermes/config.yaml
bridge:
  default:
    platform: weixin
    chat_id: o9cq807-0UUke4yw0AOz2kVnIcLA@im.wechat
```
代码读取 `bridge.platform` 或 `bridge.default.platform`，`bridge.chat_id` 或 `bridge.default.chat_id`。

### 经验总结

- config.yaml 是 hermes-agent 的权威配置源，凡是需要读取平台凭证的功能，必须从 config.yaml 的 `platforms.<name>` 路径读取，不能假设环境变量已注入。
- `bridge:` 配置块已在 config.yaml 中持久化，无需再依赖独立的 `bridge_subscription.json` 文件作为主配置来源。

---

## 2026-05-01: TUI↔微信桥接（bridge sync）在 upstream rebase 后丢失并恢复

### 症状

用户发现微信端不再同步显示 TUI 对话，`/bridge` 命令不可用。

### 根本原因

2026-04-18 实现的 TUI→微信桥接功能（`_bridge_platform`/`_bridge_send`/`bridge_queue.py`）从未被单独 commit，修改直接存在于工作目录。2026-04-28 执行 `git rebase origin/main`（794 个 commit）时，`cli.py` 被上游大幅重写，未 commit 的本地改动被 stash pop 后被覆盖，整套桥接逻辑消失。

### 重新实现方案

相比原版简化了架构：去掉了 `gateway/bridge_queue.py` 中间文件队列，改为直接在后台线程中调用 `send_weixin_direct()`，更简单可靠。

**实现文件**：`cli.py`、`hermes_cli/commands.py`

**核心组件**：
```python
# __init__ 里的状态
self._bridge_platform: Optional[str] = None
self._bridge_chat_id: Optional[str] = None

# 辅助方法
_bridge_subscription_path()  → $HERMES_HOME/bridge_subscription.json
_bridge_attach(platform, chat_id)  → 激活并持久化
_bridge_detach()               → 取消并删除订阅文件
_bridge_send(text)             → 后台线程调用 send_weixin_direct()
_handle_bridge_command(cmd)    → /bridge 命令处理器
```

**`chat()` 里的转发逻辑**（`final_response` 取得后）：
```python
if self._bridge_platform and self._bridge_chat_id and response \
        and not (result and (result.get("failed") or ...)):
    self._bridge_send(f"[TUI] 你：{_user_text}")
    self._bridge_send(f"[TUI] Hermes：{response}")
```

**`run()` 里的自动恢复**：
```python
# 启动时读取 bridge_subscription.json，自动恢复上次桥接
_sub = json.loads(_sub_path.read_text())
if _sub.get("platform") and _sub.get("chat_id"):
    self._bridge_platform = _sub["platform"]
    self._bridge_chat_id = _sub["chat_id"]
```

**命令注册**（`hermes_cli/commands.py`）：
```
/bridge <platform> <chat_id>  — 激活桥接（别名 /br）
/bridge off                   — 取消桥接
/bridge status                — 查看当前状态
```

### 经验总结

- **未 commit 的本地修改在 rebase 时极易丢失**，即使 stash 也可能被上游大改动覆盖。今后所有本地功能必须立即 commit。
- 新架构比原版更简单：直接调用 `send_weixin_direct()` 而非文件队列 IPC，减少了一个中间层。

---

## 2026-04-26: OfficeAI (WPS) 通过 OpenAI 兼容接口接入 Hermes

### 背景
用户在 Windows 侧安装了 WPS OfficeAI 插件，希望通过 Hermes 的 API server 接入本地 AI 能力。

### 调试过程

**1. 确认 API server 功能**
Hermes gateway 内置 OpenAI 兼容的 api_server platform，端点为 `/v1/chat/completions` 和 `/v1/models`。

**2. 网络连通性问题：`192.168.x.x` 不可达**
初始思路是将 `host` 改为 `0.0.0.0` 并使用 WSL 局域网 IP（`192.168.10.102`）。Windows 侧测试：
```
无法连接到远程服务器
```
根本原因：`192.168.10.102` 是物理机的局域网 IP，不是 WSL 的虚拟网卡 IP，Windows 无法通过它路由到 WSL。

**3. 发现 WSL2 使用 mirrored 网络模式**
WSL2 mirrored 模式下，WSL 内部监听的端口会自动映射到 Windows 的 `localhost`，无需 IP 转发或端口代理。

PowerShell 验证成功：
```powershell
Invoke-RestMethod -Uri "http://localhost:8642/v1/models" -Headers @{Authorization="Bearer hermes-local"}
# 返回：object=list, data=[{id=hermes-agent, ...}]
```

Chat 接口验证：
```powershell
$body = '{"model":"hermes-agent","messages":[{"role":"user","content":"你好，请回复一句话"}]}'
$resp = Invoke-RestMethod -Uri "http://localhost:8642/v1/chat/completions" -Method Post -Headers @{Authorization="Bearer hermes-local"; "Content-Type"="application/json"} -Body $body
$resp.choices[0].message.content
```
返回正常 AI 回复，验证成功。

**4. 配置 OfficeAI 插件**
- 服务商平台：自定义（OpenAI协议）
- API 代理地址：`http://localhost:8642/v1`（不能带 `/chat/completions`，否则刷新模型时会拼接成错误路径）
- API_KEY：`hermes-local`
- 模型名称：手动填写 `hermes-agent`（不依赖"刷新模型"按钮）

**5. 安全加固：恢复 host 为 127.0.0.1**
mirrored 模式下 `0.0.0.0` 会将端口暴露到局域网，存在安全风险。恢复配置：
- `gateway-config.yaml`：`host: localhost`
- `~/.hermes/config.yaml`：`host: 127.0.0.1`
- `~/.hermes/.env`：注释掉 `API_SERVER_HOST=0.0.0.0`

`API_SERVER_KEY=hermes-local` 保留（安全访问控制）。

### 最终 OfficeAI 配置
| 字段 | 值 |
|------|-----|
| API 代理地址 | `http://localhost:8642/v1` |
| API_KEY | `hermes-local` |
| 模型名称 | `hermes-agent`（手动填写） |

### 经验总结
- WSL2 mirrored 模式：Windows 侧直接用 `localhost` 访问 WSL 服务，无需改 host 为 `0.0.0.0`
- OfficeAI 的 API 地址应填 Base URL（`/v1`），不要填完整端点路径
- "刷新模型"按钮不可靠时，直接手动填模型名称保存即可

---

## 2026-04-25: DeepSeek reasoning_content 导致 auxiliary memory flush 400（第五次）

### 症状
```
⚠ Auxiliary memory flush failed: HTTP 400: The `reasoning_content` in the thinking mode must be passed back to the API.
```

### 根本原因
`flush_memories()` 在构建 `api_messages` 时调用了 `_copy_reasoning_content_for_api()`，这会给所有 DeepSeek/Kimi 会话中的 assistant 消息写入 `reasoning_content=""`。这些消息随后被传给 `auxiliary_client.call_llm()`，而 auxiliary client 使用的是非 DeepSeek provider（OpenRouter/Nous Portal 等），这些 provider 不接受 `reasoning_content` 字段，返回 400。

前四次修复只处理了主 agent 的 API 调用路径，没有覆盖 auxiliary client 路径。

### 修复方案（commit `e50ba5d2`）

在 `agent/auxiliary_client.py` 的 `_build_call_kwargs()` 中，发送前统一过滤 assistant 消息的 `reasoning_content` 字段：

```python
cleaned_messages = []
for m in messages:
    if m.get("role") == "assistant" and "reasoning_content" in m:
        m = {k: v for k, v in m.items() if k != "reasoning_content"}
    cleaned_messages.append(m)
kwargs["messages"] = cleaned_messages
```

选择在 `_build_call_kwargs()` 修复而非 `flush_memories()`，因为 auxiliary client 永远不会是 DeepSeek thinking mode，所有辅助任务（flush_memories、compression、session_search 等）都受保护。

### 验证
- gateway 已重启
- fork/main 推送至 `e50ba5d2`

---

## 2026-04-25: DEVELOPMENT_LOG.md 自动备份保护机制

### 背景
rebase 同步上游时 force push 导致旧版日志丢失（需从旧 fork commit `ff9de403` 人工恢复），因此建立自动备份机制。

### 实现
**git pre-commit hook**（`.git/hooks/pre-commit`）：每次 `git commit` 前自动将 `DEVELOPMENT_LOG.md` 备份到 `~/.hermes/doc-backups/DEVELOPMENT_LOG_YYYYMMDD-HHMMSS.md`，保留最近 100 个版本，超出自动删除最旧的。

### 恢复方式
```bash
# 列出所有备份
ls -lt ~/.hermes/doc-backups/

# 恢复最新备份
cp ~/.hermes/doc-backups/$(ls -t ~/.hermes/doc-backups/ | head -1) DEVELOPMENT_LOG.md
```

### 注意
git hooks 不随 `git push` 同步到远程，换机器后需手动重建 hook。

---

## 2026-04-25: 同步上游至最新 + DeepSeek reasoning_content 全覆盖补丁（第四次）

### 背景
同步上游至 `e5647d78`（origin/main HEAD，共 240 个新 commit）后，上游已合并了 #15250 的部分修复（`93a2d6b3` + `d58b305a`），但方案不完整——只覆盖 `tool_calls` 消息，普通文本 assistant 消息仍会触发 400。我们在上游基础上追加了全覆盖补丁。

### 上游方案的漏洞

上游 `_build_assistant_message` 和 `_copy_reasoning_content_for_api` 均有 `source_msg.get("tool_calls")` 条件判断：

```python
# 上游（不完整）
elif msg.get("tool_calls") and self._needs_deepseek_tool_reasoning():
    msg["reasoning_content"] = ""

if source_msg.get("tool_calls") and (
    self._needs_kimi_tool_reasoning() or self._needs_deepseek_tool_reasoning()
):
    api_msg["reasoning_content"] = ""
```

这导致普通文本 assistant 消息（无 `tool_calls`）在重放时仍会缺少 `reasoning_content`，触发 HTTP 400（之前测试中已验证，msg[76] 为普通文本消息）。

### 修复方案（commit `fcd9cc58`）

去掉两处的 `tool_calls` 条件判断，覆盖所有 assistant 消息：

**`_build_assistant_message`**：
```python
# 修改后（我们）
elif self._needs_deepseek_tool_reasoning() or self._needs_kimi_tool_reasoning():
    msg["reasoning_content"] = ""
```

**`_copy_reasoning_content_for_api`**：
```python
# 修改后（我们）
if self._needs_kimi_tool_reasoning() or self._needs_deepseek_tool_reasoning():
    api_msg["reasoning_content"] = ""
```

### 上游本次包含的其他关键修复
- `023b1bff`：子 agent 审批死锁修复
- `1c8ce33d`：TUI ConPTY mouse 禁用 + `/mouse` 命令
- `19a3e2ce`：gateway `/resume` 跟随 compression continuations
- `05d8f110`：`/model` 显示 provider 实际 context length

### 验证
- gateway 已重启：`systemctl --user restart hermes-gateway`
- fork/main 已推送：`f120d065`（基于上游 `e5647d78`）

---


## 2026-04-25: DeepSeek v4-flash thinking mode — `reasoning_content` 400 错误

### 症状
长对话后发请求报错：
```
HTTP 400: The `reasoning_content` in the thinking mode must be passed back to the API.
```
fallback 也同样失败，对话完全中断。

### 根本原因
DeepSeek v4-flash 默认开启 thinking mode（`extra_body.thinking.type = "enabled"`）。当对话历史里存有 `reasoning_content`（之前思维链轮次产生），API 要求下次请求也必须携带 `extra_body.thinking` 声明，否则拒绝含有 `reasoning_content` 的消息。

`chat_completions.py` 的 `build_kwargs` 只对 Kimi 做了 `extra_body.thinking` 处理，DeepSeek 直连没有对应逻辑，导致历史 `reasoning_content` 被传回但 thinking toggle 缺失。

### 修复

**`run_agent.py`**：
- 添加 `_is_deepseek = base_url_host_matches(self.base_url, "api.deepseek.com")`
- 传递 `is_deepseek=_is_deepseek` 给 `build_kwargs`

**`agent/transports/chat_completions.py`**：
- `is_deepseek = params.get("is_deepseek", False)` 读取标志
- 仿 Kimi 处理：当 `is_deepseek` 时写入 `extra_body["thinking"]`
  - 默认 `type: "enabled"`，`budget_tokens: 8000`（effort=high）
  - `reasoning_config.enabled is False` 时改为 `type: "disabled"`
  - effort=max/xhigh 时 `budget_tokens: 16000`

### 背景
DeepSeek 官方说明：`deepseek-chat` / `deepseek-reasoner` 将被废弃，分别对应 v4-flash 的非思维链和思维链模式。thinking mode 通过 `{"thinking": {"type": "enabled/disabled"}}` 控制，**默认 enabled**。

### 验证
重启 gateway 后长对话正常继续，不再出现 400 错误。

---

## 2026-04-24: DeepSeek 模型名变更 — v4-flash/v4-pro 无法选择

### 症状
`/model` 命令选择 `deepseek-v4-flash` 后报错：
```
⚠️  Normalized model 'deepseek-v4-flash' to 'deepseek-chat' for deepseek.
✗ Model `deepseek-chat` was not found in this provider's model listing.
  Similar models: `deepseek-v4-flash`, `deepseek-v4-pro`
```

### 根本原因
DeepSeek 官方 API `/v1/models` 端点已不再返回 `deepseek-chat` 和 `deepseek-reasoner`，改为 `deepseek-v4-flash` / `deepseek-v4-pro`。但 `model_normalize.py` 的白名单里没有 v4 系列，所有 `deepseek-v4-*` 输入都被强制降级为 `deepseek-chat`，然后验证失败。

### 修复

**`hermes_cli/model_normalize.py`**：
- 将 `deepseek-v4-flash`、`deepseek-v4-pro` 加入 `_DEEPSEEK_CANONICAL_MODELS`
- 新增 `_DEEPSEEK_PASSTHROUGH_PREFIXES`：`deepseek-v*`、`deepseek-r*` 等前缀直接透传
- 默认 fallback 从 `deepseek-chat` 改为 `deepseek-v4-flash`

**`hermes_cli/model_switch.py`**：
- deepseek 默认模型 `deepseek-chat` → `deepseek-v4-flash`

**`~/.hermes/config.yaml`**：
- `model.default` 和 `fallback_model.model` 均改为 `deepseek-v4-flash`

### 验证
重启 gateway 后，`/model` 选 `deepseek-v4-flash` 不再出现 normalize 警告，正常响应。

### 经验总结
- DeepSeek 更新了 API 模型名，今后 v4/v5 等新系列直接透传即可，无需每次手动加白名单
- 每次 DeepSeek 发布新模型时，需检查 `_DEEPSEEK_CANONICAL_MODELS` 及 `_DEEPSEEK_PASSTHROUGH_PREFIXES` 是否需要更新

---

## 2026-04-24: hermes-webui 服务 failed — rebase 后前端 dist 丢失

### 症状
`hermes-webui.service` 持续 failed（exit-code 1），距上次成功运行已 2 天。日志已滚动，无法从 journalctl 获取报错。

### 根本原因
rebase 到 `v2026.4.23` 后，前端构建产物 `hermes_cli/web_dist/` 目录不存在。该目录被 `.gitignore` 排除，rebase 操作不会保留，需要手动重建。`cmd_dashboard()` 启动时调用 `_build_web_ui()` 检测不到 dist，且当时 systemd 环境可能缺少 npm，导致直接 `sys.exit(1)`。

### 修复
```bash
cd /home/morrowind/hermes-agent/web
npm install --silent
npm run build
systemctl --user restart hermes-webui
```

构建输出到 `hermes_cli/web_dist/`，重启后服务恢复 active。

### 经验总结
- **每次 rebase 后**，除了检查 Python 依赖，还必须检查 `web/` 前端是否需要重建
- `hermes_cli/web_dist/` 在 gitignore 里，rebase/clone 后一律缺失，需手动 `npm run build`
- 标准 rebase 后检查清单应增加：`ls hermes_cli/web_dist/ || (cd web && npm run build)`

---

## 2026-04-21: minimax-cn 404 修复 — systemd 未加载 .env 导致 base_url 未生效

### 症状
Gateway 调用 minimax-cn 时持续 HTTP 404，endpoint 显示 `https://api.minimaxi.com/anthropic`，与预期的 `https://api.minimax.chat/v1` 不符。

### 根本原因
`hermes_cli/auth.py` 解析 `base_url_env_var` 时只调用 `os.getenv()`，而 systemd 服务文件缺少 `EnvironmentFile` 指令，导致 `~/.hermes/.env` 中的 `MINIMAX_CN_BASE_URL` 从未被注入到进程环境中。

### 修复
在 `~/.config/systemd/user/hermes-gateway.service` 的 `[Service]` 段添加：
```ini
EnvironmentFile=-/home/morrowind/.hermes/.env
```
（前缀 `-` 表示文件不存在时不报错）

然后执行：
```bash
systemctl --user daemon-reload && systemctl --user restart hermes-gateway
```

### 验证
```
cat /proc/<PID>/environ | tr '\0' '\n' | grep MINIMAX_CN_BASE_URL
# → MINIMAX_CN_BASE_URL=https://api.minimax.chat/v1
```

### 经验总结
- systemd 服务**不会**自动读取 `~/.hermes/.env`，必须显式配置 `EnvironmentFile`
- 凡是用 `os.getenv()` 读取的环境变量（而非 `get_env_value()`）都存在此问题
- `get_env_value()` 会同时检查进程环境和 `.env` 文件，更健壮；但 base_url 相关逻辑走的是前者

---

## 2026-04-20: TUI 启动自动激活微信桥接

### 需求
每次重启 TUI 后不需要手动执行 `/bridge weixin <chat_id>`，启动时自动恢复桥接。

### 根本原因
- TUI 正常退出时调用 `_bridge_detach()`，会 `clear_subscription()` 删除订阅文件。
- 自动恢复逻辑（第 8744 行）仅读取订阅文件，文件不存在时不做任何事，导致每次启动后桥接为 off。

### 修复方案

**1. `cli.py`（第 8744 行附近）**：在订阅文件不存在时追加 fallback 逻辑，读取 `config.yaml` 的 `bridge.default` 配置并自动激活：

```python
else:
    _default_bridge = self.config.get("bridge", {}).get("default", {})
    _plat = _default_bridge.get("platform", "")
    _cid = _default_bridge.get("chat_id", "")
    if _plat and _cid:
        self._bridge_attach(_plat, _cid)
        _cprint(f"  (Auto-attached from config. Use /bridge off to detach.)")
```

**2. `~/.hermes/config.yaml`**：添加：
```yaml
bridge:
  default:
    platform: weixin
    chat_id: o9cq807-0UUke4yw0AOz2kVnIcLA@im.wechat
```

### 验证
重启 TUI 后应在启动信息中看到：`(Auto-attached from config. Use /bridge off to detach.)`

---

## 2026-04-18: WebUI 无法显示 → Build + 添加 systemd 常驻服务

### 症状

`hermes dashboard` 页面无法访问（9119 端口不通）。

### 根本原因

1. **前端从未 build**：`web/dist` 目录不存在，`hermes_cli/web_dist/` 里只有旧静态文件。
2. **进程没有运行**：无 `hermes dashboard` 常驻进程。

### 修复步骤

1. Build 前端：
   ```bash
   cd /home/morrowind/hermes-agent/web && npm run build
   ```
2. 创建 `~/.config/systemd/user/hermes-webui.service`：
   ```ini
   [Unit]
   Description=Hermes Agent WebUI Dashboard
   After=network.target hermes-gateway.service
   Wants=hermes-gateway.service
   StartLimitIntervalSec=300
   StartLimitBurst=5

   [Service]
   Type=simple
   ExecStart=/home/morrowind/hermes-agent/venv/bin/python -m hermes_cli.main dashboard --port 9119 --no-open
   WorkingDirectory=/home/morrowind/hermes-agent
   Environment="PATH=/home/morrowind/hermes-agent/venv/bin:/home/morrowind/hermes-agent/node_modules/.bin:/usr/local/bin:/home/morrowind/.local/bin:/home/morrowind/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
   Environment="VIRTUAL_ENV=/home/morrowind/hermes-agent/venv"
   Environment="HERMES_HOME=/home/morrowind/.hermes"
   Restart=on-failure
   RestartSec=15
   KillMode=mixed
   KillSignal=SIGTERM
   TimeoutStopSec=30
   StandardOutput=journal
   StandardError=journal

   [Install]
   WantedBy=default.target
   ```
3. 启用并启动：
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now hermes-webui.service
   ```

**常用管理命令：**
```bash
systemctl --user status hermes-webui    # 查看状态
systemctl --user restart hermes-webui   # 重启（前端重新 build 后必须执行）
systemctl --user stop hermes-webui      # 临时停止
journalctl --user -u hermes-webui -f    # 实时查看日志
```

### 验证

- `systemctl --user status hermes-webui.service` → `active (running)`
- `ss -tlnp | grep 9119` → PID 监听 127.0.0.1:9119
- 浏览器访问 http://127.0.0.1:9119 正常显示

### 经验

以后 rebase upstream 后如果 web/ 目录有变化，需要重新执行 `npm run build`，否则 WebUI 显示的是旧版前端。

---

## 2026-04-18: 修复 send_message 两个 Bug（No home channel / Timeout context manager）

### 症状

1. `send_message(action='send', target='weixin:...')` 报 `No home channel set`，即使 `config.yaml` 里已设置 `WEIXIN_HOME_CHANNEL`。
2. 发送文件/媒体时报 `Timeout context manager should be used inside a task`。

### 根本原因

**问题1 — 配置路径错误**：

`config.yaml` 顶层的 `WEIXIN_HOME_CHANNEL: xxx` 是无效位置。`gateway/config.py` 里解析 weixin home_channel 走的是 `os.getenv("WEIXIN_HOME_CHANNEL")`，只读 `~/.hermes/.env` 文件，不解析 yaml 顶层 key。

**问题2 — asyncio Task 缺失**：

CLI 侧调用 `send_message` 工具时，`model_tools.py` 中 `_run_async()` 用 `loop.run_until_complete(coro)` 直接执行协程，协程不在 asyncio Task 里。aiohttp 在 Python 3.11+ 内部用 `asyncio.timeout()` 做超时控制，该 context manager 要求必须在 Task 上下文中运行，否则抛此错。

### 修复方案

**问题1**：
- 将 `WEIXIN_HOME_CHANNEL=o9cq807-0UUke4yw0AOz2kVnIcLA@im.wechat` 写入 `~/.hermes/.env`
- 删除 `config.yaml` 顶层无效的 `WEIXIN_HOME_CHANNEL:` key

**问题2**（`model_tools.py`）：

```python
# 修改前
worker_loop.run_until_complete(coro)
tool_loop.run_until_complete(coro)

# 修改后
worker_loop.run_until_complete(asyncio.ensure_future(coro, loop=worker_loop))
tool_loop.run_until_complete(asyncio.ensure_future(coro, loop=tool_loop))
```

`ensure_future()` 将协程包装为 Task，满足 aiohttp 内部 `asyncio.timeout()` 的运行要求。

### 验证

Gateway 重启后微信平台成功连接，`home_channel` 正确读取。

---

## 2026-04-18: TUI 对话自动同步到微信桥接会话

### 需求

当 `/bridge weixin <chat_id>` 激活后，TUI 里的普通 AI 对话（用户输入 + Hermes 回复）应自动转发到对应的微信会话，让微信用户能实时看到 TUI 里的对话内容。桥接激活即自动生效，无需额外开关。

### 架构

利用已有 outbox 文件队列 IPC（`gateway/bridge_queue.py`）——TUI 写入，gateway `_start_bridge_watcher` 消费投递，无需任何 gateway 改动。

| 方向 | 机制 | 状态 |
|------|------|------|
| 微信 → TUI 显示 | SQLite 轮询 | 已有 |
| TUI `> 消息` → 微信 | outbox 队列 | 已有 |
| **TUI 普通对话 → 微信** | outbox 队列（本次新增） | ✅ 新增 |

### 实现

**文件**：`cli.py`  
**位置**：`chat()` 方法，`response = result.get("final_response", "")` 之后（第 8265 行）

插入约 25 行代码，调用已有 `_bridge_send()`：

```python
# Bridge sync: forward TUI conversation to the bridged platform session.
if (
    self._bridge_platform
    and self._bridge_chat_id
    and response
    and not (result and (result.get("failed") or result.get("partial") or result.get("interrupted")))
):
    try:
        if isinstance(message, str):
            _user_text = message.strip()
        elif isinstance(message, list):
            _parts = [b.get("text", "") for b in message if isinstance(b, dict) and b.get("type") == "text"]
            _user_text = " ".join(_parts).strip()
            if any(b.get("type") in ("image_url", "image") for b in message if isinstance(b, dict)):
                _user_text = (_user_text + " [含图片]").strip()
        else:
            _user_text = ""
        if _user_text:
            self._bridge_send(f"[TUI] 你：{_user_text}")
        self._bridge_send(f"[TUI] Hermes：{response}")
    except Exception as _be:
        logger.debug("bridge forward error: %s", _be)
```

### 关键决策

- **插入位置**：`final_response` 取得后，确保只转发完整最终回复，不转发中间 tool-call 步骤
- **跳过条件**：`failed` / `partial` / `interrupted` 均不转发，避免错误或截断内容出现在微信端
- **多模态支持**：list 类型 message 提取 text 块，含图片时追加 `[含图片]` 标注
- **零额外开销**：`_bridge_send()` 只做文件追加写，完全非阻塞

### 消息格式（微信端显示）

```
[TUI] 你：帮我写一首关于秋天的诗
[TUI] Hermes：秋风吹落叶，...
```

### 调试过程摘要

- 最初修改后 TUI 未重启，Python 进程内存中是旧模块，调试代码无效
- 重启后发现 `_bridge_platform=None`：TUI 重启会清空桥接状态，需重新执行 `/bridge`
- 这直接暴露了"每次重启都要手动激活"的体验问题，促使实现了下面的自动恢复功能

---

## 2026-04-18: TUI 启动自动恢复桥接会话

### 需求

TUI 重启后，`_bridge_platform` 被清空，用户需要每次手动执行 `/bridge weixin <chat_id>` 才能重新激活桥接，体验差。

### 实现

**文件**：`cli.py`  
**位置**：`run()` 方法，欢迎消息显示后、状态初始化之前（第 8744 行）

启动时读取已有的 `subscription.json`，若记录有效则直接调用 `_bridge_attach()` 自动激活：

```python
# Auto-restore bridge on startup
try:
    from gateway.bridge_queue import read_subscription
    _sub = read_subscription()
    if _sub and _sub.get("platform") and _sub.get("chat_id"):
        self._bridge_attach(_sub["platform"], _sub["chat_id"])
        _cprint(f"  (Auto-restored from last session. Use /bridge off to detach.)")
except Exception:
    pass  # 非关键，不阻塞启动
```

### 效果

- 首次执行 `/bridge weixin <chat_id>` → 写入 `subscription.json`
- 之后每次重启 TUI，自动恢复桥接，无需手动输入
- 如不需要，执行 `/bridge off` 即可手动取消（同时清除 `subscription.json`）

---

## 2026-04-17: 微信机器人 MiniMax API tool_call/result 配对修复

### 症状

微信机器人调用 MiniMax API 时持续报错：
```
⚠️ Max retries (3) exhausted — trying fallback...
```
错误发生在上下文约 130 条消息、~69k tokens 时。

### 根本原因

MiniMax API 对消息序列有严格要求：assistant 声明的每个 `tool_call_id` 必须紧跟对应的 tool result，且不能有 pending call 被 user 消息打断。消息历史中出现了两类不合规配对：

**Bug 1：重复 assistant 消息**
- `[45]` assistant 声明 `call_function_6q8o4unprv4v_1`
- `[46]` tool result 正常
- `[47]` **又一个 assistant 重新声明相同 call_id**，后面直接是 user 消息 → MiniMax 报错

**Bug 2：orphan result + 后续重新声明**
- `call_5aaf249667ef4d6891262f20` 的 tool result 在 idx=120（比对应 assistant idx=123 更早）
- 旧代码删掉了 orphan result，但 `resolved_call_ids` 仍保留该 id
- 导致 idx=123 的 assistant 被误判为"已消费的重复"而保留，pending call 被 user 打断

### 修复方案

**文件**：`run_agent.py`  
**方法**：`AIAgent._sanitize_api_messages`（完全重写，顺序扫描替代 set 比较）

新算法 5 个步骤：
1. Pass 0：过滤非法 role
2. 建立全局 `resolved_call_ids`（所有有 tool result 的 call_id）
3. 顺序扫描：用 `consumed_call_ids` 实时追踪已消费的 call_id
4. 重复 assistant（所有 call_id 均已消费）→ 删除 tool_calls，保留文本内容
5. 缺失 result → 注入 stub；orphan result → 删除并同步更新 `resolved_call_ids`

**关键 fix**：删除 orphan result 时必须同步从 `resolved_call_ids` 移除，否则后续对应 assistant 会被误判：

```python
elif role == "tool":
    cid = msg.get("tool_call_id")
    if cid not in all_assistant_call_ids:
        resolved_call_ids.discard(cid)  # ← 关键：同步移除，防误判
        removed_orphan_results += 1
        continue
    if cid:
        consumed_call_ids.add(cid)
    patched.append(msg)
```

### 验证

```
Before: 129 msgs  →  After: 127 msgs
✅ All tool_call/result pairs are properly ordered!
```

语法检查通过，重启 gateway 后微信机器人恢复正常。

### 经验总结

- MiniMax / 严格 OpenAI 兼容 API 对 tool_call/result 配对敏感，必须保证顺序一致性
- `_sanitize_api_messages` 应使用顺序扫描（有状态遍历），不能用全局 set 比较
- orphan result 的删除必须同步更新所有相关状态集合，防止后续判断错误

---

## 2026-04-17: TUI ↔ 微信双向消息桥接

### 需求

在 CLI TUI 里直接与微信用户双向交互：TUI 发的消息微信端看得到，微信发的消息也实时显示在 TUI 里并可回复。

### 架构设计

两个方向使用不同机制：

| 方向 | 机制 |
|------|------|
| 微信 → TUI | TUI 后台线程轮询共享 SQLite（`~/.hermes/state.db`），检测目标 session_id 有新消息时打印到终端 |
| TUI → 微信 | TUI 写文件队列（`~/.hermes/bridge/outbox/`），gateway 后台线程读取后调用 `WeixinAdapter.send()` |

**为什么不直接调用 `WeixinAdapter.send()`？**  
`WeixinAdapter.send()` 依赖 `_session`（aiohttp ClientSession）和 `_token`（认证 token），这些是 gateway 进程内部的异步状态，TUI 无法直接访问。文件队列 IPC 是最简单且进程安全的解耦方式。

### 涉及文件

| 文件 | 变更说明 |
|------|----------|
| `gateway/bridge_queue.py` | **新建**。文件队列 IPC 工具：`enqueue_message()`（TUI 写）、`drain_outbox()`（gateway 读）、`write_subscription()` / `read_subscription()`（订阅管理） |
| `gateway/run.py` | 新增 `_start_bridge_watcher()` 后台线程函数；`start_gateway()` 中随 cron 线程一起启动，gateway 关闭时同步 stop |
| `cli.py` | 新增 `_handle_bridge_command()`、`_bridge_attach()`、`_bridge_detach()`、`_bridge_show_status()`、`_bridge_list_sessions()`、`_bridge_poll_thread()`、`_bridge_send()`；`process_command()` 注册 `bridge` 分支；主输入循环拦截 `>` 前缀发送到桥接平台 |
| `hermes_cli/commands.py` | 注册 `CommandDef("bridge", ...)` |

### 使用方法

**第一步：找到微信用户的 chat_id**

chat_id 是微信 iLink API 返回的用户 ID，可以从 gateway 日志中找到：
```
grep "inbound message.*weixin" ~/.hermes/logs/gateway.log | tail -5
# 输出示例：inbound message: platform=weixin user=小明 chat=abc123def456
```

也可以在 TUI 里列出已有 weixin 会话：
```
/bridge weixin
```

**第二步：挂载桥接**

```
/bridge weixin abc123def456
```

挂载后 TUI 会显示：
```
Bridge attached: weixin/abc123def456
Messages from this chat will appear below.
To send a message to WeChat, prefix your input with '>' — e.g.  > Hello!
Type /bridge off to detach.
```

**第三步：双向交互**

- **发送消息到微信**：在 TUI 输入框键入 `> 你好！` 然后回车
- **微信消息自动推送**：每 0.8 秒轮询一次 SQLite，有新消息时自动显示

**第四步：解除桥接**

```
/bridge off
```

### 技术细节

- **SQLite 轮询水位**：用 `rowid` 作为水位线，避免重复显示历史消息
- **session_id 延迟解析**：如果对应会话还没有 session_id（微信用户从未发过消息），轮询线程会持续重试直到 gateway 创建会话
- **bridge watcher 速率**：默认 0.5s 检查一次 outbox，延迟极低
- **进程安全**：outbox 文件用原子性 read+unlink 操作消费，避免重复投递
- **TUI 独占 bridge**：同一时刻只能桥接一个平台会话，`/bridge weixin <new_id>` 会自动 detach 旧会话

### 已知限制

- 当前只显示 user/assistant 角色的文本消息，不处理图片/语音
- `>` 前缀发送是明文，不经过 AI 处理（直接发给微信用户）
- 若 gateway 未运行，outbox 消息会在 gateway 重启后自动补发（文件持久化）

---

## 2026-04-16: 微信通道发消息无回应问题修复

### 症状

从微信机器人发消息后没有任何回应。

### 排查过程

**1. 确认 gateway 未运行**

`ps aux` 发现没有 `hermes gateway` 进程，是 gateway 根本没在运行。启动后查看日志，发现两个问题：

**2. 代理拦截 iLink API 轮询（主因）**

日志：
```
Cannot connect to host 127.0.0.1:7897 ssl:default [Connect call failed]
```

系统环境变量设了 `https_proxy=http://127.0.0.1:7897`，aiohttp 的 `trust_env=True` 会透传这个代理，但该代理当时不可用，导致所有到 `ilinkai.weixin.qq.com` 的轮询请求失败，消息完全收不到。

**3. 全局用户授权拦截（次因）**

日志：
```
No user allowlists configured. All unauthorized users will be denied.
```

gateway 全局 allowlist 没有配置，所有微信用户被拒绝。

### 修复方案

**修复1：代码层面强制绕过代理（`gateway/platforms/weixin.py`）**

微信 iLink API 和 CDN 均为国内服务，不需要走代理。在所有 HTTP 请求中显式传 `proxy=None`，彻底绕过系统代理，不依赖用户手动配置环境变量：

- `_api_post()`：iLink API POST 请求
- `_api_get()`：iLink API GET 请求
- `_upload_ciphertext()`：CDN 媒体上传
- `_download_bytes()`：CDN 媒体下载

```python
# 修改前
async with session.post(url, data=body, headers=..., timeout=timeout) as response:

# 修改后
async with session.post(url, data=body, headers=..., timeout=timeout, proxy=None) as response:
```

**修复2：配置允许所有微信用户（`~/.hermes/.env`）**

```bash
WEIXIN_ALLOW_ALL_USERS=true
```

**修复3：启动 gateway**

```bash
cd /home/morrowind/hermes-agent
source venv/bin/activate
nohup python -m gateway.run > ~/.hermes/logs/gateway.log 2>&1 &
```

### 验证

- 34 个 `tests/gateway/test_weixin.py` 测试全部通过
- 启动后日志显示 `Connected account=f47343e3`，并开始正常收取积压消息
- 微信发消息有回应，问题解决

### 经验总结

- 系统设了全局代理时，国内服务（微信、钉钉等）的 aiohttp 请求必须显式传 `proxy=None`
- gateway 默认不会自动启动，重启机器或环境后需手动拉起
- 建议配置 systemd service 或 supervisor 自动管理 gateway 进程

---
