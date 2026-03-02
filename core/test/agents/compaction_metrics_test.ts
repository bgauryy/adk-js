/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {vi} from 'vitest';

import {
  runCompactionForSlidingWindow,
  runCompactionForTokenThreshold,
} from '../../src/agents/compaction.js';

vi.mock('../../src/telemetry/compaction_metrics.js', () => ({
  recordCompactionRun: vi.fn(),
}));

import {recordCompactionRun} from '../../src/telemetry/compaction_metrics.js';

import {
  FakeSummarizer,
  fakeSessionService as _fakeSessionService,
  fakeSession,
  textEvent,
} from './compaction_test_helpers.js';

function fakeSessionService() {
  const {service, appendedEvents} = _fakeSessionService();
  return {service, appended: appendedEvents};
}

// ---------------------------------------------------------------------------
// Token-threshold metrics
// ---------------------------------------------------------------------------

describe('Compaction OTel metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runCompactionForTokenThreshold metrics', () => {
    it('records compaction run metrics on successful compaction', async () => {
      const {service} = fakeSessionService();
      const summarizer = new FakeSummarizer('compacted');
      const longText = 'x'.repeat(4000);

      const events = [
        textEvent('user', longText, 100),
        textEvent('model', longText, 200, {
          usageMetadata: {promptTokenCount: 5000, totalTokenCount: 5500},
        }),
        textEvent('user', longText, 300),
        textEvent('model', longText, 400),
      ];

      await runCompactionForTokenThreshold({
        config: {tokenThreshold: 3000, eventRetentionSize: 1, summarizer},
        session: fakeSession(events),
        sessionService: service,
        agentName: 'agent',
      });

      expect(recordCompactionRun).toHaveBeenCalledTimes(1);
      expect(recordCompactionRun).toHaveBeenCalledWith(
        'token_threshold',
        expect.any(Number),
        expect.any(Number),
      );
      const [, eventsCompacted, latencyMs] = (
        recordCompactionRun as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(eventsCompacted).toBeGreaterThan(0);
      expect(latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('does NOT record metrics when compaction is skipped (below threshold)', async () => {
      const {service} = fakeSessionService();
      const events = [textEvent('user', 'short', 100)];

      await runCompactionForTokenThreshold({
        config: {tokenThreshold: 10000, eventRetentionSize: 1},
        session: fakeSession(events),
        sessionService: service,
        agentName: 'agent',
      });

      expect(recordCompactionRun).not.toHaveBeenCalled();
    });

    it('does NOT record metrics when summarizer returns undefined', async () => {
      const {service} = fakeSessionService();
      const summarizer = new FakeSummarizer('');
      summarizer.returnEvent = undefined;
      const longText = 'x'.repeat(4000);

      const events = [
        textEvent('user', longText, 100),
        textEvent('model', longText, 200, {
          usageMetadata: {promptTokenCount: 5000, totalTokenCount: 5500},
        }),
        textEvent('user', longText, 300),
        textEvent('model', longText, 400),
      ];

      await runCompactionForTokenThreshold({
        config: {tokenThreshold: 3000, eventRetentionSize: 1, summarizer},
        session: fakeSession(events),
        sessionService: service,
        agentName: 'agent',
      });

      expect(recordCompactionRun).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Sliding-window metrics
  // ---------------------------------------------------------------------------

  describe('runCompactionForSlidingWindow metrics', () => {
    it('records sliding_window metrics on successful compaction', async () => {
      const {service} = fakeSessionService();
      const summarizer = new FakeSummarizer('sliding summary');

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

      expect(recordCompactionRun).toHaveBeenCalledTimes(1);
      expect(recordCompactionRun).toHaveBeenCalledWith(
        'sliding_window',
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('records token_threshold strategy when sliding window falls back to token compaction', async () => {
      const {service} = fakeSessionService();
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

      expect(recordCompactionRun).toHaveBeenCalledTimes(1);
      expect(recordCompactionRun).toHaveBeenCalledWith(
        'token_threshold',
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('does NOT record metrics when not enough invocations', async () => {
      const {service} = fakeSessionService();
      const summarizer = new FakeSummarizer();

      const events = [
        textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
        textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      ];

      await runCompactionForSlidingWindow({
        config: {compactionInterval: 5, overlapSize: 0, summarizer},
        session: fakeSession(events),
        sessionService: service,
      });

      expect(recordCompactionRun).not.toHaveBeenCalled();
    });
  });
});
