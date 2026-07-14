#!/usr/bin/env node
/**
 * One-shot "run this prompt through the configured CLI provider" for headless
 * scripts (e.g. scripts/challenge_submit.py) that need agent output without
 * going through the Express server, PM2, or the full AI toolkit.
 *
 * Reads the prompt from stdin, resolves the CLI provider from
 * data/providers.json + a `settings.<key>` slot in data/settings.json
 * (mirrors autofixer/server.js's provider resolution — same fallback to
 * claude-code when unset), runs it via runCliProviderPrompt, and prints the
 * agent's final stdout text to stdout. Non-zero exit + stderr message on
 * failure so callers (challenge_submit.py) can distinguish success from
 * error without parsing stdout.
 *
 * Usage:
 *   node scripts/lib/run_cli_provider.mjs [--settings-key KEY] [--provider-id ID] [--model MODEL] [--timeout-ms MS] [--cwd DIR] < prompt.txt
 *
 * --provider-id/--model override whatever is stored under data/settings.json's
 * `settings[settingsKey]` slot for this one call, without touching the file.
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pickCliProvider, runCliProviderPrompt } from '../../server/lib/cliProviderRun.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');

function parseArgs(argv) {
  const out = { settingsKey: 'challengeSubmit', timeoutMs: 300000, cwd: process.cwd(), providerId: null, model: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--settings-key') out.settingsKey = argv[++i];
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--provider-id') out.providerId = argv[++i];
    else if (arg === '--model') out.model = argv[++i];
  }
  return out;
}

async function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = (await readStdin()).trim();
  if (!prompt) {
    console.error('❌ [run_cli_provider] no prompt received on stdin');
    process.exitCode = 1;
    return;
  }

  const providersFile = await readJsonSafe(join(DATA_DIR, 'providers.json'), { providers: {} });
  const settingsFile = await readJsonSafe(join(DATA_DIR, 'settings.json'), {});
  const providers = providersFile.providers || {};
  const config = {
    ...(settingsFile[args.settingsKey] || {}),
    ...(args.providerId ? { providerId: args.providerId } : {}),
    ...(args.model ? { model: args.model } : {}),
  };

  const picked = pickCliProvider(providers, config);
  if (picked.error) {
    console.error(`❌ [run_cli_provider] ${picked.error}`);
    process.exitCode = 1;
    return;
  }

  const result = await runCliProviderPrompt({
    provider: picked.provider,
    model: picked.model,
    prompt,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
  });

  if (result.error) {
    console.error(`❌ [run_cli_provider] ${result.error}`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(result.text);
}

main();
