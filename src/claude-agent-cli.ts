// SPDX-License-Identifier: MIT
/**
 * Interactive CLI for Claude Agent SDK
 * 
 * Provides a chat interface for the Claude Agent SDK with full tool access
 */

import 'dotenv/config';
import * as readline from 'readline';
import { runClaudeAgent, CLAUDE_MODELS } from './claude-agent.js';

async function main() {
  console.log('🤖 Claude Agent SDK CLI');
  console.log('=======================\n');
  
  // Get model from env or use default
  const model = process.env.CLAUDE_MODEL || CLAUDE_MODELS.HAIKU;
  const modelName = model.includes('haiku') ? 'Haiku 4.5 (Cheap)' :
                    model.includes('sonnet') ? 'Sonnet 4 (Balanced)' :
                    model.includes('opus') ? 'Opus 4 (Premium)' : model;
  
  console.log('Using Anthropic Claude Agent SDK');
  console.log('Runtime: Claude Code 1.0.x');
  console.log(`Model: ${modelName}\n`);
  
  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set in environment');
    console.error('Get your key from: https://console.anthropic.com/');
    process.exit(1);
  }
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\nYou: '
  });

  let sessionId: string | undefined;
  let isProcessing = false;

  console.log('Available tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch');
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
      await handleCommand(input, rl);
      return;
    }

    isProcessing = true;
    console.log('\n🤖 Claude:');

    try {
      // Run the agent with the user's prompt
      for await (const message of runClaudeAgent(input, {
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
        resume: sessionId
      })) {
        // Capture session ID for context continuity
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          sessionId = message.session_id;
        }
        
        // Display thinking and tool use
        if (message.type === 'thinking' && message.content) {
          console.log(`💭 ${message.content}`);
        } else if (message.type === 'tool_use') {
          const toolName = (message as any).tool_name || 'unknown';
          console.log(`🔧 Using tool: ${toolName}`);
        } else if (message.type === 'tool_result') {
          // Optionally show tool results (can be verbose)
          // console.log(`✅ Tool completed`);
        } else if ('result' in message && message.result) {
          // Final result
          console.log(`\n${message.result}`);
        }
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

  async function handleCommand(cmd: string, rl: readline.Interface) {
    const parts = cmd.split(' ');
    const command = parts[0];

    switch (command) {
      case '/help':
        console.log(`
Available commands:
  /help      - Show this help
  /reset     - Start a new conversation (clear session)
  /status    - Show session status
  /exit      - Exit the CLI
  /quit      - Exit the CLI

The agent has access to these tools:
  Read       - Read files in the current directory
  Write      - Create new files
  Edit       - Make precise edits to existing files
  Bash       - Run terminal commands
  Glob       - Find files by pattern
  Grep       - Search file contents
  WebSearch  - Search the web
  WebFetch   - Fetch web page content

Examples:
  "Find all TypeScript files in src/"
  "Read package.json and tell me the version"
  "Create a README.md file for this project"
  "Find and fix any bugs in auth.ts"
  "Search the web for the latest React best practices"
`);
        break;
      
      case '/reset':
        sessionId = undefined;
        console.log('✅ Session reset. Next message will start a new conversation.');
        break;
      
      case '/status':
        console.log(`
Session ID: ${sessionId || 'none (new session)'}
Model: ${modelName}
Runtime: Claude Code (Claude Agent SDK)
Working directory: ${process.cwd()}
`);
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
