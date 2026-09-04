import { MessageRepository } from '@assistant-ui/core/internal'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import { syncRepositoryIncrementally } from '@/lib/incremental-external-store-runtime'

import { useRuntimeMessageRepository } from './runtime-repository'

const text = (id: string, role: ChatMessage['role'], body: string): ChatMessage => ({
  id,
  role,
  parts: [{ type: 'text', text: body }]
})

/** The repository the runtime drives — it throws on a duplicate link. */
const feedToRepository = (repository: ExportedRepository) => {
  const runtime = { repository: new MessageRepository() } as unknown as Parameters<
    typeof syncRepositoryIncrementally
  >[0]

  return syncRepositoryIncrementally(runtime, repository)
}

type ExportedRepository = ReturnType<typeof useRuntimeMessageRepository>

describe('useRuntimeMessageRepository', () => {
  it('emits each id once when the transcript repeats one', () => {
    const { result } = renderHook(() =>
      useRuntimeMessageRepository([
        text('user-1', 'user', 'hi'),
        text('assistant-1', 'assistant', 'hello'),
        text('user-1', 'user', 'hi')
      ])
    )

    const ids = result.current.messages.map(item => item.message.id)

    expect(ids).toEqual(['user-1', 'assistant-1'])
  })

  it('builds a repository the runtime can link without throwing', () => {
    const { result } = renderHook(() =>
      useRuntimeMessageRepository([
        text('user-1', 'user', 'hi'),
        text('assistant-stream-1', 'assistant', 'partial'),
        text('assistant-stream-1', 'assistant', 'partial'),
        text('user-2', 'user', 'more')
      ])
    )

    expect(feedToRepository(result.current).map(item => item.id)).toEqual(['user-1', 'assistant-stream-1', 'user-2'])
  })

  it('anchors a branch group to its fork point, and a windowed cut keeps it', () => {
    // Branch groups record their fork parent the first time they are seen. A
    // window that started mid-group would anchor the survivors to whatever
    // preceded them instead — selectTranscriptWindow aligns the cut so the
    // whole group arrives together (#55191).
    const branch = (id: string): ChatMessage => ({
      ...text(id, 'assistant', 'branch'),
      branchGroupId: 'group-1'
    })

    const messages = [text('user-1', 'user', 'hi'), branch('a-1'), branch('a-2'), text('user-2', 'user', 'more')]

    const { result } = renderHook(() => useRuntimeMessageRepository(messages))

    const parents = new Map(result.current.messages.map(item => [item.message.id, item.parentId]))

    expect(parents.get('a-1')).toBe('user-1')
    expect(parents.get('a-2')).toBe('user-1')

    // The same group fed as a window that begins AT the group start keeps the
    // fork intact (parent becomes null: the group is now the transcript root).
    const { result: windowed } = renderHook(() => useRuntimeMessageRepository(messages.slice(1)))

    const windowedParents = new Map(windowed.current.messages.map(item => [item.message.id, item.parentId]))

    expect(windowedParents.get('a-1')).toBe(windowedParents.get('a-2'))
  })

  it('renames a duplicated toolCallId within one message instead of crashing useResources (#87857)', () => {
    // The streaming path can append the same tool call twice inside ONE message
    // (optimistic write racing the authoritative event). @assistant-ui/tap's
    // useResources throws on duplicate resource keys, so the repository must
    // never emit two parts of one message keyed by the same `toolCallId-<id>`.
    const duplicated: ChatMessage = {
      id: 'assistant-dup',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'running…' },
        { type: 'tool-call', toolCallId: 'call_00_DUP', toolName: 'terminal', args: {}, argsText: '' },
        {
          type: 'tool-call',
          toolCallId: 'call_00_DUP',
          toolName: 'terminal',
          args: { done: true },
          argsText: '{"done":true}'
        }
      ] as ChatMessage['parts']
    }

    const { result } = renderHook(() => useRuntimeMessageRepository([text('user-1', 'user', 'go'), duplicated]))

    const assistant = result.current.messages.find(item => item.message.id === 'assistant-dup')
    expect(assistant).toBeDefined()

    const toolParts = (assistant!.message.content as readonly { type: string; toolCallId?: string }[]).filter(
      part => part.type === 'tool-call'
    )

    expect(toolParts).toHaveLength(2)
    expect(new Set(toolParts.map(part => part.toolCallId)).size).toBe(2)

    // And the runtime can link it end to end without throwing.
    expect(feedToRepository(result.current).map(item => item.id)).toEqual(['user-1', 'assistant-dup'])
  })

  it('drops the carried-over copy when coalescing folds a repeated toolCallId into one message (#87857)', () => {
    // Two individually-clean rows can share a toolCallId (structural carry-over
    // re-attaching a cached row's calls while the same turn also exists as a
    // committed row). Per-row that is harmless — assistant-ui's key space is
    // per-message — but coalesceToolOnlyAssistants folds the tool-only
    // follow-up into its predecessor, which used to manufacture the duplicate
    // key. The fold must drop the copy the predecessor already carries while
    // keeping the genuinely-new call.
    const tool = (toolCallId: string): ChatMessage['parts'][number] =>
      ({ type: 'tool-call', toolCallId, toolName: 'terminal', args: {}, argsText: '' }) as ChatMessage['parts'][number]

    const committed: ChatMessage = {
      id: 'committed-49-assistant',
      role: 'assistant',
      parts: [{ type: 'text', text: 'working' }, tool('call-a'), tool('call-b')] as ChatMessage['parts']
    }

    const streamed: ChatMessage = {
      id: 'assistant-stream-49',
      role: 'assistant',
      parts: [tool('call-b'), tool('call-c')] as ChatMessage['parts']
    }

    const { result } = renderHook(() =>
      useRuntimeMessageRepository([text('user-1', 'user', 'go'), committed, streamed])
    )

    const assistant = result.current.messages.find(item => item.message.id === 'committed-49-assistant')
    expect(assistant).toBeDefined()

    const ids = (assistant!.message.content as readonly { type: string; toolCallId?: string }[])
      .filter(part => part.type === 'tool-call')
      .map(part => part.toolCallId)

    // call-b appears once, call-c (genuinely new) survives the fold.
    expect(ids).toEqual(['call-a', 'call-b', 'call-c'])

    expect(feedToRepository(result.current).map(item => item.id)).toEqual(['user-1', 'committed-49-assistant'])
  })

  it('leaves a toolCallId repeated across DIFFERENT non-folded messages untouched', () => {
    // anthropic_messages-mode providers (e.g. Kimi) number tool_use blocks per
    // API response — `terminal_0` legitimately recurs on every turn. The key
    // space is per-message, so cross-message repeats are NOT collisions and
    // must never be renamed (renaming would defeat the identity cache and
    // churn re-renders on every stream delta).
    const turn = (n: number): ChatMessage[] => [
      text(`user-${n}`, 'user', 'go'),
      {
        id: `assistant-${n}`,
        role: 'assistant',
        parts: [
          { type: 'text', text: 'ok' },
          { type: 'tool-call', toolCallId: 'terminal_0', toolName: 'terminal', args: {}, argsText: '' }
        ] as ChatMessage['parts']
      }
    ]

    const { result } = renderHook(() => useRuntimeMessageRepository([...turn(1), ...turn(2)]))

    for (const id of ['assistant-1', 'assistant-2']) {
      const item = result.current.messages.find(entry => entry.message.id === id)

      const ids = (item!.message.content as readonly { type: string; toolCallId?: string }[])
        .filter(part => part.type === 'tool-call')
        .map(part => part.toolCallId)

      expect(ids).toEqual(['terminal_0'])
    }

    expect(feedToRepository(result.current).map(item => item.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2'
    ])
  })
})

/**
 * Identity contract — the load-bearing property the render-loop guard depends on.
 *
 * ChatRuntimeBoundary passes a fresh adapter literal on every render, and
 * `IncrementalExternalStoreThreadRuntimeCore.__internal_setAdapter` decides
 * "nothing observable changed" by comparing `messageRepository` BY REFERENCE
 * (see src/lib/incremental-external-store-runtime.ts). A repository that is
 * content-identical but a new object therefore fails that gate, falls through
 * to the full sync path, and notifies UNCONDITIONALLY — which is the
 * "Maximum update depth exceeded. The result of getSnapshot should be cached"
 * crash that takes the whole workspace pane down behind its error boundary.
 *
 * So this hook must preserve reference identity on no-op re-runs, exactly like
 * `stabilizeItems` does for $statusItemsBySession.
 */
describe('useRuntimeMessageRepository reference identity', () => {
  const branch = (id: string): ChatMessage => ({
    ...text(id, 'assistant', 'branch'),
    branchGroupId: 'group-1'
  })

  function renderWith(messages: ChatMessage[]) {
    return renderHook(({ input }: { input: ChatMessage[] }) => useRuntimeMessageRepository(input), {
      initialProps: { input: messages }
    })
  }

  it('keeps the repository reference when the array is rebuilt with the same messages', () => {
    const messages = [text('user-1', 'user', 'hi'), text('assistant-1', 'assistant', 'hello')]
    const { result, rerender } = renderWith(messages)
    const first = result.current

    // A new array identity with identical elements: the memo re-runs, but the
    // derived repository is unchanged, so it must come back as the SAME object.
    rerender({ input: [...messages] })

    expect(result.current).toBe(first)
  })

  it('keeps the reference across repeated no-op re-renders (the loop shape)', () => {
    const messages = [text('user-1', 'user', 'hi'), branch('a-1'), branch('a-2')]
    const { result, rerender } = renderWith(messages)
    const first = result.current

    // Five boundary re-renders — the shape the guard test in
    // incremental-runtime-adapter-notify.test.ts feeds the adapter gate.
    for (let render = 0; render < 5; render += 1) {
      rerender({ input: [...messages] })

      expect(result.current).toBe(first)
    }
  })

  it('returns a fresh repository when the transcript actually grows', () => {
    const messages = [text('user-1', 'user', 'hi')]
    const { result, rerender } = renderWith(messages)
    const first = result.current

    rerender({ input: [...messages, text('assistant-1', 'assistant', 'hello')] })

    expect(result.current).not.toBe(first)
    expect(result.current.messages.map(item => item.message.id)).toEqual(['user-1', 'assistant-1'])
  })

  it('returns a fresh repository when a message is edited in place', () => {
    const firstTurn = text('assistant-1', 'assistant', 'hello')
    const messages = [text('user-1', 'user', 'hi'), firstTurn]
    const { result, rerender } = renderWith(messages)
    const first = result.current

    // Streaming: the same id arrives as a NEW object with new content, so the
    // converted ThreadMessage differs and the repository must be rebuilt.
    rerender({ input: [messages[0], text('assistant-1', 'assistant', 'hello there')] })

    expect(result.current).not.toBe(first)
  })

  it('returns a fresh repository when the head moves', () => {
    const messages = [text('user-1', 'user', 'hi'), text('assistant-1', 'assistant', 'a'), text('assistant-2', 'assistant', 'b')]
    const { result, rerender } = renderWith(messages)
    const first = result.current

    // Same message set, different head: branch switching must still notify.
    rerender({ input: [messages[0], messages[2], messages[1]] })

    expect(result.current).not.toBe(first)
    expect(result.current.headId).not.toBe(first.headId)
  })
})
