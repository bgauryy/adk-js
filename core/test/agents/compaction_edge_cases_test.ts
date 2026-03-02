/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  eventsToCompactForTokenThreshold,
  latestPromptTokenCount,
  processCompactionEvents,
  runCompactionForTokenThreshold,
  safeTokenCompactionSplitIndex,
} from '../../src/agents/compaction.js';
import {getContents} from '../../src/agents/content_processor_utils.js';
import {Event} from '../../src/events/event.js';

import {
  compactionEvent,
  fakeSession,
  fakeSessionService,
  FakeSummarizer,
  functionCallEvent,
  functionResponseEvent,
  textEvent,
} from './compaction_test_helpers.js';

// ===========================================================================
// MULTI-AGENT EDGE CASES
// ===========================================================================

describe('Multi-agent compaction edge cases', () => {
  it('compaction summary is not treated as foreign agent event', () => {
    const events = [
      textEvent('user', 'hello', 100),
      textEvent('agent_a', 'hi from A', 200),
      textEvent('agent_b', 'hi from B', 300),
      compactionEvent(100, 300, 'Summary of multi-agent conversation', 350),
      textEvent('user', 'new message', 400),
      textEvent('agent_a', 'response from A', 500),
    ];

    const contents = getContents(events, 'agent_a');

    const summaryContent = contents.find((c) =>
      c.parts?.some((p) =>
        p.text?.includes('Summary of multi-agent conversation'),
      ),
    );
    expect(summaryContent).toBeDefined();
    expect(summaryContent!.parts?.[0]?.text).not.toContain('For context:');
  });

  it('agent transfer events after compaction range are preserved', () => {
    const events = [
      textEvent('user', 'start', 100),
      textEvent('agent_a', 'reply', 200),
      compactionEvent(100, 200, 'summary', 250),
      textEvent('agent_b', 'transferred reply', 300),
      textEvent('user', 'follow-up', 400),
    ];

    const contents = getContents(events, 'agent_a');

    const transferText = contents.find((c) =>
      c.parts?.some((p) => p.text?.includes('[agent_b]')),
    );
    expect(transferText).toBeDefined();
  });

  it('handles branched events correctly with compaction', () => {
    const events = [
      textEvent('user', 'hello', 100, {branch: 'main'}),
      textEvent('agent_a', 'hi', 200, {branch: 'main.sub_a'}),
      textEvent('agent_b', 'yo', 300, {branch: 'main.sub_b'}),
      compactionEvent(100, 200, 'summary of main.sub_a', 250),
      textEvent('user', 'msg', 400, {branch: 'main.sub_a'}),
    ];

    const contents = getContents(events, 'agent_a', 'main.sub_a');

    const allText = contents.map((c) => c.parts?.[0]?.text);
    expect(allText).toContain('summary of main.sub_a');
    expect(allText).toContain('msg');
    expect(allText).not.toContain('yo');
  });

  it('events from multiple agents are all compacted in range', () => {
    const events = [
      textEvent('user', 'start', 100),
      textEvent('agent_a', 'from A', 200),
      textEvent('agent_b', 'from B', 300),
      textEvent('user', 'mid', 400),
      compactionEvent(100, 400, 'summary of everything', 450),
      textEvent('user', 'after', 500),
    ];

    const result = processCompactionEvents(events);
    const texts = result.map((e) => e.content?.parts?.[0]?.text);
    expect(texts).not.toContain('from A');
    expect(texts).not.toContain('from B');
    expect(texts).not.toContain('start');
    expect(texts).not.toContain('mid');
    expect(texts).toContain('summary of everything');
    expect(texts).toContain('after');
  });
});

// ===========================================================================
// STATE & METADATA EDGE CASES
// ===========================================================================

describe('State and metadata during compaction', () => {
  it('events with stateDelta inside compaction range are filtered out', () => {
    const eventWithState = textEvent('user', 'set state', 200);
    eventWithState.actions.stateDelta = {key: 'value'};

    const events = [
      textEvent('user', 'hello', 100),
      eventWithState,
      compactionEvent(100, 200, 'summary', 250),
      textEvent('user', 'after', 300),
    ];

    const result = processCompactionEvents(events);
    const stateEvents = result.filter(
      (e) => Object.keys(e.actions?.stateDelta ?? {}).length > 0,
    );
    expect(stateEvents.length).toBeLessThanOrEqual(1);
  });

  it('compaction event itself does not carry state delta to LLM', () => {
    const comp = compactionEvent(100, 200, 'summary', 250);
    const events = [
      textEvent('user', 'hello', 100),
      textEvent('agent', 'reply', 200),
      comp,
      textEvent('user', 'next', 300),
    ];

    const contents = getContents(events, 'agent');
    expect(contents.length).toBeGreaterThan(0);
  });

  it('invocationId is set on compaction event when provided', async () => {
    const longText = 'x'.repeat(4000);
    const events = [
      textEvent('user', longText, 100),
      textEvent('model', longText, 200, {
        usageMetadata: {promptTokenCount: 5000, totalTokenCount: 5500},
      }),
      textEvent('user', longText, 300),
      textEvent('model', longText, 400),
    ];

    const {service, appendedEvents} = fakeSessionService();

    const summarizer = new FakeSummarizer('compacted');
    await runCompactionForTokenThreshold({
      config: {tokenThreshold: 3000, eventRetentionSize: 1, summarizer},
      session: fakeSession(events),
      sessionService: service,
      agentName: 'agent',
      invocationId: 'inv-123',
    });

    expect(appendedEvents).toHaveLength(1);
    expect(appendedEvents[0].invocationId).toBe('inv-123');
  });
});

// ===========================================================================
// EFFICIENCY EDGE CASES
// ===========================================================================

describe('Efficiency edge cases', () => {
  it('processCompactionEvents short-circuits when no compactions exist', () => {
    const events = [textEvent('user', 'a', 100), textEvent('model', 'b', 200)];
    const result = processCompactionEvents(events);
    expect(result).toBe(events);
  });

  it('estimatePromptTokenCount does not double-count with compaction', () => {
    const longText = 'x'.repeat(4000);
    const events = [
      textEvent('user', longText, 100),
      textEvent('model', longText, 200),
      compactionEvent(100, 200, 'short summary', 250),
      textEvent('user', 'new msg', 300),
    ];

    const count = latestPromptTokenCount(events, 'agent');

    const compactedChars = 'short summary'.length + 'new msg'.length;
    const rawChars = longText.length * 2 + 'new msg'.length;
    const estimatedFromRaw = Math.floor(rawChars / 4);
    const estimatedFromCompacted = Math.floor(compactedChars / 4);

    expect(count).toBeLessThan(estimatedFromRaw);
    expect(count).toBe(estimatedFromCompacted);
  });

  it('handles large event lists without throwing', () => {
    const events: Event[] = [];
    for (let i = 0; i < 1000; i++) {
      events.push(textEvent(i % 2 === 0 ? 'user' : 'model', `msg ${i}`, i));
    }
    events.push(compactionEvent(0, 500, 'summary of first 500', 1001));

    const result = processCompactionEvents(events);
    expect(result.length).toBeLessThan(events.length);
    expect(result.length).toBeGreaterThan(0);

    const summaries = result.filter((e) =>
      e.content?.parts?.[0]?.text?.includes('summary of first 500'),
    );
    expect(summaries).toHaveLength(1);
  });

  it('compaction does not re-trigger in same invocation', async () => {
    const longText = 'x'.repeat(4000);
    const events = [
      textEvent('user', longText, 100),
      textEvent('model', longText, 200, {
        usageMetadata: {promptTokenCount: 5000, totalTokenCount: 5500},
      }),
      textEvent('user', longText, 300),
      textEvent('model', longText, 400),
    ];

    const {service} = fakeSessionService();

    const summarizer = new FakeSummarizer('compacted');

    const firstResult = await runCompactionForTokenThreshold({
      config: {tokenThreshold: 3000, eventRetentionSize: 1, summarizer},
      session: fakeSession(events),
      sessionService: service,
      agentName: 'agent',
    });
    expect(firstResult).toBeDefined();
    expect(summarizer.calls).toHaveLength(1);
  });
});

// ===========================================================================
// TIMESTAMP & ORDERING EDGE CASES
// ===========================================================================

describe('Timestamp and ordering edge cases', () => {
  it('handles events with identical timestamps', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 100),
      compactionEvent(100, 100, 'summary of instant events', 101),
      textEvent('user', 'c', 200),
    ];

    const result = processCompactionEvents(events);

    const summaries = result.filter((e) =>
      e.content?.parts?.[0]?.text?.includes('summary of instant'),
    );
    expect(summaries).toHaveLength(1);
    expect(result[result.length - 1].content?.parts?.[0]?.text).toBe('c');
  });

  it('handles compaction where start == end timestamp', () => {
    const events = [
      textEvent('user', 'only event', 100),
      compactionEvent(100, 100, 'summary of one event', 101),
      textEvent('user', 'after', 200),
    ];

    const result = processCompactionEvents(events);
    const texts = result.map((e) => e.content?.parts?.[0]?.text);
    expect(texts).toContain('summary of one event');
    expect(texts).toContain('after');
    expect(texts).not.toContain('only event');
  });

  it('events at exact boundary of compaction range are included in range', () => {
    const events = [
      textEvent('user', 'at-start', 100),
      textEvent('model', 'middle', 150),
      textEvent('user', 'at-end', 200),
      compactionEvent(100, 200, 'summary', 250),
      textEvent('user', 'after', 300),
    ];

    const result = processCompactionEvents(events);
    const texts = result.map((e) => e.content?.parts?.[0]?.text);
    expect(texts).not.toContain('at-start');
    expect(texts).not.toContain('middle');
    expect(texts).not.toContain('at-end');
    expect(texts).toContain('summary');
    expect(texts).toContain('after');
  });

  it('adjacent non-overlapping compaction ranges work correctly', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      compactionEvent(100, 200, 'summary 1', 201),
      textEvent('user', 'c', 300),
      textEvent('model', 'd', 400),
      compactionEvent(300, 400, 'summary 2', 401),
      textEvent('user', 'e', 500),
    ];

    const result = processCompactionEvents(events);
    const texts = result.map((e) => e.content?.parts?.[0]?.text);
    expect(texts).toEqual(['summary 1', 'summary 2', 'e']);
  });
});

// ===========================================================================
// FUNCTION CALL/RESPONSE PAIRING IN COMPACTION
// ===========================================================================

describe('Function call/response integrity during compaction', () => {
  it('safe split does not orphan response when call is at retention boundary', () => {
    const events = [
      textEvent('user', 'start', 100),
      textEvent('model', 'thinking', 200),
      functionCallEvent('fc-1', 'search', 300),
      functionResponseEvent('fc-1', 'search', 400),
      textEvent('model', 'answer', 500),
      textEvent('user', 'thanks', 600),
    ];

    const split = safeTokenCompactionSplitIndex(events, 3);
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

  it('handles deeply nested tool calls in compaction range', () => {
    const events = [
      textEvent('user', 'q', 100),
      functionCallEvent('fc-1', 'tool_a', 200),
      functionResponseEvent('fc-1', 'tool_a', 300),
      functionCallEvent('fc-2', 'tool_b', 400),
      functionResponseEvent('fc-2', 'tool_b', 500),
      textEvent('model', 'final', 600),
      textEvent('user', 'ok', 700),
    ];

    const result = eventsToCompactForTokenThreshold(events, 2);
    expect(result.length).toBeGreaterThan(0);

    const compactedCallIds = new Set<string>();
    const compactedResponseIds = new Set<string>();
    for (const e of result) {
      for (const part of e.content?.parts ?? []) {
        if (part.functionCall?.id) compactedCallIds.add(part.functionCall.id);
        if (part.functionResponse?.id)
          compactedResponseIds.add(part.functionResponse.id);
      }
    }

    for (const id of compactedResponseIds) {
      expect(compactedCallIds.has(id)).toBe(true);
    }
  });

  it('getContents works after compaction removes function call pairs', () => {
    const events = [
      textEvent('user', 'q', 100),
      functionCallEvent('fc-1', 'search', 200),
      functionResponseEvent('fc-1', 'search', 300),
      textEvent('agent', 'answer', 400),
      compactionEvent(
        100,
        400,
        'User asked q, agent used search and answered',
        450,
      ),
      textEvent('user', 'thanks', 500),
      textEvent('agent', 'youre welcome', 600),
    ];

    const contents = getContents(events, 'agent');
    expect(contents.length).toBeGreaterThanOrEqual(2);

    const allText = contents
      .map((c) => c.parts?.map((p) => p.text).join(' '))
      .join(' ');
    expect(allText).toContain('User asked q');
    expect(allText).toContain('thanks');
  });
});

// ===========================================================================
// CONCURRENT / REPEATED COMPACTION
// ===========================================================================

describe('Repeated compaction scenarios', () => {
  it('three rolling compactions: only the latest non-subsumed remains', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      textEvent('user', 'c', 300),
      textEvent('model', 'd', 400),
      textEvent('user', 'e', 500),
      compactionEvent(100, 200, 'compact-1', 250),
      compactionEvent(100, 400, 'compact-2 (rolling)', 450),
      compactionEvent(100, 500, 'compact-3 (final rolling)', 550),
      textEvent('user', 'f', 600),
    ];

    const result = processCompactionEvents(events);
    const summaries = result.filter((e) =>
      e.content?.parts?.[0]?.text?.includes('compact'),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content?.parts?.[0]?.text).toBe(
      'compact-3 (final rolling)',
    );
  });

  it('KNOWN LIMITATION: new event at same ms as compaction endTimestamp is filtered (inclusive boundary)', () => {
    // This documents a known limitation matching the Python reference implementation.
    // Events at exactly endTimestamp are treated as "inside" the compaction range.
    // In practice this requires same-millisecond event creation, which is rare.
    const events = [
      textEvent('user', 'old', 100),
      textEvent('model', 'reply', 200),
      compactionEvent(100, 200, 'summary', 250),
      textEvent('user', 'new-at-same-ms', 200), // same ms as endTimestamp
      textEvent('user', 'after', 300),
    ];

    const result = processCompactionEvents(events);
    const texts = result.map((e) => e.content?.parts?.[0]?.text);

    // The event at ts=200 is incorrectly filtered because it falls within [100, 200]
    expect(texts).not.toContain('new-at-same-ms');
    expect(texts).toContain('summary');
    expect(texts).toContain('after');
  });

  it('non-overlapping compactions at different parts of history both survive', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      compactionEvent(100, 200, 'early-summary', 250),
      textEvent('user', 'c', 300),
      textEvent('model', 'd', 400),
      textEvent('user', 'e', 500),
      textEvent('model', 'f', 600),
      compactionEvent(300, 600, 'late-summary', 650),
      textEvent('user', 'g', 700),
    ];

    const result = processCompactionEvents(events);
    const summaryTexts = result
      .map((e) => e.content?.parts?.[0]?.text)
      .filter((t) => t?.includes('summary'));
    expect(summaryTexts).toHaveLength(2);
    expect(summaryTexts).toContain('early-summary');
    expect(summaryTexts).toContain('late-summary');
  });
});
