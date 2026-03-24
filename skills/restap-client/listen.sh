#!/bin/bash
# REST-AP Client: Start a listener for replies
# Usage: ./listen.sh [port]

PORT="${LISTENER_PORT:-${1:-4200}}"

echo "Starting REST-AP listener on port $PORT"
echo "Endpoint: http://localhost:$PORT/news"
echo "Press Ctrl+C to stop"
echo ""

# Use node for the listener
node -e "
const http = require('http');

const server = http.createServer((req, res) => {
  console.log(\`[\${new Date().toISOString()}] \${req.method} \${req.url}\`);

  if (req.method === 'POST' && req.url === '/news') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log('Received news:');
      try {
        const data = JSON.parse(body);
        console.log(JSON.stringify(data, null, 2));
      } catch {
        console.log(body);
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true}));
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok'}));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen($PORT, () => {
  console.log(\`Listening on http://localhost:$PORT\`);
});
"
