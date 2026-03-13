#!/usr/bin/env bun
/**
 * Pitch Clinic — Local Server
 * Bun HTTP server proxying Deepgram STT + Anthropic Claude
 *
 * In production (Fly.io): reads keys from env vars.
 * Locally: falls back to 1Password CLI.
 * Run: bun server.js
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const PORT = process.env.PORT || 3000;
const __dirname = new URL('.', import.meta.url).pathname;

/* ── Load API Keys ────────────────────────────────────── */
function getApiKey(opPath, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    return execSync(`op read "${opPath}"`, { encoding: 'utf8' }).trim();
  } catch {
    console.error(`❌ Missing ${envVar} env var and 1Password unavailable`);
    process.exit(1);
  }
}

console.log('🔑 Loading API keys...');
const DEEPGRAM_API_KEY = getApiKey('op://OpenClaw-Agents/Deepgram API Key - sandsync/credential', 'DEEPGRAM_API_KEY');
const ANTHROPIC_API_KEY = getApiKey('op://OpenClaw/Anthropic API Key/notesPlain', 'ANTHROPIC_API_KEY');
console.log('✅ Keys loaded.');

/* ── CORS Headers ─────────────────────────────────────── */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function errorResponse(msg, status = 500) {
  return jsonResponse({ error: msg }, status);
}

/* ── /api/transcribe ──────────────────────────────────── */
async function handleTranscribe(body) {
  if (!body.audio) throw new Error('Missing audio field');

  const audioBuffer = Buffer.from(body.audio, 'base64');
  const mimeType = body.mimeType || 'audio/webm';

  const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=en', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': mimeType,
    },
    body: audioBuffer,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Deepgram error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  return { text };
}

/* ── /api/anthropic ───────────────────────────────────── */
async function handleAnthropic(body) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic error ${response.status}: ${errText}`);
  }

  return await response.json();
}

/* ── Static file serving ──────────────────────────────── */
function serveFile(filePath, contentType) {
  try {
    const content = readFileSync(filePath);
    return new Response(content, {
      headers: { ...CORS_HEADERS, 'Content-Type': contentType },
    });
  } catch {
    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  }
}

/* ── Main Server ──────────────────────────────────────── */
const server = Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST /api/transcribe
    if (method === 'POST' && url.pathname === '/api/transcribe') {
      try {
        const body = await req.json();
        const result = await handleTranscribe(body);
        return jsonResponse(result);
      } catch (err) {
        console.error('Transcribe error:', err.message);
        return errorResponse(err.message);
      }
    }

    // POST /api/anthropic
    if (method === 'POST' && url.pathname === '/api/anthropic') {
      try {
        const body = await req.json();
        const result = await handleAnthropic(body);
        return jsonResponse(result);
      } catch (err) {
        console.error('Anthropic error:', err.message);
        return errorResponse(err.message);
      }
    }

    // GET / → serve index.html
    if (method === 'GET') {
      return serveFile(join(__dirname, 'index.html'), 'text/html');
    }

    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  },

  error(err) {
    console.error('Server error:', err);
    return new Response('Internal Server Error', { status: 500 });
  },
});

console.log(`🎯 Pitch Clinic running at http://localhost:${PORT}`);
console.log(`   → Frontend: http://localhost:${PORT}/`);
console.log(`   → API:      http://localhost:${PORT}/api/anthropic`);
console.log(`   → API:      http://localhost:${PORT}/api/transcribe`);
