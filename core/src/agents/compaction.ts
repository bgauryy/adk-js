/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {
  createEvent,
  createNewEventId,
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {BaseLlm} from '../models/base_llm.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {Session} from '../sessions/session.js';
import {recordCompactionRun} from '../telemetry/compaction_metrics.js';
import {logger} from '../utils/logger.js';

import {BaseEventsSummarizer} from './base_events_summarizer.js';
import {getContents} from './content_processor_utils.js';
import {EventsCompactionConfig} from './events_compaction_config.js';
import {LlmEventSummarizer} from './llm_event_summarizer.js';

// ---------------------------------------------------------------------------
// Configuration checks
// ---------------------------------------------------------------------------

export function hasTokenThresholdConfig(
  config: EventsCompactionConfig | undefined,
): boolean {
  return !!(
    config &&
    config.tokenThreshold != null &&
    config.eventRetentionSize != null
  );
}

export function hasSlidingWindowConfig(
  config: EventsCompactionConfig | undefined,
): boolean {
  return !!(
    config &&
    config.compactionInterval != null &&
    config.overlapSize != null
  );
}

// ---------------------------------------------------------------------------
// Token counting helpers
// ---------------------------------------------------------------------------

function countContentChars(content: Content | undefined): number {
  let total = 0;
  if (!content?.parts) return total;
  for (const part of content.parts) {
    if (part.text) {
      total += part.text.length;
    }
    if (part.functionCall) {
      total += part.functionCall.name?.length ?? 0;
      if (part.functionCall.args) {
        total += JSON.stringify(part.functionCall.args).length;
      }
    }
    if (part.functionResponse) {
      total += part.functionResponse.name?.length ?? 0;
      if (part.functionResponse.response) {
        total += JSON.stringify(part.functionResponse.response).length;
      }
    }
    if (part.executableCode?.code) {
      total += part.executableCode.code.length;
    }
    if (part.codeExecutionResult?.output) {
      total += part.codeExecutionResult.output.length;
    }
    if (part.inlineData?.data) {
      total += part.inlineData.data.length;
    }
  }
  return total;
}

/**
 * Returns an approximate prompt token count from session events.
 * Delegates to the full content-building pipeline ({@link getContents}) so that
 * the estimate matches what the model actually receives (filtering, compaction,
 * branch scoping, auth/confirmation removal, foreign-event conversion, etc.).
 */
function estimatePromptTokenCount(
  events: Event[],
  agentName: string,
  currentBranch?: string,
): number | undefined {
  const effectiveContents = getContents(events, agentName, currentBranch);
  let totalChars = 0;
  for (const content of effectiveContents) {
    totalChars += countContentChars(content);
  }
  if (totalChars <= 0) return undefined;
  return Math.floor(totalChars / 4);
}

/**
 * Returns the most recently observed prompt token count from event
 * usageMetadata, falling back to a character-based estimate.
 */
export function latestPromptTokenCount(
  events: Event[],
  agentName: string,
  currentBranch?: string,
): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const meta = events[i].usageMetadata;
    if (meta?.promptTokenCount != null) {
      return meta.promptTokenCount;
    }
  }
  return estimatePromptTokenCount(events, agentName, currentBranch);
}

// ---------------------------------------------------------------------------
// Compaction event helpers
// ---------------------------------------------------------------------------

type CompactionInfo = {
  index: number;
  startTimestamp: number;
  endTimestamp: number;
  event: Event;
};

function validCompactions(events: Event[]): CompactionInfo[] {
  const result: CompactionInfo[] = [];
  for (let i = 0; i < events.length; i++) {
    const compaction = events[i].actions?.compaction;
    if (
      !compaction ||
      compaction.startTimestamp == null ||
      compaction.endTimestamp == null ||
      !compaction.compactedContent
    ) {
      continue;
    }
    result.push({
      index: i,
      startTimestamp: compaction.startTimestamp,
      endTimestamp: compaction.endTimestamp,
      event: events[i],
    });
  }
  return result;
}

function isCompactionSubsumed(
  startTimestamp: number,
  endTimestamp: number,
  eventIndex: number,
  compactions: CompactionInfo[],
): boolean {
  for (const other of compactions) {
    if (other.index === eventIndex) continue;
    if (
      other.startTimestamp <= startTimestamp &&
      other.endTimestamp >= endTimestamp
    ) {
      if (
        other.startTimestamp < startTimestamp ||
        other.endTimestamp > endTimestamp ||
        other.index > eventIndex
      ) {
        return true;
      }
    }
  }
  return false;
}

function latestCompactionEvent(
  events: Event[],
  precomputed?: CompactionInfo[],
): Event | undefined {
  const compactions = precomputed ?? validCompactions(events);
  let latest: Event | undefined;
  let latestIndex = -1;
  for (const info of compactions) {
    if (
      isCompactionSubsumed(
        info.startTimestamp,
        info.endTimestamp,
        info.index,
        compactions,
      )
    ) {
      continue;
    }
    if (info.index > latestIndex) {
      latestIndex = info.index;
      latest = info.event;
    }
  }
  return latest;
}

function latestCompactionEndTimestamp(
  events: Event[],
  precomputed?: CompactionInfo[],
): number {
  const latest = latestCompactionEvent(events, precomputed);
  return latest?.actions?.compaction?.endTimestamp ?? 0;
}

// ---------------------------------------------------------------------------
// Event selection for token-threshold compaction
// ---------------------------------------------------------------------------

function eventFunctionCallIds(event: Event): Set<string> {
  const ids = new Set<string>();
  for (const fc of getFunctionCalls(event)) {
    if (fc.id) ids.add(fc.id);
  }
  return ids;
}

function eventFunctionResponseIds(event: Event): Set<string> {
  const ids = new Set<string>();
  for (const fr of getFunctionResponses(event)) {
    if (fr.id) ids.add(fr.id);
  }
  return ids;
}

/**
 * Returns a safe split index that avoids orphaning retained tool responses
 * from their function call events.
 */
export function safeTokenCompactionSplitIndex(
  candidateEvents: Event[],
  eventRetentionSize: number,
): number {
  const initialSplit = candidateEvents.length - eventRetentionSize;
  if (initialSplit <= 0) return 0;

  const unmatchedResponseIds = new Set<string>();
  let bestSplit = 0;

  for (let i = candidateEvents.length - 1; i >= 0; i--) {
    const event = candidateEvents[i];
    for (const id of eventFunctionResponseIds(event)) {
      unmatchedResponseIds.add(id);
    }
    for (const id of eventFunctionCallIds(event)) {
      unmatchedResponseIds.delete(id);
    }
    if (unmatchedResponseIds.size === 0 && i <= initialSplit) {
      bestSplit = i;
      break;
    }
  }

  return bestSplit;
}

/**
 * Collects events eligible for token-threshold compaction.
 * If a previous compaction exists, its summary is prepended as a seed so the
 * next summary supersedes it.
 */
export function eventsToCompactForTokenThreshold(
  events: Event[],
  eventRetentionSize: number,
  precomputed?: CompactionInfo[],
): Event[] {
  const latestCompaction = latestCompactionEvent(events, precomputed);
  const lastCompactedEnd =
    latestCompaction?.actions?.compaction?.endTimestamp ?? 0;

  const candidateEvents = events.filter(
    (e) => !e.actions?.compaction && e.timestamp > lastCompactedEnd,
  );

  if (candidateEvents.length <= eventRetentionSize) {
    return [];
  }

  let eventsToCompact: Event[];
  if (eventRetentionSize === 0) {
    eventsToCompact = candidateEvents;
  } else {
    const splitIndex = safeTokenCompactionSplitIndex(
      candidateEvents,
      eventRetentionSize,
    );
    eventsToCompact = candidateEvents.slice(0, splitIndex);
  }

  if (!eventsToCompact.length) return [];

  // Prepend previous compaction summary as a rolling seed
  if (
    latestCompaction?.actions?.compaction?.startTimestamp != null &&
    latestCompaction.actions.compaction.compactedContent
  ) {
    const seedEvent = createEvent({
      timestamp: latestCompaction.actions.compaction.startTimestamp,
      author: 'model',
      content: latestCompaction.actions.compaction.compactedContent,
      branch: latestCompaction.branch,
      invocationId: createNewEventId(),
    });
    return [seedEvent, ...eventsToCompact];
  }

  return eventsToCompact;
}

// ---------------------------------------------------------------------------
// Ensure summarizer
// ---------------------------------------------------------------------------

function getCompactionSummarizer(
  config: EventsCompactionConfig,
  llm?: BaseLlm,
): BaseEventsSummarizer {
  if (config.summarizer) return config.summarizer;
  if (!llm) {
    throw new Error('No LLM model available for event compaction summarizer.');
  }
  return new LlmEventSummarizer({llm});
}

// ---------------------------------------------------------------------------
// Token-threshold compaction runner
// ---------------------------------------------------------------------------

export async function runCompactionForTokenThreshold(params: {
  config: EventsCompactionConfig;
  session: Session;
  sessionService: BaseSessionService;
  llm?: BaseLlm;
  agentName: string;
  invocationId?: string;
  currentBranch?: string;
}): Promise<Event | undefined> {
  const {
    config,
    session,
    sessionService,
    llm,
    agentName,
    invocationId,
    currentBranch,
  } = params;

  if (!hasTokenThresholdConfig(config)) return undefined;

  const tokenCount = latestPromptTokenCount(
    session.events,
    agentName,
    currentBranch,
  );

  if (tokenCount == null || tokenCount < config.tokenThreshold!) {
    return undefined;
  }

  logger.debug(
    `Token count ${tokenCount} exceeds threshold ${config.tokenThreshold}, running compaction.`,
  );

  const cached = validCompactions(session.events);
  const events = eventsToCompactForTokenThreshold(
    session.events,
    config.eventRetentionSize!,
    cached,
  );

  if (!events.length) return undefined;

  const summarizer = getCompactionSummarizer(config, llm);
  const preCompactionLength = session.events.length;
  const startTime = Date.now();

  const compactionEvent = await summarizer.maybeSummarizeEvents({
    events,
  });

  if (compactionEvent) {
    if (session.events.length !== preCompactionLength) {
      logger.warn('Session modified during compaction, skipping.');
      return undefined;
    }

    if (invocationId) {
      compactionEvent.invocationId = invocationId;
    }
    await sessionService.appendEvent({session, event: compactionEvent});
    recordCompactionRun(
      'token_threshold',
      events.length,
      Date.now() - startTime,
    );
    logger.debug('Token-threshold event compaction finished.');
    return compactionEvent;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Sliding-window compaction runner
// ---------------------------------------------------------------------------

/**
 * Post-invocation sliding-window compaction.
 *
 * Counts new invocations since the last compaction. When the count reaches
 * `compactionInterval`, selects a window that extends `overlapSize` invocations
 * before the new block and summarises it. Token-threshold compaction is
 * attempted first when configured and not already handled by the flow
 * processor.
 */
export async function runCompactionForSlidingWindow(params: {
  config: EventsCompactionConfig | undefined;
  session: Session;
  sessionService: BaseSessionService;
  llm?: BaseLlm;
  skipTokenCompaction?: boolean;
  agentName?: string;
  currentBranch?: string;
}): Promise<Event | undefined> {
  const {
    config,
    session,
    sessionService,
    llm,
    skipTokenCompaction,
    agentName,
    currentBranch,
  } = params;
  const events = session.events;
  if (!events?.length || !config) return undefined;

  if (!skipTokenCompaction && hasTokenThresholdConfig(config)) {
    const tokenEvent = await runCompactionForTokenThreshold({
      config,
      session,
      sessionService,
      llm,
      agentName: agentName ?? '',
      currentBranch,
    });
    if (tokenEvent) return tokenEvent;
  }

  if (!hasSlidingWindowConfig(config)) return undefined;
  const {compactionInterval, overlapSize} = config;
  if (compactionInterval == null || overlapSize == null) return undefined;

  // --- last compaction end timestamp (cached for the pipeline) ---
  const cached = validCompactions(events);
  const lastCompactedEnd = latestCompactionEndTimestamp(events, cached);

  // --- latest timestamp per invocation (skip compaction events) ---
  const invocationLatest = new Map<string, number>();
  for (const event of events) {
    if (!event.invocationId || event.actions?.compaction) continue;
    invocationLatest.set(
      event.invocationId,
      Math.max(invocationLatest.get(event.invocationId) ?? 0, event.timestamp),
    );
  }

  const uniqueIds = [...invocationLatest.keys()];
  const newIds = uniqueIds.filter(
    (id) => (invocationLatest.get(id) ?? 0) > lastCompactedEnd,
  );

  if (newIds.length < compactionInterval) return undefined;

  // --- compute invocation range ---
  const endInvId = newIds[newIds.length - 1];
  const firstNewIdx = uniqueIds.indexOf(newIds[0]);
  const startIdx = Math.max(0, firstNewIdx - overlapSize);
  const startInvId = uniqueIds[startIdx];

  // --- locate event boundaries ---
  let lastEventIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].invocationId === endInvId) {
      lastEventIdx = i;
      break;
    }
  }
  if (lastEventIdx === -1) return undefined;

  let firstEventIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].invocationId === startInvId) {
      firstEventIdx = i;
      break;
    }
  }
  if (firstEventIdx === -1) return undefined;

  const eventsToCompact = events
    .slice(firstEventIdx, lastEventIdx + 1)
    .filter((e) => !e.actions?.compaction);

  if (!eventsToCompact.length) return undefined;

  const summarizer = getCompactionSummarizer(config, llm);
  const preCompactionLength = session.events.length;
  const startTime = Date.now();

  const compactionEvent = await summarizer.maybeSummarizeEvents({
    events: eventsToCompact,
  });

  if (compactionEvent) {
    if (session.events.length !== preCompactionLength) {
      logger.warn('Session modified during compaction, skipping.');
      return undefined;
    }

    await sessionService.appendEvent({session, event: compactionEvent});
    recordCompactionRun(
      'sliding_window',
      eventsToCompact.length,
      Date.now() - startTime,
    );
    logger.debug('Sliding-window event compaction finished.');
    return compactionEvent;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// processCompactionEvents — used by ContentRequestProcessor
// ---------------------------------------------------------------------------

/**
 * Processes events by applying compaction: replaces raw events that fall
 * within compaction ranges with their summary content.
 *
 * @param events A list of events that may include compaction events.
 * @returns A new list with compacted ranges replaced by summaries.
 */
export function processCompactionEvents(events: Event[]): Event[] {
  const compactions = validCompactions(events);

  if (compactions.length === 0) {
    return events;
  }

  // Identify subsumed compaction events
  const subsumedIndexes = new Set<number>();
  for (const info of compactions) {
    if (
      isCompactionSubsumed(
        info.startTimestamp,
        info.endTimestamp,
        info.index,
        compactions,
      )
    ) {
      subsumedIndexes.add(info.index);
    }
  }

  // Build compaction ranges and summary items
  const compactionRanges: Array<{start: number; end: number}> = [];
  const processedItems: Array<{
    timestamp: number;
    index: number;
    event: Event;
  }> = [];

  for (const info of compactions) {
    if (subsumedIndexes.has(info.index)) continue;
    const compaction = info.event.actions!.compaction!;

    compactionRanges.push({
      start: compaction.startTimestamp,
      end: compaction.endTimestamp,
    });

    processedItems.push({
      timestamp: compaction.endTimestamp,
      index: info.index,
      event: createEvent({
        timestamp: compaction.endTimestamp,
        author: 'model',
        content: compaction.compactedContent,
        branch: info.event.branch,
        invocationId: info.event.invocationId,
        actions: info.event.actions,
      }),
    });
  }

  compactionRanges.sort((a, b) => a.start - b.start);

  function isTimestampCompacted(ts: number): boolean {
    let lo = 0;
    let hi = compactionRanges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ts < compactionRanges[mid].start) hi = mid - 1;
      else if (ts > compactionRanges[mid].end) lo = mid + 1;
      else return true;
    }
    return false;
  }

  // Add non-compacted, non-compaction events
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.actions?.compaction) continue;
    if (isTimestampCompacted(event.timestamp)) continue;
    processedItems.push({timestamp: event.timestamp, index: i, event});
  }

  // Sort by timestamp then original index for stability
  processedItems.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);

  return processedItems.map((item) => item.event);
}
