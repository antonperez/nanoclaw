import { describe, it, expect } from 'vitest';
import { classifyQuery, buildToolFilter, getAllowedTools, isRPrefix, stripRPrefix } from './query-classifier.js';

// --- classifyQuery ---

describe('classifyQuery', () => {
  it('routes scheduled tasks to sonnet', () => {
    const result = classifyQuery('Run the daily brief', true);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('scheduled-task');
  });

  it('routes q: prefix to sonnet', () => {
    const result = classifyQuery('q: is wimbledon on?', false);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('q-prefix');
  });

  it('q: prefix is case-insensitive', () => {
    const result = classifyQuery('Q: quick question', false);
    expect(result.reason).toBe('q-prefix');
  });

  it('routes r: prefix to sonnet', () => {
    const result = classifyQuery('r: udemy access via BDO', false);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('r-prefix');
  });

  it('routes remember: prefix to sonnet', () => {
    const result = classifyQuery('remember: therapy notes', false);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('r-prefix');
  });

  it('routes remember with space prefix to sonnet', () => {
    const result = classifyQuery('remember this important thing', false);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('r-prefix');
  });

  it('r: prefix is case-insensitive', () => {
    const result = classifyQuery('R: BDO has udemy', false);
    expect(result.reason).toBe('r-prefix');
  });

  it('routes general prompts to sonnet by default', () => {
    const result = classifyQuery('what are the odds sinner wins wimbledon?', false);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('default-sonnet');
  });

  it('routes o: prefix to opus', () => {
    const result = classifyQuery('o: second-order think this BDO situation', false);
    expect(result.model).toContain('opus');
    expect(result.reason).toBe('o-prefix');
  });

  it('o: prefix is case-insensitive', () => {
    const result = classifyQuery('O: analyse this', false);
    expect(result.reason).toBe('o-prefix');
  });

  it('scheduled task takes precedence over o: prefix', () => {
    const result = classifyQuery('o: daily brief', true);
    expect(result.reason).toBe('scheduled-task');
  });

  it('scheduled task takes precedence over q: prefix', () => {
    const result = classifyQuery('q: daily brief', true);
    expect(result.reason).toBe('scheduled-task');
  });
});

// --- stripRPrefix ---

describe('stripRPrefix', () => {
  it('strips r: prefix', () => {
    expect(stripRPrefix('r: udemy access via BDO')).toBe('udemy access via BDO');
  });

  it('strips remember: prefix', () => {
    expect(stripRPrefix('remember: therapy notes')).toBe('therapy notes');
  });

  it('strips remember with trailing space', () => {
    expect(stripRPrefix('remember this')).toBe('this');
  });

  it('strips R: case-insensitively', () => {
    expect(stripRPrefix('R: some fact')).toBe('some fact');
  });

  it('strips leading whitespace before prefix', () => {
    expect(stripRPrefix('  r: indented')).toBe('indented');
  });
});

// --- isRPrefix ---

describe('isRPrefix', () => {
  it('returns true for r: prefix', () => { expect(isRPrefix('r: fact')).toBe(true); });
  it('returns true for remember: prefix', () => { expect(isRPrefix('remember: fact')).toBe(true); });
  it('returns true for remember with space', () => { expect(isRPrefix('remember this')).toBe(true); });
  it('returns false for regular message', () => { expect(isRPrefix('what is the weather?')).toBe(false); });
  it('returns false for q: prefix', () => { expect(isRPrefix('q: quick question')).toBe(false); });
});

// --- getAllowedTools ---

describe('getAllowedTools', () => {
  it('returns core 5 tools for a simple prompt', () => {
    const tools = getAllowedTools('hello', true);
    expect(tools).toHaveLength(5);
    expect(tools).toContain('Bash');
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    expect(tools).toContain('mcp__nanoclaw__send_message');
    expect(tools).toContain('mcp__nanoclaw__web_fetch');
  });

  it('adds manage_tasks for scheduling keywords', () => {
    const tools = getAllowedTools('schedule a reminder for tomorrow', true);
    expect(tools).toContain('mcp__nanoclaw__manage_tasks');
  });

  it('adds send_email for email keywords', () => {
    const tools = getAllowedTools('send an email to john', true);
    expect(tools).toContain('mcp__nanoclaw__send_email');
  });

  it('adds dav_request for calendar keywords', () => {
    const tools = getAllowedTools('check my calendar events', true);
    expect(tools).toContain('mcp__nanoclaw__dav_request');
  });

  it('excludes register_group when not main', () => {
    const tools = getAllowedTools('register a new group', false);
    expect(tools).not.toContain('mcp__nanoclaw__register_group');
  });

  it('returns only send_message for simple-pattern routing', () => {
    const tools = getAllowedTools('hi', true, 'simple-pattern');
    expect(tools).toEqual(['mcp__nanoclaw__send_message']);
  });

  it('returns an array not a Set', () => {
    expect(Array.isArray(getAllowedTools('hello', true))).toBe(true);
  });
});

// --- buildToolFilter ---

describe('buildToolFilter', () => {
  const allTools = [
    'Bash', 'Read', 'Write',
    'mcp__nanoclaw__send_message', 'mcp__nanoclaw__web_fetch',
    'mcp__nanoclaw__manage_tasks',
    'mcp__nanoclaw__send_email', 'mcp__nanoclaw__dav_request',
    'mcp__nanoclaw__register_group',
  ].map(name => ({ name }));

  function filterNames(prompt: string, isMain = true, routingReason?: string): string[] {
    const filter = buildToolFilter(prompt, isMain, routingReason);
    return allTools.filter(filter).map(t => t.name);
  }

  it('always includes core tools', () => {
    const names = filterNames('hello');
    expect(names).toContain('Bash');
    expect(names).toContain('Read');
    expect(names).toContain('Write');
    expect(names).toContain('mcp__nanoclaw__send_message');
    expect(names).toContain('mcp__nanoclaw__web_fetch');
  });

  it('excludes task tools for simple prompt', () => {
    const names = filterNames('hello');
    expect(names).not.toContain('mcp__nanoclaw__manage_tasks');
    expect(names).not.toContain('mcp__nanoclaw__send_email');
    expect(names).not.toContain('mcp__nanoclaw__dav_request');
    expect(names).not.toContain('mcp__nanoclaw__register_group');
  });

  it('includes manage_tasks when prompt mentions scheduling', () => {
    const names = filterNames('schedule a reminder for tomorrow');
    expect(names).toContain('mcp__nanoclaw__manage_tasks');
  });

  it('includes email tool when prompt mentions email', () => {
    const names = filterNames('send an email to john');
    expect(names).toContain('mcp__nanoclaw__send_email');
  });

  it('includes calendar tools when prompt mentions events', () => {
    const names = filterNames('check my calendar events');
    expect(names).toContain('mcp__nanoclaw__dav_request');
    expect(names).toContain('mcp__nanoclaw__manage_tasks');
  });

  it('includes dav_request when prompt mentions contacts', () => {
    const names = filterNames('find phone number for Sarah');
    expect(names).toContain('mcp__nanoclaw__dav_request');
  });

  it('includes register_group only from main', () => {
    const mainNames = filterNames('register a new group', true);
    expect(mainNames).toContain('mcp__nanoclaw__register_group');

    const nonMainNames = filterNames('register a new group', false);
    expect(nonMainNames).not.toContain('mcp__nanoclaw__register_group');
  });

  it('simple prompt loads only 5 core tools', () => {
    const names = filterNames('what is the weather?');
    expect(names).toHaveLength(5);
  });

  it('task prompt loads core + 1 manage_tasks tool = 6', () => {
    const names = filterNames('schedule a task for 9am');
    expect(names).toHaveLength(6);
  });

  it('minimal mode: simple-pattern routing returns only send_message', () => {
    const names = filterNames('hi', true, 'simple-pattern');
    expect(names).toEqual(['mcp__nanoclaw__send_message']);
    expect(names).toHaveLength(1);
  });

  it('minimal mode: does not include Bash, Read, Write, web_fetch', () => {
    const names = filterNames('thanks', true, 'simple-pattern');
    expect(names).not.toContain('Bash');
    expect(names).not.toContain('Read');
    expect(names).not.toContain('Write');
    expect(names).not.toContain('mcp__nanoclaw__web_fetch');
  });

  it('without routingReason still returns 5 core tools for simple prompt', () => {
    const names = filterNames('what is the weather?', true, undefined);
    expect(names).toHaveLength(5);
  });
});
