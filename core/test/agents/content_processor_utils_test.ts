/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {
  getContents,
  isAdkFrameworkEvent,
  isEventContentEmpty,
} from '../../src/agents/content_processor_utils.js';
import {createEvent, Event} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textEvent(
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

// ---------------------------------------------------------------------------
// isEventContentEmpty — basic
// ---------------------------------------------------------------------------

describe('isEventContentEmpty', () => {
  it('returns true for event with no content', () => {
    const event = createEvent({author: 'user'});
    expect(isEventContentEmpty(event)).toBe(true);
  });

  it('returns true for event with no role', () => {
    const event = createEvent({content: {role: '', parts: [{text: 'hi'}]}});
    expect(isEventContentEmpty(event)).toBe(true);
  });

  it('returns true for event with empty parts', () => {
    const event = createEvent({content: {role: 'user', parts: []}});
    expect(isEventContentEmpty(event)).toBe(true);
  });

  it('returns true when all parts are empty text', () => {
    const event = createEvent({content: {role: 'user', parts: [{text: ''}]}});
    expect(isEventContentEmpty(event)).toBe(true);
  });

  it('returns false when event has text content', () => {
    const event = createEvent({
      content: {role: 'user', parts: [{text: 'hello'}]},
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns false when event has functionCall', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'tool', args: {}}}],
      },
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns false when event has functionResponse', () => {
    const event = createEvent({
      content: {
        role: 'user',
        parts: [{functionResponse: {name: 'tool', response: {result: 'ok'}}}],
      },
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns false for empty text part followed by functionCall', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [{text: ''}, {functionCall: {name: 'tool', args: {}}}],
      },
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns false for inlineData', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [{inlineData: {mimeType: 'image/png', data: 'abc'}}],
      },
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns false for executableCode', () => {
    const event = createEvent({
      content: {role: 'model', parts: [{executableCode: {code: 'print(1)'}}]},
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns false for codeExecutionResult', () => {
    const event = createEvent({
      content: {role: 'model', parts: [{codeExecutionResult: {output: '1'}}]},
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns false for fileData', () => {
    const event = createEvent({
      content: {
        role: 'user',
        parts: [
          {fileData: {fileUri: 'gs://bucket/file', mimeType: 'text/plain'}},
        ],
      },
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns true when all parts have only empty text', () => {
    const event = createEvent({
      content: {role: 'user', parts: [{text: ''}, {text: ''}, {text: ''}]},
    });
    expect(isEventContentEmpty(event)).toBe(true);
  });

  it('returns false when one of many empty parts has visible content', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [
          {text: ''},
          {text: ''},
          {functionCall: {name: 'tool', args: {}}},
        ],
      },
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns true for undefined parts', () => {
    const event = createEvent({content: {role: 'user'}});
    expect(isEventContentEmpty(event)).toBe(true);
  });

  it('returns true when all parts are thought-only text', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [{text: 'internal reasoning', thought: true}],
      },
    });
    expect(isEventContentEmpty(event)).toBe(true);
  });

  it('returns false when thought part is accompanied by visible text', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [{text: 'thinking...', thought: true}, {text: 'visible answer'}],
      },
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns false for functionCall even if marked as thought', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'tool', args: {}}, thought: true} as Part & {
            thought: boolean;
          },
        ],
      },
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });

  it('returns false for functionResponse even if marked as thought', () => {
    const event = createEvent({
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {name: 'tool', response: {}},
            thought: true,
          } as Part & {thought: boolean},
        ],
      },
    });
    expect(isEventContentEmpty(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getContents — isEventContentEmpty integration
// ---------------------------------------------------------------------------

describe('getContents pre-filter integration', () => {
  it('preserves function-call-only events', () => {
    const event = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'search', args: {q: 'test'}}}],
      },
    });
    const contents = getContents([event], 'model');
    expect(contents).toHaveLength(1);
    expect(contents[0].parts?.[0]?.functionCall?.name).toBe('search');
  });

  it('preserves function-response-only events', () => {
    const fcEvent = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc-1', name: 'tool', args: {}}}],
      },
    });
    const frEvent = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {id: 'fc-1', name: 'tool', response: {ok: true}}},
        ],
      },
    });
    const contents = getContents([fcEvent, frEvent], 'model');
    expect(contents).toHaveLength(2);
  });

  it('drops events where all parts are empty text', () => {
    const events = [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: ''}, {text: ''}]},
      }),
      textEvent('user', 'real message', 200),
    ];
    const contents = getContents(events, 'agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].parts?.[0]?.text).toBe('real message');
  });

  it('preserves executableCode events in context', () => {
    const event = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [{executableCode: {code: 'x = 1'}}],
      },
    });
    const contents = getContents([event], 'model');
    expect(contents).toHaveLength(1);
  });

  it('drops thought-only events from context', () => {
    const events = [
      textEvent('user', 'hello', 100),
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{text: 'let me think...', thought: true}],
        },
        timestamp: 200,
      }),
      textEvent('model', 'visible reply', 300),
    ];
    const contents = getContents(events, 'model');
    expect(contents).toHaveLength(2);
    expect(contents[0].parts?.[0]?.text).toBe('hello');
    expect(contents[1].parts?.[0]?.text).toBe('visible reply');
  });

  it('mixed conversation with tool calls is fully preserved', () => {
    const events = [
      textEvent('user', 'find weather', 100),
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {text: ''},
            {functionCall: {id: 'fc-1', name: 'weather', args: {city: 'NYC'}}},
          ],
        },
        timestamp: 200,
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'fc-1',
                name: 'weather',
                response: {temp: 72},
              },
            },
          ],
        },
        timestamp: 300,
      }),
      textEvent('model', 'It is 72 degrees in NYC', 400),
    ];
    const contents = getContents(events, 'model');
    expect(contents).toHaveLength(4);
  });
});

describe('getContents', () => {
  it('should not drop events with empty text followed by functionCall', () => {
    const event = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [{text: ''}, {functionCall: {name: 'myTool', args: {}}}],
      },
    });
    const contents = getContents([event], 'agent');
    expect(contents.length).toBe(1);
  });

  it('should handle object responses in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionResponse: {
              name: 'transfer_to_agent',
              response: {
                result: 'success',
                details: {
                  foo: 'bar',
                },
              },
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    // We expect the content to contain a string representation of the object, not [object Object]
    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('transfer_to_agent'),
    );
    expect(textPart).toBeDefined();
    expect(textPart?.text).not.toContain('[object Object]');
    expect(textPart?.text).toContain('{"result":"success"');
  });

  it('should handle object parameters in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'transfer_to_agent',
              args: {
                target_agent: 'foo',
                reason: 'bar',
              },
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('transfer_to_agent'),
    );
    expect(textPart).toBeDefined();
    expect(textPart?.text).not.toContain('[object Object]');
    expect(textPart?.text).toContain('{"target_agent":"foo"');
  });

  it('should handle circular objects in convertForeignEvent', () => {
    const circular: Record<string, unknown> = {a: 1};
    circular.self = circular;

    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'circular_tool',
              args: circular,
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('circular_tool'),
    );
    expect(textPart).toBeDefined();
    // It should fall back to String(obj) which is usually [object Object] for plain objects.
    expect(textPart?.text).toContain('[object Object]');
  });
});

// ---------------------------------------------------------------------------
// isAdkFrameworkEvent
// ---------------------------------------------------------------------------

describe('isAdkFrameworkEvent', () => {
  it('returns false for event with no content', () => {
    expect(isAdkFrameworkEvent(createEvent({author: 'user'}))).toBe(false);
  });

  it('returns false for event with empty parts', () => {
    expect(
      isAdkFrameworkEvent(createEvent({content: {role: 'model', parts: []}})),
    ).toBe(false);
  });

  it('returns true for event where all parts are adk_ function calls', () => {
    const event = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'adk_request_credential', args: {}}},
          {functionCall: {name: 'adk_request_confirmation', args: {}}},
        ],
      },
    });
    expect(isAdkFrameworkEvent(event)).toBe(true);
  });

  it('returns true for event where all parts are adk_ function responses', () => {
    const event = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{functionResponse: {name: 'adk_request_input', response: {}}}],
      },
    });
    expect(isAdkFrameworkEvent(event)).toBe(true);
  });

  it('returns false for mixed adk_ and regular content', () => {
    const event = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [
          {text: 'some text'},
          {functionCall: {name: 'adk_request_credential', args: {}}},
        ],
      },
    });
    expect(isAdkFrameworkEvent(event)).toBe(false);
  });

  it('returns false for non-adk function calls', () => {
    const event = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'search_tool', args: {}}}],
      },
    });
    expect(isAdkFrameworkEvent(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getContents — ADK framework event filter
// ---------------------------------------------------------------------------

describe('getContents ADK framework filter', () => {
  it('filters out pure adk_ framework events', () => {
    const events = [
      textEvent('user', 'hello', 100),
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'adk_custom_internal', args: {}}}],
        },
        timestamp: 200,
      }),
      textEvent('model', 'world', 300),
    ];
    const contents = getContents(events, 'model');
    expect(contents).toHaveLength(2);
    expect(contents[0].parts?.[0]?.text).toBe('hello');
    expect(contents[1].parts?.[0]?.text).toBe('world');
  });
});

// ---------------------------------------------------------------------------
// getContents — request input event filter
// ---------------------------------------------------------------------------

describe('getContents request input filter', () => {
  it('filters out request input events', () => {
    const events = [
      textEvent('user', 'start', 100),
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'adk_request_input', args: {}}}],
        },
        timestamp: 200,
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'adk_request_input',
                response: {text: 'input'},
              },
            },
          ],
        },
        timestamp: 300,
      }),
      textEvent('model', 'done', 400),
    ];
    const contents = getContents(events, 'model');
    expect(contents).toHaveLength(2);
    expect(contents[0].parts?.[0]?.text).toBe('start');
    expect(contents[1].parts?.[0]?.text).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// getContents — rewind
// ---------------------------------------------------------------------------

describe('getContents rewind', () => {
  it('removes events from rewind target invocation onward', () => {
    const events = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      textEvent('user', 'c', 300, {invocationId: 'inv-2'}),
      textEvent('model', 'd', 400, {invocationId: 'inv-2'}),
      createEvent({
        author: 'user',
        timestamp: 450,
        actions: createEventActions({rewindBeforeInvocationId: 'inv-2'}),
        content: {role: 'user', parts: [{text: 'rewind'}]},
      }),
      textEvent('user', 'e', 500, {invocationId: 'inv-3'}),
      textEvent('model', 'f', 600, {invocationId: 'inv-3'}),
    ];
    const contents = getContents(events, 'model');
    const texts = contents.map((c) => c.parts?.[0]?.text);
    expect(texts).toContain('a');
    expect(texts).toContain('b');
    expect(texts).not.toContain('c');
    expect(texts).not.toContain('d');
  });

  it('keeps all events when rewind target not found', () => {
    const events = [
      textEvent('user', 'a', 100, {invocationId: 'inv-1'}),
      textEvent('model', 'b', 200, {invocationId: 'inv-1'}),
      createEvent({
        author: 'user',
        timestamp: 300,
        actions: createEventActions({
          rewindBeforeInvocationId: 'inv-nonexistent',
        }),
        content: {role: 'user', parts: [{text: 'rewind'}]},
      }),
    ];
    const contents = getContents(events, 'model');
    expect(contents.length).toBeGreaterThanOrEqual(2);
  });

  it('does nothing when no rewind action exists', () => {
    const events = [textEvent('user', 'a', 100), textEvent('model', 'b', 200)];
    const contents = getContents(events, 'model');
    expect(contents).toHaveLength(2);
  });
});
