/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

/**
 * Base interface for compacting events.
 *
 * Implementations summarize a list of events into a single compaction event.
 * If compaction fails or is not needed, `maybeSummarizeEvents` returns
 * undefined.
 */
export abstract class BaseEventsSummarizer {
  /**
   * Summarizes the given events into a single compaction event.
   *
   * @param params.events Events to compact.
   * @returns The new compacted event, or undefined if no compaction happened.
   */
  abstract maybeSummarizeEvents(params: {
    events: Event[];
  }): Promise<Event | undefined>;
}
