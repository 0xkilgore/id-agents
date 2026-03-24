// SPDX-License-Identifier: MIT
/**
 * Interactive CLI for Claude Agent REST-AP Server
 * 
 * Chat with Claude Agent via REST-AP protocol
 */

import 'dotenv/config';
import * as readline from 'readline';
import fetch from 'node-fetch';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  bold: '\x1b[1m'
};

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let agentPort: number | undefined;
  let agentName: string | undefined;
  let listAgents = false;
  
  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      agentPort = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--name' || args[i] === '-n') {
      agentName = args[i + 1];
      i++;
    } else if (args[i] === '--list' || args[i] === '-l') {
      listAgents = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: npm run claude:talk [options]

Options:
  --list, -l            List all available agents
  --port, -p <port>     Connect to agent on specific port (e.g., 4101)
  --name, -n <name>     Connect to agent by name (e.g., "helper")
  --help, -h            Show this help

Examples:
  npm run claude:talk --list           # List all agents
  npm run claude:talk --port 4101     # Connect by port
  npm run claude:talk --name helper    # Connect by name
  npm run claude:talk                  # Connect to default agent on port 4101

Environment Variables:
  CLAUDE_AGENT_URL     Full URL to agent (default: http://localhost:4101)
`);
      process.exit(0);
    }
  }

  // Handle --list command
  if (listAgents) {
    try {
      const response = await fetch('http://localhost:3100/agents');
      const data: any = await response.json();
      
      if (data.agents.length === 0) {
        console.log('📋 No agents running\n');
        console.log('Spawn an agent with:');
        console.log('  curl -X POST http://localhost:3100/agents/spawn -H "Content-Type: application/json" -d \'{"name": "my-agent"}\'');
        process.exit(0);
      }
      
      console.log(`📋 Available Agents (${data.agents.length})\n`);
      console.log('─'.repeat(80));
      
      for (const agent of data.agents) {
        console.log(`\n  ${colors.bold}${agent.name}${colors.reset} (${agent.id})`);
        console.log(`  Model:  ${agent.model}`);
        console.log(`  Port:   ${agent.port}`);
        console.log(`  Status: ${agent.status === 'running' ? colors.green + '●' + colors.reset : '○'} ${agent.status}`);
        console.log(`  URL:    ${agent.url}`);
        console.log(`\n  Connect: ${colors.cyan}npm run claude:talk -- --name ${agent.name}${colors.reset}`);
        console.log(`       or: ${colors.cyan}npm run claude:talk -- --port ${agent.port}${colors.reset}`);
      }
      
      console.log('\n' + '─'.repeat(80));
      process.exit(0);
    } catch (error) {
      console.error('❌ Cannot connect to agent manager at http://localhost:3100');
      console.error('   Make sure it\'s running: npm run claude:manager\n');
      process.exit(1);
    }
  }

  console.log('🤖 Claude Agent REST-AP Client');
  console.log('===============================\n');
  
  let serverUrl: string;
  
  // If name provided, look up the agent
  if (agentName) {
    try {
      const response = await fetch('http://localhost:3100/agents');
      const data: any = await response.json();
      const agent = data.agents.find((a: any) => a.name === agentName);
      
      if (!agent) {
        console.error(`❌ Agent "${agentName}" not found`);
        console.error(`Available agents: ${data.agents.map((a: any) => a.name).join(', ')}\n`);
        process.exit(1);
      }
      
      serverUrl = agent.url;
      console.log(`Found agent: ${agent.name}`);
      console.log(`Model: ${agent.model}`);
      console.log(`Port: ${agent.port}\n`);
    } catch (error) {
      console.error('❌ Cannot connect to agent manager at http://localhost:3100');
      console.error('   Make sure it\'s running: npm run claude:manager\n');
      process.exit(1);
    }
  } else if (agentPort) {
    serverUrl = `http://localhost:${agentPort}`;
  } else {
    serverUrl = process.env.CLAUDE_AGENT_URL || 'http://localhost:4101';
  }
  
  // Check if server is running
  try {
    const catalogResponse = await fetch(`${serverUrl}/.well-known/restap.json`);
    if (!catalogResponse.ok) {
      throw new Error('Server not responding');
    }
    const catalog: any = await catalogResponse.json();
    console.log(`Connected to: ${catalog.provider?.name || catalog.agent?.name || 'Claude Agent'}`);
    console.log(`Server: ${serverUrl}\n`);
  } catch (error) {
    console.error('❌ Cannot connect to Claude Agent server');
    console.error(`   Make sure it's running on: ${serverUrl}`);
    console.error(`   Or start the manager: npm run claude:manager\n`);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\nYou: '
  });

  let lastNewsTimestamp = 0;
  let isProcessing = false;
  let sessionId: string | undefined; // Track session for context continuity

  console.log('Type your message or /help for commands\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    
    if (!input) {
      rl.prompt();
      return;
    }

    if (isProcessing) {
      console.log('⏳ Please wait for the current request to complete...');
      rl.prompt();
      return;
    }

    // Handle commands
    if (input.startsWith('/')) {
      await handleCommand(input, rl, serverUrl);
      return;
    }

    isProcessing = true;
    console.log(`\n${colors.bold}${colors.cyan}🤖 Claude:${colors.reset}\n`);

    try {
      // Send message to Claude via REST-AP (with session_id if available)
      const talkResponse = await fetch(`${serverUrl}/talk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: input,
          session_id: sessionId // Pass session for context continuity
        })
      });

      const talkData: any = await talkResponse.json();

      if (talkResponse.status === 202 && talkData.query_id) {
        const queryId = talkData.query_id;
        console.log(`${colors.gray}⏳ Processing (query: ${queryId})...${colors.reset}\n`);

        // Adaptive polling: start frequent, then back off
        const startTime = Date.now();
        const MAX_POLL_TIME = 60 * 60 * 1000; // 1 hour
        
        function getPollInterval(elapsedMs: number): number {
          const elapsedSeconds = elapsedMs / 1000;
          const elapsedMinutes = elapsedSeconds / 60;
          
          if (elapsedSeconds < 30) return 2000;        // 0-30s: 2 seconds
          if (elapsedMinutes < 1) return 5000;         // 30s-1min: 5 seconds
          if (elapsedMinutes < 2) return 10000;        // 1-2min: 10 seconds
          if (elapsedMinutes < 3) return 20000;        // 2-3min: 20 seconds
          if (elapsedMinutes < 4) return 30000;        // 3-4min: 30 seconds
          if (elapsedMinutes < 5) return 60000;        // 4-5min: 1 minute
          if (elapsedMinutes < 10) return 120000;      // 5-10min: 2 minutes
          if (elapsedMinutes < 60) return 300000;      // 10-60min: 5 minutes
          return -1; // Stop polling after 1 hour
        }

        // Poll for completion with adaptive intervals
        let completed = false;
        let lastPollInterval = 2000;
        
        while (!completed) {
          const elapsed = Date.now() - startTime;
          
          if (elapsed >= MAX_POLL_TIME) {
            console.log(`${colors.yellow}⏰ Polling timeout after 1 hour. Stopping...${colors.reset}`);
            completed = true;
            break;
          }
          
          const pollInterval = getPollInterval(elapsed);
          if (pollInterval === -1) {
            console.log(`${colors.yellow}⏰ Polling timeout after 1 hour. Stopping...${colors.reset}`);
            completed = true;
            break;
          }
          
          // Only show interval change message if it changed
          if (pollInterval !== lastPollInterval) {
            const intervalSeconds = pollInterval / 1000;
            const intervalMinutes = intervalSeconds / 60;
            const display = intervalMinutes >= 1 
              ? `${intervalMinutes} minute${intervalMinutes > 1 ? 's' : ''}`
              : `${intervalSeconds} seconds`;
            console.log(`${colors.gray}⏱️  Polling interval: ${display}${colors.reset}\n`);
            lastPollInterval = pollInterval;
          }
          
          await new Promise(resolve => setTimeout(resolve, pollInterval));

          // Use query_id parameter for efficient server-side filtering
          const newsResponse = await fetch(`${serverUrl}/news?since=${lastNewsTimestamp}&query_id=${queryId}`);
          const newsData: any = await newsResponse.json();

          // Update timestamp
          if (newsData.timestamp) {
            lastNewsTimestamp = newsData.timestamp;
          }

          // Since we're filtering by query_id on the server, items should already be filtered
          // But we still check the type to distinguish completion vs failure
          const completion = newsData.items.find((item: any) =>
            item.type === 'query.completed'
          );

          if (completion) {
            const result = completion.data.result;
            
            // Capture session ID for context continuity
            if (result.sessionId) {
              sessionId = result.sessionId;
            }
            
            // Show thinking and tool use
            if (result.messages && result.messages.length > 0) {
              for (const msg of result.messages) {
                if (msg.startsWith('[Thinking]')) {
                  console.log(`${colors.gray}💭 ${msg.substring(11)}${colors.reset}`);
                } else if (msg.startsWith('[Tool]')) {
                  console.log(`${colors.yellow}🔧 ${msg.substring(7)}${colors.reset}`);
                }
              }
              console.log();
            }

            // Show final result in cyan
            console.log(`${colors.cyan}${result.result}${colors.reset}`);
            
            completed = true;
          }

          // Check for failure
          const failure = newsData.items.find((item: any) =>
            item.type === 'query.failed'
          );

          if (failure) {
            console.error(`❌ Error: ${failure.data.error}`);
            completed = true;
          }
        }
      } else {
        // Immediate response (shouldn't happen with current implementation)
        console.log(JSON.stringify(talkData, null, 2));
      }

    } catch (error) {
      console.error('\n❌ Error:', error instanceof Error ? error.message : String(error));
    } finally {
      isProcessing = false;
      rl.prompt();
    }
  });

  rl.on('close', () => {
    console.log('\nGoodbye!');
    process.exit(0);
  });

  async function handleCommand(cmd: string, rl: readline.Interface, serverUrl: string) {
    const parts = cmd.split(' ');
    const command = parts[0];

    switch (command) {
      case '/help':
        console.log(`
Available commands:
  /help      - Show this help
  /status    - Show server status
  /news      - Show recent news
  /clear     - Clear news history
  /reset     - Start a new conversation (clear session)
  /exit      - Exit the CLI
  /quit      - Exit the CLI

Claude has access to these tools:
  Read       - Read files in the working directory
  Write      - Create new files
  Edit       - Make precise edits to existing files
  Bash       - Run terminal commands
  Glob       - Find files by pattern
  Grep       - Search file contents
  WebSearch  - Search the web
  WebFetch   - Fetch web page content

Examples:
  "List all TypeScript files in src/"
  "Read package.json and summarize the dependencies"
  "Create a README.md file for this project"
  "Search the web for the latest React best practices"
`);
        break;
      
      case '/status':
        try {
          const catalogResponse = await fetch(`${serverUrl}/.well-known/restap.json`);
          const catalog: any = await catalogResponse.json();
          console.log(`
Server: ${serverUrl}
Provider: ${catalog.provider.name}
Capabilities: ${catalog.capabilities.length}
`);
        } catch (error) {
          console.error('❌ Cannot connect to server');
        }
        break;
      
      case '/news':
        try {
          const newsResponse = await fetch(`${serverUrl}/news?since=0`);
          const newsData: any = await newsResponse.json();
          console.log(`\nRecent news (${newsData.items.length} items):\n`);
          for (const item of newsData.items.slice(-10)) {
            console.log(`  [${item.type}] ${item.message}`);
          }
        } catch (error) {
          console.error('❌ Cannot fetch news');
        }
        break;
      
      case '/clear':
        lastNewsTimestamp = Date.now();
        console.log('✅ News history cleared');
        break;
      
      case '/reset':
        sessionId = undefined;
        console.log('✅ Session reset. Next message will start a new conversation.');
        break;
      
      case '/exit':
      case '/quit':
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
        break;
      
      default:
        console.log(`Unknown command: ${command}`);
        console.log('Type /help for available commands');
    }
    
    rl.prompt();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
