/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {validateEventsCompactionConfig} from '../../src/agents/events_compaction_config.js';

describe('validateEventsCompactionConfig', () => {
  it('accepts empty config', () => {
    expect(() => validateEventsCompactionConfig({})).not.toThrow();
  });

  it('accepts config with both tokenThreshold and eventRetentionSize', () => {
    expect(() =>
      validateEventsCompactionConfig({
        tokenThreshold: 1000,
        eventRetentionSize: 5,
      }),
    ).not.toThrow();
  });

  it('accepts config with eventRetentionSize = 0', () => {
    expect(() =>
      validateEventsCompactionConfig({
        tokenThreshold: 1000,
        eventRetentionSize: 0,
      }),
    ).not.toThrow();
  });

  it('throws when only tokenThreshold set', () => {
    expect(() =>
      validateEventsCompactionConfig({tokenThreshold: 1000}),
    ).toThrow('tokenThreshold and eventRetentionSize must both be set');
  });

  it('throws when only eventRetentionSize set', () => {
    expect(() =>
      validateEventsCompactionConfig({eventRetentionSize: 5}),
    ).toThrow('tokenThreshold and eventRetentionSize must both be set');
  });

  it('throws when tokenThreshold is 0', () => {
    expect(() =>
      validateEventsCompactionConfig({
        tokenThreshold: 0,
        eventRetentionSize: 5,
      }),
    ).toThrow('tokenThreshold must be greater than 0');
  });

  it('throws when tokenThreshold is negative', () => {
    expect(() =>
      validateEventsCompactionConfig({
        tokenThreshold: -100,
        eventRetentionSize: 5,
      }),
    ).toThrow('tokenThreshold must be greater than 0');
  });

  it('throws when eventRetentionSize is negative', () => {
    expect(() =>
      validateEventsCompactionConfig({
        tokenThreshold: 1000,
        eventRetentionSize: -1,
      }),
    ).toThrow('eventRetentionSize must be >= 0');
  });

  it('accepts config with both compactionInterval and overlapSize', () => {
    expect(() =>
      validateEventsCompactionConfig({
        compactionInterval: 10,
        overlapSize: 2,
      }),
    ).not.toThrow();
  });

  it('throws when only compactionInterval set', () => {
    expect(() =>
      validateEventsCompactionConfig({compactionInterval: 10}),
    ).toThrow('compactionInterval and overlapSize must both be set');
  });

  it('throws when only overlapSize set', () => {
    expect(() => validateEventsCompactionConfig({overlapSize: 2})).toThrow(
      'compactionInterval and overlapSize must both be set',
    );
  });

  it('accepts config with all fields set', () => {
    expect(() =>
      validateEventsCompactionConfig({
        tokenThreshold: 5000,
        eventRetentionSize: 10,
        compactionInterval: 5,
        overlapSize: 1,
      }),
    ).not.toThrow();
  });

  it('throws when compactionInterval is 0', () => {
    expect(() =>
      validateEventsCompactionConfig({
        compactionInterval: 0,
        overlapSize: 1,
      }),
    ).toThrow('compactionInterval must be greater than 0');
  });

  it('throws when compactionInterval is negative', () => {
    expect(() =>
      validateEventsCompactionConfig({
        compactionInterval: -5,
        overlapSize: 1,
      }),
    ).toThrow('compactionInterval must be greater than 0');
  });

  it('throws when overlapSize is negative', () => {
    expect(() =>
      validateEventsCompactionConfig({
        compactionInterval: 5,
        overlapSize: -1,
      }),
    ).toThrow('overlapSize must be >= 0');
  });

  it('accepts overlapSize of 0', () => {
    expect(() =>
      validateEventsCompactionConfig({
        compactionInterval: 5,
        overlapSize: 0,
      }),
    ).not.toThrow();
  });
});
