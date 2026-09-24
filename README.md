# dsh-persona-manage

**中文** ｜ [English](#english)

DSH（DeepSeek Harness）Web GUI 的 Persona 提示词管理插件：在 **设置 → Persona 提示词**
页面直接编辑部署级系统提示词，保存即热生效（无需重启宿主）。

- 版本：`0.1.1`（`package.json`）· 协议：MIT · Node `^22.19.0 || >=24.0.0` · peer `react ^18.2.0`

## 功能

- **编辑 deployment persona**：多行等宽编辑器，编辑 `system-prompt` 组装行的
  `persona` 配置（渲染为系统提示词 order 0 的 `deployment:persona` 段，紧跟 harness
  身份之后、所有工具引导之前，对每个会话生效）。
- **严格模板 lint**：persona 文本是严格 `{{…}}` 模板（内置变量仅 `{{model}}` /
  `{{cwd}}`）。空组 `{{}}`、含额外花括号的畸形组、未知变量名都会让 **每次模型请求
  直接抛错**（lone `{{` 后方无 `}}` 时按字面量放行）。编辑器实时标出全部风险组；
  保存时服务端拦截（可带 `force: true` 越过）。**空 / 纯空白内容保存 = 恢复默认
  persona**（与重置同一条收敛路径：清 store、剥托管层、出厂文案重新渲染，只写
  文件层、不触碰活树，空 store 事故链不会复发）。
- **体积 / token 统计**：字符数、字节数、行数、估算 token（CJK ≈ 1 token/字符，
  其他 ≈ 1 token/4 字符）——即每次请求的固定成本。
- **活注册表诊断（短重试 + 中性文案）**：保存后经 `systemPrompt.assemble()` 探测
  实际渲染的 `deployment:persona` 段。宿主在保存/重置后约 2 秒窗口内自动重采样
  （穿越 fiber 热重启窗口），响应带 `converged` 标记；客户端对未收敛样本自动复查
  3 次（0.7/1.6/3 秒退避）。诊断只分两种口吻：`✓ 已生效`，或"正在应用中……（热
  重启窗口，通常数秒内自行恢复）"——不再出现"服务不可见/未找到段"这类惊吓性
  瞬态表述；复查超时才提示刷新。
- **热应用（纯运行时）**：persona 由插件自有的全局 prompt section 渲染（见
  [架构](#架构)），保存只更新内存 holder——零 fiber 重启、零组合文件写入，
  每个会话（含当前已存在的）下一次组装的请求即用新文案。
- **重置 / 重新加载 / 放弃修改**：重置会移除托管覆盖（补丁块 + 预设行），让
  dsh-web-app 的出厂默认 persona 重新渲染（保存空内容与此等价）；此外可丢弃本地
  草稿，或重新拉取服务端快照。

## 架构

双面插件（与 dsh-mcp-manage 同模式）：

- **宿主侧**（`lib/index.js`，exports `.`，inject `webServer` + `loader`）：提供
  `/api/dsh-persona-manage` 路由族（见 [HTTP API](#http-api)）。
- **浏览器侧**（`lib/client.js`，exports `./client`，由宿主以
  `/plugins/<id>/client.js` 下发，inject `slots`）：注册 `settings.section` 槽位
  （`id: persona-manage`，`order: 26`，label「Persona 提示词」），内嵌客户端 lint
  镜像实时标错。

### 保存路径：运行时 section（v0.1.4）

persona 由本插件注册的**自有全局 prompt section**（`deployment:persona-manage`，与
`dsh-system-prompt` 自带的 `deployment:persona` 同序位）渲染，其 `text` 是读取可变
holder 的函数——**每次组装求值**。保存/重置只更新 holder 与 store，是纯运行时操作：
零 fiber 重启、零组合文件写入，**每个会话（含已存在的）下一次组装的请求即用新文案**。
这从结构上消除了"保存后当前会话输入框卡死"的问题（任何组合文件写入都会触发 loader
重组装波，而 Web 客户端不会为已挂载的会话视图重绑作用域服务，输入框因此 inert）。

| 面 | 位置 | 作用 |
|---|---|---|
| 运行时 section | `ctx.systemPrompt.section({ name: 'deployment:persona-manage', text: () => holder })` | persona 的唯一渲染面；全局层、同 `DEPLOYMENT_PERSONA` 序位，紧跟 harness 身份 |
| store | `$DSH_HOME/persona-manage/persona.json`（`$DSH_HOME` 未设则 `~/.dsh`） | 持久层；启动与每次 `loader/entry-init` / `loader/config-update` 事件上幂等重施加到 holder |
| 固定 pin | profile `cordis.patch.yml` 的托管块：`system-prompt: { persona: '' }` | 压制 dsh-web-app 出厂 persona 行，防止与我们的 section 重复渲染。**内容固定、永不移除**——首次创建（或从旧版文本块迁移）时写入一次，此后所有操作跳过写入（skip-if-unchanged） |
| 出厂捕获 | `$DSH_HOME/persona-manage/factory.json` | pin 创建前从组装行捕获一次出厂文案；重置/空保存 = section 运行时切回该文案（同样零写入） |
| 遗留清理 | `~/.dsh/.agent-presets/re-standard/agent.cordis.yml` 的 `- id: persona` 行 | 旧版写入的 scoped 遮蔽行，启动时一次性移除（其遮蔽语义与本方案冲突：空 `text: ''` 仍会遮蔽出厂文案） |

### lint 规则（`lintPersona`，宿主/客户端同源实现）

镜像 `renderPrompt` 的扫描器：从每个 `{{` 找其后最近的 `}}`——

| 输入 | 判定 |
|---|---|
| `{{}}` 空组 | error：渲染时抛错 |
| `{{…{…}}}` / `{{…}…}}`（组内含花括号） | error：畸形组，渲染时抛错 |
| `{{name}}` 且 `name ∉ {model, cwd}` | error：未知变量（除非其他插件注册了它） |
| `{{model}}` / `{{cwd}}` | info：渲染时替换为实际值 |
| `{{` 之后全文本再无 `}}` | 字面量放行 |

## HTTP API

前缀 `/api/dsh-persona-manage`，全部返回 `{ ok, … }` JSON 信封：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 快照：活 persona + lint findings + stats + live 诊断（serviceAvailable / sectionFound / matchesRow / preview） |
| `PUT` | `/` | 保存 `{ persona: string, force?: boolean }`。校验：body ≤ 256 KiB（超出 413）、拒绝 `</script>`（400）、lint 阻断（422，`force: true` 越过）；**空 / 纯空白内容不报错**——直接收敛为组合默认（响应带 `savedDefault: true`，编辑器据此显示"已保存为默认"） |
| `POST` | `/reset` | 移除托管覆盖（补丁块 + 预设行），恢复组合出厂默认（响应同样带 `savedDefault: true`）；只写文件层、不触碰活树（无 fiber 重启、无级联） |

未知子路径 404，方法不符 405，服务端异常 500（`{ ok: false, error }`）。

## 安装（web profile）

```powershell
# 1. profile 依赖（link 到本目录）
#    C:\Users\<you>\.dsh\profiles\web\package.json 的 dependencies 加：
#      "dsh-persona-manage": "link:H:/DSH/Plugin/dsh-persona-manage"
#    dsh.profile.bundles 数组加："dsh-persona-manage"
# 2. 安装并重启
cd $env:USERPROFILE\.dsh\profiles\web
pnpm install
# 重启 dsh web（dsh_web.bat），浏览器刷新
```

包内 `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch` 声明）会在 profile
roster 中插入插件行（`- insert: - id: persona-manage, name: dsh-persona-manage`），
宿主以 `/plugins/dsh-persona-manage/client.js` 下发浏览器侧脚本（`dsh.client`
声明自动注入 `@deepseek-ai/dsh-client-runtime` 与 `@deepseek-ai/dsh-client-ui-settings`）。

## 已知边界

- settings RPC 仅限 loopback 浏览器（远程浏览器页面显示 unavailable，与官方设置页一致）。
- 保存后对**新组装的请求 / 新会话**生效；已进行中的轮次不变。修改 persona 会使
  所有会话的 KV-cache 前缀从系统提示词第一个变化 token 起失效一次。
- lint 的已知变量表是内置集合（`model`/`cwd`）；若其他插件注册了更多提示词变量，
  相应组会被误报为"未知"，可用"强制保存"越过。
- `re-standard` preset 的遗留 `- id: persona` 行会在启动时被一次性移除（旧版语义，
  与运行时 section 方案冲突）；此后本插件不再写该文件。
- **卸载/禁用注意**：固定 pin（`system-prompt: { persona: '' }`）创建后常驻。卸载或
  长期禁用本插件时需手动删除 `cordis.patch.yml` 中 `# >>> dsh-persona-manage` 与
  `# <<<` 之间的托管块（否则组装行的 persona 保持为空，出厂文案不会回来）。

## English

Persona prompt management plugin for the DSH (DeepSeek Harness) web GUI: edit the
deployment-level system prompt directly on the **Settings → Persona 提示词**
("Persona Prompt") page — saved changes hot-apply, no host restart.

- Version `0.1.4` · MIT · Node `^22.19.0 || >=24.0.0` · peer `react ^18.2.0`

### Features

- **Edit the deployment persona**: a monospace multi-line editor for the
  `persona` config of the `system-prompt` composition row. It renders as the
  order-0 `deployment:persona` section of the system prompt — right after the
  harness identity, before all tool primers, in effect for every session.
- **Strict template lint**: the persona text is a strict `{{…}}` template; the
  only built-in variables are `{{model}}` and `{{cwd}}`. An empty group `{{}}`,
  a malformed group with stray braces, or an unknown name makes **every model
  request throw** (a lone `{{` with no later `}}` passes as a literal). The
  editor flags all risky groups live; the server blocks saving them unless you
  pass `force: true`. **An empty / whitespace-only save restores the
  composition default** — the same convergence path as reset (store cleared,
  managed layers dropped, factory persona renders again); it is file-level
  only and never touches the live tree, so the empty-store incident chain
  cannot recur.
- **Size / token stats**: characters, bytes, lines, estimated tokens (CJK ≈
  1 token/char, other ≈ 1 token/4 chars) — the fixed cost paid on every request.
- **Live-registry diagnostics (short retry + neutral wording)**: after each
  save the host probes the actually rendered `deployment:persona` section via
  `systemPrompt.assemble()`, re-sampling through the ~2 s settle
  window; the response carries a `converged` marker, and the client
  auto-rechecks unconverged samples three times (0.7/1.6/3 s backoff). The
  page speaks two tones only — `✓ active` or "applying (hot-restart window,
  usually settles within seconds)" — never the alarming transient states;
  a refresh hint appears only after the rechecks run out.
- **Hot apply (pure runtime)**: the persona renders through this plugin's own
  global prompt section (see [Architecture](#architecture)); saving updates
  an in-memory holder only — zero fiber restarts, zero composition-file
  writes, and the next assembled request of every session (existing ones
  included) already uses the new text.
- **Reset / reload / discard**: reset switches the section back to the
  captured factory persona at runtime (saving empty content is equivalent);
  also drop the local draft, or re-fetch the server snapshot.

### Architecture

Dual-face plugin (same pattern as dsh-mcp-manage):

- **Host side** (`lib/index.js`, exports `.`, injects `webServer` + `loader`):
  serves the `/api/dsh-persona-manage` route family (see [HTTP API](#http-api-1)).
- **Browser side** (`lib/client.js`, exports `./client`, served by the host at
  `/plugins/<id>/client.js`, injects `slots`): registers a `settings.section`
  slot (`id: persona-manage`, `order: 26`), with a client-side lint mirror.

The persona renders through this plugin's OWN global prompt section
(`deployment:persona-manage`, registered once at fiber start with a function
`text` reading a mutable holder — evaluated on EVERY assembly). Saves and
resets update only the holder and the store: pure runtime, no fiber restarts,
no composition-file writes. This structurally eliminates the wedged
active-session composer (any composition write recomposed the loader, and the
web client did not re-bind its session-scoped services for the mounted
conversation view, leaving the input bar inert).

| Surface | Location | Role |
|---|---|---|
| Runtime section | `ctx.systemPrompt.section({ name: 'deployment:persona-manage', text: () => holder })` | The sole rendering surface; global layer, same `DEPLOYMENT_PERSONA` order, right after the harness identity |
| Store | `$DSH_HOME/persona-manage/persona.json` (`~/.dsh` when `$DSH_HOME` is unset) | Persistence; re-applied to the holder at boot and on every `loader/entry-init` / `loader/config-update` |
| Fixed pin | the managed block in the profile's `cordis.patch.yml`: `system-prompt: { persona: '' }` | Suppresses dsh-web-app's factory persona row so it cannot double-render next to our section. **Fixed content, never removed** — written once at first creation (or migration from a legacy text block), then skipped on every operation (skip-if-unchanged) |
| Factory capture | `$DSH_HOME/persona-manage/factory.json` | The factory text, captured once from the row before pinning; reset / empty-save switches the section back to it at runtime (also zero writes) |
| Legacy cleanup | the `- id: persona` row of `~/.dsh/.agent-presets/re-standard/agent.cordis.yml` | The legacy scoped shadow row written by older versions is removed once at boot (its shadowing semantics conflict with this design: an empty `text: ''` still shadows the factory text) |

### HTTP API

Prefix `/api/dsh-persona-manage`; every response is an `{ ok, … }` JSON envelope.

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Snapshot: live persona + lint findings + stats + live diagnostics |
| `PUT` | `/` | Save `{ persona: string, force?: boolean }`. Validates: ≤ 256 KiB (413), rejects `</script>` (400), lint blocking (422, bypass with `force: true`); an **empty / whitespace-only body is not an error** — it converges to the composition default (response carries `savedDefault: true`, which the editor uses to show "saved as default") |
| `POST` | `/reset` | Drop the managed override (patch block + preset row) so the composition default renders again (response also carries `savedDefault: true`); file layers only — no live-tree touch, no fiber restart, no reload cascade |

Unknown subpath ⇒ 404; wrong method ⇒ 405; server error ⇒ 500 with
`{ ok: false, error }`.

### Installation (web profile)

```powershell
# 1. Profile dependency (link to this directory)
#    In C:\Users\<you>\.dsh\profiles\web\package.json add to dependencies:
#      "dsh-persona-manage": "link:H:/DSH/Plugin/dsh-persona-manage"
#    and add "dsh-persona-manage" to the dsh.profile.bundles array.
# 2. Install and restart
cd $env:USERPROFILE\.dsh\profiles\web
pnpm install
# Restart the DSH web host, then refresh the browser
```

The bundled `cordis.patch.yml` (declared via `dsh.bundle.patch` in
`package.json`) inserts the plugin row into the profile roster; the host serves
the browser half at `/plugins/dsh-persona-manage/client.js` with the declared
`@deepseek-ai/dsh-client-runtime` and `@deepseek-ai/dsh-client-ui-settings`
injections.

### Known limitations

- The settings RPC is loopback-only (remote browsers show "unavailable", same
  as the official settings page).
- Saves take effect for **newly assembled requests / new sessions**; in-flight
  turns are untouched. Changing the persona invalidates every session's
  KV-cache prefix from the first changed token of the system prompt.
- The lint's known-variable table is the built-in set (`model`/`cwd`); variables
  registered by other plugins are flagged as "unknown" — override with
  "force save".
- The legacy `- id: persona` row of the `re-standard` preset is removed once
  at boot (older-version semantics that conflict with the runtime-section
  design); the preset file is never written afterwards.
- **Uninstall/disable note**: the fixed pin (`system-prompt: { persona: '' }`)
  stays once created. Uninstalling or long-term disabling this plugin requires
  manually deleting the managed block between `# >>> dsh-persona-manage` and
  `# <<< dsh-persona-manage <<<` in `cordis.patch.yml` (otherwise the row
  keeps its pinned empty persona and the factory text does not come back).

## License

[MIT](LICENSE) © null119
