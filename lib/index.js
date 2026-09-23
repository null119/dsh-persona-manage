/**
 * dsh-persona-manage — host half: the persona management backend.
 *
 * The deployment persona lives in the `system-prompt` composition row's
 * config (dsh-system-prompt reads its config at fiber construction and does
 * NOT register a settings namespace), so the write path is the loader entry:
 *   loader.resolve('system-prompt') → entry.update({ config: {...persona} })
 * which cordis reconciles into a live fiber reload — new persona applies to
 * the next assembled request, no host restart.
 *
 * Loader-tree mutations are runtime-only (a user-patch HMR reload resets
 * rows), so the persona also persists in `$DSH_HOME/persona-manage/persona.json`
 * and is re-enforced at boot and on every loader/config-update — the same
 * store-plus-enforce pattern dsh-mcp-manage uses for composition overrides.
 *
 * Route family under /api/dsh-persona-manage:
 *   GET  /        → snapshot (live persona + lint warnings + stats)
 *   PUT  /        → validate + persist + apply { persona }; an empty (or
 *                   whitespace-only) body converges to the composition
 *                   default — the same state POST /reset produces
 *   POST /reset   → drop the managed override (patch block + preset row) so
 *                   the composition default renders again; never touches the
 *                   live tree, so no fiber restart, no reload cascade
 *
 * The persona text is a STRICT template: every complete `{{…}}` group
 * resolves against registered prompt variables (the agent loop registers
 * `model` and `cwd`); an unknown or malformed group makes renderPrompt THROW
 * on every assembly, so this backend lints before save.
 *
 * The browser half (./client) renders the 设置 → Persona 提示词 page.
 *
 * @module dsh-persona-manage
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve the harness home exactly like dsh-home-paths: $DSH_HOME over ~/.dsh. */
function resolveDshHome() {
	const fromEnv = process.env.DSH_HOME
	if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
	return join(homedir(), '.dsh')
}

/** Route prefix for this plugin's JSON operations. */
export const ROUTE_PREFIX = '/api/dsh-persona-manage'

/** Composition row id whose config carries the deployment persona. */
const SYSTEM_PROMPT_ENTRY = 'system-prompt'

/** Hard cap on the persisted persona text — far above any sane prompt. */
const MAX_PERSONA_BYTES = 256 * 1024

/** Variables the stock agent loop registers; anything else is plugin-provided. */
const STOCK_VARIABLES = ['model', 'cwd']

/** Loud failure when the loader entry face is missing. */
const ENTRY_UPDATE_FACE = 'loader entry update face unavailable'

export const inject = ['webServer', 'loader']

/** One JSON envelope response. */
function json(res, payload, status = 200) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(payload))
}

/** Read the request body (bounded) as UTF-8 text. */
function readBody(req, maxBytes = MAX_PERSONA_BYTES + 4096) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let total = 0
		req.on('data', (chunk) => {
			total += chunk.length
			if (total > maxBytes) {
				reject(new Error(`request body exceeds ${String(maxBytes)} bytes`))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}

/** Parse a JSON body or undefined on failure. */
async function parseJsonBody(req) {
	try {
		return JSON.parse(await readBody(req))
	} catch {
		return undefined
	}
}

/**
 * Lint one persona text against the strict `{{…}}` render rules, mirroring
 * renderPrompt's scanner: a `{{` whose next `}}` closes a complete group is
 * resolved (unknown name ⇒ render throws); `{{` with no later `}}` passes as
 * a literal. Returns ordered findings (kind + offset + message).
 */
export function lintPersona(text) {
	const findings = []
	for (let open = text.indexOf('{{'); open !== -1; ) {
		const close = text.indexOf('}}', open + 2)
		if (close === -1) {
			// Lone `{{` with no closing `}}` anywhere later: literal, passes.
			break
		}
		const name = text.slice(open + 2, close)
		if (name.length === 0) {
			findings.push({ kind: 'error', offset: open, message: '空变量组 {{}} —— 未知引用，渲染时会抛错' })
		} else if (name.includes('{') || name.includes('}')) {
			findings.push({ kind: 'error', offset: open, message: `畸形变量组 {{${name}}} —— 内容含额外花括号（如 {{{x}}}），渲染时会抛错` })
		} else if (!STOCK_VARIABLES.includes(name)) {
			findings.push({
				kind: 'error',
				offset: open,
				message: `未知变量 {{${name}}} —— 不是已注册变量（内置：${STOCK_VARIABLES.join('、')}），除非其他插件注册了它，否则每次请求都会抛错。如需字面量请写成单花括号或加空格`,
			})
		} else {
			findings.push({ kind: 'info', offset: open, message: `变量 {{${name}}} 将在渲染时替换为实际值` })
		}
		open = text.indexOf('{{', close + 2)
	}
	return findings
}

/** Rough token estimate: CJK ≈ 1 token/char, other text ≈ 1 token/4 chars. */
function estimateTokens(text) {
	let cjk = 0
	let other = 0
	for (const ch of text) (ch.codePointAt(0) > 0x2e7f ? cjk++ : other++)
	return cjk + Math.ceil(other / 4)
}

/** Stats block shared by read and write responses. */
function statsOf(text) {
	return {
		characters: text.length,
		bytes: Buffer.byteLength(text, 'utf8'),
		lines: text.length === 0 ? 0 : text.split('\n').length,
		estimatedTokens: estimateTokens(text),
	}
}

// ---- persisted store: $DSH_HOME/persona-manage/persona.json -----------------

function storePath() {
	return join(resolveDshHome(), 'persona-manage', 'persona.json')
}

/** Load the persisted persona ('' when absent or malformed). */
async function loadStore() {
	try {
		const parsed = JSON.parse(await readFile(storePath(), 'utf8'))
		return typeof parsed.persona === 'string' ? parsed.persona : ''
	} catch {
		return ''
	}
}

/** Persist the persona. */
async function saveStore(persona) {
	const path = storePath()
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify({ persona, updatedAt: new Date().toISOString() }, null, '\t')}\n`, 'utf8')
}

// ---- durable layer: the profile's own cordis.patch.yml ----------------------

const PATCH_BEGIN = '# >>> dsh-persona-manage (managed) >>>'
const PATCH_END = '# <<< dsh-persona-manage <<<'

/**
 * The profile patch file — the LAST layer of the composition (applied after
 * every bundle, including dsh-web-app's own `system-prompt` persona override)
 * and hot-reloaded by the include watcher. Resolved from the loader's
 * `baseUrl`, which app-boot pins to the profile directory.
 */
function profilePatchPath(ctx) {
	const base = ctx.baseUrl ?? ctx.loader?.ctx?.baseUrl
	if (typeof base !== 'string' || base.length === 0) throw new Error('cannot determine the profile directory (ctx.baseUrl unset)')
	return join(fileURLToPath(base), 'cordis.patch.yml')
}

/** Render the persona as an indented YAML block scalar body (tabs expanded). */
function blockScalarLines(persona) {
	return persona.replace(/\t/g, '  ').replace(/\n+$/, '').split('\n').map((line) => (line.length === 0 ? '' : `      ${line}`))
}

/** Build the managed patch region for one persona. */
function managedBlock(persona) {
	const lines = [PATCH_BEGIN, '- id: system-prompt', '  config:', '    persona: |-']
	for (const line of blockScalarLines(persona)) lines.push(line)
	lines.push(PATCH_END)
	return lines
}

/**
 * The empty-persona document: keep any other entries, and when none remain
 * keep (or restore) the `[]` placeholder — a comments-only document parses
 * as null and fails the whole profile load with "must be a top-level YAML
 * array", so the placeholder may never be stripped without a replacement.
 */
export function emptyPatchLayerText(stripped, hasOtherEntries) {
	if (hasOtherEntries) return stripped
	return stripped.some((line) => line.trim() === '[]') ? stripped : [...stripped, '[]']
}

/**
 * Rewrite the profile patch layer so the managed `system-prompt` row carries
 * the persona (or carries nothing, restoring the bundle default, when empty).
 * The include watcher hot-reloads the file into a recomposition where this
 * last layer overrides every earlier `persona` value.
 */
async function writePatchLayer(ctx, persona) {
	const path = profilePatchPath(ctx)
	let text
	try {
		text = await readFile(path, 'utf8')
	} catch {
		text = '[]\n'
	}
	// Strip any existing managed region, remembering what surrounded it.
	const lines = text.split('\n')
	const stripped = []
	let inBlock = false
	for (const line of lines) {
		if (line.trim() === PATCH_BEGIN) {
			inBlock = true
			continue
		}
		if (line.trim() === PATCH_END) {
			inBlock = false
			continue
		}
		if (!inBlock) stripped.push(line)
	}
	const hasOtherEntries = stripped.some((line) => line.trim() !== '[]' && line.trim() !== '' && !line.trim().startsWith('#'))
	if (persona.length === 0) {
		const next = emptyPatchLayerText(stripped, hasOtherEntries)
		const body = next.join('\n').replace(/\n{3,}$/, '\n')
		const out = body.endsWith('\n') || body.length === 0 ? body : `${body}\n`
		// Skip the rewrite (and the watcher reload it triggers) when the file
		// already carries no managed region.
		if (out !== text) await writeFile(path, out, 'utf8')
		return
	}
	const block = managedBlock(persona)
	if (hasOtherEntries) {
		// Append as one more array item after the existing entries.
		let insertAt = stripped.length
		while (insertAt > 0 && stripped[insertAt - 1].trim() === '') insertAt -= 1
		stripped.splice(insertAt, 0, ...block, '')
		const out = `${stripped.join('\n').trimEnd()}\n`
		if (out !== text) await writeFile(path, out, 'utf8')
	} else {
		// Replace the placeholder `[]` (or empty doc) with the block.
		const withoutMarker = stripped.filter((line) => line.trim() !== '[]')
		const out = `${withoutMarker.join('\n').trimEnd()}\n${block.join('\n')}\n`
		if (out !== text) await writeFile(path, out, 'utf8')
	}
}

// ---- session plane: the user preset whose persona row sessions render --------

/** The user preset this plugin manages (standard's twin with our persona). */
const PRESET_ID = 're-standard'

function presetCompositionPath() {
	return join(resolveDshHome(), '.agent-presets', PRESET_ID, 'agent.cordis.yml')
}

/**
 * Rewrite the preset's persona row as a line-span replacement: the entry runs
 * from its top-level `- id: persona` line through every indented or blank
 * line after it, so every prior shape — `''`, a `|`/`|-` block, or a
 * hand-mangled orphan body under `text: ''` — converges to one well-formed
 * row. The row always leaves the next entry on its own line and the file
 * ends with a newline.
 *
 * An EMPTY persona means "stop shadowing the composition default": the row is
 * REMOVED (writing `text: ''` would register an empty section that still
 * shadows, leaving sessions with no persona at all). With no row present an
 * empty persona is a no-op (text returned unchanged), and a non-empty persona
 * INSERTS the row above the first top-level entry.
 */
export function replacePresetPersona(text, persona) {
	const lines = text.split('\n')
	const start = lines.findIndex((line) => /^- id: persona\s*$/.test(line))
	if (start === -1) {
		if (persona.length === 0) return text
		const row = ['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', '    text: |-', ...blockScalarLines(persona)]
		const first = lines.findIndex((line) => /^- /.test(line))
		if (first === -1) {
			const body = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
			const out = [...body, '', ...row].join('\n')
			return out.endsWith('\n') ? out : `${out}\n`
		}
		lines.splice(first, 0, ...row, '')
		const out = lines.join('\n')
		return out.endsWith('\n') ? out : `${out}\n`
	}
	let end = start + 1
	while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end += 1
	if (persona.length === 0) {
		lines.splice(start, end - start)
		// Keep one blank line between whatever preceded the row and the next entry.
		if (start < lines.length && lines[start].trim() !== '' && (start === 0 || lines[start - 1].trim() !== '')) lines.splice(start, 0, '')
		const out = lines.join('\n')
		return out.endsWith('\n') ? out : `${out}\n`
	}
	const row = ['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', '    text: |-', ...blockScalarLines(persona)]
	lines.splice(start, end - start, ...row, ...(end < lines.length ? [''] : []))
	const out = lines.join('\n')
	return out.endsWith('\n') ? out : `${out}\n`
}

/**
 * Converge the managed preset's persona row to `persona`: present with the
 * text when non-empty, absent when empty (the deployment default then renders
 * for sessions instead of an empty shadow). Every session on the `standard`
 * family renders the PRESET's scoped persona (it shadows the deployment
 * default by design), so this file is what actually reaches the model; its
 * stamp is re-checked per session creation, so edits apply to new sessions
 * without a restart. Returns false when the preset is absent.
 */
async function writePresetPersona(persona) {
	const path = presetCompositionPath()
	let text
	try {
		text = await readFile(path, 'utf8')
	} catch {
		return false
	}
	const next = replacePresetPersona(text, persona)
	if (next !== text) await writeFile(path, next, 'utf8')
	return true
}

// ---- live tree application ---------------------------------------------------

/**
 * The entry tree that owns our row. Profile rows (system-prompt included)
 * compose inside the root include's SUBTREE, not the root loader store, so
 * resolution must run against our own tree — falling back to the root loader
 * covers non-profile compositions.
 */
function treeOf(ctx) {
	return ctx.fiber?.entry?.parent?.tree ?? ctx.loader
}

/** Resolve the system-prompt composition row, or undefined while absent. */
function resolveEntry(ctx) {
	for (const tree of [treeOf(ctx), ctx.loader]) {
		if (tree === undefined || typeof tree?.resolve !== 'function') continue
		try {
			return tree.resolve(SYSTEM_PROMPT_ENTRY)
		} catch {
			// try the next tree
		}
	}
	return undefined
}

/** Read the persona the live tree would render: the composition row's config. */
function livePersona(ctx) {
	const entry = resolveEntry(ctx)
	if (entry === undefined) return undefined
	const config = entry.options?.config
	const persona = typeof config?.persona === 'string' ? config.persona : ''
	return { persona, config }
}

/**
 * Apply one persona durably: rewrite the profile patch layer (the LAST
 * composition layer, overriding dsh-web-app's own persona row, hot-reloaded
 * by the include watcher) and the preset's persona row, then — for a
 * NON-EMPTY persona only — kick the live row immediately so the change
 * reaches the next assembled request without waiting for the watcher.
 *
 * An empty persona never touches the live tree: `entry.update({ persona: '' })`
 * would blank the row's config (wiping dsh-web-app's factory text at runtime)
 * and restart the system-prompt fiber, cascading a reload through every
 * plugin that injects its services. The recomposition from the stripped patch
 * layer restores the row's bundle default on its own.
 */
async function applyPersona(ctx, persona) {
	await writePatchLayer(ctx, persona)
	const presetWritten = await writePresetPersona(persona)
	if (!presetWritten) ctx.logger.warn(`dsh-persona-manage: preset "${PRESET_ID}" composition not found; sessions on the standard preset keep its own persona`)
	if (persona.length === 0) return
	const entry = resolveEntry(ctx)
	if (entry === undefined || typeof entry.update !== 'function') {
		throw new Error(ENTRY_UPDATE_FACE)
	}
	const nextConfig = { ...(entry.options?.config ?? {}), persona }
	await entry.update({ config: nextConfig })
	// The config-only diff path goes through _patchContext → fiber.update;
	// if the live registry did not pick the new text up (restart vetoed or
	// raced), force the fiber itself to update with the new config.
	const probe = await liveSection(ctx)
	if (probe.found && probe.text !== persona) {
		ctx.logger.warn('dsh-persona-manage: entry update did not reach the live registry; forcing fiber update')
		if (typeof entry.fiber?.update === 'function') await entry.fiber.update(nextConfig, false)
	}
}

/** Read the persona section the LIVE prompt registry would render now. */
async function liveSection(ctx) {
	const service = ctx.get('systemPrompt')
	if (service === undefined || typeof service.assemble !== 'function') {
		return { serviceAvailable: false, found: false }
	}
	try {
		const assembly = await service.assemble()
		const section = assembly?.sections?.find((candidate) => candidate?.name === 'deployment:persona')
		if (section === undefined) return { serviceAvailable: true, found: false }
		return { serviceAvailable: true, found: true, text: typeof section.text === 'string' ? section.text : '' }
	} catch (error) {
		return { serviceAvailable: true, found: false, error: String(error?.message ?? error) }
	}
}

/**
 * Converge the durable layers to "no managed persona": strip the profile
 * patch's managed region and remove the preset's persona row so the bundle
 * default renders again. File-level only — the live tree is never touched
 * (no entry.update, so no fiber restart and no reload cascade), and both
 * writers skip the rewrite when the files already carry no managed state.
 */
async function clearManagedLayers(ctx) {
	await writePatchLayer(ctx, '')
	await writePresetPersona('')
}

/**
 * Idempotently re-enforce the persisted persona against the live tree —
 * converging by observation keeps boot events and config reloads
 * side-effect free when the row already carries the store's persona.
 */
async function enforce(ctx, stored) {
	try {
		// An empty store means no managed persona is set, not "clear the row":
		// the bundle default already renders. Converge the durable layers to
		// unmanaged (self-healing any residue from earlier versions that wrote
		// an empty persona into the patch/preset) WITHOUT touching the live
		// tree — forcing "" mid-boot would restart the system-prompt fiber and
		// cascade a reload through every plugin that injects its services.
		if (!stored) {
			await clearManagedLayers(ctx)
			return
		}
		const live = livePersona(ctx)
		if (live === undefined || live.persona === stored) return
		await applyPersona(ctx, stored)
		ctx.logger.info('dsh-persona-manage: persona re-enforced from store')
	} catch (error) {
		ctx.logger.warn(`dsh-persona-manage: enforce: ${String(error)}`)
	}
}

/** Snapshot view, or an explicit unavailable marker. */
async function view(ctx) {
	const live = livePersona(ctx)
	if (live === undefined) {
		return { available: false, error: `composition row "${SYSTEM_PROMPT_ENTRY}" not found in the loader tree` }
	}
	const probe = await liveSection(ctx)
	return {
		available: true,
		persona: live.persona,
		includeHarnessIdentity: live.config?.includeHarnessIdentity !== false,
		includeRuntimeContext: live.config?.includeRuntimeContext !== false,
		warnings: lintPersona(live.persona),
		stats: statsOf(live.persona),
		live: {
			serviceAvailable: probe.serviceAvailable,
			sectionFound: probe.found,
			matchesRow: probe.found === true && probe.text === live.persona,
			preview: probe.found === true ? probe.text.slice(0, 80) : '',
			...probe.error !== undefined ? { error: probe.error } : {},
		},
	}
}

/**
 * Plugin entry: restore the persisted persona, keep it enforced across loader
 * reconciliations, then serve the management route family.
 * @param ctx - plugin context (webServer + loader injected).
 */
export async function apply(ctx) {
	// Loader-owned event names predate the 4.0.1 typings (the mcp-manage
	// precedent); subscribe through the plain ctx.on face.
	const enforceStored = () => {
		void loadStore().then((stored) => enforce(ctx, stored)).catch((error) => ctx.logger.warn(`dsh-persona-manage: ${String(error)}`))
	}
	ctx.effect(() => ctx.on('loader/entry-init', enforceStored), 'persona-manage: entry-init enforcement')
	ctx.effect(() => ctx.on('loader/config-update', enforceStored), 'persona-manage: config-update enforcement')
	enforceStored()

	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			try {
				const raw = (req.url ?? '').split('?')[0]
				const sub = raw === ROUTE_PREFIX ? '' : raw.startsWith(`${ROUTE_PREFIX}/`) ? raw.slice(ROUTE_PREFIX.length + 1) : null
				if (sub === null) {
					res.writeHead(404)
					res.end()
					return
				}

				// GET / — snapshot of the live composition config
				if (sub === '' && req.method === 'GET') {
					json(res, { ok: true, ...(await view(ctx)) })
					return
				}

				// PUT / — validate + persist + apply the persona
				if (sub === '' && req.method === 'PUT') {
					const body = await parseJsonBody(req)
					if (body === undefined || typeof body !== 'object' || typeof body.persona !== 'string') {
						json(res, { ok: false, error: 'expected { persona: string }' }, 400)
						return
					}
					const persona = body.persona
					// An empty (or whitespace-only) save means "save the
					// default": converge to exactly the state POST /reset
					// produces (store cleared, managed layers dropped, factory
					// persona renders). Both writers are file-level only, so
					// this can never restart the system-prompt fiber — the
					// empty-store incident stays dead. The live row keeps the
					// previous persona until the include watcher recomposes,
					// so the response carries a savedDefault marker instead of
					// pretending the snapshot already shows the default.
					if (persona.trim().length === 0) {
						await saveStore('')
						await applyPersona(ctx, '')
						ctx.logger.info('dsh-persona-manage: empty save converged to the composition default')
						json(res, { ok: true, savedDefault: true, ...(await view(ctx)) })
						return
					}
					const bytes = Buffer.byteLength(persona, 'utf8')
					if (bytes > MAX_PERSONA_BYTES) {
						json(res, { ok: false, error: `persona exceeds ${String(MAX_PERSONA_BYTES)} bytes (${String(bytes)})` }, 413)
						return
					}
					if (persona.includes('</script>')) {
						json(res, { ok: false, error: 'persona must not contain </script>' }, 400)
						return
					}
					const blocking = lintPersona(persona).filter((finding) => finding.kind === 'error')
					if (blocking.length > 0 && body.force !== true) {
						json(res, { ok: false, error: blocking[0].message, warnings: lintPersona(persona) }, 422)
						return
					}
					await saveStore(persona)
					await applyPersona(ctx, persona)
					ctx.logger.info(`dsh-persona-manage: persona applied (${String(bytes)} bytes, ${String(blocking.length)} lint error(s) overridden via force)`)
					json(res, { ok: true, ...(await view(ctx)) })
					return
				}

				// POST /reset — drop the managed override; the composition
				// default (dsh-web-app's factory persona) renders again.
				if (sub === 'reset' && req.method === 'POST') {
					await saveStore('')
					await applyPersona(ctx, '')
					ctx.logger.info('dsh-persona-manage: persona override dropped; composition default restored')
					json(res, { ok: true, savedDefault: true, ...(await view(ctx)) })
					return
				}

				res.writeHead(405)
				res.end()
			} catch (error) {
				ctx.logger.warn(`dsh-persona-manage: ${String(error)}`)
				json(res, { ok: false, error: String(error?.message ?? error) }, 500)
			}
		},
	}), 'persona-manage: routes')
}
