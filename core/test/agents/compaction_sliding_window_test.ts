/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {runCompactionForSlidingWindow} from '../../src/agents/compaction.js';

import {
  fakeSessionService as _fakeSessionService,
  compactionEvent,
  fakeSession,
  FakeSummarizer,
  textEvent,
} from './compaction_test_helpers.js';

function fakeSessionService() {
  const {service, appendedEvents} = _fakeSessionService();
  return {service, appended: appendedEvents};
}

// ---------------------------------------------------------------------------
// runCompactionForSlidingWindow
// ---------------------------------------------------------------------------

describe('runCompactionForSlidingWindow', () => {
  it('returns early when config is undefined', async () => {
    const {service, appended} = fakeSessionService();
    await runCompactionForSlidingWindow({
      config: undefined,
      session: fakeSession([textEvent('user', 'hi', 100)]),
      sessionService: service,
    });
    expect(appended).toHaveLength(0);
  });

  it('returns early when events list is empty', async () => {
    const {service, appended} = fakeSessionService();
    await runCompactionForSlidingWindow({
      config: {compactionInterval: 2, overlapSize: 1},
      session: fakeSession([]),
      sessionService: service,
    });
    expect(appended).toHaveLength(0);
  });

  it('does nothing when only sliding window config but not enough invocations', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer();
    const events = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
    ];
    await runCompactionForSlidingWindow({
      config: {compactionInterval: 2, overlapSize: 0, summarizer},
      session: fakeSession(events),
      sessionService: service,
    });
    expect(appended).toHaveLength(0);
    expect(summarizer.calls).toHaveLength(0);
  });

  it('returns compaction event when enough new invocations exist', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('sliding summary');
    const events = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      textEvent('user', 'c', 300, {invocationId: 'inv-2'}),
      textEvent('model', 'd', 400, {invocationId: 'inv-2'}),
    ];
    const result = await runCompactionForSlidingWindow({
      config: {compactionInterval: 2, overlapSize: 0, summarizer},
      session: fakeSession(events),
      sessionService: service,
    });
    expect(result).toBeDefined();
    expect(result!.actions.compaction).toBeDefined();
    expect(appended).toHaveLength(1);
    expect(summarizer.calls).toHaveLength(1);
    expect(summarizer.calls[0]).toHaveLength(4);
  });

  it('includes overlap invocations from before the new block', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('overlap summary');

    const prevComp = compactionEvent(100, 400, 'prev summary', 450, {
      invocationId: 'comp-1',
    });

    const events = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      textEvent('user', 'c', 300, {invocationId: 'inv-2'}),
      textEvent('model', 'd', 400, {invocationId: 'inv-2'}),
      prevComp,
      textEvent('user', 'e', 500, {invocationId: 'inv-3'}),
      textEvent('model', 'f', 600, {invocationId: 'inv-3'}),
      textEvent('user', 'g', 700, {invocationId: 'inv-4'}),
      textEvent('model', 'h', 800, {invocationId: 'inv-4'}),
      textEvent('user', 'i', 900, {invocationId: 'inv-5'}),
      textEvent('model', 'j', 1000, {invocationId: 'inv-5'}),
    ];

    await runCompactionForSlidingWindow({
      config: {compactionInterval: 3, overlapSize: 1, summarizer},
      session: fakeSession(events),
      sessionService: service,
    });

    expect(appended).toHaveLength(1);
    expect(summarizer.calls).toHaveLength(1);

    const compactedEvents = summarizer.calls[0];
    const compactedInvIds = new Set(compactedEvents.map((e) => e.invocationId));
    expect(compactedInvIds.has('inv-2')).toBe(true);
    expect(compactedInvIds.has('inv-3')).toBe(true);
    expect(compactedInvIds.has('inv-4')).toBe(true);
    expect(compactedInvIds.has('inv-5')).toBe(true);
  });

  it('filters out compaction events from the window', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('clean summary');

    const events = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      compactionEvent(50, 90, 'old summary', 150, {invocationId: 'old-comp'}),
      textEvent('user', 'c', 300, {invocationId: 'inv-2'}),
      textEvent('model', 'd', 400, {invocationId: 'inv-2'}),
    ];

    await runCompactionForSlidingWindow({
      config: {compactionInterval: 2, overlapSize: 0, summarizer},
      session: fakeSession(events),
      sessionService: service,
    });

    expect(appended).toHaveLength(1);
    const compactedEvents = summarizer.calls[0];
    const hasCompaction = compactedEvents.some((e) => e.actions?.compaction);
    expect(hasCompaction).toBe(false);
  });

  it('does not compact when summarizer returns undefined', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('');
    summarizer.returnEvent = undefined;

    const events = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      textEvent('user', 'c', 300, {invocationId: 'inv-2'}),
      textEvent('model', 'd', 400, {invocationId: 'inv-2'}),
    ];

    await runCompactionForSlidingWindow({
      config: {compactionInterval: 2, overlapSize: 0, summarizer},
      session: fakeSession(events),
      sessionService: service,
    });

    expect(appended).toHaveLength(0);
  });

  it('prefers token-threshold compaction when both are configured', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('token compact');

    const longText = 'x'.repeat(20000);
    const events = [
      textEvent('user', longText, 100, {invocationId: 'inv-1'}),
      textEvent('model', longText, 200, {
        invocationId: 'inv-1',
        usageMetadata: {promptTokenCount: 50000, totalTokenCount: 55000},
      }),
      textEvent('user', longText, 300, {invocationId: 'inv-2'}),
      textEvent('model', longText, 400, {invocationId: 'inv-2'}),
    ];

    await runCompactionForSlidingWindow({
      config: {
        tokenThreshold: 1000,
        eventRetentionSize: 1,
        compactionInterval: 2,
        overlapSize: 0,
        summarizer,
      },
      session: fakeSession(events),
      sessionService: service,
    });

    expect(appended).toHaveLength(1);
    expect(summarizer.calls).toHaveLength(1);
  });

  it('skips token compaction when skipTokenCompaction is true', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('sliding only');

    const longText = 'x'.repeat(20000);
    const events = [
      textEvent('user', longText, 100, {invocationId: 'inv-1'}),
      textEvent('model', longText, 200, {
        invocationId: 'inv-1',
        usageMetadata: {promptTokenCount: 50000, totalTokenCount: 55000},
      }),
      textEvent('user', longText, 300, {invocationId: 'inv-2'}),
      textEvent('model', longText, 400, {invocationId: 'inv-2'}),
    ];

    await runCompactionForSlidingWindow({
      config: {
        tokenThreshold: 1000,
        eventRetentionSize: 1,
        compactionInterval: 2,
        overlapSize: 0,
        summarizer,
      },
      session: fakeSession(events),
      sessionService: service,
      skipTokenCompaction: true,
    });

    expect(appended).toHaveLength(1);
    const compactedEvents = summarizer.calls[0];
    const compactedInvIds = new Set(compactedEvents.map((e) => e.invocationId));
    expect(compactedInvIds.has('inv-1')).toBe(true);
    expect(compactedInvIds.has('inv-2')).toBe(true);
  });

  it('does nothing when no sliding window config', async () => {
    const {service, appended} = fakeSessionService();
    const events = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      textEvent('user', 'c', 300, {invocationId: 'inv-2'}),
      textEvent('model', 'd', 400, {invocationId: 'inv-2'}),
    ];

    await runCompactionForSlidingWindow({
      config: {},
      session: fakeSession(events),
      sessionService: service,
    });

    expect(appended).toHaveLength(0);
  });

  it('handles events without invocationId gracefully', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('summary');

    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      textEvent('user', 'c', 300, {invocationId: 'inv-1'}),
      textEvent('model', 'd', 400, {invocationId: 'inv-1'}),
    ];

    await runCompactionForSlidingWindow({
      config: {compactionInterval: 2, overlapSize: 0, summarizer},
      session: fakeSession(events),
      sessionService: service,
    });

    expect(appended).toHaveLength(0);
  });

  it('compacts correctly after a previous compaction exists', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('new summary');

    const events = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      textEvent('user', 'c', 300, {invocationId: 'inv-2'}),
      textEvent('model', 'd', 400, {invocationId: 'inv-2'}),
      compactionEvent(100, 400, 'old summary', 450),
      textEvent('user', 'e', 500, {invocationId: 'inv-3'}),
      textEvent('model', 'f', 600, {invocationId: 'inv-3'}),
      textEvent('user', 'g', 700, {invocationId: 'inv-4'}),
      textEvent('model', 'h', 800, {invocationId: 'inv-4'}),
    ];

    await runCompactionForSlidingWindow({
      config: {compactionInterval: 2, overlapSize: 0, summarizer},
      session: fakeSession(events),
      sessionService: service,
    });

    expect(appended).toHaveLength(1);
    const compactedEvents = summarizer.calls[0];
    for (const e of compactedEvents) {
      expect(e.timestamp).toBeGreaterThan(400);
    }
  });

  it('throws when no llm and no summarizer provided', async () => {
    const {service} = fakeSessionService();
    const events = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      textEvent('user', 'c', 300, {invocationId: 'inv-2'}),
      textEvent('model', 'd', 400, {invocationId: 'inv-2'}),
    ];

    await expect(
      runCompactionForSlidingWindow({
        config: {compactionInterval: 2, overlapSize: 0},
        session: fakeSession(events),
        sessionService: service,
      }),
    ).rejects.toThrow('No LLM model available');
  });

  it('overlapSize 0 does not include previous invocations', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('no overlap');

    const events = [
      textEvent('user', 'old', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'old reply', 200, {invocationId: 'inv-1'}),
      compactionEvent(100, 200, 'old comp', 250),
      textEvent('user', 'a', 300, {invocationId: 'inv-2'}),
      textEvent('model', 'b', 400, {invocationId: 'inv-2'}),
      textEvent('user', 'c', 500, {invocationId: 'inv-3'}),
      textEvent('model', 'd', 600, {invocationId: 'inv-3'}),
    ];

    await runCompactionForSlidingWindow({
      config: {compactionInterval: 2, overlapSize: 0, summarizer},
      session: fakeSession(events),
      sessionService: service,
    });

    expect(appended).toHaveLength(1);
    const compactedEvents = summarizer.calls[0];
    const compactedInvIds = new Set(compactedEvents.map((e) => e.invocationId));
    expect(compactedInvIds.has('inv-1')).toBe(false);
    expect(compactedInvIds.has('inv-2')).toBe(true);
    expect(compactedInvIds.has('inv-3')).toBe(true);
  });

  it('returns undefined when config is undefined', async () => {
    const {service} = fakeSessionService();
    const result = await runCompactionForSlidingWindow({
      config: undefined,
      session: fakeSession([textEvent('user', 'hi', 100)]),
      sessionService: service,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when not enough invocations', async () => {
    const {service} = fakeSessionService();
    const summarizer = new FakeSummarizer();
    const result = await runCompactionForSlidingWindow({
      config: {compactionInterval: 5, overlapSize: 0, summarizer},
      session: fakeSession([
        textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
        textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      ]),
      sessionService: service,
    });
    expect(result).toBeUndefined();
  });

  it('passes agentName and currentBranch through to token-threshold fallback', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('branched compact');

    const longText = 'x'.repeat(20000);
    const events = [
      textEvent('user', longText, 100, {
        invocationId: 'inv-1',
        branch: 'main.sub_a',
      }),
      textEvent('myAgent', longText, 200, {
        invocationId: 'inv-1',
        branch: 'main.sub_a',
        usageMetadata: {promptTokenCount: 50000, totalTokenCount: 55000},
      }),
      textEvent('otherAgent', longText, 250, {
        invocationId: 'inv-1',
        branch: 'main.sub_b',
      }),
      textEvent('user', longText, 300, {
        invocationId: 'inv-2',
        branch: 'main.sub_a',
      }),
      textEvent('myAgent', longText, 400, {
        invocationId: 'inv-2',
        branch: 'main.sub_a',
      }),
    ];

    const result = await runCompactionForSlidingWindow({
      config: {
        tokenThreshold: 1000,
        eventRetentionSize: 1,
        compactionInterval: 2,
        overlapSize: 0,
        summarizer,
      },
      session: fakeSession(events),
      sessionService: service,
      agentName: 'myAgent',
      currentBranch: 'main.sub_a',
    });

    expect(result).toBeDefined();
    expect(appended).toHaveLength(1);
  });

  it('skips compaction when session is modified during LLM call', async () => {
    const {service, appended} = fakeSessionService();
    const summarizer = new FakeSummarizer('concurrent');

    const sessionEvents = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      textEvent('user', 'c', 300, {invocationId: 'inv-2'}),
      textEvent('model', 'd', 400, {invocationId: 'inv-2'}),
    ];
    const session = fakeSession(sessionEvents);

    const origMaybeSummarize = summarizer.maybeSummarizeEvents.bind(summarizer);
    summarizer.maybeSummarizeEvents = async (params) => {
      session.events.push(textEvent('user', 'concurrent', 500));
      return origMaybeSummarize(params);
    };

    const result = await runCompactionForSlidingWindow({
      config: {compactionInterval: 2, overlapSize: 0, summarizer},
      session,
      sessionService: service,
    });

    expect(result).toBeUndefined();
    expect(appended).toHaveLength(0);
  });
});
