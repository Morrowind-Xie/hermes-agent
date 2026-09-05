import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createPoolStopper, type PoolStopEntry } from './pool-stop'

// Pins the orphaned-backend class from #62721: fire-and-forget pool stops
// (SIGTERM + immediate entry delete) dropped the process handle before the
// child exited, so a slow/stuck backend survived detached under PID 1.

interface Child {
  exited: boolean
  killed: boolean
}

function harness() {
  const pool = new Map<string, PoolStopEntry>()
  const events: string[] = []
  const exitResolvers = new Map<Child, () => void>()

  const stopper = createPoolStopper({
    pool,
    stopChild: child => {
      ;(child as Child).killed = true
      events.push('stop')
    },
    waitForExit: child =>
      new Promise<void>(resolve => {
        exitResolvers.set(child as Child, () => {
          ;(child as Child).exited = true
          events.push('exit')
          resolve()
        })
      })
  })

  function addChild(key: string): Child {
    const child: Child = { exited: false, killed: false }

    pool.set(key, { process: child })

    return child
  }

  return { addChild, events, exitResolvers, pool, stopper }
}

test('evicts the entry immediately but retains the handle until bounded exit', async () => {
  const { addChild, exitResolvers, pool, stopper } = harness()
  const child = addChild('selena')

  const stop = stopper.stop('selena')

  // No router may hand out the dying backend...
  assert.equal(pool.has('selena'), false)
  // ...but the stop is not done and the in-flight handle is discoverable.
  assert.equal(child.killed, true)
  assert.equal(stopper.inFlight('selena'), stop)

  exitResolvers.get(child)?.()
  await stop

  assert.equal(child.exited, true)
  assert.equal(stopper.inFlight('selena'), undefined)
})

test('concurrent stop requests share one in-flight teardown', async () => {
  const { addChild, events, exitResolvers, stopper } = harness()
  const child = addChild('selena')

  const first = stopper.stop('selena')
  const second = stopper.stop('selena')

  assert.equal(first, second)

  exitResolvers.get(child)?.()
  await first

  // One SIGTERM, one exit — not one per caller.
  assert.deepEqual(events, ['stop', 'exit'])
})

test('stop of an unknown key resolves without signalling anything', async () => {
  const { events, stopper } = harness()

  await stopper.stop('ghost')

  assert.deepEqual(events, [])
  assert.equal(stopper.inFlight('ghost'), undefined)
})

test('stopAll stops every pooled backend and resolves after all exits', async () => {
  const { addChild, exitResolvers, pool, stopper } = harness()
  const a = addChild('a')
  const b = addChild('b')

  let settled = false

  const all = stopper.stopAll().then(() => {
    settled = true
  })

  assert.equal(pool.size, 0)
  assert.equal(a.killed, true)
  assert.equal(b.killed, true)

  exitResolvers.get(a)?.()
  await Promise.resolve()
  assert.equal(settled, false, 'must wait for EVERY child, not the first')

  exitResolvers.get(b)?.()
  await all
  assert.equal(settled, true)
})

test('a respawn can await the in-flight stop before reusing the key', async () => {
  const { addChild, exitResolvers, stopper } = harness()
  const child = addChild('selena')
  const order: string[] = []

  void stopper.stop('selena')

  const respawn = (async () => {
    const dying = stopper.inFlight('selena')

    if (dying) {
      await dying
    }

    order.push('spawn')
  })()

  order.push('exit-signal')
  exitResolvers.get(child)?.()
  await respawn

  assert.deepEqual(order, ['exit-signal', 'spawn'])
})

test('stoppingCount reports the leases about to free, and only those', async () => {
  // Spawn admission asks this question to decide whether a full pool can still
  // drain. A wrong answer either wedges a productive wait behind a false
  // "saturated", or refuses a spawn whose slot was milliseconds from release.
  const { addChild, exitResolvers, stopper } = harness()
  const a = addChild('a')
  const b = addChild('b')

  assert.equal(stopper.stoppingCount(), 0, 'an idle pool has nothing releasing')

  const stopA = stopper.stop('a')
  assert.equal(stopper.stoppingCount(), 1)

  // A second caller shares the same teardown and must not be counted twice, or
  // admission would see two leases about to free.
  assert.equal(stopper.stop('a'), stopA)
  assert.equal(stopper.stoppingCount(), 1)

  const stopB = stopper.stop('b')
  assert.equal(stopper.stoppingCount(), 2)

  exitResolvers.get(a)?.()
  await stopA
  assert.equal(stopper.stoppingCount(), 1, 'a completed teardown stops counting')

  // A key already gone from the pool never started a teardown, so it is not an
  // in-flight one.
  await stopper.stop('gone')
  assert.equal(stopper.stoppingCount(), 1)

  exitResolvers.get(b)?.()
  await stopB
  assert.equal(stopper.stoppingCount(), 0)
})

