const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const gameHandler = require('./lib/game-handler');
const logger = require('./lib/logger');
const maintenance = require('./lib/maintenance');

const PORT = process.env.PORT || 3000;
const CONTEXT = 'Server';

const app = express();

// Redirect root to index.html
app.get('/', (req, res) => {
  res.redirect('/index.html');
});

app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Stats endpoint (monitoring)
app.get('/stats', (req, res) => {
  const stats = maintenance.getStats(gameHandler);
  res.json(stats);
});

// Debug endpoint (internal use only)
app.get('/debug/cleanup', (req, res) => {
  const stats = maintenance.cleanupNow(gameHandler);
  res.json({ message: 'Cleanup triggered', stats });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  logger.info(CONTEXT, 'CardArena server started', { port: PORT, type: 'static + WebSocket' });
  gameHandler.startHeartbeat();
  maintenance.startMaintenance(gameHandler);
});

// WebSocket connection handling using shared game-handler
wss.on('connection', (ws) => {
  gameHandler.handleConnection(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      logger.debug(CONTEXT, 'Failed to parse JSON message');
      return;
    }
    gameHandler.handleMessage(ws, msg);
  });

  ws.on('close', () => {
    gameHandler.handleClose(ws);
  });

  ws.on('error', (err) => {
    logger.error(CONTEXT, 'WebSocket error', { error: err.message });
  });
});

process.on('SIGINT', () => {
  logger.info(CONTEXT, 'Shutting down server');
  maintenance.stopMaintenance();
  gameHandler.stopHeartbeat();
  server.close(() => {
    logger.info(CONTEXT, 'Server closed');
    process.exit(0);
  });
});
