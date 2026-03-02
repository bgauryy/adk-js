/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseEventsSummarizer} from './base_events_summarizer.js';

/**
 * Configuration for event compaction.
 *
 * Supports two compaction strategies:
 *
 * 1. Token-threshold: Compacts when prompt token count exceeds `tokenThreshold`,
 *    keeping the last `eventRetentionSize` raw events un-compacted.
 *
 * 2. Sliding window: Compacts every `compactionInterval` invocations with
 *    `overlapSize` invocations of overlap between consecutive summaries.
 *
 * Both strategies can be combined; token-threshold takes priority.
 */
export interface EventsCompactionConfig {
  /**
   * The event summarizer to use for compaction.
   * If not provided, an LlmEventSummarizer will be auto-created using the
   * agent's model when compaction is triggered.
   */
  summarizer?: BaseEventsSummarizer;

  /**
   * Post-invocation token threshold trigger.
   * When the most recently observed prompt token count meets or exceeds this
   * threshold, compaction is triggered. Must be set together with
   * `eventRetentionSize`.
   */
  tokenThreshold?: number;

  /**
   * Number of raw events to keep un-compacted after token-threshold compaction.
   * Must be set together with `tokenThreshold`.
   */
  eventRetentionSize?: number;

  /**
   * The number of new user-initiated invocations that trigger a sliding-window
   * compaction. Must be set together with `overlapSize`.
   */
  compactionInterval?: number;

  /**
   * The number of preceding invocations to include from the end of the last
   * compacted range, creating overlap for context continuity. Must be set
   * together with `compactionInterval`.
   */
  overlapSize?: number;
}

/**
 * Validates an EventsCompactionConfig, throwing if paired fields are
 * inconsistently set.
 */
export function validateEventsCompactionConfig(
  config: EventsCompactionConfig,
): void {
  const hasThreshold = config.tokenThreshold != null;
  const hasRetention = config.eventRetentionSize != null;
  if (hasThreshold !== hasRetention) {
    throw new Error(
      'tokenThreshold and eventRetentionSize must both be set or both unset.',
    );
  }
  if (hasThreshold && config.tokenThreshold! <= 0) {
    throw new Error('tokenThreshold must be greater than 0.');
  }
  if (hasRetention && config.eventRetentionSize! < 0) {
    throw new Error('eventRetentionSize must be >= 0.');
  }

  const hasInterval = config.compactionInterval != null;
  const hasOverlap = config.overlapSize != null;
  if (hasInterval !== hasOverlap) {
    throw new Error(
      'compactionInterval and overlapSize must both be set or both unset.',
    );
  }
  if (hasInterval && config.compactionInterval! <= 0) {
    throw new Error('compactionInterval must be greater than 0.');
  }
  if (hasOverlap && config.overlapSize! < 0) {
    throw new Error('overlapSize must be >= 0.');
  }
}
