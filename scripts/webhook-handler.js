#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.WEBHOOK_PORT || 3000;
const CREEM_WEBHOOK_SECRET = process.env.CREEM_WEBHOOK_SECRET;
const CREEM_API_KEY = process.env.CREEM_API_KEY;
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

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function verifySignature(body, signature) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', CREEM_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(signature || '');
  // timingSafeEqual throws if buffers differ in length; guard against that.
  if (expectedBuf.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, sigBuf);
}

function sendEmail(to, licenseKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
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
  if (req.url !== '/webhooks/creem' || req.method !== 'POST') {
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
    const d = event.data || event;
    const email =
      (d.customer && (d.customer.email || d.customer.email_address)) ||
      d.email ||
      d.customer_email ||
      d.billing_email ||
      (d.billing_address && d.billing_address.email);
    if (!email) {
      log('No email in event'); res.writeHead(400); res.end('no email'); return;
    }
    log(`Issuing license for ${email}`);
    execFile(KEYGEN_SCRIPT, [email, 'pro', '365'], { timeout: 30000 }, (err, stdout) => {
      if (err) { log('keygen failed: ' + err.message); res.writeHead(500); res.end('keygen failed'); return; }
      const license = stdout.trim().split('\n').pop();
      log(`Issued: ${license}`);
      sendEmail(email, license).then(() => {
        res.writeHead(200); res.end('ok');
      }).catch(e => {
        log('email failed: ' + e.message);
        res.writeHead(500); res.end('email failed');
      });
    });
  });
});

server.listen(PORT, () => log(`Webhook listener on :${PORT}`));
