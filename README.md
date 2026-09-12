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
  保存时服务端拦截（可带 `force: true` 越过）。
- **体积 / token 统计**：字符数、字节数、行数、估算 token（CJK ≈ 1 token/字符，
  其他 ≈ 1 token/4 字符）——即每次请求的固定成本。
- **活注册表诊断**：保存后立即经 `systemPrompt.assemble()` 探测实际渲染的
  `deployment:persona` 段，页面上显示 `✓ 已同步` / `✗ 未同步`（含段首 80 字符预览）。
- **热应用**：四面写入（见[架构](#架构)），cordis 将配置 diff 解析为活 fiber 重载
  ——新 persona 对下一次组装的请求生效，无需重启宿主。
- **重置 / 重新加载 / 放弃修改**：一键恢复默认（空 persona，段落渲染时消失）、
  丢弃本地草稿，或重新拉取服务端快照。

## 架构

双面插件（与 dsh-mcp-manage 同模式）：

- **宿主侧**（`lib/index.js`，exports `.`，inject `webServer` + `loader`）：提供
  `/api/dsh-persona-manage` 路由族（见 [HTTP API](#http-api)）。
- **浏览器侧**（`lib/client.js`，exports `./client`，由宿主以
  `/plugins/<id>/client.js` 下发，inject `slots`）：注册 `settings.section` 槽位
  （`id: persona-manage`，`order: 26`，label「Persona 提示词」），内嵌客户端 lint
  镜像实时标错。

### 保存时的四面写入（v0.1.1）

dsh-system-prompt **不注册 settings 命名空间**（persona 只存在于组装行 config），
因此 persona 需要同时落到四个面，缺一面就会出现"重启后丢失"或"会话拿不到"：

| 面 | 位置 | 作用 |
|---|---|---|
| 持久补丁层 | profile 自己的 `cordis.patch.yml`（由 `ctx.baseUrl` 解析） | **最后**合成层，覆盖 dsh-web-app 自带的 `system-prompt` persona 行；include watcher 热重载。清空时保留 `[]` 占位符——纯注释文档会解析为 null 并炸掉整个 profile 加载（`must be a top-level YAML array`） |
| 会话层 | `~/.dsh/.agent-presets/re-standard/agent.cordis.yml` 的 `- id: persona` 行 | standard 家族的会话渲染 preset 的 scoped persona（遮蔽部署默认值），**这才是实际到达模型的那份**。按行跨度整行替换，收敛 `''`、`|`/`|-` 块、手工改坏的历史形状；每会话创建时重查，改完新会话即生效。preset 不存在时仅告警 |
| 活树 | `loader` entry `entry.update({ config })` | cordis 将配置 diff 解析为活 fiber 重载；探测发现活注册表未同步时（重启被否决 / 竞态）强制 `entry.fiber.update(config, false)` 兜底 |
| store + enforce | `$DSH_HOME/persona-manage/persona.json`（`$DSH_HOME` 未设则 `~/.dsh`） | loader-tree 变更是运行时态（用户补丁 HMR 重载会重置行），故在 `loader/entry-init` / `loader/config-update` 事件上幂等重施加（对比活值，已一致则零副作用） |

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
| `PUT` | `/` | 保存 `{ persona: string, force?: boolean }`。校验：body ≤ 256 KiB（超出 413）、拒绝 `</script>`（400）、lint 阻断（422，`force: true` 越过）；通过后持久化 + 四面应用 |
| `POST` | `/reset` | 清空 persona（恢复合成默认），同样四面应用 |

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
- `re-standard` preset 不存在时仅告警（`preset "re-standard" composition not
  found`），standard 家族会话保留各自的 persona，其他三面照常写入。

## English

Persona prompt management plugin for the DSH (DeepSeek Harness) web GUI: edit the
deployment-level system prompt directly on the **Settings → Persona 提示词**
("Persona Prompt") page — saved changes hot-apply, no host restart.

- Version `0.1.1` · MIT · Node `^22.19.0 || >=24.0.0` · peer `react ^18.2.0`

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
  pass `force: true`.
- **Size / token stats**: characters, bytes, lines, estimated tokens (CJK ≈
  1 token/char, other ≈ 1 token/4 chars) — the fixed cost paid on every request.
- **Live-registry diagnostics**: after each save the host probes the actually
  rendered `deployment:persona` section via `systemPrompt.assemble()` and the
  page shows synced / out-of-sync state with an 80-char preview.
- **Hot apply**: a four-surface write (see [Architecture](#architecture));
  cordis reconciles the config diff into a live fiber reload, so the next
  assembled request already uses the new persona.
- **Reset / reload / discard**: restore the default (empty persona — the
  section disappears at render time), drop the local draft, or re-fetch the
  server snapshot.

### Architecture

Dual-face plugin (same pattern as dsh-mcp-manage):

- **Host side** (`lib/index.js`, exports `.`, injects `webServer` + `loader`):
  serves the `/api/dsh-persona-manage` route family (see [HTTP API](#http-api-1)).
- **Browser side** (`lib/client.js`, exports `./client`, served by the host at
  `/plugins/<id>/client.js`, injects `slots`): registers a `settings.section`
  slot (`id: persona-manage`, `order: 26`), with a client-side lint mirror.

dsh-system-prompt does **not** register a settings namespace — the persona only
exists in the composition row's config — so a save writes four surfaces at once:

| Surface | Location | Role |
|---|---|---|
| Durable patch layer | the profile's own `cordis.patch.yml` (resolved from `ctx.baseUrl`) | The **last** composition layer, overriding dsh-web-app's own `system-prompt` persona row; hot-reloaded by the include watcher. When cleared, the `[]` placeholder is preserved — a comments-only document parses as null and fails the whole profile load |
| Session layer | the `- id: persona` row of `~/.dsh/.agent-presets/re-standard/agent.cordis.yml` | Sessions on the `standard` family render the preset's scoped persona, which shadows the deployment default — **this is the text that actually reaches the model**. Rewritten as a whole line-span so every historical shape converges; re-checked per session creation. Absent preset ⇒ warning only |
| Live tree | the loader entry via `entry.update({ config })` | cordis reconciles into a live fiber reload; if the probe shows the registry did not pick the change up, `entry.fiber.update(config, false)` forces it |
| Store + enforce | `$DSH_HOME/persona-manage/persona.json` (`~/.dsh` when `$DSH_HOME` is unset) | Loader-tree mutations are runtime-only (a user-patch HMR reload resets rows), so the persona is idempotently re-enforced on `loader/entry-init` and `loader/config-update` |

### HTTP API

Prefix `/api/dsh-persona-manage`; every response is an `{ ok, … }` JSON envelope.

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Snapshot: live persona + lint findings + stats + live diagnostics |
| `PUT` | `/` | Save `{ persona: string, force?: boolean }`. Validates: ≤ 256 KiB (413), rejects `</script>` (400), lint blocking (422, bypass with `force: true`); then persists and applies to all four surfaces |
| `POST` | `/reset` | Clear the persona (restore the composition default), same four-surface apply |

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
- A missing `re-standard` preset only warns; sessions on the standard preset
  keep their own persona while the other three surfaces are written as usual.

## License

[MIT](LICENSE) © null119
