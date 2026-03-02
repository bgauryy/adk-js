/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {createEvent, createNewEventId, Event} from '../events/event.js';
import {createEventActions, EventCompaction} from '../events/event_actions.js';
import {BaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';
import {logger} from '../utils/logger.js';

import {BaseEventsSummarizer} from './base_events_summarizer.js';

const DEFAULT_PROMPT_TEMPLATE =
  'You are summarizing a conversation for context-window compaction.' +
  ' Your output will be injected as context into future LLM calls,' +
  ' so preserve all factual details: names, IDs, numbers, decisions,' +
  ' tool results, and unresolved tasks. Retain enough specificity that' +
  ' a reader could continue the conversation without losing information.' +
  '\n\n{conversationHistory}';

const CHUNK_MERGE_PROMPT_TEMPLATE =
  'The following are summaries of consecutive conversation segments.' +
  ' Please combine them into a single coherent summary that preserves' +
  ' key information, decisions, and unresolved items.\n\n{chunkSummaries}';

const DEFAULT_MAX_PROMPT_CHARS = 500_000;

/**
 * An LLM-based event summarizer for event compaction.
 *
 * Summarizes a list of events into a single compacted event using the
 * provided LLM. The resulting event carries an `EventCompaction` action
 * that records the timestamp range and summary content.
 */
export class LlmEventSummarizer extends BaseEventsSummarizer {
  private readonly llm: BaseLlm;
  private readonly promptTemplate: string;
  private readonly maxPromptChars: number;

  constructor(params: {
    llm: BaseLlm;
    promptTemplate?: string;
    maxPromptChars?: number;
  }) {
    super();
    this.llm = params.llm;
    this.promptTemplate = params.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;
    this.maxPromptChars = params.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  }

  private formatEventsForPrompt(events: Event[]): string {
    const lines: string[] = [];
    let lastInvocationId: string | undefined;

    for (const event of events) {
      if (!event.content?.parts) continue;

      if (event.invocationId && event.invocationId !== lastInvocationId) {
        if (lastInvocationId !== undefined) {
          lines.push('--- turn ---');
        }
        lastInvocationId = event.invocationId;
      }

      const isSeedSummary = !!event.actions?.compaction?.compactedContent;
      const author = event.author ?? 'unknown';
      const ts = this.formatTimestamp(event.timestamp);

      if (isSeedSummary) {
        lines.push(`[Previous summary as of ${ts}]:`);
      }

      for (const part of event.content.parts) {
        const prefix = isSeedSummary ? '' : `[${ts}] ${author}: `;
        if (part.text) {
          lines.push(`${prefix}${part.text}`);
        } else if (part.functionCall) {
          const args = JSON.stringify(part.functionCall.args ?? {});
          lines.push(
            `${prefix}[Called tool "${part.functionCall.name}" with args: ${args}]`,
          );
        } else if (part.functionResponse) {
          const resp = JSON.stringify(part.functionResponse.response ?? {});
          lines.push(
            `${prefix}[Tool "${part.functionResponse.name}" returned: ${resp}]`,
          );
        } else if (part.executableCode) {
          lines.push(`${prefix}[Executed code: ${part.executableCode.code}]`);
        } else if (part.codeExecutionResult) {
          lines.push(
            `${prefix}[Code output: ${part.codeExecutionResult.output}]`,
          );
        } else if (part.inlineData) {
          lines.push(
            `${prefix}[Attached ${part.inlineData.mimeType ?? 'data'} (inline)]`,
          );
        } else if (part.fileData) {
          lines.push(
            `${prefix}[Attached file: ${part.fileData.fileUri ?? 'unknown'}]`,
          );
        }
      }
    }
    return lines.join('\n');
  }

  private formatTimestamp(ts: number): string {
    if (!ts || ts <= 0) return 'unknown';
    try {
      return new Date(ts).toISOString();
    } catch {
      return String(ts);
    }
  }

  private splitIntoChunks(events: Event[]): Event[][] {
    const chunks: Event[][] = [];
    let currentChunk: Event[] = [];
    let currentLen = 0;

    for (const event of events) {
      const eventText = this.formatEventsForPrompt([event]);
      const eventLen = eventText.length;

      if (currentLen + eventLen > this.maxPromptChars && currentChunk.length) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentLen = 0;
      }
      currentChunk.push(event);
      currentLen += eventLen;
    }
    if (currentChunk.length) {
      chunks.push(currentChunk);
    }
    return chunks;
  }

  private async callLlm(prompt: string): Promise<Content | undefined> {
    const llmRequest: LlmRequest = {
      model: this.llm.model,
      contents: [{role: 'user', parts: [{text: prompt}]}],
      toolsDict: {},
      liveConnectConfig: {},
    };

    try {
      for await (const llmResponse of this.llm.generateContentAsync(
        llmRequest,
        false,
      )) {
        if (llmResponse.content) {
          return llmResponse.content;
        }
      }
    } catch (error: unknown) {
      logger.warn(
        `Event compaction summarizer failed: ${error instanceof Error ? error.message : String(error)}. Skipping compaction.`,
      );
    }
    return undefined;
  }

  override async maybeSummarizeEvents(params: {
    events: Event[];
  }): Promise<Event | undefined> {
    const {events} = params;
    if (!events.length) {
      return undefined;
    }

    const conversationHistory = this.formatEventsForPrompt(events);

    let summaryContent: Content | undefined;

    if (conversationHistory.length <= this.maxPromptChars) {
      const prompt = this.promptTemplate.replace(
        '{conversationHistory}',
        conversationHistory,
      );
      summaryContent = await this.callLlm(prompt);
    } else {
      summaryContent = await this.chunkedSummarize(events);
    }

    if (!summaryContent) {
      return undefined;
    }

    summaryContent.role = 'model';

    const startTimestamp = events[0].timestamp;
    const endTimestamp = events[events.length - 1].timestamp;

    const compaction: EventCompaction = {
      startTimestamp,
      endTimestamp,
      compactedContent: summaryContent,
    };

    return createEvent({
      author: 'user',
      invocationId: createNewEventId(),
      actions: createEventActions({compaction}),
    });
  }

  private async chunkedSummarize(
    events: Event[],
  ): Promise<Content | undefined> {
    const chunks = this.splitIntoChunks(events);
    const chunkSummaries: string[] = [];

    for (const chunk of chunks) {
      const history = this.formatEventsForPrompt(chunk);
      const prompt = this.promptTemplate.replace(
        '{conversationHistory}',
        history,
      );
      const content = await this.callLlm(prompt);
      const text = content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join('\n');
      if (text) {
        chunkSummaries.push(text);
      }
    }

    if (!chunkSummaries.length) return undefined;

    if (chunkSummaries.length === 1) {
      return {role: 'model', parts: [{text: chunkSummaries[0]}]};
    }

    const mergePrompt = CHUNK_MERGE_PROMPT_TEMPLATE.replace(
      '{chunkSummaries}',
      chunkSummaries
        .map((s, i) => `--- Segment ${i + 1} ---\n${s}`)
        .join('\n\n'),
    );
    return this.callLlm(mergePrompt);
  }
}
