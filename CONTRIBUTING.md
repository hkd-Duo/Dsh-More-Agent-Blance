# Contributing

Thanks for taking the time to improve `dsh-plugin-team-balancer`.

## Ground rules

- Keep the plugin dependency-free: plain ESM for the Host half, a browser module for the
  Client half, Node built-ins only.
- Never reroute a root Session (the Lead or the user's own chats). Only delegated
  children may be balanced.
- Do not write unknown Session event types; the Session log must stay loadable.
- Keep the Web surfaces inside the slots they register: `main`, `sidebar.panellist`,
  and `plugins.bundle.config`. Do not append a second application to `document.body`.
- The Host HTTP routes stay loopback + same-origin only; a config write must be
  validated before it is persisted.

## Development

Requirements: Node.js >= 20 (DSH desktop ships a newer runtime).

```bash
npm run check   # syntax-check index.js and client.js
npm test        # host fake-Cordis test + client fake-loader test
```

There is no build step. The plugin package is linked into a DSH profile for manual
testing:

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-plugin-team-balancer
```

After changing `index.js`, restart the desktop app (host modules are imported once).
Client-only changes are served from `client.js`, so a page refresh is enough. Never
leave a debug `console.log` or marker write in the shipped half.

## Pull requests

1. Keep changes focused; describe the user-visible effect and the seam you used.
2. Add or update a check in `tools/` when behavior changes: assignment, request
   rewriting, config validation, persistence, or UI registration.
3. Update `CHANGELOG.md` under an `Unreleased` or version heading.
4. Run `npm test` and paste the result in the PR description.

## Reporting bugs

Please include:

- DSH version and profile (`desktop`, `web`, …);
- the configured pool, and what `GET /dsh-team-balancer/state` reports;
- the child Session's `request/header` lines proving the actual route;
- whether `includeSubagents` is enabled.

Use the issue templates for bug reports and feature requests.

## Release checklist

- [ ] `npm run check` and `npm test` pass
- [ ] `CHANGELOG.md` has the version and date (move `Unreleased` entries into it)
- [ ] `package.json` version bumped (semver)
- [ ] README install snippet, badges and compatibility notes still accurate
- [ ] tag and push:

  ```bash
  git tag -a vX.Y.Z -m "vX.Y.Z"
  git push origin main vX.Y.Z
  ```

- [ ] publish a GitHub release for the tag
  (<https://github.com/hkd-Duo/Dsh-More-Agent-Blance/releases/new>), using the
  CHANGELOG section as the body; `.github/release.yml` provides categorized
  auto-generated notes when GitHub generates them
