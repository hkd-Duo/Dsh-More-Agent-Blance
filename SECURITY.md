# Security policy

## Supported versions

| Version | Supported | Notes |
|---|---|---|
| 0.2.x | ✅ | Current line; routing through `agent.model.select()` on DSH 0.2.2+, fallback on older cores |
| 0.1.x | ❌ | No longer supported; 0.1.x fails on DSH 0.2.2 and should be upgraded |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting for this repository:
**Security → Advisories → Report a vulnerability**
(<https://github.com/hkd-Duo/Dsh-More-Agent-Blance/security/advisories/new>).

Include:

- the affected version (`package.json` / release tag) and DSH version,
- a minimal reproduction (configuration, pool, commands),
- the impact you believe it has, and any suggested fix.

You can expect an initial acknowledgement within a few days. Please give the maintainer a
reasonable window to ship a fix before public disclosure.

## Scope notes

- The plugin runs as Host-side code inside the local DeepSeek Harness process; installing
  it grants the same trust as any other profile plugin.
- Its configuration HTTP routes (`/dsh-team-balancer/state|config|reset`) accept only
  loopback same-origin requests; they never accept remote callers.
- The plugin changes the model route of **delegated child agents only**. It does not read
  or transmit conversation content, credentials, or provider keys.
- Pool overrides are stored locally at `$DSH_HOME/storages/team-balancer/config.json`;
  provider credentials remain under the Harness credential store and are never read by
  this plugin.

## Out of scope

- Vulnerabilities in DeepSeek Harness itself or in third-party LLM providers — report
  those to the respective project.
- Misconfiguration of provider keys or model ids by the user.
- Denial of service caused by a user-configured pool pointing at expensive or
  rate-limited models.
