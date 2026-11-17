# Auto Team

A DSH Host bundle that removes the *choice* of whether a session gets an agent
team. On every genuine session start it establishes, verifies, and then keeps
repairing the configured four-member crew, before the first step of the first turn.

It ships a four-member crew — `scout` (reconnaissance), `builder` (implementation),
`critic` (independent verification) and `operator` (long-running execution and
environment diagnosis) — all `fresh` context, created through
`ctx.agentTeams.spawnTeammate`. Ownership is disjoint: reconnaissance does not
implement, implementation does not self-verify, verification does not repair.

## Why it exists

The Agent Teams bundle (`@deepseek-ai/dsh-experimental-agent-team-profile`)
installs the Team service and the `spawn_teammate` tool, but it never seeds a
roster. A fresh session therefore starts with a Lead and no teammates, and the
crew appears only if the model decides to call the tool. Prompt text asking the
model to do that is advisory: skipped under time pressure, forgotten after
compaction, untestable.

This bundle makes provisioning deterministic instead.

## The hard constraint: there is no dormant spawn

A teammate cannot be created silently, and no amount of design gets around it.
From `dsh-experimental-agent-team/lib/index.js`:

```js
const started = await this.ctx.subagents.startActivation({
  childId, provider, label: description,
  request: { prompt: request.prompt, parent: root },   // :1032-1041
})
await this.checkpointInitialPrompt(childId, started.messageId, signal)  // :1043
```

`spawnAdmitted` journals the member, hands `request.prompt` to the subagent
runtime as a **user message**, and blocks on `checkpointInitialPrompt`, which
rejects unless that message became durably accepted. `SpawnTeammateRequest.prompt`
is required and `SubagentActivationSpec.request` requires a prompt too. So every
teammate answers exactly one message at birth.

Therefore reliability cannot come from avoiding that turn. It comes from
**redundancy**: never trust a single attempt, and verify the outcome.

## Mechanism

1. **`agent/created`** — the serial lifecycle event the Agent loop awaits before
   releasing queued input. For an agent that is enabled by config, was created
   from a configured start source, and resolves through `ctx.agentTeams.tryMembership()`
   to `role: 'lead'`, the plugin spawns the configured crew. Because the event is
   awaited, the whole crew exists before turn 1 step 1.
2. **Verify the roster.** After spawning, the plugin reads `listMembers` and
   compares it with the configured names. *"The call returned" is not "the
   teammate exists"* — a provider can resolve without producing a member.
3. **`agent/pre-step` self-heal.** Whenever the roster is short and attempts
   remain, the next step provisions again, adding only the missing names. A
   partial or lost crew repairs itself instead of staying broken.
4. **Say it out loud.** Success logs `[auto-team] provisioned [...]`; a shortfall
   logs `[auto-team] DEGRADED session <id>: expected [...] present [...] missing
   [...] after n/m attempts`, so the failure is diagnosable rather than silent.

The membership check is the load-bearing guard against recursion: teammate and
workflow children also emit `agent/created`, and `tryMembership()` returns
`role: 'teammate'` or `undefined` for them, so neither can re-trigger provisioning.

## Enforcement, not advice

Teaching is a sentence; enforcement is a refused call. Four policies run in
`tools/pre-execute`:

| Policy | Effect |
|---|---|
| Initialization gate | A freshly spawned crew member has **no tools** until a real instruction arrives (`agent-message`, or a human message with an `rpcId`). Runtime-context injections do not count. It keys on the member id this plugin spawned **and** on the four reserved crew names, so a Lead-spawned teammate reusing `scout` / `builder` / `critic` / `operator` is gated too. |
| Role capability | `scout` and `critic` are **read-only**: the six write tools (`write`, `edit`, `write_file`, `apply_patch`, `str_replace_editor`, `run_code`) and **strong** mutating shell verbs are refused. Weak redirections and unrecognized shell aliases are not blocked: a guardrail, not a sandbox. Find and report the defect; do not repair what you verified. `builder` and `operator` may write. |
| Shell guard | For a Lead under `require`, a **strong** mutating verb (`rm -rf`, `Set-Content`, `git commit`, installs) is refused until the Lead has delegated — retrying does not help. A **weak** redirection (`>` also occurs inside quoted strings) earns exactly one nudge, then a retry proceeds. `shellGuard` is independent of `delegationPolicy`; `shellGuard: false` disables it. |
| Delegation-first | The six write tools are refused until the Lead has **attempted** a delegation. `team_task_create` and `team_task_update` count as delegation attempts and clear the valve, as does any failed attempt. `require` (default) holds across retries; `nudge` yields to one retry; `off` disables, and an unusable crew never traps the session. |

All four fail **open** if they cannot evaluate, and none of them refuse the Lead's
delegation tools, workflow children, or plain subagents. The read-only rule covers
the six write tools and strong shell verbs; a weak redirection or an unrecognized
shell alias can still write, so treat it as a guardrail that makes the correct path
the default, not as a sandbox.

A Host or plugin reload mid-session wipes **all** in-memory policy state: the
Lead's next edit is refused until it makes any delegation call (one refusal under
`nudge`, held across retries under `require`), and every crew member is gated
again until the Lead's next message re-instructs it. Nothing is persisted, so the
policies cannot tell a reload from a fresh session.

## Initialization cannot act

A spawn prompt is a real turn, and an agent holding a full tool surface will use
it — "do not explore" is advisory, so a fresh teammate starts reading and poking
at the repository before you have asked it anything.

The gate is structural, not advisory. A listener on `tools/pre-execute` denies
**every** tool call for a teammate that has not yet received a real instruction,
so initialization can only produce its acknowledgement and stop.

Reserved names close the lost-spawn-result hole: the gate applies to any member
whose name is one of the configured crew names, even when this plugin holds no
spawn record for it. A Lead-spawned `scout` (or `builder`, `critic`, `operator`)
is therefore gated until messaged; a Lead-spawned specialist with any other name
is not.

"Real instruction" is exact, not a guess: a user message whose source is either

- `kind: 'agent-message'` — a Team message from the Lead, and
- `kind: 'user'` **with an `rpcId`** — something a human actually typed.

Runtime-context injections (`time-context` and friends) append user messages too,
so a naive "second user message means instructed" check would unlock every first
turn. The spawn prompt itself matches neither rule. The gate fails **open** if it
cannot evaluate, because a gate that bricks a working agent is worse than an
ungated turn. Disable with `gateInitialTurn: false`.

## The first turn is a real turn — keep it inert

Because a spawn prompt *is* a user message the teammate answers, a standby charter
that asks it to describe what it wants ("name the two facts you'd want first")
reads to a fresh agent as a question to put back to whoever is there — so it
addresses the user. The shipped charters therefore:

- state that the teammate is a peer of the Lead and that **the user does not read
  its messages**;
- forbid exploring, proposing work, and asking questions;
- end with `Acknowledge with exactly this and nothing else: READY`.

If you customise `teammates[].prompt`, keep both properties — say who it reports
to, and demand a token, not a paragraph.

## Survivability

| Failure | Behaviour |
|---|---|
| Agent Teams bundle absent | `inject: ['agentTeams']` leaves the row pending and inert; the profile still boots |
| A spawn throws | Caught and logged; `agent/created` never fails session creation |
| A spawn resolves but creates nothing | Caught by the post-spawn roster read, logged as `DEGRADED`, repaired on the next step |
| A provider hangs | One `spawnTimeoutMs` deadline for the whole attempt, not per spawn, so session creation cannot be held for N × the timeout |
| Duplicate or concurrent `agent/created` | Concurrent events share one in-flight attempt; completed ones short-circuit on a per-session `done` flag |
| Partial failure | Provisioning is per name: retry adds only the teammates missing from the roster |
| A teammate reports `failed` | **Not retried.** `spawnAdmitted` rejects any reuse of a journaled Team name, so a retry can never succeed — one clear `DEGRADED` line tells you to start a fresh session |
| Attempts exhausted | Stops at `maxAttempts`, leaves a diagnostic, and never loops |
| Plugin disarmed (`enabled: false`, or the Agent Teams surface changed) | Fully inert — the policy listener is not even registered |
| Agent disposed | Its policy state is dropped, so a recycled id cannot inherit an old decision |
| A `fork` teammate | Inherited parent history is not an instruction: the gate still holds until the Lead messages it |
| Resume | Not a configured start source by default, so `agent/created` spawns nothing — but the pre-step self-heal deliberately ignores `startSources` and repairs a short roster |
| A new source for the same session (`/clear`) | Resets the `done`/attempt state, then re-checks the roster — no duplicate names |
| `dsh` upgrade | Zero imports; the bundle has no dependency on private dsh packages |

Nothing in `index.js` throws. That is deliberate: a throwing `agent/created`
listener fails session creation itself.

## Install

`dsh-auto-team` is a plain npm package, so any pnpm-resolvable source works. Pick one:

```sh
# 1. Straight from GitHub (no clone needed)
dsh plugin --profile web add github:VerbalChainsaw/dsh-auto-team

# 2. A specific tag or commit, for a reproducible install
dsh plugin --profile web add github:VerbalChainsaw/dsh-auto-team#v1.19.0

# 3. A packed tarball, for an air-gapped or pinned install
npm pack
dsh plugin --profile web add ./dsh-auto-team-1.19.0.tgz

# 4. A local checkout, while developing
dsh plugin --profile web add ..\dsh-auto-team
```

Or use the `plugin_manager` tool: `remove_bundle` the previous version, then
`install_bundle` with the path or git spec.

**A git or tarball install copies the package into the profile.** A local-path
install creates a `link:` instead, which means the profile breaks if the checkout
moves — fine for development, wrong for a keeper. Check with:

```sh
node node_modules/dsh-auto-team/verify.mjs
```

**Editing a checkout does not update an installed profile.** Repack or reinstall,
then restart the Host. Bump `version` before repacking: the same version with
different bytes is a pnpm cache trap.

**Node 20.11+** is required (the plugin uses `node:` builtins and `import.meta.dirname`).

## Configuration reference

Every knob is optional; the shipped values live in `cordis.patch.yml` and the rest
are code defaults. Override a knob in the profile's `cordis.patch.yml` by row id
`auto-team` — an override replaces the whole `config`, so restate every field you keep.

| Knob | Default | Shipped | What it does |
|---|---|---|---|
| `enabled` | `true` | `true` | Master switch; `false` leaves the bundle installed but inert |
| `provisionOn` | `startup` | **`lazy`** | `startup` seeds the crew at session start; `lazy` creates it at the first durable-team delegation |
| `startSources` | `[startup]` | `[startup]` | Start sources that seed a crew — **only consulted when `provisionOn: startup`** |
| `teammates[]` | four-member crew | — | Replace the crew. Each entry: `name` (lower-kebab), `description`, `prompt`, `context` (`fresh`\|`fork`), `provider`, `writes` (bool) |
| `spawnTimeoutMs` | `15000` | `15000` | Total budget for one provisioning attempt |
| `blockBudgetMs` | `8000` | `8000` | Longest a session open or a step may wait; `0` blocks for the full attempt |
| `maxAttempts` | `3` | `3` | Provisioning attempts before `DEGRADED`; exhaustion opens the Lead's write valve |
| `gateInitialTurn` | `true` | `true` | No tools for a fresh member until a real instruction arrives |
| `delegationPolicy` | `require` | `require` | `require` refuses the Lead's writes until it delegates; `nudge` allows one retry; `off` disables |
| `requireDelegationFirst` | — | — | Legacy boolean: `false` → `off`, `true` → `require` |
| `shellGuard` | `true` | `true` | Shell counts as a write surface (strong verbs refused under `require`; weak redirections nudge) |
| `reportEvery` | `10` | `10` | Refuse a member's next call after this many without an outbound message; `0` disables |
| `flashOnly` | `true` | `true` | A child naming any model other than `deepseek-flash` is refused |
| `persistState` | `true` | `true` | Durable policy state on disk |
| `stateFile` | `$DSH_HOME/data/auto-team/policy-state.json` | — | Where that state lives |

Malformed `teammates[]` entries are dropped with a warning; if **all** are malformed
the shipped crew is used instead.

## Verifying it works

**Logic — runs anywhere, no credentials:**

```sh
node test/provision.test.mjs
```

73 assertions against the real listeners and a fake Agent Teams service: the crew
spawns in order, team children and non-Team subagents cannot recurse, resume is
skipped, duplicates and concurrency are idempotent, a partial roster is completed
by name, a throwing or hanging provider cannot fail or stall creation, a spawn
that resolves without creating a member is caught by roster verification and
repaired, self-heal stops at `maxAttempts`, a failed name is never retried,
`/clear` does not duplicate, both wait sites honour `blockBudgetMs`, a changed
Agent Teams surface disarms cleanly, the initialization gate denies tools until a
real instruction and ignores runtime-context injections, that gate covers members
this plugin created and the four reserved crew names (a Lead-spawned specialist
with any other name is never gated), read-only roles cannot write — including
through a strong shell verb — while the implementation role can, the
delegation-first nudge fires once and yields to a retry or a prior delegation, the
gate fails open, it never touches the Lead's delegation tools or non-Team
children, a disarmed plugin registers no policy at all, and the shipped briefs
demand a token rather than inviting a question.

**Integration — needs a new session:**

A session that already exists is never retrofitted. Start a new chat, then call
`list_agents` before sending anything that does work: it should show the Lead plus
`scout`, `builder`, `critic` and `operator`.

**Which charters are live?** The Host log prints one line at activation:

```
[auto-team] armed api=ok sources=[startup] budget=15000ms block=8000ms gate=on policy=require shell=on report=10 scout:standby,builder:standby,critic:standby,operator:standby
```

`standby` means the charter demands a token; `chatty` means it still invites a
reply. This line also appears inside `node test/provision.test.mjs` output.

Note: `test-headless-team.yml` is a scratch overlay used to mount the same rows on
the `headless` profile for an isolated probe. It is not part of the installed
bundle.