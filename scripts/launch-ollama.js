#!/usr/bin/env node

import { spawn, execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseEnvFile } from './lib/envFile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const env = { ...parseEnvFile(join(rootDir, '.env')), ...process.env };

const DEFAULT_HOST = '127.0.0.1:11434';
const KEEPALIVE_MS = 60 * 60 * 1000;
const isDetached = process.argv.includes('--detach') || process.argv.includes('--detached');

function normalizeHost(value) {
  const raw = String(value || DEFAULT_HOST).trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(raw)) return raw;
  return raw;
}

function baseUrlFromHost(value) {
  const host = normalizeHost(value);
  if (/^https?:\/\//i.test(host)) return host;
  return `http://${host}`;
}

function ollamaEnv() {
  const host = normalizeHost(env.OLLAMA_HOST || DEFAULT_HOST);
  const childEnv = { ...process.env, OLLAMA_HOST: host };

  if (env.OLLAMA_MODELS) {
    childEnv.OLLAMA_MODELS = env.OLLAMA_MODELS;
  }

  if (env.OLLAMA_ORIGINS) {
    childEnv.OLLAMA_ORIGINS = env.OLLAMA_ORIGINS;
  }

  return childEnv;
}

function hasOllama() {
  try {
    execFileSync('ollama', ['--version'], {
      stdio: 'pipe',
      windowsHide: true,
      timeout: 7500
    });
    return true;
  } catch {
    return false;
  }
}

async function isOllamaHealthy(timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrlFromHost(env.OLLAMA_HOST)}/api/tags`, {
      method: 'GET',
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForOllama() {
  for (let i = 0; i < 10; i += 1) {
    if (await isOllamaHealthy(1500)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

function keepAlive(label) {
  console.log(label);
  setInterval(() => {}, KEEPALIVE_MS);
}

async function main() {
  const startMode = String(env.PORTOS_START_OLLAMA || 'true').toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(startMode)) {
    const label = '🦙 PORTOS_START_OLLAMA=false; leaving Ollama unmanaged.';
    if (isDetached) {
      console.log(label);
      return;
    }
    keepAlive(label);
    return;
  }

  if (await isOllamaHealthy()) {
    const label = `🦙 Ollama already reachable at ${baseUrlFromHost(env.OLLAMA_HOST)}; PortOS will use the existing daemon.`;
    if (isDetached) {
      console.log(label);
      return;
    }
    keepAlive(label);
    return;
  }

  if (!hasOllama()) {
    console.error('🦙 Ollama CLI not found on PATH. Run `npm run setup:llm` or install Ollama, then restart PortOS.');
    process.exit(1);
  }

  console.log(`🦙 Starting Ollama with OLLAMA_HOST=${normalizeHost(env.OLLAMA_HOST || DEFAULT_HOST)}`);

  const child = spawn('ollama', ['serve'], {
    stdio: isDetached ? 'ignore' : 'inherit',
    windowsHide: true,
    detached: isDetached,
    env: ollamaEnv()
  });

  if (isDetached) {
    child.unref();
    const ready = await waitForOllama();
    console.log(ready
      ? `🦙 Ollama is ready at ${baseUrlFromHost(env.OLLAMA_HOST)}.`
      : `🦙 Ollama was launched; ${baseUrlFromHost(env.OLLAMA_HOST)} did not answer before timeout.`);
    return;
  }

  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    console.error(`🦙 Failed to start Ollama: ${error.message}`);
    process.exit(1);
  });
}

await main();
