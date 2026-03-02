/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Outcome} from '@google/genai';

import {LlmEventSummarizer} from '../../src/agents/llm_event_summarizer.js';
import {createEvent, Event} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';

// ---------------------------------------------------------------------------
// Fake LLM
// ---------------------------------------------------------------------------

class FakeLlm extends BaseLlm {
  lastRequest?: LlmRequest;
  responseText: string;
  shouldReturnEmpty = false;

  constructor(responseText: string = 'This is a summary.') {
    super({model: 'fake-model'});
    this.responseText = responseText;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream: boolean,
  ): AsyncGenerator<LlmResponse> {
    this.lastRequest = llmRequest;
    if (this.shouldReturnEmpty) {
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [{text: this.responseText}],
      },
    };
  }

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

function textEvent(author: string, text: string, timestamp: number): Event {
  return createEvent({
    author,
    content: {role: author === 'user' ? 'user' : 'model', parts: [{text}]},
    timestamp,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LlmEventSummarizer', () => {
  it('returns undefined for empty events', async () => {
    const llm = new FakeLlm();
    const summarizer = new LlmEventSummarizer({llm});
    const result = await summarizer.maybeSummarizeEvents({events: []});
    expect(result).toBeUndefined();
  });

  it('calls LLM with formatted conversation history', async () => {
    const llm = new FakeLlm('A conversation summary.');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      textEvent('user', 'What is the weather?', 100),
      textEvent('model', 'It is sunny today.', 200),
    ];

    await summarizer.maybeSummarizeEvents({events});

    expect(llm.lastRequest).toBeDefined();
    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('user: What is the weather?');
    expect(promptText).toContain('model: It is sunny today.');
  });

  it('returns compaction event with correct timestamp range', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      textEvent('user', 'a', 100),
      textEvent('model', 'b', 200),
      textEvent('user', 'c', 300),
    ];

    const result = await summarizer.maybeSummarizeEvents({events});

    expect(result).toBeDefined();
    expect(result!.actions.compaction).toBeDefined();
    expect(result!.actions.compaction!.startTimestamp).toBe(100);
    expect(result!.actions.compaction!.endTimestamp).toBe(300);
    expect(result!.actions.compaction!.compactedContent.role).toBe('model');
    expect(result!.actions.compaction!.compactedContent.parts?.[0]?.text).toBe(
      'Summary',
    );
  });

  it('returns undefined when LLM returns empty', async () => {
    const llm = new FakeLlm();
    llm.shouldReturnEmpty = true;
    const summarizer = new LlmEventSummarizer({llm});

    const events = [textEvent('user', 'test', 100)];
    const result = await summarizer.maybeSummarizeEvents({events});
    expect(result).toBeUndefined();
  });

  it('uses custom prompt template', async () => {
    const llm = new FakeLlm('Custom summary');
    const summarizer = new LlmEventSummarizer({
      llm,
      promptTemplate: 'CUSTOM: {conversationHistory}',
    });

    const events = [textEvent('user', 'hello', 100)];
    await summarizer.maybeSummarizeEvents({events});

    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toMatch(/CUSTOM: \[.*\] user: hello/);
  });

  it('includes functionCall context in prompt', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'search', args: {q: 'weather'}}}],
        },
        timestamp: 100,
      }),
      textEvent('user', 'thanks', 200),
    ];

    await summarizer.maybeSummarizeEvents({events});
    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('search');
    expect(promptText).toContain('weather');
  });

  it('includes functionResponse context in prompt', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {name: 'search', response: {temp: '72F'}}},
          ],
        },
        timestamp: 100,
      }),
    ];

    await summarizer.maybeSummarizeEvents({events});
    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('search');
    expect(promptText).toContain('72F');
  });

  it('handles events with no text content gracefully', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const noTextEvent = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'tool', args: {}}}],
      },
      timestamp: 100,
    });
    const events = [noTextEvent, textEvent('user', 'hello', 200)];

    const result = await summarizer.maybeSummarizeEvents({events});
    expect(result).toBeDefined();

    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('user: hello');
    expect(promptText).not.toContain('undefined');
  });

  it('handles events with no author', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const noAuthorEvent = createEvent({
      content: {role: 'user', parts: [{text: 'anonymous'}]},
      timestamp: 100,
    });
    const events = [noAuthorEvent];

    await summarizer.maybeSummarizeEvents({events});

    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('unknown: anonymous');
  });
});

// ---------------------------------------------------------------------------
// formatEventsForPrompt — tool context advanced
// ---------------------------------------------------------------------------

describe('LlmEventSummarizer tool context formatting', () => {
  it('formats mixed text and functionCall in same conversation', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      textEvent('user', 'What is 2+2?', 100),
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'calculator', args: {expr: '2+2'}}}],
        },
        timestamp: 200,
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {name: 'calculator', response: {result: 4}}},
          ],
        },
        timestamp: 300,
      }),
      textEvent('model', 'The answer is 4.', 400),
    ];

    await summarizer.maybeSummarizeEvents({events});
    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';

    expect(promptText).toContain('user: What is 2+2?');
    expect(promptText).toContain('[Called tool "calculator"');
    expect(promptText).toContain('"expr":"2+2"');
    expect(promptText).toContain('[Tool "calculator" returned:');
    expect(promptText).toContain('"result":4');
    expect(promptText).toContain('model: The answer is 4.');
  });

  it('handles functionCall with empty args', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'get_time', args: {}}}],
        },
        timestamp: 100,
      }),
    ];

    await summarizer.maybeSummarizeEvents({events});
    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('[Called tool "get_time" with args: {}]');
  });

  it('handles functionCall with undefined args', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'ping'}}],
        },
        timestamp: 100,
      }),
    ];

    await summarizer.maybeSummarizeEvents({events});
    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('[Called tool "ping" with args: {}]');
  });

  it('handles functionResponse with undefined response', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [{functionResponse: {name: 'ping'}}],
        },
        timestamp: 100,
      }),
    ];

    await summarizer.maybeSummarizeEvents({events});
    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('[Tool "ping" returned: {}]');
  });

  it('prefers text over functionCall when part has both', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {text: 'I will search', functionCall: {name: 'search', args: {}}},
          ],
        },
        timestamp: 100,
      }),
    ];

    await summarizer.maybeSummarizeEvents({events});
    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('model: I will search');
    expect(promptText).not.toContain('[Called tool');
  });

  it('formats multiple parallel tool calls in same event', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'tool_a', args: {x: 1}}},
            {functionCall: {name: 'tool_b', args: {y: 2}}},
          ],
        },
        timestamp: 100,
      }),
    ];

    await summarizer.maybeSummarizeEvents({events});
    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('[Called tool "tool_a"');
    expect(promptText).toContain('[Called tool "tool_b"');
  });

  it('skips events with no content parts', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({author: 'user', timestamp: 100}),
      textEvent('user', 'real message', 200),
    ];

    await summarizer.maybeSummarizeEvents({events});
    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('user: real message');
    expect(promptText).not.toContain('unknown:');
  });
});

// ---------------------------------------------------------------------------
// Prompt quality: LLM gets system context + rich data
// ---------------------------------------------------------------------------

describe('LlmEventSummarizer prompt quality', () => {
  it('prompt tells the LLM this is for context-window compaction', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [textEvent('user', 'hello', 100)];
    await summarizer.maybeSummarizeEvents({events});

    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText.toLowerCase()).toContain('context');
    expect(promptText.toLowerCase()).toMatch(/preserv|retain|maintain/);
  });

  it('includes timestamps in formatted conversation', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      textEvent('user', 'hello', 1709136000000),
      textEvent('model', 'hi', 1709136060000),
    ];
    await summarizer.maybeSummarizeEvents({events});

    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toMatch(/\d{4}[-/]\d{2}/);
  });

  it('marks invocation boundaries in formatted output', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'q1'}]},
        timestamp: 100,
        invocationId: 'inv-1',
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'a1'}]},
        timestamp: 200,
        invocationId: 'inv-1',
      }),
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'q2'}]},
        timestamp: 300,
        invocationId: 'inv-2',
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'a2'}]},
        timestamp: 400,
        invocationId: 'inv-2',
      }),
    ];
    await summarizer.maybeSummarizeEvents({events});

    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toMatch(/turn|invocation|---/i);
  });

  it('marks seed (previous summary) distinctly from regular messages', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const seedEvent = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [{text: 'Previous summary of conversation'}],
      },
      timestamp: 100,
      actions: createEventActions({
        compaction: {
          startTimestamp: 0,
          endTimestamp: 99,
          compactedContent: {
            role: 'model',
            parts: [{text: 'Previous summary of conversation'}],
          },
        },
      }),
    });

    const events = [
      seedEvent,
      textEvent('user', 'new question', 200),
      textEvent('model', 'new answer', 300),
    ];

    await summarizer.maybeSummarizeEvents({events});

    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toMatch(
      /previous summary|prior summary|existing summary/i,
    );
  });

  it('represents inlineData events in the prompt', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [{inlineData: {mimeType: 'image/png', data: 'abc123'}}],
        },
        timestamp: 100,
      }),
      textEvent('model', 'I see the image', 200),
    ];
    await summarizer.maybeSummarizeEvents({events});

    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toMatch(/image|inline.*data|attachment/i);
  });

  it('represents executableCode events in the prompt', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{executableCode: {code: 'print(42)'}}],
        },
        timestamp: 100,
      }),
    ];
    await summarizer.maybeSummarizeEvents({events});

    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('print(42)');
  });

  it('represents codeExecutionResult events in the prompt', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {codeExecutionResult: {output: '42', outcome: Outcome.OUTCOME_OK}},
          ],
        },
        timestamp: 100,
      }),
    ];
    await summarizer.maybeSummarizeEvents({events});

    const promptText = llm.lastRequest!.contents[0].parts?.[0]?.text ?? '';
    expect(promptText).toContain('42');
  });
});

// ---------------------------------------------------------------------------
// Chunked summarization
// ---------------------------------------------------------------------------

describe('LlmEventSummarizer chunked summarization', () => {
  it('uses single-pass when prompt fits within maxPromptChars', async () => {
    const llm = new FakeLlm('Short summary');
    const summarizer = new LlmEventSummarizer({llm, maxPromptChars: 100_000});

    const events = [textEvent('user', 'hello', 100)];
    const result = await summarizer.maybeSummarizeEvents({events});

    expect(result).toBeDefined();
    expect(llm.lastRequest).toBeDefined();
    expect(result!.actions.compaction!.compactedContent.parts?.[0]?.text).toBe(
      'Short summary',
    );
  });

  it('uses chunked summarization when prompt exceeds maxPromptChars', async () => {
    const callTexts: string[] = [];
    const llm = new FakeLlm('Chunk summary');
    const origGen = llm.generateContentAsync.bind(llm);
    llm.generateContentAsync = async function* (req, stream) {
      const text = req.contents?.[0]?.parts?.[0]?.text ?? '';
      callTexts.push(text);
      yield* origGen(req, stream);
    };

    const summarizer = new LlmEventSummarizer({llm, maxPromptChars: 50});

    const events = [
      textEvent('user', 'a'.repeat(40), 100),
      textEvent('model', 'b'.repeat(40), 200),
      textEvent('user', 'c'.repeat(40), 300),
    ];

    const result = await summarizer.maybeSummarizeEvents({events});

    expect(result).toBeDefined();
    expect(callTexts.length).toBeGreaterThan(1);
  });

  it('returns undefined when all chunks fail', async () => {
    const llm = new FakeLlm('');
    llm.shouldReturnEmpty = true;
    const summarizer = new LlmEventSummarizer({llm, maxPromptChars: 10});

    const events = [
      textEvent('user', 'a'.repeat(20), 100),
      textEvent('model', 'b'.repeat(20), 200),
    ];

    const result = await summarizer.maybeSummarizeEvents({events});
    expect(result).toBeUndefined();
  });

  it('preserves timestamp range across chunks', async () => {
    const llm = new FakeLlm('Merged summary');
    const summarizer = new LlmEventSummarizer({llm, maxPromptChars: 50});

    const events = [
      textEvent('user', 'a'.repeat(40), 100),
      textEvent('model', 'b'.repeat(40), 500),
    ];

    const result = await summarizer.maybeSummarizeEvents({events});
    expect(result).toBeDefined();
    expect(result!.actions.compaction!.startTimestamp).toBe(100);
    expect(result!.actions.compaction!.endTimestamp).toBe(500);
  });

  it('defaults to 500K maxPromptChars', async () => {
    const llm = new FakeLlm('Summary');
    const summarizer = new LlmEventSummarizer({llm});

    const events = [textEvent('user', 'a'.repeat(1000), 100)];
    const result = await summarizer.maybeSummarizeEvents({events});

    expect(result).toBeDefined();
  });
});
