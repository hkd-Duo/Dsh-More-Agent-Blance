# How it works

This page describes the runtime design behind `dsh-plugin-team-balancer` so future
changes can be reviewed against the actual seams instead of guesses.

## Surfaces

```
┌────────────────────────────────────────────────────────────────┐
│ Client (browser)                                               │
│  sidebar.panellist  id=team-balancer      ← balance icon       │
│  main               key=team-balancer     ← full editor        │
│  plugins.bundle.config key=dsh-plugin-…   ← Plugins-page copy  │
│        │ fetch('/dsh-team-balancer/state')                     │
│        │ POST config / reset                                   │
└────────┼───────────────────────────────────────────────────────┘
         │ same-origin, loopback only
┌────────▼───────────────────────────────────────────────────────┐
│ Host plugin (team-balancer)                                    │
│  GET  /state   POST /config   POST /reset                      │
│  config store: $DSH_HOME/storages/team-balancer/config.json    │
│  agent/created  → assign sticky route + publish AgentOptions   │
│  agent/request  → force route on every model request           │
│  llm/adapters-updated → invalidate route/catalog caches        │
└────────────────────────────────────────────────────────────────┘
```

## Assignment

- A **child** is any Agent whose Session header carries `parentSession`; root Sessions
  (the Lead and the user's own chats) are never touched.
- Team teammates are detected through `ctx.agentTeams.tryMembership(agent)` and their
  ordinal is their index among teammate rows in `ctx.agentTeams.listMembers(root)`.
  The roster is durable Team state, so an ordinal survives cold resume and restart.
- Ordinary subagents (opt-in) use a process-local cursor.
- The route is `cycle[ordinal % cycleLength]` where `cycle` is generated from the
  configured weights with smooth weighted round robin, e.g. weights `2:1` produce
  `[0, 1, 0]`.
- The chosen route is written into the in-memory assignment map and published onto the
  child's `AgentOptions` (`provider`, `model`, optional `reasoningEffort`). That keeps
  the Team roster, the session model selector, and the system prompt's `{{model}}`
  variable consistent with the real route.

## Request routing

The route is fixed through one of two mechanisms, detected per Agent.

### DSH 0.2.2+ — `agent.model.select()` (primary)

The 0.2.2 loop captures the step model before prompt assembly and before
`agent/pre-step`, keeps it through retries, and rejects any route change proposed by the
`agent/request` waterfall. The plugin therefore selects the route while handling
`agent/created`, before the first step starts:

```js
agent.model.select({ provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
```

`AgentModel.select()` appends a durable `model/selection` event; the `modelSelection`
projection folds it into `pending`/`lastUsed`. That makes the choice visible to the
model and the UI (the `{{model}}` persona and the selector follow it), sticky across
steps and cold resumes, and idempotent on resume because selecting the same route is a
no-op. A same-route assignment preserves the inherited reasoning effort; a route change
omits it (or uses the route's configured effort).

### DSH ≤ 0.2.1 — `agent/request` fallback

When an Agent does not expose `agent.model`, the plugin keeps one Host-level waterfall
listener:

```js
ctx.on('agent/request', async (payload, next) => {
  const base = await next()
  const record = assignments.get(payload.agent.id) ?? await ensureAssignment(payload.agent)
  return record === undefined ? base : routeConfiguration(base, record)
})
```

- Same provider/model → the base configuration is returned unchanged, preserving the
  inherited reasoning effort and output cap.
- Different route → the listener returns only `{ provider, model }` plus an optional
  configured effort, so an inherited effort is not sent to a model that rejects it.
- On 0.2.2+ this listener returns the frozen configuration untouched, because the loop
  would reject a route change there.

## Config lifecycle

The UI writes through the Host routes, not through the profile patch:

1. `POST /config` validates the patch (booleans, 1–20 routes, exact provider/model,
   integer weight 1–100).
2. The override object `{enabled?, includeSubagents?, pool?}` is persisted atomically
   to `$DSH_HOME/storages/team-balancer/config.json`.
3. The in-memory effective config switches immediately; route/catalog caches are
   invalidated.
4. Live **idle** children are re-routed through the selection API (the recorded route on
   older cores); running children keep their current model; unloaded children re-derive
   their route from the durable roster ordinal when their Session resumes.

`POST /reset` deletes the override file and restores the bundle-patch defaults.

## Validation and degradation

- At assignment time each configured route is probed with
  `ctx.llm.resolveModelInfo(provider, model)`; results are cached for 60 seconds and
  invalidated on `llm/adapters-updated`.
- Only routable routes participate in the cycle, so an unconfigured provider (for
  example no `ZAI_API_KEY`) degrades the team to the remaining routes instead of
  failing teammate creation.
- Missing `agentTeams` means "no teammate detection": only the opt-in subagent path
  remains available.

## Why not the subagent tool's model-selection settings

`subagent-model-selection` constrains the official `subagent` tool. Team teammates are
created by the Team domain through the subagent **provider** seam, which does not carry
a model selection, so this plugin assigns the route at the Agent lifecycle seam
(`agent.model.select()` on 0.2.2+, the recorded route elsewhere). Both mechanisms can
coexist.

## Failure modes to keep in mind

| Situation | Behavior |
|---|---|
| Provider unmounted / model unknown | route skipped, warning logged; child keeps the inherited model if nothing routable |
| UI save while a teammate runs | running teammate keeps the model; idle/new ones use the new pool |
| App restart | overrides persist in JSON; assignments rebuild from the durable roster ordinal |
| Child session opened in the Web UI | model selection falls back to the logged `request/header` route, which matches this plugin's route |
