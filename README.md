# Local Codex Bridge

*A thin supervisory MCP bridge between external AI supervisors and native Codex.*

Local Codex Bridge 是一个面向 Windows 与 macOS 的轻量 MCP stdio 适配器：

```text
ChatGPT / external AI supervisor
              ↕
        Local Codex Bridge
              ↕
      native Codex app-server
              ↕
   native Codex threads / turns
```

它解决的不是“再造一个 Codex”，而是让擅长对话、规划和持续监督的 AI，可以直接监督本机原生 Codex 完成真实工程任务。

**监督者负责目标、资源、边界、风险、审批与验收；Codex 保留原生的编码与执行自主性。**

Bridge 本身保持薄层：

- 不创建第二套 job / task 系统；
- 不复制 Codex 对话历史；
- 不维护平行线程数据库；
- 不缓存“当前模型”状态；
- 不替代 Codex 自己的 session / thread / turn 语义。

**原生 Codex thread/session 始终是执行事实源。**

## 当前测试候选版本

**V2.1.3** · [CHANGELOG](CHANGELOG.md)

V2.1.3 继续收紧 Bridge 作为 supervisory adapter 的边界，并补充：

- 原生 `model/list` 的按需发现；
- `codex_turn` 的可选 model / reasoning-effort override；
- stable permission approval response；
- mutating acknowledgement timeout 的 UNKNOWN 语义；
- 公开工具描述与运行时约束的一致性；
- 统一版本锚点与升级假设检查。

Windows 与 macOS 共用同一核心 Bridge，实现差异只保留在平台原生路径、launcher、checkpoint 默认目录、进程启动与终止等系统边界。

------

## 谁负责什么

### External supervisor / ChatGPT

适合负责：

- 理解用户目标；
- 拆解任务；
- 决定工作范围与风险边界；
- 选择何时继续观察、纠正、审批或中断；
- 判断结果是否满足验收条件；
- 在 Codex 无法自行安全决定时提供监督。

### Native Codex

继续负责：

- 原生 thread / turn 生命周期；
- 工作区文件与命令执行；
- Codex 自己的上下文与历史；
- sandbox 与 approval-policy 行为；
- 模型和 reasoning effort 的真实运行状态；
- 持久化的原生执行结果。

### Local Codex Bridge

只负责把两者接起来：

- MCP stdio ↔ Codex app-server JSONL；
- 有界地暴露监督所需状态；
- 转发明确的控制意图；
- 对高风险、歧义或协议边界 fail closed；
- 不把自己升级成第二个 orchestration runtime。

------

## 10 个 MCP 工具（当前开发候选）

| Tool               | 用途                                                         | 边界                                                         |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `codex_threads`    | 列出、搜索、读取原生 Codex 持久线程                          | `cwd` / search 只是筛选条件，不是 ACL                        |
| `codex_models`     | 按需读取一页原生 `model/list`                                | 不缓存模型目录，不维护 current-model registry                |
| `codex_turn`       | 创建或恢复原生 thread，并启动一个 turn                       | 返回 accepted 不等于任务完成；model / effort 都是可选 override |
| `codex_observe`    | 有界读取实时事件、持久历史、pending requests、terminal state 与 cursor | 支持一次 bounded wait；安静不等于卡死                        |
| `codex_steer`      | 对同一个 active turn 追加语义纠正或新意图                    | 不是 timer、polling 或 retry 机制                            |
| `codex_respond`    | 回答真实存在且 Bridge 明确支持的 approval / user-input / permission request | 必须保留原始 request id 和准确 scope；不支持 elicitation     |
| `codex_interrupt`  | 中断准确的 active thread / turn                              | 只发送原生 interrupt，不重启 Bridge 或 app-server            |
| `bridge_status` | 读取当前运行 Bridge 身份、进程与 live 状态 | 不启动子进程；未知字段明确 unavailable |
| `codex_runtime` | 读取或显式重启所管理的 app-server 子进程 | 有 active/pending/in-flight 时 RESTART_DENIED；重新握手 |
| `codex_checkpoint` | 保存可选、精简、有界的 supervisory anchor                    | 不是 transcript、job id 或 Codex history 的替代品            |

完整 schema 与运行时限制以 [`src/tools.ts`](src/tools.ts) 为准。

------

## Model 与 reasoning effort

Bridge 不接管 Codex 的模型状态。

### 普通 continuation

如果 `codex_turn` 没有显式传入 `model` 或 `effort`：

- Bridge 不调用 `model/list`；
- 不推断当前模型；
- 不发送新的 model / effort override；
- 原生 Codex thread 自己继续保持已有状态。

### 显式 model override

如果 supervisor 明确指定 `model`：

Bridge 会临时读取一份新的、包含 hidden models 的原生 `model/list` catalog 来验证该模型是否存在。

这个 catalog：

- 只用于当前请求；
- 有分页和循环保护；
- 不持久化；
- 不形成模型 registry 或 cache。

### `model + effort`

如果同时指定模型和 reasoning effort：

Bridge 只在原生 catalog **明确证明不兼容**时本地拒绝。

如果 upstream 没有提供足够的 compatibility metadata，Bridge 不自行猜测，而把最终决定留给 native Codex。

### effort-only

如果只提供 `effort`：

Bridge 不尝试推断当前 thread 正在使用哪个模型。

它只会拒绝一个在当前 catalog 所有已公布 reasoning-effort token 中都不存在的值；这个 effort 对当前真实模型是否可用，仍由 app-server 决定。

`thread/read` 也不会被 Bridge 当作 current-model registry 的来源。

------

## 监督一个 turn

`codex_turn` 的成功返回只表示 native `turn/start` 已被接受。

长任务通常应继续通过 `codex_observe` 监督，而不是把“请求已接受”误认为“任务已经完成”。

一个典型流程是：

```text
codex_turn
    ↓
codex_observe
    ↓
 ┌───────────────┬────────────────┬─────────────────┐
 │ continue      │ steer          │ respond         │
 │ observing     │ same turn      │ real pending    │
 │               │                │ request         │
 └───────────────┴────────────────┴─────────────────┘
    ↓
terminal state / acceptance
```

普通观察省略 cursor，即使用内置 auto 协议；不必回填 codex_turn 的 event_cursor。supervisor 只需判断新的证据、审批和验收。

几个重要原则：

- 长时间没有新命令输出，不足以证明 Codex 卡住；
- steer 应代表新的语义信息或纠正，而不是定时催促；
- respond 只能回答真实存在的 pending request；
- interrupt 只在确实需要停止当前 turn 时使用；
- `thread_id` 是 native Codex thread identity，不是 Bridge 发明的永久 task ID。

------

## UNKNOWN：不要直接重试 mutating request

以下原生请求如果已经成功写入 app-server，但等待 acknowledgement 超时：

- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/steer`
- `turn/interrupt`

Bridge 会把结果视为：

**UNKNOWN / possibly accepted**

这不等于失败。

请求可能已经被 native Codex 接受，只是 acknowledgement 没有及时返回。

因此 supervisor 应：

1. 先 `codex_observe` 或读取 native state；
2. 判断原操作是否已经发生；
3. 再决定是否需要后续动作。

**不要因为 timeout 直接重发 mutating request。**

Bridge 不自动替 supervisor 做这种 retry。

------

## Elicitation 目前不受支持

`mcpServer/elicitation/request` 当前没有进入 Bridge 的 supported response surface。

如果 native Codex 发出这类 request：

- Bridge 会保留并暴露它；
- 不会静默吞掉；
- 不会猜测 response schema；
- 不会通过 `codex_respond` 随便构造答案。

只有未来存在明确、稳定并经过验证的上游 contract 时，才值得考虑支持。

------

## 快速开始

### 环境要求

- Windows 或 macOS
- Node.js 24+
- 官方 Codex executable
  - 可以直接通过 `codex` 找到；
  - 或使用 `CODEX_EXE` 显式指定。

本项目不捆绑、也不依赖 `@openai/codex` npm package。

### Clone、构建与测试

```powershell
git clone https://github.com/zoeynine/Local-Codex-Bridge.git
cd Local-Codex-Bridge
npm ci
npm run typecheck
npm run build
npm test
```

直接启动：

```powershell
$env:CODEX_EXE = 'C:\path\to\codex.exe' # codex 已在 PATH 时可省略
npm start
```

### 配置 MCP client

严格的 MCP stdio client 应直接启动构建后的 Node entry：

```text
command: node
args:    C:\absolute\path\to\Local-Codex-Bridge\dist\src\index.js
env:     CODEX_EXE=C:\path\to\codex.exe   # optional
```

macOS 使用同一个构建入口，只需把 `args` 换成 `dist/src/index.js` 的绝对 POSIX path。

不同 MCP client 的配置格式可能不同，但最终应直接运行：

```text
node <repository>/dist/src/index.js
```

不要在 Secure MCP Tunnel 或其他严格 JSON-RPC stdio transport 后使用 `npm start`，因为 npm lifecycle output 可能污染 stdout 协议流。

当 Bridge 的 MCP tool set 发生变化后，已经连接的 MCP client 通常需要重新连接或重启，才能刷新自己的 tool catalog。

------

## 可选：Secure MCP Tunnel

远程 MCP 场景可以在 Bridge 前面使用 Secure MCP Tunnel：

```text
remote MCP client
        ↕
Secure MCP Tunnel
        ↕
node <repository>/dist/src/index.js
        ↕
native Codex
```

Tunnel 的认证、profile、port、ready endpoint 和进程生命周期属于外部配置。

本仓库：

- 不创建 Tunnel profile；
- 不保存生产凭据；
- 不内置生产端口；
- 不把 Tunnel control plane 变成 Bridge 自己的 HTTP API。

------

## Windows

### Optional Tray

`windows/` 中的 Tray 是已安装 Tunnel client 的轻量启动与状态层，不是 Bridge 核心运行时的必需组件。

Canonical launcher 名为 `LocalCodexBridgeTray.*`。

调试启动示例：

```powershell
.\windows\LocalCodexBridgeTray.Debug.cmd `
  -ReadyUrl 'http://127.0.0.1:<port>/readyz' `
  -ProfileName 'your-profile' `
  -TunnelExecutable 'C:\path\to\tunnel-client.exe'
```

Local settings 模板：

[`windows/local-settings.example.json`](windows/local-settings.example.json)

实际的：

```text
windows/local-settings.json
```

保持 ignored，不进入 Git。

配置优先级：

1. 显式命令行参数；
2. `LOCAL_CODEX_BRIDGE_*` 环境变量；
3. legacy `LUMEN_CODEX_V2_*` 环境变量；
4. ignored local settings。

旧的 `LumenCodexControlV2Tray.*` launcher 和 legacy env names 目前只作为兼容入口保留，不代表第二套产品。

Tray 不自动重启 Tunnel，并且只会在 process identity、profile、PID 等信息重新核验一致后，停止由当前 Tray 实例启动的进程。

------

## macOS

`Start Mac Codex Bridge.app`、`launcher/` 与 `bin/start-production-tunnel` 提供 macOS Finder / Tunnel 平台集成。

它们只是平台外层；真正的 Bridge 仍然运行同一个：

```text
dist/src/index.js
```

修改 launcher 或 Finder bundle 后，应在 macOS 12+ 上重新构建并验证：

```bash
launcher/build-launcher.sh
npm run test:macos
```

Windows 与 macOS 是同一 Bridge 的两个平台入口，而不是两套独立实现。

------

## 安全与信任边界

Local Codex Bridge **不会创建新的操作系统 sandbox**。

真正的文件、命令、网络与进程能力仍由 native Codex 的配置，以及每个 turn 的：

- `sandbox`
- `approval_policy`

决定。

例如：

- `danger-full-access` 会扩大 sandbox 允许的文件、命令和进程访问范围；
- `approval_policy=never` 不会自行扩大 OS sandbox，但会移除交互式审批这一确认层。

两者是不同的风险维度。

还需要注意：

- `codex_turn` / `codex_steer` 的自然语言指令可能促使 Codex 使用它已有的文件和命令能力；
- “Bridge 没有暴露一个 generic shell MCP tool”并不意味着 native Codex 不会执行命令；
- `codex_threads` 可以看到同一 OS user / Codex runtime 可见的持久线程，筛选条件不能充当访问隔离；
- Bridge 启动 app-server 时会继承自己的环境，但会移除 Tunnel 使用的 `CONTROL_PLANE_API_KEY`；
- 其他环境变量仍属于可信启动边界，不应放入不必要的 secrets；
- 实时事件和 pending request 会受到数量与内容 sanitization 限制，但 Bridge 不是 hostile multi-tenant gateway；
- checkpoint 应保持短小，不保存完整 prompt、transcript、原始事件、命令输出或最终回答。

远程使用时，应由经过认证并正确配置的 Tunnel 提供连接边界。

------

## 持久化

原生 Codex 负责持久化：

- threads；
- turns；
- conversation history；
- native execution results。

Bridge 的：

- live event ring；
- active-turn runtime state；
- pending requests

主要存在于内存中。

Bridge 重启后，默认 auto 会要求 re-anchor 并明确 live state 无法重建；显式 manual cursor 的取证读取仍可回退到有限 native persisted history，不伪造丢失的 live state。

### Checkpoint

`codex_checkpoint` 是唯一刻意保存的 Bridge-side supervisory state，而且保持有界。

Windows 新安装默认：

```text
%LOCALAPPDATA%\LocalCodexBridge\checkpoints\<sha256(thread_id)>.json
```

macOS 默认：

```text
~/Library/Application Support/LocalCodexBridge/checkpoints/<sha256(thread_id)>.json
```

可以通过：

```text
LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR
```

覆盖。

legacy：

```text
LUMEN_CODEX_V2_CHECKPOINT_DIR
```

目前仍保留显式兼容。

Bridge 不自动迁移旧 checkpoint。

------

## Deliberate non-goals

Local Codex Bridge 当前刻意不做：

- browser UI；
- HTTP control plane / HTTP MCP server；
- 第二套 task queue 或 job database；
- transcript duplication；
- model cache；
- current-model registry；
- queued-message facade；
- automatic mutating-request retry；
- automatic app-server restart；
- generic shell / `command/exec` MCP surface。

以下 upstream 能力也没有因为“存在”就自动加入 Bridge：

- `command/exec`
- `thread/turns/list`
- `sourceKinds`
- elicitation response
- provider / `serviceTier` capability abstraction

它们只是未来可以重新评估的候选，不是 roadmap promise。

Bridge 的目标不是把所有 Codex app-server API 都搬进 MCP，而是只暴露监督真正需要的最小 surface。

------

## Upgrading Codex

Bridge 必然依赖少量 native app-server protocol assumptions。

这些依赖、当前验证状态、对应代码位置，以及 upstream 改变后需要重新检查的内容，都集中记录在：

[`PROTOCOL-ASSUMPTIONS.md`](PROTOCOL-ASSUMPTIONS.md)

升级 Codex runtime、修改 protocol-facing behavior，或者相关 regression test 开始失败时，应优先重新核对这份 checklist，而不是凭旧实现经验直接修改 Bridge。

------

## 开发与测试

常用检查：

```powershell
npm run typecheck
npm run build
npm test
```

`npm test` 会运行共享 runtime / app-server / MCP / checkpoint / platform / shutdown / UX projection 测试，并继续执行当前平台对应的集成测试。

真实 Codex smoke 与普通测试刻意分开：

```powershell
npm run smoke:live
```

它会实际调用 native Codex，并可能留下持久测试 thread；只有明确接受这些副作用时才运行。

主要实现位置：

- `src/mcp.ts` — MCP stdio / JSON-RPC boundary
- `src/app-server.ts` — native Codex app-server process / protocol adapter
- `src/tools.ts` — 10 tools、schema 与 supervisory semantics
- `src/runtime.ts` — bounded live runtime state / events / pending requests
- `src/checkpoint.ts` — optional supervisory checkpoint
- `src/platform.ts` — Windows / macOS platform boundary
- `src/version.ts` — canonical Bridge version
- `src/ux-projection.ts` — optional UX projection / compatibility
- `windows/` — optional Windows Tray
- `launcher/`, `bin/`, `Start Mac Codex Bridge.app` — optional macOS integration

------

## License

MIT License — see [`LICENSE`](LICENSE).

## 协作贡献者与致谢

协作贡献者：**小年（ChatGPT）**、**Codex**。

谢谢一起把“让外部 AI 真正监督 native Codex”从一个小想法，一点点压成了一层足够薄、边界足够清楚、也愿意公开给别人继续折腾的 Bridge。`(*╹▽╹*)`

以及谢谢**予安**，没有你我也不会试着去做些什么ღ( ´･ᴗ･` )

## 隔离开发增强（沿用 2.1.3 版本号，尚未发布）

本工作树增加以下功能；它不代表官方新版本，也不包含 Goal mode passthrough、第二套 agent/job runtime、重试队列或新的持久任务库。

### 运行身份与受控恢复

`bridge_status {}` 只读返回当前 Bridge 的编译版本常量、构建时嵌入的 SHA-256、实际 PID 和 process uptime。构建指纹来自 `npm run build` 对排序后的 `dist/src/*.js`（排除指纹模块本身）的哈希，带文件名和字节长度分隔；它不从启动目录的 Git HEAD、包文件或环境变量推断运行身份。直接 tsc/源码运行没有该指纹时返回 unavailable。哈希用于区分构建产物，不是签名或来源认证。

`codex_runtime { "action": "status" }` 不启动子进程。它返回 Bridge 管理的 app-server 的状态、可取得时的 PID、握手状态、live generation、active turn/pending request 数量与 `safe_to_restart`。未启动、已退出或无法取得 PID 时返回 null/unavailable；不扫描其他 Codex 实例，不返回请求内容、环境、登录信息或 Tunnel 设置。

`codex_runtime { "action": "restart" }` 只终止并重新启动当前 Bridge 管理的 app-server 子进程，然后重新执行 initialize/initialized。Bridge 和 Tunnel 都不重启。任何 active turn、pending approval/user-input（包括没有 turn_id 的请求）、正在执行的 RPC/写入/turn 启动事务、关闭或重启操作都会导致 `RESTART_DENIED`。已发送 mutation 超时且原子进程仍存活时，因 outcome UNKNOWN 也拒绝重启；这项保守锁定不会随 late-response retention 到期而自行解除。有效且作用域匹配的迟到原生回执可解除对应 UNKNOWN；没有这种证据时继续保守锁定，进程实际退出后才可显式恢复。

异常退出仍然锁定错误，后续普通调用不会自动重启；重启握手失败也不会重试。status 是瞬时快照，restart 会在实际执行时再次检查并同步取得排他门闩。工具 annotation 覆盖两种 action，所以 codex_runtime 整体标记为可能修改/破坏状态；status action 本身只读。

确认旧子进程退出后，Bridge 清除旧 live ring、pending、terminal 与 turn 映射并发布清零的 UX counts。generation 增加。旧线程在重新出现前，auto 明确要求 re-anchor；显式 manual 取证可走已有 degraded thread/read，其 cursor 不是有效 live cursor。重新出现的 live 线程使用高于上一 generation 的 cursor floor，旧 cursor 会报告丢失，不重放旧事件。checkpoint 与原生持久线程不变。重启后不能宣称旧 live state 已重建。

### 默认 auto：只传本次增量，异常时局部展开

普通监督只需调用：

```json
{"thread_id": "native-thread-id", "wait_ms": 10000}
```

`mode` 支持 `auto | supervision | raw`，默认为 auto。**GPT=supervisor，Bridge=transport/control/evidence，Codex=executor。** 降噪、自动 cursor 和异常证据选择由 Bridge 实现，安装后不需要另给 GPT 一套压缩日志提示词；Bridge 不生成计划、不调度新任务，也不代替 supervisor 判断验收。

| 调用方式 | cursor 与返回行为 |
| --- | --- |
| 省略 mode/cursor，或 mode=auto 且无 cursor | 每连接/线程自动消费；正常为 supervision；异常时附加相关局部 raw 证据 |
| mode=supervision 且无 cursor | 同一自动 cursor；强制低噪声，不附加自动 raw 扩展 |
| mode=raw 且无 cursor | 显式调试/取证；返回自动 cursor 之后的原始页 |
| 显式 cursor，mode 省略/auto/raw | 独立 manual raw 分页，保留原有 cursor/fallback/snapshot 语义；不改变自动 cursor |
| 显式 cursor，mode=supervision | 独立 manual 分页并过滤噪声；不改变自动 cursor |

自动状态限定于一个 MCP 连接，最多保留 128 个线程的消费元数据，不保存聊天或事件副本。结果成功写回 stdio 后才提交 cursor；取消或写入失败回滚消费。同连接/线程的并发自动 observe 会明确拒绝，避免两个调用重复消费；没有等待队列或重试循环。manual 调用可独立取证。连接结束清除自动状态，容量淘汰或 generation 改变会要求 re-anchor；不能猜出丢失的消费进度。

普通 events 只来自本次原始页，已消费事件不会在下一次自动调用重放。自动模式的 pending_requests 只返回新出现的请求，pending_request_count 保留当前数量；terminal 只在快照变化时返回，terminal_unchanged 明示已有但未变化。manual 读取继续返回原有完整当前 pending/terminal 快照。普通 auto/supervision 会省略 turn/completed 内嵌 items 和 terminal.turn 的整段 turn payload；同一 final 文本只发送一次，不重复携带已交付日志，显式 raw 仍保留取证数据。自动 pending 元数据最多 128 条；超限明确标记并要求 re-anchor/手动取证。

supervision 精确抑制 `item/agentMessage/delta` 和 `thread/tokenUsage/updated` 通知，保留 command start/output/completion、file change、approval/user-input、warning/error、turn status、完整 agent item 和 terminal；server requests 不会作为通知过滤。limit 仍限制原始消费页。`next_cursor` 是原始页消费末尾，`current_cursor`、`cursor_floor`、`cursor_lost`、`has_more` 不因过滤而改变。空 events 也可能有真实 cursor 推进；自动模式由 Bridge 保存，manual 调用应保存返回的 next_cursor。`suppressed_events` 只统计本页被抑制的事件，不对已经丢失的 ring 内容编造计数。

每次返回固定 `delta_summary` 六字段，空值为数组 []，每字段最多 8 条：

- changes：原生 file/turn/status 的变化证据；
- commands：本次命令开始、输出、完成的标识与短摘录；
- validation：有明确 exitCode 时的 reported_command_exit；不推断“所有测试通过”或“任务验收完成”；
- pending：新 pending 或 no_longer_pending；消失不等于被批准；
- unresolved：本次新增异常代码/原生 warning/error；
- next：基于真实状态的 inspect_pending_requests、inspect_local_evidence、observe_remaining_delta 或 re_anchor 提示；不会自行执行这些动作。

auto 的局部扩展触发包括 cursor_lost、mutation outcome UNKNOWN、app-server unexpected exit/unavailable、restart failure、native/MCP JSON-RPC/protocol error、unknown pending request/state、turn/terminal 矛盾，以及非零 command exit 且输出缺失或超过短摘要预算。缺少有效迟到回执的 UNKNOWN 和仍不可用的子进程不会因“提示已读”而被推断为恢复。准确匹配的有效原生回执可解除对应 UNKNOWN；TTL 到期、缺字段或作用域不匹配不能解除。

`diagnostics` 最多附加 6 条相关本线程 recent raw 摘录（序列化正文预算 6000 字符）、4 条 runtime 诊断元数据及 4 条连接错误响应。命令失败只展开相关命令；无从关联线程的协议错误只附加原错误响应，不重放无关线程历史。重复的持续异常不会重复附加旧 raw 内容。原始诊断摘录保留真实 cursor 并标明不推进主事件 cursor。进程/连接诊断 ring 各最多 32 条，全部为本地有界临时证据。

异常消失或一次性协议错误已交付后，后续 auto 回到 supervision。低噪声模式不代表 task 成功，也不代表 supervisor 已恢复理解。cursor_lost、generation 变化、Bridge 重启后的 live unreconstructable 等返回 `reanchor.required`；应读取 checkpoint（若使用）和 native thread 重新锚定意图、硬约束与证据。自动 fallback 不拉取/重放 persisted history；它明确返回 live_state_reconstructable:false，live cursor 字段为 null/unavailable，不把零伪装成恢复后的有效 cursor。只有显式 manual 调试/取证路径继续原有 degraded thread/read fallback。

checkpoint 仍是 Goal、硬约束、current state、validation/unresolved 摘要的可选持久快照：原始字段保存目标和约束，acceptance_status/current_understanding/next_step 保存精简验证与未决事项。Bridge 不会自动把 delta summary、完整聊天或 raw 日志写入 checkpoint，也不把 checkpoint 变成生命周期库。

### requested 与 native evidence

`codex_turn` 的原有 accepted/thread_id/turn_id/event_cursor/status 保留，新增 `context_verification`：

- requested 记录调用方的 cwd/project_alias/sandbox/approval_policy/model/effort；selected_cwd 是 Bridge 选定的目标（可能来自 alias 或继承的原生 thread.cwd），不是生效证明。
- native_thread_context.fields 仅投影这次 thread/start 或 thread/resume 的顶层 cwd/sandbox/approvalPolicy/model/reasoningEffort，逐字段附 source、verified、value 和 available/unknown；作用时点明确为 before_turn_start。
- effective.fields 的作用域为 accepted_turn。当前受支持的 turn/start 只返回 Turn，没有这些设置的权威回读，故返回 verified:false、value:null、source:null、status:unknown。请求已接受、catalog 支持某模型/effort 或历史中出现过某模型都不能替代这个证据。

显式 sandbox/approval 的既有 fail-closed 检查继续生效。没有建立 current-model registry/cache，也没有为省略 model/effort 的普通继续操作增加 model/list 或推测当前模型。

### allowed_roots 与 project_alias

使用已有 ignored `windows/local-settings.json` 的可选 `targeting` 对象；其他平台可用相同 JSON 结构。Bridge 只在启动时显式设置 `LOCAL_CODEX_BRIDGE_LOCAL_SETTINGS_FILE` 为该文件的绝对路径时读取，不搜索用户 home，不自动接入或修改 Tunnel profile。若通过外部 launcher 启动，须由其传递该变量；不需要改变 Tray 的进程身份与 no-auto-restart 行为。

```json
{
  "targeting": {
    "allowed_roots": ["C:\\Projects"],
    "project_aliases": {
      "demo": "C:\\Projects\\Demo"
    }
  }
}
```

这些是占位路径，应替换为目标机器的绝对路径。macOS 使用 /absolute/paths。路径不展开环境变量、~ 或 URL 编码。alias 区分大小写，仅映射 cwd 字符串，不能包含 sandbox、approval、model、effort 等设置。cwd 与 project_alias 同时传入无条件拒绝；未知 alias 拒绝。

未配置 allowed_roots 保留原有路径行为。显式空数组表示拒绝所有 turn 目标。配置后 fresh、resume 显式 cwd、alias 以及继承 cwd 均检查：继承时先 thread/read 读取目标并保留 resume/turn 的 cwd 省略语义；在 thread/start/resume 返回后还须验证顶层有效 cwd 存在、在范围内且与所选目标一致，再发送 turn/start。验证失败可能已创建/加载原生线程，但不会接着启动 turn，也不会自动重试。

Windows 采用原生绝对 drive-letter 路径规范化、大小写不敏感的目录边界比较、stat/realpath 与逐级 link 检查。拒绝原始 .. 分量、UNC/device、ADS、保留设备名、尾随点/空格等歧义路径、缺失/不可读/非目录路径及 symlink/junction（包括 root 自身或祖先）。即使 link 指回允许范围内，也保守拒绝。规范与磁盘真实路径都须匹配范围，并以目录 file identity 核对真实祖先（避免 Windows 可区分大小写目录中的同名路径混淆）；每次选择时重新检查。macOS 比较区分大小写。

**allowed_roots 是 Bridge 选择 cwd 的 targeting policy，不是 OS sandbox、ACL 或多租户隔离。** 它不撤销 native Codex 已有能力，不限制 thread visibility，也不能保证命令内部只访问这些目录。文件系统可在检查后变化；这不是持有文件句柄的强制访问控制。原生 sandbox/approval 与本机用户的权限仍是执行边界。
