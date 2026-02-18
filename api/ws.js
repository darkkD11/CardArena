const { Server } = require('ws');

let wss;
let rooms = {};
let clients = new Map();

function genRoomCode(){return Math.random().toString(36).slice(2,8).toUpperCase()}
function send(ws, msg){ try{ ws.send(JSON.stringify(msg)); }catch(e){} }
function broadcastToRoom(roomId, msg){
  const room = rooms[roomId];
  if(!room) return;
  room.players.forEach(p=>{
    const client = Array.from(clients.entries()).find(([sock,info])=>info && info.playerId===p.id);
    if(client && client[0] && client[0].readyState===1) send(client[0], msg);
  });
}
function safeRoomForBroadcast(room){
  const r = Object.assign({}, room);
  r.players = (r.players||[]).map(p=>({id:p.id,name:p.name,avatar:p.avatar,isBot:!!p.isBot,ready:!!p.ready}));
  return r;
}

module.exports = (req, res) => {
  if (!wss) {
    wss = new Server({ noServer: true });
    rooms = {}; clients = new Map();
    wss.on('connection', (ws) => {
      clients.set(ws, null);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        const { type, payload } = msg;
        switch (type) {
          case 'identify': {
            const playerId = payload && payload.playerId;
            const name = payload && payload.name;
            clients.set(ws, { playerId, name });
            for (const r of Object.values(rooms)) {
              const existing = r.players.find(p => p.id === playerId);
              if (existing) {
                send(ws, { type: 'joined_room', room: safeRoomForBroadcast(r) });
                broadcastToRoom(r.id, { type: 'room_updated', room: safeRoomForBroadcast(r) });
              }
            }
            send(ws, { type: 'rooms_list', rooms: Object.values(rooms).filter(r => !r.private).reduce((a, r) => { a[r.id] = safeRoomForBroadcast(r); return a; }, {}) });
            break;
          }
          case 'list_rooms':
            send(ws, { type: 'rooms_list', rooms: Object.values(rooms).filter(r => !r.private).reduce((a, r) => { a[r.id] = safeRoomForBroadcast(r); return a; }, {}) });
            break;
          case 'create_room': {
            const info = clients.get(ws) || {};
            const owner = payload.ownerId || info.playerId;
            if (!owner || info.playerId !== owner) { send(ws, { type: 'error', error: 'not_authorized' }); break; }
            const id = 'room_' + Date.now();
            const code = genRoomCode();
            const ownerName = payload.ownerName || info.name || 'Player';
            const room = { id, code, name: payload.name || ownerName + "'s Room", host: owner, maxPlayers: payload.maxPlayers || 4, players: [{ id: owner, name: ownerName, avatar: payload.avatar || 0, isBot: false, ready: true }], status: 'waiting', private: !!payload.private, password: payload.password || null, bots: [] };
            rooms[id] = room;
            send(ws, { type: 'room_created', room: safeRoomForBroadcast(room) });
            break;
          }
          case 'join_room': {
            const roomId = payload.roomId;
            const player = payload.player;
            const room = rooms[roomId];
            if (!room) { send(ws, { type: 'error', error: 'room_not_found' }); break; }
            if (room.players.length >= room.maxPlayers) { send(ws, { type: 'error', error: 'room_full' }); break; }
            room.players.push(Object.assign({ ready: false, isBot: false }, player));
            send(ws, { type: 'joined_room', room: safeRoomForBroadcast(room) });
            broadcastToRoom(roomId, { type: 'room_updated', room: safeRoomForBroadcast(room) });
            break;
          }
          case 'join_by_code': {
            const code = payload.code;
            const player = payload.player;
            const room = Object.values(rooms).find(r => r.code === code);
            if (!room) { send(ws, { type: 'error', error: 'room_not_found' }); break; }
            if (room.players.length >= room.maxPlayers) { send(ws, { type: 'error', error: 'room_full' }); break; }
            room.players.push(Object.assign({ ready: false, isBot: false }, player));
            send(ws, { type: 'joined_room', room: safeRoomForBroadcast(room) });
            broadcastToRoom(room.id, { type: 'room_updated', room: safeRoomForBroadcast(room) });
            break;
          }
          case 'leave_room': {
            const { roomId, playerId } = payload;
            const room = rooms[roomId];
            if (room) {
              const leaverSock = Array.from(clients.entries()).find(([s, info]) => info && info.playerId === playerId);
              if (leaverSock && leaverSock[0] && leaverSock[0].readyState === 1) { send(leaverSock[0], { type: 'left_room', room: safeRoomForBroadcast(room), playerId }); }
              room.players = room.players.filter(p => p.id !== playerId);
              broadcastToRoom(roomId, { type: 'room_updated', room: safeRoomForBroadcast(room) });
            }
            break;
          }
          case 'chat': {
            const { roomId, from, text } = payload; broadcastToRoom(roomId, { type: 'chat', from, text }); break;
          }
          case 'player_ready': {
            const { roomId, playerId, ready } = payload; const room = rooms[roomId]; if (room) { const p = room.players.find(x => x.id === playerId); if (p) p.ready = ready; broadcastToRoom(roomId, { type: 'room_updated', room: safeRoomForBroadcast(room) }); } break;
          }
          case 'play_cards': {
            const { roomId, playerId, cardIds, claimedRank } = payload;
            const room = rooms[roomId];
            if (!room) { send(ws, { type: 'error', error: 'room_not_found' }); break; }
            broadcastToRoom(roomId, { type: 'player_played', roomId, playerId, cardIds, claimedRank });
            break;
          }
          case 'pass': {
            const { roomId, playerId } = payload; const room = rooms[roomId]; if (!room) { send(ws, { type: 'error', error: 'room_not_found' }); break; } broadcastToRoom(roomId, { type: 'player_passed', roomId, playerId }); break;
          }
          case 'check': {
            const { roomId, playerId } = payload; const room = rooms[roomId]; if (!room) { send(ws, { type: 'error', error: 'room_not_found' }); break; } broadcastToRoom(roomId, { type: 'player_checked', roomId, playerId }); break;
          }
          case 'add_bot': {
            const { roomId, diff } = payload; const room = rooms[roomId]; if (room && room.players.length < room.maxPlayers) { const bot = { id: 'bot_' + Math.random().toString(36).slice(2, 8), name: 'Bot_' + Math.floor(Math.random() * 999), avatar: Math.floor(Math.random() * 10), isBot: true, ready: true, diff: diff || 'medium' }; room.players.push(bot); broadcastToRoom(roomId, { type: 'room_updated', room: safeRoomForBroadcast(room) }); } break;
          }
          case 'kick_player': {
            const { roomId, playerId } = payload; const room = rooms[roomId];
            const info = clients.get(ws) || {};
            if (!room) { send(ws, { type: 'error', error: 'room_not_found' }); break; }
            if (room.host !== info.playerId) { send(ws, { type: 'error', error: 'not_authorized' }); break; }
            if (room) { room.players = room.players.filter(p => p.id !== playerId); broadcastToRoom(roomId, { type: 'room_updated', room: safeRoomForBroadcast(room) }); }
            break;
          }
          case 'start_game': {
            const roomId = payload.roomId; const room = rooms[roomId]; const info = clients.get(ws) || {};
            if (!room) { send(ws, { type: 'error', error: 'room_not_found' }); break; }
            if (room.host !== info.playerId) { send(ws, { type: 'error', error: 'not_authorized' }); break; }
            if (room) {
              const deck = [];
              const SUITS = ['♠', '♥', '♦', '♣'];
              const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
              for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s, id: r + s });
              for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
              const n = room.players.length;
              const hands = {};
              for (let i = 0; i < n; i++) hands[room.players[i].id] = [];
              deck.forEach((c, i) => { hands[room.players[i % n].id].push(c); });
              room.status = 'playing';
              broadcastToRoom(roomId, { type: 'start_game', roomId, players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, isBot: !!p.isBot })), starterId: room.host, hands });
            }
            break;
          }
        }
      });
      ws.on('close', () => {
        const info = clients.get(ws);
        if (info && info.playerId) {
          for (const r of Object.values(rooms)) {
            if (r.players.find(p => p.id === info.playerId)) {
              r.players = r.players.filter(p => p.id !== info.playerId);
              broadcastToRoom(r.id, { type: 'left_room', room: safeRoomForBroadcast(r), playerId: info.playerId });
            }
          }
        }
        clients.delete(ws);
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
