# dsh-plugin-team-balancer

[中文](README.zh.md) · [How it works](docs/how-it-works.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [GitHub](https://github.com/hkd-Duo/More-Agent-Blance)

> **Weighted multi-AI balancing for DeepSeek Harness Agent Teams.**
> Teammates and delegated subagents rotate across DeepSeek, GLM (and any other mounted
> provider) by weight, while the Lead keeps its own model. Everything — balancing
> style presets, the weighted model pool, and live route assignments — is edited from
> a first-class panel in the Web sidebar.

- Package: `dsh-plugin-team-balancer`
- Loader row: `team-balancer`
- Host + Client halves, zero runtime dependencies, MIT

---

## Why

Agent Teams are powerful, but every delegated child inherits the Lead's model. In a
profile with DeepSeek **and** GLM configured, the whole team still runs on one
provider: one bill, one rate limit, one failure mode, and the other providers never
participate.

This plugin turns that into an explicit, visible policy: a weighted pool of
provider/model routes, assigned to delegated children in creation order, with the
Lead untouched.

## Features

- **Sidebar panel** — a balance icon in the left rail opens the full editor; no
  backend YAML editing.
- **Balancing styles** — one click applies: even rotation (1:1), DeepSeek-first (2:1),
  GLM-first (1:2), DeepSeek-only, GLM-only. Fine-tune weights afterwards.
- **Custom model pool** — up to 20 provider/model routes, weight 1–100 each; any
  provider the Host mounts is selectable, with its advertised models.
- **Live assignments table** — see the exact `provider/model` each teammate and
  subagent currently runs on.
- **Save applies immediately** — no app restart; running teammates keep their model,
  idle and new children are rebalanced on their next request.
- **Graceful degradation** — a route whose provider or model is not routable (missing
  key, unmounted adapter) is skipped with a warning instead of failing teammate
  creation.
- **Durable stickiness** — a teammate's ordinal comes from the durable Team roster, so
  the same child keeps the same route across turns, cold resumes and restarts.
- **Bundle-page editor too** — the same editor is rendered on
  Settings → Plugins → *dsh-plugin-team-balancer*.

## Install

### Web UI

1. Open **Settings → Plugins → Plugin Manager → Add plugin**.
2. Enter the GitHub address:
   `github:hkd-Duo/More-Agent-Blance`
3. Confirm, wait for the install, then refresh the page (`Ctrl+R`) if the sidebar
   icon does not appear immediately.

### CLI

```bash
dsh plugin --profile <profile> add github:hkd-Duo/More-Agent-Blance
```

### Local development

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-plugin-team-balancer
```

The package is a self-contained bundle: the patch inserts the `team-balancer` row,
and the bundle's `dsh.client` declaration adds the sidebar panel and Plugins-page
editor. No separate bundle is needed.

## Use

1. Click the **balance icon** in the left sidebar (after the built-in panels).
2. Pick a **balancing style**, or edit the pool: provider, model, weight, add/remove.
3. Toggle *Enable balancing* and *Balance ordinary subagents too* if needed.
4. Press **Save and apply**.
5. Ask the Lead to create teammates as usual; the *Current assignments* table shows
   which provider each one runs on.

The Lead and the user's own chats are never rerouted.

## Configuration

Factory defaults live in [cordis.patch.yml](cordis.patch.yml). Values saved from the
UI override them and are stored at:

```text
$DSH_HOME/storages/team-balancer/config.json
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. When off, delegated children inherit the Lead model. |
| `includeSubagents` | `false` | Also balance ordinary `subagent` / `subagent_fork` children. |
| `pool[].provider` | — | LLM provider route id, e.g. `deepseek-official`, `zai`. |
| `pool[].model` | — | Model id under that provider. |
| `pool[].weight` | `1` | Positive integer 1–100 used by smooth weighted round robin. |
| `pool[].reasoningEffort` | unset | Optional fixed effort for the route; when unset, switching providers clears the inherited effort. |

Assignment rule: teammate ordinal `N` (creation order in the durable Team roster)
receives `cycle[N % cycleLength]`, where `cycle` is generated from the weights with
smooth weighted round robin. Example `deepseek 2 : glm 1` → `[deepseek, glm, deepseek]`.

Host HTTP routes (loopback + same-origin only):

| Route | Method | Purpose |
|---|---|---|
| `/dsh-team-balancer/state` | GET | effective config, providers/models, route availability, live assignments |
| `/dsh-team-balancer/config` | POST | validate, persist and live-apply `{enabled, includeSubagents, pool}` |
| `/dsh-team-balancer/reset` | POST | drop stored overrides, back to bundle defaults |

## How it works

See [docs/how-it-works.md](docs/how-it-works.md) for the full data flow. In short:

1. `agent/created` assigns each delegated child a sticky route, publishes it onto
   `AgentOptions`, and fixes it through `agent.model.select()` on DSH 0.2.2+ (the
   loop freezes the step model before prompt assembly there).
2. On DSH 0.2.2+ routing lives entirely in that selection; on older cores a Host-level
   `agent/request` waterfall listener applies the same route as a fallback.
3. Root Sessions are skipped; the pool is validated with `ctx.llm.resolveModelInfo`
   (60 s cache) and recomputed when adapters change.

## Development

No build step; plain ESM, two Node built-ins only.

```bash
npm run check   # node --check on both halves
npm test        # fake-Cordis host test + fake-module-loader client test
```

Both test files run with plain Node (>= 20) and no dependencies:

- `tools/host-test.mjs` — mounts the real Host half on a fake context, then verifies
  assignment, request rewriting, HTTP save/reset/validation and persistence.
- `tools/client-test.mjs` — executes the real client bundle with a fake module loader,
  React stub and fake context, then verifies all three slot registrations.

## Compatibility

- DeepSeek Harness desktop/Web profile with the Agent Teams experimental bundle
  (`@deepseek-ai/dsh-experimental-agent-team-profile`) mounted.
- **DSH 0.2.2+**: routing uses `agent.model.select()`; this is the supported path.
- **DSH ≤ 0.2.1**: the plugin detects the missing `agent.model` API and falls back to
  the `agent/request` waterfall route rewrite.
- The sidebar panel needs the Web UI; in a headless/CLI-only profile the Host half
  still balances and its HTTP routes remain available.

## Known limitations

- **Idle roster display** — the core Team roster falls back to the Lead's model for
  members that are unloaded; a running teammate shows its real model. The *Current
  assignments* table and the child session's `request/header` are authoritative.
- **No failover** — a provider that fails mid-run is handled by the existing
  `llm-retry` policy; this plugin does not retry on another route.
- **Fork children** — switching provider degrades foreign replay metadata to plain
  history (existing Harness behavior); the conversation continues.
- **Install-before-request only** — a request already in flight is never switched
  mid-step.

## License

[MIT](LICENSE) © hkd-Duo
