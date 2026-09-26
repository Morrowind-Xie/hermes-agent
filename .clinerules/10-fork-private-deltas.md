# 本 fork 的操作规则 · 私有 delta 与复核清单

## R4 · fork 本地文件（上游无对应物，必须存在且被引用）

| 文件 | 作用 |
|---|---|
| `hermes_cli/cli_bridge_mixin.py` | 微信↔TUI 桥：bridge 状态字段、`/bridge` 分发、启动自动恢复、工具进度通知、对话镜像同步 |
| `apps/desktop/electron/pool-eviction.ts` (+ `.test.ts`) | 池饱和 backpressure：`selectPoolEvictions()` → `localBackendSlotsThatMayFree()` → `decideLocalBackendAdmission` |
| `scripts/patch-assistant-ui-render-loop.mjs` | 根 `package.json` postinstall 里挂的 assistant-ui 渲染环补丁 |

每轮同步后检查是否仍在、是否仍被引用：

```bash
for f in hermes_cli/cli_bridge_mixin.py apps/desktop/electron/pool-eviction.ts scripts/patch-assistant-ui-render-loop.mjs; do
  [ -f "$f" ] && echo "ok $f" || echo "MISSING $f"; done
grep -n 'selectPoolEvictions' apps/desktop/electron/main.ts
find node_modules/@assistant-ui -name subscribable.js -exec grep -c 'hermes-render-loop-patch' {} + | head -1
```

`pool-eviction.ts` 已被上游删过一次（`chore(desktop): drop four electron modules nothing imports` —— 删它的前提是"**上游树**里无人引用"），本轮之后它是**fork 本地文件**；再被删就按分叉点恢复。

## R5 · 逐行存活校验（不可省）

把"本地相对上次同步点的全部私有工作"逐行核对是否仍在合并后的树里：

```bash
# BASE = 上次同步到的上游 tip；REF = 本次合并前的 fork HEAD（即 39b2a067bd 一类）
BASE=<上次上游 tip> REF=<合并前 HEAD> ./venv/bin/python <verify_private.py>   # 期望末行 missing_total=0
```

脚本口径：取 `git diff $BASE..$REF -- <file>` 的 `+` 行（跳过 `DEVELOPMENT_LOG.md`、`.gitignore`），逐行确认仍存在于合并后的文件中。**刻意重写**的少数行放进 `EXPECTED_REWRITES` 白名单，白名单里每条都要能说出理由（例：把 source 启动从 `npm exec -- electron .` 换成 prepared Electron 运行时，因为上游换了实现）。

历史脚本模板：`/tmp/sync/verify_private.py`、`/tmp/sync2/…`、`/tmp/sync3/…`（临时目录可能被清；被清就按上述口径重建，脚本很短）。

## R6 · 常驻重叠文件（两侧都改，自动合并后必须人工复核）

- `gateway/run_turn.py` —— 我们放 bridge inbox + 对话镜像；上游放 turn / silence 判定链
- `hermes_cli/main_desktop.py` —— 我们放 `source` 启动的 `desktop.electron_flags`；上游反复重构启动实现
- `tests/hermes_cli/test_gui_command.py` —— 我们的 2 个 `electron_flags` 测试；上游反复重写该文件
- `agent/auxiliary_client.py`、`apps/desktop/electron/main.ts`、`apps/desktop/src/i18n/*.ts`

**零文本冲突 ≠ 零复核。** 每个重叠文件都要回答两件事：

1. **变量/符号作用域**：自动合并可能让调用点引用的名字被搬走 —— `py_compile` 查不出，必须 `grep` 确认定义在**使用之前**且同一作用域。实例：`gateway/run_turn.py` 里我们传 `bridge_user_msg=message_text`，必须确认 `message_text` 的赋值仍早于该调用点。
2. **判定前后语义**：我们该传"判定后的值"还是"判定前的值"。实例：bridge 镜像应显示 gateway **实际发出**的 `response`（silence 判定之后的值），否则 TUI 显示与实际发送不一致。

## R7 · 其他既存红线

- `hermes_cli/main_install_repair.py`、`main_web_build.py` **本地已存在**（上游更早拆分），不要重复创建。
- 改 CLI 私有代码时改 `hermes_cli/cli_*_mixin.py`，**不要改 `cli.py`**（上游已把它拆成 mixin，只剩类头与少量未搬迁方法）。
- `bridge` 的落点与可达性探针（每轮同步后跑一次）：

  ```bash
  ./venv/bin/python -c "from cli import HermesCLI; print(HermesCLI._slash_handler('bridge'), len(HermesCLI._SLASH_DISPATCH))"
  # 期望：('_handle_bridge_command', True) 44
  ```

- 本地新增测试若用 `linux_only`/`macos_only`/`windows_only` 旧 marker，会被 CI 车道**静默忽略**（既不在任何 host 上跑，也不报错）；唯一 host-gating marker 是 `@pytest.mark.platforms(...)`。
- 不要"顺手"把上游删掉的读源码型测试加回来（上游在批量清洗那类测试，项目 `AGENTS.md` 明令禁止测试读源码）。
