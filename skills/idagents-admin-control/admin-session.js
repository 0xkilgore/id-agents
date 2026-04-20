#!/usr/bin/env node
/**
 * Admin Session - Complete admin agent session for Claude Code
 *
 * This script:
 * 1. Starts a temporary listener for replies
 * 2. Provides functions to talk to manager and execute commands
 * 3. Handles the full request/response cycle
 *
 * Usage: node admin-session.js [action] [args...]
 *
 * Actions:
 *   talk "message"      - Send message to manager, wait for reply
 *   remote "/command"   - Execute remote command
 *   listen              - Start listener only (for manual use)
 *
 * Environment:
 *   MANAGER_URL         - Manager daemon endpoint for /remote dispatch (default: http://127.0.0.1:4100)
 *   REPL_URL            - Interactive CLI endpoint for /talk to the human operator (default: http://127.0.0.1:4000)
 *   ADMIN_API_KEY       - API key (default: from ~/.id-agents/admin.key)
 *   ADMIN_LISTENER_PORT - Listener port (default: 4100)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const MANAGER_URL = process.env.MANAGER_URL || 'http://127.0.0.1:4100';
const REPL_URL = process.env.REPL_URL || 'http://127.0.0.1:4000';
const REPLY_TIMEOUT = parseInt(process.env.ADMIN_REPLY_TIMEOUT) || 300000; // 5 min

// Find an available port dynamically
async function findAvailablePort(startPort = 4100, endPort = 4199) {
  for (let port = startPort; port <= endPort; port++) {
    const isAvailable = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '0.0.0.0');
    });
    if (isAvailable) return port;
  }
  throw new Error(`No available port found in range ${startPort}-${endPort}`);
}

// Load API key
function loadApiKey() {
  if (process.env.ADMIN_API_KEY) return process.env.ADMIN_API_KEY;
  const keyPath = path.join(process.env.HOME || '/tmp', '.id-agents', 'admin.key');
  try {
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch {
    return null;
  }
}

// HTTP request helper
async function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Start temporary listener and wait for a reply
function startListenerAndWait(queryId, port) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/news') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            console.log(`\nReceived reply from ${data.from || 'unknown'}`);

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));

            // Check if this is the reply we're waiting for
            if (!resolved && (!queryId || data.in_reply_to === queryId)) {
              resolved = true;
              server.close();
              resolve(data);
            }
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`Listener started on port ${port}`);
    });

    // Timeout
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.close();
        reject(new Error('Timeout waiting for reply'));
      }
    }, REPLY_TIMEOUT);

    server.on('close', () => clearTimeout(timeout));
  });
}

// Talk to manager and wait for reply
async function talkToManager(message) {
  console.log(`\nSending to manager: "${message}"`);

  // Find an available port dynamically
  const port = process.env.ADMIN_LISTENER_PORT
    ? parseInt(process.env.ADMIN_LISTENER_PORT)
    : await findAvailablePort();

  // Start listener first
  const listenerPromise = startListenerAndWait(null, port);

  // Give listener a moment to start
  await new Promise(r => setTimeout(r, 100));

  // Send message to the interactive REPL (/talk only lives there)
  const response = await httpRequest(`${REPL_URL}/talk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      from: 'admin',
      reply_endpoint: `http://127.0.0.1:${port}/news`
    })
  });

  if (response.status !== 202 && response.status !== 200) {
    throw new Error(`Failed to send message: ${JSON.stringify(response.data)}`);
  }

  console.log(`Message sent, query_id: ${response.data.query_id}`);
  console.log('Waiting for reply...\n');

  // Wait for reply
  const reply = await listenerPromise;
  return reply;
}

// Execute remote command
async function remoteCommand(command) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    throw new Error('No API key found. Set ADMIN_API_KEY or create ~/.id-agents/admin.key');
  }

  console.log(`\nExecuting: ${command}`);

  const response = await httpRequest(`${MANAGER_URL}/remote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    body: JSON.stringify({ command, from: 'admin' })
  });

  if (response.data.ok) {
    console.log('\nSuccess!');
    console.log(response.data.result);
    return response.data;
  } else {
    throw new Error(response.data.error || 'Command failed');
  }
}

// Main
async function main() {
  const action = process.argv[2];
  const args = process.argv.slice(3).join(' ');

  try {
    switch (action) {
      case 'talk':
        if (!args) {
          console.log('Usage: node admin-session.js talk "message"');
          process.exit(1);
        }
        const reply = await talkToManager(args);
        console.log('\n=== Reply ===');
        console.log(`From: ${reply.from}`);
        console.log(`Message: ${reply.message}`);
        break;

      case 'remote':
        if (!args) {
          console.log('Usage: node admin-session.js remote "/command"');
          process.exit(1);
        }
        await remoteCommand(args);
        break;

      case 'listen':
        const listenPort = process.env.ADMIN_LISTENER_PORT
          ? parseInt(process.env.ADMIN_LISTENER_PORT)
          : await findAvailablePort();
        console.log(`Starting listener on port ${listenPort} (Ctrl+C to stop)...`);
        await startListenerAndWait(null, listenPort);
        break;

      default:
        console.log('Admin Session - Claude Code Admin Agent');
        console.log('');
        console.log('Usage: node admin-session.js <action> [args]');
        console.log('');
        console.log('Actions:');
        console.log('  talk "message"     - Send message to manager, wait for reply');
        console.log('  remote "/command"  - Execute remote command');
        console.log('  listen             - Start listener only');
        console.log('');
        console.log('Examples:');
        console.log('  node admin-session.js talk "Can I spawn a new agent?"');
        console.log('  node admin-session.js remote "/agents"');
        console.log('  node admin-session.js remote "/spawn my-agent"');
        process.exit(0);
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

main();
