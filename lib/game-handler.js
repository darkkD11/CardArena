/**
 * Shared game handler for CardArena WebSocket server
 * Used by both server.js and api/ws.js
 * 
 * Orchestrates room management, player connections, and game logic
 */

const config = require('./config');
const logger = require('./logger');
const validators = require('./validators');
const { sanitizeString, sanitizePlayer, isValidId, isValidAvatar, isValidMaxPlayers, isValidDifficulty, isValidRank } = validators;

const CONTEXT = 'GameHandler';

// ============================================================
// IN-MEMORY STATE
// ============================================================

let rooms = {};
let clients = new Map();           // ws -> {playerId, name, isAlive}
let clientsByPlayerId = new Map(); // playerId -> ws (for O(1) lookup)
let heartbeatTimer = null;
let disconnectedPlayers = new Map(); // playerId -> {roomId, disconnectedAt, playerData}

// Rate limiting: track messages per player
let messageRateLimits = new Map(); // playerId -> {count, resetTime}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function genRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function send(ws, msg) {
  try {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  } catch (e) {
    // Ignore send errors
  }
}

/**
 * Get WebSocket by player ID - O(1) lookup
 */
function getSocketByPlayerId(playerId) {
  return clientsByPlayerId.get(playerId);
}

function broadcastToRoom(roomId, msg) {
  const room = rooms[roomId];
  if (!room) return;
  
  room.players.forEach(p => {
    if (p.isBot) return; // Bots don't have sockets
    const ws = getSocketByPlayerId(p.id);
    if (ws && ws.readyState === 1) {
      send(ws, msg);
    }
  });
}

function broadcastRoomsList() {
  const publicRooms = Object.values(rooms)
    .filter(r => !r.private)
    .reduce((acc, r) => { acc[r.id] = safeRoomForBroadcast(r); return acc; }, {});
  const msg = { type: 'rooms_list', rooms: publicRooms };
  
  for (const [ws] of clients) {
    if (ws.readyState === 1) send(ws, msg);
  }
}

function safeRoomForBroadcast(room) {
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    host: room.host,
    maxPlayers: room.maxPlayers,
    status: room.status,
    private: room.private,
    hasPassword: !!room.password, // Don't expose actual password
    players: (room.players || []).map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      isBot: !!p.isBot,
      ready: !!p.ready
    })),
    bots: room.bots || []
  };
}

function createBot(diff = 'medium') {
  const validDiff = isValidDifficulty(diff) ? diff : 'medium';
  return {
    id: 'bot_' + Math.random().toString(36).slice(2, 8),
    name: 'Bot_' + Math.floor(Math.random() * 999),
    avatar: Math.floor(Math.random() * 10),
    isBot: true,
    ready: true,
    diff: validDiff
  };
}

// ============================================================
// GAME LOGIC
// ============================================================

function createDeck() {
  const deck = [];
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ rank: r, suit: s, id: r + s });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function dealCards(deck, players) {
  const n = players.length;
  const hands = {};
  for (let i = 0; i < n; i++) {
    hands[players[i].id] = [];
  }
  deck.forEach((c, i) => {
    hands[players[i % n].id].push(c);
  });
  return hands;
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

function handleMessage(ws, msg) {
  if (!msg || typeof msg !== 'object') return;
  const { type, payload } = msg;
  if (!payload || typeof payload !== 'object') {
    // Some messages like list_rooms don't need payload
    if (type !== 'list_rooms') return;
  }

  // Rate limiting check
  const clientInfo = clients.get(ws);
  if (clientInfo) {
    const playerId = clientInfo.playerId;
    const now = Date.now();
    let limit = messageRateLimits.get(playerId);
    
    if (!limit) {
      limit = { count: 1, resetTime: now + config.RATE_LIMIT_WINDOW };
      messageRateLimits.set(playerId, limit);
    } else if (now > limit.resetTime) {
      limit.count = 1;
      limit.resetTime = now + config.RATE_LIMIT_WINDOW;
    } else {
      limit.count++;
      if (limit.count > config.RATE_LIMIT_MAX) {
        send(ws, { type: 'error', error: 'rate_limit_exceeded' });
        logger.warn(CONTEXT, 'Rate limit exceeded', { playerId });
        return;
      }
    }
  }

  switch (type) {
    case 'identify': {
      const playerId = payload && payload.playerId;
      const name = sanitizeString(payload && payload.name, config.MAX_NAME_LENGTH);
      
      if (!isValidId(playerId)) {
        send(ws, { type: 'error', error: 'invalid_player_id' });
        logger.warn(CONTEXT, 'Invalid player ID', { playerId });
        break;
      }
      
      // Remove old mapping if this playerId was connected elsewhere
      const oldWs = clientsByPlayerId.get(playerId);
      if (oldWs && oldWs !== ws) {
        clients.delete(oldWs);
        logger.info(CONTEXT, 'Replaced old connection', { playerId });
      }
      
      clients.set(ws, { playerId, name, isAlive: true });
      clientsByPlayerId.set(playerId, ws);
      logger.info(CONTEXT, 'Player identified', { playerId, name, totalClients: clients.size });
      
      // Check if player was disconnected and trying to reconnect
      const disconnectInfo = disconnectedPlayers.get(playerId);
      if (disconnectInfo) {
        const room = rooms[disconnectInfo.roomId];
        if (room) {
          // Restore player to room
          disconnectInfo.playerData.disconnected = false;
          room.players.push(disconnectInfo.playerData);
          
          // Send reconnection data
          send(ws, { type: 'joined_room', room: safeRoomForBroadcast(room) });
          
          // If game is in progress, send game state
          if (room.status === 'playing' && room.gameState) {
            send(ws, {
              type: 'game_state_restore',
              roomId: room.id,
              gameState: {
                hands: { [playerId]: room.gameState.hands[playerId] || [] },
                pile: room.gameState.pile,
                currentTurn: room.gameState.currentTurn,
                currentRank: room.gameState.currentRank,
                players: room.players.map(p => ({
                  id: p.id,
                  name: p.name,
                  avatar: p.avatar,
                  isBot: !!p.isBot,
                  cardCount: (room.gameState.hands[p.id] || []).length
                }))
              }
            });
          }
          
          broadcastToRoom(room.id, {
            type: 'player_reconnected',
            room: safeRoomForBroadcast(room),
            playerId
          });
        }
        disconnectedPlayers.delete(playerId);
      } else {
        // Normal reconnect to existing rooms (page refresh scenario)
        for (const r of Object.values(rooms)) {
          const existing = r.players.find(p => p.id === playerId);
          if (existing) {
            send(ws, { type: 'joined_room', room: safeRoomForBroadcast(r) });
            
            // If game is in progress, send game state
            if (r.status === 'playing' && r.gameState) {
              send(ws, {
                type: 'game_state_restore',
                roomId: r.id,
                gameState: {
                  hands: { [playerId]: r.gameState.hands[playerId] || [] },
                  pile: r.gameState.pile,
                  currentTurn: r.gameState.currentTurn,
                  currentRank: r.gameState.currentRank,
                  players: r.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    avatar: p.avatar,
                    isBot: !!p.isBot,
                    cardCount: (r.gameState.hands[p.id] || []).length
                  }))
                }
              });
            }
            
            broadcastToRoom(r.id, { type: 'room_updated', room: safeRoomForBroadcast(r) });
          }
        }
      }
      
      // Send current rooms list
      const publicRooms = Object.values(rooms)
        .filter(r => !r.private)
        .reduce((a, r) => { a[r.id] = safeRoomForBroadcast(r); return a; }, {});
      send(ws, { type: 'rooms_list', rooms: publicRooms });
      break;
    }

    case 'list_rooms': {
      const publicRooms = Object.values(rooms)
        .filter(r => !r.private)
        .reduce((a, r) => { a[r.id] = safeRoomForBroadcast(r); return a; }, {});
      send(ws, { type: 'rooms_list', rooms: publicRooms });
      break;
    }

    case 'create_room': {
      const info = clients.get(ws) || {};
      const owner = payload.ownerId || info.playerId;
      
      if (!isValidId(owner) || info.playerId !== owner) {
        send(ws, { type: 'error', error: 'not_authorized' });
        logger.warn(CONTEXT, 'Unauthorized room creation attempt', { playerId: info.playerId, attemptedOwner: owner });
        break;
      }
      
      const id = 'room_' + Date.now();
      const code = genRoomCode();
      const ownerName = sanitizeString(payload.ownerName || info.name, config.MAX_NAME_LENGTH) || 'Player';
      const roomName = sanitizeString(payload.name, config.MAX_ROOM_NAME_LENGTH) || ownerName + "'s Room";
      const maxPlayers = isValidMaxPlayers(payload.maxPlayers) ? Number(payload.maxPlayers) : 4;
      const password = payload.private ? sanitizeString(payload.password, config.MAX_PASSWORD_LENGTH) : null;
      
      const room = {
        id,
        code,
        name: roomName,
        host: owner,
        maxPlayers,
        players: [{
          id: owner,
          name: ownerName,
          avatar: isValidAvatar(payload.avatar) ? Number(payload.avatar) : 0,
          isBot: false,
          ready: true
        }],
        status: 'waiting',
        private: !!payload.private,
        password,
        bots: []
      };
      
      rooms[id] = room;
      logger.info(CONTEXT, 'Room created', { roomId: id, roomCode: code, roomName, owner, maxPlayers, private: !!payload.private });
      send(ws, { type: 'room_created', room: safeRoomForBroadcast(room) });
      broadcastRoomsList();
      break;
    }

    case 'join_room': {
      const roomId = payload.roomId;
      const player = sanitizePlayer(payload.player);
      const room = rooms[roomId];
      
      if (!room) {
        send(ws, { type: 'error', error: 'room_not_found' });
        logger.debug(CONTEXT, 'Room not found', { roomId });
        break;
      }
      if (!player) {
        send(ws, { type: 'error', error: 'invalid_player' });
        break;
      }
      if (room.players.length >= room.maxPlayers) {
        send(ws, { type: 'error', error: 'room_full' });
        break;
      }
      // Check password for private rooms
      if (room.password && payload.password !== room.password) {
        send(ws, { type: 'error', error: 'wrong_password' });
        break;
      }
      // Check if player already in room
      if (room.players.find(p => p.id === player.id)) {
        send(ws, { type: 'error', error: 'already_in_room' });
        break;
      }
      
      room.players.push({ ...player, ready: false, isBot: false });
      send(ws, { type: 'joined_room', room: safeRoomForBroadcast(room) });
      broadcastToRoom(roomId, { type: 'room_updated', room: safeRoomForBroadcast(room) });
      broadcastRoomsList();
      break;
    }

    case 'join_by_code': {
      const code = sanitizeString(payload.code, 6).toUpperCase();
      const player = sanitizePlayer(payload.player);
      const room = Object.values(rooms).find(r => r.code === code);
      
      if (!room) {
        send(ws, { type: 'error', error: 'room_not_found' });
        break;
      }
      if (!player) {
        send(ws, { type: 'error', error: 'invalid_player' });
        break;
      }
      if (room.players.length >= room.maxPlayers) {
        send(ws, { type: 'error', error: 'room_full' });
        break;
      }
      // Check password for private rooms
      if (room.password && payload.password !== room.password) {
        send(ws, { type: 'error', error: 'wrong_password' });
        break;
      }
      // Check if player already in room
      if (room.players.find(p => p.id === player.id)) {
        send(ws, { type: 'error', error: 'already_in_room' });
        break;
      }
      
      room.players.push({ ...player, ready: false, isBot: false });
      send(ws, { type: 'joined_room', room: safeRoomForBroadcast(room) });
      broadcastToRoom(room.id, { type: 'room_updated', room: safeRoomForBroadcast(room) });
      broadcastRoomsList();
      break;
    }

    case 'leave_room': {
      const { roomId, playerId } = payload;
      
      if (!isValidId(playerId)) break;
      
      const room = rooms[roomId];
      
      if (room) {
        // Send confirmation to leaving client using O(1) lookup
        const leaverSock = getSocketByPlayerId(playerId);
        if (leaverSock && leaverSock.readyState === 1) {
          send(leaverSock, { type: 'left_room', room: safeRoomForBroadcast(room), playerId });
        }
        
        room.players = room.players.filter(p => p.id !== playerId);
        
        // Clean up empty rooms
        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          // Transfer host if host left
          if (room.host === playerId && room.players.length > 0) {
            const newHost = room.players.find(p => !p.isBot) || room.players[0];
            room.host = newHost.id;
          }
          broadcastToRoom(roomId, { type: 'room_updated', room: safeRoomForBroadcast(room) });
        }
        
        broadcastRoomsList();
      }
      break;
    }

    case 'chat': {
      const { roomId, from, text } = payload;
      const sanitizedText = sanitizeString(text, config.MAX_CHAT_LENGTH);
      const sanitizedFrom = sanitizeString(from, config.MAX_NAME_LENGTH);
      
      if (!sanitizedText || !rooms[roomId]) break;
      
      broadcastToRoom(roomId, { type: 'chat', from: sanitizedFrom, text: sanitizedText });
      break;
    }

    case 'player_ready': {
      const { roomId, playerId, ready } = payload;
      const room = rooms[roomId];
      const info = clients.get(ws) || {};
      
      // Only allow player to change their own ready status
      if (!room || info.playerId !== playerId) break;
      
      const p = room.players.find(x => x.id === playerId);
      if (p) p.ready = !!ready;
      broadcastToRoom(roomId, { type: 'room_updated', room: safeRoomForBroadcast(room) });
      broadcastRoomsList();
      break;
    }

    case 'add_bot': {
      const { roomId, diff } = payload;
      const room = rooms[roomId];
      const info = clients.get(ws) || {};
      
      // Only host can add bots
      if (!room || room.host !== info.playerId) {
        send(ws, { type: 'error', error: 'not_authorized' });
        break;
      }
      if (room.players.length >= room.maxPlayers) {
        send(ws, { type: 'error', error: 'room_full' });
        break;
      }
      
      const bot = createBot(diff);
      room.players.push(bot);
      broadcastToRoom(roomId, { type: 'room_updated', room: safeRoomForBroadcast(room) });
      broadcastRoomsList();
      break;
    }

    case 'kick_player': {
      const { roomId, playerId } = payload;
      const room = rooms[roomId];
      const info = clients.get(ws) || {};
      
      if (!room) {
        send(ws, { type: 'error', error: 'room_not_found' });
        break;
      }
      if (room.host !== info.playerId) {
        send(ws, { type: 'error', error: 'not_authorized' });
        break;
      }
      // Can't kick yourself
      if (playerId === info.playerId) {
        send(ws, { type: 'error', error: 'cannot_kick_self' });
        break;
      }
      
      // Notify kicked player
      const kickedSock = getSocketByPlayerId(playerId);
      if (kickedSock) {
        send(kickedSock, { type: 'kicked', roomId });
      }
      
      room.players = room.players.filter(p => p.id !== playerId);
      broadcastToRoom(roomId, { type: 'room_updated', room: safeRoomForBroadcast(room) });
      broadcastRoomsList();
      break;
    }

    case 'start_game': {
      const roomId = payload.roomId;
      const room = rooms[roomId];
      const info = clients.get(ws) || {};
      
      if (!room) {
        send(ws, { type: 'error', error: 'room_not_found' });
        break;
      }
      if (room.host !== info.playerId) {
        send(ws, { type: 'error', error: 'not_authorized' });
        break;
      }
      if (room.players.length < 2) {
        send(ws, { type: 'error', error: 'not_enough_players' });
        break;
      }
      if (room.status === 'playing') {
        send(ws, { type: 'error', error: 'game_already_started' });
        break;
      }
      
      // Server-side authoritative deck and dealing
      const deck = shuffleDeck(createDeck());
      const hands = dealCards(deck, room.players);
      
      room.status = 'playing';
      
      // Store game state for reconnection
      room.gameState = {
        hands,
        pile: [],
        currentTurn: room.host,
        currentRank: null
      };
      
      broadcastToRoom(roomId, {
        type: 'start_game',
        roomId,
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          isBot: !!p.isBot
        })),
        starterId: room.host,
        hands
      });
      broadcastRoomsList();
      break;
    }

    case 'play_cards': {
      const { roomId, playerId, cardIds, claimedRank } = payload;
      const room = rooms[roomId];
      const info = clients.get(ws) || {};
      
      if (!room) {
        send(ws, { type: 'error', error: 'room_not_found' });
        break;
      }
      // Validate player is the one making the request
      if (info.playerId !== playerId) {
        send(ws, { type: 'error', error: 'not_authorized' });
        break;
      }
      // Validate cardIds is an array
      if (!Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > 4) {
        send(ws, { type: 'error', error: 'invalid_cards' });
        break;
      }
      // Validate rank
      if (!isValidRank(claimedRank)) {
        send(ws, { type: 'error', error: 'invalid_rank' });
        break;
      }
      
      // Update server-side game state
      if (room.gameState) {
        // Remove played cards from player's hand
        const playerHand = room.gameState.hands[playerId] || [];
        room.gameState.hands[playerId] = playerHand.filter(c => !cardIds.includes(c.id));
        
        // Add cards to pile (face down - just track count)
        room.gameState.pile.push(...cardIds.map(id => ({ id, playerId })));
        room.gameState.currentRank = claimedRank;
        
        // Advance turn
        const playerIndex = room.players.findIndex(p => p.id === playerId);
        const nextIndex = (playerIndex + 1) % room.players.length;
        room.gameState.currentTurn = room.players[nextIndex].id;
      }
      
      broadcastToRoom(roomId, {
        type: 'player_played',
        roomId,
        playerId,
        cardIds,
        claimedRank
      });
      break;
    }

    case 'pass': {
      const { roomId, playerId } = payload;
      const room = rooms[roomId];
      const info = clients.get(ws) || {};
      
      if (!room) {
        send(ws, { type: 'error', error: 'room_not_found' });
        break;
      }
      if (info.playerId !== playerId) {
        send(ws, { type: 'error', error: 'not_authorized' });
        break;
      }
      
      broadcastToRoom(roomId, { type: 'player_passed', roomId, playerId });
      break;
    }

    case 'check': {
      const { roomId, playerId } = payload;
      const room = rooms[roomId];
      const info = clients.get(ws) || {};
      
      if (!room) {
        send(ws, { type: 'error', error: 'room_not_found' });
        break;
      }
      if (info.playerId !== playerId) {
        send(ws, { type: 'error', error: 'not_authorized' });
        break;
      }
      
      broadcastToRoom(roomId, { type: 'player_checked', roomId, playerId });
      break;
    }
  }
}

// ============================================================
// CONNECTION HANDLERS
// ============================================================

function handleConnection(ws) {
  clients.set(ws, { isAlive: true });
  logger.debug(CONTEXT, 'Client connected', { totalClients: clients.size });
  
  // Handle pong responses
  ws.on('pong', () => {
    const info = clients.get(ws);
    if (info) {
      info.isAlive = true;
    }
  });
}

function handleClose(ws) {
  const info = clients.get(ws);
  
  if (info && info.playerId) {
    logger.info(CONTEXT, 'Player disconnected', { playerId: info.playerId });
    
    // Clean up playerId -> ws mapping
    clientsByPlayerId.delete(info.playerId);
    
    // Handle player in rooms
    for (const r of Object.values(rooms)) {
      const playerInRoom = r.players.find(p => p.id === info.playerId);
      if (playerInRoom) {
        // If game is in progress, use grace period instead of immediate removal
        if (r.status === 'playing') {
          // Store player data for potential reconnection
          disconnectedPlayers.set(info.playerId, {
            roomId: r.id,
            disconnectedAt: Date.now(),
            playerData: { ...playerInRoom }
          });
          
          logger.debug(CONTEXT, 'Started reconnection grace period', { 
            playerId: info.playerId, 
            roomId: r.id, 
            gracePeriod: config.RECONNECT_GRACE_PERIOD 
          });
          
          // Remove from active players but keep their game state
          r.players = r.players.filter(p => p.id !== info.playerId);
          
          // Transfer host if needed
          if (r.host === info.playerId && r.players.length > 0) {
            const newHost = r.players.find(p => !p.isBot) || r.players[0];
            r.host = newHost.id;
          }
          
          broadcastToRoom(r.id, {
            type: 'player_disconnected',
            room: safeRoomForBroadcast(r),
            playerId: info.playerId,
            gracePeriod: config.RECONNECT_GRACE_PERIOD
          });
          
          // Schedule cleanup after grace period
          setTimeout(() => {
            cleanupDisconnectedPlayer(info.playerId);
          }, config.RECONNECT_GRACE_PERIOD);
        } else {
          // Waiting room - remove immediately
          logger.debug(CONTEXT, 'Removed player from waiting room', { 
            playerId: info.playerId, 
            roomId: r.id 
          });
          
          r.players = r.players.filter(p => p.id !== info.playerId);
          
          // Clean up empty rooms
          if (r.players.length === 0) {
            delete rooms[r.id];
            logger.info(CONTEXT, 'Deleted empty room', { roomId: r.id });
          } else {
            // Transfer host if needed
            if (r.host === info.playerId) {
              const newHost = r.players.find(p => !p.isBot) || r.players[0];
              r.host = newHost.id;
            }
            broadcastToRoom(r.id, {
              type: 'left_room',
              room: safeRoomForBroadcast(r),
              playerId: info.playerId
            });
          }
        }
      }
    }
    broadcastRoomsList();
  }
  
  // Clean up rate limiting data
  if (info && info.playerId) {
    messageRateLimits.delete(info.playerId);
  }
  
  clients.delete(ws);
}

/**
 * Clean up a disconnected player after grace period expires
 */
function cleanupDisconnectedPlayer(playerId) {
  const disconnectInfo = disconnectedPlayers.get(playerId);
  if (!disconnectInfo) return; // Already reconnected
  
  const room = rooms[disconnectInfo.roomId];
  disconnectedPlayers.delete(playerId);
  messageRateLimits.delete(playerId);
  
  if (room) {
    // Remove player's game state
    if (room.gameState && room.gameState.hands[playerId]) {
      delete room.gameState.hands[playerId];
    }
    
    // If room is empty or only has bots, clean up
    const humanPlayers = room.players.filter(p => !p.isBot);
    if (humanPlayers.length === 0) {
      delete rooms[room.id];
    } else {
      broadcastToRoom(room.id, {
        type: 'player_timeout',
        roomId: room.id,
        playerId
      });
    }
    broadcastRoomsList();
  }
}

// ============================================================
// HEARTBEAT (ping/pong for stale connection detection)
// ============================================================

function startHeartbeat() {
  if (heartbeatTimer) return; // Already running
  
  logger.info(CONTEXT, 'Starting heartbeat', { interval: config.HEARTBEAT_INTERVAL });
  
  heartbeatTimer = setInterval(() => {
    let staleCount = 0;
    clients.forEach((info, ws) => {
      if (info && info.isAlive === false) {
        // Connection didn't respond to last ping - terminate
        staleCount++;
        logger.debug(CONTEXT, 'Terminating stale connection', { playerId: info.playerId || 'unknown' });
        ws.terminate();
        return;
      }
      
      // Mark as not alive, will be set true when pong received
      if (info) {
        info.isAlive = false;
      }
      
      // Send ping (client auto-responds with pong)
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.ping();
      }
    });
    if (staleCount > 0) {
      logger.info(CONTEXT, 'Terminated stale connections', { count: staleCount });
    }
  }, config.HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    logger.info(CONTEXT, 'Stopped heartbeat');
  }
}

// ============================================================
// STATE ACCESSORS (for testing/debugging)
// ============================================================

function getRooms() {
  return rooms;
}

function getClients() {
  return clients;
}

function getClientsByPlayerId() {
  return clientsByPlayerId;
}

function resetState() {
  stopHeartbeat();
  rooms = {};
  clients = new Map();
  clientsByPlayerId = new Map();
  disconnectedPlayers = new Map();
  messageRateLimits = new Map();
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  handleMessage,
  handleConnection,
  handleClose,
  startHeartbeat,
  stopHeartbeat,
  getRooms,
  getClients,
  getClientsByPlayerId,
  resetState,
  send,
  broadcastToRoom,
  broadcastRoomsList
};
