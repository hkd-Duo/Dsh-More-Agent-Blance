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
 *   POST /dsh-team-balancer/config  -> save {enabled, includeSubagents, pool}
 *   POST /dsh-team-balancer/reset   -> drop stored overrides, back to bundle defaults
 *
 * Routing mechanism: `agent/created` assigns every child Agent a sticky route
 * from the weighted pool; one Host `agent/request` listener forces that route
 * on each model request of that child, and the child's AgentOptions are updated
 * so the Team roster, session selector, and {{model}} persona report it. Root
 * Sessions (the Lead and the user's own chats) are never rerouted.
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

/** Bundle-patch defaults used until the user saves overrides. */
const DEFAULT_POOL = [
  { provider: 'deepseek-official', model: 'deepseek-flash', weight: 1 },
  { provider: 'zai', model: 'glm-5.3-flash', weight: 1 },
]

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
  if (Array.isArray(source.pool)) config.pool = dedupePool(source.pool)
  else if (options.partial !== true) config.pool = dedupePool(DEFAULT_POOL)
  if (config.pool !== undefined && config.pool.length === 0 && options.partial !== true) config.pool = dedupePool(DEFAULT_POOL)
  return config
}

/**
 * Validate an incoming config patch from the Web page.
 * @param {unknown} body parsed JSON body.
 * @returns {{enabled?: boolean, includeSubagents?: boolean, pool?: object[]}}
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
 * Build the smooth weighted round-robin pick sequence for a pool.
 * @param {Array<{weight: number}>} pool
 * @returns {number[]} pool indexes covering exactly one total-weight cycle.
 */
function weightedCycle(pool) {
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0)
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
  const storePath = join(resolveDshHome(), 'storages', STORE_DIR, 'config.json')

  /** @type {Map<string, object>} agent id -> sticky route record */
  const assignments = new Map()
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

  /** Merge base config with stored partial overrides. */
  function mergeConfig(base, overrides) {
    return {
      enabled: overrides.enabled === undefined ? base.enabled : overrides.enabled,
      includeSubagents: overrides.includeSubagents === undefined ? base.includeSubagents : overrides.includeSubagents,
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
    const signature = JSON.stringify(usable.map((route) => [route.provider, route.model, route.weight]))
    if (routeCache !== undefined && routeCache.signature === signature) return routeCache
    const cycle = weightedCycle(usable)
    routeCache = { signature, usable, cycle }
    return routeCache
  }

  /** Route for the ordinal-th balanced child. */
  async function routeForOrdinal(ordinal) {
    const cached = await currentCycle()
    if (cached.usable.length === 0) return undefined
    return cached.usable[cached.cycle[ordinal % cached.cycle.length]]
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

  /** Assign and remember one child Agent's route. */
  async function ensureAssignment(agent) {
    if (disposed || effective.enabled !== true) return undefined
    const existing = assignments.get(agent.id)
    if (existing !== undefined) return existing
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
    const route = await routeForOrdinal(ordinal)
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
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(teammateName === undefined ? {} : { teammateName }),
      assignedAt: now(),
    }
    assignments.set(agent.id, record)
    publishRoute(agent, record)
    logger.info(
      `team-balancer: ${kind} ${teammateName === undefined ? String(agent.id).slice(0, 8) : `"${teammateName}"`} -> ${record.provider}/${record.model}` +
        `${usesAgentModelApi(agent) ? ' (agent.model.select)' : ' (agent/request)'}`,
    )
    return record
  }

  /**
   * Re-route children that can still change their step model: live idle Agents
   * are updated through the selection API, running ones keep the current model,
   * and unloaded ones are re-assigned when their Session resumes.
   */
  async function rebalanceIdleAssignments() {
    const agents = ctx.get('agents')
    for (const [agentId, record] of [...assignments]) {
      const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(agentId) : undefined
      if (agent === undefined) {
        assignments.delete(agentId)
        continue
      }
      if (agent.status === 'running') continue
      const route = await routeForOrdinal(record.ordinal)
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
    }
  }

  /** Snapshot for the Web page. */
  async function stateSnapshot() {
    const [providers, routes] = await Promise.all([providerCatalog(), inspectedPool()])
    return {
      ok: true,
      pluginVersion: '0.2.0',
      enabled: effective.enabled,
      includeSubagents: effective.includeSubagents,
      pool: effective.pool,
      defaults: baseConfig,
      stored,
      storagePath: storePath,
      routes,
      providers,
      assignments: [...assignments.values()].map((record) => ({ ...record })),
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
      if (agent === undefined || parentSessionOf(agent) === undefined) return
      await ensureAssignment(agent)
    } catch (error) {
      logger.warn(`team-balancer: failed to assign a route: ${describeError(error)}`)
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

  const offCreated = ctx.on('agent/created', onCreated)
  const offDisposed = ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent !== undefined) assignments.delete(agent.id)
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
    assignments.clear()
    invalidate()
  }, 'team-balancer.registrations()')

  logger.info(
    `team-balancer: mounted (enabled=${String(effective.enabled)}, includeSubagents=${String(effective.includeSubagents)}, ` +
      `pool=${effective.pool.map((entry) => `${entry.provider}/${entry.model}×${entry.weight}`).join(', ')}, store=${storePath})`,
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
