// SPDX-License-Identifier: MIT
/**
 * Example: Using id-agents SDK
 * 
 * This demonstrates spawning agents and interacting with them
 */

import IdAgentsCLI from '../id-agents-cli.js';

async function main() {
  console.log('🚀 ID Agents SDK Example\n');

  // Connect to the agent manager
  const cli = new IdAgentsCLI('http://localhost:3100');

  // 1. Spawn a coding agent (cheap)
  console.log('1️⃣ Spawning a coding agent...');
  const codingAgent = await cli.spawn({
    name: 'coding-agent',
    model: 'claude-haiku-4-5-20251001'
  });
  console.log(`   ✅ ${codingAgent.name} spawned on port ${codingAgent.port}`);
  console.log(`   URL: ${codingAgent.url}\n`);

  // 2. Spawn a research agent (smart)
  console.log('2️⃣ Spawning a research agent...');
  const researchAgent = await cli.spawn({
    name: 'research-agent',
    model: 'claude-haiku-4-5-20251001' // Using Haiku for now to save costs
  });
  console.log(`   ✅ ${researchAgent.name} spawned on port ${researchAgent.port}`);
  console.log(`   URL: ${researchAgent.url}\n`);

  // 3. List all agents
  console.log('3️⃣ Listing all agents...');
  const agents = await cli.list();
  console.log(`   Found ${agents.length} agents:`);
  for (const agent of agents) {
    console.log(`   - ${agent.name} (${agent.status}) on port ${agent.port}`);
  }
  console.log('');

  // 4. Send a task to the coding agent
  console.log('4️⃣ Sending task to coding agent...');
  const task = 'Create a simple HTML page with a button that says "Hello World"';
  console.log(`   Task: ${task}`);
  
  const response = await cli.talk(codingAgent.id, task);
  console.log(`   Response: Query ${response.query_id} - ${response.status}\n`);

  // 5. Poll for results
  console.log('5️⃣ Waiting for results...');
  let completed = false;
  let attempts = 0;
  const maxAttempts = 30;
  
  while (!completed && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    
    const news = await cli.news(codingAgent.id);
    
    if (news.items && news.items.length > 0) {
      for (const item of news.items) {
        if (item.type === 'query.completed') {
          console.log(`   ✅ Task completed!`);
          console.log(`   Result: ${item.data.result.result.substring(0, 200)}...`);
          
          if (item.data.result.sessionId) {
            console.log(`   Session ID: ${item.data.result.sessionId}`);
          }
          
          completed = true;
          break;
        } else if (item.type === 'query.failed') {
          console.log(`   ❌ Task failed: ${item.data.error}`);
          completed = true;
          break;
        }
      }
    }
    
    attempts++;
    if (!completed) {
      console.log(`   Still waiting... (attempt ${attempts}/${maxAttempts})`);
    }
  }

  if (!completed) {
    console.log('   ⏱️ Timed out waiting for results');
  }

  console.log('\n6️⃣ Done! Agents are still running.');
  console.log('   You can continue to interact with them using:');
  console.log(`   - Direct REST-AP: curl http://localhost:${codingAgent.port}/talk`);
  console.log(`   - CLI: id-agents talk ${codingAgent.id} "next task"`);
  console.log(`   - Stop: id-agents stop ${codingAgent.id}`);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
