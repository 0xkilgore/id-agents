#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import readline from 'readline';
import { InteractiveAgentServer } from './interactive-agent-server.js';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  red: '\x1b[31m'
};

// Agent name is required - you are an agent in the network
const name = process.argv[2];
if (!name) {
  console.error(`\n${colors.red}❌ Error: Agent name is required${colors.reset}`);
  console.log(`\n${colors.gray}Usage: npm run agent <agent-name> [port]${colors.reset}`);
  console.log(`${colors.gray}Example: npm run agent operator${colors.reset}`);
  console.log(`${colors.gray}Example: npm run agent alice 4000${colors.reset}\n`);
  process.exit(1);
}

if (name.toLowerCase() === 'manager') {
  console.error(`\n${colors.red}❌ Error: "manager" is reserved for the daemon-owned manager identity${colors.reset}`);
  console.log(`${colors.gray}Choose another interactive agent name, e.g. "operator" or "alice".${colors.reset}\n`);
  process.exit(1);
}

const port = parseInt(process.argv[3]) || 4000;

const server = new InteractiveAgentServer(name, port);

// Determine endpoint URL for registration
function getEndpointUrl(): string {
  return `http://localhost:${port}`;
}

async function registerWithManager() {
  // Always register - you are an agent in the network
  try {
    const endpoint = getEndpointUrl();
    const response = await fetch('http://localhost:3100/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, endpoint })
    });
    
    if (response.ok) {
      console.log(`${colors.green}✅ Registered as agent "${name}"${colors.reset}`);
      console.log(`${colors.gray}   Endpoint: ${endpoint}${colors.reset}\n`);
    } else {
      console.log(`${colors.yellow}⚠️  Could not register (manager may not be running)${colors.reset}`);
      console.log(`${colors.gray}   You can still use the CLI, but other agents won't discover you${colors.reset}\n`);
    }
  } catch (error) {
    console.log(`${colors.yellow}⚠️  Could not register (manager may not be running)${colors.reset}`);
    console.log(`${colors.gray}   You can still use the CLI, but other agents won't discover you${colors.reset}\n`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let lastPendingCount = 0;
let chatAgent: any | null = null;
let chatSessionId: string | undefined;

function updatePrompt() {
  if (chatAgent) {
    rl.setPrompt(`${colors.green}> [${name}] → [${chatAgent.name}]${colors.reset} `);
  } else {
    rl.setPrompt(`${colors.green}> [${name}]${colors.reset} `);
  }
}

async function displayPendingQuestions(force: boolean = false) {
  const pending = await server.getPendingQueries();
  
  if (pending.length === 0) {
    if (force || lastPendingCount > 0) {
      console.log(`\n${colors.green}✅ All questions answered!${colors.reset}\n`);
    }
    lastPendingCount = 0;
    return;
  }
  
  if (force || pending.length !== lastPendingCount) {
    console.log(`\n${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}${colors.yellow}🔔 ${pending.length} PENDING QUESTION${pending.length > 1 ? 'S' : ''}${colors.reset}\n`);
    
    pending.forEach((q, i) => {
      const time = new Date(q.timestamp).toLocaleTimeString();
      console.log(`${colors.bold}${i + 1}.${colors.reset} ${colors.cyan}[${q.query_id}]${colors.reset}`);
      console.log(`   ${colors.gray}Time:${colors.reset} ${time}`);
      console.log(`   ${colors.bold}Question:${colors.reset} ${q.message}\n`);
    });
    
    console.log(`${colors.gray}💡 Type a number (1-${pending.length}) to respond, or /list to see details${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
    
    lastPendingCount = pending.length;
  }
}

console.log(`\n${colors.bold}${colors.cyan}╔═════════════════════════════════════╗${colors.reset}`);
console.log(`     ${colors.bold}🤖 Agent: ${name}${colors.reset}     `);
console.log(`${colors.bold}${colors.cyan}╚═════════════════════════════════════╝${colors.reset}\n`);

server.start().then(async () => {
  console.log(`${colors.green}✅ Agent "${name}" running on port ${port}${colors.reset}`);
  console.log(`${colors.gray}   Catalog: http://localhost:${port}/.well-known/restap.json${colors.reset}\n`);
  
  await registerWithManager();
  
  console.log(`${colors.bold}📬 Listening for messages from other agents...${colors.reset}\n`);
  console.log(`${colors.gray}Commands:${colors.reset}`);
  console.log(`  ${colors.cyan}<number>${colors.reset}        - Respond to question #1, #2, etc.`);
  console.log(`  ${colors.cyan}/chat <agent> [msg]${colors.reset} - Chat with an agent (changes prompt)`);
  console.log(`  ${colors.cyan}/ask <agent> <msg>${colors.reset} - Ask another agent a question`);
  console.log(`  ${colors.cyan}/spawn <name>${colors.reset}   - Spawn a new local agent`);
  console.log(`  ${colors.cyan}/agents${colors.reset}        - List all agents in the network`);
  console.log(`  ${colors.cyan}/list${colors.reset}          - Show all pending questions`);
  console.log(`  ${colors.cyan}/respond <num|id> [msg]${colors.reset} - Respond to a query`);
  console.log(`  ${colors.cyan}/fetch <agent> [file]${colors.reset} - List or fetch files from an agent`);
  console.log(`  ${colors.cyan}/upload <agent> <file>${colors.reset} - Upload a file to an agent`);
  console.log(`  ${colors.cyan}/help${colors.reset}           - Show this help`);
  console.log(`  ${colors.cyan}/quit${colors.reset}          - Exit\n`);
  
  // Poll for new queries every 2 seconds
  setInterval(() => {
    displayPendingQuestions().catch(() => {});
  }, 2000);
  
  updatePrompt();
  rl.prompt();
});

rl.on('line', async (line) => {
  const input = line.trim();
  
  if (!input) {
    rl.prompt();
    return;
  }
  
  // Handle number input (quick response by index)
  const num = parseInt(input);
  const pending = await server.getPendingQueries();
  
  if (!isNaN(num) && num > 0 && num <= pending.length) {
    const query = pending[num - 1];
    await respondToQuery(query.query_id, query.message);
    rl.prompt();
    return;
  }
  
  // Handle commands
  // If we're in chat mode and user enters a command (starts with /), exit chat mode first
  if (chatAgent && input.startsWith('/')) {
    chatAgent = null;
    chatSessionId = undefined;
    updatePrompt();
  }
  
  if (input === '/quit' || input === '/exit') {
    console.log(`\n${colors.green}👋 Goodbye!${colors.reset}\n`);
    process.exit(0);
  }
  
  if (input === '/list' || input === '/ls') {
    await displayPendingQuestions(true);
    rl.prompt();
    return;
  }
  
  if (input === '/help' || input === '/h') {
    console.log(`\n${colors.bold}Available Commands:${colors.reset}\n`);
    console.log(`  ${colors.cyan}<number>${colors.reset}        - Respond to question by number (1, 2, 3...)`);
    console.log(`  ${colors.cyan}/chat <agent> [message]${colors.reset} - Chat with an agent (changes prompt to > [agent])`);
    console.log(`  ${colors.cyan}/ask <agent> <message>${colors.reset} - Ask another agent a question`);
    console.log(`  ${colors.cyan}/spawn <name> [model]${colors.reset} - Spawn a new local agent`);
    console.log(`  ${colors.cyan}/agents${colors.reset}        - List all agents in the network`);
    console.log(`  ${colors.cyan}/list${colors.reset}          - Show all pending questions`);
    console.log(`  ${colors.cyan}/respond <number|query_id> [response]${colors.reset} - Respond to a query`);
    console.log(`  ${colors.cyan}/fetch <agent> [filename]${colors.reset} - List files (no filename) or fetch a file`);
    console.log(`  ${colors.cyan}/upload <agent> <filepath>${colors.reset} - Upload a file to an agent's workspace`);
    console.log(`  ${colors.cyan}/help${colors.reset}           - Show this help`);
    console.log(`  ${colors.cyan}/quit${colors.reset}          - Exit\n`);
    rl.prompt();
    return;
  }

  if (input === '/chat') {
    console.log(`\n${colors.red}❌ Usage: /chat <agent-name> [message]${colors.reset}`);
    console.log(`${colors.gray}Example: /chat helper${colors.reset}`);
    console.log(`${colors.gray}Example: /chat helper Hello, how are you?${colors.reset}\n`);
    rl.prompt();
    return;
  }

  if (input.startsWith('/chat ')) {
    const rest = input.substring(6).trim();
    if (!rest) {
      console.log(`\n${colors.red}❌ Usage: /chat <agent-name> [message]${colors.reset}\n`);
      rl.prompt();
      return;
    }

    // Parse agent name and optional message
    const parts = rest.split(' ');
    const agentName = parts[0];
    const message = parts.slice(1).join(' ');

    const resolved = await resolveAgent(agentName);
    if (!resolved) {
      rl.prompt();
      return;
    }

    chatAgent = resolved;
    // Keep session per agent (simple single-session; resets when switching agents)
    chatSessionId = undefined;
    updatePrompt();
    console.log(`\n${colors.green}✅ Chatting with ${chatAgent.name}${colors.reset}`);
    console.log(`${colors.gray}   Prompt is now: > [${chatAgent.name}]${colors.reset}\n`);
    
    // If a message was provided, send it immediately
    if (message) {
      await chatWithAgent(chatAgent, message);
    }
    
    rl.prompt();
    return;
  }

  if (input.startsWith('/spawn ')) {
    const parts = input.substring(7).trim().split(' ');
    const agentName = parts[0];
    const model = parts[1]; // Optional
    
    if (!agentName) {
      console.log(`\n${colors.red}❌ Usage: /spawn <name> [model]${colors.reset}`);
      console.log(`${colors.gray}Example: /spawn coder${colors.reset}`);
      console.log(`${colors.gray}Example: /spawn helper claude-sonnet-4-20250514${colors.reset}\n`);
      rl.prompt();
      return;
    }
    
    await spawnAgent(agentName, model);
    rl.prompt();
    return;
  }
  
  if (input === '/agents') {
    await listAgents();
    rl.prompt();
    return;
  }
  
  if (input.startsWith('/ask ')) {
    const parts = input.substring(5).trim().split(' ');
    const agentName = parts[0];
    const message = parts.slice(1).join(' ');
    
    if (!agentName || !message) {
      console.log(`\n${colors.red}❌ Usage: /ask <agent-name> <message>${colors.reset}`);
      console.log(`${colors.gray}Example: /ask helper What should I work on?${colors.reset}\n`);
      rl.prompt();
      return;
    }
    
    await askAgent(agentName, message);
    rl.prompt();
    return;
  }
  
  if (input.startsWith('/respond ')) {
    const rest = input.substring(9).trim();
    if (!rest) {
      console.log(`\n${colors.red}❌ Usage: /respond <number|query_id> [response]${colors.reset}`);
      console.log(`${colors.gray}Example: /respond 1${colors.reset}`);
      console.log(`${colors.gray}Example: /respond 1 Yes, I'm here${colors.reset}`);
      console.log(`${colors.gray}Example: /respond query_123 Yes, I'm here${colors.reset}\n`);
      rl.prompt();
      return;
    }
    
    // Parse query identifier and optional response
    const parts = rest.split(' ');
    const identifier = parts[0];
    const responseText = parts.slice(1).join(' ');
    
    // Check if identifier is a number (index)
    let query;
    const num = parseInt(identifier);
    if (!isNaN(num) && num > 0 && num <= pending.length) {
      query = pending[num - 1];
    } else {
      // Treat as query_id
      query = pending.find(q => q.query_id === identifier);
    }
    
    if (!query) {
      console.log(`\n${colors.red}❌ Query "${identifier}" not found${colors.reset}\n`);
      rl.prompt();
      return;
    }
    
    // If response text provided, send it directly; otherwise prompt interactively
    if (responseText) {
      try {
        await server.respond(query.query_id, responseText);
        console.log(`\n${colors.green}✅ Response sent!${colors.reset}\n`);
        lastPendingCount = 0; // Force refresh
      } catch (error: any) {
        console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
      }
    } else {
      await respondToQuery(query.query_id, query.message);
    }
    
    rl.prompt();
    return;
  }
  
  if (input.startsWith('/fetch ')) {
    const rest = input.substring(7).trim();
    if (!rest) {
      console.log(`\n${colors.red}❌ Usage: /fetch <agent-name> [filename]${colors.reset}`);
      console.log(`${colors.gray}Example: /fetch coder${colors.reset} - List all files`);
      console.log(`${colors.gray}Example: /fetch coder index.html${colors.reset} - Fetch specific file`);
      console.log(`${colors.gray}Example: /fetch helper /tmp/output.txt${colors.reset}\n`);
      rl.prompt();
      return;
    }
    
    const parts = rest.split(' ');
    const agentName = parts[0];
    const filename = parts.slice(1).join(' ');
    
    if (!agentName) {
      console.log(`\n${colors.red}❌ Usage: /fetch <agent-name> [filename]${colors.reset}`);
      console.log(`${colors.gray}Example: /fetch coder${colors.reset} - List all files\n`);
      rl.prompt();
      return;
    }
    
    if (filename) {
      await fetchFile(agentName, filename);
    } else {
      await listFiles(agentName);
    }
    
    rl.prompt();
    return;
  }
  
  if (input.startsWith('/upload ')) {
    const rest = input.substring(8).trim();
    if (!rest) {
      console.log(`\n${colors.red}❌ Usage: /upload <agent-name> <filepath>${colors.reset}`);
      console.log(`${colors.gray}Example: /upload coder ./myfile.html${colors.reset}`);
      console.log(`${colors.gray}Example: /upload coder /path/to/file.txt${colors.reset}\n`);
      rl.prompt();
      return;
    }
    
    const parts = rest.split(' ');
    const agentName = parts[0];
    const filepath = parts.slice(1).join(' ');
    
    if (!agentName || !filepath) {
      console.log(`\n${colors.red}❌ Usage: /upload <agent-name> <filepath>${colors.reset}`);
      console.log(`${colors.gray}Example: /upload coder ./myfile.html${colors.reset}\n`);
      rl.prompt();
      return;
    }
    
    await uploadFile(agentName, filepath);
    rl.prompt();
    return;
  }
  
  // If it's not a number and not a command, treat as response to first pending question
  if (pending.length > 0) {
    const query = pending[0];
    console.log(`\n${colors.yellow}💡 Responding to: ${query.message}${colors.reset}\n`);
    try {
      server.respond(query.query_id, input);
      console.log(`${colors.green}✅ Response sent!${colors.reset}\n`);
      lastPendingCount = 0; // Force refresh
    } catch (error: any) {
      console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
    }
    rl.prompt();
    return;
  }
  
  // If we're in chat mode, send the message to the current chat agent
  if (chatAgent) {
    await chatWithAgent(chatAgent, input);
    rl.prompt();
    return;
  }

  console.log(`\n${colors.yellow}💡 No pending questions. Type /help for commands.${colors.reset}\n`);
  rl.prompt();
});

async function respondToQuery(query_id: string, question: string) {
  console.log(`\n${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}📝 Question:${colors.reset} ${question}`);
  console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  console.log(`${colors.gray}💬 Enter your response (or /cancel to abort):${colors.reset}\n`);
  
  const responseRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${colors.cyan}>>${colors.reset} `
  });
  
  return new Promise<void>((resolve) => {
    responseRl.prompt();
    
    responseRl.once('line', async (responseLine) => {
      const response = responseLine.trim();
      
      if (response === '/cancel' || response === '/c') {
        console.log(`\n${colors.yellow}❌ Response cancelled${colors.reset}\n`);
        responseRl.close();
        resolve();
        return;
      }
      
      if (!response) {
        console.log(`\n${colors.red}❌ Response cannot be empty${colors.reset}\n`);
        responseRl.close();
        resolve();
        return;
      }
      
      try {
        await server.respond(query_id, response);
        console.log(`\n${colors.green}✅ Response sent! The agent will receive it via /news${colors.reset}\n`);
        lastPendingCount = 0; // Force refresh
      } catch (error: any) {
        console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
      }
      
      responseRl.close();
      resolve();
    });
  });
}

async function listAgents() {
  try {
    const response = await fetch('http://localhost:3100/agents');
    if (!response.ok) {
      console.log(`\n${colors.red}❌ Could not fetch agents${colors.reset}\n`);
      return;
    }
    
    const data: any = await response.json();
    const agents = data.agents;
    
    if (agents.length === 0) {
      console.log(`\n${colors.gray}📭 No agents in the network${colors.reset}\n`);
      return;
    }
    
    console.log(`\n${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}🤖 Agents in Network (${agents.length})${colors.reset}\n`);
    
    agents.forEach((agent: any, i: number) => {
      const typeEmoji = agent.type === 'virtual' ? '🧑' : '🤖';
      console.log(`${typeEmoji} ${colors.bold}${agent.name}${colors.reset}`);
      console.log(`   ${colors.gray}Type:${colors.reset} ${agent.type || 'claude'}`);
      if (agent.model) {
        console.log(`   ${colors.gray}Model:${colors.reset} ${agent.model}`);
      }
      console.log(`   ${colors.gray}URL:${colors.reset} ${agent.url}`);
      if (i < agents.length - 1) console.log('');
    });
    
    console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function askAgent(agentName: string, message: string) {
  try {
    console.log(`\n${colors.gray}🔍 Looking for agent "${agentName}"...${colors.reset}`);
    const agent = await resolveAgent(agentName);
    if (!agent) return;

    console.log(`${colors.green}✓${colors.reset} Found ${agent.name}\n`);
    console.log(`${colors.gray}📤 Sending: "${message}"${colors.reset}`);

    const { resultText } = await talkToAgentAndWait(agent, message, undefined, (queryId) => {
      console.log(`${colors.gray}   Query ID: ${queryId}${colors.reset}`);
    });
    console.log(`${colors.bold}${colors.cyan}🤖 ${agent.name}:${colors.reset}`);
    console.log(`${colors.cyan}${resultText}${colors.reset}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function spawnAgent(name: string, model?: string) {
  try {
    console.log(`\n${colors.gray}🚀 Spawning agent "${name}"...${colors.reset}`);
    
    const payload: any = { name };
    if (model) {
      payload.model = model;
    }
    
    const response = await fetch('http://localhost:3100/agents/spawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const error: any = await response.json();
      console.log(`\n${colors.red}❌ Failed to spawn agent: ${error.error}${colors.reset}\n`);
      return;
    }
    
    const agent: any = await response.json();
    
    console.log(`\n${colors.green}✅ Agent spawned successfully!${colors.reset}`);
    console.log(`   ${colors.gray}Name:${colors.reset} ${agent.name}`);
    console.log(`   ${colors.gray}Model:${colors.reset} ${agent.model}`);
    console.log(`   ${colors.gray}Port:${colors.reset} ${agent.port}`);
    console.log(`   ${colors.gray}URL:${colors.reset} ${agent.url}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function resolveAgent(agentNameOrId: string): Promise<any | null> {
  try {
    const listResponse = await fetch('http://localhost:3100/agents');
    if (!listResponse.ok) {
      console.log(`\n${colors.red}❌ Could not fetch agents${colors.reset}\n`);
      return null;
    }

    const data: any = await listResponse.json();
    const agent = data.agents.find((a: any) => a.name === agentNameOrId || a.id === agentNameOrId);

    if (!agent) {
      console.log(`\n${colors.red}❌ Agent "${agentNameOrId}" not found${colors.reset}`);
      console.log(`${colors.gray}Available agents: ${data.agents.map((a: any) => a.name).join(', ')}${colors.reset}\n`);
      return null;
    }

    return agent;
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
    return null;
  }
}

async function talkToAgentAndWait(agent: any, message: string, session_id?: string, onQueryId?: (queryId: string) => void): Promise<{ queryId: string; resultText: string; sessionId?: string; }> {
  const talkResponse = await fetch(`${agent.url}/talk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, session_id })
  });

  if (!talkResponse.ok) {
    throw new Error(`Failed to send message to ${agent.name}`);
  }

  const talkData: any = await talkResponse.json();
  const queryId = talkData.query_id;
  
  // Notify caller immediately with the query_id
  if (onQueryId) {
    onQueryId(queryId);
  }

  const startTime = Date.now();
  const MAX_POLL_TIME = 5 * 60 * 1000; // 5 minutes
  let lastTimestamp = 0;
  const spinner = ['|', '/', '-', '\\'];
  let spinnerIndex = 0;
  let spinnerInterval: NodeJS.Timeout | null = null;

  // Start spinner animation
  const startSpinner = () => {
    spinnerInterval = setInterval(() => {
      process.stdout.write(`\r${colors.gray}${spinner[spinnerIndex]}${colors.reset} Waiting for response...`);
      spinnerIndex = (spinnerIndex + 1) % spinner.length;
    }, 200);
  };

  const stopSpinner = () => {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
    process.stdout.write('\r' + ' '.repeat(50) + '\r'); // Clear the spinner line
  };

  startSpinner();

  try {
    while (Date.now() - startTime < MAX_POLL_TIME) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      const newsResponse = await fetch(`${agent.url}/news?since=${lastTimestamp}&query_id=${queryId}`);
      if (!newsResponse.ok) continue;

      const newsData: any = await newsResponse.json();
      lastTimestamp = newsData.timestamp;

      const completion = newsData.items.find((item: any) => item.type === 'query.completed');
      if (completion) {
        stopSpinner();
        const resultObj = completion.data.result || {};
        return {
          queryId,
          resultText: resultObj.result || 'No response',
          sessionId: resultObj.sessionId
        };
      }

      const failure = newsData.items.find((item: any) => item.type === 'query.failed');
      if (failure) {
        stopSpinner();
        throw new Error(failure.data?.error || 'Agent failed');
      }
    }

    stopSpinner();
  } catch (error) {
    stopSpinner();
    throw error;
  }

  throw new Error(`Timeout: ${agent.name} did not respond within 5 minutes`);
}

async function chatWithAgent(agent: any, message: string): Promise<void> {
  try {
    const { resultText, sessionId } = await talkToAgentAndWait(agent, message, chatSessionId, (queryId) => {
      console.log(`${colors.gray}Query ID: ${queryId}${colors.reset}`);
    });
    if (sessionId) chatSessionId = sessionId;
    console.log(`${colors.cyan}${resultText}${colors.reset}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error chatting with ${agent.name}: ${error.message}${colors.reset}\n`);
  }
}

async function listFiles(agentName: string) {
  try {
    console.log(`\n${colors.gray}🔍 Looking for agent "${agentName}"...${colors.reset}`);
    const agent = await resolveAgent(agentName);
    if (!agent) return;

    console.log(`${colors.green}✓${colors.reset} Found ${agent.name}\n`);
    console.log(`${colors.gray}📋 Listing files...${colors.reset}`);

    const response = await fetch(`${agent.url}/files/list`, {
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.log(`\n${colors.red}❌ Failed to list files: ${response.status} ${response.statusText}${colors.reset}\n`);
      return;
    }

    const data: any = await response.json();
    const files = data.files || [];
    
    if (files.length === 0) {
      console.log(`\n${colors.gray}📭 No files found${colors.reset}\n`);
      return;
    }

    console.log(`\n${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}📁 Files (${files.length})${colors.reset}\n`);
    
    files.forEach((file: any, i: number) => {
      const size = file.size < 1024 
        ? `${file.size} B`
        : file.size < 1024 * 1024
        ? `${(file.size / 1024).toFixed(1)} KB`
        : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
      
      const modified = new Date(file.modified).toLocaleString();
      
      console.log(`${colors.bold}${i + 1}.${colors.reset} ${colors.cyan}${file.path}${colors.reset}`);
      console.log(`   ${colors.gray}Size:${colors.reset} ${size}`);
      console.log(`   ${colors.gray}Modified:${colors.reset} ${modified}`);
      if (i < files.length - 1) console.log('');
    });
    
    console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`\n${colors.gray}💡 Use /fetch ${agentName} <filename> to download a file${colors.reset}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function fetchFile(agentName: string, filename: string) {
  try {
    console.log(`\n${colors.gray}🔍 Looking for agent "${agentName}"...${colors.reset}`);
    const agent = await resolveAgent(agentName);
    if (!agent) return;

    console.log(`${colors.green}✓${colors.reset} Found ${agent.name}\n`);
    console.log(`${colors.gray}📥 Fetching: ${filename}${colors.reset}`);

    // Remove leading slash if present (files endpoint handles it)
    const cleanFilename = filename.startsWith('/') ? filename.substring(1) : filename;
    const fileUrl = `${agent.url}/files/${cleanFilename}`;

    const response = await fetch(fileUrl);
    
    if (!response.ok) {
      if (response.status === 404) {
        console.log(`\n${colors.red}❌ File not found: ${filename}${colors.reset}`);
        console.log(`${colors.gray}   Make sure the file exists in the agent's workspace or /tmp directory${colors.reset}\n`);
      } else {
        console.log(`\n${colors.red}❌ Failed to fetch file: ${response.status} ${response.statusText}${colors.reset}\n`);
      }
      return;
    }

    const content = await response.text();
    const basename = path.basename(cleanFilename);
    const outputPath = path.join(process.cwd(), basename);

    // Write file to current directory
    fs.writeFileSync(outputPath, content, 'utf8');

    console.log(`\n${colors.green}✅ File fetched successfully!${colors.reset}`);
    console.log(`   ${colors.gray}Saved to:${colors.reset} ${outputPath}`);
    console.log(`   ${colors.gray}Size:${colors.reset} ${content.length} bytes\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function uploadFile(agentName: string, filepath: string) {
  try {
    console.log(`\n${colors.gray}🔍 Looking for agent "${agentName}"...${colors.reset}`);
    const agent = await resolveAgent(agentName);
    if (!agent) return;

    console.log(`${colors.green}✓${colors.reset} Found ${agent.name}\n`);
    
    // Resolve file path (can be relative or absolute)
    const fullPath = path.isAbsolute(filepath) ? filepath : path.join(process.cwd(), filepath);
    
    if (!fs.existsSync(fullPath)) {
      console.log(`\n${colors.red}❌ File not found: ${filepath}${colors.reset}\n`);
      return;
    }
    
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) {
      console.log(`\n${colors.red}❌ Path is not a file: ${filepath}${colors.reset}\n`);
      return;
    }
    
    console.log(`${colors.gray}📤 Uploading: ${filepath}${colors.reset}`);
    console.log(`${colors.gray}   Size: ${stats.size} bytes${colors.reset}`);
    
    const content = fs.readFileSync(fullPath, 'utf8');
    const filename = path.basename(fullPath);
    
    const response = await fetch(`${agent.url}/files/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content })
    });
    
    if (!response.ok) {
      const error: any = await response.json().catch(() => ({ error: response.statusText }));
      console.log(`\n${colors.red}❌ Failed to upload file: ${error.error || response.statusText}${colors.reset}\n`);
      return;
    }
    
    const result: any = await response.json();
    
    console.log(`\n${colors.green}✅ File uploaded successfully!${colors.reset}`);
    console.log(`   ${colors.gray}Filename:${colors.reset} ${result.filename}`);
    console.log(`   ${colors.gray}Path:${colors.reset} ${result.path}`);
    console.log(`   ${colors.gray}Size:${colors.reset} ${result.size} bytes\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

rl.on('close', () => {
  console.log(`\n${colors.green}👋 Goodbye!${colors.reset}\n`);
  process.exit(0);
});
