const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const gameHandler = require('./lib/game-handler');

const PORT = process.env.PORT || 3000;

const app = express();

// Redirect root to index.html
app.get('/', (req, res) => {
  res.redirect('/index.html');
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log('CardArena server (static + WS) running on port', PORT);
  gameHandler.startHeartbeat();
});

// WebSocket connection handling using shared game-handler
wss.on('connection', (ws) => {
  gameHandler.handleConnection(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    gameHandler.handleMessage(ws, msg);
  });

  ws.on('close', () => {
    gameHandler.handleClose(ws);
  });

  ws.on('error', () => {});
});

process.on('SIGINT', () => {
  console.log('Shutting down');
  gameHandler.stopHeartbeat();
  server.close(() => process.exit(0));
});
