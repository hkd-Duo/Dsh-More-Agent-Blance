// Host-half smoke test for dsh-plugin-team-balancer: loads the real module,
// mounts it on a fake Cordis context, and exercises assignment + HTTP handlers.
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'tbz-home-'))
process.env.DSH_HOME = home

const moduleUrl = new URL('../index.js', import.meta.url).href
const plugin = await import(moduleUrl)
const assert = (condition, message) => {
  if (!condition) throw new Error('ASSERT FAILED: ' + message)
  console.log('ok -', message)
}

// ---- fake services -------------------------------------------------------
const promptSections = new Map()
const promptScope = {
  systemPrompt: {
    section(section) {
      promptSections.set(section.name, section)
      return () => {
        if (promptSections.get(section.name) === section) promptSections.delete(section.name)
      }
    },
    getSectionOrder(name) {
      return name === 'TEAM_POLICY' ? 600 : 0
    },
  },
}
const lead = {
  id: 'lead-1',
  status: 'running',
  options: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  session: { header: {} },
  ctx: {
    inject(names, callback) {
      if (!names.every((name) => services[name] !== undefined)) return undefined
      callback(promptScope)
      return {
        dispose() {
          promptSections.clear()
        },
      }
    },
  },
}
const agents = new Map([[lead.id, lead]])
agents.list = () => [...agents.values()]
agents.roots = () => [...agents.values()].filter((agent) => agent.session?.header?.parentSession === undefined)
const teammates = [] // roster entries besides the lead
const liveRoster = () => [{ id: lead.id, name: 'lead', role: 'lead' }, ...teammates]

const llm = {
  listProviders: () => [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'zai', name: 'zai' },
  ],
  listModels: async (provider) =>
    provider === 'zai'
      ? [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' }, { id: 'glm-5.3', name: 'GLM-5.3' }]
      : [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
  resolveModelInfo: async (provider, model) => {
    if (provider === 'zai' && (model === 'glm-5.3-flash' || model === 'glm-5.3')) return { provider, model }
    if (provider === 'deepseek-official' && model === 'deepseek-flash') return { provider, model }
    throw new Error('unknown route ' + provider + '/' + model)
  },
}

const agentTeams = {
  tryMembership(agent) {
    if (agent.id === lead.id) return { root: lead, role: 'lead', name: 'lead', id: 'team-1' }
    const member = liveRoster().find((row) => row.id === agent.id)
    if (member === undefined) return { root: agent, role: 'lead', name: 'lead', id: agent.id }
    return { root: lead, role: 'teammate', name: member.name, id: 'team-1' }
  },
  listMembers() {
    return liveRoster()
  },
}

const routes = []
const webServer = {
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}

const handlers = new Map()
const services = { agents, llm, agentTeams, webServer, systemPrompt: promptScope.systemPrompt }
function fakeChild(extra = {}) {
  return {
    logger: console,
    get: (name) => services[name],
    effect: (fn) => {
      const dispose = fn()
      return dispose
    },
    ...extra,
  }
}
const ctx = {
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  get: (name) => services[name],
  on(name, listener) {
    const list = handlers.get(name) ?? []
    list.push(listener)
    handlers.set(name, list)
    return () => {
      const current = handlers.get(name) ?? []
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
    }
  },
  effect(fn) {
    return fn()
  },
  inject(names, callback) {
    if (names.every((name) => services[name] !== undefined)) callback(fakeChild({ webServer }))
  },
}

async function emit(name, payload) {
  for (const listener of handlers.get(name) ?? []) await listener(payload)
}
async function request(agent, base) {
  let result = base
  const listeners = handlers.get('agent/request') ?? []
  const run = async (index) => {
    if (index >= listeners.length) return result
    return listeners[index]({ agent }, async () => {
      const next = await run(index + 1)
      return next
    })
  }
  return run(0)
}

// ---- mount ---------------------------------------------------------------
plugin.apply(ctx, {
  enabled: true,
  includeSubagents: false,
  pool: [
    { provider: 'deepseek-official', model: 'deepseek-flash', weight: 1 },
    { provider: 'zai', model: 'glm-5.3-flash', weight: 1 },
  ],
})
assert(plugin.name === 'team-balancer', 'plugin exports a name')
assert(typeof plugin.apply === 'function', 'plugin exports apply')
assert(routes.length === 3, 'three HTTP routes registered when webServer is present')

// ---- Lead guidance -------------------------------------------------------
assert(promptSections.has('team-balancer:policy'), 'mount installs the Lead delegation policy section')
const policySection = promptSections.get('team-balancer:policy')
assert(policySection.order === 601, 'policy section sits just after TEAM_POLICY (order 601)')
const policyText = policySection.text()
assert(policyText.includes('spawn_teammate') && policyText.includes('2-4 teammates'), 'policy tells the Lead to split work into 2-4 teammates')
assert(policyText.includes('deepseek-official/deepseek-flash') && policyText.includes('zai/glm-5.3-flash'), 'policy names the weighted pool (no manual model choice)')

// ---- teammate A: ordinal 0 -> DeepSeek ----------------------------------
const a = { id: 'agent-a', status: 'running', options: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, session: { header: { parentSession: lead.id } }, ctx: {} }
agents.set(a.id, a)
teammates.push({ id: a.id, name: 'alpha', role: 'teammate' })
await emit('agent/created', { agent: a })
assert(a.options.model === 'deepseek-flash', 'teammate A keeps DeepSeek (ordinal 0)')
assert(a.options.reasoningEffort === 'high', 'same route keeps the inherited reasoning effort')

// ---- teammate B: ordinal 1 -> GLM ---------------------------------------
const b = { id: 'agent-b', status: 'idle', options: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, session: { header: { parentSession: lead.id } }, ctx: {} }
agents.set(b.id, b)
teammates.push({ id: b.id, name: 'beta', role: 'teammate' })
await emit('agent/created', { agent: b })
assert(b.options.provider === 'zai' && b.options.model === 'glm-5.3-flash', 'teammate B is assigned GLM (ordinal 1)')
assert(b.options.reasoningEffort === undefined, 'switching provider drops the inherited reasoning effort')

// ---- request routing -----------------------------------------------------
const requestA = await request(a, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 256000 })
assert(requestA.provider === 'deepseek-official' && requestA.reasoningEffort === 'high', 'teammate A request keeps DeepSeek + effort')
const requestB = await request(b, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
assert(requestB.provider === 'zai' && requestB.model === 'glm-5.3-flash' && requestB.reasoningEffort === undefined, 'teammate B request is rewritten to GLM without inherited effort')
const requestLead = await request(lead, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
assert(requestLead.provider === 'deepseek-official' && requestLead.reasoningEffort === 'high', 'Lead request is untouched')

// ---- HTTP state ----------------------------------------------------------
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(text) { this.body = text },
  }
}
function fakeRequest(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: { host: '127.0.0.1:7995' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}
const stateRoute = routes.find((route) => route.path === '/dsh-team-balancer/state')
const configRoute = routes.find((route) => route.path === '/dsh-team-balancer/config')
const resetRoute = routes.find((route) => route.path === '/dsh-team-balancer/reset')
assert(stateRoute && configRoute && resetRoute, 'expected HTTP routes exist')

let res = fakeResponse()
await stateRoute.handler(fakeRequest('GET'), res)
const state0 = JSON.parse(res.body)
assert(res.status === 200 && state0.ok === true, 'GET state succeeds')
assert(state0.pool.length === 2, 'state reports two pool routes')
assert(state0.assignments.length === 2, 'state reports two live assignments')
assert(state0.providers.some((provider) => provider.id === 'zai' && provider.models.length === 2), 'state lists zai models for the UI')
assert(state0.routes.every((route) => route.available === true), 'both configured routes are available')
assert(state0.pluginVersion === '0.3.0', 'state reports the plugin version (proves the migrated code is running)')
assert(state0.autoTeam === true && state0.spread === true, 'state exposes autoTeam and spread defaults')
assert(state0.capabilityRouting === true && state0.emphasis === 'auto', 'state exposes capabilityRouting and emphasis defaults')
const glmCapabilities = state0.capabilities.find((entry) => entry.provider === 'zai')?.tags ?? []
const deepseekCapabilities = state0.capabilities.find((entry) => entry.provider === 'deepseek-official')?.tags ?? []
assert(glmCapabilities.includes('vision'), 'state marks GLM as a vision-capable route')
assert(deepseekCapabilities.includes('code'), 'state marks DeepSeek as a code-capable route')
assert(state0.guidance.installed === 1 && state0.guidance.renders >= 1, 'state reports the Lead policy as installed and rendered')
assert(existsSync(join(home, 'storages', 'team-balancer', 'assignments.json')), 'assignments persisted under DSH_HOME')
const savedAssignments = JSON.parse(readFileSync(join(home, 'storages', 'team-balancer', 'assignments.json'), 'utf8'))
assert(
  Array.isArray(savedAssignments) && savedAssignments.some((record) => record.agentId === 'agent-a' && record.provider === 'deepseek-official'),
  'persisted assignment records carry agent id and route',
)

// ---- save a new weighted pool -------------------------------------------
res = fakeResponse()
await configRoute.handler(fakeRequest('POST', {
  pool: [
    { provider: 'zai', model: 'glm-5.3-flash', weight: 2 },
    { provider: 'deepseek-official', model: 'deepseek-flash', weight: 1 },
  ],
}), res)
const state1 = JSON.parse(res.body)
assert(res.status === 200 && state1.pool[0].provider === 'zai' && state1.pool[0].weight === 2, 'POST config stores the new weighted pool')
assert(existsSync(join(home, 'storages', 'team-balancer', 'config.json')), 'overrides persisted under DSH_HOME')
assert(JSON.parse(readFileSync(join(home, 'storages', 'team-balancer', 'config.json'), 'utf8')).pool[0].weight === 2, 'persisted JSON matches the saved pool')
assert(state1.assignments.some((record) => record.agentId === b.id && record.model === 'deepseek-flash'), 'idle teammate B is re-routed live to DeepSeek under the new 2:1 cycle')
assert(b.options.model === 'deepseek-flash', 'idle teammate B AgentOptions follow the re-route')
assert(state1.assignments.some((record) => record.agentId === a.id), 'running teammate A keeps its assignment')

// ---- ordinal with the new weights: teammate C -> GLM (2:1 cycle) --------
const c = { id: 'agent-c', status: 'running', options: { provider: 'deepseek-official', model: 'deepseek-flash' }, session: { header: { parentSession: lead.id } }, ctx: {} }
agents.set(c.id, c)
teammates.push({ id: c.id, name: 'gamma', role: 'teammate' })
await emit('agent/created', { agent: c })
assert(c.options.provider === 'zai', 'teammate C follows the new 2:1 cycle (ordinal 2 -> GLM)')

// ---- autoTeam toggle disables the Lead policy text ------------------------
res = fakeResponse()
await configRoute.handler(fakeRequest('POST', { autoTeam: false }), res)
assert(res.status === 200 && JSON.parse(res.body).autoTeam === false, 'autoTeam can be turned off')
assert(policySection.text() === '', 'policy section renders nothing when autoTeam is off')
res = fakeResponse()
await configRoute.handler(fakeRequest('POST', { autoTeam: true }), res)
assert(JSON.parse(res.body).autoTeam === true, 'autoTeam can be turned back on')

// ---- invalid save rejected ----------------------------------------------
res = fakeResponse()
await configRoute.handler(fakeRequest('POST', { pool: [] }), res)
assert(res.status === 400, 'empty pool is rejected with 400')

// ---- reset ---------------------------------------------------------------
res = fakeResponse()
await resetRoute.handler(fakeRequest('POST'), res)
const state2 = JSON.parse(res.body)
assert(res.status === 200 && state2.pool[0].provider === 'deepseek-official' && state2.pool[0].weight === 1, 'reset restores the bundle defaults')
assert(!existsSync(join(home, 'storages', 'team-balancer', 'config.json')), 'reset removes the stored overrides')

// ---- DeepSeek Harness 0.2.2+: route through agent.model.select() ---------
// The 0.2.2 loop fixes the step model before prompt assembly and rejects any
// `agent/request` route change, so the plugin must select before that point.
function modelAgent(id, initialSelection) {
  let selection = { ...initialSelection }
  const calls = []
  const agent = {
    id,
    status: 'running',
    options: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
    session: { header: { parentSession: lead.id } },
    ctx: {},
    calls,
  }
  agent.model = {
    current: () => ({ ...selection }),
    select: (next) => {
      calls.push({ ...next })
      selection = { ...next }
      agent.options.provider = next.provider
      agent.options.model = next.model
      if (next.reasoningEffort === undefined) delete agent.options.reasoningEffort
      else agent.options.reasoningEffort = next.reasoningEffort
    },
  }
  return agent
}

const d = modelAgent('agent-d', { provider: 'deepseek-official', model: 'deepseek-flash' })
agents.set(d.id, d)
teammates.push({ id: d.id, name: 'delta', role: 'teammate' })
await emit('agent/created', { agent: d })
assert(d.calls.length === 1 && d.calls[0].provider === 'zai' && d.calls[0].model === 'glm-5.3-flash', 'new-API teammate D selects GLM through agent.model.select()')
const requestD = await request(d, { provider: 'zai', model: 'glm-5.3-flash' })
assert(requestD.provider === 'zai' && requestD.model === 'glm-5.3-flash', 'new-API request keeps the fixed selection (agent/request is not rewritten)')

const e = modelAgent('agent-e', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
agents.set(e.id, e)
teammates.push({ id: e.id, name: 'epsilon', role: 'teammate' })
await emit('agent/created', { agent: e })
assert(
  e.calls.length === 1 && e.calls[0].provider === 'deepseek-official' && e.calls[0].reasoningEffort === 'high',
  'new-API same-route assignment keeps the inherited reasoning effort',
)

// ---- spread-first: 1:2 pool starts with one of each provider -------------
res = fakeResponse()
await configRoute.handler(fakeRequest('POST', {
  spread: true,
  pool: [
    { provider: 'deepseek-official', model: 'deepseek-flash', weight: 1 },
    { provider: 'zai', model: 'glm-5.3-flash', weight: 2 },
  ],
}), res)
assert(res.status === 200, 'spread config saved')
const f = { id: 'agent-f', status: 'idle', options: { provider: 'deepseek-official', model: 'deepseek-flash' }, session: { header: { parentSession: lead.id } }, ctx: {} }
agents.set(f.id, f)
teammates.push({ id: f.id, name: 'zeta', role: 'teammate' })
await emit('agent/created', { agent: f })
assert(f.options.provider === 'zai', 'spread-first gives ordinal 5 GLM (1:2 cycle is DeepSeek, GLM, GLM)')

// ---- capability routing: vision names -> GLM, code names -> DeepSeek ----
res = fakeResponse()
await configRoute.handler(fakeRequest('POST', {
  capabilityRouting: true,
  emphasis: 'auto',
  pool: [
    { provider: 'deepseek-official', model: 'deepseek-flash', weight: 1 },
    { provider: 'zai', model: 'glm-5.3-flash', weight: 2 },
  ],
}), res)
assert(res.status === 200, 'capability routing config saved')
const g = { id: 'agent-g', status: 'idle', options: { provider: 'deepseek-official', model: 'deepseek-flash' }, session: { header: { parentSession: lead.id } }, ctx: {} }
agents.set(g.id, g)
teammates.push({ id: g.id, name: 'vision-ocr', role: 'teammate' })
await emit('agent/created', { agent: g })
assert(g.options.provider === 'zai' && g.options.model === 'glm-5.3-flash', 'vision-* teammate routes to GLM even when the weighted cycle would pick DeepSeek')
const h = { id: 'agent-h', status: 'idle', options: { provider: 'zai', model: 'glm-5.3-flash' }, session: { header: { parentSession: lead.id } }, ctx: {} }
agents.set(h.id, h)
teammates.push({ id: h.id, name: 'code-table', role: 'teammate' })
await emit('agent/created', { agent: h })
assert(h.options.provider === 'deepseek-official' && h.options.model === 'deepseek-flash', 'code-* teammate routes to DeepSeek')

// ---- emphasis fallback for unrecognized names ---------------------------
res = fakeResponse()
await configRoute.handler(fakeRequest('POST', { emphasis: 'code' }), res)
assert(res.status === 200, 'emphasis=code saved')
const i = { id: 'agent-i', status: 'idle', options: { provider: 'zai', model: 'glm-5.3-flash' }, session: { header: { parentSession: lead.id } }, ctx: {} }
agents.set(i.id, i)
teammates.push({ id: i.id, name: 'omega', role: 'teammate' })
await emit('agent/created', { agent: i })
assert(i.options.provider === 'deepseek-official', 'unrecognized teammate follows the code emphasis fallback')
res = fakeResponse()
await configRoute.handler(fakeRequest('POST', { emphasis: 'vision' }), res)
assert(res.status === 200, 'emphasis=vision saved')
const j = { id: 'agent-j', status: 'idle', options: { provider: 'deepseek-official', model: 'deepseek-flash' }, session: { header: { parentSession: lead.id } }, ctx: {} }
agents.set(j.id, j)
teammates.push({ id: j.id, name: 'sigma', role: 'teammate' })
await emit('agent/created', { agent: j })
assert(j.options.provider === 'zai', 'unrecognized teammate follows the vision emphasis fallback')
res = fakeResponse()
await configRoute.handler(fakeRequest('POST', { emphasis: 'graphics' }), res)
assert(res.status === 400, 'unknown emphasis is rejected with 400')

// ---- disposal ------------------------------------------------------------
for (const disposers of handlers.values()) for (const listener of [...disposers]) void listener
rmSync(home, { recursive: true, force: true })
console.log('\nALL HOST CHECKS PASSED')
