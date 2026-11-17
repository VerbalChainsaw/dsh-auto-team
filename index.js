/**
 * Auto Team — deterministic agent-team provisioning for fresh sessions.
 *
 * The Agent Teams bundle installs the Team service and its model tools but never
 * seeds a roster: a fresh session starts with a Lead and no teammates, and the
 * pair only appears if the model chooses to call `spawn_teammate`. This plugin
 * removes that choice from the model's hands.
 *
 * ## Why there is no dormant spawn
 *
 * `TeamService.spawnAdmitted` journals the member, then calls
 * `ctx.subagents.startActivation({ request: { prompt } })` and blocks on
 * `checkpointInitialPrompt`, which rejects unless that prompt became a durably
 * accepted user message. `SubagentActivationSpec.request` requires a prompt, and
 * `SpawnTeammateRequest.prompt` is required. So every teammate answers exactly
 * one message at birth and there is no API that creates a silent member.
 *
 * ## Therefore: redundancy, not avoidance
 *
 * One attempt is a single point of failure, so this plugin never trusts it:
 *  1. `agent/created` provisions before the session releases queued input.
 *  2. Every spawn is followed by a roster read (`verifyPair`), because "the call
 *     returned" is not "the teammate exists".
 *  3. `agent/pre-step` re-provisions whenever the roster is short and attempts
 *     remain, so a partial or lost pair repairs itself on the next step.
 *  4. A deliberate `DEGRADED` log states exactly which names are missing, so the
 *     failure is diagnosable instead of silent.
 *
 * Survivability rules:
 *  - `inject: ['agentTeams']` leaves the row pending and inert (not failed) when
 *    Agent Teams is absent.
 *  - Nothing throws: a throwing `agent/created` listener fails session creation.
 *  - One deadline per attempt bounds session-start latency for the whole pair.
 *  - Provisioning is idempotent per session and per start source, and concurrent
 *    events share one in-flight attempt instead of spawning twice.
 *
 * @module @local/dsh-auto-team
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Every child this profile may run. Enforced for surfaces that take a model. */
const FLASH_MODEL = 'deepseek-flash'
/** Tools whose call arguments may name a child model. */
const CHILD_MODEL_TOOLS = new Set(['subagent', 'subagent_fork'])
/** Cap on persisted id lists so the state file cannot grow without bound. */
const STATE_CAP = 256
/** Default durable policy state. Overridable for tests and by config. */
const DEFAULT_STATE_FILE = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'data',
  'auto-team',
  'policy-state.json',
)

/**
 * Read the durable policy snapshot. Any failure is non-fatal: the plugin then
 * behaves exactly as it did before durability existed (memory only).
 * @returns the parsed snapshot, or undefined.
 */
function loadPolicyState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Write the durable policy snapshot atomically (tmp file + rename) so a crash
 * mid-write cannot leave a half-parsed file behind.
 * @returns whether the snapshot reached disk.
 */
function savePolicyState(file, snapshot) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(snapshot))
    renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}

/** Trim a Set to its most recent entries, as a plain array. */
const capped = (set) => [...set].slice(-STATE_CAP)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'auto-team'

/** The Agent Teams service is the only hard dependency. */
export const inject = ['agentTeams']

/** Sentinel resolved by the per-spawn timeout race. */
const TIMED_OUT = Symbol('auto-team/timeout')

/**
 * The shipped crew. Ownership is deliberately disjoint: reconnaissance does not
 * implement, implementation does not self-verify, verification does not repair,
 * and long-running execution is its own job.
 */
const CREW = [
  { name: 'scout', role: 'the reconnaissance member', owns: 'reconnaissance and ground truth' },
  {
    name: 'builder',
    role: 'the implementation member',
    owns: 'implementation slices inside a declared write scope',
  },
  {
    name: 'critic',
    role: 'the independent verification member',
    owns: 'independent verification; never approves by default',
  },
  {
    name: 'operator',
    role: 'the execution member',
    owns: 'long-running builds, services, ports and environment diagnosis',
  },
]

/**
 * Build the standing brief a teammate receives as its first user message.
 *
 * The tools are disabled on this turn (see the initialization gate), so the brief
 * has to be self-contained: it is the only thing the teammate knows until the Lead
 * sends an assignment. It therefore states the mode, the job, the crew, how work
 * arrives, how to delegate, and the evidence standard.
 */
function standingBrief({ name, role, mission, writes }) {
  // Deliberately short. A spawn prompt is injected as the teammate's first user
  // message and sits in its context for the whole session, so the full operating
  // manual lives in the doctrine skill and in the Lead's assignments — not here.
  const lines = [
    `You are \`${name}\`, ${role} of this session's agent team. Report to the Lead.`,
    'The user does not read your messages: never address the user, never ask it anything,',
    'and never announce that you are waiting for work.',
    '',
    'Your job: ' + mission,
    '',
    'Work arrives as a `send_message` from the Lead or a peer. Treat each message as',
    'self-contained; if it is ambiguous, do the smallest reasonable thing and state the',
    'assumption. Ground every claim — VERIFIED (you read or ran it), INFERRED, UNVERIFIED —',
    'and cite a file, a command or an output. Report back what you did, what you found,',
    'and what is next. Before you finish: release your task claim, stop what you started,',
    'leave no scratch files.',
    '',
    'Start clean: do nothing until you are messaged. Do not explore the repository.',
  ]
  if (writes === false) {
    lines.push(
      '',
      'You are read-only: `write`, `edit`, `run_code` and mutating shell commands are',
      'refused. Report the defect; do not repair it.',
    )
  }
  lines.push('', 'Reply with exactly: READY')
  return lines.join('\n')
}

const MISSIONS = {
  scout:
    'You are the reconnaissance half. Establish ground truth: what exists, what runs, ' +
    'what breaks. Read and run; do not redesign. Hand back paths, exact commands and ' +
    'observed output so the Lead can decide.',
  builder:
    'You are the implementation half. Make the smallest complete change that satisfies ' +
    'the assignment, at the paths you were given, reusing the patterns already there. ' +
    'Never widen scope and never touch paths outside your declared write scope. Report ' +
    'changed paths and the checks you ran.',
  critic:
    'You are the independent verification half. Disagree with evidence. Given a claim or ' +
    'a change, find what breaks it: read the actual files, run the actual command. One ' +
    'reproducible defect beats a general concern, and you never approve by default.',
  operator:
    'You are the execution half for long-running and environment-shaped work: builds, ' +
    'test suites, services, ports, background jobs, logs and environment diagnosis. ' +
    'Start the thing, watch the real output, report what you observed rather than what ' +
    'you expected, and stop what you started.',
}

/** Reads are allowed everywhere; writes are refused for verification roles. */
const WRITES_BY_ROLE = { scout: false, builder: true, critic: false, operator: true }

/**
 * Shipped crew. The briefs are deliberately inert for this turn and complete for
 * every later one: the initialization gate means this text is all the teammate
 * has until the Lead assigns work.
 */
const DEFAULT_PAIR = CREW.map((member) => ({
  name: member.name,
  description: `${member.owns[0].toUpperCase()}${member.owns.slice(1)}.`,
  context: 'fresh',
  provider: 'spawn',
  writes: WRITES_BY_ROLE[member.name] !== false,
  prompt: standingBrief({
    name: member.name,
    role: member.role,
    mission: MISSIONS[member.name],
    writes: WRITES_BY_ROLE[member.name] !== false,
  }),
}))

/** The Team service's member-name shape: lower-kebab, letters/digits/hyphens. */
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Coerce one configured teammate into the exact shape `spawnTeammate` accepts.
 * @param spec - raw row from `config.teammates`, possibly malformed.
 * @returns a normalized spec, or `undefined` when it cannot be spawned.
 */
function normalizeTeammate(spec) {
  if (spec === null || typeof spec !== 'object') return undefined
  const name = String(spec.name ?? '').trim()
  const prompt = String(spec.prompt ?? '')
  if (name === '' || prompt === '') return undefined
  // The Team service enforces lower-kebab member names BEFORE journaling, so an
  // invalid configured name would be retried on every step until attempts run
  // out, with a confusing diagnostic. Drop it here and say so instead.
  if (!MEMBER_NAME.test(name)) return undefined
  const context = spec.context === 'fork' ? 'fork' : 'fresh'
  const provider =
    typeof spec.provider === 'string' && spec.provider !== ''
      ? spec.provider
      : context === 'fork'
        ? 'fork'
        : 'spawn'
  return {
    name,
    description: String(spec.description ?? name),
    prompt,
    context,
    provider,
    writes: spec.writes !== false,
  }
}

/**
 * Register the provisioning listeners for the lifetime of `ctx`.
 * @param ctx - plugin context; listeners are disposed with it.
 * @param config - pair composition, start sources, and provisioning limits.
 */
export function apply(ctx, config) {
  const teams = ctx.agentTeams

  const settings = config ?? {}
  // Upgrade guard: if a future Agent Teams release renames or drops one of the
  // three methods this plugin depends on, disable cleanly with one clear line
  // instead of emitting a DEGRADED diagnostic on every session.
  //
  // Name exactly what is missing. A minimal profile (for example the shipped
  // `naked` preset) mounts no Agent Teams at all, and "DISARMED api=MISSING"
  // alone does not tell an operator which bundle to add.
  const missingSurfaces = []
  if (typeof teams?.tryMembership !== 'function') missingSurfaces.push('tryMembership')
  if (typeof teams?.listMembers !== 'function') missingSurfaces.push('listMembers')
  if (typeof teams?.spawnTeammate !== 'function') missingSurfaces.push('spawnTeammate')
  const supported = missingSurfaces.length === 0
  const enabled = settings.enabled !== false && supported
  const configured = Array.isArray(settings.teammates) ? settings.teammates : []
  const normalized = configured.map(normalizeTeammate).filter((spec) => spec !== undefined)
  const specs = normalized.length > 0 ? normalized : DEFAULT_PAIR.map(normalizeTeammate)
  const startSources = new Set(
    Array.isArray(settings.startSources) && settings.startSources.length > 0
      ? settings.startSources
      : ['startup'],
  )
  const timeoutMs =
    Number.isFinite(settings.spawnTimeoutMs) && settings.spawnTimeoutMs > 0
      ? settings.spawnTimeoutMs
      : 15000
  const maxAttempts =
    Number.isFinite(settings.maxAttempts) && settings.maxAttempts > 0
      ? Math.floor(settings.maxAttempts)
      : 3
  // Durable policy state: which sessions have delegated, which were nudged, which
  // members are gated or released. Without this, every Host reload re-derives a
  // different answer for the same session — the one genuinely unpredictable thing
  // left in the plugin.
  const stateFile =
    typeof settings.stateFile === 'string' && settings.stateFile !== ''
      ? settings.stateFile
      : DEFAULT_STATE_FILE
  const persistState = settings.persistState !== false
  // Children may only run on the flash model. Enforced for the surfaces whose
  // call arguments actually name a model; teammates inherit the Lead's route.
  const flashOnly = settings.flashOnly !== false
  // Assigned once the durable snapshot has been read, but declared here so the
  // activation line can report it. (Referencing it before initialisation would
  // throw inside the diagnostic's own try/catch and silently drop the line.)
  let stateLoaded = false
  // How long session creation may wait for the pair. `agent/created` is awaited
  // before the session releases queued input, so an unbounded wait turns a
  // stalled provider into a stalled chat. Past this budget the session opens and
  // provisioning finishes in the background, with `agent/pre-step` self-heal as
  // the safety net. `0` means block for the whole attempt budget.
  const blockBudgetMs =
    Number.isFinite(settings.blockBudgetMs) && settings.blockBudgetMs >= 0
      ? Math.floor(settings.blockBudgetMs)
      : 8000
  // A spawn prompt is a real turn, and an agent with a full tool surface will use
  // it: "do not explore" is advisory. This gate is not advisory — a teammate gets
  // no tools at all until a real instruction arrives, so initialization can only
  // produce its acknowledgement.
  const gateInitialTurn = settings.gateInitialTurn !== false
  // When the crew comes into existence.
  //   'startup' — seed it the moment a session starts.
  //   'lazy'    — create nothing until the Lead's first delegation attempt.
  // The shipped profile is 'lazy': a fresh session costs zero turns, spawns no
  // agents, and reads nothing until you actually delegate something.
  const provisionOn = settings.provisionOn === 'lazy' ? 'lazy' : 'startup'
  // Enforcement depth, not advice:
  //   'require' (default) — file edits are refused until the Lead has attempted a
  //      delegation, or until the crew is provably unusable.
  //   'nudge'   — refuse once, let a retry through.
  //   'off'     — no policy.
  // A delegation *attempt* clears the policy even if it fails, so this can never
  // trap a session that genuinely cannot delegate.
  let delegationPolicy = 'require'
  if (
    settings.delegationPolicy === 'off' ||
    settings.delegationPolicy === 'nudge' ||
    settings.delegationPolicy === 'require'
  ) {
    delegationPolicy = settings.delegationPolicy
  } else if (settings.requireDelegationFirst === false) {
    delegationPolicy = 'off'
  } else if (settings.requireDelegationFirst === true) {
    delegationPolicy = 'require'
  }
  const requireDelegationFirst = delegationPolicy !== 'off'
  // Compelled reporting: refuse a member's next tool call after this many
  // without an outbound message. 0 disables it.
  const reportEvery =
    Number.isFinite(settings.reportEvery) && settings.reportEvery >= 0
      ? Math.floor(settings.reportEvery)
      : 10
  const MESSAGING_TOOLS = new Set(['send_message', 'send_structured_message'])
  // Mutating shell commands count as writes for the Lead, but only as a one-shot
  // nudge: shell is also how verification runs.
  const shellGuard = settings.shellGuard !== false

  // One-line activation record, readable in the Host log without creating a
  // session: `standby` means the charter demands a token, `chatty` means it
  // still invites a reply.
  try {
    const roster = specs
      .map((spec) => `${spec.name}:${/READY\s*$/.test(spec.prompt) ? 'standby' : 'chatty'}`)
      .join(',')
    console.warn(
      `[auto-team] ${enabled ? 'armed' : 'DISARMED'} api=${supported ? 'ok' : 'MISSING'} ` +
        (supported
          ? ''
          : `missing=[${missingSurfaces.join(',')}] ` +
            'fix="add @deepseek-ai/dsh-experimental-agent-team-profile to this profile, ' +
            'or disable dsh-auto-team" ') +
        `sources=[${[...startSources].join(',')}] budget=${timeoutMs}ms ` +
        `block=${blockBudgetMs === 0 ? 'full' : `${blockBudgetMs}ms`} ` +
        `gate=${gateInitialTurn ? 'on' : 'off'} policy=${delegationPolicy} ` +
        `shell=${shellGuard ? 'on' : 'off'} report=${reportEvery || 'off'} ` +
        `provision=${provisionOn} state=${stateLoaded ? 'durable' : 'memory'} ` +
        `flash=${flashOnly ? 'only' : 'any'} ${roster}`,
    )
  } catch (error) {
    // Diagnostics must never fail activation — but a swallowed diagnostic is
    // invisible, so say why it could not be written.
    console.error('[auto-team] activation diagnostic failed:', error && error.message)
  }

  // An inert row must be inert: no listeners, no state file, no handlers. This is
  // what a minimal profile (no Agent Teams) gets when the bundle is installed
  // anyway — a single DISARMED line and nothing else.
  if (!enabled) return () => {}

  const warn = (message, error) => {
    try {
      const detail =
        error === undefined ? '' : `: ${error && error.message ? error.message : String(error)}`
      console.warn(`[auto-team] ${message}${detail}`)
    } catch {
      // Logging must never be the thing that breaks session creation.
    }
  }

  // Report malformed config loudly instead of silently substituting the shipped
  // crew: the Team service validates member names strictly, so an invalid entry
  // would fail on every step forever if it ever reached the journal.
  {
    const dropped = configured.length - normalized.length
    if (dropped > 0) {
      warn(
        `dropped ${dropped} malformed teammate spec(s) from config: names must be ` +
          'lower-kebab and prompts non-empty — they were dropped instead of shipped',
      )
    }
  }

  /** Per-session bookkeeping. */
  const sessions = new Map()
  /** Teammates observed to have received a real instruction, so they are never gated again. */
  const released = new Set()
  /** Exact member ids this plugin spawned: only these are initialization-gated. */
  const gatedIds = new Set()
  /** Configured names are reserved: the gate still works if a spawn result was lost. */
  const specNames = new Set(specs.map((spec) => spec.name))
  /** Configured spec by name, for role capability policy. */
  const specsByName = new Map(specs.map((spec) => [spec.name, spec]))
  /** Member id -> configured name, recorded from our own spawns. */
  const memberNames = new Map()
  /** Leads already nudged once for editing before delegating. */
  const nudgedLeads = new Set()
  /** Leads already nudged once for a mutating shell command. */
  const nudgedShell = new Set()
  /** Member id -> tool calls since its last outbound message. */
  const outboundCalls = new Map()
  /** Denials already logged, so a repeating refusal does not flood the Host log. */
  const loggedDenials = new Set()
  /**
   * Record one refusal in the Host log. Policy decisions are otherwise invisible:
   * they only exist in the model's tool result, so an operator cannot tell an
   * armed policy from an inert one. One line per member per kind keeps the
   * enforcement observable without turning the log into a denial feed.
   */
  const logDenial = (agentId, kind, detail) => {
    const key = `${agentId}|${kind}`
    if (loggedDenials.has(key)) return
    loggedDenials.add(key)
    warn(`policy refused [${kind}] ${detail} (session ${agentId})`)
  }
  /** Leads that have used a delegation surface this session. */
  const delegatedLeads = new Set()

  // ---- durable policy state -------------------------------------------------
  // Seed from disk so a reload answers the same question the same way. Any read
  // failure leaves the plugin exactly as predictable as it was before: memory only.
  const snapshot = persistState ? loadPolicyState(stateFile) : undefined
  if (snapshot !== undefined) {
    const seed = (set, key) => {
      const value = snapshot[key]
      if (Array.isArray(value)) for (const id of value) if (typeof id === 'string') set.add(id)
    }
    seed(delegatedLeads, 'delegated')
    seed(nudgedLeads, 'nudgedLead')
    seed(nudgedShell, 'nudgedShell')
    seed(released, 'released')
    seed(gatedIds, 'gated')
    stateLoaded = true
  }
  let lastSnapshot = ''
  /**
   * Flush the durable snapshot. Called only on transitions that change a decision,
   * and skipped when the bytes are unchanged, so a hot tool-call path stays cheap.
   */
  const persist = () => {
    if (!persistState) return
    try {
      const next = {
        version: 1,
        delegated: capped(delegatedLeads),
        nudgedLead: capped(nudgedLeads),
        nudgedShell: capped(nudgedShell),
        released: capped(released),
        gated: capped(gatedIds),
      }
      const serialized = JSON.stringify(next)
      if (serialized === lastSnapshot) return
      lastSnapshot = serialized
      if (!savePolicyState(stateFile, next)) {
        warn(`could not persist policy state to ${stateFile}; continuing in memory`)
      }
    } catch (error) {
      warn('policy-state persist failed', error)
    }
  }

  const sessionFor = (id) => {
    let state = sessions.get(id)
    if (state === undefined) {
      state = { source: undefined, done: false, attempts: 0, inFlight: undefined, degraded: false }
      sessions.set(id, state)
    }
    return state
  }

  /** Resolve a Team role, treating any lookup failure as "not a Team member". */
  const membershipOf = (agent) => {
    try {
      return teams.tryMembership(agent)
    } catch {
      return undefined
    }
  }

  /**
   * Read the roster and compare it with the configured pair.
   * @returns the expected names split into present and missing.
   */
  const verifyPair = (agent) => {
    const status = new Map()
    let rosterKnown = true
    try {
      for (const member of teams.listMembers(agent)) {
        if (member.role === 'teammate' && typeof member.name === 'string') {
          status.set(member.name, member.status)
        }
      }
    } catch {
      // An unreadable roster must not be reported as "everyone is missing": that
      // burns every attempt spawning names that already exist, and it misdiagnoses
      // the cause. `provision` checks rosterKnown before doing anything.
      rosterKnown = false
    }
    const present = []
    const missing = []
    const failed = []
    const activating = []
    for (const spec of specs) {
      const value = status.get(spec.name)
      if (value === undefined) missing.push(spec.name)
      else if (value === 'failed') failed.push(spec.name)
      else if (value === 'provisioning') {
        activating.push(spec.name)
        present.push(spec.name)
      } else present.push(spec.name)
    }
    return {
      // Nothing left to spawn: every configured name is journaled.
      complete: missing.length === 0,
      // Every configured name is journaled AND usable. A member still activating
      // is not yet usable: calling that "healthy" produced false successes when a
      // spawn timed out and the member later settled to failed.
      healthy: missing.length === 0 && failed.length === 0 && activating.length === 0,
      present,
      missing,
      failed,
      activating,
      status,
      rosterKnown,
    }
  }

  /** Only a Team Lead on a configured start source is provisioned. */
  const isEligibleLead = (agent) => {
    const membership = membershipOf(agent)
    return membership !== undefined && membership.role === 'lead'
  }

  /**
   * Establish every configured teammate missing from the roster, then verify.
   * Concurrent callers share one attempt.
   * @returns whether the verified pair is in place.
   */
  async function provision(agent, state) {
    if (state.done) return true
    if (state.inFlight !== undefined) return state.inFlight

    const attempt = (async () => {
      const before = verifyPair(agent)
      if (!before.rosterKnown) {
        state.attempts += 1
        warn(
          `session ${agent.id}: roster unreadable (listMembers threw) — skipped provisioning ` +
            `on attempt ${state.attempts}/${maxAttempts}; not spawning blind`,
        )
        return false
      }
      if (before.healthy) {
        state.done = true
        return true
      }
      if (before.complete && before.failed.length === 0 && before.activating.length > 0) {
        // Every name is journaled and none has failed, but some are still
        // activating. Spawning would duplicate names, marking done would be a
        // false success, and spending an attempt here would burn the budget while
        // nothing is wrong. The next pre-step re-checks for free.
        warn(`session ${agent.id}: waiting for [${before.activating.join(',')}] to activate`)
        return false
      }
      if (before.complete) {
        // Every configured name is journaled but at least one is failed.
        // `spawnAdmitted` rejects any reuse of a journaled name, so retrying can
        // never succeed — stop burning attempts and say so once, clearly.
        // Marking attempts exhausted is what opens the Lead's write valve: a crew
        // that cannot be repaired must not lock the session out of its own work.
        state.done = true
        state.attempts = maxAttempts
        state.degraded = true
        warn(
          `DEGRADED session ${agent.id}: [${before.failed.join(',')}] failed, and a Team ` +
            'name cannot be reused for the life of its journal — start a new session ' +
            'for a fresh pair, or spawn a differently named teammate',
        )
        return false
      }
      if (state.attempts >= maxAttempts) return false
      state.attempts += 1

      // One deadline for the whole attempt, not one per spawn: `agent/created`
      // is awaited before the session releases input, so a per-spawn bound would
      // let N stalled providers hold session creation for N x spawnTimeoutMs.
      const deadline = Date.now() + timeoutMs
      for (const spec of specs) {
        if (!before.missing.includes(spec.name)) continue
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          warn(`provisioning budget of ${timeoutMs}ms exhausted before "${spec.name}"`)
          break
        }
        const controller = new AbortController()
        let timer
        try {
          const spawned = teams.spawnTeammate(agent, {
            name: spec.name,
            description: spec.description,
            prompt: [{ type: 'text', text: spec.prompt }],
            context: spec.context,
            provider: spec.provider,
            signal: controller.signal,
          })
          const expiry = new Promise((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), remaining)
          })
          const outcome = await Promise.race([spawned, expiry])
          if (outcome === TIMED_OUT) {
            warn(`provisioning "${spec.name}" exceeded the ${timeoutMs}ms attempt budget`)
            try {
              controller.abort()
            } catch {
              // Cancelling a settled spawn is not an error.
            }
          } else if (outcome && outcome.member && typeof outcome.member.id === 'string') {
            // Only members this plugin created get the initialization gate. A
            // teammate the Lead spawns with a real task in its prompt must be
            // able to act immediately.
            gatedIds.add(outcome.member.id)
            memberNames.set(outcome.member.id, spec.name)
            persist()
          }
        } catch (error) {
          warn(`provisioning "${spec.name}" failed`, error)
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }

      // "The call returned" is not "the teammate exists".
      const after = verifyPair(agent)
      if (after.healthy) {
        state.done = true
        console.warn(`[auto-team] provisioned [${after.present.join(',')}] for ${agent.id}`)
        return true
      }
      if (after.complete && after.failed.length === 0 && after.activating.length > 0) {
        // Spawns landed but activation has not settled. Neither a success nor a
        // degradation yet: leave `done` unset so the next step re-checks for free.
        warn(
          `session ${agent.id}: spawned, waiting for [${after.activating.join(',')}] to activate`,
        )
        return false
      }
      if (after.complete) {
        state.done = true
        state.attempts = maxAttempts
        state.degraded = true
        warn(
          `DEGRADED session ${agent.id}: [${after.failed.join(',')}] failed; those names ` +
            'cannot be reused. Start a new session for a fresh pair.',
        )
        return false
      }
      warn(
        `DEGRADED session ${agent.id}: expected [${specs.map((spec) => spec.name).join(',')}] ` +
          `present [${after.present.join(',')}] missing [${after.missing.join(',')}] ` +
          `after ${state.attempts}/${maxAttempts} attempts` +
          (after.rosterKnown ? '' : ' (roster unreadable on the re-check)'),
      )
      return false
    })()

    const guarded = attempt.finally(() => {
      state.inFlight = undefined
    })
    state.inFlight = guarded
    return guarded
  }

  /**
   * Await provisioning for at most `blockBudgetMs`.
   *
   * Every wait site must use this. Binding only `agent/created` was a real defect:
   * the next `agent/pre-step` then awaited the same in-flight attempt without a
   * bound and still stalled the first model step for the remaining budget.
   *
   * @returns whether the wait was released early, leaving work in the background.
   */
  async function bounded(pending) {
    if (blockBudgetMs === 0 || blockBudgetMs >= timeoutMs) {
      await pending
      return false
    }
    let timer
    const released = await Promise.race([
      pending.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), blockBudgetMs)
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (released) pending.catch(() => {})
    return released
  }

  // Awaited before queued input is released, so the pair exists on step one.
  ctx.on('agent/created', async (payload) => {
    try {
      // Destructure inside the guard: a malformed payload must not throw out of a
      // listener whose contract says a throw fails session creation.
      const agent = payload === null || payload === undefined ? undefined : payload.agent
      const source = payload === null || payload === undefined ? undefined : payload.source
      if (agent === null || agent === undefined) return
      if (!enabled) return
      // Lazy provisioning: a fresh session starts with the Lead alone. The crew is
      // created just-in-time when the Lead first delegates, not here.
      if (provisionOn === 'lazy') return
      if (!startSources.has(source)) return
      if (!isEligibleLead(agent)) return
      const state = sessionFor(agent.id)
      if (state.source !== source) {
        // A new start source for the same session (for example /clear) is a new
        // provisioning opportunity, not "already done" — and it must also clear
        // the degraded verdict and the Lead's policy state, or a healthy new crew
        // would inherit a permanently open (or closed) valve from the old one.
        state.source = source
        state.done = false
        state.attempts = 0
        state.degraded = false
        delegatedLeads.delete(agent.id)
        nudgedLeads.delete(agent.id)
        nudgedShell.delete(agent.id)
        persist()
      }
      const released = await bounded(provision(agent, state))
      if (released) {
        warn(
          `released session start after ${blockBudgetMs}ms; provisioning continues in the background`,
        )
      }
    } catch (error) {
      warn('session-start provisioning failed', error)
    }
  })

  // Redundancy: repair a short roster on later steps while attempts remain.
  // This deliberately ignores `startSources`: a resumed or compacted session that
  // lost a member should heal, even though only `startup` seeds a fresh crew.
  ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
    } catch (error) {
      // A step decision cannot be fabricated, so propagate — but say why first,
      // so the Host log shows it was a downstream listener, not this plugin.
      warn('downstream pre-step listener failed; rethrowing', error)
      throw error
    }
    try {
      if (!enabled) return decision
      const agent = payload.agent
      if (agent === null || agent === undefined) return decision
      if (payload.signal !== undefined && payload.signal.aborted) return decision
      // Eligibility first: allocating per-agent state for every teammate and
      // subagent that takes a step is pointless churn.
      if (!isEligibleLead(agent)) return decision
      const state = sessionFor(agent.id)
      // Lazy mode: healing only applies once provisioning has begun. Before the
      // Lead delegates there is no crew to heal, and starting one here would be
      // the eager behaviour lazy mode exists to avoid.
      if (
        provisionOn === 'lazy' &&
        state.attempts === 0 &&
        state.done === false &&
        state.degraded !== true
      ) {
        return decision
      }
      if (state.done || state.attempts >= maxAttempts) return decision
      const released = await bounded(provision(agent, state))
      if (released) {
        warn(`released step ${payload.step} after ${blockBudgetMs}ms; provisioning continues`)
      }
    } catch (error) {
      warn('deferred provisioning failed', error)
    }
    return decision
  })

  /**
   * True when a durable user message carries an actual instruction: a Team
   * message (`agent-message`) or something a human typed (`user` with an rpcId).
   * Runtime-context injections such as `time-context` do not count, and neither
   * does the spawn prompt, so neither can open the gate early.
   *
   * The scan stops at `inheritedEventCount`: a `fork` teammate inherits the
   * parent session's events, and those include the human's real prompts. Without
   * this bound every forked teammate would be considered instructed before it
   * ever ran, and its initialization turn would execute with tools.
   */
  const hasInstruction = (session) => {
    const total = typeof session.seq === 'number' ? session.seq : 0
    const inherited =
      typeof session.inheritedEventCount === 'number' && session.inheritedEventCount >= 0
        ? session.inheritedEventCount
        : 0
    for (let seq = total - 1; seq >= inherited; seq -= 1) {
      const event = session.eventAt(seq)
      if (event === null || event === undefined) continue
      if (event.type !== 'user/message') continue
      const source = event.data === null || event.data === undefined ? undefined : event.data.source
      if (source === null || source === undefined || typeof source !== 'object') continue
      if (source.kind === 'agent-message') return true
      if (source.kind === 'user' && 'rpcId' in source) return true
    }
    return false
  }

  /**
   * True when this session's durable log shows it has already coordinated with
   * its team (any `team/`-prefixed event). Used to re-open the delegation valve
   * after a Host reload wiped in-memory state: an ongoing session that has used
   * its crew must not be punished by an upgrade. Inherited (forked) events do
   * not count.
   */
  const sessionHasTeamActivity = (session) => {
    if (session === null || session === undefined) return false
    if (typeof session.eventAt !== 'function') return false
    const total = typeof session.seq === 'number' ? session.seq : 0
    const inherited =
      typeof session.inheritedEventCount === 'number' && session.inheritedEventCount >= 0
        ? session.inheritedEventCount
        : 0
    for (let seq = total - 1; seq >= inherited; seq -= 1) {
      const event = session.eventAt(seq)
      if (
        event !== null &&
        event !== undefined &&
        typeof event.type === 'string' &&
        event.type.startsWith('team/')
      ) {
        return true
      }
    }
    return false
  }

  const WRITE_TOOLS = new Set([
    'write',
    'edit',
    'write_file',
    'apply_patch',
    'str_replace_editor',
    'run_code',
    // Artifact-persisting tools are writes too.
    'imagegen',
    'vision_export_artifact',
    'vision_export_report',
    'vision_export_reports',
    'vision_materialize',
    'win_clipboard_write',
  ])
  /**
   * Name-based writer detection: the set above plus any tool whose name marks it
   * as persisting an artifact. Best-effort by construction — a guardrail, not a
   * sandbox — because arbitrary code can always write.
   */
  const isWriteTool = (tool) =>
    WRITE_TOOLS.has(tool) || /^vision_export/.test(tool) || /^mcp__.+_save$/.test(tool)
  /**
   * Durable-team surfaces: creating or addressing a teammate that persists.
   * These are the only tools that justify pulling a crew into existence.
   */
  const TEAM_TOOLS = new Set([
    'spawn_teammate',
    'send_message',
    'send_structured_message',
    'team_task_create',
    'team_task_update',
  ])
  /**
   * Bounded nested-delegation surfaces. A workflow or one-shot child satisfies the
   * delegation policy (it is delegation), but it must NOT spin up a durable crew:
   * `workflow` is itself the team engine — a goal fanned out to bounded children —
   * and creating idle teammates alongside it is pure waste.
   */
  const NESTED_TOOLS = new Set(['workflow', 'subagent', 'subagent_fork'])
  const DELEGATION_TOOLS = new Set([...TEAM_TOOLS, ...NESTED_TOOLS])
  /** Shell surfaces that can mutate the tree without ever touching write/edit. */
  const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal', 'run_code'])
  /**
   * Conservative mutating-shell detector. A false positive costs one retry; a
   * false negative lets an entire job bypass the delegation policy, so the patterns
   * lean toward catching too much. Plain reads, test runs and `npm test` do not
   * match.
   */
  /**
   * Mutating-shell detection, split by confidence.
   *
   * `strong` is an unambiguous mutating verb at the start of a command segment —
   * anchored so `Get-Help mkdir` and `rg "x" file` do not match, and so `rm -rf`
   * and `cp -r` do (a trailing `\b` after `rm\s+` failed on flags starting `-`).
   *
   * `weak` is a bare redirection. It is genuinely a write, but `>` also appears
   * inside quoted strings (`rg "=>"`), so it is never treated as a hard violation.
   */
  const SHELL_MUTATION_VERBS =
    /(?:^|[;&|]\s*)\s*(?:Set-Content|Add-Content|Out-File|Tee-Object|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|mkdir|rmdir|touch|rm|del|mv|cp|ac|ni|ri|ren|rni|mi|cpi|copy|move|erase|md|rd|tee|git\s+(?:commit|push|reset|checkout|clean|add|restore)|npm\s+(?:install|add|ci)|pnpm\s+(?:add|install)|pip\s+install|uv\s+add)(?=\s|$|["'])/im
  const SHELL_REDIRECT = /(?<![0-9=<-])>(?!&)/i
  /** A shell wrapper whose -c/-Command payload is the real command to inspect. */
  const SHELL_WRAPPER = /^(?:bash|sh|pwsh|powershell|cmd)(?:\s+-\w+)*\s+(-c|-Command)\s+["']([^"']+)["']/i
  /** True when the character at `index` sits inside an opened double quote. */
  const insideQuotes = (command, index) =>
    ((command.slice(0, index).match(/"/g) ?? []).length & 1) === 1
  /**
   * Classify a command's mutating intent.
   * @returns 'strong' — an unambiguous mutating verb outside quotes; 'weak' — a
   * bare redirection outside quotes; 'quoted' — a verb inside quotes (data, not
   * action); 'none'.
   */
  const shellMutation = (exec) => {
    const args = exec.arguments
    if (args === null || args === undefined || typeof args !== 'object') return 'none'
    const command = typeof args.command === 'string' ? args.command : args.cmd
    if (typeof command !== 'string') return 'none'
    // `bash -c "..."` / `pwsh -Command "..."` — the payload is the real command.
    const wrapped = SHELL_WRAPPER.exec(command)
    if (wrapped !== null) {
      if (SHELL_MUTATION_VERBS.test(wrapped[2])) return 'strong'
      if (SHELL_REDIRECT.test(wrapped[2])) return 'weak'
      return 'none'
    }
    // A mutating verb or redirect inside quotes is data, not a mutation: demote it
    // one step instead of hard-refusing a read that merely mentions a verb.
    const verb = SHELL_MUTATION_VERBS.exec(command)
    if (verb !== null) return insideQuotes(command, verb.index) ? 'quoted' : 'strong'
    const redir = SHELL_REDIRECT.exec(command)
    if (redir !== null) return insideQuotes(command, redir.index) ? 'none' : 'weak'
    return 'none'
  }
  const specFor = (agent, membership) => {
    const byId = memberNames.get(agent.id)
    const name = byId !== undefined ? byId : membership === undefined ? undefined : membership.name
    return name === undefined ? undefined : specsByName.get(name)
  }

  // Any of these policies being live keeps the listener registered. Read-only
  // enforcement must not disappear just because the other two were switched off.
  const enforcesReadOnly = specs.some((spec) => spec.writes === false)

  // Structural, not advisory:
  //  1. A freshly spawned teammate has no tools until the Lead actually asks it
  //     something, so initialization terminates instead of "starting work".
  //  2. A verification role cannot write. The role is enforced by capability, not
  //     by a sentence in its brief.
  //  3. A Lead that edits files before delegating anything is refused once per
  //     session; retrying the same call overrides the nudge.
  if (enabled && (gateInitialTurn || requireDelegationFirst || shellGuard || enforcesReadOnly || reportEvery > 0)) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      let decision
      try {
        decision = await next()
      } catch (error) {
        // A downstream policy threw. Failing open here is the conservative choice:
        // rejecting would surface as a tool error with no explanation, and our own
        // policy has not decided anything yet.
        warn('downstream pre-execute listener failed; allowing the call', error)
        return { kind: 'allow' }
      }
      try {
        // A delegation *attempt* clears the valve even when the call itself is
        // refused downstream. That is the documented contract ("attempting a
        // delegation clears this even if the call fails") and the only thing
        // stopping a downstream deny from locking the Lead out under `require`.
        if (exec !== null && exec !== undefined) {
          const earlyAgent = exec.agent
          const earlyTool = typeof exec.name === 'string' ? exec.name : ''
          if (
            earlyAgent !== null &&
            earlyAgent !== undefined &&
            DELEGATION_TOOLS.has(earlyTool)
          ) {
            delegatedLeads.add(earlyAgent.id)
            persist()
          }
        }
        if (decision.kind !== 'allow') return decision
        if (exec === null || exec === undefined) return decision
        const agent = exec.agent
        if (agent === null || agent === undefined) return decision
        const tool = typeof exec.name === 'string' ? exec.name : ''
        const membership = membershipOf(agent)

        // Flash-only: a child that names a model must name the flash model. The
        // surfaces that take a model are checked directly; teammates inherit the
        // Lead's route, so keeping the Lead on flash keeps them on flash.
        if (flashOnly && CHILD_MODEL_TOOLS.has(tool)) {
          const args = exec.arguments
          const requested =
            args !== null && typeof args === 'object' && typeof args.model === 'string'
              ? args.model
              : undefined
          if (requested !== undefined && requested !== FLASH_MODEL) {
            logDenial(agent.id, 'flash-only', tool + ' requested model ' + requested)
            return {
              kind: 'deny',
              reason:
                'This profile runs children on ' + FLASH_MODEL + ' only. Omit model, or set model: ' +
                JSON.stringify(FLASH_MODEL) + '.',
            }
          }
        }

        if ((requireDelegationFirst || shellGuard) && membership !== undefined && membership.role === 'lead') {
          const leadState = sessions.get(agent.id)
          // Never trap a session whose crew could not be provisioned or whose
          // roster cannot be repaired: `degraded` and exhausted attempts both mean
          // "stop pushing work to a crew that cannot take it".
          const unusable =
            leadState !== undefined &&
            (leadState.degraded === true || leadState.attempts >= maxAttempts)
          let delegated = delegatedLeads.has(agent.id)
          // A Host or plugin reload wipes in-memory policy state, but the Lead's
          // session log is durable: if this session has already coordinated with
          // its team (team/* events), the valve re-opens instead of re-blocking
          // an ongoing session after an upgrade.
          if (!delegated && sessionHasTeamActivity(agent.session)) {
            delegatedLeads.add(agent.id)
            persist()
            delegated = true
          }

          if (requireDelegationFirst) {
            if (DELEGATION_TOOLS.has(tool)) {
              // Just-in-time provisioning, and only for a durable-team surface:
              // the crew is created when the Lead actually addresses teammates,
              // not when it runs a workflow (the workflow engine is its own team).
              if (provisionOn === 'lazy' && TEAM_TOOLS.has(tool)) {
                const lazyState = sessionFor(agent.id)
                try {
                  await bounded(provision(agent, lazyState))
                } catch (error) {
                  warn('just-in-time provisioning failed', error)
                }
              }
              delegatedLeads.add(agent.id)
              persist()
              return decision
            }
            if (!delegated && !unusable && isWriteTool(tool)) {
              if (delegationPolicy === 'nudge' && nudgedLeads.has(agent.id)) return decision
              nudgedLeads.add(agent.id)
              persist()
              logDenial(agent.id, 'delegation-first', `${tool} before any delegation`)
              return {
                kind: 'deny',
                reason:
                  'This session has not delegated anything yet. Put the first slice on a crew ' +
                  'member with `send_message` (scout, builder, critic, operator) or fan it out with ' +
                  '`workflow`; file edits are refused until then. Attempting a delegation clears ' +
                  'this even if the call fails.' +
                  (delegationPolicy === 'nudge' ? ' Retry this exact call to override.' : ''),
              }
            }
          }

          // Shell is a write surface too. `strong` matches are unambiguous mutating
          // verbs; under `require` they are refused until the Lead delegates, so the
          // shell cannot become the way around a locked write/edit. `weak` matches
          // are bare redirections, which also occur inside quoted strings, so they
          // only ever earn a one-shot nudge.
          if (shellGuard && !delegated && !unusable && SHELL_TOOLS.has(tool)) {
            const mutation = shellMutation(exec)
            if (mutation !== 'none' && mutation !== 'quoted') {
              const strong = mutation === 'strong'
              if (strong && delegationPolicy === 'require') {
                logDenial(agent.id, 'shell-mutation', `${tool} before any delegation`)
                return {
                  kind: 'deny',
                  reason:
                    'That shell command mutates the filesystem, which is builder work (or operator ' +
                    'work if it is long-running). Under `delegationPolicy: require` it is refused ' +
                    'until you delegate — retrying will not help. Delegate, or set the policy to ' +
                    '`nudge` if you intend to work solo.',
                }
              }
              if (!nudgedShell.has(agent.id)) {
                nudgedShell.add(agent.id)
                persist()
                return {
                  kind: 'deny',
                  reason:
                    (strong
                      ? 'That shell command mutates the filesystem. Delegate it to builder (or ' +
                        'operator for a long job), '
                      : 'That command looks like a file redirection. If it writes, delegate it; ') +
                    'retry this exact call to proceed yourself. Verification and read-only commands ' +
                    'are unaffected.',
                }
              }
            }
          }
          return decision
        }

        if (membership === undefined || membership.role !== 'teammate') return decision

        const spec = specFor(agent, membership)
        if (spec !== undefined && spec.writes === false) {
          // A mutating shell command is a write. Without this the read-only role
          // was advisory: `critic` could `Set-Content` its way around the block.
          const mutation = SHELL_TOOLS.has(tool) ? shellMutation(exec) : 'none'
          const shellWrite = mutation === 'strong' || mutation === 'weak'
          if (isWriteTool(tool) || shellWrite) {
            logDenial(agent.id, 'read-only', `${spec.name} attempted ${tool}`)
            return {
              kind: 'deny',
              reason:
                `\`${spec.name}\` is a read-only role: \`${tool}\` is refused` +
                (shellWrite ? ' (a mutating shell command counts as a write)' : '') +
                '. Report the defect and its evidence to the Lead; do not repair it yourself.',
            }
          }
        }

        // Compelled reporting: a member cannot grind indefinitely without telling
        // anyone. Sending a message resets the window; hitting it once forces a
        // status line, then clears so a long task continues normally.
        const allowOrReport = () => {
          if (reportEvery <= 0) return decision
          if (MESSAGING_TOOLS.has(tool)) {
            outboundCalls.set(agent.id, 0)
            return decision
          }
          const used = (outboundCalls.get(agent.id) ?? 0) + 1
          if (used >= reportEvery) {
            // Do NOT reset the counter here: resetting would let the very next
            // call pass without a message, turning the policy into a 1-in-N
            // speed bump. Only an actual outbound message resets it.
            logDenial(agent.id, 'silent-member', `${used} tool calls without a message`)
            return {
              kind: 'deny',
              reason:
                `You have made ${used} tool calls since your last message. Report now: ` +
                '`send_message` to `lead` with one line of what you did, one line of what you ' +
                'found (with evidence), and one line of what is next. Then continue.',
            }
          }
          outboundCalls.set(agent.id, used)
          return decision
        }

        if (!gateInitialTurn) return allowOrReport()
        if (released.has(agent.id)) return allowOrReport()
        if (!gatedIds.has(agent.id) && !specNames.has(membership.name)) return allowOrReport()
        const session = agent.session
        if (session === null || session === undefined) return allowOrReport()
        if (typeof session.eventAt !== 'function') return allowOrReport()
        if (hasInstruction(session)) {
          released.add(agent.id)
          gatedIds.delete(agent.id)
          persist()
          return allowOrReport()
        }
        logDenial(agent.id, 'initialization', tool)
        return {
          kind: 'deny',
          reason:
            'Initialization turn: you have no tools until the Lead sends your first assignment. ' +
            'Do not explore, do not ask questions, and do not address the user. Reply READY and stop.',
        }
      } catch (error) {
        // Fail open: policy that cannot evaluate must never brick a working agent.
        warn('pre-execute policy failed open', error)
        return decision
      }
    })
  }

  // A long-lived Host creates and disposes many agents. Policy state must not
  // outlive the agent, and a recycled id must not inherit a stale decision.
  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload === null || payload === undefined ? undefined : payload.agent
      const id = agent === null || agent === undefined ? undefined : agent.id
      if (id === undefined) return
      sessions.delete(id)
      released.delete(id)
      gatedIds.delete(id)
      memberNames.delete(id)
      nudgedLeads.delete(id)
      nudgedShell.delete(id)
      outboundCalls.delete(id)
      for (const key of [...loggedDenials]) {
        if (key.startsWith(`${id}|`)) loggedDenials.delete(key)
      }
      delegatedLeads.delete(id)
    } catch (error) {
      warn('disposal cleanup failed', error)
    }
  })

  return () => {
    sessions.clear()
    released.clear()
    gatedIds.clear()
    memberNames.clear()
    nudgedLeads.clear()
    nudgedShell.clear()
    outboundCalls.clear()
    loggedDenials.clear()
    delegatedLeads.clear()
  }
}