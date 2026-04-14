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
    const result = classifyQuery('Please analyze the quarterly report and summarize the key findings for the team meeting', false, true);
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

  it('routes complex prompts to sonnet', () => {
    const result = classifyQuery(
      'Analyze my spending this month and create a summary report with charts',
      false, true,
    );
    expect(result.model).toContain('sonnet');
    expect(result.reason).toBe('default-sonnet');
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
    'mcp__nanoclaw__schedule_task', 'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__task_action', 'mcp__nanoclaw__update_task',
    'mcp__nanoclaw__send_email', 'mcp__nanoclaw__caldav_request',
    'mcp__nanoclaw__carddav_request', 'mcp__nanoclaw__register_group',
  ].map(name => ({ name }));

  function filterNames(prompt: string, isMain = true): string[] {
    const filter = buildToolFilter(prompt, isMain);
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
    expect(names).not.toContain('mcp__nanoclaw__schedule_task');
    expect(names).not.toContain('mcp__nanoclaw__list_tasks');
    expect(names).not.toContain('mcp__nanoclaw__send_email');
    expect(names).not.toContain('mcp__nanoclaw__caldav_request');
    expect(names).not.toContain('mcp__nanoclaw__carddav_request');
    expect(names).not.toContain('mcp__nanoclaw__register_group');
  });

  it('includes task tools when prompt mentions scheduling', () => {
    const names = filterNames('schedule a reminder for tomorrow');
    expect(names).toContain('mcp__nanoclaw__schedule_task');
    expect(names).toContain('mcp__nanoclaw__list_tasks');
    expect(names).toContain('mcp__nanoclaw__task_action');
    expect(names).toContain('mcp__nanoclaw__update_task');
  });

  it('includes email tool when prompt mentions email', () => {
    const names = filterNames('send an email to john');
    expect(names).toContain('mcp__nanoclaw__send_email');
  });

  it('includes calendar tools when prompt mentions events', () => {
    const names = filterNames('check my calendar events');
    expect(names).toContain('mcp__nanoclaw__caldav_request');
    expect(names).toContain('mcp__nanoclaw__schedule_task');
  });

  it('includes contacts tool when prompt mentions contacts', () => {
    const names = filterNames('find phone number for Sarah');
    expect(names).toContain('mcp__nanoclaw__carddav_request');
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

  it('task prompt loads core + 4 task tools = 9', () => {
    const names = filterNames('schedule a task for 9am');
    expect(names).toHaveLength(9);
  });
});
