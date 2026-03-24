// SPDX-License-Identifier: MIT
/**
 * Inter-Agent Communication Demo
 * 
 * Demonstrates agents discovering and communicating with each other
 */

import { IdAgentsCLI } from '../id-agents-cli.js';

async function main() {
  console.log('🤖 Inter-Agent Communication Demo\n');

  const cli = new IdAgentsCLI('http://localhost:3100');

  // Spawn two agents
  console.log('1️⃣ Spawning agents...');
  
  const coder = await cli.spawn({
    name: 'coder',
    model: 'claude-haiku-4-5-20251001'
  });
  console.log(`   ✅ Coder agent on port ${coder.port}`);

  const helper = await cli.spawn({
    name: 'helper',
    model: 'claude-haiku-4-5-20251001'
  });
  console.log(`   ✅ Helper agent on port ${helper.port}\n`);

  // Give the coder a task that requires help
  console.log('2️⃣ Asking coder to create HTML, but first check with helper...');
  
  const coderTask = `
I need to create a simple HTML page with a red button.

But first, can you check with the "helper" agent to see what agents are available
and then ask them for their opinion on button design best practices?

Use these bash commands:
- List agents: curl -s http://localhost:3100/agents | python3 -m json.tool
- Talk to helper: curl -s -X POST http://localhost:${helper.port}/talk -H "Content-Type: application/json" -d '{"message": "What are HTML button best practices?"}'
- Get response: curl -s http://localhost:${helper.port}/news | python3 -m json.tool

After you get advice from the helper, create the HTML page.
`;

  const response = await cli.talk(coder.id, coderTask);
  console.log(`   Query started: ${response.query_id}\n`);

  // Wait for completion
  console.log('3️⃣ Waiting for agents to collaborate...');
  let completed = false;
  let attempts = 0;
  const maxAttempts = 60;  // 2 minutes
  
  while (!completed && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const news = await cli.news(coder.id);
    
    if (news.items && news.items.length > 0) {
      for (const item of news.items) {
        if (item.type === 'query.completed') {
          console.log('\n4️⃣ ✅ Collaboration complete!\n');
          console.log('Result from coder:');
          console.log('---');
          console.log(item.data.result.result);
          console.log('---\n');
          completed = true;
          break;
        } else if (item.type === 'query.failed') {
          console.log(`\n❌ Task failed: ${item.data.error}\n`);
          completed = true;
          break;
        }
      }
    }
    
    attempts++;
    if (!completed && attempts % 5 === 0) {
      console.log(`   Still working... (${attempts * 2}s)`);
    }
  }

  if (!completed) {
    console.log('\n⏱️ Timed out waiting for result');
  }

  console.log('\n5️⃣ Agents are still running. You can interact with them:');
  console.log(`   - Coder: http://localhost:${coder.port}`);
  console.log(`   - Helper: http://localhost:${helper.port}`);
  console.log('\n   Stop them with:');
  console.log(`   - id-agents stop ${coder.id}`);
  console.log(`   - id-agents stop ${helper.id}`);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
