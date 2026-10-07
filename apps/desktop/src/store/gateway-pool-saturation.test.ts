import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression for the local-backend retry storm. When the pool cap sits below the
// number of mounted panes, every over-cap profile used to re-dial on the 15s
// transport backoff forever: each attempt paid main's full slot wait, failed
// with a reason the user never saw, and re-armed itself (observed: three
// profiles stuck at `3/3 busy` for 3.5 hours). Saturation is now its own class —
// a slow clock, one explanation, and the fast clock again once the dial gets
// through. Driven through the real store with the real main-side message, not by
// reading source text.
import { localBackendPoolSaturatedMessage } from '../../electron/pool-spawn-coordinator'

const notifyMocks = vi.hoisted(() => ({ notify: vi.fn() }))

const gatewayMocks = vi.hoisted(() => ({
  connect: vi.fn(async (_wsUrl: string): Promise<void> => undefined)
}))

vi.mock('@/hermes', () => ({
  setApiRequestConnection: vi.fn(),
  HermesGateway: class {
    connectionState = 'closed'
    connect = async (wsUrl: string): Promise<void> => {
      await gatewayMocks.connect(wsUrl)
      this.connectionState = 'open'
    }
    close = (): void => {
      this.connectionState = 'closed'
    }
    onEvent = vi.fn(() => () => {})
    onState = vi.fn(() => () => {})
  }
}))
vi.mock('@/store/session', () => ({ setConnection: vi.fn(), setGatewayState: vi.fn() }))
vi.mock('@/store/notify-baseline', () => ({ markNativeNotifyBaseline: vi.fn() }))
vi.mock('@/store/notifications', () => ({ notify: notifyMocks.notify }))

const { closeSecondaryGateways, configureGatewayRegistry, ensureGatewayForProfile, setPrimaryGateway } =
  await import('./gateway')

const localConn = {
  authMode: 'token',
  baseUrl: 'http://127.0.0.1:42075',
  mode: 'local',
  profile: 'music',
  token: 'fake-test-token',
  wsUrl: 'ws://127.0.0.1:42075/api/ws'
}

function installDesktop(getConnection: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    getConnection,
    touchBackend: vi.fn(async () => undefined)
  }
}

function saturatedDial(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    throw new Error(localBackendPoolSaturatedMessage(3))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  // Full jitter would make the retry clock a random variable; pin it to the
  // bottom of its range so the slow interval is asserted exactly.
  vi.spyOn(Math, 'random').mockReturnValue(0)
  configureGatewayRegistry({ onEvent: vi.fn() })
  setPrimaryGateway({ connectionState: 'open' } as never, 'default')
  notifyMocks.notify.mockClear()
  gatewayMocks.connect.mockClear()
})

afterEach(() => {
  closeSecondaryGateways()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})
describe('local backend pool saturation', () => {
  it('re-asks on the slow pool clock instead of hammering the transport clock', async () => {
    const getConnection = saturatedDial()
    installDesktop(getConnection)

    await expect(ensureGatewayForProfile('music')).rejects.toThrow(/local backend slots are busy/)
    // Two dials per user-initiated attempt: ensureGatewayForProfile first asks
    // main for the route (sharedPrimaryRoute probes getConnection), then
    // openSecondary dials it. Background retries only dial, hence +1 each.
    expect(getConnection).toHaveBeenCalledTimes(2)

    // The old loop was back inside the 15s transport ceiling long before here.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(getConnection).toHaveBeenCalledTimes(2)

    // Still self-healing: the entry stays wanted, so the next slot a pane frees
    // is picked up without the user clicking anything.
    await vi.advanceTimersByTimeAsync(45_000)
    expect(getConnection).toHaveBeenCalledTimes(3)
  })

  it('explains itself once, and only from the background retry', async () => {
    const getConnection = saturatedDial()
    installDesktop(getConnection)

    // A user-initiated switch surfaces the failure through its own caller, so
    // the store must not stack a second toast on it.
    await expect(ensureGatewayForProfile('music')).rejects.toThrow(/local backend slots are busy/)
    expect(notifyMocks.notify).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(notifyMocks.notify).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(180_000)
    expect(getConnection.mock.calls.length).toBeGreaterThan(2)
    expect(notifyMocks.notify).toHaveBeenCalledTimes(1)

    // Resolved through the real catalog — a key missing from en.ts would come
    // back as the dotted path instead of prose.
    expect(notifyMocks.notify.mock.calls[0][0]).toMatchObject({
      kind: 'error',
      title: 'Local agent limit reached'
    })
  })

  it('leaves an ordinary transport failure on the fast clock', async () => {
    // A dropped socket really can recover on its own; slowing it would make a
    // gateway restart feel like a hang.
    vi.spyOn(Math, 'random').mockReturnValue(0.99)

    const getConnection = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })

    installDesktop(getConnection)

    await expect(ensureGatewayForProfile('music')).rejects.toThrow('ECONNRESET')

    await vi.advanceTimersByTimeAsync(2_000)
    expect(getConnection.mock.calls.length).toBeGreaterThan(1)
    expect(notifyMocks.notify).not.toHaveBeenCalled()
  })

  it('goes back to the fast clock once a slot frees', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)

    let slotFreed = false

    const getConnection = vi.fn(async () => {
      if (!slotFreed) {
        throw new Error(localBackendPoolSaturatedMessage(3))
      }

      return localConn
    })

    installDesktop(getConnection)

    await expect(ensureGatewayForProfile('music')).rejects.toThrow(/local backend slots are busy/)

    // The user closes a pane, the pool gets a slot, and the next background
    // attempt gets through.
    await vi.advanceTimersByTimeAsync(60_000)
    slotFreed = true
    await vi.advanceTimersByTimeAsync(61_000)

    const dialCount = getConnection.mock.calls.length
    expect(dialCount).toBeGreaterThan(1)
    expect(gatewayMocks.connect).toHaveBeenCalled()

    // An open socket parks the retry clock: no slow saturation timer left behind
    // redialing a healthy route.
    await vi.advanceTimersByTimeAsync(180_000)
    expect(getConnection.mock.calls.length).toBe(dialCount)
  })
})
