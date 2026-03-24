#!/bin/bash
# Deploy ID Agents Manager to Railway/other PaaS
# This creates a simple web service that talks to the container manager

set -e

echo "🚀 Preparing ID Agents Manager for deployment"

# Check if we're in the project directory
if [ ! -f "package.json" ]; then
    echo "❌ Please run this script from the id-agents project root"
    exit 1
fi

# Build the application
echo "🔨 Building application..."
npm run build

# Create a simple start script for PaaS deployment
cat > start-manager.js << 'EOF'
#!/usr/bin/env node
// Simple start script for PaaS deployment (Railway, Render, etc.)
// Starts only the manager service, not the container manager

const { startAgentManager } = require('./dist/start-agent-manager.js');

console.log('🚀 Starting ID Agents Manager for PaaS deployment...');

// Start the manager
startAgentManager().catch(error => {
    console.error('❌ Failed to start manager:', error);
    process.exit(1);
});
EOF

chmod +x start-manager.js

# Create Procfile for Heroku-style deployment (optional)
cat > Procfile << 'EOF'
web: node start-manager.js
EOF

# Create Dockerfile for containerized deployment (optional)
cat > Dockerfile.manager << 'EOF'
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy built application
COPY dist/ ./dist/
COPY start-manager.js ./

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S idagents -u 1001

USER idagents

EXPOSE 3000

CMD ["node", "start-manager.js"]
EOF

echo "✅ Manager deployment files created!"
echo ""
echo "📋 Deployment options:"
echo ""
echo "🚂 Railway Deployment:"
echo "1. Connect your GitHub repo to Railway"
echo "2. Set build command: npm run build"
echo "3. Set start command: node start-manager.js"
echo "4. Add environment variables (see .env.example)"
echo "5. Add CONTAINER_MANAGER_URL pointing to your Hetzner VPS"
echo ""
echo "🐙 Render Deployment:"
echo "1. Create new Web Service on Render"
echo "2. Connect GitHub repo"
echo "3. Set build command: npm run build"
echo "4. Set start command: node start-manager.js"
echo "5. Add environment variables"
echo ""
echo "🐳 Docker Deployment:"
echo "1. Build: docker build -f Dockerfile.manager -t id-manager ."
echo "2. Run: docker run -p 4100:4100 -e CONTAINER_MANAGER_URL=... id-manager"
echo ""
echo "🔑 Required Environment Variables:"
echo "- ANTHROPIC_API_KEY"
echo "- DATABASE_URL (Railway/PlanetScale)"
echo "- CONTAINER_MANAGER_URL (http://your-hetzner-ip:8080)"
echo "- CONTAINER_MANAGER_API_KEY (if set on container manager)"