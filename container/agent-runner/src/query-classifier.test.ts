import { describe, it, expect } from 'vitest';
import { classifyQuery, buildToolFilter } from './query-classifier.js';

// --- classifyQuery ---

describe('classifyQuery', () => {
  it('routes scheduled tasks to haiku', () => {
    const result = classifyQuery('Run the daily brief', true, false);
    expect(result.model).toContain('haiku');
    expect(result.reason).toBe('scheduled-task');
  });

  it('routes short prompts without session to haiku', () => {
    const result = classifyQuery('what time is it?', false, false);
    expect(result.model).toContain('haiku');
    expect(result.reason).toBe('short-no-history');
  });

  it('routes long prompts with session to sonnet', () => {
    const longPrompt = 'Please analyze the quarterly report and summarize the key findings for the team meeting. '.repeat(4);
    const result = classifyQuery(longPrompt, false, true);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('default-sonnet');
  });

  it('routes simple greetings to haiku', () => {
    for (const greeting of ['hi', 'Hello', 'good morning', 'thanks', 'gm', 'ok']) {
      const result = classifyQuery(greeting, false, true);
      expect(result.model).toContain('haiku');
      expect(result.reason).toBe('simple-pattern');
    }
  });

  it('routes complex prompts over 300 chars to sonnet', () => {
    // Prompt intentionally >300 chars with no tool keywords to verify length cutoff
    const result = classifyQuery(
      'Analyze my spending this month and create a summary report with charts. Include breakdowns by category, trends over time, and comparisons to previous months. Also highlight any anomalies or unusual spending patterns you detect. Be thorough and very detailed in your analysis, covering all aspects of my finances.',
      false, true,
    );
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('default-sonnet');
  });

  it('routes short Q&A without tool keywords to haiku', () => {
    const result = classifyQuery('what is the capital of France?', false, true);
    expect(result.model).toContain('haiku');
    expect(result.reason).toBe('short-no-tools');
  });

  it('routes short prompt with tool keywords to sonnet', () => {
    const result = classifyQuery('schedule a meeting for tomorrow at 3pm', false, true);
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('default-sonnet');
  });

  it('routes long Q&A to sonnet regardless', () => {
    const longPrompt = 'I need you to analyze this situation and provide recommendations. '.repeat(6);
    const result = classifyQuery(longPrompt, false, true);
    expect(result.model).toContain('sonnet');
  });

  it('scheduled task overrides all other checks', () => {
    // Even a long complex prompt goes to haiku if scheduled
    const result = classifyQuery(
      'Analyze my spending this month and create a summary report with charts',
      true, true,
    );
    expect(result.model).toContain('haiku');
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
