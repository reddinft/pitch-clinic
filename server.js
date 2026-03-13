#!/usr/bin/env bun
/**
 * Pitch Clinic — Local Server
 * Bun HTTP server proxying Deepgram STT + Anthropic Claude
 * + SQLite session store with share codes
 * + Admin page + voucher system
 *
 * In production (Fly.io): reads keys from env vars.
 * Locally: falls back to 1Password CLI.
 * Run: bun server.js
 */

import { execSync } from 'child_process';
import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
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

db.run(`CREATE TABLE IF NOT EXISTS vouchers (
  code TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT DEFAULT 'admin',
  note TEXT,
  redeemed_at DATETIME,
  redeemed_session_id TEXT,
  is_active INTEGER DEFAULT 1
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

// Admin password — soft fail (disables /admin if unavailable)
let ADMIN_PASSWORD = null;
try {
  ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ||
    execSync('op read "op://OpenClaw-Agents/Pitch Clinic Admin Password/password"', { encoding: 'utf8' }).trim();
  console.log('🔐 Admin password loaded.');
} catch {
  console.warn('⚠️  ADMIN_PASSWORD not set — /admin routes disabled (set ADMIN_PASSWORD env var)');
}

console.log('✅ Keys loaded.');

/* ── Admin session store ──────────────────────────────── */
const adminSessions = new Set();

function generateAdminToken() {
  return randomBytes(32).toString('hex');
}

function isAdminAuthenticated(req) {
  if (!ADMIN_PASSWORD) return false;
  const cookie = req.headers.get('cookie') || '';
  const match = cookie.match(/admin_token=([a-f0-9]{64})/);
  return match && adminSessions.has(match[1]);
}

function generateVoucherCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusables
  const segment = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${segment()}-${segment()}-${segment()}`;
}

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

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders },
  });
}

/* ── Admin HTML ───────────────────────────────────────── */
function renderLoginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pitch Clinic Admin</title>
  <style>
    body { background: #09090b; color: #fafafa; font-family: system-ui, -apple-system, sans-serif;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #111113; border: 1px solid #27272a; border-radius: 12px; padding: 40px; width: 360px; }
    h1 { font-size: 20px; font-weight: 700; margin: 0 0 24px; }
    input { width: 100%; padding: 10px 14px; background: #18181b; border: 1px solid #27272a;
            border-radius: 8px; color: #fafafa; font-size: 14px; box-sizing: border-box; margin-bottom: 16px; }
    input:focus { outline: none; border-color: #dc2626; }
    button { width: 100%; padding: 10px; background: #dc2626; border: none; border-radius: 8px;
             color: white; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #b91c1c; }
    .error { color: #f87171; font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 Pitch Clinic Admin</h1>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="POST" action="/admin/login">
      <input type="password" name="password" placeholder="Admin password" autofocus />
      <button type="submit">Sign In →</button>
    </form>
  </div>
</body>
</html>`;
}

function renderDashboardPage(vouchers) {
  const tierLabel = { standard: 'Standard ($5)', voice: 'Voice ($10)', deep: 'Deep ($20)' };

  const statusCell = (v) => {
    if (!v.is_active) return `<span style="color:#f87171;font-weight:600;">Revoked</span>`;
    if (v.redeemed_at) return `<span style="color:#d97706;font-weight:600;">Used</span><br><span style="font-size:11px;color:#a1a1aa;">${v.redeemed_at.slice(0, 10)}</span>`;
    return `<span style="color:#22c55e;font-weight:600;">Unused</span>`;
  };

  const actionCell = (v) => {
    if (v.is_active && !v.redeemed_at) {
      return `<button onclick="revokeVoucher('${escapeHtml(v.code)}')" style="padding:4px 10px;background:#27272a;border:1px solid #3f3f46;border-radius:6px;color:#f87171;font-size:12px;cursor:pointer;">Revoke</button>`;
    }
    return '';
  };

  const rows = vouchers.length > 0
    ? vouchers.map(v => `
      <tr id="row-${v.code.replace(/-/g, '')}">
        <td><span class="code-chip" onclick="copyCode('${escapeHtml(v.code)}')" title="Click to copy">${escapeHtml(v.code)}</span></td>
        <td>${escapeHtml(v.tier)}</td>
        <td style="color:#a1a1aa;">${escapeHtml(v.note || '—')}</td>
        <td style="color:#a1a1aa;font-size:12px;">${v.created_at.slice(0, 10)}</td>
        <td>${statusCell(v)}</td>
        <td>${actionCell(v)}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" style="text-align:center;color:#52525b;padding:32px;">No vouchers yet</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pitch Clinic Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { background: #09090b; color: #fafafa; font-family: system-ui, -apple-system, sans-serif;
           margin: 0; padding: 24px; min-height: 100vh; }
    .header { display: flex; justify-content: space-between; align-items: center;
               margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid #27272a; }
    h1 { font-size: 22px; font-weight: 800; margin: 0; }
    .btn { padding: 8px 16px; background: #27272a; border: 1px solid #3f3f46;
           border-radius: 8px; color: #fafafa; font-size: 14px; cursor: pointer; font-family: inherit; }
    .btn:hover { background: #3f3f46; }
    .btn-red { background: #dc2626; border-color: #dc2626; }
    .btn-red:hover { background: #b91c1c; border-color: #b91c1c; }
    .card { background: #111113; border: 1px solid #27272a; border-radius: 12px;
             padding: 24px; margin-bottom: 24px; }
    .card h2 { font-size: 16px; font-weight: 700; margin: 0 0 20px; }
    .form-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 16px; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-size: 12px; color: #a1a1aa; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    select, input[type="number"], input[type="text"] {
      padding: 8px 12px; background: #18181b; border: 1px solid #27272a;
      border-radius: 8px; color: #fafafa; font-size: 14px; font-family: inherit; }
    select:focus, input:focus { outline: none; border-color: #dc2626; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 8px 12px; font-size: 11px; color: #71717a;
         text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #27272a; }
    td { padding: 10px 12px; border-bottom: 1px solid #1a1a1d; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .code-chip { font-family: monospace; font-size: 13px; background: #1c1c1e;
                  border: 1px solid #27272a; border-radius: 6px; padding: 3px 8px;
                  cursor: pointer; user-select: all; }
    .code-chip:hover { border-color: #52525b; }
    .generated-codes { margin-top: 16px; display: none; }
    .generated-codes h3 { font-size: 13px; color: #a1a1aa; margin: 0 0 10px; }
    .code-list { display: flex; flex-direction: column; gap: 8px; }
    .code-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
                  background: #18181b; border: 1px solid #27272a; border-radius: 8px; }
    .code-item .code { font-family: monospace; font-size: 15px; flex: 1; letter-spacing: 0.05em; }
    .copy-btn { padding: 4px 10px; background: #27272a; border: 1px solid #3f3f46;
                 border-radius: 6px; color: #a1a1aa; font-size: 12px; cursor: pointer; }
    .copy-btn:hover { color: #fafafa; background: #3f3f46; }
    .toast { position: fixed; bottom: 24px; right: 24px; background: #18181b;
              border: 1px solid #27272a; border-radius: 10px; padding: 12px 20px;
              font-size: 14px; transform: translateY(80px); opacity: 0;
              transition: all 0.2s; z-index: 1000; }
    .toast.show { transform: translateY(0); opacity: 1; }
  </style>
</head>
<body>
  <div style="max-width: 960px; margin: 0 auto;">
    <div class="header">
      <h1>🎯 Pitch Clinic Admin</h1>
      <form method="POST" action="/admin/logout" style="margin:0;">
        <button type="submit" class="btn">Sign Out</button>
      </form>
    </div>

    <!-- Generate Vouchers -->
    <div class="card">
      <h2>🎟️ Generate Voucher Codes</h2>
      <div class="form-row">
        <div class="form-group">
          <label>Tier</label>
          <select id="gen-tier">
            <option value="standard">Standard ($5)</option>
            <option value="voice">Voice ($10)</option>
            <option value="deep">Deep Research ($20)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Count</label>
          <input type="number" id="gen-count" value="1" min="1" max="10" style="width:80px;" />
        </div>
        <div class="form-group" style="flex:1;min-width:200px;">
          <label>Note (optional)</label>
          <input type="text" id="gen-note" placeholder="e.g. for @techcrunch" />
        </div>
        <button class="btn btn-red" onclick="generateVouchers()" id="gen-btn">Generate →</button>
      </div>

      <div class="generated-codes" id="generated-codes">
        <h3>Generated codes — click any to copy</h3>
        <div class="code-list" id="code-list"></div>
      </div>
    </div>

    <!-- All Vouchers -->
    <div class="card">
      <h2>📋 All Vouchers</h2>
      <div style="overflow-x:auto;">
        <table id="vouchers-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Tier</th>
              <th>Note</th>
              <th>Created</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="vouchers-body">
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2000);
    }

    function copyCode(code) {
      navigator.clipboard.writeText(code).then(() => showToast('Copied: ' + code));
    }

    async function generateVouchers() {
      const tier = document.getElementById('gen-tier').value;
      const count = parseInt(document.getElementById('gen-count').value) || 1;
      const note = document.getElementById('gen-note').value.trim();
      const btn = document.getElementById('gen-btn');

      if (count < 1 || count > 10) { showToast('Count must be 1–10'); return; }

      btn.disabled = true;
      btn.textContent = 'Generating…';

      try {
        const res = await fetch('/admin/vouchers/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier, count, note: note || null })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Generation failed');

        // Show generated codes
        const container = document.getElementById('generated-codes');
        const list = document.getElementById('code-list');
        container.style.display = 'block';
        list.innerHTML = '';

        for (const v of data.vouchers) {
          const item = document.createElement('div');
          item.className = 'code-item';
          item.innerHTML = \`
            <span class="code">\${v.code}</span>
            <span style="font-size:12px;color:#a1a1aa;">\${v.tier}</span>
            \${v.note ? \`<span style="font-size:12px;color:#71717a;">\${v.note}</span>\` : ''}
            <button class="copy-btn" onclick="copyCode('\${v.code}')">Copy</button>
          \`;
          list.appendChild(item);
        }

        // Refresh table
        await refreshTable();
        showToast(\`Generated \${data.vouchers.length} code\${data.vouchers.length > 1 ? 's' : ''}\`);
      } catch (e) {
        showToast('Error: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Generate →';
      }
    }

    async function revokeVoucher(code) {
      if (!confirm(\`Revoke voucher \${code}? This cannot be undone.\`)) return;
      try {
        const res = await fetch('/admin/vouchers/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Revoke failed'); }
        await refreshTable();
        showToast('Voucher revoked');
      } catch (e) {
        showToast('Error: ' + e.message);
      }
    }

    async function refreshTable() {
      const res = await fetch('/admin/vouchers');
      const vouchers = await res.json();
      const tbody = document.getElementById('vouchers-body');

      if (!vouchers.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#52525b;padding:32px;">No vouchers yet</td></tr>';
        return;
      }

      tbody.innerHTML = vouchers.map(v => {
        const statusHtml = !v.is_active
          ? '<span style="color:#f87171;font-weight:600;">Revoked</span>'
          : v.redeemed_at
            ? \`<span style="color:#d97706;font-weight:600;">Used</span><br><span style="font-size:11px;color:#a1a1aa;">\${v.redeemed_at.slice(0, 10)}</span>\`
            : '<span style="color:#22c55e;font-weight:600;">Unused</span>';

        const actionHtml = v.is_active && !v.redeemed_at
          ? \`<button onclick="revokeVoucher('\${v.code}')" style="padding:4px 10px;background:#27272a;border:1px solid #3f3f46;border-radius:6px;color:#f87171;font-size:12px;cursor:pointer;">Revoke</button>\`
          : '';

        return \`<tr>
          <td><span class="code-chip" onclick="copyCode('\${v.code}')" title="Click to copy">\${v.code}</span></td>
          <td>\${v.tier}</td>
          <td style="color:#a1a1aa;">\${v.note || '—'}</td>
          <td style="color:#a1a1aa;font-size:12px;">\${v.created_at.slice(0, 10)}</td>
          <td>\${statusHtml}</td>
          <td>\${actionHtml}</td>
        </tr>\`;
      }).join('');
    }
  </script>
</body>
</html>`;
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
  const d = result.dimensions || {};
  const killShot = d.vc_kill_shot?.question || '';
  const killWhy = d.vc_kill_shot?.why || '';
  const founderName = result.founder_name || 'Anonymous Founder';
  const verdict = result.overall_verdict || '';
  const scoreColor = score >= 80 ? '#16a34a' : score >= 60 ? '#d97706' : '#dc2626';
  const scoreBg = score >= 80 ? 'rgba(22,163,74,0.1)' : score >= 60 ? 'rgba(217,119,6,0.1)' : 'rgba(220,38,38,0.1)';
  const scoreBorder = score >= 80 ? 'rgba(22,163,74,0.3)' : score >= 60 ? 'rgba(217,119,6,0.3)' : 'rgba(220,38,38,0.3)';
  const shareUrl = `https://pitch-clinic.fly.dev/r/${session.short_code}`;

  const dimLabels = {
    hook: 'Hook', problem_clarity: 'Problem Clarity', solution: 'Solution',
    market_size: 'Market Size', business_model: 'Business Model',
    traction: 'Traction', founder_market_fit: 'Founder-Market Fit',
  };

  const dimCards = Object.entries(dimLabels).map(([key, label]) => {
    const dim = d[key];
    if (!dim) return '';
    const c = dim.score >= 80 ? '#16a34a' : dim.score >= 60 ? '#d97706' : '#dc2626';
    const pct = Math.round(dim.score);
    return `
      <div style="background:#111113;border:1px solid #27272a;border-left:3px solid ${c};border-radius:10px;padding:16px 18px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">
          <span style="font-size:11px;font-weight:700;color:#71717a;text-transform:uppercase;letter-spacing:.06em;">${escapeHtml(label)}</span>
          <span style="font-size:22px;font-weight:900;color:${c};">${dim.score}<span style="font-size:11px;color:#52525b;">/100</span></span>
        </div>
        <div style="height:3px;background:#27272a;border-radius:2px;margin-bottom:10px;">
          <div style="height:100%;width:${pct}%;background:${c};border-radius:2px;"></div>
        </div>
        <p style="margin:0;font-size:13px;color:#a1a1aa;line-height:1.5;">${escapeHtml(dim.verdict || '')}</p>
      </div>`;
  }).join('');

  const nextSteps = (result.next_steps || []).map((s, i) =>
    `<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:8px;">
      <span style="min-width:22px;height:22px;background:#dc2626;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;">${i+1}</span>
      <span style="font-size:14px;color:#e2e8f0;line-height:1.5;">${escapeHtml(s)}</span>
    </div>`
  ).join('');

  const xText = encodeURIComponent(`Just got my startup pitch destroyed by AI — scored ${score}/100.\n\nThe kill shot: "${killShot.slice(0,80)}..."\n\nCan you beat me? ${shareUrl}`);
  const liText = encodeURIComponent(`Ran my startup pitch through Pitch Clinic — scored ${score}/100. The AI found the exact question that would've ended my investor meeting.\n\n→ ${shareUrl}`);
  const fbText = encodeURIComponent(shareUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(founderName)} scored ${score}/100 — Pitch Clinic</title>
  <meta property="og:title" content="${escapeHtml(founderName)} scored ${score}/100 on Pitch Clinic" />
  <meta property="og:description" content="${escapeHtml(verdict)} | Kill shot: ${escapeHtml(killShot)}" />
  <meta property="og:image" content="https://pitch-clinic.fly.dev/og/${session.short_code}" />
  <meta property="og:url" content="${shareUrl}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(founderName)}: ${score}/100 on Pitch Clinic" />
  <meta name="twitter:description" content="${escapeHtml(verdict)}" />
  <meta name="twitter:image" content="https://pitch-clinic.fly.dev/og/${session.short_code}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:#09090b;color:#fafafa;font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:24px 16px 60px;}
    a{text-decoration:none;}
    .container{max-width:680px;margin:0 auto;}
    .brand{font-size:13px;font-weight:700;color:#52525b;letter-spacing:.08em;text-transform:uppercase;margin-bottom:32px;display:flex;align-items:center;gap:8px;}
    .brand a{color:#dc2626;}
    .score-wrap{text-align:center;margin-bottom:32px;}
    .score-num{font-size:108px;font-weight:900;line-height:1;color:${scoreColor};text-shadow:0 0 60px ${scoreColor}44;}
    .score-denom{font-size:28px;font-weight:300;color:#52525b;}
    .founder{font-size:20px;font-weight:700;color:#fafafa;margin-bottom:8px;}
    .verdict{font-size:15px;color:#a1a1aa;max-width:480px;margin:0 auto 32px;line-height:1.6;text-align:center;}
    .section-title{font-size:11px;font-weight:700;color:#52525b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:14px;}
    .dim-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin-bottom:28px;}
    .kill-shot{background:#111113;border:2px solid rgba(202,138,4,0.3);border-radius:12px;padding:20px 22px;margin-bottom:28px;box-shadow:0 0 24px rgba(202,138,4,0.08);}
    .kill-label{font-size:11px;font-weight:700;color:#ca8a04;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px;}
    .kill-q{font-size:16px;font-weight:600;color:#fde68a;font-style:italic;border-left:3px solid #ca8a04;padding-left:14px;margin-bottom:10px;line-height:1.5;}
    .kill-why{font-size:13px;color:#a1a1aa;line-height:1.5;}
    .callout-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:28px;}
    .callout{padding:18px 20px;border-radius:12px;}
    .callout-green{background:rgba(22,163,74,0.08);border:1px solid rgba(22,163,74,0.25);}
    .callout-red{background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.25);}
    .callout-label{font-size:13px;font-weight:700;margin-bottom:6px;}
    .callout-text{font-size:13px;color:#a1a1aa;line-height:1.5;}
    .hook-box{background:#111113;border:1px solid #27272a;border-left:3px solid #16a34a;border-radius:10px;padding:18px 20px;margin-bottom:28px;}
    .hook-label{font-size:11px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px;}
    .hook-text{font-size:15px;color:#bbf7d0;font-style:italic;line-height:1.6;}
    .share-section{background:#111113;border:1px solid #27272a;border-radius:14px;padding:24px;margin-bottom:28px;text-align:center;}
    .share-url{font-family:monospace;font-size:12px;color:#52525b;margin-bottom:16px;}
    .share-btns{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:16px;}
    .share-btn{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;}
    .qr-wrap{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:16px;}
    .cta-btn{display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:#dc2626;border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:700;cursor:pointer;margin-top:8px;text-decoration:none;}
    .cta-btn:hover{background:#b91c1c;}
    @media(max-width:520px){.callout-row{grid-template-columns:1fr;} .score-num{font-size:80px;}}
  </style>
</head>
<body>
  <div class="container">

    <div class="brand">
      <span>🎯 Pitch Clinic</span>
      <span style="color:#27272a;">|</span>
      <span>Shared Result</span>
    </div>

    <!-- Score -->
    <div class="score-wrap">
      <div class="founder">${escapeHtml(founderName)}</div>
      <div><span class="score-num">${score}</span><span class="score-denom">/100</span></div>
      <p class="verdict">${escapeHtml(verdict)}</p>
    </div>

    <!-- Dimensions -->
    <p class="section-title">Breakdown</p>
    <div class="dim-grid">${dimCards}</div>

    <!-- Kill Shot -->
    <div class="kill-shot">
      <div class="kill-label">⚡ The Deal-Killer</div>
      <div class="kill-q">${escapeHtml(killShot)}</div>
      <div class="kill-why">${escapeHtml(killWhy)}</div>
    </div>

    <!-- Strength / Fix -->
    <div class="callout-row">
      <div class="callout callout-green">
        <div class="callout-label" style="color:#4ade80;">💪 Biggest Strength</div>
        <div class="callout-text">${escapeHtml(result.biggest_strength || '')}</div>
      </div>
      <div class="callout callout-red">
        <div class="callout-label" style="color:#f87171;">🎯 Fix One Thing</div>
        <div class="callout-text">${escapeHtml(result.fix_one_thing || '')}</div>
      </div>
    </div>

    <!-- Hook rewrite -->
    ${result.rewrite_the_hook ? `
    <div class="hook-box">
      <div class="hook-label">✏️ Better Opening Line</div>
      <div class="hook-text">"${escapeHtml(result.rewrite_the_hook)}"</div>
    </div>` : ''}

    <!-- Next Steps -->
    ${nextSteps ? `
    <p class="section-title">Next Steps</p>
    <div style="background:#111113;border:1px solid #27272a;border-radius:10px;padding:18px 20px;margin-bottom:28px;">${nextSteps}</div>` : ''}

    <!-- Momentum Signal -->
    ${result.momentum_signal ? `
    <p style="text-align:center;font-style:italic;color:#a1a1aa;font-size:14px;margin-bottom:28px;line-height:1.6;">${escapeHtml(result.momentum_signal)}</p>` : ''}

    <!-- Share -->
    <div class="share-section">
      <div class="share-url">${shareUrl}</div>
      <div class="share-btns">
        <a href="https://twitter.com/intent/tweet?text=${xText}" target="_blank" class="share-btn" style="background:#000;color:#fff;">𝕏 Share on X</a>
        <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}" target="_blank" class="share-btn" style="background:#0a66c2;color:#fff;">💼 LinkedIn</a>
        <a href="https://www.facebook.com/sharer/sharer.php?u=${fbText}" target="_blank" class="share-btn" style="background:#1877f2;color:#fff;">📘 Facebook</a>
      </div>
      <div class="qr-wrap">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&bgcolor=111113&color=fafafa&qzone=1&data=${encodeURIComponent(shareUrl)}"
             alt="QR code" width="140" height="140" style="border-radius:10px;border:1px solid #27272a;" />
        <span style="font-size:11px;color:#52525b;">Scan to share</span>
      </div>
    </div>

    <!-- CTA -->
    <div style="text-align:center;">
      <a href="https://pitch-clinic.fly.dev" class="cta-btn">Think you can score higher? →</a>
    </div>

  </div>
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

    /* ── Admin routes ──────────────────────────────────── */

    // GET /admin — login page or dashboard
    if (method === 'GET' && url.pathname === '/admin') {
      if (!ADMIN_PASSWORD) return htmlResponse('<h1>Admin not configured</h1>', 503);
      if (!isAdminAuthenticated(req)) return htmlResponse(renderLoginPage());
      const vouchers = db.query('SELECT * FROM vouchers ORDER BY created_at DESC').all();
      return htmlResponse(renderDashboardPage(vouchers));
    }

    // POST /admin/login
    if (method === 'POST' && url.pathname === '/admin/login') {
      if (!ADMIN_PASSWORD) return htmlResponse('<h1>Admin not configured</h1>', 503);
      try {
        const formData = await req.formData();
        const password = formData.get('password') || '';
        if (password !== ADMIN_PASSWORD) {
          return htmlResponse(renderLoginPage('Incorrect password'));
        }
        const token = generateAdminToken();
        adminSessions.add(token);
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/admin',
            'Set-Cookie': `admin_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`,
          },
        });
      } catch (err) {
        return htmlResponse(renderLoginPage('Login error: ' + err.message));
      }
    }

    // POST /admin/logout
    if (method === 'POST' && url.pathname === '/admin/logout') {
      const cookie = req.headers.get('cookie') || '';
      const match = cookie.match(/admin_token=([a-f0-9]{64})/);
      if (match) adminSessions.delete(match[1]);
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/admin',
          'Set-Cookie': 'admin_token=; HttpOnly; Path=/; Max-Age=0',
        },
      });
    }

    // POST /admin/vouchers/generate
    if (method === 'POST' && url.pathname === '/admin/vouchers/generate') {
      if (!isAdminAuthenticated(req)) return jsonResponse({ error: 'Unauthorized' }, 401);
      try {
        const { tier, count = 1, note = null } = await req.json();
        const validTiers = ['standard', 'voice', 'deep'];
        if (!validTiers.includes(tier)) return jsonResponse({ error: 'Invalid tier' }, 400);
        const cnt = Math.min(10, Math.max(1, parseInt(count) || 1));

        const generated = [];
        const stmt = db.prepare('INSERT INTO vouchers (code, tier, note) VALUES (?, ?, ?)');
        for (let i = 0; i < cnt; i++) {
          let code;
          for (let j = 0; j < 10; j++) {
            code = generateVoucherCode();
            const exists = db.query('SELECT code FROM vouchers WHERE code = ?').get(code);
            if (!exists) break;
          }
          stmt.run(code, tier, note || null);
          generated.push({ code, tier, note: note || null });
        }

        console.log(`🎟️  Generated ${cnt} ${tier} voucher(s)`);
        return jsonResponse({ vouchers: generated });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // GET /admin/vouchers — list all vouchers as JSON
    if (method === 'GET' && url.pathname === '/admin/vouchers') {
      if (!isAdminAuthenticated(req)) return jsonResponse({ error: 'Unauthorized' }, 401);
      const vouchers = db.query('SELECT * FROM vouchers ORDER BY created_at DESC').all();
      return jsonResponse(vouchers);
    }

    // POST /admin/vouchers/revoke
    if (method === 'POST' && url.pathname === '/admin/vouchers/revoke') {
      if (!isAdminAuthenticated(req)) return jsonResponse({ error: 'Unauthorized' }, 401);
      try {
        const { code } = await req.json();
        if (!code) return jsonResponse({ error: 'Missing code' }, 400);
        const normalised = code.trim().toUpperCase();
        const voucher = db.query('SELECT * FROM vouchers WHERE code = ?').get(normalised);
        if (!voucher) return jsonResponse({ error: 'Voucher not found' }, 404);
        db.run('UPDATE vouchers SET is_active = 0 WHERE code = ?', [normalised]);
        return jsonResponse({ success: true });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    /* ── Voucher API ────────────────────────────────────── */

    // POST /api/validate-voucher
    if (method === 'POST' && url.pathname === '/api/validate-voucher') {
      try {
        const { code } = await req.json();
        if (!code) return jsonResponse({ valid: false, reason: 'Missing code' });
        const normalised = code.trim().toUpperCase().replace(/\s/g, '');
        const voucher = db.query('SELECT * FROM vouchers WHERE code = ?').get(normalised);
        if (!voucher) return jsonResponse({ valid: false, reason: 'Invalid code' });
        if (!voucher.is_active) return jsonResponse({ valid: false, reason: 'This code has been revoked' });
        if (voucher.redeemed_at) return jsonResponse({ valid: false, reason: 'This code has already been used' });
        return jsonResponse({ valid: true, tier: voucher.tier });
      } catch (err) {
        return jsonResponse({ valid: false, reason: 'Server error' }, 500);
      }
    }

    // POST /api/redeem-voucher — mark voucher as used after analysis
    if (method === 'POST' && url.pathname === '/api/redeem-voucher') {
      try {
        const { code, sessionId } = await req.json();
        if (!code) return jsonResponse({ error: 'Missing code' }, 400);
        const normalised = code.trim().toUpperCase().replace(/\s/g, '');
        const voucher = db.query('SELECT * FROM vouchers WHERE code = ?').get(normalised);
        if (!voucher) return jsonResponse({ error: 'Voucher not found' }, 404);
        if (!voucher.is_active) return jsonResponse({ error: 'Voucher is revoked' }, 400);
        if (voucher.redeemed_at) return jsonResponse({ error: 'Already redeemed' }, 400);
        const now = new Date().toISOString();
        db.run(
          'UPDATE vouchers SET redeemed_at = ?, redeemed_session_id = ? WHERE code = ?',
          [now, sessionId || null, normalised]
        );
        console.log(`🎟️  Voucher redeemed: ${normalised} (session: ${sessionId || 'unknown'})`);
        return jsonResponse({ success: true });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    /* ── Existing routes ──────────────────────────────── */

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

        console.log(`💾 Session saved: ${shortCode} (score=${overallScore}, tier=${tier}, founder=${founderName})`);

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
console.log(`   → Admin:         http://localhost:${PORT}/admin`);
console.log(`   → Anthropic API: http://localhost:${PORT}/api/anthropic`);
console.log(`   → Transcribe:    http://localhost:${PORT}/api/transcribe`);
console.log(`   → Save session:  http://localhost:${PORT}/api/save-session`);
console.log(`   → Share page:    http://localhost:${PORT}/r/:shortCode`);
console.log(`   → OG image:      http://localhost:${PORT}/og/:shortCode`);
console.log(`   → Validate:      http://localhost:${PORT}/api/validate-voucher`);
