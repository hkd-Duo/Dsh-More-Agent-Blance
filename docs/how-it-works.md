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

## Request rewriting

One Host-level waterfall listener is registered:

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
  configured effort, so an inherited effort (for example DeepSeek's `high`) is not sent
  to a model that rejects it.
- The loop logs the resulting `request/header`, which is the durable evidence of the
  actual route.

## Config lifecycle

The UI writes through the Host routes, not through the profile patch:

1. `POST /config` validates the patch (booleans, 1–20 routes, exact provider/model,
   integer weight 1–100).
2. The override object `{enabled?, includeSubagents?, pool?}` is persisted atomically
   to `$DSH_HOME/storages/team-balancer/config.json`.
3. The in-memory effective config switches immediately; route/catalog caches are
   invalidated.
4. Assignments of **idle** children are dropped so they re-derive with the new cycle on
   their next request. Running children keep their current route until they go idle.

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
a model selection, so this plugin enforces the route at the `agent/request` seam that
every delegated Agent passes through. Both mechanisms can coexist.

## Failure modes to keep in mind

| Situation | Behavior |
|---|---|
| Provider unmounted / model unknown | route skipped, warning logged; child keeps the inherited model if nothing routable |
| UI save while a teammate runs | running teammate keeps the model; idle/new ones use the new pool |
| App restart | overrides persist in JSON; assignments rebuild from the durable roster ordinal |
| Child session opened in the Web UI | model selection falls back to the logged `request/header` route, which matches this plugin's route |
