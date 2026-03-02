/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  eventsToCompactForTokenThreshold,
  hasSlidingWindowConfig,
  hasTokenThresholdConfig,
  latestPromptTokenCount,
  processCompactionEvents,
  runCompactionForTokenThreshold,
  safeTokenCompactionSplitIndex,
} from '../../src/agents/compaction.js';
import {EventsCompactionConfig} from '../../src/agents/events_compaction_config.js';
import {createEvent, Event} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';
import {BaseSessionService} from '../../src/sessions/base_session_service.js';

import {
  compactionEvent,
  fakeSession,
  fakeSessionService,
  FakeSummarizer,
  functionCallEvent,
  functionResponseEvent,
  textEvent,
} from './compaction_test_helpers.js';

// ---------------------------------------------------------------------------
// hasTokenThresholdConfig
// ---------------------------------------------------------------------------

describe('hasTokenThresholdConfig', () => {
  it('returns false for undefined', () => {
    expect(hasTokenThresholdConfig(undefined)).toBe(false);
  });

  it('returns false when only tokenThreshold set', () => {
    expect(hasTokenThresholdConfig({tokenThreshold: 1000})).toBe(false);
  });

  it('returns false when only eventRetentionSize set', () => {
    expect(hasTokenThresholdConfig({eventRetentionSize: 5})).toBe(false);
  });

  it('returns true when both set', () => {
    expect(
      hasTokenThresholdConfig({tokenThreshold: 1000, eventRetentionSize: 5}),
    ).toBe(true);
  });

  it('returns true when eventRetentionSize is 0', () => {
    expect(
      hasTokenThresholdConfig({tokenThreshold: 1000, eventRetentionSize: 0}),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasSlidingWindowConfig
// ---------------------------------------------------------------------------

describe('hasSlidingWindowConfig', () => {
  it('returns false for undefined', () => {
    expect(hasSlidingWindowConfig(undefined)).toBe(false);
  });

  it('returns false when only compactionInterval set', () => {
    expect(hasSlidingWindowConfig({compactionInterval: 10})).toBe(false);
  });

  it('returns true when both set', () => {
    expect(
      hasSlidingWindowConfig({compactionInterval: 10, overlapSize: 2}),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// latestPromptTokenCount
// ---------------------------------------------------------------------------

describe('latestPromptTokenCount', () => {
  it('returns usageMetadata.promptTokenCount from last event with it', () => {
    const events = [
      textEvent('user', 'hello', 100),
      textEvent('model', 'hi', 200, {
        usageMetadata: {promptTokenCount: 42, totalTokenCount: 60},
      }),
      textEvent('user', 'bye', 300),
    ];
    expect(latestPromptTokenCount(events, 'agent')).toBe(42);
  });

  it('falls back to char/4 estimate when no usageMetadata', () => {
    const events = [textEvent('user', 'a'.repeat(400), 100)];
    expect(latestPromptTokenCount(events, 'agent')).toBe(100);
  });

  it('returns undefined for empty events', () => {
    expect(latestPromptTokenCount([], 'agent')).toBeUndefined();
  });

  it('returns undefined for events with no text content', () => {
    const events = [createEvent({author: 'user', timestamp: 100})];
    expect(latestPromptTokenCount(events, 'agent')).toBeUndefined();
  });

  it('skips events from other branches in estimation', () => {
    const events = [
      textEvent('user', 'a'.repeat(400), 100, {branch: 'main.sub'}),
      textEvent('model', 'b'.repeat(400), 200, {branch: 'other'}),
    ];
    const result = latestPromptTokenCount(events, 'agent', 'main.sub');
    expect(result).toBe(100);
  });

  it('accounts for compacted content in estimation', () => {
    const events = [compactionEvent(100, 200, 'x'.repeat(400), 300)];
    const result = latestPromptTokenCount(events, 'agent');
    expect(result).toBe(100);
  });

  it('includes function call/response content in char-based estimation', () => {
    const events = [
      textEvent('user', 'hi', 100, {invocationId: 'inv1'}),
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc1',
                name: 'myTool',
                args: {data: 'y'.repeat(400)},
              },
            },
          ],
        },
        timestamp: 200,
        invocationId: 'inv1',
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'fc1',
                name: 'myTool',
                response: {result: 'z'.repeat(400)},
              },
            },
          ],
        },
        timestamp: 300,
        invocationId: 'inv1',
      }),
      textEvent('model', 'done', 400, {invocationId: 'inv1'}),
    ];
    const result = latestPromptTokenCount(events, 'agent');
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(10);
  });

  it('includes executableCode parts in char-based estimation', () => {
    const events = [
      textEvent('user', 'run code', 100, {invocationId: 'inv1'}),
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{executableCode: {code: 'x'.repeat(400)}}],
        },
        timestamp: 200,
        invocationId: 'inv1',
      }),
    ];
    const result = latestPromptTokenCount(events, 'agent');
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// safeTokenCompactionSplitIndex
// ---------------------------------------------------------------------------

describe('safeTokenCompactionSplitIndex', () => {
  it('returns 0 when retention size >= events length', () => {
    const events = [textEvent('user', 'a', 100), textEvent('model', 'b', 200)];
    expect(safeTokenCompactionSplitIndex(events, 5)).toBe(0);
  });

  it('returns 0 when retention size equals events length', () => {
    const events = [textEvent('user', 'a', 100), textEvent('model', 'b', 200)];
    expect(safeTokenCompactionSplitIndex(events, 2)).toBe(0);
  });

  it('splits at boundary when no function calls involved', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      textEvent('user', 'c', 300),
      textEvent('model', 'd', 400),
    ];
    const split = safeTokenCompactionSplitIndex(events, 2);
    expect(split).toBe(2);
  });

  it('avoids orphaning function response from its call', () => {
    const events = [
      textEvent('user', 'a', 100),
      functionCallEvent('fc-1', 'tool_a', 200),
      functionResponseEvent('fc-1', 'tool_a', 300),
      textEvent('model', 'result', 400),
    ];
    const split = safeTokenCompactionSplitIndex(events, 1);
    expect(split).toBeLessThanOrEqual(3);
    const retained = events.slice(split);
    const retainedResponseIds = new Set<string>();
    const retainedCallIds = new Set<string>();
    for (const e of retained) {
      for (const part of e.content?.parts ?? []) {
        if (part.functionResponse?.id)
          retainedResponseIds.add(part.functionResponse.id);
        if (part.functionCall?.id) retainedCallIds.add(part.functionCall.id);
      }
    }
    for (const id of retainedResponseIds) {
      expect(retainedCallIds.has(id)).toBe(true);
    }
  });

  it('handles function call at boundary: keeps pair together', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      functionCallEvent('fc-1', 'tool', 300),
      functionResponseEvent('fc-1', 'tool', 400),
      textEvent('model', 'done', 500),
    ];
    const split = safeTokenCompactionSplitIndex(events, 2);
    expect(split).toBeLessThanOrEqual(3);
  });

  it('handles multiple parallel function calls', () => {
    const events = [
      textEvent('user', 'start', 100),
      functionCallEvent('fc-1', 'tool_a', 200),
      functionCallEvent('fc-2', 'tool_b', 201),
      functionResponseEvent('fc-1', 'tool_a', 300),
      functionResponseEvent('fc-2', 'tool_b', 301),
      textEvent('model', 'done', 400),
    ];
    const split = safeTokenCompactionSplitIndex(events, 1);
    const retained = events.slice(split);
    const retainedResponseIds = new Set<string>();
    const retainedCallIds = new Set<string>();
    for (const e of retained) {
      for (const part of e.content?.parts ?? []) {
        if (part.functionResponse?.id)
          retainedResponseIds.add(part.functionResponse.id);
        if (part.functionCall?.id) retainedCallIds.add(part.functionCall.id);
      }
    }
    for (const id of retainedResponseIds) {
      expect(retainedCallIds.has(id)).toBe(true);
    }
  });

  it('compacts orphaned response into summarized portion', () => {
    const events = [
      functionResponseEvent('fc-orphan', 'orphaned_tool', 100),
      textEvent('user', 'a', 200),
      textEvent('model', 'b', 300),
    ];
    const split = safeTokenCompactionSplitIndex(events, 1);
    expect(split).toBe(2);
    const retained = events.slice(split);
    const retainedResponseIds = new Set<string>();
    for (const e of retained) {
      for (const part of e.content?.parts ?? []) {
        if (part.functionResponse?.id)
          retainedResponseIds.add(part.functionResponse.id);
      }
    }
    expect(retainedResponseIds.size).toBe(0);
  });

  it('returns 0 when orphaned responses span into the retained portion', () => {
    const events = [
      functionResponseEvent('fc-orphan', 'orphaned_tool', 100),
      functionResponseEvent('fc-orphan2', 'orphaned_tool2', 200),
      textEvent('model', 'b', 300),
    ];
    const split = safeTokenCompactionSplitIndex(events, 2);
    expect(split).toBe(0);
  });

  it('returns 0 when retention size exceeds the event count', () => {
    const events = [textEvent('user', 'a', 100)];
    expect(safeTokenCompactionSplitIndex(events, 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// eventsToCompactForTokenThreshold
// ---------------------------------------------------------------------------

describe('eventsToCompactForTokenThreshold', () => {
  it('returns empty when fewer events than retention size', () => {
    const events = [textEvent('user', 'a', 100), textEvent('model', 'b', 200)];
    expect(eventsToCompactForTokenThreshold(events, 5)).toEqual([]);
  });

  it('returns empty when events equal retention size', () => {
    const events = [textEvent('user', 'a', 100), textEvent('model', 'b', 200)];
    expect(eventsToCompactForTokenThreshold(events, 2)).toEqual([]);
  });

  it('returns events to compact, keeping retention events', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      textEvent('user', 'c', 300),
      textEvent('model', 'd', 400),
      textEvent('user', 'e', 500),
      textEvent('model', 'f', 600),
    ];
    const result = eventsToCompactForTokenThreshold(events, 2);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(events.length);
  });

  it('compacts all events when retention is 0', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      textEvent('user', 'c', 300),
    ];
    const result = eventsToCompactForTokenThreshold(events, 0);
    expect(result).toHaveLength(3);
  });

  it('skips events already covered by existing compaction', () => {
    const e1 = textEvent('user', 'a', 100);
    const e2 = textEvent('model', 'b', 200);
    const comp = compactionEvent(100, 200, 'summary of a+b', 250);
    const e3 = textEvent('user', 'c', 300);
    const e4 = textEvent('model', 'd', 400);
    const e5 = textEvent('user', 'e', 500);
    const e6 = textEvent('model', 'f', 600);

    const events = [e1, e2, comp, e3, e4, e5, e6];
    const result = eventsToCompactForTokenThreshold(events, 2);

    // The first event may be a seed from the previous compaction summary
    // (timestamp = startTimestamp of the previous compaction).
    // All other non-seed events must be after the compaction range.
    const hasSeed =
      result.length > 0 &&
      result[0].content?.parts?.[0]?.text === 'summary of a+b';
    const candidateEvents = hasSeed ? result.slice(1) : result;
    for (const ev of candidateEvents) {
      expect(ev.timestamp).toBeGreaterThan(200);
    }
  });

  it('prepends previous compaction summary as seed', () => {
    const comp = compactionEvent(100, 300, 'previous summary', 350);
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      textEvent('user', 'c', 300),
      comp,
      textEvent('model', 'd', 400),
      textEvent('user', 'e', 500),
      textEvent('model', 'f', 600),
      textEvent('user', 'g', 700),
      textEvent('model', 'h', 800),
    ];
    const result = eventsToCompactForTokenThreshold(events, 2);
    expect(result.length).toBeGreaterThan(0);

    const seedEvent = result[0];
    expect(seedEvent.content?.parts?.[0]?.text).toBe('previous summary');
  });
});

// ---------------------------------------------------------------------------
// processCompactionEvents
// ---------------------------------------------------------------------------

describe('processCompactionEvents', () => {
  it('returns events unchanged when no compaction events present', () => {
    const events = [textEvent('user', 'a', 100), textEvent('model', 'b', 200)];
    const result = processCompactionEvents(events);
    expect(result).toHaveLength(2);
    expect(result[0].timestamp).toBe(100);
    expect(result[1].timestamp).toBe(200);
  });

  it('replaces events in compaction range with summary', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      compactionEvent(100, 200, 'summary', 250),
      textEvent('user', 'c', 300),
    ];
    const result = processCompactionEvents(events);

    expect(result).toHaveLength(2);

    const summaryEvent = result[0];
    expect(summaryEvent.content?.parts?.[0]?.text).toBe('summary');
    expect(summaryEvent.timestamp).toBe(200);

    expect(result[1].timestamp).toBe(300);
  });

  it('handles multiple non-overlapping compactions', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      compactionEvent(100, 200, 'summary1', 250),
      textEvent('user', 'c', 300),
      textEvent('model', 'd', 400),
      compactionEvent(300, 400, 'summary2', 450),
      textEvent('user', 'e', 500),
    ];
    const result = processCompactionEvents(events);

    expect(result).toHaveLength(3);
    expect(result[0].content?.parts?.[0]?.text).toBe('summary1');
    expect(result[1].content?.parts?.[0]?.text).toBe('summary2');
    expect(result[2].timestamp).toBe(500);
  });

  it('removes subsumed compaction (smaller inside larger)', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      textEvent('user', 'c', 300),
      compactionEvent(100, 200, 'small summary', 250),
      compactionEvent(100, 300, 'big summary', 350),
      textEvent('user', 'd', 400),
    ];
    const result = processCompactionEvents(events);

    const summaries = result.filter((e) =>
      e.content?.parts?.[0]?.text?.includes('summary'),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content?.parts?.[0]?.text).toBe('big summary');
  });

  it('preserves events outside compaction range', () => {
    const events = [
      textEvent('user', 'before', 50),
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      compactionEvent(100, 200, 'summary', 250),
      textEvent('user', 'after', 300),
    ];
    const result = processCompactionEvents(events);

    expect(result).toHaveLength(3);
    expect(result[0].content?.parts?.[0]?.text).toBe('before');
    expect(result[1].content?.parts?.[0]?.text).toBe('summary');
    expect(result[2].content?.parts?.[0]?.text).toBe('after');
  });

  it('maintains chronological ordering after compaction', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      textEvent('user', 'c', 300),
      compactionEvent(100, 200, 'summary', 250),
      textEvent('model', 'd', 400),
    ];
    const result = processCompactionEvents(events);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp).toBeGreaterThanOrEqual(
        result[i - 1].timestamp,
      );
    }
  });

  it('handles empty events list', () => {
    expect(processCompactionEvents([])).toEqual([]);
  });

  it('handles events only containing compaction events with no raw events', () => {
    const events = [compactionEvent(100, 200, 'only summary', 250)];
    const result = processCompactionEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].content?.parts?.[0]?.text).toBe('only summary');
  });

  it('handles compaction event with invalid/missing fields gracefully', () => {
    const badCompactionEvent = createEvent({
      author: 'user',
      timestamp: 250,
      actions: createEventActions({
        compaction: {
          startTimestamp: undefined as unknown as number,
          endTimestamp: 200,
          compactedContent: {role: 'model', parts: [{text: 'bad'}]},
        },
      }),
    });
    const events = [
      textEvent('user', 'a', 100),
      badCompactionEvent,
      textEvent('user', 'b', 300),
    ];
    const result = processCompactionEvents(events);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('handles rolling compaction: new larger replaces old smaller', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      textEvent('user', 'c', 300),
      textEvent('model', 'd', 400),
      compactionEvent(100, 200, 'first compact', 250),
      compactionEvent(100, 400, 'second compact (rolling)', 450),
      textEvent('user', 'e', 500),
    ];
    const result = processCompactionEvents(events);

    const summaries = result.filter((e) =>
      e.content?.parts?.[0]?.text?.includes('compact'),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content?.parts?.[0]?.text).toBe(
      'second compact (rolling)',
    );
    expect(result[result.length - 1].timestamp).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// runCompactionForTokenThreshold (integration)
// ---------------------------------------------------------------------------

describe('runCompactionForTokenThreshold', () => {
  let appendedEvents: Event[];
  let sessionService: BaseSessionService;

  beforeEach(() => {
    const fake = fakeSessionService();
    sessionService = fake.service;
    appendedEvents = fake.appendedEvents;
  });

  it('returns undefined when config has no threshold', async () => {
    const result = await runCompactionForTokenThreshold({
      config: {},
      session: fakeSession([]),
      sessionService,
      agentName: 'agent',
    });
    expect(result).toBeUndefined();
    expect(appendedEvents).toHaveLength(0);
  });

  it('returns undefined when token count below threshold', async () => {
    const events = [textEvent('user', 'short', 100)];
    const result = await runCompactionForTokenThreshold({
      config: {tokenThreshold: 10000, eventRetentionSize: 1},
      session: fakeSession(events),
      sessionService,
      agentName: 'agent',
    });
    expect(result).toBeUndefined();
  });

  it('returns compaction event when token count exceeds threshold', async () => {
    const longText = 'x'.repeat(4000);
    const events = [
      textEvent('user', longText, 100),
      textEvent('model', longText, 200),
      textEvent('user', longText, 300),
      textEvent('model', longText, 400, {
        usageMetadata: {promptTokenCount: 5000, totalTokenCount: 5500},
      }),
      textEvent('user', longText, 500),
      textEvent('model', longText, 600),
    ];

    const summarizer = new FakeSummarizer('compacted summary');
    const config: EventsCompactionConfig = {
      tokenThreshold: 3000,
      eventRetentionSize: 2,
      summarizer,
    };

    const result = await runCompactionForTokenThreshold({
      config,
      session: fakeSession(events),
      sessionService,
      agentName: 'agent',
    });

    expect(result).toBeDefined();
    expect(result!.actions.compaction).toBeDefined();
    expect(appendedEvents).toHaveLength(1);
    expect(summarizer.calls).toHaveLength(1);
  });

  it('returns undefined when summarizer returns undefined', async () => {
    const longText = 'x'.repeat(4000);
    const events = [
      textEvent('user', longText, 100),
      textEvent('model', longText, 200, {
        usageMetadata: {promptTokenCount: 5000, totalTokenCount: 5500},
      }),
      textEvent('user', longText, 300),
      textEvent('model', longText, 400),
    ];

    const summarizer = new FakeSummarizer('');
    summarizer.returnEvent = undefined;

    const result = await runCompactionForTokenThreshold({
      config: {
        tokenThreshold: 3000,
        eventRetentionSize: 1,
        summarizer,
      },
      session: fakeSession(events),
      sessionService,
      agentName: 'agent',
    });

    expect(result).toBeUndefined();
    expect(appendedEvents).toHaveLength(0);
  });

  it('throws when no llm and no summarizer provided', async () => {
    const longText = 'x'.repeat(4000);
    const events = [
      textEvent('user', longText, 100),
      textEvent('model', longText, 200, {
        usageMetadata: {promptTokenCount: 5000, totalTokenCount: 5500},
      }),
      textEvent('user', longText, 300),
      textEvent('model', longText, 400),
    ];

    await expect(
      runCompactionForTokenThreshold({
        config: {tokenThreshold: 3000, eventRetentionSize: 1},
        session: fakeSession(events),
        sessionService,
        agentName: 'agent',
      }),
    ).rejects.toThrow('No LLM model available');
  });

  it('uses char-based estimation when no usageMetadata', async () => {
    const longText = 'x'.repeat(20000);
    const events = [
      textEvent('user', longText, 100),
      textEvent('model', longText, 200),
      textEvent('user', longText, 300),
      textEvent('model', longText, 400),
    ];

    const summarizer = new FakeSummarizer('compacted');
    const result = await runCompactionForTokenThreshold({
      config: {
        tokenThreshold: 1000,
        eventRetentionSize: 1,
        summarizer,
      },
      session: fakeSession(events),
      sessionService,
      agentName: 'agent',
    });

    expect(result).toBeDefined();
  });

  it('does not mutate the shared config object with a summarizer', async () => {
    const longText = 'x'.repeat(5000);
    const events = [
      textEvent('user', longText, 100),
      textEvent('model', longText, 200),
      textEvent('user', longText, 300),
      textEvent('model', longText, 400),
    ];

    const config: EventsCompactionConfig = {
      tokenThreshold: 1000,
      eventRetentionSize: 1,
    };

    const fakeLlm = {
      model: 'fake',
      generateContentAsync: async function* () {
        yield {content: {role: 'model' as const, parts: [{text: 'summary'}]}};
      },
      connect: () => {
        throw new Error('not implemented');
      },
    } as unknown as import('../../src/models/base_llm.js').BaseLlm;

    await runCompactionForTokenThreshold({
      config,
      session: fakeSession(events),
      sessionService,
      llm: fakeLlm,
      agentName: 'agent',
    });

    expect(config.summarizer).toBeUndefined();
  });

  it('uses config.summarizer when already set, without creating a new one', async () => {
    const longText = 'x'.repeat(4000);
    const events = [
      textEvent('user', longText, 100),
      textEvent('model', longText, 200, {
        usageMetadata: {promptTokenCount: 5000, totalTokenCount: 5500},
      }),
      textEvent('user', longText, 300),
      textEvent('model', longText, 400),
    ];

    const summarizer = new FakeSummarizer('used-preset-summarizer');

    await runCompactionForTokenThreshold({
      config: {
        tokenThreshold: 3000,
        eventRetentionSize: 1,
        summarizer,
      },
      session: fakeSession(events),
      sessionService,
      agentName: 'agent',
    });

    expect(summarizer.calls).toHaveLength(1);
    expect(appendedEvents).toHaveLength(1);
    expect(
      appendedEvents[0].actions.compaction?.compactedContent.parts?.[0]?.text,
    ).toBe('used-preset-summarizer');
  });

  it('skips compaction when session is modified during LLM call', async () => {
    const longText = 'x'.repeat(4000);
    const sessionEvents = [
      textEvent('user', longText, 100),
      textEvent('model', longText, 200, {
        usageMetadata: {promptTokenCount: 5000, totalTokenCount: 5500},
      }),
      textEvent('user', longText, 300),
      textEvent('model', longText, 400),
    ];

    const session = fakeSession(sessionEvents);
    const summarizer = new FakeSummarizer('compacted');

    const origMaybeSummarize = summarizer.maybeSummarizeEvents.bind(summarizer);
    summarizer.maybeSummarizeEvents = async (params) => {
      session.events.push(textEvent('user', 'concurrent event', 500));
      return origMaybeSummarize(params);
    };

    const result = await runCompactionForTokenThreshold({
      config: {tokenThreshold: 3000, eventRetentionSize: 1, summarizer},
      session,
      sessionService,
      agentName: 'agent',
    });

    expect(result).toBeUndefined();
    expect(appendedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// processCompactionEvents — binary search correctness
// ---------------------------------------------------------------------------

describe('processCompactionEvents binary search', () => {
  it('handles many non-overlapping compaction ranges correctly', () => {
    const events: Event[] = [];
    const numRanges = 20;

    for (let i = 0; i < numRanges; i++) {
      const start = 100 + i * 200;
      const end = start + 50;
      events.push(textEvent('user', `msg-${i}`, start));
      events.push(textEvent('model', `reply-${i}`, start + 25));
      events.push(compactionEvent(start, end, `summary-${i}`, end + 1));
      events.push(textEvent('user', `gap-${i}`, end + 80));
    }

    const result = processCompactionEvents(events);

    const summaryTexts = result
      .filter((e) => e.content?.parts?.[0]?.text?.startsWith('summary-'))
      .map((e) => e.content?.parts?.[0]?.text);
    expect(summaryTexts).toHaveLength(numRanges);

    const gapTexts = result
      .filter((e) => e.content?.parts?.[0]?.text?.startsWith('gap-'))
      .map((e) => e.content?.parts?.[0]?.text);
    expect(gapTexts).toHaveLength(numRanges);

    const rawMsgTexts = result.filter((e) =>
      e.content?.parts?.[0]?.text?.startsWith('msg-'),
    );
    expect(rawMsgTexts).toHaveLength(0);
  });

  it('binary search finds exact start boundary', () => {
    const events = [
      textEvent('user', 'at-start', 100),
      textEvent('model', 'middle', 150),
      compactionEvent(100, 200, 'summary', 250),
      textEvent('user', 'just-outside', 201),
    ];

    const result = processCompactionEvents(events);
    const texts = result.map((e) => e.content?.parts?.[0]?.text);
    expect(texts).not.toContain('at-start');
    expect(texts).toContain('summary');
    expect(texts).toContain('just-outside');
  });

  it('binary search finds exact end boundary', () => {
    const events = [
      textEvent('user', 'before', 99),
      textEvent('user', 'at-end', 200),
      compactionEvent(100, 200, 'summary', 250),
      textEvent('user', 'after', 300),
    ];

    const result = processCompactionEvents(events);
    const texts = result.map((e) => e.content?.parts?.[0]?.text);
    expect(texts).toContain('before');
    expect(texts).not.toContain('at-end');
    expect(texts).toContain('summary');
    expect(texts).toContain('after');
  });

  it('maintains sort order with interleaved compaction ranges', () => {
    const events = [
      textEvent('user', 'a', 50),
      textEvent('user', 'b', 150),
      textEvent('user', 'c', 250),
      textEvent('user', 'd', 350),
      textEvent('user', 'e', 450),
      compactionEvent(100, 200, 'summary-1', 201),
      compactionEvent(300, 400, 'summary-2', 401),
    ];

    const result = processCompactionEvents(events);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp).toBeGreaterThanOrEqual(
        result[i - 1].timestamp,
      );
    }

    const texts = result.map((e) => e.content?.parts?.[0]?.text);
    expect(texts).toContain('a');
    expect(texts).not.toContain('b');
    expect(texts).toContain('summary-1');
    expect(texts).toContain('c');
    expect(texts).not.toContain('d');
    expect(texts).toContain('summary-2');
    expect(texts).toContain('e');
  });
});
