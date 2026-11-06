# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-06

### Documentation

- Add a complete installation tutorial in Chinese ([docs/install.zh.md](docs/install.zh.md))
  and English ([docs/install.md](docs/install.md)): requirements and compatibility,
  desktop Plugin Manager steps, the non-Electron CLI caveat, local development, provider
  setup, first-run verification, upgrade, uninstall, FAQ and the compatibility table.
- Add README badges (CI, version, license, supported DSH version), a SECURITY policy and
  release-note categories for the GitHub repository.

### Added

- Support for DeepSeek Harness **0.2.2+** `AgentModel` routing: each delegated
  child's route is fixed through `agent.model.select()` before step preparation, which
  is the only supported way to change a step's model in the new loop.

### Changed

- The `agent/request` route rewrite is now a compatibility fallback used only when an
  Agent does not expose `agent.model`. On 0.2.2+ the listener returns the frozen
  configuration unchanged, because the loop rejects a route change there.
- Saving the pool now re-routes live **idle** children through the selection API
  instead of dropping their assignment; running children keep their current model.

### Fixed

- Teammates failed on DSH `0.2.2-rc.1` with
  `agent/request proposed "<route>" after step preparation fixed "<route>"; use agent.model.select() before step preparation`.
  Assignment now happens at creation through the selection API, and a teammate
  assigned a route different from the Lead's runs on it again.

## [0.1.0] - 2026-11-05

### Added

- Weighted multi-provider balancing for Agent Teams: teammates are assigned a sticky
  route from a weighted pool in durable roster order; the Lead is never rerouted.
- Optional balancing of ordinary `subagent` / `subagent_fork` children.
- Host `agent/request` enforcement so every model request of a delegated child uses
  its assigned provider/model; inherited reasoning effort is cleared on route changes
  unless the route pins one.
- Route validation through `ctx.llm.resolveModelInfo` with a 60 s cache and
  invalidation on `llm/adapters-updated`; non-routable routes are skipped gracefully.
- First-class Web surfaces: a left-sidebar panel (balance icon + full editor), a
  Plugins-page bundle configuration editor, and a live assignments table.
- Balancing style presets: even rotation, DeepSeek-first, GLM-first, single provider.
- Free-form pool editor (provider/model selects, weights 1–100, add/remove rows).
- Host HTTP routes `GET /dsh-team-balancer/state`, `POST /dsh-team-balancer/config`,
  `POST /dsh-team-balancer/reset`, restricted to loopback same-origin requests.
- Persistence of UI overrides in `$DSH_HOME/storages/team-balancer/config.json` with
  immediate live apply, plus a reset-to-defaults action.
- Dependency-free test suite: fake-Cordis host test and fake-module-loader client test.
- GitHub Actions CI, MIT license, English and Chinese documentation.
