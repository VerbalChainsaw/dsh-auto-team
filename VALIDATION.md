# Validation record

Every claim below was executed, not reasoned. Commands are exact; outputs are
verbatim. No secret values appear in this file.

Environment: Windows, dsh `0.2.1-rc.2`, plugin `dsh-auto-team@1.19.0` (evidence captured across 1.9.0–1.19.0).

---

## 1. A real fresh session provisions the crew — VERIFIED

The web GUI requires a tokenised URL, so a **real** Host session was run with
`dsh --profile headless` plus the test overlay that mounts the same Agent Teams
rows and this bundle. The model credential was injected into the child process
only, from the credential store, and not printed by that probe.

```
dsh --profile headless --patch test-headless-team.yml "..."

[auto-team] armed api=ok sources=[startup] budget=15000ms block=8000ms gate=on
            policy=require shell=on scout:standby,builder:standby,critic:standby,operator:standby
[auto-team] provisioned [scout,builder,critic,operator] for session-6936f1a2-...
```

Reproduced in a second session (`session-6058145d-...`). The `provisioned` line is
emitted **only after** `listMembers` confirms all four names, so it is a verified
post-condition, not "the call returned".

Also observed: `send_message` started `scout`'s turn and it answered
`SCOUT-ONLINE`; the Lead handled the reply.

## 2. The delegation policy refuses a live Lead edit — VERIFIED

```
LEAD_REFUSAL: This session has not delegated anything yet. Put the first slice on a
crew member with `send_message` (scout, builder, critic, operator) or fan it out
with `workflow`; file edits are refused until then. Attempting a delegation clears
this even if the call fails.
```

The Lead then confirmed by `glob` that no file had been created.

## 3. The read-only role refuses a live `critic` write — VERIFIED

```
CRITIC_REFUSAL: Error: `critic` is a read-only role: `write` is refused. Report the
defect and its evidence to the Lead; do not repair it yourself.
```

## 4. The shell guard fires in production — VERIFIED, unplanned

A command containing `*> $out` (a file write) was refused:

```
That shell command mutates the filesystem, which is builder work (or operator work
if it is long-running). Delegate it, or retry the same call to proceed yourself —
verification and read-only commands are unaffected.
```

A read-only replacement command then ran normally, confirming the guard is scoped
to mutations.

## 5. The crew is provisioned in the live `web` profile — INFERRED (strong)

`list_agents` in the live web session returned six members:

```
lead, verifier, scout, critic, builder, operator   (all but lead inactive)
```

`verifier` was spawned manually. `scout`, `critic`, `builder` and `operator` were
not: this plugin is the only component that creates those names, and `agent/pre-step`
self-heal is the path that ran after the module reloaded. The Host's `[auto-team]
provisioned` line for that session was not captured, so this is INFERRED from the
roster rather than read from a log.

Side effect worth recording: because the module reloaded, in-memory policy state
reset and the next Lead edit was refused again — the valve's documented
"one delegation clears it" recovery worked.

## 6. The installed artifact is the code under test — VERIFIED

```
workspace:  A2EA3B53040DD5603364CF5A90486C19D38B605AFCD9BBA0B2E562EC302C7DB4
installed:  A2EA3B53040DD5603364CF5A90486C19D38B605AFCD9BBA0B2E562EC302C7DB4
identical:  True
reparsePoint: False      (a real directory, not a link into a checkout)
```

## 7. Repeatable verification, from the installed package — VERIFIED

```
node C:/Users/zerop/.dsh/profiles/web/node_modules/dsh-auto-team/verify.mjs

PASS  installed artifact is byte-identical to this checkout
PASS  policy suite passes against the INSTALLED artifact   (59/59 assertions)
PASS  auto-team is in the profile bundle layer list
PASS  profile owns a packaged copy, not a link into a checkout
4/4 checks passed
```

The suite imports the module under test via `AUTO_TEAM_MODULE`, so assertions run
against installed bytes rather than the workspace copy. `verify.mjs` ships inside
the package, so anyone can re-run it.

---

## 8. The initialization gate refuses a live teammate — VERIFIED

Captured 2026-11-16 by `operator` with a headless probe. A freshly spawned
`scout` tried to read before the Lead had messaged it, and the Host denied the
call. Log line, verbatim:

```
[auto-team] policy refused [initialization] read (session cc1083d6-72ad-419a-8ed6-bdd7f66982ce)
```

`scout`'s tool result, verbatim:

```
Error: Initialization turn: you have no tools until the Lead sends your first assignment. Do not explore, do not ask questions, and do not address the user. Reply READY and stop.
```

The probe exited 0. The gate was observed from the denied side on a real Host
session, not only unit-tested against the listener.

---

## Defects this validation found in my own harness

- `verify.mjs` failed on first run: the test imported an absolute Windows path,
  which the ESM loader rejects (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). Fixed by
  converting to a `file://` URL. The harness caught a real bug on its first run.

## What is NOT validated

| Claim | Status |
|---|---|
| Fresh-session provisioning (headless) | **VERIFIED** §1, twice |
| Delegation policy live | **VERIFIED** §2 |
| Read-only role live | **VERIFIED** §3 |
| Shell guard live | **VERIFIED** §4 |
| Artifact identity + repeatable self-check | **VERIFIED** §6–7 |
| Initialization gate denying a real teammate | **VERIFIED** §8, live Host session |
| Provisioning in the live `web` profile | **INFERRED** from the roster, §5 |
| Self-heal repairing a partial live roster | **NOT OBSERVED LIVE.** The web-session crew appearing is consistent with it, but the mechanism was not isolated |

The last row is the honest remainder. Nothing here proves it.

## Security note

During the probe, the operator printed the `DEEPSEEK_API_KEY` value once in its own session transcript (not in any log file); key rotation is recommended.
---

## 8. Team run — goal-driven, bounded jobs (2026-11-16)

Goal `goal-703ece1f-04dc-4ae0-a661-4454c7be3f56`. One `workflow` run
(`team-run-final-audit`) with three bounded one-shot jobs, each given one
objective, an explicit file list, a forbidden list, an acceptance check and a
result schema. All three returned `status: done` with line-level evidence.

What the jobs found, and what was fixed:

1. **lockout-paths** — the Lead has exactly three deny paths and every one has an
   escape, except when a *downstream* listener refuses the delegation call: our
   code returned before recording the attempt. **Fixed**: a delegation attempt is
   recorded before the allow check, so a downstream deny can no longer leave the
   valve closed (test: "a downstream deny passes through but still counts as a
   delegation attempt").
2. **config-drift** — `startSources` is dead config under `provisionOn: lazy`, and
   both the patch header and the package description still said "pair". **Fixed**:
   documented scope, descriptions corrected to the four-member crew.
3. **untested-behaviour** — 28 shipped behaviours had no assertion. **Partially
   fixed**: seven high-value ones now have tests (rpcId-less user message,
   inherited team activity, subagent/team-task delegation, nudge-mode strong
   mutation, downstream deny, legacy flag). Suite is 70/70.

The remaining 21 are cosmetic or diagnostic paths (log wording, default values,
cleanup assertions); they are listed in the run output and are not claims about
safety or enforcement.