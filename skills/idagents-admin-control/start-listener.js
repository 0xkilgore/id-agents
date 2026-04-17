#!/usr/bin/env node
/**
 * Admin Listener - Temporary HTTP server to receive replies from the manager
 *
 * Usage: node start-listener.js [port]
 * Default port: 4050
 *
 * Receives POST /news with replies and prints them to stdout.
 * Exits when it receives a message with type "admin.done" or after timeout.
 */

import http from 'http';
const port = parseInt(process.argv[2]) || process.env.ADMIN_LISTENER_PORT || 4050;
const timeout = parseInt(process.env.ADMIN_LISTENER_TIMEOUT) || 600000; // 10 min default

// Store received messages
const messages = [];

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // GET /news - return received messages
  if (req.method === 'GET' && req.url.startsWith('/news')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: messages, total: messages.length }));
    return;
  }

  // POST /news - receive messages/replies
  if (req.method === 'POST' && req.url === '/news') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const timestamp = Date.now();

        const message = {
          type: data.type || 'message',
          from: data.from || 'unknown',
          message: data.message || '',
          in_reply_to: data.in_reply_to,
          timestamp,
          data: data.data || {}
        };

        messages.push(message);

        // Print to stdout for Claude Code to see
        console.log('\n' + '='.repeat(50));
        console.log(`REPLY RECEIVED [${new Date(timestamp).toLocaleTimeString()}]`);
        console.log('='.repeat(50));
        console.log(`From: ${message.from}`);
        if (message.in_reply_to) {
          console.log(`In reply to: ${message.in_reply_to}`);
        }
        console.log(`Message: ${message.message}`);
        console.log('='.repeat(50) + '\n');

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, timestamp }));

        // Check for done signal
        if (data.type === 'admin.done') {
          console.log('Received done signal, shutting down listener...');
          setTimeout(() => process.exit(0), 100);
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', messages: messages.length }));
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Admin listener started on http://127.0.0.1:${port}`);
  console.log(`Waiting for replies... (timeout: ${timeout/1000}s)`);
  console.log('Press Ctrl+C to stop\n');
});

// Timeout - auto-shutdown after period of inactivity
const timeoutId = setTimeout(() => {
  console.log('Listener timeout, shutting down...');
  process.exit(0);
}, timeout);

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.log('\nShutting down listener...');
  clearTimeout(timeoutId);
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  clearTimeout(timeoutId);
  server.close(() => process.exit(0));
});
