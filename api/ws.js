/**
 * Vercel/serverless WebSocket handler for CardArena
 * Uses shared game-handler module
 */
const { Server } = require('ws');
const gameHandler = require('../lib/game-handler');

let wss;

module.exports = (req, res) => {
  if (!wss) {
    wss = new Server({ noServer: true });
    
    // Reset state for serverless cold starts
    gameHandler.resetState();
    
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
  }

  if (req.method === 'GET' && req.url === '/api/ws') {
    if (req.headers.upgrade !== 'websocket') {
      res.statusCode = 426;
      res.end('Upgrade Required');
      return;
    }
    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    res.statusCode = 404;
    res.end('Not found');
  }
};
