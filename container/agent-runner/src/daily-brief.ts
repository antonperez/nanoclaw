/**
 * Parallel daily brief pipeline.
 * Runs 7 sections concurrently via Promise.all(), then synthesizes.
 * Sections 1-6: Haiku (cheap, fast). Section 7: Sonnet (synthesis).
 */

// Cost comparison for daily brief (7 sections):
// Before (single Sonnet query with all tools):
//   ~8K input × 5 turns × $3/M = $0.12 input + ~3K output × $15/M = $0.045 output
//   Total: ~$0.165/brief
//
// After (6× Haiku parallel + 1× Sonnet synthesis):
//   6 Haiku sections: 6 × ~1.5K input × $0.80/M = $0.0072 + 6 × ~200 output × $4/M = $0.0048
//   1 Sonnet synthesis: ~2K input × $3/M = $0.006 + ~300 output × $15/M = $0.0045
//   Total: ~$0.022/brief
//
// Savings: ~87% ($0.165 → $0.022)

import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'child_process';
import { calcCost } from './direct-api.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-20250514';

interface BriefSection {
  name: string;
  model: string;
  prompt: string;
  tools: Anthropic.Tool[];
}

interface SectionResult {
  name: string;
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// Note: web_search is a built-in tool that doesn't exist in our setup.
// We'll use the bash tool to call curl for web searches instead.
const BASH_TOOL: Anthropic.Tool = {
  name: 'bash',
  description: 'Run a shell command. Timeout: 30s.',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
    },
    required: ['command'],
  },
};

function buildSections(date: string): BriefSection[] {
  return [
    {
      name: 'Manila Weather',
      model: HAIKU,
      prompt: `Current weather in Manila, Philippines for ${date}. Include temperature (Fahrenheit), conditions, humidity, and any weather alerts. Use bash with curl to fetch from wttr.in/Manila?format=j1. Be concise — 2-3 lines max.`,
      tools: [BASH_TOOL],
    },
    {
      name: 'Holiday Alert',
      model: HAIKU,
      prompt: `Is ${date} a holiday in the Philippines? Check for national holidays, special non-working days, and notable observances. Also check US federal holidays. Use bash with curl to search if needed. Reply in 1-2 lines. If no holiday, say "No holidays today."`,
      tools: [BASH_TOOL],
    },
    {
      name: 'Today in History',
      model: HAIKU,
      prompt: `What happened on this day (${date}) in history? Pick 2-3 interesting events from different eras. Be concise — one line per event. No tool calls needed — use your training data.`,
      tools: [],
    },
    {
      name: 'AI & Agents',
      model: HAIKU,
      prompt: `Top 2-3 AI and AI agent news headlines for ${date} or the past 24 hours. Use bash with curl to fetch from a news API or search. Focus on: new model releases, agent frameworks, MCP/tool-use developments, major funding. One line per headline with source. If you can't fetch, use recent training data.`,
      tools: [BASH_TOOL],
    },
    {
      name: 'DevSecOps & Cloud',
      model: HAIKU,
      prompt: `Top 2-3 DevSecOps and cloud infrastructure headlines for ${date} or the past 24 hours. Focus on: Kubernetes, AWS/GCP/Azure announcements, security vulnerabilities, CI/CD tooling. Use bash with curl if needed. One line per headline.`,
      tools: [BASH_TOOL],
    },
    {
      name: 'PH Banking & Fintech',
      model: HAIKU,
      prompt: `Top 2-3 Philippine banking and fintech headlines for ${date}. Focus on: BSP announcements, digital banking, GCash/Maya updates, peso exchange rate, PSEi movement. Use bash with curl if needed. One line per headline.`,
      tools: [BASH_TOOL],
    },
  ];
}

async function runSection(
  client: Anthropic,
  section: BriefSection,
  log: (msg: string) => void,
): Promise<SectionResult> {
  const startTime = Date.now();

  try {
    // Simple single-turn: no tool loop for most sections
    const response = await client.messages.create({
      model: section.model,
      max_tokens: 300,
      system: `You are a concise news briefing assistant. Output ONLY the requested information. No greetings, no commentary. Use bullet points (•).`,
      tools: section.tools.length > 0 ? section.tools : undefined,
      messages: [{ role: 'user', content: section.prompt }],
    });

    // Handle tool use (single round only for brief sections)
    let text = '';
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    if (toolUseBlocks.length > 0 && section.tools.length > 0) {
      // Execute tool calls — every tool_use must get a tool_result
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        if (block.type === 'tool_use' && block.name === 'bash') {
          const cmd = (block.input as { command: string }).command;
          const result = await new Promise<string>((resolve) => {
            execFile('bash', ['-c', cmd], { timeout: 15000, maxBuffer: 512 * 1024, cwd: '/workspace/group' }, (err, stdout, stderr) => {
              resolve((stdout + (stderr ? '\n' + stderr : '')).slice(0, 3000) || (err?.message ?? 'no output'));
            });
          });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        } else if (block.type === 'tool_use') {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: unknown tool "${block.name}"`, is_error: true });
        }
      }

      // Second call with tool results
      const followUp = await client.messages.create({
        model: section.model,
        max_tokens: 300,
        system: `You are a concise news briefing assistant. Output ONLY the requested information. No greetings, no commentary. Use bullet points (•).`,
        messages: [
          { role: 'user', content: section.prompt },
          { role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] },
          { role: 'user', content: toolResults },
        ],
      });

      text = followUp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      const totalInput = response.usage.input_tokens + followUp.usage.input_tokens;
      const totalOutput = response.usage.output_tokens + followUp.usage.output_tokens;

      log(`[brief] ${section.name}: ${section.model.includes('haiku') ? 'haiku' : 'sonnet'} ${totalInput}+${totalOutput} tokens, ${Date.now() - startTime}ms`);

      return {
        name: section.name,
        text,
        model: section.model,
        inputTokens: totalInput,
        outputTokens: totalOutput,
      };
    }

    // No tool use — extract text directly
    text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    log(`[brief] ${section.name}: ${section.model.includes('haiku') ? 'haiku' : 'sonnet'} ${response.usage.input_tokens}+${response.usage.output_tokens} tokens, ${Date.now() - startTime}ms`);

    return {
      name: section.name,
      text,
      model: section.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (err) {
    log(`[brief] ${section.name} ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return {
      name: section.name,
      text: `(Error fetching ${section.name})`,
      model: section.model,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

export async function runDailyBrief(
  log: (msg: string) => void,
): Promise<{ text: string; totalInputTokens: number; totalOutputTokens: number; costUsd: number }> {
  const client = new Anthropic();
  const now = new Date();
  const date = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  log(`[brief] Starting parallel daily brief for ${date}`);

  // Run sections 1-6 in parallel
  const sections = buildSections(date);
  const results = await Promise.all(
    sections.map(s => runSection(client, s, log)),
  );

  // Section 7: Sonnet synthesis — receives all 6 outputs
  const sectionSummaries = results
    .map(r => `*${r.name}*\n${r.text}`)
    .join('\n\n');

  const synthesisPrompt = `You have 6 daily briefing sections below. Write a "Worth Your Attention" section (2-3 bullets) highlighting the most actionable or notable items across ALL sections. What should Anton pay attention to today? What connects across sections?

${sectionSummaries}

Output ONLY the "Worth Your Attention" bullets. Use • for bullets. Be direct.`;

  const synthesisResult = await runSection(client, {
    name: 'Worth Your Attention',
    model: SONNET,
    prompt: synthesisPrompt,
    tools: [],
  }, log);

  // Assemble final message
  const allResults = [...results, synthesisResult];
  const totalInput = allResults.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutput = allResults.reduce((sum, r) => sum + r.outputTokens, 0);

  // Calculate cost per-section using the correct model pricing
  const totalCost = allResults.reduce((sum, r) => sum + calcCost(
    { input_tokens: r.inputTokens, output_tokens: r.outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    r.model,
  ), 0);

  const brief = [
    `*Daily Brief — ${date}*`,
    '',
    ...allResults.map(r => `*${r.name}*\n${r.text}`),
    '',
    `_${allResults.length} sections | ${totalInput + totalOutput} tokens | ${allResults.filter(r => r.model.includes('haiku')).length} haiku + ${allResults.filter(r => r.model.includes('sonnet')).length} sonnet_`,
  ].join('\n\n');

  log(`[brief] Complete: ${totalInput} input + ${totalOutput} output tokens, cost: $${totalCost.toFixed(4)}`);

  return { text: brief, totalInputTokens: totalInput, totalOutputTokens: totalOutput, costUsd: totalCost };
}
