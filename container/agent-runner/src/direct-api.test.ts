import { describe, it, expect } from 'vitest';
import { calcCost } from './direct-api.js';

// --- calcCost ---

describe('calcCost', () => {
  it('returns 0 for zero usage', () => {
    expect(
      calcCost({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(0);
  });

  it('calculates input-only cost at $3/M', () => {
    expect(
      calcCost({
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(3.0);
  });

  it('calculates output-only cost at $15/M', () => {
    expect(
      calcCost({
        input_tokens: 0,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(15.0);
  });

  it('calculates cache_read cost at $0.30/M', () => {
    expect(
      calcCost({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
      }),
    ).toBeCloseTo(0.3, 4);
  });

  it('calculates mixed usage', () => {
    // 5K input + 1K output + 3K cache_read + 2K cache_creation
    // = 0.015 + 0.015 + 0.0009 + 0.0075 = 0.0384
    expect(
      calcCost({
        input_tokens: 5000,
        output_tokens: 1000,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 2000,
      }),
    ).toBeCloseTo(0.0384, 4);
  });

  it('handles typical single-turn chat (6K input, 500 output, 2K cache)', () => {
    const cost = calcCost({
      input_tokens: 6000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 0,
    });
    // 0.018 + 0.0075 + 0.0006 = 0.0261
    expect(cost).toBeCloseTo(0.0261, 4);
    expect(cost).toBeLessThan(0.05); // sanity: single turn should be cheap
  });

  it('uses opus pricing at $15/M input for opus model', () => {
    expect(
      calcCost(
        {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        'claude-opus-4-20250514',
      ),
    ).toBe(15.0);
  });
});
