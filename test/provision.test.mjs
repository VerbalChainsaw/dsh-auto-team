// Verification harness for @local/dsh-auto-team.
//
// It imports the real plugin and drives its real `agent/created` and
// `agent/pre-step` listeners against a fake Agent Teams service. That covers the
// logic most likely to be wrong — the recursion guard, the idempotency guard, the
// no-throw contract, the timeout, and the retry — without needing a model
// credential or a fresh Host session.
//
// Run: node test/provision.test.mjs

import assert from 'node:assert/strict'
// Target any copy of the plugin: by default the workspace source, or an installed
// artifact via AUTO_TEAM_MODULE. That is what makes the suite able to validate the
// bytes that are actually installed in a profile.
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const tempState = () => join(mkdtempSync(join(tmpdir(), 'auto-team-state-')), 'policy.json')
import { pathToFileURL } from 'node:url'

// On Windows an absolute path must become a file:// URL for the ESM loader --
// verify.mjs passes exactly this to test the installed artifact.
const rawModule = process.env.AUTO_TEAM_MODULE ?? '../index.js'
const modulePath = isAbsolute(rawModule) ? pathToFileURL(rawModule).href : rawModule
const { apply: pluginApply, inject, name } = await import(modulePath)

// Hermetic suite. Durability is off by default so no test can leak policy state
// into another test, or into the operator's real ~/.dsh state file.
const apply = (ctx, cfg = {}) => pluginApply(ctx, { persistState: false, ...cfg })

const CREW = ['scout', 'builder', 'critic', 'operator']

let failures = 0
const results = []

async function test(title, run) {
  try {
    await run()
    results.push(`PASS  ${title}`)
  } catch (error) {
    failures += 1
    results.push(`FAIL  ${title}\n        ${error.message}`)
  }
}

/** Build a ctx that records listeners and can dispatch them in order. */
function makeCtx(teams) {
  const listeners = new Map()
  const ctx = {
    agentTeams: teams,
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
  }
  return {
    ctx,
    count: (event) => (listeners.get(event) ?? []).length,
    async fire(event, payload, next = async () => ({ kind: 'ok', messages: [] })) {
      const list = listeners.get(event) ?? []
      // An inert plugin registers nothing, and that is correct: firing an event at
      // it must be a no-op rather than a harness error.
      if (list.length === 0) return { kind: 'allow' }
      let value
      for (const handler of list) value = await handler(payload, next)
      return value
    },
  }
}

/**
 * Fake Agent Teams service.
 * @param role - role tryMembership reports.
 * @param members - roster listMembers returns.
 * @param behaviour - 'ok' | 'throw' | 'hang' | 'fail-once'.
 */
function makeTeams({ role = 'lead', memberName = 'lead', members, behaviour = 'ok', hangMs = 5000 } = {}) {
  const spawned = []
  const journaled = new Set()
  const burned = new Set()
  let calls = 0
  let lastSpawn
  return {
    spawned,
    callCount: () => calls,
    get lastSpawn() {
      return lastSpawn
    },
    tryMembership: () => ({ role, name: memberName }),
    // A real Host roster reflects what was actually spawned; an explicit
    // `members` array overrides that to simulate a pre-existing team.
    listMembers: () =>
      members ??
      [...journaled].map((memberName) => ({
        role: 'teammate',
        status: burned.has(memberName)
          ? 'failed'
          : spawned.includes(memberName)
            ? 'inactive'
            : 'provisioning',
        name: memberName,
      })),
    spawnTeammate: (agent, request) =>
      new Promise((resolve, reject) => {
        calls += 1
        lastSpawn = { context: request.context, provider: request.provider }
        if (burned.has(request.name)) {
          reject(new Error('TEAM_MEMBER_NAME_TAKEN'))
          return
        }
        if (behaviour === 'throw') {
          burned.add(request.name)
          reject(new Error('provider exploded'))
          return
        }
        if (behaviour === 'fail-once' && calls === 1) {
          burned.add(request.name)
          reject(new Error('transient failure'))
          return
        }
        // 'silent' resolves without the member ever appearing on the roster:
        // the exact case roster verification exists to catch.
        const silent = behaviour === 'silent' || (behaviour === 'silent-once' && calls === 1)
        const delay = behaviour === 'hang' ? hangMs : 1
        const timer = setTimeout(() => {
          journaled.add(request.name)
          if (!silent) spawned.push(request.name)
          resolve({
            member: {
              id: `member-${request.name}`,
              name: request.name,
              role: 'teammate',
              status: 'running',
            },
          })
        }, delay)
        request.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      }),
  }
}
const LEAD = { id: 's-lead' }
const startup = { agent: LEAD, source: 'startup' }

const makeSession = (events, inheritedEventCount = 0) => ({
  seq: events.length,
  inheritedEventCount,
  eventAt: (index) => events[index],
})
const SPAWN_PROMPT = { type: 'user/message', data: { source: { kind: 'subagent' } } }
const TIME_CONTEXT = { type: 'user/message', data: { source: { kind: 'time-context' } } }
const ASSIGNMENT = { type: 'user/message', data: { source: { kind: 'agent-message' } } }
const HUMAN = { type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-1' } } }
const ALLOW = async () => ({ kind: 'allow' })
const teammateAgent = (events) => ({ id: 's-teammate', session: makeSession(events) })



await test('a fresh lead session gets the configured pair, in order, before input', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', startup)
  dispose()
  assert.deepEqual(teams.spawned, CREW)
})

await test('a teammate emitting agent/created does not trigger more teammates (no recursion)', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'scout' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', { agent: { id: 's-child' }, source: 'startup' })
  dispose()
  assert.deepEqual(teams.spawned, [])
})

await test('a non-Team subagent (tryMembership undefined) is left alone', async () => {
  const teams = makeTeams()
  teams.tryMembership = () => undefined
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', { agent: { id: 's-sub' }, source: 'startup' })
  dispose()
  assert.deepEqual(teams.spawned, [])
})

await test('a resume is not a fresh start', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', { agent: LEAD, source: 'resume' })
  dispose()
  assert.deepEqual(teams.spawned, [])
})

await test('a complete existing roster is not duplicated', async () => {
  const teams = makeTeams({
    members: [
      { role: 'teammate', status: 'inactive', name: 'scout' },
      { role: 'teammate', status: 'inactive', name: 'builder' },
      { role: 'teammate', status: 'inactive', name: 'critic' },
      { role: 'teammate', status: 'inactive', name: 'operator' },
    ],
  })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', startup)
  dispose()
  assert.deepEqual(teams.spawned, [])
})

await test('a partial roster is completed by name, not duplicated', async () => {
  const teams = makeTeams({ members: [{ role: 'teammate', status: 'inactive', name: 'scout' }] })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', startup)
  dispose()
  assert.deepEqual(teams.spawned, ['builder', 'critic', 'operator'], 'only the missing members should spawn')
})

await test('a throwing provider never fails session creation', async () => {
  const teams = makeTeams({ behaviour: 'throw' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'], maxAttempts: 1 })
  await fire('agent/created', startup) // must resolve, not reject
  dispose()
  assert.deepEqual(teams.spawned, [])
})

await test('hanging providers are bounded by one attempt budget, not one timeout each', async () => {
  const teams = makeTeams({ behaviour: 'hang', hangMs: 30000 })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'], spawnTimeoutMs: 60, maxAttempts: 1 })
  const started = Date.now()
  await fire('agent/created', startup)
  const elapsed = Date.now() - started
  dispose()
  // Two stalled spawns must not cost 2 x 60ms of session-creation latency.
  assert.ok(elapsed < 1000, `should return after one budget, took ${elapsed}ms`)
  assert.deepEqual(teams.spawned, [], 'neither stalled teammate should be recorded')
})

await test('a duplicate agent/created for one session does not double-spawn', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', startup)
  await fire('agent/created', startup)
  dispose()
  assert.deepEqual(teams.spawned, CREW)
})

await test('a failed name is burned and never re-spawned, matching the real Team journal', async () => {
  const teams = makeTeams({ behaviour: 'fail-once' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', startup)
  assert.deepEqual(teams.spawned, ['builder', 'critic', 'operator'], 'scout failed, the rest succeeded')
  await fire('agent/pre-step', { agent: LEAD, turn: 1, step: 1 })
  assert.deepEqual(
    teams.spawned,
    ['builder', 'critic', 'operator'],
    'a burned name can never be re-spawned',
  )
  await fire('agent/pre-step', { agent: LEAD, turn: 1, step: 2 })
  assert.deepEqual(teams.spawned, ['builder', 'critic', 'operator'], 'the degraded verdict holds; nothing more spawns')
  dispose()
})

await test('disabled config spawns nothing', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: false })
  await fire('agent/created', startup)
  dispose()
  assert.deepEqual(teams.spawned, [])
})

await test('malformed teammate specs are dropped and the shipped pair is used', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, teammates: [{ name: '', prompt: '' }] })
  await fire('agent/created', startup)
  dispose()
  assert.deepEqual(teams.spawned, CREW)
})

await test('the shipped brief tells the teammate its mode, job, team and standard', async () => {
  // Regression guard, twice over:
  //  - an earlier charter asked it to "name the two facts you'd want first", which a
  //    fresh agent put back to the user as a question;
  //  - the initialization gate denies tools, so the brief must carry everything the
  //    teammate knows: mode, job, team, how work arrives, and the evidence standard.
  const teams = makeTeams()
  const captured = []
  const spawn = teams.spawnTeammate
  teams.spawnTeammate = (agent, request) => {
    captured.push(request.prompt.map((block) => block.text ?? '').join('\n'))
    return spawn(agent, request)
  }
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', startup)
  dispose()
  assert.equal(captured.length, CREW.length)
  for (const charter of captured) {
    assert.match(charter, /READY/, 'must demand a token acknowledgement')
    assert.match(charter, /never address the user/i, 'must forbid addressing the user')
    assert.match(charter, /start clean|do nothing until/i, 'must state the starting mode')
    assert.match(charter, /Your job:/, 'must state the job')
    assert.match(charter, /send_message/, 'must say how work reaches it')
    assert.ok(charter.length < 1200, 'the standby brief must stay small: ' + charter.length)
    assert.match(charter, /VERIFIED/, 'must state the evidence standard')
    assert.match(charter, /Lead/i, 'must identify the Lead')
    assert.doesNotMatch(charter, /would most want|name the two|what you would/i, 'must not ask it a question')
    assert.doesNotMatch(charter, /## Recipes/, 'the full manual must not be pumped into every spawn')
  }
  assert.notEqual(captured[0], captured[1], 'each half gets its own mission')
})

await test('a changed Agent Teams surface disables cleanly instead of failing per session', async () => {
  // Simulates a future dsh release that renames spawnTeammate.
  const teams = {
    tryMembership: () => ({ role: 'lead', name: 'lead' }),
    listMembers: () => [],
  }
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', startup) // must resolve, not reject
  dispose()
})

await test('a stalled provider releases session start at blockBudgetMs and finishes in the background', async () => {
  const teams = makeTeams({ behaviour: 'hang', hangMs: 30000 })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, {
    enabled: true,
    startSources: ['startup'],
    spawnTimeoutMs: 30000,
    blockBudgetMs: 60,
    maxAttempts: 1,
  })
  const started = Date.now()
  await fire('agent/created', startup)
  const elapsed = Date.now() - started
  dispose()
  assert.ok(elapsed < 2000, `session start should release early, took ${elapsed}ms`)
})

await test('after the block budget releases session start, the next step is bounded too', async () => {
  // CENTER C0: agent/created is bounded by blockBudgetMs, but agent/pre-step
  // awaited the same in-flight attempt unbounded, so a stalled provider still
  // delayed the first model step by the remaining attempt budget.
  const teams = makeTeams({ behaviour: 'hang', hangMs: 30000 })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, {
    enabled: true,
    startSources: ['startup'],
    spawnTimeoutMs: 30000,
    blockBudgetMs: 60,
    maxAttempts: 3,
  })
  await fire('agent/created', startup)
  const started = Date.now()
  await fire('agent/pre-step', { agent: LEAD, turn: 1, step: 1 })
  const elapsed = Date.now() - started
  dispose()
  assert.ok(elapsed < 2000, `first step re-blocked on the stalled attempt, took ${elapsed}ms`)
})

await test('a freshly spawned teammate has no tools until it is actually instructed', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'scout' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const decision = await fire(
    'tools/pre-execute',
    { agent: teammateAgent([SPAWN_PROMPT]), name: 'pwsh' },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'deny', 'initialization must not be able to act')
  assert.match(decision.reason, /READY/, 'denial must tell it to stop')
})

await test('a runtime-context injection does not open the gate', async () => {
  // time-context and friends append user messages too; a naive "second user
  // message means instructed" check would unlock every agent's first turn.
  const teams = makeTeams({ role: 'teammate', memberName: 'scout' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const decision = await fire(
    'tools/pre-execute',
    { agent: teammateAgent([SPAWN_PROMPT, TIME_CONTEXT]), name: 'read' },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'deny')
})

await test('a real team assignment opens the gate, permanently', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'scout' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const instructed = await fire(
    'tools/pre-execute',
    { agent: teammateAgent([SPAWN_PROMPT, ASSIGNMENT]), name: 'read' },
    ALLOW,
  )
  const afterwards = await fire(
    'tools/pre-execute',
    { agent: teammateAgent([SPAWN_PROMPT]), name: 'read' },
    ALLOW,
  )
  dispose()
  assert.equal(instructed.kind, 'allow')
  assert.equal(afterwards.kind, 'allow', 'stays open once released')
})

await test('a human-typed message also opens the gate', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'scout' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const decision = await fire(
    'tools/pre-execute',
    { agent: teammateAgent([SPAWN_PROMPT, HUMAN]), name: 'read' },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'allow')
})

await test('the Lead and non-Team children are never gated', async () => {
  const lead = makeTeams({ role: 'lead' })
  const a = makeCtx(lead)
  const disposeA = apply(a.ctx, { enabled: true })
  const leadDecision = await a.fire(
    'tools/pre-execute',
    { agent: teammateAgent([SPAWN_PROMPT]), name: 'read' },
    ALLOW,
  )
  disposeA()

  const other = makeTeams()
  other.tryMembership = () => undefined
  const b = makeCtx(other)
  const disposeB = apply(b.ctx, { enabled: true })
  const childDecision = await b.fire(
    'tools/pre-execute',
    { agent: teammateAgent([SPAWN_PROMPT]), name: 'read' },
    ALLOW,
  )
  disposeB()

  assert.equal(leadDecision.kind, 'allow')
  assert.equal(childDecision.kind, 'allow')
})

await test('the gate fails open when it cannot evaluate', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'scout' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const decision = await fire(
    'tools/pre-execute',
    { agent: { id: 's-teammate' }, name: 'read' },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'allow', 'a broken gate must never brick an agent')
})

await test('a teammate the Lead spawns with a real task is not initialization-gated', async () => {
  // Gap G1: gating by role would deny a specialist whose spawn prompt IS its
  // assignment, which is spawn_teammate's documented contract.
  const teams = makeTeams({ role: 'teammate', memberName: 'analyst' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const decision = await fire(
    'tools/pre-execute',
    { agent: { id: 's-specialist', session: makeSession([SPAWN_PROMPT]) }, name: 'pwsh' },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'allow', 'a teammate with a real task must be able to act')
})

await test('the gate follows the member identity this plugin created', async () => {
  // Configured names are reserved, and recorded member ids are gated even when
  // the reported membership name is something else.
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', startup) // Lead provisions; member ids are recorded
  teams.tryMembership = () => ({ role: 'teammate', name: 'analyst' })
  const decision = await fire(
    'tools/pre-execute',
    { agent: { id: 'member-scout', session: makeSession([SPAWN_PROMPT]) }, name: 'read' },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'deny', 'a member this plugin spawned is gated by id')
})

await test('a disarmed plugin registers no gate at all', async () => {
  // Gap G2: gateInitialTurn was honoured even when enabled was false, so a
  // disarmed plugin still denied teammate tools.
  const teams = makeTeams({ role: 'teammate', memberName: 'scout' })
  const { ctx, count } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: false })
  const gateListeners = count('tools/pre-execute')
  dispose()
  assert.equal(gateListeners, 0, 'disabled means inert, not partially active')
})

await test('a failed teammate name is not retried, because a Team name is never reusable', async () => {
  // spawnAdmitted rejects any reuse of a journaled name, so retrying a failed
  // name can never succeed. It must stop immediately instead of burning attempts.
  const teams = makeTeams({
    members: [
      { role: 'teammate', status: 'inactive', name: 'scout' },
      { role: 'teammate', status: 'inactive', name: 'builder' },
      { role: 'teammate', status: 'failed', name: 'critic' },
      { role: 'teammate', status: 'inactive', name: 'operator' },
    ],
  })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'], maxAttempts: 3 })
  await fire('agent/created', startup)
  const afterCreate = teams.callCount()
  await fire('agent/pre-step', { agent: LEAD, turn: 1, step: 1 })
  const afterStep = teams.callCount()
  dispose()
  assert.equal(afterCreate, 0, 'no spawn is attempted for a name that is already journaled')
  assert.equal(afterStep, 0, 'the failed name is not retried on later steps')
})

await test('a read-only role cannot write; the implementation role can', async () => {
  const scoutTeams = makeTeams({ role: 'teammate', memberName: 'scout' })
  const a = makeCtx(scoutTeams)
  const disposeA = apply(a.ctx, { enabled: true })
  const denied = await a.fire(
    'tools/pre-execute',
    { agent: teammateAgent([SPAWN_PROMPT]), name: 'write' },
    ALLOW,
  )
  disposeA()

  const builderTeams = makeTeams({ role: 'teammate', memberName: 'builder' })
  const b = makeCtx(builderTeams)
  const disposeB = apply(b.ctx, { enabled: true })
  const allowed = await b.fire(
    'tools/pre-execute',
    { agent: teammateAgent([SPAWN_PROMPT, ASSIGNMENT]), name: 'write' },
    ALLOW,
  )
  disposeB()

  assert.equal(denied.kind, 'deny', 'verification must not repair what it found')
  assert.match(denied.reason, /read-only/i)
  assert.equal(allowed.kind, 'allow', 'implementation writes')
})

await test('nudge mode: a Lead edit is refused once, then allowed on retry', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, delegationPolicy: 'nudge' })
  const lead = { id: 's-lead' }
  const first = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  const second = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(first.kind, 'deny', 'enforce delegation before solo implementation')
  assert.match(first.reason, /delegat/i)
  assert.equal(second.kind, 'allow', 'a retry overrides, so a session can never brick')
})

await test('a Lead that delegated first is never nudged', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const lead = { id: 's-lead' }
  const delegated = await fire('tools/pre-execute', { agent: lead, name: 'send_message' }, ALLOW)
  const edit = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(delegated.kind, 'allow')
  assert.equal(edit.kind, 'allow', 'delegation already happened')
})

await test('require mode: edits stay refused across retries until a delegation is attempted', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true }) // default is 'require'
  const lead = { id: 's-lead' }
  const first = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  const retry = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  const delegated = await fire('tools/pre-execute', { agent: lead, name: 'send_message' }, ALLOW)
  const afterwards = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(first.kind, 'deny', 'no solo implementation before delegation')
  assert.equal(retry.kind, 'deny', 'a retry must not silently defeat the policy')
  assert.equal(delegated.kind, 'allow')
  assert.equal(afterwards.kind, 'allow', 'delegation opens file edits')
})

await test('require mode: an unusable crew never traps the Lead', async () => {
  // If provisioning exhausts its attempts, editing must be allowed again: the
  // policy exists to push work to a crew, not to punish a broken crew.
  const teams = makeTeams({ role: 'lead', behaviour: 'throw' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'], maxAttempts: 1 })
  await fire('agent/created', startup)
  const edit = await fire('tools/pre-execute', { agent: LEAD, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(edit.kind, 'allow', 'a degraded crew must not block the session')
})

await test('delegationPolicy off disables the policy entirely', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, delegationPolicy: 'off' })
  const edit = await fire('tools/pre-execute', { agent: { id: 's-lead' }, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(edit.kind, 'allow')
})

await test('read-only roles stay enforced when the other policies are off', async () => {
  // Gap: the listener used to be registered only for the init gate and the
  // delegation policy, so switching both off silently made critic writable.
  const teams = makeTeams({ role: 'teammate', memberName: 'critic' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, gateInitialTurn: false, delegationPolicy: 'off' })
  const decision = await fire(
    'tools/pre-execute',
    { agent: { id: 's-critic', session: makeSession([SPAWN_PROMPT, ASSIGNMENT]) }, name: 'edit' },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'deny', 'verification must not write with other policies off')
})

await test('a fork teammate does not inherit its way out of the gate', async () => {
  // Gap: a forked session carries the Lead's human messages, which used to count
  // as a real instruction before the teammate ever ran a turn.
  const teams = makeTeams({ role: 'teammate', memberName: 'scout' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const session = makeSession([HUMAN, HUMAN, SPAWN_PROMPT], 2)
  const decision = await fire(
    'tools/pre-execute',
    { agent: { id: 's-fork', session }, name: 'read' },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'deny', 'inherited history is not an instruction')
})

await test('disposing an agent clears its policy state', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const lead = { id: 's-lead' }
  await fire('tools/pre-execute', { agent: lead, name: 'send_message' }, ALLOW)
  const before = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  await fire('agent/disposed', { agent: lead })
  const after = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(before.kind, 'allow')
  assert.equal(after.kind, 'deny', 'a recycled id must not inherit the old decision')
})

await test('a redirection is nudged once for the Lead, then allowed', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const lead = { id: 's-lead' }
  const edit = { agent: lead, name: 'pwsh', arguments: { command: 'Get-Date > out.txt' } }
  const first = await fire('tools/pre-execute', edit, ALLOW)
  const retry = await fire('tools/pre-execute', edit, ALLOW)
  dispose()
  assert.equal(first.kind, 'deny', 'a write in disguise should be challenged')
  assert.match(first.reason, /builder|delegate/i)
  assert.equal(retry.kind, 'allow', 'shell is also how verification runs: one retry passes')
})

await test('read-only shell commands are never challenged', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const decision = await fire(
    'tools/pre-execute',
    { agent: { id: 's-lead' }, name: 'pwsh', arguments: { command: 'node test/provision.test.mjs' } },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'allow')
})

await test('a delegated Lead may mutate the tree however it likes', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const lead = { id: 's-lead' }
  await fire('tools/pre-execute', { agent: lead, name: 'send_message' }, ALLOW)
  const decision = await fire(
    'tools/pre-execute',
    { agent: lead, name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force dist' } },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'allow')
})

await test('shellGuard false disables the shell nudge', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, shellGuard: false })
  const decision = await fire(
    'tools/pre-execute',
    { agent: { id: 's-lead' }, name: 'pwsh', arguments: { command: 'New-Item -ItemType Directory dist' } },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'allow')
})

await test('a member that grinds without reporting is stopped and told to report', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'builder' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, reportEvery: 3 })
  const builder = { id: 's-builder', session: makeSession([SPAWN_PROMPT, ASSIGNMENT]) }
  const kinds = []
  for (let i = 0; i < 4; i += 1) {
    const d = await fire('tools/pre-execute', { agent: builder, name: 'read' }, ALLOW)
    kinds.push(d.kind)
  }
  const reported = await fire('tools/pre-execute', { agent: builder, name: 'send_message' }, ALLOW)
  const after = await fire('tools/pre-execute', { agent: builder, name: 'read' }, ALLOW)
  dispose()
  assert.deepEqual(kinds, ['allow', 'allow', 'deny', 'deny'], 'refusal persists until the member actually reports')
  assert.equal(reported.kind, 'allow', 'sending a message is always allowed')
  assert.equal(after.kind, 'allow', 'the window resets after reporting')
})

await test('reportEvery 0 disables compelled reporting', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'builder' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, reportEvery: 0 })
  const builder = { id: 's-builder', session: makeSession([SPAWN_PROMPT, ASSIGNMENT]) }
  let sawDeny = false
  for (let i = 0; i < 25; i += 1) {
    const d = await fire('tools/pre-execute', { agent: builder, name: 'read' }, ALLOW)
    if (d.kind !== 'allow') sawDeny = true
  }
  dispose()
  assert.equal(sawDeny, false)
})

await test('require mode refuses a mutating shell command until the Lead delegates', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true }) // default policy: require
  const lead = { id: 's-lead' }
  const command = { agent: lead, name: 'pwsh', arguments: { command: 'rm -rf build' } }
  const first = await fire('tools/pre-execute', command, ALLOW)
  const retry = await fire('tools/pre-execute', command, ALLOW)
  await fire('tools/pre-execute', { agent: lead, name: 'send_message' }, ALLOW)
  const afterDelegating = await fire('tools/pre-execute', command, ALLOW)
  dispose()
  assert.equal(first.kind, 'deny', 'a destructive shell command is a write')
  assert.equal(retry.kind, 'deny', 'retrying must not defeat require mode')
  assert.equal(afterDelegating.kind, 'allow', 'delegation opens it')
})

await test('a read-only role cannot mutate through the shell either', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'critic' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const agent = { id: 's-critic', session: makeSession([SPAWN_PROMPT, ASSIGNMENT]) }
  const destructive = await fire(
    'tools/pre-execute',
    { agent, name: 'pwsh', arguments: { command: 'git commit -am wip' } },
    ALLOW,
  )
  const readOnly = await fire(
    'tools/pre-execute',
    { agent, name: 'pwsh', arguments: { command: 'node test/provision.test.mjs' } },
    ALLOW,
  )
  dispose()
  assert.equal(destructive.kind, 'deny', 'shell writes are writes')
  assert.match(destructive.reason, /read-only/i)
  assert.equal(readOnly.kind, 'allow', 'running a check is not a write')
})

await test('an unreadable roster is reported instead of spawning blind', async () => {
  const teams = makeTeams()
  teams.listMembers = () => {
    throw new Error('journal unavailable')
  }
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'], maxAttempts: 1 })
  await fire('agent/created', startup)
  dispose()
  assert.deepEqual(teams.spawned, [], 'must not spawn names it cannot reconcile')
})

await test('a DEGRADED crew opens the Lead write valve', async () => {
  const teams = makeTeams({
    members: [
      { role: 'teammate', status: 'inactive', name: 'scout' },
      { role: 'teammate', status: 'inactive', name: 'builder' },
      { role: 'teammate', status: 'failed', name: 'critic' },
      { role: 'teammate', status: 'inactive', name: 'operator' },
    ],
  })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', startup) // DEGRADED: critic is failed and cannot be replaced
  const edit = await fire('tools/pre-execute', { agent: { id: 's-lead' }, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(edit.kind, 'allow', 'a crew that cannot be repaired must not lock the Lead out')
})

await test('compelled reporting works even when every other policy is off', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'custom-writer' })
  const { ctx, fire, count } = makeCtx(teams)
  const dispose = apply(ctx, {
    enabled: true,
    gateInitialTurn: false,
    delegationPolicy: 'off',
    shellGuard: false,
    reportEvery: 3,
    teammates: [{ name: 'custom-writer', description: 'w', prompt: 'w', writes: true }],
  })
  const gateListeners = count('tools/pre-execute')
  dispose()
  assert.ok(gateListeners >= 1, 'reportEvery alone must keep the policy listener registered')
})

await test('a new start source clears the Lead delegation valve, not just provisioning state', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup', 'clear'] })
  const lead = { id: 's-lead' }
  await fire('tools/pre-execute', { agent: lead, name: 'send_message' }, ALLOW)
  const before = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  await fire('agent/created', { agent: LEAD, source: 'clear' })
  const after = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(before.kind, 'allow', 'delegation opens edits')
  assert.equal(after.kind, 'deny', '/clear re-arms the valve instead of inheriting the old decision')
})

await test('invalid member names are dropped, valid ones kept, all-invalid falls back', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, {
    enabled: true,
    startSources: ['startup'],
    teammates: [
      { name: 'Scout Bad', description: 'x', prompt: 'x' },
      { name: 'ok-name', description: 'x', prompt: 'x', writes: true },
    ],
  })
  await fire('agent/created', startup)
  dispose()
  assert.deepEqual(teams.spawned, ['ok-name'], 'invalid names are dropped, valid ones spawned')
})

await test('a fork-context teammate maps to the fork provider', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, {
    enabled: true,
    startSources: ['startup'],
    teammates: [{ name: 'forker', description: 'x', prompt: 'x', context: 'fork' }],
  })
  await fire('agent/created', startup)
  dispose()
  assert.deepEqual(teams.spawned, ['forker'])
  assert.ok(teams.lastSpawn && teams.lastSpawn.context === 'fork' && teams.lastSpawn.provider === 'fork', 'fork context must map to the fork provider')
})

await test('blockBudgetMs 0 blocks for the full attempt', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'], blockBudgetMs: 0 })
  await fire('agent/created', startup)
  dispose()
  assert.deepEqual(teams.spawned, CREW)
})

await test('a downstream pre-execute throw fails open instead of rejecting the listener', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const decision = await fire(
    'tools/pre-execute',
    { agent: { id: 'x' }, name: 'read' },
    async () => {
      throw new Error('downstream boom')
    },
  )
  dispose()
  assert.equal(decision.kind, 'allow')
})

await test('quoted mutation verbs are demoted to weak, quoted redirects to none', async () => {
  // The classifier must not hard-refuse a read that merely mentions a verb or
  // contains a comparison inside quotes.
  const teams = makeTeams({ role: 'teammate', memberName: 'critic' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const agent = { id: 's-critic', session: makeSession([SPAWN_PROMPT, ASSIGNMENT]) }
  const quotedVerb = await fire(
    'tools/pre-execute',
    { agent, name: 'pwsh', arguments: { command: 'rg "x; rm -rf y" src' } },
    ALLOW,
  )
  const comparison = await fire(
    'tools/pre-execute',
    { agent, name: 'pwsh', arguments: { command: 'node -e "1 > 0"' } },
    ALLOW,
  )
  const realVerb = await fire(
    'tools/pre-execute',
    { agent, name: 'pwsh', arguments: { command: 'rm -rf build' } },
    ALLOW,
  )
  dispose()
  assert.equal(quotedVerb.kind, 'allow', 'a verb inside quotes is data, not a mutation')
  assert.equal(comparison.kind, 'allow', 'a comparison inside quotes is not a redirection')
  assert.equal(realVerb.kind, 'deny', 'a real verb at segment start is still refused')
})

await test('read-only roles refuse aliases, wrappers, redirections and artifact tools', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'critic' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const agent = { id: 's-critic', session: makeSession([SPAWN_PROMPT, ASSIGNMENT]) }
  const cases = [
    { name: 'pwsh', arguments: { command: 'Get-Date > out.txt' }, expect: 'deny' }, // weak redirect
    { name: 'pwsh', arguments: { command: 'ri -Recurse -Force dist' }, expect: 'deny' }, // alias
    { name: 'pwsh', arguments: { command: 'bash -c "rm -rf build"' }, expect: 'deny' }, // wrapper
    { name: 'imagegen', arguments: {}, expect: 'deny' }, // artifact writer
    { name: 'pwsh', arguments: { command: 'node test/provision.test.mjs' }, expect: 'allow' }, // read
  ]
  for (const c of cases) {
    const d = await fire('tools/pre-execute', { agent, name: c.name, arguments: c.arguments }, ALLOW)
    assert.equal(d.kind, c.expect, c.name + ' ' + JSON.stringify(c.arguments))
  }
  dispose()
})

await test('a session with durable team activity reopens the valve after a reload', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const teamEvent = { type: 'team/member', data: {} }
  const lead = { id: 's-lead', session: makeSession([teamEvent]) }
  const decision = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(decision.kind, 'allow', 'a session that already used its crew must not be re-blocked by a reload')
})

await test('lazy mode provisions nothing at session start', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'], provisionOn: 'lazy' })
  await fire('agent/created', startup)
  await fire('agent/pre-step', { agent: LEAD, turn: 1, step: 1 })
  dispose()
  assert.deepEqual(teams.spawned, [], 'a clean start spawns nothing and reads nothing')
})

await test('lazy mode provisions the crew at the first delegation attempt', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'], provisionOn: 'lazy' })
  await fire('agent/created', startup)
  const decision = await fire('tools/pre-execute', { agent: LEAD, name: 'send_message' }, ALLOW)
  dispose()
  assert.equal(decision.kind, 'allow')
  assert.deepEqual(teams.spawned, CREW, 'the crew appears just in time')
})

await test('lazy mode still refuses the first write', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, provisionOn: 'lazy' })
  const decision = await fire('tools/pre-execute', { agent: { id: 's-lead' }, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(decision.kind, 'deny', 'no crew yet, so the Lead is pushed to delegate')
})

await test('lazy mode does not spawn a crew for a workflow run', async () => {
  // workflow IS the team engine: bounded one-shot children against a goal. Pulling
  // a durable roster into existence on every workflow call was pure waste.
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'], provisionOn: 'lazy' })
  const decision = await fire('tools/pre-execute', { agent: LEAD, name: 'workflow' }, ALLOW)
  dispose()
  assert.equal(decision.kind, 'allow', 'a workflow clears the delegation policy')
  assert.deepEqual(teams.spawned, [], 'and must not create idle teammates')
})

await test('a user message without an rpcId does not open the gate', async () => {
  const teams = makeTeams({ role: 'teammate', memberName: 'scout' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const noRpc = { type: 'user/message', data: { source: { kind: 'user' } } }
  const decision = await fire(
    'tools/pre-execute',
    { agent: teammateAgent([SPAWN_PROMPT, noRpc]), name: 'read' },
    ALLOW,
  )
  dispose()
  assert.equal(decision.kind, 'deny', 'only a human-typed message counts, not any user message')
})

await test('inherited team activity does not reopen the valve', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const inheritedTeamEvent = { type: 'team/member', data: {} }
  const lead = { id: 's-lead', session: makeSession([inheritedTeamEvent], 1) }
  const decision = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(decision.kind, 'deny', 'a forked prefix is not this session\'s own delegation')
})

await test('a subagent call clears the valve without creating a crew', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, provisionOn: 'lazy' })
  const decision = await fire('tools/pre-execute', { agent: LEAD, name: 'subagent' }, ALLOW)
  dispose()
  assert.equal(decision.kind, 'allow')
  assert.deepEqual(teams.spawned, [], 'bounded children are not a durable crew')
})

await test('a team-task delegation provisions the crew just in time', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, provisionOn: 'lazy' })
  const decision = await fire('tools/pre-execute', { agent: LEAD, name: 'team_task_create' }, ALLOW)
  dispose()
  assert.equal(decision.kind, 'allow')
  assert.deepEqual(teams.spawned, CREW, 'adding work to the board needs a crew to own it')
})

await test('nudge mode lets one strong shell mutation retry through', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, delegationPolicy: 'nudge' })
  const lead = { id: 's-lead' }
  const command = { agent: lead, name: 'pwsh', arguments: { command: 'Set-Content a.txt x' } }
  const first = await fire('tools/pre-execute', command, ALLOW)
  const retry = await fire('tools/pre-execute', command, ALLOW)
  dispose()
  assert.equal(first.kind, 'deny')
  assert.equal(retry.kind, 'allow', 'nudge is one retry, and strong mutations are no exception')
})

await test('a downstream deny passes through but still counts as a delegation attempt', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const lead = { id: 's-lead' }
  const refused = await fire(
    'tools/pre-execute',
    { agent: lead, name: 'send_message' },
    async () => ({ kind: 'deny', reason: 'downstream says no' }),
  )
  const edit = await fire('tools/pre-execute', { agent: lead, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(refused.kind, 'deny', 'a downstream refusal is preserved')
  assert.equal(edit.kind, 'allow', 'the attempt cleared the valve anyway')
})

await test('the legacy requireDelegationFirst false disables the policy', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, requireDelegationFirst: false })
  const decision = await fire('tools/pre-execute', { agent: { id: 's-lead' }, name: 'edit' }, ALLOW)
  dispose()
  assert.equal(decision.kind, 'allow')
})

await test('children may only run on the flash model', async () => {
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true })
  const lead = { id: 's-lead' }
  const wrong = await fire('tools/pre-execute', { agent: lead, name: 'subagent', arguments: { model: 'gpt-5' } }, ALLOW)
  const right = await fire('tools/pre-execute', { agent: lead, name: 'subagent', arguments: { model: 'deepseek-flash' } }, ALLOW)
  const omitted = await fire('tools/pre-execute', { agent: lead, name: 'subagent', arguments: {} }, ALLOW)
  dispose()
  assert.equal(wrong.kind, 'deny', 'a child naming another model is refused')
  assert.equal(right.kind, 'allow')
  assert.equal(omitted.kind, 'allow', 'omitting the model inherits flash')
})

await test('durable policy state survives a reload and resets on a new source', async () => {
  const stateFile = tempState()
  const one = makeCtx(makeTeams())
  const disposeOne = apply(one.ctx, { enabled: true, stateFile, persistState: true, startSources: ['startup', 'clear'] })
  await one.fire('tools/pre-execute', { agent: { id: 's-lead' }, name: 'send_message' }, ALLOW)
  disposeOne()

  const two = makeCtx(makeTeams())
  const disposeTwo = apply(two.ctx, { enabled: true, stateFile, persistState: true, startSources: ['startup', 'clear'] })
  const afterReload = await two.fire('tools/pre-execute', { agent: { id: 's-lead' }, name: 'edit' }, ALLOW)
  await two.fire('agent/created', { agent: LEAD, source: 'clear' })
  const afterClear = await two.fire('tools/pre-execute', { agent: { id: 's-lead' }, name: 'edit' }, ALLOW)
  disposeTwo()
  assert.equal(afterReload.kind, 'allow', 'a reload must answer the same question the same way')
  assert.equal(afterClear.kind, 'deny', '/clear re-arms the policy, and that decision persists too')
})

await test('persistState false keeps policy state in memory only', async () => {
  const stateFile = tempState()
  const teams = makeTeams({ role: 'lead' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, persistState: false, stateFile })
  await fire('tools/pre-execute', { agent: { id: 's-lead' }, name: 'send_message' }, ALLOW)
  dispose()
  assert.equal(existsSync(stateFile), false, 'nothing is written when durability is off')
})

await test('a profile without Agent Teams names what to install and registers nothing', async () => {
  // The `naked` profile is exactly this shape: base + web app, no team service.
  let listeners = 0
  const ctx = {
    agentTeams: { tryMembership: undefined },
    on: () => {
      listeners += 1
      return () => {}
    },
  }
  const lines = []
  const original = console.warn
  console.warn = (...args) => lines.push(args.join(' '))
  let dispose
  try {
    dispose = apply(ctx, { enabled: true })
  } finally {
    console.warn = original
    if (dispose) dispose()
  }
  const line = lines.find((entry) => entry.includes('[auto-team]'))
  assert.ok(line, 'activation must say something')
  assert.match(line, /DISARMED/)
  assert.match(line, /missing=\[/, 'must name the missing surface')
  assert.match(line, /dsh-experimental-agent-team-profile/, 'must name the bundle to install')
  assert.equal(listeners, 0, 'an inert row must register no listener at all')
})

await test('exports match the Cordis Host plugin contract', async () => {
  assert.equal(name, 'auto-team')
  assert.deepEqual(inject, ['agentTeams'])
  assert.equal(typeof apply, 'function')
})

await test('concurrent agent/created events share one attempt instead of double-spawning', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await Promise.all([fire('agent/created', startup), fire('agent/created', startup)])
  dispose()
  assert.deepEqual(teams.spawned, CREW, 'no duplicate names')
})

await test('a spawn that resolves but creates nothing is caught by roster verification and repaired', async () => {
  // The provider reports success, the roster says otherwise. Only the
  // post-spawn roster read can tell the difference.
  const teams = makeTeams({ behaviour: 'silent-once' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'] })
  await fire('agent/created', startup)
  assert.deepEqual(teams.spawned, ['builder', 'critic', 'operator'], 'scout silently failed to appear')
  await fire('agent/pre-step', { agent: LEAD, turn: 1, step: 1 })
  assert.deepEqual(teams.spawned, ['builder', 'critic', 'operator'], 'scout is journaled but stuck provisioning')
  await fire('agent/pre-step', { agent: LEAD, turn: 1, step: 2 })
  assert.deepEqual(teams.spawned, ['builder', 'critic', 'operator'], 'a journaled name is never re-spawned while activating')
  dispose()
})

await test('self-heal stops at maxAttempts instead of spawning forever', async () => {
  const teams = makeTeams({ behaviour: 'silent' })
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup'], maxAttempts: 2 })
  await fire('agent/created', startup)
  await fire('agent/pre-step', { agent: LEAD, turn: 1, step: 1 })
  const settled = teams.callCount()
  await fire('agent/pre-step', { agent: LEAD, turn: 1, step: 2 })
  dispose()
  assert.equal(settled, CREW.length, 'one spawn round; journaled names are never re-spawned')
  assert.equal(teams.callCount(), settled, 'attempts exhausted, so nothing more is spawned')
})

await test('a later start source for the same session does not duplicate an intact pair', async () => {
  const teams = makeTeams()
  const { ctx, fire } = makeCtx(teams)
  const dispose = apply(ctx, { enabled: true, startSources: ['startup', 'clear'] })
  await fire('agent/created', startup)
  await fire('agent/created', { agent: LEAD, source: 'clear' })
  dispose()
  assert.deepEqual(teams.spawned, CREW, '/clear re-checked the roster, did not re-spawn')
})

console.log(results.join('\n'))
console.log(`\n${results.length - failures}/${results.length} passed`)
process.exit(failures === 0 ? 0 : 1)
