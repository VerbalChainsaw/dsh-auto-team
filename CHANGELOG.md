# Changelog

All notable changes to `dsh-auto-team`. The format follows Keep a Changelog;
this package uses semantic versioning.

## [1.19.0] — 2026-11-17

Packaging only; behaviour is 1.18.0.

- Renamed the package from `@local/dsh-auto-team` to `dsh-auto-team` so it can be
  installed from a git URL, a tarball, or a registry.
- Added MIT `LICENSE`, `repository` / `homepage` / `bugs`, `keywords`, and a
  documented `scripts` surface (`test`, `verify`, `check`).
- `verify.mjs` derives the installed path and profile dependency from the package
  name, so a rename cannot silently invalidate the check.

## [1.18.0] — 2026-11-17

- **Durable policy state**: delegation, nudges, gated and released members persist
  to `${DSH_HOME:-~/.dsh}/data/auto-team/policy-state.json` with an atomic write
  and a 256-entry cap. A reload now answers the same question the same way.
- **Flash-only**: `subagent` / `subagent_fork` calls naming any model other than
  `deepseek-flash` are refused (`flashOnly`, default on).
- Activation line reports `state=durable|memory` and `flash=only|any`.
- Test suite made hermetic: it no longer writes into the operator's real state
  file (a real pollution bug found and fixed).

## [1.17.0] — 2026-11-16

- **Workflow is the team engine**: `workflow`, `subagent` and `subagent_fork`
  satisfy the delegation policy but no longer create a durable crew.
- A delegation attempt is recorded even when a downstream listener refuses the
  call, closing the last theoretical lockout path.
- Seven gap tests from a three-job workflow audit (70 total).

## [1.16.0] — 2026-11-16

- `provisionOn: lazy` shipped: a fresh session spawns nothing and reads nothing
  until the first durable-team delegation.
- Standby brief reduced from ~700 words to ~120 (the manual lives in the skill).
- Self-heal no longer wakes a crew in lazy mode before it exists.

## [1.15.0] — 2026-11-16

- Four-member crew (`scout`, `builder`, `critic`, `operator`) with disjoint
  ownership; read-only roles enforced by capability.
- Enforcement: initialization gate, read-only tool + shell refusal,
  delegation-first policy (`require` / `nudge` / `off`), compelled reporting.
- Shell classifier split into `strong` / `weak` / `quoted` / `none` with
  PowerShell aliases, wrapper extraction and quote-parity demotion.

## [1.0.0] — 2026-11-16

- First working version: deterministic crew provisioning on the awaited
  `agent/created` event, roster verification, self-heal, bounded attempt budget,
  and a shipped policy suite with an end-to-end verifier.
