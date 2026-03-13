#!/usr/bin/env bun
/**
 * Pitch Clinic — Local Server
 * Bun HTTP server proxying Deepgram STT + Anthropic Claude
 * + SQLite session store with share codes
 *
 * In production (Fly.io): reads keys from env vars.
 * Locally: falls back to 1Password CLI.
 * Run: bun server.js
 */

import { execSync } from 'child_process';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { Database } from 'bun:sqlite';

const PORT = process.env.PORT || 3000;
const __dirname = new URL('.', import.meta.url).pathname;

/* ── SQLite Session Store ─────────────────────────────── */
const DB_PATH = process.env.NODE_ENV === 'production' ? '/app/data/sessions.db' : './sessions.db';

// Ensure data directory exists in production
if (process.env.NODE_ENV === 'production') {
  try { mkdirSync('/app/data', { recursive: true }); } catch {}
}

const db = new Database(DB_PATH);
db.run(`CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  short_code TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  tier TEXT DEFAULT 'free',
  pitch_text TEXT,
  analysis_json TEXT,
  founder_name TEXT,
  overall_score INTEGER,
  kill_shot TEXT
)`);

console.log(`🗄️  SQLite sessions DB: ${DB_PATH}`);

function generateShortCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no confusables
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

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

/* ── Share page helpers ───────────────────────────────── */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSharePage(session) {
  const result = JSON.parse(session.analysis_json);
  const score = result.overall_score;
  const killShot = result.dimensions?.vc_kill_shot?.question || '';
  const founderName = result.founder_name || 'Anonymous Founder';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(founderName)} scored ${score}/100 on Pitch Clinic</title>
  <meta property="og:title" content="${escapeHtml(founderName)} scored ${score}/100 on Pitch Clinic" />
  <meta property="og:description" content="Kill shot: ${escapeHtml(killShot)}" />
  <meta property="og:image" content="https://pitch-clinic.fly.dev/og/${session.short_code}" />
  <meta property="og:url" content="https://pitch-clinic.fly.dev/r/${session.short_code}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(founderName)}: ${score}/100 on Pitch Clinic" />
  <meta name="twitter:description" content="VC Kill Shot: ${escapeHtml(killShot)}" />
  <meta name="twitter:image" content="https://pitch-clinic.fly.dev/og/${session.short_code}" />
  <style>
    body { background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  </style>
  <script>
    try {
      sessionStorage.setItem('sharedResult', JSON.stringify(${session.analysis_json}));
      sessionStorage.setItem('sharedCode', '${session.short_code}');
    } catch(e) {}
    window.location.replace('/?r=${session.short_code}');
  </script>
</head>
<body>
  <p>Loading pitch analysis...</p>
  <noscript>
    <a href="/?r=${session.short_code}" style="color:#ef4444;">View analysis →</a>
  </noscript>
</body>
</html>`;
}

function generateOgSvg(score, founderName, verdict) {
  const color = score >= 80 ? '#16a34a' : score >= 60 ? '#d97706' : '#dc2626';
  const safeFounder = escapeHtml(String(founderName || 'Pitch Clinic').slice(0, 40));
  const safeVerdict = escapeHtml(String(verdict || '').slice(0, 100));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="8" fill="${color}"/>
  <text x="60" y="76" font-family="system-ui,-apple-system,sans-serif" font-size="28" font-weight="600" fill="#94a3b8">Pitch Clinic 🎯</text>
  <text x="60" y="280" font-family="system-ui,-apple-system,sans-serif" font-size="220" font-weight="900" fill="${color}">${score}</text>
  <text x="390" y="240" font-family="system-ui,-apple-system,sans-serif" font-size="56" font-weight="300" fill="#475569">/100</text>
  <text x="60" y="340" font-family="system-ui,-apple-system,sans-serif" font-size="38" font-weight="700" fill="#e2e8f0">${safeFounder}</text>
  <text x="60" y="390" font-family="system-ui,-apple-system,sans-serif" font-size="24" fill="#94a3b8">${safeVerdict}</text>
  <rect x="60" y="500" width="440" height="72" rx="12" fill="${color}" opacity="0.9"/>
  <text x="280" y="546" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="26" font-weight="700" fill="white">Analyse your pitch →</text>
  <text x="60" y="612" font-family="system-ui,-apple-system,sans-serif" font-size="20" fill="#475569">pitch-clinic.fly.dev</text>
</svg>`;
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

    // POST /api/save-session
    if (method === 'POST' && url.pathname === '/api/save-session') {
      try {
        const body = await req.json();
        const { pitchText, result, tier = 'free' } = body;
        if (!result) return errorResponse('Missing result', 400);

        const id = crypto.randomUUID();
        let shortCode = generateShortCode();
        // Retry on collision (extremely unlikely but safe)
        for (let i = 0; i < 5; i++) {
          const exists = db.prepare('SELECT id FROM sessions WHERE short_code = ?').get(shortCode);
          if (!exists) break;
          shortCode = generateShortCode();
        }

        const founderName = result.founder_name || null;
        const overallScore = result.overall_score || null;
        const killShot = result.dimensions?.vc_kill_shot?.question || null;

        db.prepare(`INSERT INTO sessions (id, short_code, tier, pitch_text, analysis_json, founder_name, overall_score, kill_shot)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, shortCode, tier, pitchText || null,
          JSON.stringify(result), founderName, overallScore, killShot
        );

        console.log(`💾 Session saved: ${shortCode} (score=${overallScore}, founder=${founderName})`);

        return jsonResponse({
          shortCode,
          url: `https://pitch-clinic.fly.dev/r/${shortCode}`,
        });
      } catch (err) {
        console.error('Save session error:', err.message);
        return errorResponse(err.message);
      }
    }

    // GET /api/session/:shortCode
    if (method === 'GET' && url.pathname.startsWith('/api/session/')) {
      const parts = url.pathname.split('/');
      const shortCode = parts[3];
      if (!shortCode) return errorResponse('Missing short code', 400);
      const session = db.prepare('SELECT * FROM sessions WHERE short_code = ?').get(shortCode);
      if (!session) return errorResponse('Session not found', 404);
      return jsonResponse(session);
    }

    // GET /r/:shortCode — share page with OG tags
    if (method === 'GET' && url.pathname.startsWith('/r/')) {
      const parts = url.pathname.split('/');
      const shortCode = parts[2];
      if (!shortCode) return new Response('Not found', { status: 404 });
      const session = db.prepare('SELECT * FROM sessions WHERE short_code = ?').get(shortCode);
      if (!session) {
        return new Response(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="background:#0f172a;color:#e2e8f0;font-family:system-ui;padding:40px;text-align:center;">
  <h1 style="color:#ef4444;">Link not found</h1>
  <p>This share link is invalid or has expired.</p>
  <a href="/" style="color:#ef4444;font-size:1.2em;">← Analyse your own pitch</a>
</body></html>`, {
          status: 404,
          headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
        });
      }
      return new Response(renderSharePage(session), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
      });
    }

    // GET /og/:shortCode — OG image as SVG
    if (method === 'GET' && url.pathname.startsWith('/og/')) {
      const parts = url.pathname.split('/');
      const shortCode = parts[2];
      if (!shortCode) return new Response('Not found', { status: 404 });
      const session = db.prepare('SELECT overall_score, founder_name, analysis_json FROM sessions WHERE short_code = ?').get(shortCode);
      if (!session) return new Response('Not found', { status: 404 });
      const result = JSON.parse(session.analysis_json || '{}');
      const svg = generateOgSvg(session.overall_score || 0, session.founder_name, result.overall_verdict);
      return new Response(svg, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=86400',
        },
      });
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
console.log(`   → Frontend:      http://localhost:${PORT}/`);
console.log(`   → Anthropic API: http://localhost:${PORT}/api/anthropic`);
console.log(`   → Transcribe:    http://localhost:${PORT}/api/transcribe`);
console.log(`   → Save session:  http://localhost:${PORT}/api/save-session`);
console.log(`   → Share page:    http://localhost:${PORT}/r/:shortCode`);
console.log(`   → OG image:      http://localhost:${PORT}/og/:shortCode`);
