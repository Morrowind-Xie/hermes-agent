/**
 * Admission policy for one local profile-backend spawn.
 *
 * A lease is held for the WHOLE lifetime of a local backend (starting or
 * running), so `maxBackends` is a cap on running children, not on concurrent
 * spawns. That is correct as a process-wave brake, but it left the opposite
 * case with no policy at all: when the surfaces a user keeps mounted (bot
 * panes, restored session tiles, the profile pinned as primary) demand MORE
 * backends than the cap, the excess tickets queue behind leases that can never
 * be released — LRU eviction spares every keepalive-fresh entry, and a mounted
 * pane pings its backend every 60s. The queue therefore cannot drain, cannot
 * converge, and fails only after the full slot wait, while the renderer's
 * transport backoff re-arms the identical doomed request every few seconds.
 * Observed in the field: three profiles queued at `3/3 busy` for over three
 * hours, thousands of retries, no message anywhere the user could read.
 *
 * `saturated` is the answer to that state: nothing is freeing and nothing is
 * reclaimable, so waiting is provably futile and the spawn must fail with a
 * reason instead of burning the wait. Anything still able to yield a slot
 * (an in-flight stop, or a running backend eviction may reclaim) keeps the
 * normal queue path, because there the wait is productive.
 *
 * Pure over counts so the contract is asserted directly rather than through a
 * booted Electron or main.ts source text.
 */
export type LocalBackendAdmission = 'acquire' | 'saturated' | 'wait'

export interface LocalBackendAdmissionState {
  /** `poolLimits.maxBackends` currently in force. */
  limit: number
  /** Leases held by local backends that are starting or running. */
  activeCount: number
  /** Backends already stopping: each releases its lease when the child exits. */
  stoppingCount: number
  /** Running backends LRU eviction may reclaim (not keepalive-fresh). */
  reclaimableCount: number
}

export function decideLocalBackendAdmission(state: LocalBackendAdmissionState): LocalBackendAdmission {
  if (state.activeCount < state.limit) {
    return 'acquire'
  }

  if (state.stoppingCount + state.reclaimableCount > 0) {
    return 'wait'
  }

  return 'saturated'
}

/**
 * Stable substring carried in the rejection text. Classification must survive
 * the IPC boundary, and Electron serializes a handler error down to its
 * message, so a marker in the sentence is the only thing the renderer can key
 * on. Built and parsed in this one module so the two can never drift.
 */
export const LOCAL_BACKEND_POOL_SATURATED_SENTINEL = 'local backend slots are busy'

export function localBackendPoolSaturatedMessage(limit: number): string {
  return (
    `All ${limit} local backend slots are busy, and none can be reclaimed ` +
    `(every profile backend is held open by a pane that is still in view). ` +
    `Close another bot pane, or raise the local agent limit under Settings -> Advanced, ` +
    `then open this bot again.`
  )
}

export function isLocalBackendPoolSaturatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  return message.includes(LOCAL_BACKEND_POOL_SATURATED_SENTINEL)
}

export type ReleaseLocalBackendSlot = () => void

export type LocalBackendSpawnRequest = {
  acquired: Promise<ReleaseLocalBackendSlot>
  cancel: () => boolean
}

type Waiter = {
  key: string
  resolve: (release: ReleaseLocalBackendSlot) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export async function releaseLocalBackendSlotAfterExit(
  release: ReleaseLocalBackendSlot,
  waitForExit: () => Promise<void>
): Promise<void> {
  await waitForExit()
  release()
}

/**
 * Bounds the number of local profile backends that are starting or running.
 *
 * A lease is acquired immediately before local start work and is held until
 * the child exits or the start fails. Remote descriptors never call request().
 */
export class LocalBackendSpawnCoordinator {
  #limit: number
  #active = 0
  #queue: Waiter[] = []

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('Local backend spawn limit must be a positive integer.')
    }

    this.#limit = limit
  }

  get activeCount(): number {
    return this.#active
  }

  get limit(): number {
    return this.#limit
  }

  /**
   * Adopt a new cap at runtime (the pool size is a live device preference).
   * Raising it drains waiters into the newly freed slots immediately; lowering
   * it never revokes a granted slot — the running backends simply stay over
   * the cap until they exit, and LRU eviction (main.ts) converges the pool.
   */
  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('Local backend spawn limit must be a positive integer.')
    }

    this.#limit = limit
    this.#drain()
  }

  get queuedCount(): number {
    return this.#queue.length
  }

  request(key: string, options: { timeoutMs?: number } = {}): LocalBackendSpawnRequest {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1)) {
      throw new RangeError('Local backend spawn timeout must be a positive number.')
    }

    if (this.#active < this.#limit) {
      return {
        acquired: Promise.resolve(this.#grant()),
        cancel: () => false
      }
    }

    let waiter!: Waiter

    const acquired = new Promise<ReleaseLocalBackendSlot>((resolve, reject) => {
      waiter = { key, resolve, reject, timer: null }
      this.#queue.push(waiter)

      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.#rejectWaiter(
            waiter,
            new Error(`Local backend start for "${key}" timed out while waiting for a free slot.`)
          )
        }, options.timeoutMs)
        waiter.timer.unref?.()
      }
    })

    return {
      acquired,
      cancel: () =>
        this.#rejectWaiter(waiter, new Error(`Local backend start for "${key}" was cancelled while queued.`))
    }
  }

  acquire(key: string): Promise<ReleaseLocalBackendSlot> {
    return this.request(key).acquired
  }

  #rejectWaiter(waiter: Waiter, error: Error): boolean {
    const index = this.#queue.indexOf(waiter)

    if (index === -1) {
      return false
    }

    this.#queue.splice(index, 1)
    this.#clearTimer(waiter)
    waiter.reject(error)

    return true
  }

  #clearTimer(waiter: Waiter): void {
    if (waiter.timer) {
      clearTimeout(waiter.timer)
      waiter.timer = null
    }
  }

  #grant(): ReleaseLocalBackendSlot {
    this.#active += 1
    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      this.#active -= 1
      this.#drain()
    }
  }

  /** Hand free slots to queued waiters while under the (possibly lowered) cap. */
  #drain(): void {
    while (this.#active < this.#limit && this.#queue.length > 0) {
      const next = this.#queue.shift()!
      this.#clearTimer(next)
      next.resolve(this.#grant())
    }
  }
}
