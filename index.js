/**
 * dsh-plugin-team-balancer — Host half.
 *
 * Distributes Agent Teams teammates (and optionally ordinary delegated
 * subagents) across a weighted pool of LLM provider routes, while the Team Lead
 * keeps its own model. The pool and switches are owned by this plugin and are
 * edited from the Web Plugins page (bundle page) through the two HTTP routes
 * below; values persist as JSON under the DSH home and apply live.
 *
 * Routes:
 *   GET  /dsh-team-balancer/state   -> effective config, routable providers,
 *                                      validated pool, live assignments
 *   POST /dsh-team-balancer/config  -> save {enabled, includeSubagents,
 *                                      autoTeam, spread, idleFirst,
 *                                      capabilityRouting, emphasis, pool}
 *   POST /dsh-team-balancer/reset   -> drop stored overrides, back to bundle defaults
 *
 * Routing mechanism: every child Agent gets a sticky route from the weighted
 * pool. On DeepSeek Harness 0.2.2+ the route is fixed before the step through
 * `agent.model.select()`; on older cores it is forced by the `agent/request`
 * waterfall. The child's AgentOptions are updated so the Team roster, session
 * selector, and {{model}} persona report it. Assignments persist under
 * <DSH_HOME>/storages/team-balancer/assignments.json, so a restart or a plugin
 * reload restores each teammate's model instead of leaving it on the Lead's.
 *
 * Automatic participation: with `autoTeam` on, the plugin also installs a
 * per-agent system-prompt section on root (Lead) Agents that tells the model to
 * split substantial work across 2-4 teammates instead of doing everything in
 * one context. The section is scoped to each root Agent via `agent.ctx`, so
 * teammates never receive it. Root Sessions are never rerouted.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'team-balancer'

/** Only hard Service dependency; optional services are read through ctx.get(). */
export const inject = ['agents']

const STORE_DIR = 'team-balancer'
const BODY_LIMIT = 64 * 1024
const CATALOG_TTL_MS = 60 * 1000
const ROUTE_TTL_MS = 60 * 1000
const CONFIG_FILE = 'config.json'
const ASSIGNMENTS_FILE = 'assignments.json'
/** Version reported by /state; bump together with package.json. */
const VERSION = '0.3.1'

/** Bundle-patch defaults used until the user saves overrides. */
const DEFAULT_POOL = [
  { provider: 'deepseek-official', model: 'deepseek-flash', weight: 1 },
  { provider: 'zai', model: 'glm-5.3-flash', weight: 1 },
]

/** Default for the Lead-participation system-prompt section. */
const DEFAULT_AUTO_TEAM = true
/** Default for spreading distinct providers before repeating one. */
const DEFAULT_SPREAD = true
/** Default for sending a new parallel child to a provider that is not busy. */
const DEFAULT_IDLE_FIRST = true
/** Prompt section name; unique so it never shadows a core section. */
const GUIDANCE_SECTION = 'team-balancer:policy'

/** Default capability emphasis: follow the task hint, otherwise rotate evenly. */
const DEFAULT_CAPABILITY_ROUTING = true
const DEFAULT_EMPHASIS = 'auto'
const EMPHASIS_MODES = new Set(['auto', 'balanced', 'code', 'vision'])

/**
 * Capability vocabulary. A teammate's name prefix (`vision-*`, `code-*`,
 * `table-*`, ...) or the configured emphasis selects one of these buckets; each
 * pool route advertises the buckets it is good at.
 */
const CAPABILITY_KEYWORDS = {
  vision: [
    'vision',
    'image',
    'images',
    'img',
    'visual',
    'screenshot',
    'ocr',
    'multimodal',
    'ui',
    'ux',
    'frontend',
    'design',
    'css',
    'html',
    '图像',
    '图片',
    '视觉',
    '截图',
    '界面',
    '前端',
    '设计',
    '多模态',
  ],
  code: [
    'code',
    'coding',
    'table',
    'tables',
    'tabular',
    'data',
    'dataset',
    'sql',
    'api',
    'backend',
    'server',
    'refactor',
    'test',
    'tests',
    'debug',
    'typescript',
    'javascript',
    'python',
    'script',
    'algorithm',
    'logic',
    '代码',
    '表格',
    '数据',
    '重构',
    '调试',
    '测试',
    '算法',
    '后端',
  ],
}

/** Name prefixes that force one capability bucket. */
const NAME_CAPABILITY = new Map([
  ['vision', 'vision'],
  ['image', 'vision'],
  ['img', 'vision'],
  ['visual', 'vision'],
  ['ui', 'vision'],
  ['frontend', 'vision'],
  ['design', 'vision'],
  ['ocr', 'vision'],
  ['code', 'code'],
  ['coding', 'code'],
  ['table', 'code'],
  ['tables', 'code'],
  ['data', 'code'],
  ['sql', 'code'],
  ['api', 'code'],
  ['backend', 'code'],
  ['refactor', 'code'],
  ['test', 'code'],
  ['debug', 'code'],
  ['script', 'code'],
])

/** @returns {number} whole milliseconds on a monotonic-enough clock. */
function now() {
  return Date.now()
}

/** One bounded error description for logs and HTTP replies. */
function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Trim one string field or return undefined. */
function stringField(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Normalize one pool entry.
 * @returns {{provider: string, model: string, weight: number, reasoningEffort?: string} | undefined}
 */
function normalizeEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const provider = stringField(entry.provider)
  const model = stringField(entry.model)
  if (provider === undefined || model === undefined) return undefined
  const rawWeight = typeof entry.weight === 'number' && Number.isFinite(entry.weight) ? entry.weight : 1
  const weight = Math.max(1, Math.min(100, Math.round(rawWeight)))
  const normalized = { provider, model, weight }
  const effort = stringField(entry.reasoningEffort)
  if (effort !== undefined) normalized.reasoningEffort = effort
  return normalized
}

/** Deduplicate a normalized pool by provider+model. */
function dedupePool(entries) {
  const pool = []
  const seen = new Set()
  for (const entry of entries) {
    const normalized = normalizeEntry(entry)
    if (normalized === undefined) continue
    const key = `${normalized.provider}\u0000${normalized.model}`
    if (seen.has(key)) continue
    seen.add(key)
    pool.push(normalized)
  }
  return pool
}

/**
 * Normalize a complete or partial configuration.
 * @param {unknown} raw loader row config or stored JSON.
 * @param {{partial?: boolean}} [options] partial keeps absent fields out.
 */
function normalizeConfig(raw, options = {}) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = {}
  if (source.enabled !== undefined) config.enabled = source.enabled === true
  if (options.partial !== true && config.enabled === undefined) config.enabled = true
  if (source.includeSubagents !== undefined) config.includeSubagents = source.includeSubagents === true
  if (options.partial !== true && config.includeSubagents === undefined) config.includeSubagents = false
  if (source.autoTeam !== undefined) config.autoTeam = source.autoTeam === true
  if (options.partial !== true && config.autoTeam === undefined) config.autoTeam = DEFAULT_AUTO_TEAM
  if (source.spread !== undefined) config.spread = source.spread === true
  if (options.partial !== true && config.spread === undefined) config.spread = DEFAULT_SPREAD
  if (source.idleFirst !== undefined) config.idleFirst = source.idleFirst === true
  if (options.partial !== true && config.idleFirst === undefined) config.idleFirst = DEFAULT_IDLE_FIRST
  if (source.capabilityRouting !== undefined) config.capabilityRouting = source.capabilityRouting === true
  if (options.partial !== true && config.capabilityRouting === undefined) config.capabilityRouting = DEFAULT_CAPABILITY_ROUTING
  if (source.emphasis !== undefined && EMPHASIS_MODES.has(source.emphasis)) config.emphasis = source.emphasis
  if (options.partial !== true && config.emphasis === undefined) config.emphasis = DEFAULT_EMPHASIS
  if (Array.isArray(source.pool)) config.pool = dedupePool(source.pool)
  else if (options.partial !== true) config.pool = dedupePool(DEFAULT_POOL)
  if (config.pool !== undefined && config.pool.length === 0 && options.partial !== true) config.pool = dedupePool(DEFAULT_POOL)
  return config
}

/**
 * Validate an incoming config patch from the Web page.
 * @param {unknown} body parsed JSON body.
 * @returns {{enabled?: boolean, includeSubagents?: boolean, autoTeam?: boolean, spread?: boolean, idleFirst?: boolean, capabilityRouting?: boolean, emphasis?: string, pool?: object[]}}
 */
function validatePatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是对象')
  const patch = {}
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
    patch.enabled = body.enabled
  }
  if ('includeSubagents' in body) {
    if (typeof body.includeSubagents !== 'boolean') throw new Error('includeSubagents 必须是布尔值')
    patch.includeSubagents = body.includeSubagents
  }
  if ('autoTeam' in body) {
    if (typeof body.autoTeam !== 'boolean') throw new Error('autoTeam 必须是布尔值')
    patch.autoTeam = body.autoTeam
  }
  if ('spread' in body) {
    if (typeof body.spread !== 'boolean') throw new Error('spread 必须是布尔值')
    patch.spread = body.spread
  }
  if ('idleFirst' in body) {
    if (typeof body.idleFirst !== 'boolean') throw new Error('idleFirst 必须是布尔值')
    patch.idleFirst = body.idleFirst
  }
  if ('capabilityRouting' in body) {
    if (typeof body.capabilityRouting !== 'boolean') throw new Error('capabilityRouting 必须是布尔值')
    patch.capabilityRouting = body.capabilityRouting
  }
  if ('emphasis' in body) {
    if (typeof body.emphasis !== 'string' || !EMPHASIS_MODES.has(body.emphasis)) throw new Error('emphasis 必须是 auto / balanced / code / vision')
    patch.emphasis = body.emphasis
  }
  if ('pool' in body) {
    if (!Array.isArray(body.pool)) throw new Error('pool 必须是数组')
    if (body.pool.length === 0) throw new Error('至少保留一条路由')
    if (body.pool.length > 20) throw new Error('路由数量不能超过 20 条')
    const pool = []
    for (const entry of body.pool) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('每条路由必须是对象')
      const provider = stringField(entry.provider)
      const model = stringField(entry.model)
      if (provider === undefined || model === undefined) throw new Error('每条路由都需要 provider 和 model')
      if (entry.weight !== undefined && entry.weight !== null && entry.weight !== '') {
        const weight = Number(entry.weight)
        if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new Error(`权重必须是 1-100 的整数（${provider}/${model}）`)
      }
      const reasoningEffort = entry.reasoningEffort === undefined ? undefined : stringField(entry.reasoningEffort)
      const normalized = { provider, model, weight: entry.weight === undefined ? 1 : Number(entry.weight) }
      if (reasoningEffort !== undefined) normalized.reasoningEffort = reasoningEffort
      pool.push(normalized)
    }
    patch.pool = dedupePool(pool)
    if (patch.pool.length === 0) throw new Error('至少保留一条有效路由')
  }
  if (Object.keys(patch).length === 0) throw new Error('没有可保存的字段')
  return patch
}

/**
 * Build the weighted pick sequence for a pool.
 *
 * With `spread`, the first pass contains every distinct route once, in pool
 * order; only then are the remaining weight slots filled by smooth weighted
 * round robin. A 1:1 pool yields [DeepSeek, GLM], and a 1:2 pool yields
 * [DeepSeek, GLM, GLM] instead of [GLM, GLM, DeepSeek] — so the very first two
 * teammates already run on different providers. Without `spread`, plain smooth
 * weighted round robin is used.
 * @param {Array<{weight: number}>} pool
 * @param {boolean} spread
 * @returns {number[]} pool indexes covering exactly one total-weight cycle.
 */
function weightedCycle(pool, spread) {
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0)
  if (spread !== true) {
    const current = pool.map(() => 0)
    const cycle = []
    for (let step = 0; step < total; step += 1) {
      let best = 0
      for (let index = 0; index < pool.length; index += 1) {
        current[index] += pool[index].weight
        if (current[index] > current[best]) best = index
      }
      cycle.push(best)
      current[best] -= total
    }
    return cycle
  }
  const remaining = pool.map((entry) => entry.weight)
  const cycle = []
  // One distinct route of every provider first, in configured order.
  for (let index = 0; index < pool.length && cycle.length < total; index += 1) {
    if (remaining[index] <= 0) continue
    cycle.push(index)
    remaining[index] -= 1
  }
  // Fill the rest with smooth weighted round robin over the remaining counts.
  const remainder = remaining.reduce((sum, weight) => sum + weight, 0)
  const current = pool.map(() => 0)
  for (let step = cycle.length; step < total; step += 1) {
    let best = -1
    for (let index = 0; index < pool.length; index += 1) {
      if (remaining[index] <= 0) continue
      current[index] += remaining[index]
      if (best < 0 || current[index] > current[best]) best = index
    }
    if (best < 0) break
    cycle.push(best)
    current[best] -= remainder
  }
  return cycle
}

/** Merge one assigned route into a request configuration. */
function routeConfiguration(base, record) {
  const sameRoute = base.provider === record.provider && base.model === record.model
  if (sameRoute) {
    if (record.reasoningEffort === undefined) return base
    if (String(base.reasoningEffort ?? '') === record.reasoningEffort) return base
    return { ...base, reasoningEffort: record.reasoningEffort }
  }
  return {
    provider: record.provider,
    model: record.model,
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }),
  }
}

/** Read a child Session's parent id without trusting a missing surface. */
function parentSessionOf(agent) {
  try {
    return agent.session?.header?.parentSession
  } catch {
    return undefined
  }
}

/** Match one keyword as a whole ASCII word, or as a plain substring for CJK. */
function containsWord(text, word) {
  if (/^[a-z0-9]+$/.test(word)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text)
  }
  return text.includes(word)
}

/** Capability buckets a route advertises, inferred from its provider/model. */
function capabilityTagsFor(route) {
  const text = `${route.provider} ${route.model}`.toLowerCase()
  const tags = []
  if (text.includes('glm') || text.includes('zai')) tags.push('vision')
  if (text.includes('deepseek')) tags.push('code')
  return tags
}

/** Classify free text into one capability bucket; vision wins when both match. */
function classifyCapability(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const lower = text.toLowerCase()
  for (const capability of ['vision', 'code']) {
    const words = CAPABILITY_KEYWORDS[capability]
    if (words.some((word) => containsWord(lower, word))) return capability
  }
  return undefined
}

/** Infer a capability from a teammate name such as `vision-ocr` or `code-api`. */
function capabilityFromName(name) {
  if (typeof name !== 'string' || name.trim() === '') return undefined
  const lower = name.trim().toLowerCase()
  for (const token of lower.split(/[^a-z0-9]+/)) {
    const mapped = NAME_CAPABILITY.get(token)
    if (mapped !== undefined) return mapped
  }
  return classifyCapability(lower)
}

/** Resolve the DSH home directory the host process runs with. */
function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') return join(profileDir, '..', '..')
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return join(home, '.dsh')
}

/**
 * Mount the balancer.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {unknown} rawConfig loader row config.
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger
  const baseConfig = normalizeConfig(rawConfig)
  const storePath = join(resolveDshHome(), 'storages', STORE_DIR, CONFIG_FILE)
  const assignmentsPath = join(resolveDshHome(), 'storages', STORE_DIR, ASSIGNMENTS_FILE)

  /** @type {Map<string, object>} agent id -> sticky route record */
  const assignments = new Map()
  /** @type {Map<object, {dispose: () => Promise<unknown>}>} Lead agent -> prompt fiber */
  const guidanceFibers = new Map()
  let guidanceRenders = 0
  let guidanceLastRenderedAt
  /** @type {object | undefined} validated route cache for the current pool */
  let routeCache
  /** @type {{at: number, value?: Array<object>} | undefined} provider catalog cache */
  let catalogCache
  /** @type {Map<string, {at: number, ok: boolean, error?: string}>} */
  const probeCache = new Map()
  let subagentCursor = 0
  let disposed = false
  let stored = readStored()
  let effective = mergeConfig(baseConfig, stored)
  for (const record of readAssignments()) assignments.set(record.agentId, record)
  subagentCursor = [...assignments.values()].filter((record) => record.kind === 'subagent').length

  /** Merge base config with stored partial overrides. */
  function mergeConfig(base, overrides) {
    return {
      enabled: overrides.enabled === undefined ? base.enabled : overrides.enabled,
      includeSubagents: overrides.includeSubagents === undefined ? base.includeSubagents : overrides.includeSubagents,
      autoTeam: overrides.autoTeam === undefined ? base.autoTeam : overrides.autoTeam,
      spread: overrides.spread === undefined ? base.spread : overrides.spread,
      idleFirst: overrides.idleFirst === undefined ? base.idleFirst : overrides.idleFirst,
      capabilityRouting: overrides.capabilityRouting === undefined ? base.capabilityRouting : overrides.capabilityRouting,
      emphasis: overrides.emphasis === undefined ? base.emphasis : overrides.emphasis,
      pool: overrides.pool === undefined ? base.pool : overrides.pool,
    }
  }

  /** Read persisted overrides; a broken file is ignored with a warning. */
  function readStored() {
    try {
      const text = readFileSync(storePath, 'utf8')
      const parsed = JSON.parse(text)
      const partial = normalizeConfig(parsed, { partial: true })
      return partial
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return {}
      logger.warn(`team-balancer: ignored unreadable settings file ${storePath}: ${describeError(error)}`)
      return {}
    }
  }

  /** Atomically persist the override object. */
  function writeStored(next) {
    mkdirSync(dirname(storePath), { recursive: true })
    const temporary = `${storePath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(temporary, storePath)
  }

  /** Delete the persisted overrides. */
  function clearStored() {
    try {
      rmSync(storePath, { force: true })
    } catch (error) {
      logger.warn(`team-balancer: failed to remove ${storePath}: ${describeError(error)}`)
    }
  }

  /** Validate one persisted assignment record. */
  function normalizeAssignment(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const agentId = stringField(raw.agentId)
    const provider = stringField(raw.provider)
    const model = stringField(raw.model)
    const ordinal = typeof raw.ordinal === 'number' && Number.isInteger(raw.ordinal) && raw.ordinal >= 0 ? raw.ordinal : undefined
    if (agentId === undefined || provider === undefined || model === undefined || ordinal === undefined) return undefined
    const kind = raw.kind === 'subagent' ? 'subagent' : 'teammate'
    const record = {
      agentId,
      kind,
      ordinal,
      provider,
      model,
      assignedAt: typeof raw.assignedAt === 'number' ? raw.assignedAt : now(),
    }
    const name = stringField(raw.teammateName)
    if (name !== undefined) record.teammateName = name
    const effort = stringField(raw.reasoningEffort)
    if (effort !== undefined) record.reasoningEffort = effort
    return record
  }

  /** Read saved assignments so a restart restores each teammate's model. */
  function readAssignments() {
    try {
      const parsed = JSON.parse(readFileSync(assignmentsPath, 'utf8'))
      if (!Array.isArray(parsed)) return []
      const records = []
      for (const raw of parsed) {
        const record = normalizeAssignment(raw)
        if (record !== undefined) records.push(record)
      }
      return records
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
      logger.warn(`team-balancer: ignored unreadable assignments file ${assignmentsPath}: ${describeError(error)}`)
      return []
    }
  }

  /** Persist the current assignment table; failures never break a turn. */
  function writeAssignments() {
    try {
      mkdirSync(dirname(assignmentsPath), { recursive: true })
      const temporary = `${assignmentsPath}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify([...assignments.values()], null, 2)}\n`, 'utf8')
      renameSync(temporary, assignmentsPath)
    } catch (error) {
      logger.warn(`team-balancer: failed to persist assignments: ${describeError(error)}`)
    }
  }

  /** Invalidate every derived cache after a config change. */
  function invalidate() {
    routeCache = undefined
    catalogCache = undefined
    probeCache.clear()
  }

  /** List currently routable providers with their advertised models. */
  async function providerCatalog() {
    const cached = catalogCache
    if (cached !== undefined && now() - cached.at < CATALOG_TTL_MS) return cached.value
    const llm = ctx.get('llm')
    if (llm === undefined) return []
    const listed = []
    try {
      for (const provider of llm.listProviders()) {
        const row = { id: provider.id, name: provider.name ?? provider.id, models: [] }
        try {
          const models = await llm.listModels(provider.id)
          row.models = models.map((model) => ({ id: model.id, name: model.name ?? model.id }))
        } catch (error) {
          row.error = describeError(error)
        }
        listed.push(row)
      }
    } catch (error) {
      logger.warn(`team-balancer: provider catalog failed: ${describeError(error)}`)
      return []
    }
    catalogCache = { at: now(), value: listed }
    return listed
  }

  /** Probe one exact route once per minute. */
  async function probeRoute(provider, model) {
    const key = `${provider}\u0000${model}`
    const cached = probeCache.get(key)
    if (cached !== undefined && now() - cached.at < ROUTE_TTL_MS) return cached
    const llm = ctx.get('llm')
    if (llm === undefined) return { at: now(), ok: true }
    try {
      await llm.resolveModelInfo(provider, model)
      const result = { at: now(), ok: true }
      probeCache.set(key, result)
      return result
    } catch (error) {
      const result = { at: now(), ok: false, error: describeError(error) }
      probeCache.set(key, result)
      return result
    }
  }

  /** The configured pool annotated with live availability. */
  async function inspectedPool() {
    const routes = []
    for (const entry of effective.pool) {
      const probe = await probeRoute(entry.provider, entry.model)
      routes.push({ ...entry, available: probe.ok === true, ...(probe.error === undefined ? {} : { error: probe.error }) })
    }
    return routes
  }

  /** The routable subset in configured order, usable for cycles. */
  async function usablePool() {
    const routes = await inspectedPool()
    return routes.filter((route) => route.available === true)
  }

  /** Cached weighted cycle over the currently usable pool. */
  async function currentCycle() {
    const usable = await usablePool()
    const signature = JSON.stringify([effective.spread === true, usable.map((route) => [route.provider, route.model, route.weight])])
    if (routeCache !== undefined && routeCache.signature === signature) return routeCache
    const cycle = weightedCycle(usable, effective.spread === true)
    routeCache = { signature, usable, cycle }
    return routeCache
  }

  /** Route for the ordinal-th balanced child. */
  async function routeForOrdinal(ordinal) {
    const cached = await currentCycle()
    if (cached.usable.length === 0) return undefined
    return cached.usable[cached.cycle[ordinal % cached.cycle.length]]
  }

  /** Stable key for one provider/model pair. */
  function routeKey(route) {
    return `${route.provider}\u0000${route.model}`
  }

  /** Live running child count per route; dormant children are not busy. */
  function runningRouteCounts() {
    const agents = ctx.get('agents')
    const counts = new Map()
    for (const record of assignments.values()) {
      const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(record.agentId) : undefined
      if (agent === undefined || agent.status !== 'running') continue
      const key = routeKey(record)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }

  /** Pick one route from a candidate subset through the weighted spread cycle. */
  function pickFromCycle(routes, ordinal) {
    if (routes.length === 0) return undefined
    if (routes.length === 1) return routes[0]
    const cycle = weightedCycle(routes, effective.spread === true)
    return routes[cycle[ordinal % cycle.length]]
  }

  /**
   * Pick the route for one child. A recognized capability prefers the routes
   * that advertise it (still rotating by weight inside that subset); otherwise
   * the weighted spread cycle decides. With `idleFirst`, a newly created child
   * avoids a provider that is already running work: if the weighted pick is
   * busy and another route is idle, the idle route wins — even when the
   * capability filter would have chosen the busy one. When every route is
   * busy the normal weighted choice is kept.
   * @param {number} ordinal creation ordinal
   * @param {'vision'|'code'|undefined} capability task hint
   * @param {boolean} [preferIdle] apply the idle-first rule (new assignments only)
   */
  async function routeFor(ordinal, capability, preferIdle = true) {
    const cached = await currentCycle()
    if (cached.usable.length === 0) return undefined
    const preferred = capability === undefined ? [] : cached.usable.filter((route) => capabilityTagsFor(route).includes(capability))
    const base = preferred.length > 0 ? preferred : cached.usable
    if (preferIdle && effective.idleFirst === true) {
      const counts = runningRouteCounts()
      const idleOf = (routes) => routes.filter((route) => (counts.get(routeKey(route)) ?? 0) === 0)
      // A new parallel child should use a model that is not working right now,
      // even if the weighted cycle would repeat the busy one.
      const idlePreferred = idleOf(base)
      if (idlePreferred.length > 0) return pickFromCycle(idlePreferred, ordinal)
      // The capability-matching routes are all busy: borrow any idle route so a
      // parallel request still goes to the other model.
      if (base !== cached.usable) {
        const idleAny = idleOf(cached.usable)
        if (idleAny.length > 0) return pickFromCycle(idleAny, ordinal)
      }
      // Every route is busy: keep the usual weighted choice.
    }
    return pickFromCycle(base, ordinal)
  }

  /** Capability hint for one child, from its teammate name and the emphasis setting. */
  function capabilityFor(teammateName) {
    if (effective.capabilityRouting !== true) return undefined
    const fromName = capabilityFromName(teammateName)
    if (fromName !== undefined) return fromName
    if (effective.emphasis === 'code') return 'code'
    if (effective.emphasis === 'vision') return 'vision'
    return undefined
  }

  /** Resolve a child Agent's Team membership and roster ordinal. */
  function teammateOf(agent) {
    const teams = ctx.get('agentTeams')
    if (teams === undefined || typeof teams.tryMembership !== 'function') return undefined
    let membership
    try {
      membership = teams.tryMembership(agent)
    } catch {
      return undefined
    }
    if (membership === undefined || membership === null || membership.role !== 'teammate') return undefined
    let index = 0
    try {
      const rows = teams.listMembers(membership.root)
      const teammates = rows.filter((row) => row.role === 'teammate')
      const found = teammates.findIndex((row) => row.id === agent.id)
      if (found >= 0) index = found
    } catch {
      /* roster reads are best-effort */
    }
    return { index, name: typeof membership.name === 'string' ? membership.name : undefined }
  }

  /** Publish the route onto AgentOptions so rosters and personas report it. */
  function publishRoute(agent, record) {
    try {
      const options = agent.options
      if (options === null || typeof options !== 'object') return
      const sameRoute = options.provider === record.provider && options.model === record.model
      options.provider = record.provider
      options.model = record.model
      if (record.reasoningEffort !== undefined) options.reasoningEffort = record.reasoningEffort
      else if (!sameRoute) delete options.reasoningEffort
    } catch {
      /* Options may be read-only in a future core; the model selection still routes. */
    }
  }

  /**
   * Whether this Agent exposes the 0.2.2+ `agent.model` selection API. The new
   * loop fixes the step model before prompt assembly, so routing must go through
   * `agent.model.select()` instead of the `agent/request` waterfall.
   */
  function usesAgentModelApi(agent) {
    const model = agent?.model
    return model !== undefined && model !== null && typeof model.select === 'function'
  }

  /** Read the Agent's current routed selection when the core exposes it. */
  function currentSelectionOf(agent) {
    try {
      const model = agent?.model
      if (model === undefined || model === null || typeof model.current !== 'function') return undefined
      const selection = model.current()
      if (selection === undefined || selection === null) return undefined
      if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
      return selection
    } catch {
      return undefined
    }
  }

  /** Apply one route through the 0.2.2+ AgentModel API; returns the effort used. */
  function selectRoute(agent, route) {
    const current = currentSelectionOf(agent)
    let effort = route.reasoningEffort
    if (effort === undefined && current !== undefined && current.provider === route.provider && current.model === route.model) {
      effort = current.reasoningEffort
    }
    if (usesAgentModelApi(agent)) {
      try {
        agent.model.select({
          provider: route.provider,
          model: route.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        })
      } catch (error) {
        logger.warn(`team-balancer: agent.model.select failed for ${agent.id}: ${describeError(error)}`)
      }
    }
    return effort
  }

  /** Human-readable pool used inside the Lead guidance section. */
  function describePool() {
    return effective.pool.map((entry) => `${entry.provider}/${entry.model}×${entry.weight}`).join(', ')
  }

  /** The system-prompt policy that makes the Lead open multiple teammates. */
  function guidanceText() {
    const emphasisLine =
      effective.emphasis === 'code'
        ? 'Unless a teammate is clearly visual, prefer the code/table route for unmatched work.'
        : effective.emphasis === 'vision'
          ? 'Unless a teammate is clearly code/table work, prefer the vision/UI route for unmatched work.'
          : 'Match each teammate to its discipline; otherwise the weighted pool rotates.'
    return [
      '## Team balancer policy',
      '',
      'A team balancer is active in this session. It assigns every teammate its provider and model automatically from a weighted pool, preferring the model that fits the teammate\'s discipline. Never choose a model for a teammate, and never ask the user which model to use.',
      `- Weighted pool: ${describePool()}. ${emphasisLine}`,
      '- When one provider is already busy and another one is idle, a newly created parallel teammate is routed to the idle model even if the weights would repeat the busy one.',
      '- Name teammates by their primary discipline so the balancer can route them: `vision-*` for image, visual, screenshot/OCR, UI, frontend or design work; `code-*`, `table-*` or `data-*` for code, tables, data, SQL, API, refactoring, debugging or tests. Use a descriptive name for anything else.',
      '- When a request has two or more independent workstreams (separate files or modules, separate research questions, separate verification angles), split it: call `spawn_teammate` once per workstream, typically 2-4 teammates. Give each one a complete brief, a disjoint write scope, and a clear deliverable; keep one owner per file.',
      '- Combine discipline-specific teammates when the request mixes media: for example one `vision-*` teammate for screenshots/UI inspection and one `code-*` or `table-*` teammate for implementation, data or tables.',
      '- Do the remaining integration and synthesis yourself. Do not serialize independent work inside one context when teammates can run in parallel.',
      '- Keep small or tightly coupled tasks single-agent; do not create teammates just to look busy.',
      '- Use `list_agents` to see teammates and their status, and `send_message` to steer or unblock one.',
    ].join('\n')
  }

  /**
   * Install the Lead-only prompt section through the Agent's own scope, the same
   * way core plugins attach per-agent prompt content. Only root Agents (no
   * parent Session) receive it, so teammates never see this policy.
   */
  function installGuidance(agent) {
    if (disposed || guidanceFibers.has(agent)) return
    if (parentSessionOf(agent) !== undefined) return
    if (agent.ctx === undefined || typeof agent.ctx.inject !== 'function') return
    try {
      const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: GUIDANCE_SECTION,
          order: scope.systemPrompt.getSectionOrder('TEAM_POLICY') + 1,
          text: () => {
            if (effective.enabled !== true || effective.autoTeam !== true) return ''
            guidanceRenders += 1
            guidanceLastRenderedAt = now()
            return guidanceText()
          },
        })
      })
      if (fiber !== undefined && fiber !== null) guidanceFibers.set(agent, fiber)
    } catch (error) {
      logger.warn(`team-balancer: failed to install the Lead policy section: ${describeError(error)}`)
    }
  }

  /** Release one Agent's Lead policy section. */
  function uninstallGuidance(agent) {
    const fiber = guidanceFibers.get(agent)
    if (fiber === undefined) return
    guidanceFibers.delete(agent)
    try {
      const task = fiber.dispose()
      if (task !== undefined && task !== null && typeof task.catch === 'function') {
        void task.catch((error) => logger.warn(`team-balancer: policy section cleanup failed: ${describeError(error)}`))
      }
    } catch (error) {
      logger.warn(`team-balancer: policy section cleanup failed: ${describeError(error)}`)
    }
  }

  /** Install guidance on live Leads and assign live children that missed the event. */
  function adoptLiveAgents() {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.list !== 'function') return
    let live
    try {
      live = agents.list()
    } catch (error) {
      logger.warn(`team-balancer: agents.list failed during adoption: ${describeError(error)}`)
      return
    }
    for (const agent of live) {
      if (parentSessionOf(agent) === undefined) {
        installGuidance(agent)
        continue
      }
      void ensureAssignment(agent).catch((error) => logger.warn(`team-balancer: adoption failed: ${describeError(error)}`))
    }
  }

  /** Assign and remember one child Agent's route. */
  async function ensureAssignment(agent) {
    if (disposed) return undefined
    const existing = assignments.get(agent.id)
    if (existing !== undefined) {
      // A persisted assignment may survive a restart; reapply it to the live Agent.
      if (effective.enabled === true) {
        selectRoute(agent, existing)
        publishRoute(agent, existing)
      }
      return existing
    }
    if (effective.enabled !== true) return undefined
    if (parentSessionOf(agent) === undefined) return undefined
    const teammate = teammateOf(agent)
    let kind
    let ordinal
    let teammateName
    if (teammate !== undefined) {
      kind = 'teammate'
      ordinal = teammate.index
      teammateName = teammate.name
    } else if (effective.includeSubagents === true) {
      kind = 'subagent'
      ordinal = subagentCursor
      subagentCursor += 1
    } else {
      return undefined
    }
    const capability = capabilityFor(teammateName)
    const route = await routeFor(ordinal, capability)
    if (route === undefined) {
      logger.warn('team-balancer: no routable route in the pool right now; child keeps the inherited model')
      return undefined
    }
    const effort = selectRoute(agent, route)
    const record = {
      agentId: agent.id,
      kind,
      ordinal,
      provider: route.provider,
      model: route.model,
      ...(capability === undefined ? {} : { capability }),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(teammateName === undefined ? {} : { teammateName }),
      assignedAt: now(),
    }
    assignments.set(agent.id, record)
    publishRoute(agent, record)
    writeAssignments()
    logger.info(
      `team-balancer: ${kind} ${teammateName === undefined ? String(agent.id).slice(0, 8) : `"${teammateName}"`} -> ${record.provider}/${record.model}` +
        `${capability === undefined ? '' : ` [${capability}]`}` +
        `${usesAgentModelApi(agent) ? ' (agent.model.select)' : ' (agent/request)'}`,
    )
    return record
  }

  /**
   * Re-route children that can still change their step model: live idle Agents
   * are updated through the selection API, running ones keep the current model,
   * and dormant ones keep their persisted route until their Session resumes.
   */
  async function rebalanceIdleAssignments() {
    const agents = ctx.get('agents')
    let changed = false
    for (const [agentId, record] of [...assignments]) {
      const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(agentId) : undefined
      if (agent === undefined) continue
      if (agent.status === 'running') continue
      // Rebalancing follows the configured weights; idle-first only applies to
      // newly created parallel children, not to moving existing idle ones.
      const route = await routeFor(record.ordinal, record.capability, false)
      if (route === undefined) continue
      const effort = selectRoute(agent, route)
      const next = {
        ...record,
        provider: route.provider,
        model: route.model,
      }
      if (effort === undefined) delete next.reasoningEffort
      else next.reasoningEffort = effort
      assignments.set(agentId, next)
      publishRoute(agent, next)
      changed = true
    }
    if (changed) writeAssignments()
  }

  /** Snapshot for the Web page. */
  async function stateSnapshot() {
    const [providers, routes] = await Promise.all([providerCatalog(), inspectedPool()])
    const live = ctx.get('agents')
    const isLive = (id) => live !== undefined && typeof live.get === 'function' && live.get(id) !== undefined
    const running = runningRouteCounts()
    return {
      ok: true,
      pluginVersion: VERSION,
      enabled: effective.enabled,
      includeSubagents: effective.includeSubagents,
      autoTeam: effective.autoTeam,
      spread: effective.spread,
      idleFirst: effective.idleFirst,
      capabilityRouting: effective.capabilityRouting,
      emphasis: effective.emphasis,
      capabilities: effective.pool.map((route) => ({
        provider: route.provider,
        model: route.model,
        tags: capabilityTagsFor(route),
      })),
      pool: effective.pool,
      defaults: baseConfig,
      stored,
      storagePath: storePath,
      assignmentsPath,
      routes: routes.map((route) => ({ ...route, running: running.get(routeKey(route)) ?? 0 })),
      providers,
      assignments: [...assignments.values()]
        .sort((left, right) => left.assignedAt - right.assignedAt)
        .map((record) => ({ ...record, active: isLive(record.agentId) })),
      guidance: {
        installed: guidanceFibers.size,
        renders: guidanceRenders,
        lastRenderedAt: guidanceLastRenderedAt,
      },
      writeTime: now(),
    }
  }

  /** Apply one validated patch: persist, switch live config, rebalance idle children. */
  async function applyPatch(patch) {
    const nextStored = { ...stored, ...patch }
    writeStored(nextStored)
    stored = nextStored
    effective = mergeConfig(baseConfig, stored)
    invalidate()
    await rebalanceIdleAssignments()
    return stateSnapshot()
  }

  /** Restore bundle defaults and remove the stored override. */
  async function resetConfig() {
    clearStored()
    stored = {}
    effective = mergeConfig(baseConfig, stored)
    invalidate()
    await rebalanceIdleAssignments()
    return stateSnapshot()
  }

  async function onCreated(payload) {
    try {
      const agent = payload?.agent
      if (agent === undefined) return
      // Root Agents (the Lead and plain chats) receive the delegation policy.
      if (parentSessionOf(agent) === undefined) {
        installGuidance(agent)
        return
      }
      await ensureAssignment(agent)
    } catch (error) {
      logger.warn(`team-balancer: failed to initialize an Agent: ${describeError(error)}`)
    }
  }

  async function onRequest(payload, next) {
    const base = await next()
    const agent = payload?.agent
    if (agent === undefined) return base
    // 0.2.2+: the loop fixes the step model before prompt assembly and rejects a
    // route change here; `agent.model.select()` at assignment time owns routing.
    if (usesAgentModelApi(agent)) return base
    let record = assignments.get(agent.id)
    if (record === undefined) {
      try {
        record = await ensureAssignment(agent)
      } catch (error) {
        logger.warn(`team-balancer: lazy route assignment failed: ${describeError(error)}`)
        record = undefined
      }
    }
    if (record === undefined) return base
    return routeConfiguration(base, record)
  }

  // Live Agents that entered before this plugin mounted still need guidance
  // (Leads) or a restored route (children). Persistent assignments make this
  // the normal path after a host restart or a plugin reload.
  adoptLiveAgents()

  const offCreated = ctx.on('agent/created', onCreated)
  const offDisposed = ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    // Keep the persisted route: the same Session id gets it back when resumed.
    uninstallGuidance(agent)
  })
  const offRequest = ctx.on('agent/request', onRequest)
  const offAdapters = ctx.on('llm/adapters-updated', () => invalidate())

  ctx.inject(['webServer'], (child) => {
    child.effect(
      () =>
        child.webServer.register({
          kind: 'exact',
          path: '/dsh-team-balancer/state',
          handler: async (req, res) => {
            if (!isTrustedRequest(req)) {
              writeJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            if (req.method !== 'GET') {
              writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            try {
              writeJson(res, 200, await stateSnapshot())
            } catch (error) {
              writeJson(res, 500, { ok: false, error: describeError(error) })
            }
          },
        }),
      'team-balancer: /dsh-team-balancer/state route',
    )
    child.effect(
      () =>
        child.webServer.register({
          kind: 'exact',
          path: '/dsh-team-balancer/config',
          handler: async (req, res) => {
            if (!isTrustedRequest(req)) {
              writeJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            if (req.method !== 'POST') {
              writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            try {
              const body = JSON.parse(await readJsonBody(req))
              const patch = validatePatch(body)
              writeJson(res, 200, await applyPatch(patch))
            } catch (error) {
              writeJson(res, 400, { ok: false, error: describeError(error) })
            }
          },
        }),
      'team-balancer: /dsh-team-balancer/config route',
    )
    child.effect(
      () =>
        child.webServer.register({
          kind: 'exact',
          path: '/dsh-team-balancer/reset',
          handler: async (req, res) => {
            if (!isTrustedRequest(req)) {
              writeJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            if (req.method !== 'POST') {
              writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            try {
              writeJson(res, 200, await resetConfig())
            } catch (error) {
              writeJson(res, 500, { ok: false, error: describeError(error) })
            }
          },
        }),
      'team-balancer: /dsh-team-balancer/reset route',
    )
  })

  ctx.effect(() => () => {
    disposed = true
    offCreated()
    offDisposed()
    offRequest()
    offAdapters()
    for (const agent of [...guidanceFibers.keys()]) uninstallGuidance(agent)
    guidanceFibers.clear()
    invalidate()
  }, 'team-balancer.registrations()')

  logger.info(
    `team-balancer: mounted (enabled=${String(effective.enabled)}, includeSubagents=${String(effective.includeSubagents)}, ` +
      `autoTeam=${String(effective.autoTeam)}, spread=${String(effective.spread)}, ` +
      `capabilityRouting=${String(effective.capabilityRouting)}, emphasis=${String(effective.emphasis)}, ` +
      `pool=${effective.pool.map((entry) => `${entry.provider}/${entry.model}×${entry.weight}`).join(', ')}, ` +
      `assignments=${assignments.size}, store=${storePath})`,
  )
}

/** Write one JSON reply. */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Read a bounded JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw new Error('请求体为空')
  return text
}

/** Accept only the local Web page: loopback host and same-origin (or no Origin). */
function isTrustedRequest(req) {
  const host = req.headers.host
  if (!host) return false
  const hostname = host.split(':')[0]
  if (!isLoopbackHostname(hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Whether a host header names the local machine. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
