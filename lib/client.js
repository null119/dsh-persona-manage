window.__ModuleLoader__.load({
	id: "dsh-persona-manage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region client/index.js
		/**
		* Persona management client plugin — registers the settings page
		* (设置 → Persona 提示词) into `settings.section`. The page talks to the
		* host route family under /api/dsh-persona-manage served by the node half.
		*/
		const ROUTE_PREFIX = '/api/dsh-persona-manage'
		const STOCK_VARIABLES = ['model', 'cwd']

		/** Client-side mirror of the host lint: flag strict-template hazards live. */
		function lintPersona(text) {
			const findings = []
			for (let open = text.indexOf('{{'); open !== -1; ) {
				const close = text.indexOf('}}', open + 2)
				if (close === -1) break
				const name = text.slice(open + 2, close)
				if (name.length === 0) {
					findings.push({ kind: 'error', message: '空变量组 {{}} —— 未知引用，渲染时会抛错' })
				} else if (name.includes('{') || name.includes('}')) {
					findings.push({ kind: 'error', message: `畸形变量组 {{${name}}} —— 渲染时会抛错` })
				} else if (!STOCK_VARIABLES.includes(name)) {
					findings.push({ kind: 'error', message: `未知变量 {{${name}}} —— 内置变量只有 ${STOCK_VARIABLES.join('、')}；如需字面量请改写` })
				} else {
					findings.push({ kind: 'info', message: `变量 {{${name}}} 渲染时替换为实际值` })
				}
				open = text.indexOf('{{', close + 2)
			}
			return findings
		}

	async function request(method, path, body) {
		const response = await fetch(`${ROUTE_PREFIX}${path}`, {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		let parsed
		try {
			parsed = await response.json()
		} catch {
			throw new Error(`HTTP ${String(response.status)}`)
		}
		if (!parsed.ok) throw new Error(typeof parsed.error === 'string' ? parsed.error : `HTTP ${String(response.status)}`)
		return parsed
	}

	/**
	* Neutral, user-readable wording for one live-registry sample. Anything the
	* host marked converged is a definitive ✓; anything else is a fiber-restart
	* window state ("applying"), never an alarm — the host already re-sampled
	* through the window, and the client auto-rechecks what remains.
	*/
	function liveStatusText(live) {
		if (live === undefined) return ''
		if (live.converged === true) return '✓ 已生效：当前会话请求实际渲染的 persona 与保存内容一致'
		if (live.serviceAvailable === false) return '正在应用中：宿主插件热重启窗口（提示词服务瞬时不可见），通常数秒内自行恢复'
		if (live.sectionFound === false) {
			return live.error !== undefined
				? `正在应用中：探测暂时出错（${live.error}），稍候自动复查`
				: '正在应用中：提示词段重建窗口（persona 段瞬时缺席），通常数秒内自行恢复'
		}
		return `正在应用中：活注册表仍渲染上一版内容（段首 80 字符：${live.preview !== undefined ? JSON.stringify(live.preview) : '(空)'}），等待配置重组装收敛，稍候自动复查`
	}

		const CSS = `
		.pmn-page { display: flex; flex-direction: column; gap: 16px; width: min(100%, 820px); color: var(--dsw-alias-label-primary); }
		.pmn-section { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; background: var(--dsw-alias-bg-layer-1); }
		.pmn-section-head { margin: 0; font-size: 14px; font-weight: 600; }
		.pmn-desc { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
		.pmn-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.pmn-btn { height: 32px; padding: 0 16px; border: none; border-radius: 16px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground, #fff); cursor: pointer; font-size: 13px; }
		.pmn-btn:not(:disabled):hover { opacity: 0.9; }
		.pmn-btn:disabled { opacity: 0.5; cursor: default; }
		.pmn-btn-ghost { height: 30px; padding: 0 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 15px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 13px; }
		.pmn-btn-ghost:not(:disabled):hover { background: var(--dsw-alias-bg-layer-2); }
		.pmn-btn-ghost:disabled { opacity: 0.5; cursor: default; }
		.pmn-btn-danger { color: var(--dsw-alias-state-error-primary); }
		.pmn-err { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
		.pmn-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
		.pmn-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
		.pmn-loading { font-size: 13px; color: var(--dsw-alias-label-secondary); }
		.pmn-editor { width: 100%; min-height: 340px; resize: vertical; box-sizing: border-box; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 18px; tab-size: 2; }
		.pmn-editor:focus { outline: 1px solid var(--dsw-alias-brand-primary); }
		.pmn-findings { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
		.pmn-finding { font-size: 12px; line-height: 18px; }
		.pmn-finding-error { color: var(--dsw-alias-state-error-primary); }
		.pmn-finding-info { color: var(--dsw-alias-label-secondary); }
		.pmn-stats { display: flex; gap: 16px; flex-wrap: wrap; margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
		.pmn-ver { margin-left: 8px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
		`

	function PersonaSection(_props) {
		const [status, setStatus] = react.useState('loading')
		const [error, setError] = react.useState('')
		const [notice, setNotice] = react.useState('')
		const [draft, setDraft] = react.useState('')
		const [saved, setSaved] = react.useState('')
		const [busy, setBusy] = react.useState(false)
		const [liveInfo, setLiveInfo] = react.useState(undefined)
		const [version, setVersion] = react.useState('')
		// Token guarding the auto-recheck loop: a newer save/recheck supersedes
		// the running one so stale polls never overwrite fresh state.
		const recheckToken = react.useRef(0)

		/**
		* Re-poll the live registry a few times until the host reports converged.
		* The host already re-samples through the fiber-restart window; this
		* catches the stragglers (slow recomposition) without user action.
		*/
		const runLiveRecheck = react.useCallback(async (okText) => {
			const token = recheckToken.current + 1
			recheckToken.current = token
			for (const delay of [700, 1600, 3000]) {
				await new Promise((wake) => setTimeout(wake, delay))
				if (recheckToken.current !== token) return
				try {
					const parsed = await request('GET', '/')
					if (recheckToken.current !== token) return
					if (parsed.available) setLiveInfo(parsed.live)
					if (parsed.live !== undefined && parsed.live.converged === true) {
						setNotice(okText ?? '已生效——新会话即用此 persona')
						return
					}
				} catch { /* keep polling */ }
			}
			if (recheckToken.current === token) setNotice('已保存 ✓（写入成功）；活注册表较久未确认收敛——可刷新页面复查，通常不影响新会话拿到新 persona')
		}, [])

		react.useEffect(() => {
			request('GET', '/').then((parsed) => {
				if (!parsed.available) {
					setStatus('unavailable')
					return
				}
				setVersion(typeof parsed.version === 'string' ? parsed.version : '')
				setDraft(parsed.persona)
				setSaved(parsed.persona)
				setLiveInfo(parsed.live)
				setStatus('ready')
				if (parsed.live !== undefined && parsed.live.converged !== true) void runLiveRecheck('✓ 已生效：渲染文本与保存内容一致')
			}).catch((err) => {
				setError(String(err.message ?? err))
				setStatus('error')
			})
		}, [runLiveRecheck])

			const findings = react.useMemo(() => lintPersona(draft), [draft])
			const errorCount = findings.filter((f) => f.kind === 'error').length
			const dirty = draft !== saved
			// Empty content is a valid save target — it means "save the
			// default": the host converges to the composition default (same
			// as 重置为默认) and answers with a savedDefault marker.
			const empty = draft.trim().length === 0

		const save = react.useCallback(async (force) => {
			setBusy(true)
			setNotice('')
			setError('')
			try {
				const parsed = await request('PUT', '/', { persona: draft, force: force === true })
				if (parsed.savedDefault === true) {
					// Empty save / reset → the factory persona renders now
					// (runtime section, instantly effective); show it.
					setDraft(typeof parsed.persona === 'string' ? parsed.persona : '')
					setSaved(typeof parsed.persona === 'string' ? parsed.persona : '')
					setLiveInfo(parsed.live)
					if (parsed.live !== undefined && parsed.live.converged === true) {
						setNotice('已保存为默认 ✓——出厂 persona 已生效（新会话生效）')
					} else {
						setNotice('已保存为默认 ✓——正在应用，稍候自动复查…')
						void runLiveRecheck('已保存为默认 ✓——出厂 persona 已生效')
					}
					return
				}
				setDraft(parsed.persona)
				setSaved(parsed.persona)
				setLiveInfo(parsed.live)
				if (parsed.live !== undefined && parsed.live.converged === true) {
					setNotice(`已保存并生效 ✓（${String(parsed.stats.bytes)} 字节，约 ${String(parsed.stats.estimatedTokens)} token）——新会话即用新 persona`)
				} else {
					setNotice('已保存 ✓（写入成功）——正在热应用到宿主，稍候自动复查…')
					void runLiveRecheck()
				}
			} catch (err) {
				setError(String(err.message ?? err))
			} finally {
				setBusy(false)
			}
		}, [draft, runLiveRecheck])

		const reset = react.useCallback(async () => {
			setBusy(true)
			setNotice('')
			setError('')
			try {
				const parsed = await request('POST', '/reset')
				setDraft(typeof parsed.persona === 'string' ? parsed.persona : '')
				setSaved(typeof parsed.persona === 'string' ? parsed.persona : '')
				setLiveInfo(parsed.live)
				if (parsed.live !== undefined && parsed.live.converged === true) {
					setNotice('已重置 ✓——出厂默认 persona 已生效（新会话生效）')
				} else {
					setNotice('已重置 ✓——正在应用，稍候自动复查…')
					void runLiveRecheck('已重置 ✓——出厂默认 persona 已生效')
				}
			} catch (err) {
				setError(String(err.message ?? err))
			} finally {
				setBusy(false)
			}
		}, [runLiveRecheck])

			const reload = react.useCallback(async () => {
				setBusy(true)
				setNotice('')
				setError('')
				try {
					const parsed = await request('GET', '/')
					setDraft(parsed.persona)
					setSaved(parsed.persona)
					setNotice('已重新加载')
				} catch (err) {
					setError(String(err.message ?? err))
				} finally {
					setBusy(false)
				}
			}, [])

			if (status === 'loading') return react.createElement('div', { className: 'pmn-loading' }, '加载中…')
			if (status === 'error') return react.createElement('div', { className: 'pmn-err' }, `读取失败：${error}`)
			if (status === 'unavailable') {
				return react.createElement('div', { className: 'pmn-page' },
					react.createElement('div', { className: 'pmn-section' },
						react.createElement('h3', { className: 'pmn-section-head' }, 'Persona 提示词'),
						react.createElement('p', { className: 'pmn-desc' }, 'system-prompt 设置命名空间不可用：宿主未加载 system-prompt 插件。'))
				)
			}

			const lines = draft.length === 0 ? 0 : draft.split('\n').length
			let cjk = 0, other = 0
			for (const ch of draft) (ch.codePointAt(0) > 0x2e7f ? cjk++ : other++)
			const tokens = cjk + Math.ceil(other / 4)

			return react.createElement('div', { className: 'pmn-page' },
				react.createElement('div', { className: 'pmn-section' },
					react.createElement('h3', { className: 'pmn-section-head' },
						'Persona 提示词（部署级系统提示词）',
						version !== '' ? react.createElement('span', { className: 'pmn-ver' }, `v${version}`) : null),
					react.createElement('p', { className: 'pmn-desc' },
						'此文本渲染为系统提示词 order 0 的 deployment:persona 段，紧跟 harness 身份之后、所有工具引导之前，对每个会话生效。保存即持久化并热应用（无需重启宿主）；内容为空时保存即恢复默认 persona。'),
					react.createElement('p', { className: 'pmn-desc' },
						'注意：文本是严格模板 —— 完整的 {{…}} 组会被解释为提示词变量（内置仅 ',
						react.createElement('code', null, '{{model}}'), ' / ', react.createElement('code', null, '{{cwd}}'),
						'），未知或畸形的组会让每次模型请求直接抛错。需要字面量花括号请写单花括号或加空格。')),
				react.createElement('div', { className: 'pmn-section' },
					react.createElement('textarea', {
						className: 'pmn-editor',
						value: draft,
						spellCheck: false,
						placeholder: '输入 persona 提示词…（清空后保存 = 恢复默认）',
						onChange: (event) => setDraft(event.target.value),
					}),
					findings.length > 0 ? react.createElement('ul', { className: 'pmn-findings' },
						findings.slice(0, 20).map((finding, index) => react.createElement('li', {
							key: index,
							className: `pmn-finding pmn-finding-${finding.kind}`,
						}, (finding.kind === 'error' ? '⚠ ' : 'ℹ ') + finding.message)),
						findings.length > 20 ? react.createElement('li', { className: 'pmn-finding pmn-finding-info', key: 'more' }, `…另有 ${String(findings.length - 20)} 条`) : null,
					) : null,
					react.createElement('div', { className: 'pmn-stats' },
						react.createElement('span', null, `${String(draft.length)} 字符`),
						react.createElement('span', null, `${String(lines)} 行`),
						react.createElement('span', null, `≈ ${String(tokens)} token（每次请求固定成本）`),
						empty ? react.createElement('span', null, '内容为空：保存将恢复默认 persona（出厂文案）') : null,
						dirty && !empty ? react.createElement('span', { className: 'pmn-err' }, '● 未保存的修改') : null),
					react.createElement('div', { className: 'pmn-row' },
						react.createElement('button', {
							className: 'pmn-btn',
							disabled: busy || !dirty,
							onClick: () => { void save(false) },
						}, '保存'),
						errorCount > 0 ? react.createElement('button', {
							className: 'pmn-btn-ghost pmn-btn-danger',
							disabled: busy,
							title: '忽略 lint 错误强制保存（可能导致每次请求抛错）',
							onClick: () => { void save(true) },
						}, `强制保存（${String(errorCount)} 处错误）`) : null,
						react.createElement('button', {
							className: 'pmn-btn-ghost',
							disabled: busy,
							onClick: () => { setDraft(saved); setNotice(''); setError('') },
						}, '放弃修改'),
						react.createElement('button', {
							className: 'pmn-btn-ghost',
							disabled: busy,
							onClick: () => { void reload() },
						}, '重新加载'),
						react.createElement('button', {
							className: 'pmn-btn-ghost pmn-btn-danger',
							disabled: busy,
							onClick: () => { void reset() },
						}, '重置为默认'),
						notice !== '' ? react.createElement('span', { className: 'pmn-ok' }, notice) : null,
						error !== '' ? react.createElement('span', { className: 'pmn-err' }, error) : null),
				liveInfo !== undefined ? react.createElement('div', { className: 'pmn-meta' },
					`活注册表：${liveStatusText(liveInfo)}`) : null,
			))
		}

		/** Required services: the settings-slot registry. */
		const inject = ['slots']

		/**
		* Register the persona-management settings page.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement('style')
				style.dataset.plugin = 'dsh-persona-manage'
				style.textContent = CSS
				document.head.appendChild(style)
				return () => style.remove()
			}, 'persona-manage: styles')

			ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'persona-manage',
				order: 26,
				label: 'Persona 提示词',
			}, PersonaSection)), 'persona-manage: settings section')
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
