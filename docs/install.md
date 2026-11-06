# Installation guide (dsh-plugin-team-balancer)

> Goal: install **Team AI Balancer** in DeepSeek Harness so Agent Teams teammates rotate
> across DeepSeek / GLM and other providers by weight, editable from a sidebar panel.
>
> Repository: <https://github.com/hkd-Duo/Dsh-More-Agent-Blance>

## 0. Requirements

| Item | Requirement |
|---|---|
| DeepSeek Harness | Desktop or Web; plugin `0.2.0` supports **DSH 0.2.2-rc.1+** (`agent.model.select()`) and **0.2.1 or older** (automatic fallback) |
| Team capability | Agent Teams bundle enabled (`@deepseek-ai/dsh-experimental-agent-team-profile`, on by default on desktop) |
| Providers | At least one; for multi-AI balancing configure **DeepSeek official** + **GLM (zai)** |
| Credentials | DeepSeek account or `DEEPSEEK_API_KEY`; GLM needs `ZAI_API_KEY` |
| Network | The plugin manager must reach GitHub |

## 1. Desktop app — Plugin Manager (recommended)

A desktop profile is Electron-managed and must be changed through the Plugin Manager, not
the CLI.

1. Open the **Plugins** panel in the left sidebar (or **Settings → Plugins**).
2. Open **Plugin Manager → Add plugin**.
3. Enter:

   ```text
   github:hkd-Duo/Dsh-More-Agent-Blance
   ```

4. Confirm and wait for pnpm to finish; `+ dsh-plugin-team-balancer` in the log means
   success.
5. Close the dialog and press **Ctrl+R**. A **balance icon** (Team AI Balancer) appears
   in the left rail after the built-in panel icons.
6. If it does not appear, check **Settings → Plugins → Installed plugins** and make sure
   `dsh-plugin-team-balancer` is enabled, then refresh again.

Two entry points are installed:

- left-rail **balance icon** → full editor (styles, weighted pool, live assignments);
- **Settings → Plugins → dsh-plugin-team-balancer** → the same editor on the bundle page.

## 2. CLI (non-Electron profiles only)

For self-managed Web/TUI profiles (for example a profile served by `dsh web`), **not** the
desktop `desktop` profile:

```bash
dsh plugin --profile <profile> add github:hkd-Duo/Dsh-More-Agent-Blance
```

Restart that Web/CLI process and refresh the page. If you see
`profile "desktop" is managed exclusively by the Electron application`, use method 1.

## 3. Local development / offline

```bash
git clone git@github.com:hkd-Duo/Dsh-More-Agent-Blance.git
dsh plugin --profile <profile> add link:/absolute/path/Dsh-More-Agent-Blance
```

On desktop, choose **Local directory** in the Plugin Manager and point at the clone.

- Changing `index.js` (Host half) requires an app restart;
- changing `client.js` (Client half) only needs a page refresh;
- the bundle patch inserts the `team-balancer` row, so no profile edit is needed.

## 4. Configure providers

1. **Settings → Models**: confirm both routes exist, e.g.
   `deepseek-official / deepseek-flash` and `zai / glm-5.3-flash`.
2. Open the balance panel and check **Route availability** — unavailable routes are
   flagged and skipped; only routable routes participate in the rotation.
3. Keep the default `DeepSeek 1 : GLM 1`, apply a preset, or edit provider/model/weight
   (1–100) and press **Save and apply**.

## 5. First-run verification

1. Open the balance panel; it should show *Balancing style*, *Model pool*, *Current
   assignments*.
2. Pick **Even rotation (1:1)** and save.
3. Ask the Lead to create two teammates. The first uses the first route in the pool, the
   second uses the second route.
4. The *Current assignments* table should show two different `provider/model` pairs. The
   child Session's `request/header` is the durable proof of the real route.

The Lead and the user's own chats are never rerouted.

## 6. Upgrade

- Use **Update** on the installed bundle in the Plugin Manager (DSH 0.2.2+ supports
  third-party plugin updates and rolls back a failed hot update).
- Or remove and re-add the same GitHub address.
- For a linked local checkout: `git pull`, then restart the app.
- Keep the plugin at **0.2.0+**: 0.1.0 fails on DSH 0.2.2 with
  `agent/request proposed … use agent.model.select()`.

## 7. Uninstall

1. **Settings → Plugins → Installed plugins → dsh-plugin-team-balancer → Remove**.
2. The sidebar icon and bundle editor disappear.
3. Optional cleanup of saved pool overrides:

   ```text
   $DSH_HOME/storages/team-balancer/config.json
   ```

4. Existing teammates keep the model of their last request.

## 8. FAQ

**GitHub connection fails during install** — check the proxy/network, retry, or clone and
install from a local directory (method 3).

**No balance icon after install** — refresh with `Ctrl+R`, verify the bundle and row are
enabled in Settings → Plugins, and read the diagnostics shown by the Plugin Manager.

**Teammates fail with `agent/request proposed … use agent.model.select()`** — the plugin is
0.1.0 on DSH 0.2.2; upgrade to 0.2.0+.

**A GLM route is unavailable** — configure `ZAI_API_KEY`, check the exact model id, refresh
the provider catalog in Settings → Models.

**Only some teammates use a different model** — the Lead is intentionally excluded;
`includeSubagents` defaults to off; unroutable routes are skipped.

**An idle teammate still shows the Lead model in the Team roster** — the core roster
falls back to the Lead model for unloaded members; the *Current assignments* table and
`request/header` are authoritative.

**Restore defaults** — *Restore defaults* in the panel, or delete
`$DSH_HOME/storages/team-balancer/config.json`.

**Security** — host-side code, only delegated children are rerouted, and config HTTP
routes accept loopback same-origin requests only.

## 9. Compatibility

| Plugin | DSH | Routing |
|---|---|---|
| 0.2.0 | 0.2.2-rc.1+ | `agent.model.select()` |
| 0.2.0 | 0.2.1 or older | `agent/request` fallback |
| 0.1.0 | 0.2.1 or older | `agent/request`; fails on 0.2.2 — upgrade |
