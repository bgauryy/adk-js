/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {BaseEventsSummarizer} from '../../src/agents/base_events_summarizer.js';
import {createEvent, Event} from '../../src/events/event.js';
import {
  createEventActions,
  EventCompaction,
} from '../../src/events/event_actions.js';
import {BaseSessionService} from '../../src/sessions/base_session_service.js';
import {Session} from '../../src/sessions/session.js';

export function textEvent(
  author: string,
  text: string,
  timestamp: number,
  extra?: Partial<Event>,
): Event {
  return createEvent({
    author,
    content: {role: author === 'user' ? 'user' : 'model', parts: [{text}]},
    timestamp,
    ...extra,
  });
}

export function functionCallEvent(
  callId: string,
  name: string,
  timestamp: number,
  extra?: Partial<Event>,
): Event {
  return createEvent({
    author: 'model',
    content: {
      role: 'model',
      parts: [{functionCall: {id: callId, name, args: {}}}],
    },
    timestamp,
    ...extra,
  });
}

export function functionResponseEvent(
  callId: string,
  name: string,
  timestamp: number,
  extra?: Partial<Event>,
): Event {
  return createEvent({
    author: 'user',
    content: {
      role: 'user',
      parts: [{functionResponse: {id: callId, name, response: {result: 'ok'}}}],
    },
    timestamp,
    ...extra,
  });
}

export function compactionEvent(
  startTs: number,
  endTs: number,
  summaryText: string,
  timestamp: number,
  extra?: Partial<Event>,
): Event {
  const compactedContent: Content = {
    role: 'model',
    parts: [{text: summaryText}],
  };
  const compaction: EventCompaction = {
    startTimestamp: startTs,
    endTimestamp: endTs,
    compactedContent,
  };
  return createEvent({
    author: 'user',
    timestamp,
    actions: createEventActions({compaction}),
    ...extra,
  });
}

export class FakeSummarizer extends BaseEventsSummarizer {
  calls: Event[][] = [];
  returnEvent: Event | undefined;

  constructor(summaryText: string = 'summary') {
    super();
    this.returnEvent = createEvent({
      author: 'user',
      timestamp: Date.now(),
      actions: createEventActions({
        compaction: {
          startTimestamp: 0,
          endTimestamp: 0,
          compactedContent: {role: 'model', parts: [{text: summaryText}]},
        },
      }),
    });
  }

  override async maybeSummarizeEvents(params: {
    events: Event[];
  }): Promise<Event | undefined> {
    this.calls.push(params.events);
    if (!this.returnEvent) return undefined;
    const first = params.events[0];
    const last = params.events[params.events.length - 1];
    return createEvent({
      ...this.returnEvent,
      actions: createEventActions({
        compaction: {
          ...this.returnEvent.actions.compaction!,
          startTimestamp: first.timestamp,
          endTimestamp: last.timestamp,
        },
      }),
    });
  }
}

export function fakeSession(events: Event[]): Session {
  return {
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    events,
    state: {},
    lastUpdateTime: Date.now(),
  };
}

export function fakeSessionService(): {
  service: BaseSessionService;
  appendedEvents: Event[];
} {
  const appendedEvents: Event[] = [];
  const service = {
    appendEvent: async ({event}: {session: Session; event: Event}) => {
      appendedEvents.push(event);
      return event;
    },
  } as unknown as BaseSessionService;
  return {service, appendedEvents};
}
