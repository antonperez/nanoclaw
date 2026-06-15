/**
 * Parallel daily brief pipeline.
 * Runs 7 sections concurrently via Promise.all(), then synthesizes.
 * Uses claude CLI — OAuth compatible, no direct @anthropic-ai/sdk calls.
 */

import { spawn } from 'child_process';

const HAIKU  = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-20250514';

const BRIEF_SYSTEM = 'You are a concise news briefing assistant. Output ONLY the requested information. No greetings, no commentary. Use bullet points (•).';

interface BriefSection {
  name: string;
  model: string;
  prompt: string;
}

interface SectionResult {
  name: string;
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function buildSections(date: string): BriefSection[] {
  return [
    {
      name: 'Manila Weather',
      model: SONNET,
      prompt: `Fetch current weather in Manila, Philippines. Run: curl -s "https://wttr.in/Manila?format=j1" and extract current_condition[0]: temp_C, weatherDesc, humidity, precipMM. Output 2 lines max: temp + conditions, then rain/alert if any. You MUST use the bash tool — no training data.`,
    },
    {
      name: 'Holiday Alert',
      model: HAIKU,
      prompt: `Check PH public holidays for ${date}. Run: curl -s "https://date.nager.at/api/v3/PublicHolidays/2026/PH" and find any holiday matching today's date (month/day). Output 1 line: holiday name, or "No PH holiday today." You MUST use the bash tool.`,
    },
    {
      name: 'Today in History',
      model: SONNET,
      prompt: `What happened on this day (${date}) in history? Pick 2-3 interesting events from different eras. Be concise — one line per event. Use your training data.`,
    },
    {
      name: 'AI & Agents',
      model: SONNET,
      prompt: `Top 2-3 AI and agent news from the past 24h. You MUST run: curl -s "https://hn.algolia.com/api/v1/search?tags=story&query=AI+agent+LLM&hitsPerPage=5" and extract title+url from hits[]. Output one line per item: headline — source. Do not use training data.`,
    },
    {
      name: 'DevSecOps & Cloud',
      model: SONNET,
      prompt: `Top 2-3 DevSecOps/cloud headlines from the past 24h. You MUST run: curl -s "https://hn.algolia.com/api/v1/search?tags=story&query=kubernetes+AWS+security+cloud&hitsPerPage=5" and extract title+url from hits[]. Output one line per item. Do not use training data.`,
    },
    {
      name: 'PH Banking & Fintech',
      model: SONNET,
      prompt: `Top 2-3 PH banking/fintech headlines. You MUST run: curl -s "https://hn.algolia.com/api/v1/search?tags=story&query=Philippines+fintech+GCash+BSP&hitsPerPage=5" then also curl -s "https://query1.finance.yahoo.com/v8/finance/chart/PHP%3DX?interval=1d&range=1d" for USD/PHP rate. Output headlines + current exchange rate. Do not use training data.`,
    },
  ];
}

async function runSection(
  section: BriefSection,
  log: (msg: string) => void,
): Promise<SectionResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', section.model,
      '--system-prompt', BRIEF_SYSTEM,
      '--dangerously-skip-permissions',
      section.prompt,
    ];

    const proc = spawn('claude', args, {
      env: { ...process.env },
      cwd: '/workspace/group',
    });

    let resultText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let lineBuffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === 'assistant') {
            const usage = (event.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
            if (usage) {
              inputTokens  += usage.input_tokens  ?? 0;
              outputTokens += usage.output_tokens ?? 0;
            }
          }
          if (event.type === 'result') {
            resultText = (event.result   as string) ?? '';
            costUsd    = (event.cost_usd as number) ?? 0;
          }
        } catch {
          // Non-JSON line — ignore
        }
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 && !resultText) {
        log(`[brief] ${section.name}: CLI exited ${code}`);
        resolve({
          name: section.name,
          text: `(Error fetching ${section.name})`,
          model: section.model,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        });
        return;
      }
      log(`[brief] ${section.name}: ${section.model.includes('haiku') ? 'haiku' : 'sonnet'} ${inputTokens}+${outputTokens} tokens, ${Date.now() - startTime}ms`);
      resolve({ name: section.name, text: resultText, model: section.model, inputTokens, outputTokens, costUsd });
    });

    proc.on('error', (err: Error) => {
      log(`[brief] ${section.name} spawn error: ${err.message}`);
      resolve({
        name: section.name,
        text: `(Error fetching ${section.name}: ${err.message})`,
        model: section.model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
    });
  });
}

export async function runDailyBrief(
  log: (msg: string) => void,
): Promise<{ text: string; totalInputTokens: number; totalOutputTokens: number; costUsd: number }> {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  log(`[brief] Starting parallel daily brief for ${date}`);

  // Run sections 1-6 in parallel
  const sections = buildSections(date);
  const results = await Promise.all(sections.map(s => runSection(s, log)));

  // Section 7: Sonnet synthesis — receives all 6 outputs
  const sectionSummaries = results.map(r => `*${r.name}*\n${r.text}`).join('\n\n');

  const synthesisResult = await runSection({
    name: 'Worth Your Attention',
    model: SONNET,
    prompt: `You have 6 daily briefing sections below. Write a "Worth Your Attention" section (2-3 bullets) highlighting the most actionable or notable items across ALL sections. What should Anton pay attention to today? What connects across sections?\n\n${sectionSummaries}\n\nOutput ONLY the "Worth Your Attention" bullets. Use • for bullets. Be direct.`,
  }, log);

  const allResults = [...results, synthesisResult];
  const totalInput  = allResults.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutput = allResults.reduce((sum, r) => sum + r.outputTokens, 0);
  const totalCost   = allResults.reduce((sum, r) => sum + r.costUsd, 0);

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
