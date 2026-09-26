# 本 fork 的操作规则 · 上游同步

适用范围：本仓库是 `Morrowind-Xie/hermes-agent` 的 fork。`AGENTS.md` 管**项目源码怎么写**（上游规范，含各区域 `AGENTS.md`）；本目录管**如何操作这个 fork**（同步、验证、运行）。冲突时取更严者。

远端：`origin` = `NousResearch/hermes-agent`（上游）；`fork` = `Morrowind-Xie/hermes-agent`（我们的推送目标）。

---

## R1 · 同步触发策略（最重要）

**上游更新极快（单日 288 ~ 3194 个提交）。用户不打算随时跟进，默认姿态是"不同步"。**

- **只在出现「新的稳定 tag 且尚未并入 HEAD」时，才主动提示同步。** 其余任何时刻都不要劝同步。
- 用户主动问「检查上游情况」时，**照常报告全部事实**（behind/ahead、上游 tip、规模、热点目录、冲突预演、是否需要 `npm ci`/`uv sync`/web 重建）—— 这只是报告，不是提示同步。结论行必须明确写「无需同步（最新稳定 tag 已并入）」或「有新的稳定 tag，建议同步」。
- 只有用户明确说「同步」才动手。

判定命令（已实测，直接照抄）：

```bash
git fetch origin --tags --prune -q
tag=$(git tag --sort=-creatordate | grep -E '^v20[0-9]{2}\.[0-9]+\.[0-9]+$' | head -1)
git merge-base --is-ancestor "$tag" HEAD && echo "SYNCED  $tag" || echo "NEW STABLE TAG  $tag"
```

- **稳定 tag** = `^v20[0-9]{2}\.[0-9]+\.[0-9]+$`（如 `v2026.9.24`、`v2026.9.21`）。
- **不算稳定版，必须忽略**：`rc.N-v0.21.5`、`abandoned-rc.N-v0.21.5`、`v0.21.4+canary.<ts>` —— 这些是发布流水线的试切/废弃候选，一天能出十几个（实测 09-26 一天出了 6 个 rc + 6 个 abandoned）。
- `SYNCED` = 最新稳定 tag 已是 HEAD 祖先 → **不提示同步**；`NEW STABLE TAG` = 未并入 → 提示，并附规模 / 冲突预演 / 依赖影响（是否需 `npm ci`、`uv sync`、重建 web）。
- 一次 fetch 出现多个新稳定 tag 时，只报最新那个，并说明跨越了哪几个。

## R2 · 同步执行流程（用户说「同步」后照此执行）

1. **预检**：工作区干净、`main == fork/main`；记下 gateway / dashboard / desktop 的 PID（同步后要重启，见 `20-pm-and-runtime.md`）。
2. **冲突预演**：`git merge-tree --write-tree --name-only main origin/main`（历史准确率 100%，与实跑逐字一致）。
3. **合并**：`git merge origin/main --no-edit`，逐文件解冲突（原则见 `10-fork-private-deltas.md`）。
4. **逐行存活校验**（R5，不可省）：确认本地私有改动没被静默丢弃。
5. **语义复核**：按 `10-fork-private-deltas.md` 的重叠文件清单逐个查（**零文本冲突 ≠ 零复核**）。
6. **全串行验证链**：pytest → `uv lock --check` →（如需要）`npm ci` → `typecheck` → **`eslint`** → 定向 vitest →（如需要）web build → desktop build。
7. **写日志 + 推送**：`DEVELOPMENT_LOG.md` 顶部新增条目，然后 `git push fork main`。

## R3 · 验证节奏与不可跳过的项

- **全串行**：禁止同时压 pytest + vitest + tsc + build（并发会产生假阳性）。
- **`typecheck` 不可跳**：上游会成批删除"它自己树里没人引用"的模块（实测删过 `pool-eviction.ts`、`gitlock.ts`、`deep-link-route.ts`、`update-remote.ts`），这类丢失**只有 typecheck/import 能发现**。
- **`eslint` 不可跳**：自动合并会把两侧的 named import 拼成一份列表而打乱 `perfectionist/sort-named-imports` 要求的顺序 —— `tsc` 与 vitest **都不报**（实测 2026-09-26：`pool-spawn-coordinator.test.ts` 的 import 顺序被合并打乱，typecheck rc=0、vitest 全绿，只有 eslint 报 error）。命令：
  ```bash
  cd apps/desktop && npx eslint src/ electron/ --quiet   # error 行数为 0 才算过
  ```
  同理，若本波改动了 `web/` 或 `ui-tui/`，也跑一次对应 workspace 的 lint（根 `npm run --ws check` 含 typecheck+test+lint，较重，按需）。
- 冲突标记必须清零：`git grep -c '^<<<<<<< ' | wc -l` → `0`。
- 判"要不要 `npm ci` / 要不要重建 web" **看 `git diff --stat` 与 lockfile 实际差异，不要看版本号** —— 上游主线版本恒为 `0.0.0`（真实身份 = release tag + `install-stamp.json`）。
- 定向 pytest：跑 `10-fork-private-deltas.md` 的常规集，**再加**本波改动热点目录对应的测试文件（上游新增的测试文件按文件名直接加）。
