# Hermes Agent — 开发与调试记录

> **时间线索**：最新的记录在最顶端，按时间倒序排列。

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
