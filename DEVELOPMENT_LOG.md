# Hermes-Agent 开发日志

> 时间线索：最新的记录在最顶端，按时间倒序排列。
> 本文件记录 fork 独有的功能开发、调试过程和架构决策。

---

## 2026-04-25 DeepSeek reasoning_content 全覆盖修复（第四次，同步上游后追加）

### 背景
同步上游至最新（`e5647d78`）后，上游自己合并了 #15250 的修复（`93a2d6b3` + `d58b305a`），
但上游方案只覆盖了 `tool_calls` 消息，未覆盖普通文本 assistant 消息。
我们在测试中已验证普通文本消息也会触发 400，因此在上游基础上追加补丁。

### 症状
DeepSeek v4-flash 直连 + 长 session 重放时：
```
HTTP 400: The reasoning_content in the thinking mode must be passed back to the API.
```
触发消息为无 `tool_calls` 的普通文本 assistant 消息。

### 根本原因
DeepSeek thinking mode 要求历史中**每一条** assistant 消息（无论是否有 `tool_calls`）
都必须携带 `reasoning_content` 字段（空字符串可接受）。

上游 #15250 的修复：
- `_build_assistant_message`：只在有 `tool_calls` 时写入 `reasoning_content=""`
- `_copy_reasoning_content_for_api`：兜底只对 `tool_calls` 消息补空字符串

两处都缺少对普通文本消息的覆盖。

### 修复方案（commit `fcd9cc58`）

**`_build_assistant_message`**（创建时防毒）：

```python
# 修改前（上游）
elif msg.get("tool_calls") and self._needs_deepseek_tool_reasoning():
    msg["reasoning_content"] = ""

# 修改后（我们）
elif self._needs_deepseek_tool_reasoning() or self._needs_kimi_tool_reasoning():
    msg["reasoning_content"] = ""
```

**`_copy_reasoning_content_for_api`**（重放时兜底）：

```python
# 修改前（上游）
if source_msg.get("tool_calls") and (
    self._needs_kimi_tool_reasoning()
    or self._needs_deepseek_tool_reasoning()
):
    api_msg["reasoning_content"] = ""

# 修改后（我们）
if self._needs_kimi_tool_reasoning() or self._needs_deepseek_tool_reasoning():
    api_msg["reasoning_content"] = ""
```

### 迭代历史（本次 rebase 前的三轮调试）

| 轮次 | 触发场景 | 修复 |
|------|---------|------|
| 第1次 | 无 `extra_body.thinking` toggle | 添加 DeepSeek thinking mode 开关 |
| 第2次 | msg[103] tool_calls 消息无 `reasoning_content` | 对 tool_calls 消息补空字符串 |
| 第3次 | msg[76] 普通文本消息无 `reasoning_content` | 对所有 assistant 消息兜底补空字符串 |
| 第4次（本次）| 同步上游后上游方案不完整 | 在上游基础上恢复全覆盖逻辑 |

### 验证
- gateway 已重启：`systemctl --user restart hermes-gateway`
- fork/main 已 force push：`fcd9cc58`（基于上游 `e5647d78`）

---

## 2026-04-25 同步上游至最新

将本地 main 同步到上游 `e5647d78`（origin/main HEAD），共合并 240 个上游 commit。

上游本次包含的关键修复：
- `93a2d6b3`：DeepSeek tool-call 消息 reasoning_content echo（不完整版）
- `d58b305a`：提取 `_needs_kimi_tool_reasoning()` 辅助方法 + 21 个回归测试
- `023b1bff`：子 agent 审批死锁修复
- `1c8ce33d`：TUI ConPTY mouse 禁用 + /mouse 命令
- `19a3e2ce`：gateway /resume 跟随 compression continuations

---

## 2026-04 DeepSeek 直连支持（初始实现）

### 功能
- 添加 DeepSeek v4-flash / v4-pro 模型名支持
- 添加 `extra_body.thinking` toggle（仿 Kimi 逻辑）
- 添加 `_is_deepseek` 检测（`base_url_host_matches("api.deepseek.com")`）

### 相关 commits（已被 rebase 合并到上游基础上）
- `2c38a573`：更新 DeepSeek 模型名
- `c84d55dc`：添加 thinking mode toggle
- `2ded2fa4`：非 thinking provider 剥掉 reasoning_content
- `7dbe7787`：tool-call 消息补空字符串
- `ff9de403`：所有 assistant 消息全覆盖（第三次修复）
