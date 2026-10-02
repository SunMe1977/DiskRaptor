#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no extra dependency).
// Loads scripts/.env if present; real env vars take precedence.
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (_) {}
})();

const PORT = process.env.WEBHOOK_PORT || 3000;
const CREEM_WEBHOOK_SECRET = process.env.CREEM_WEBHOOK_SECRET;
const CREEM_API_KEY = process.env.CREEM_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'DiskRaptor <noreply@diskraptor.com>';
const KEYGEN_SCRIPT = path.join(__dirname, 'keygen.sh');
const LOG_FILE = path.join(__dirname, 'webhook.log');

if (!CREEM_WEBHOOK_SECRET) {
  console.error('FATAL: CREEM_WEBHOOK_SECRET env var is required');
  process.exit(1);
}
if (!CREEM_API_KEY) {
  console.error('FATAL: CREEM_API_KEY env var is required');
  process.exit(1);
}
// Without Resend every fulfillment would 500 after issuing the license,
// causing Creem retries to mint duplicate licenses without ever emailing.
if (!process.env.RESEND_API_KEY) {
  console.error('FATAL: RESEND_API_KEY env var is required');
  process.exit(1);
}
if (!process.env.RESEND_FROM && !RESEND_FROM) {
  console.error('FATAL: RESEND_FROM env var is required (e.g. DiskRaptor <noreply@diskraptor.com>)');
  process.exit(1);
}

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function verifySignature(body, signature) {
  // Creem sends raw hex; some setups prefix with 'sha256='. Accept both.
  const sig = String(signature || '').trim();
  const hex = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig;
  const expectedHex = crypto
    .createHmac('sha256', CREEM_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  const expectedBuf = Buffer.from('sha256=' + expectedHex);
  const sigBuf = Buffer.from(sig);
  // timingSafeEqual throws if buffers differ in length; guard against that.
  // Fall back to comparing raw hex (without prefix) as well.
  if (expectedBuf.length === sigBuf.length && crypto.timingSafeEqual(expectedBuf, sigBuf)) return true;
  const expHexBuf = Buffer.from(expectedHex);
  const hexBuf = Buffer.from(hex);
  if (expHexBuf.length !== hexBuf.length) return false;
  return crypto.timingSafeEqual(expHexBuf, hexBuf);
}

function sendEmail(to, licenseKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: RESEND_FROM,
      to,
      subject: 'Your DiskRaptor Pro license',
      text: `License key: ${licenseKey}\n\nPaste it into About → Pro to activate.`,
    });
    // NOTE: api.resend.com is HTTPS-only — plain http would fail every send.
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/v1/emails',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error('Email ' + res.statusCode + ': ' + data));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  // req.url contains query string (?...) — strip it and tolerate a trailing
  // slash so '/webhooks/creem/', '/webhooks/creem?x=1' etc. don't 404.
  // A 404 here shows up in Creem's dashboard as failed delivery.
  let pathname = req.url || '';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch (_) {}
  pathname = pathname.replace(/\/+$/, '') || '/';
  if ((pathname !== '/webhooks/creem' && pathname !== '/webhook/creem') || req.method !== 'POST') {
    log(`404 ${req.method} ${req.url}`);
    res.writeHead(404); res.end('not found'); return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    // Creem signs the raw body with an HMAC-SHA256 header. Support the common
    // header spellings so a rename on Creem's side doesn't break verification.
    const sig = req.headers['creem-signature']
      || req.headers['x-creem-signature']
      || req.headers['creem-hmac-sha256']
      || req.headers['x-creem-hmac-sha256']
      || '';
    if (!verifySignature(body, sig)) {
      log('INVALID SIGNATURE');
      res.writeHead(401); res.end('bad signature'); return;
    }
    let event;
    try { event = JSON.parse(body); } catch (_) {
      res.writeHead(400); res.end('bad json'); return;
    }
    // Event type field varies by provider/version. Only issue on checkout completion.
    const eventType = event.type || event.event || event.event_type || event.eventType || '';
    if (!/checkout|order|purchase/i.test(eventType) || /fail|refund|dispute/i.test(eventType)) {
      log('Ignored event: ' + eventType);
      res.writeHead(200); res.end('ignored'); return;
    }
    const d = event.data || event.object || event;
    const email =
      (d.customer && (d.customer.email || d.customer.email_address)) ||
      d.email ||
      d.customer_email ||
      d.billing_email ||
      (d.billing_address && d.billing_address.email) ||
      // Real Creem shape: { eventType, object: { customer: { email } } }
      (event.object && event.object.customer && event.object.customer.email) ||
      (event.data && event.data.object && event.data.object.customer && event.data.object.customer.email) ||
      (event.object && event.object.email);
    if (!email) {
      log('No email in event'); res.writeHead(400); res.end('no email'); return;
    }
    log(`Issuing license for ${email}`);
    let child;
    try {
      child = execFile(KEYGEN_SCRIPT, [email, 'pro', '365'], { timeout: 30000 }, (err, stdout) => {
      if (err) { log('keygen failed: ' + err.message); res.writeHead(500); res.end('keygen failed'); return; }
      // keygen.sh prints a decorated report — the license is the
      // `License:` line, NOT the last line (which is a ━━━ border).
      // Parsed from this process's own stdout, so concurrent checkouts
      // can't steal each other's key (unlike the shared LICENSE.key file).
      const line = String(stdout || '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('License:'));
      const license = line ? line.slice('License:'.length).trim() : '';
      if (!license || license.indexOf('.') < 0) {
        log('keygen output missing License line');
        res.writeHead(500); res.end('keygen failed'); return;
      }
      log(`Issued: ${license}`);
      sendEmail(email, license).then(() => {
        res.writeHead(200); res.end('ok');
      }).catch(e => {
        log('email failed: ' + e.message);
        res.writeHead(500); res.end('email failed');
      });
      });
    } catch (e) {
      // execFile throws synchronously on Windows for .sh (EFTYPE) — don't crash the listener.
      log('keygen spawn failed: ' + (e && e.message ? e.message : e));
      res.writeHead(500); res.end('keygen failed'); return;
    }
  });
});

server.listen(PORT, () => log(`Webhook listener on :${PORT}`));
