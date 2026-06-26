#!/usr/bin/env node

import { spawn, execFileSync } from 'child_process';

const DEFAULT_HOST = '127.0.0.1:11434';
const KEEPALIVE_MS = 60 * 60 * 1000;

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
  const host = normalizeHost(process.env.OLLAMA_HOST || DEFAULT_HOST);
  const env = { ...process.env, OLLAMA_HOST: host };

  if (process.env.OLLAMA_MODELS) {
    env.OLLAMA_MODELS = process.env.OLLAMA_MODELS;
  }

  return env;
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

async function isOllamaHealthy() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(`${baseUrlFromHost(process.env.OLLAMA_HOST)}/api/tags`, {
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

function keepAlive(label) {
  console.log(label);
  setInterval(() => {}, KEEPALIVE_MS);
}

async function main() {
  const startMode = String(process.env.PORTOS_START_OLLAMA || 'true').toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(startMode)) {
    keepAlive('🦙 PORTOS_START_OLLAMA=false; leaving Ollama unmanaged.');
    return;
  }

  if (await isOllamaHealthy()) {
    keepAlive(`🦙 Ollama already reachable at ${baseUrlFromHost(process.env.OLLAMA_HOST)}; PortOS will use the existing daemon.`);
    return;
  }

  if (!hasOllama()) {
    console.error('🦙 Ollama CLI not found on PATH. Run `npm run setup:llm` or install Ollama, then restart PortOS.');
    process.exit(1);
  }

  console.log(`🦙 Starting Ollama with OLLAMA_HOST=${normalizeHost(process.env.OLLAMA_HOST || DEFAULT_HOST)}`);

  const child = spawn('ollama', ['serve'], {
    stdio: 'inherit',
    windowsHide: true,
    env: ollamaEnv()
  });

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
