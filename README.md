# dsh-plugin-team-balancer

[![CI](https://github.com/hkd-Duo/Dsh-More-Agent-Blance/actions/workflows/ci.yml/badge.svg)](https://github.com/hkd-Duo/Dsh-More-Agent-Blance/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/v/tag/hkd-Duo/Dsh-More-Agent-Blance?label=version)](https://github.com/hkd-Duo/Dsh-More-Agent-Blance/tags)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1%2B-blue)](docs/install.md#9-compatibility)

[中文](README.zh.md) · [Install guide](docs/install.md) · [How it works](docs/how-it-works.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [GitHub](https://github.com/hkd-Duo/Dsh-More-Agent-Blance)

> **Weighted multi-AI balancing for DeepSeek Harness Agent Teams.**
> Teammates and delegated subagents rotate across DeepSeek, GLM (and any other mounted
> provider) by weight, while the Lead keeps its own model. The Lead also receives a
> delegation policy that turns substantial tasks into 2-4 parallel teammates instead of
> one serial context. Everything — balancing style presets, the weighted model pool, and
> live route assignments — is edited from a first-class panel in the Web sidebar.

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

- **Lead delegation policy** — root Agents get a short system-prompt section telling
  them to split requests with two or more independent workstreams across 2-4
  `spawn_teammate` calls with disjoint write scopes, and to leave model choice to the
  balancer. Small or tightly coupled tasks stay single-agent. Can be turned off.
- **Spread before repeat** — the first rotation gives every configured provider one slot,
  so the first two teammates already run on different models even with a 2:1 weight.
- **Idle-first for parallel work** — a new teammate goes to a provider that is not
  currently running work. If GLM is busy and DeepSeek is idle, the next parallel child
  takes DeepSeek instead of repeating GLM. Capability-matched idle routes win first; when
  everything is busy the normal weighted pick resumes.
- **Capability-aware routing** — a teammate named `vision-*`, `image-*` or `ui-*`
  prefers the vision-capable route (GLM by default); `code-*`, `table-*`, `data-*` or
  `api-*` prefers the code/table route (DeepSeek). For unrecognized names an
  `emphasis` option picks the fallback: auto, balanced, code-first or vision-first.
- **Durable assignments** — routes are stored in `assignments.json` and re-applied when a
  restart or plugin reload adopts live Agents; dormant teammates resume on the same
  route.
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

> Step-by-step tutorial (providers, first-run verification, upgrades, uninstall and FAQ):
> **[docs/install.md](docs/install.md)**.

### Desktop app (Plugin Manager)

1. Open the **Plugins** panel in the left sidebar (or **Settings → Plugins**).
2. Open **Plugin Manager → Add plugin** and enter
   `github:hkd-Duo/Dsh-More-Agent-Blance`.
3. Confirm and wait for the install, then press **Ctrl+R**. A **balance icon** appears in
   the left rail; if not, check that the bundle and its row are enabled in
   **Settings → Plugins**, then refresh again.

### CLI (non-Electron profiles only)

The desktop `desktop` profile is Electron-managed and must use the Plugin Manager. For a
self-managed Web/TUI profile:

```bash
dsh plugin --profile <profile> add github:hkd-Duo/Dsh-More-Agent-Blance
```

### Local development

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/Dsh-More-Agent-Blance
```

The package is a self-contained bundle: the patch inserts the `team-balancer` row, and
the bundle's `dsh.client` declaration adds the sidebar panel and Plugins-page editor. No
separate bundle is needed.

## Use

1. Click the **balance icon** in the left sidebar (after the built-in panels).
2. Pick a **balancing style**, or edit the pool: provider, model, weight, add/remove.
3. Toggle *Enable balancing*, *Lead splits work across teammates*, *Spread providers
   before repeating*, *New tasks prefer an idle provider*, *Match models to task type*,
   and *Balance ordinary subagents too* as needed. With capability routing on, pick the
   fallback *emphasis* for unrecognized names (auto, balanced, code-first or
   vision-first).
4. Press **Save and apply**.
5. Ask the Lead to do a task with independent parts; with the delegation policy on it
   creates several teammates, and the *Current assignments* table shows which provider
   each one runs on. For image/visual work have the Lead name the teammate `vision-*`;
   for code or tables use `code-*` / `table-*` and the balancer matches the model.

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
| `autoTeam` | `true` | Add the Lead delegation policy that splits substantial tasks across 2-4 teammates. |
| `spread` | `true` | First rotation gives every pool route one slot before weights repeat. |
| `idleFirst` | `true` | Send a new parallel teammate to a provider that is not currently running work. |
| `capabilityRouting` | `true` | Route vision/UI teammates to GLM and code/table teammates to DeepSeek by name. |
| `emphasis` | `auto` | Fallback when a name reveals nothing: `auto`, `balanced`, `code`, `vision`. |
| `includeSubagents` | `false` | Also balance ordinary `subagent` / `subagent_fork` children. |
| `pool[].provider` | — | LLM provider route id, e.g. `deepseek-official`, `zai`. |
| `pool[].model` | — | Model id under that provider. |
| `pool[].weight` | `1` | Positive integer 1–100 used by smooth weighted round robin. |
| `pool[].reasoningEffort` | unset | Optional fixed effort for the route; when unset, switching providers clears the inherited effort. |

Assignment rule: teammate ordinal `N` (creation order in the durable Team roster)
receives `cycle[N % cycleLength]`. With `spread`, the cycle contains every route once
first, then fills the remaining weight slots: `deepseek 1 : glm 2` → `[deepseek, glm, glm]`.
With `spread` off it is plain smooth weighted round robin: `[glm, glm, deepseek]`.
With `idleFirst` on, a new child first looks for a route whose provider has no running
child; if the preferred route is busy and another provider is idle, the idle provider is
used. This applies only at creation time — rebalances and live teammates keep their
route.

Host HTTP routes (loopback + same-origin only):

| Route | Method | Purpose |
|---|---|---|
| `/dsh-team-balancer/state` | GET | effective config, providers/models, route availability, live assignments |
| `/dsh-team-balancer/config` | POST | validate, persist and live-apply `{enabled, autoTeam, spread, idleFirst, capabilityRouting, emphasis, includeSubagents, pool}` |
| `/dsh-team-balancer/reset` | POST | drop stored overrides, back to bundle defaults |

## How it works

See [docs/how-it-works.md](docs/how-it-works.md) for the full data flow. In short:

1. `agent/created` assigns each delegated child a sticky route (idle-first when another
   provider is currently busy), publishes it onto `AgentOptions`, and fixes it through
   `agent.model.select()` on DSH 0.2.2+ (the loop freezes the step model before prompt
   assembly there).
2. On DSH 0.2.2+ routing lives entirely in that selection; on older cores a Host-level
   `agent/request` waterfall listener applies the same route as a fallback.
3. On mount the plugin adopts live Agents (`agents.list()`): root Agents receive the
   delegation policy section through their own `systemPrompt` scope, and children that
   entered before the plugin loaded get their persisted route back.
4. Assignments are written to `$DSH_HOME/storages/team-balancer/assignments.json`, so a
   host restart or plugin reload does not lose the distribution.
5. Root Sessions are never rerouted; the pool is validated with
   `ctx.llm.resolveModelInfo` (60 s cache) and recomputed when adapters change.

## Development

No build step; plain ESM, two Node built-ins only.

```bash
npm run check   # node --check on both halves
npm test        # fake-Cordis host test + fake-module-loader client test
```

Both test files run with plain Node (>= 20) and no dependencies:

- `tools/host-test.mjs` — mounts the real Host half on a fake context, then verifies
  route assignment, request rewriting, Lead guidance section rendering, spread-first
  cycles, HTTP save/reset/validation and assignment persistence.
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

## Community

- [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Security policy](SECURITY.md)
- [Releases](https://github.com/hkd-Duo/Dsh-More-Agent-Blance/releases) · [Tags](https://github.com/hkd-Duo/Dsh-More-Agent-Blance/tags) · [Issues](https://github.com/hkd-Duo/Dsh-More-Agent-Blance/issues)

## License

[MIT](LICENSE) © hkd-Duo
