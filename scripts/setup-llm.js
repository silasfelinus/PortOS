#!/usr/bin/env node

/**
 * AI Tooling Setup / Doctor
 *
 * Detects the local agent CLIs PortOS can orchestrate (Claude Code, Codex /
 * OpenAI CLI, Ollama, LM Studio), records sane local defaults in `.env`, checks
 * reachable local/Tailscale media backends, and offers to install/select a local
 * LLM backend when running interactively.
 *
 * Called by: npm run setup (and `npm run setup:llm` directly).
 */

import { execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { parseEnvFile, upsertEnvKey } from './lib/envFile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const envPath = join(rootDir, '.env');

const DEFAULTS = {
  LLM_BACKEND: 'ollama',
  OLLAMA_HOST: '127.0.0.1:11434',
  PORTOS_START_OLLAMA: 'true',
  PORTOS_COMFY_URL: 'https://ferngrotto.foxhound-chicken.ts.net',
  PORTOS_STABLE_DIFFUSION_URL: 'https://ferngrotto.foxhound-chicken.ts.net:8443'
};

function readEnv() {
  return { ...parseEnvFile(envPath), ...process.env };
}

function setEnvKey(key, value) {
  upsertEnvKey(envPath, key, value);
}

function ensureEnvDefault(key, value) {
  const env = readEnv();
  if (!env[key]) {
    setEnvKey(key, value);
    console.log(`   wrote ${key}=${value}`);
  }
}

function commandResult(command, args = ['--version']) {
  try {
    const stdout = execFileSync(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
      timeout: 7500
    });

    const version = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    return { ok: true, version: version || 'installed' };
  } catch (error) {
    return {
      ok: false,
      message: error?.code === 'ENOENT'
        ? 'not found on PATH'
        : (error?.message || 'not detected')
    };
  }
}

function hasCommand(command, args = ['--version']) {
  return commandResult(command, args).ok;
}

const hasBrew = () => hasCommand('brew', ['--version']);
const hasWinget = () => hasCommand('winget', ['--version']);
const hasOllama = () => hasCommand('ollama', ['--version']);
const hasLmStudio = () =>
  hasCommand('lms', ['version']) ||
  (process.platform === 'darwin' && existsSync('/Applications/LM Studio.app'));

function formatStatus(result) {
  return result.ok ? `✅ ${result.version}` : `⚠️  ${result.message}`;
}

function printToolStatus() {
  const checks = [
    ['Claude Code', commandResult('claude', ['--version'])],
    ['Codex CLI', commandResult('codex', ['--version'])],
    ['OpenAI CLI', commandResult('openai', ['--version'])],
    ['Ollama CLI', commandResult('ollama', ['--version'])],
    ['LM Studio CLI', commandResult('lms', ['version'])]
  ];

  console.log('🧰 AI tool check');
  for (const [label, result] of checks) {
    console.log(`   ${label.padEnd(14)} ${formatStatus(result)}`);
  }
  console.log('');
}

function installOllama() {
  const platform = process.platform;

  try {
    if (platform === 'win32' && hasWinget()) {
      console.log('🪟 Installing Ollama via WinGet...');
      execFileSync('winget', [
        'install',
        '--id',
        'Ollama.Ollama',
        '-e',
        '--accept-source-agreements',
        '--accept-package-agreements'
      ], { stdio: 'inherit', windowsHide: true });
      return true;
    }

    if (platform === 'darwin' && hasBrew()) {
      console.log('🍺 Installing Ollama via Homebrew...');
      execFileSync('brew', ['install', 'ollama'], { stdio: 'inherit' });
      return true;
    }

    if (platform === 'linux') {
      console.log('⬇️  Installing Ollama via official script...');
      execFileSync('bash', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { stdio: 'inherit' });
      return true;
    }
  } catch (err) {
    console.error(`⚠️  Ollama install failed: ${err.message}`);
  }

  console.log('   Download Ollama manually: https://ollama.com/download');
  return false;
}

function installLmStudio() {
  try {
    if (process.platform === 'darwin' && hasBrew()) {
      console.log('🍺 Installing LM Studio via Homebrew...');
      execFileSync('brew', ['install', '--cask', 'lm-studio'], { stdio: 'inherit' });
      console.log('   Launch LM Studio, then enable the local server (Developer tab) and run: lms bootstrap');
      return true;
    }
  } catch (err) {
    console.error(`⚠️  LM Studio install failed: ${err.message}`);
  }

  console.log('   Download LM Studio manually: https://lmstudio.ai/download');
  return false;
}

function setBackend(backend) {
  setEnvKey('LLM_BACKEND', backend);

  if (backend === 'ollama') {
    ensureEnvDefault('OLLAMA_HOST', DEFAULTS.OLLAMA_HOST);
    ensureEnvDefault('PORTOS_START_OLLAMA', DEFAULTS.PORTOS_START_OLLAMA);
  }

  console.log(`✅ Local LLM backend set to ${backend} (LLM_BACKEND in .env)`);
}

function promptChoice() {
  return new Promise((resolve) => {
    console.log('🧠 Choose a local LLM backend (for free, on-device models):');
    console.log('');
    console.log('   1) Ollama    (CLI-first, simple `ollama pull`, great default)');
    console.log('   2) LM Studio (GUI app with a built-in model browser)');
    console.log('   3) Skip      (configure later in Settings → Local LLMs)');
    console.log('');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('   Enter choice [1/2/3]: ', (answer) => {
      rl.close();
      const t = answer.trim();
      resolve(t === '1' ? 'ollama' : t === '2' ? 'lmstudio' : 'skip');
    });
  });
}

function promptYesNo(question, defaultYes = false) {
  return new Promise((resolve) => {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`   ${question} ${suffix}: `, (answer) => {
      rl.close();
      const t = answer.trim();
      if (!t) {
        resolve(defaultYes);
        return;
      }
      resolve(/^y(es)?$/i.test(t));
    });
  });
}

function endpointUrl(baseUrl, healthPath) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}${healthPath}`;
}

function ollamaBaseUrl(host) {
  const raw = String(host || DEFAULTS.OLLAMA_HOST).trim();
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `http://${raw.replace(/\/+$/, '')}`;
}

async function checkHttp(label, url) {
  if (!url) {
    console.log(`   ${label.padEnd(18)} ⚠️  no URL configured`);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal
    });

    const status = `${response.status} ${response.statusText}`.trim();
    console.log(`   ${label.padEnd(18)} ${response.ok ? '✅' : '⚠️ '} ${status} — ${url}`);
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : (error?.message || 'unreachable');
    console.log(`   ${label.padEnd(18)} ⚠️  ${reason} — ${url}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function printEndpointStatus() {
  const env = readEnv();
  const ollamaUrl = `${ollamaBaseUrl(env.OLLAMA_HOST)}/api/tags`;
  const comfyUrl = endpointUrl(env.PORTOS_COMFY_URL || DEFAULTS.PORTOS_COMFY_URL, '/system_stats');
  const stableDiffusionUrl = endpointUrl(env.PORTOS_STABLE_DIFFUSION_URL || DEFAULTS.PORTOS_STABLE_DIFFUSION_URL, '/sdapi/v1/progress');

  console.log('🌐 Local/Tailscale AI endpoint check');
  await checkHttp('Ollama API', ollamaUrl);
  await checkHttp('ComfyUI', comfyUrl);
  await checkHttp('Stable Diffusion', stableDiffusionUrl);
  console.log('');
}

function printMissingHints() {
  const claude = commandResult('claude', ['--version']);
  const codex = commandResult('codex', ['--version']);
  const openai = commandResult('openai', ['--version']);

  if (claude.ok && codex.ok && openai.ok) return;

  console.log('🛠️  Missing CLI hints');
  if (!claude.ok) {
    if (process.platform === 'win32' && hasWinget()) {
      console.log('   Claude Code: winget install Anthropic.ClaudeCode');
    } else {
      console.log('   Claude Code: npm install -g @anthropic-ai/claude-code');
    }
  }

  if (!codex.ok) {
    console.log('   Codex CLI: install from https://developers.openai.com/codex/cli');
  }

  if (!openai.ok) {
    console.log('   OpenAI CLI: optional; PortOS can still use OPENAI_API_KEY directly.');
  }
  console.log('');
}

function writePortosDefaults() {
  console.log('🧭 PortOS local AI defaults');
  ensureEnvDefault('OLLAMA_HOST', DEFAULTS.OLLAMA_HOST);
  ensureEnvDefault('PORTOS_START_OLLAMA', DEFAULTS.PORTOS_START_OLLAMA);
  ensureEnvDefault('PORTOS_COMFY_URL', DEFAULTS.PORTOS_COMFY_URL);
  ensureEnvDefault('PORTOS_STABLE_DIFFUSION_URL', DEFAULTS.PORTOS_STABLE_DIFFUSION_URL);
  console.log('');
}

async function main() {
  printToolStatus();
  writePortosDefaults();
  await printEndpointStatus();
  printMissingHints();

  const env = readEnv();
  const existing = env.LLM_BACKEND;

  if (existing === 'ollama' || existing === 'lmstudio') {
    const installed = existing === 'ollama' ? hasOllama() : hasLmStudio();
    console.log(`🧠 Local LLM backend: ${existing}${installed ? ' (installed)' : ' — not detected'}`);

    if (installed || !process.stdin.isTTY || !process.stdout.isTTY) {
      process.exit(0);
    }

    const label = existing === 'ollama' ? 'Ollama' : 'LM Studio';
    const yes = await promptYesNo(`${label} is selected but not installed. Install it now?`);
    if (yes) {
      (existing === 'ollama' ? installOllama : installLmStudio)();
    }
    process.exit(0);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('🧠 No local LLM backend selected — defaulting to Ollama for PortOS launcher startup.');
    setBackend(DEFAULTS.LLM_BACKEND);
    process.exit(0);
  }

  const choice = await promptChoice();

  if (choice === 'skip') {
    console.log('   Skipped — pick a backend later in Settings → Local LLMs.');
    process.exit(0);
  }

  const alreadyInstalled = choice === 'ollama' ? hasOllama() : hasLmStudio();
  if (!alreadyInstalled) {
    const label = choice === 'ollama' ? 'Ollama' : 'LM Studio';
    const yes = await promptYesNo(`${label} is not installed. Install it now?`);
    if (yes) {
      (choice === 'ollama' ? installOllama : installLmStudio)();
    } else {
      console.log(`   Skipping install — you can install ${label} later, the choice is still saved.`);
    }
  }

  setBackend(choice);
}

await main();
