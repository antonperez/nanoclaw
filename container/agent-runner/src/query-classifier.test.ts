import { describe, it, expect } from 'vitest';
import { classifyQuery, buildToolFilter } from './query-classifier.js';

// --- classifyQuery ---

describe('classifyQuery', () => {
  it('routes scheduled tasks to haiku', () => {
    const result = classifyQuery('Run the daily brief', true);
    expect(result.model).toContain('haiku');
    expect(result.reason).toBe('scheduled-task');
  });

  it('routes simple greetings to haiku', () => {
    for (const greeting of ['hi', 'Hello', 'good morning', 'thanks', 'gm', 'ok']) {
      const result = classifyQuery(greeting, false);
      expect(result.model).toContain('haiku');
      expect(result.reason).toBe('simple-pattern');
    }
  });

  it('routes greeting with trailing punctuation to haiku', () => {
    for (const greeting of ['hi!', 'thanks.', 'ok?', 'bye!']) {
      const result = classifyQuery(greeting, false);
      expect(result.model).toContain('haiku');
      expect(result.reason).toBe('simple-pattern');
    }
  });

  it('does not route greeting followed by a request to haiku', () => {
    const result = classifyQuery('hi can you schedule a meeting', false);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('default-sonnet');
  });

  it('does not route greeting with extra words to haiku', () => {
    for (const prompt of ['hello how are you', 'ok sounds good', 'thanks for the help']) {
      const result = classifyQuery(prompt, false);
      expect(result.model).toContain('sonnet');
      expect(result.reason).toBe('default-sonnet');
    }
  });

  it('routes complex prompts to sonnet', () => {
    const longPrompt = 'Please analyze the quarterly report and summarize the key findings for the team meeting. '.repeat(4);
    const result = classifyQuery(longPrompt, false);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('default-sonnet');
  });

  it('routes prompt with tool keywords to sonnet', () => {
    const result = classifyQuery('schedule a meeting for tomorrow at 3pm', false);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('default-sonnet');
  });

  it('routes general questions to sonnet', () => {
    const result = classifyQuery('what is the capital of France?', false);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('default-sonnet');
  });

  it('scheduled task overrides all other checks', () => {
    const result = classifyQuery(
      'Analyze my spending this month and create a summary report with charts',
      true,
    );
    expect(result.model).toContain('haiku');
    expect(result.reason).toBe('scheduled-task');
  });
});

// --- buildToolFilter ---

describe('buildToolFilter', () => {
  const allTools = [
    'bash', 'read_file', 'write_file',
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
    expect(names).toContain('bash');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
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

  it('minimal mode: does not include bash, read_file, web_fetch', () => {
    const names = filterNames('thanks', true, 'simple-pattern');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('mcp__nanoclaw__web_fetch');
  });

  it('without routingReason still returns 5 core tools for simple prompt', () => {
    const names = filterNames('what is the weather?', true, undefined);
    expect(names).toHaveLength(5);
  });
});
