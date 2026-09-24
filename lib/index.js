/**
 * dsh-persona-manage — host half: the persona management backend.
 *
 * The persona is served as this plugin's OWN global prompt section
 * (`deployment:persona-manage`, registered once at fiber start with a
 * function `text` that reads a mutable holder): editing the persona updates
 * the holder — ZERO fiber restarts, ZERO composition-file writes, and the
 * next assembled request of every session (existing ones included) already
 * uses the new text. This is the fix for the wedged active-session composer:
 * every composition write (the old patch-layer text override) recomposed the
 * loader and the web client did not re-bind its session-scoped input
 * services, leaving the chat input inert until a session switch.
 *
 * The composition is touched exactly once — a FIXED pin
 * (`system-prompt: {persona: ''}`) written at the first boot after install
 * (boot-time, before any save) so the registry's own deployment:persona
 * section stops rendering the factory text next to ours. The pin never
 * changes afterwards; the factory text it displaced is captured to
 * `$DSH_HOME/persona-manage/factory.json` and restored at runtime on reset.
 * The persona also persists in `$DSH_HOME/persona-manage/persona.json` and is
 * re-applied to the holder at boot and on every loader/config-update.
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

/**
 * The name of THIS plugin's own global prompt section. Different from the
 * registry's `deployment:persona` (a same-name global registration would
 * collide); same order, so the text renders exactly where the deployment
 * persona belongs — right after the harness identity.
 */
const PERSONA_SECTION_NAME = 'deployment:persona-manage'

/** Hard cap on the persisted persona text — far above any sane prompt. */
const MAX_PERSONA_BYTES = 256 * 1024

/** Variables the stock agent loop registers; anything else is plugin-provided. */
const STOCK_VARIABLES = ['model', 'cwd']

export const inject = ['webServer', 'loader', 'systemPrompt']

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

/**
 * The plugin's own package version, read once from package.json (never
 * hardcoded, so it cannot drift) and echoed in every snapshot response for
 * the settings page to display.
 */
let versionPromise
function pluginVersion() {
	versionPromise ??= readFile(new URL('../package.json', import.meta.url), 'utf8')
		.then((text) => String(JSON.parse(text).version ?? 'unknown'))
		.catch(() => 'unknown')
	return versionPromise
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

/** Where the displaced factory persona text is captured once, for runtime reset. */
function factoryPath() {
	return join(resolveDshHome(), 'persona-manage', 'factory.json')
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

/** Load the captured factory persona ('' when never captured). */
async function loadFactory() {
	try {
		const parsed = JSON.parse(await readFile(factoryPath(), 'utf8'))
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

/** Persist the captured factory persona (one time, at pin creation). */
async function saveFactory(persona) {
	const path = factoryPath()
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify({ persona, capturedAt: new Date().toISOString() }, null, '\t')}\n`, 'utf8')
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

/**
 * The FIXED managed pin: blanks the system-prompt row's own persona so the
 * registry's `deployment:persona` section stops rendering the factory text
 * next to this plugin's runtime section. The pin's content NEVER changes
 * with the persona — that is the point: once present, re-applying it is a
 * byte-identical no-op, so persona edits never touch this file and never
 * trigger the include-watcher recomposition (whose reconcile wave wedged
 * the web client's active-session composer).
 */
function managedBlock() {
	return [PATCH_BEGIN, '- id: system-prompt', '  config:', "    persona: ''", PATCH_END]
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
 * Converge the pin state: ensure the managed pin is present when `pin` is
 * true, stripped when false. Content is fixed, so an already-correct file is
 * never rewritten — composition writes happen only on the managed↔unmanaged
 * transition (once, at boot), never on persona edits.
 */
async function writePatchLayer(ctx, pin) {
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
	if (!pin) {
		const next = emptyPatchLayerText(stripped, hasOtherEntries)
		const body = next.join('\n').replace(/\n{3,}$/, '\n')
		const out = body.endsWith('\n') || body.length === 0 ? body : `${body}\n`
		// Skip the rewrite (and the watcher reload it triggers) when the file
		// already carries no managed region.
		if (out !== text) await writeFile(path, out, 'utf8')
		return
	}
	const block = managedBlock()
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
 * Apply one persona at runtime: set the text our global section renders and
 * ensure the pin exists. The pin's content is FIXED and it is NEVER removed
 * — while unmanaged our section simply renders the captured factory text,
 * so save / reset / empty-save are ALL pure runtime operations: zero fiber
 * restarts, zero loader recomposition, and the next assembled request of
 * every session — existing ones included — already uses the new text.
 * (Corollary: uninstalling or disabling this plugin requires manually
 * removing the managed pin, or the row keeps its pinned empty persona.)
 *
 * @param persona the text the section should render (the captured factory
 * text when unmanaged — reset and empty-save land here, so the UI keeps
 * showing the effective persona).
 */
async function applyPersona(ctx, persona, runtime) {
	await writePatchLayer(ctx, true)
	await writePresetPersona('') // one-time removal of the legacy scoped shadow row
	runtime.text = persona
}

/** Read the persona section the LIVE prompt registry would render now. */
async function liveSection(ctx) {
	const service = ctx.get('systemPrompt')
	if (service === undefined || typeof service.assemble !== 'function') {
		return { serviceAvailable: false, found: false }
	}
	try {
		const assembly = await service.assemble()
		const section = assembly?.sections?.find((candidate) => candidate?.name === PERSONA_SECTION_NAME)
		if (section === undefined) return { serviceAvailable: true, found: false }
		return { serviceAvailable: true, found: true, text: typeof section.text === 'string' ? section.text : '' }
	} catch (error) {
		return { serviceAvailable: true, found: false, error: String(error?.message ?? error) }
	}
}

/**
 * Settling window for the post-write live probe: applying a persona restarts
 * the system-prompt fiber (the designed hot-apply), during which the service
 * blinks and its section registry rebuilds. A single sample taken right after
 * the write therefore reports scary-but-wrong states ("service invisible",
 * "section missing"). Re-sample briefly until the registry renders `expect`.
 */
const SETTLE_SAMPLE_MS = 200
const SETTLE_MAX_SAMPLES = 10

/**
 * Whether one probe sample shows the registry settled on `expect`. An EMPTY
 * expect converges on "section filtered out" — dsh-system-prompt drops
 * empty-text sections from the assembly, so absence IS the rendered state.
 */
function probeConverged(probe, expect) {
	if (probe.serviceAvailable !== true) return false
	if (probe.found !== true) return expect.length === 0
	return probe.text === expect
}

/**
 * Probe the live registry, re-sampling through the fiber-restart window until
 * it renders `expect` or the budget runs out. Returns the last sample plus
 * whether it converged.
 */
async function settleProbe(ctx, expect) {
	let probe = await liveSection(ctx)
	for (let taken = 1; taken < SETTLE_MAX_SAMPLES && !probeConverged(probe, expect); taken += 1) {
		await new Promise((wake) => setTimeout(wake, SETTLE_SAMPLE_MS))
		probe = await liveSection(ctx)
	}
	return { probe, converged: probeConverged(probe, expect) }
}

/**
 * The factory persona as shipped by dsh-web-app — last-resort fallback for
 * the capture below (used only when neither a capture nor an unpinned row
 * is available, e.g. upgrading from a version whose patch block carried a
 * custom persona).
 */
const FALLBACK_FACTORY_PERSONA = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'

/**
 * Whether the profile patch layer already carries the managed region — when
 * it does, the row's own persona is pinned/overridden and is NOT a reliable
 * factory capture source.
 */
async function patchHasManagedRegion(ctx) {
	try {
		return (await readFile(profilePatchPath(ctx), 'utf8')).includes(PATCH_BEGIN)
	} catch {
		return false
	}
}

/**
 * Idempotently converge boot state onto the runtime section: capture the
 * factory persona once (from a prior capture, or from the still-unpinned
 * row), ensure the pin and the legacy preset row are converged, and set the
 * rendered text from the store. The ONLY composition write this ever does
 * is the one-time pin creation (or legacy-block migration) — persona edits
 * and resets never write and never restart anything.
 */
async function enforce(ctx, stored, runtime) {
	try {
		if (runtime.default === '') {
			const captured = await loadFactory()
			if (captured !== '') {
				runtime.default = captured
			} else if (!(await patchHasManagedRegion(ctx))) {
				// No capture and no managed region: the live row still
				// renders the factory text — grab it before pinning.
				const rowPersona = livePersona(ctx)?.persona
				if (typeof rowPersona === 'string' && rowPersona.length > 0) {
					runtime.default = rowPersona
					await saveFactory(rowPersona)
				}
			}
			if (runtime.default === '') runtime.default = FALLBACK_FACTORY_PERSONA
		}
		await applyPersona(ctx, stored !== '' ? stored : runtime.default, runtime)
	} catch (error) {
		ctx.logger.warn(`dsh-persona-manage: enforce: ${String(error)}`)
	}
}

/**
 * Snapshot view. The persona is the STORE text — or, when nothing is stored,
 * the captured factory text our section renders in its place. Pass
 * `settleExpect` right after a write to re-sample the live probe through any
 * settle window; without it one fast sample serves a plain GET.
 */
async function view(ctx, runtime, settleExpect) {
	const version = await pluginVersion()
	const persona = settleExpect !== undefined ? settleExpect : ((await loadStore()) || runtime.default)
	const flags = livePersona(ctx)?.config ?? {}
	const expect = persona
	let probe
	let converged
	if (settleExpect !== undefined) {
		;({ probe, converged } = await settleProbe(ctx, expect))
	} else {
		probe = await liveSection(ctx)
		converged = probeConverged(probe, expect)
	}
	return {
		available: true,
		version,
		persona,
		includeHarnessIdentity: flags.includeHarnessIdentity !== false,
		includeRuntimeContext: flags.includeRuntimeContext !== false,
		warnings: lintPersona(persona),
		stats: statsOf(persona),
		live: {
			serviceAvailable: probe.serviceAvailable,
			sectionFound: probe.found,
			matchesRow: probe.found === true && probe.text === persona,
			converged,
			preview: probe.found === true ? probe.text.slice(0, 80) : '',
			...probe.error !== undefined ? { error: probe.error } : {},
		},
	}
}

/**
 * Plugin entry: register the runtime persona section, restore the persisted
 * persona onto it, keep it enforced across loader reconciliations, then
 * serve the management route family.
 * @param ctx - plugin context (webServer + loader + systemPrompt injected).
 */
export async function apply(ctx) {
	const runtime = { text: '', default: '' }
	// The persona surface: one global section whose text is read from the
	// mutable holder on EVERY assembly — saving only updates the holder.
	ctx.effect(() => ctx.systemPrompt.section({
		name: PERSONA_SECTION_NAME,
		order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA'),
		text: () => runtime.text,
	}), 'persona-manage: persona section')

	// Loader-owned event names predate the 4.0.1 typings (the mcp-manage
	// precedent); subscribe through the plain ctx.on face.
	const enforceStored = () => {
		void loadStore().then((stored) => enforce(ctx, stored, runtime)).catch((error) => ctx.logger.warn(`dsh-persona-manage: ${String(error)}`))
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

					// GET / — snapshot of the store + live section state
					if (sub === '' && req.method === 'GET') {
						json(res, { ok: true, ...(await view(ctx, runtime)) })
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
					// default": unmanage and render the captured factory
					// persona. This is pure runtime — no fiber restart, no
					// composition write (once the pin is converged).
					if (persona.trim().length === 0) {
						await saveStore('')
						await applyPersona(ctx, runtime.default, runtime)
						ctx.logger.info('dsh-persona-manage: empty save converged to the factory default')
						json(res, { ok: true, savedDefault: true, ...(await view(ctx, runtime, runtime.default)) })
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
					await applyPersona(ctx, persona, runtime)
					ctx.logger.info(`dsh-persona-manage: persona applied at runtime (${String(bytes)} bytes, ${String(blocking.length)} lint error(s) overridden via force)`)
					json(res, { ok: true, ...(await view(ctx, runtime, persona)) })
					return
				}

				// POST /reset — unmanage and render the captured factory
				// persona; pure runtime once the pin is converged.
				if (sub === 'reset' && req.method === 'POST') {
					await saveStore('')
					await applyPersona(ctx, runtime.default, runtime)
					ctx.logger.info('dsh-persona-manage: persona override dropped; factory default restored')
					json(res, { ok: true, savedDefault: true, ...(await view(ctx, runtime, runtime.default)) })
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
