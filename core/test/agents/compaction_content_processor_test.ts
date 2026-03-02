/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getContents} from '../../src/agents/content_processor_utils.js';
import {createEvent} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';

import {compactionEvent, textEvent} from './compaction_test_helpers.js';

// ---------------------------------------------------------------------------
// Tests: getContents with compaction
// ---------------------------------------------------------------------------

describe('getContents with compaction events', () => {
  it('returns normal contents when no compaction events exist', () => {
    const events = [
      textEvent('user', 'hello', 100),
      textEvent('agent', 'hi', 200),
    ];
    const contents = getContents(events, 'agent');
    expect(contents).toHaveLength(2);
    expect(contents[0].parts?.[0]?.text).toBe('hello');
    expect(contents[1].parts?.[0]?.text).toBe('hi');
  });

  it('replaces compacted events with summary content', () => {
    const events = [
      textEvent('user', 'old message 1', 100),
      textEvent('agent', 'old response 1', 200),
      compactionEvent(100, 200, 'Summary of old conversation', 250),
      textEvent('user', 'new message', 300),
      textEvent('agent', 'new response', 400),
    ];

    const contents = getContents(events, 'agent');

    expect(contents.length).toBe(3);
    expect(contents[0].parts?.[0]?.text).toBe('Summary of old conversation');
    expect(contents[1].parts?.[0]?.text).toBe('new message');
    expect(contents[2].parts?.[0]?.text).toBe('new response');
  });

  it('handles multiple compactions replacing different ranges', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('agent', 'b', 200),
      compactionEvent(100, 200, 'Summary 1', 250),
      textEvent('user', 'c', 300),
      textEvent('agent', 'd', 400),
      compactionEvent(300, 400, 'Summary 2', 450),
      textEvent('user', 'e', 500),
    ];

    const contents = getContents(events, 'agent');
    expect(contents).toHaveLength(3);
    expect(contents[0].parts?.[0]?.text).toBe('Summary 1');
    expect(contents[1].parts?.[0]?.text).toBe('Summary 2');
    expect(contents[2].parts?.[0]?.text).toBe('e');
  });

  it('handles rolling compaction where larger supersedes smaller', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('agent', 'b', 200),
      textEvent('user', 'c', 300),
      compactionEvent(100, 200, 'first summary', 250),
      compactionEvent(100, 300, 'rolling summary', 350),
      textEvent('user', 'd', 400),
      textEvent('agent', 'e', 500),
    ];

    const contents = getContents(events, 'agent');

    const summaryTexts = contents
      .map((c) => c.parts?.[0]?.text)
      .filter((t) => t?.includes('summary'));
    expect(summaryTexts).toHaveLength(1);
    expect(summaryTexts[0]).toBe('rolling summary');
  });

  it('compaction events with no content role are excluded', () => {
    const compOnly = createEvent({
      author: 'user',
      timestamp: 250,
      actions: createEventActions({
        compaction: {
          startTimestamp: 100,
          endTimestamp: 200,
          compactedContent: {role: 'model', parts: [{text: 'summary'}]},
        },
      }),
    });

    const events = [
      textEvent('user', 'a', 100),
      textEvent('agent', 'b', 200),
      compOnly,
      textEvent('user', 'c', 300),
    ];

    const contents = getContents(events, 'agent');
    const allText = contents.map((c) => c.parts?.[0]?.text);
    expect(allText).toContain('summary');
    expect(allText).toContain('c');
    expect(allText).not.toContain('a');
    expect(allText).not.toContain('b');
  });

  it('works with branch filtering and compaction', () => {
    const events = [
      textEvent('user', 'a', 100, {branch: 'main'}),
      textEvent('agent', 'b', 200, {branch: 'main'}),
      compactionEvent(100, 200, 'summary', 250),
      textEvent('user', 'c', 300, {branch: 'main'}),
      textEvent('agent', 'd', 400, {branch: 'other'}),
    ];

    const contents = getContents(events, 'agent', 'main');

    const allText = contents.map((c) => c.parts?.[0]?.text);
    expect(allText).toContain('summary');
    expect(allText).toContain('c');
    expect(allText).not.toContain('d');
  });

  it('foreign agent events after compaction are converted correctly', () => {
    const events = [
      textEvent('user', 'a', 100),
      textEvent('current_agent', 'b', 200),
      compactionEvent(100, 200, 'summary', 250),
      textEvent('other_agent', 'foreign text', 300),
      textEvent('user', 'c', 400),
    ];

    const contents = getContents(events, 'current_agent');

    const foreignConverted = contents.find((c) =>
      c.parts?.some((p) => p.text?.includes('[other_agent]')),
    );
    expect(foreignConverted).toBeDefined();
  });
});
