/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {metrics} from '@opentelemetry/api';
import {version} from '../version.js';

const meter = metrics.getMeter('gcp.vertex.agent.compaction', version);

const compactionRunsCounter = meter.createCounter('adk.compaction.runs', {
  description: 'Number of compaction runs by strategy',
});

const eventsCompactedCounter = meter.createCounter(
  'adk.compaction.events_compacted',
  {description: 'Number of events compacted per run'},
);

const compactionLatencyHistogram = meter.createHistogram(
  'adk.compaction.latency_ms',
  {description: 'Compaction latency in milliseconds', unit: 'ms'},
);

export type CompactionStrategy = 'token_threshold' | 'sliding_window';

export function recordCompactionRun(
  strategy: CompactionStrategy,
  eventsCompacted: number,
  latencyMs: number,
): void {
  compactionRunsCounter.add(1, {strategy});
  eventsCompactedCounter.add(eventsCompacted, {strategy});
  compactionLatencyHistogram.record(latencyMs, {strategy});
}
