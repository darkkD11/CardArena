/**
 * Authentication & Session Management for CardArena
 * Prevents ID spoofing and manages player sessions
 */

const config = require('./config');

/**
 * Session store: playerId -> {
 *   connectionId: unique identifier per connection
 *   connectedAt: timestamp
 *   lastActivity: timestamp
 *   playerInfo: {name, avatar}
 * }
 */
const sessions = new Map();

/**
 * Connection-to-Session mapping for fast lookup
 * connectionId -> playerId
 */
const connectionMap = new Map();

/**
 * Generate a unique connection ID
 */
function generateConnectionId() {
  return 'conn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Create a new session for a player
 * Returns: { playerId, connectionId, token } if created
 * Returns: null if validation fails
 */
function createSession(playerId, playerName, playerAvatar) {
  // Validate inputs
  if (typeof playerId !== 'string' || playerId.length === 0) {
    return null;
  }

  const connectionId = generateConnectionId();
  const now = Date.now();

  sessions.set(playerId, {
    connectionId,
    connectedAt: now,
    lastActivity: now,
    playerInfo: {
      name: playerName || 'Player',
      avatar: playerAvatar || 0
    }
  });

  connectionMap.set(connectionId, playerId);

  return {
    playerId,
    connectionId,
    token: Buffer.from(`${playerId}:${connectionId}`).toString('base64')
  };
}

/**
 * Validate a session by connection ID
 * Also updates lastActivity timestamp
 */
function validateSession(playerId, connectionId) {
  if (!playerId || !connectionId) return false;

  const session = sessions.get(playerId);
  if (!session) return false;

  // Check if connection ID matches
  if (session.connectionId !== connectionId) {
    return false; // Session hijacking attempt detected
  }

  // Update activity timestamp
  session.lastActivity = Date.now();
  return true;
}

/**
 * Get session info for a player
 */
function getSession(playerId) {
  return sessions.get(playerId);
}

/**
 * End a session (player disconnect)
 */
function endSession(playerId) {
  const session = sessions.get(playerId);
  if (session) {
    connectionMap.delete(session.connectionId);
    sessions.delete(playerId);
    return true;
  }
  return false;
}

/**
 * Verify player authority over a resource
 * (e.g., can only operate on their own session)
 */
function isAuthorized(playerId, connectionId, resourceOwnerId) {
  // Must have valid session
  if (!validateSession(playerId, connectionId)) {
    return false;
  }

  // If resource owner specified, must match
  if (resourceOwnerId && playerId !== resourceOwnerId) {
    return false;
  }

  return true;
}

/**
 * Clean up expired sessions (older than max inactivity time)
 * Default: 24 hours of inactivity
 */
function cleanupExpiredSessions(maxInactiveTime = 86400000) {
  const now = Date.now();
  const expiredPlayers = [];

  for (const [playerId, session] of sessions) {
    if (now - session.lastActivity > maxInactiveTime) {
      expiredPlayers.push(playerId);
    }
  }

  expiredPlayers.forEach(playerId => endSession(playerId));

  return expiredPlayers.length;
}

/**
 * Get all active sessions (for debugging/monitoring)
 */
function getActiveSessions() {
  const active = {};
  for (const [playerId, session] of sessions) {
    active[playerId] = {
      connectedAt: session.connectedAt,
      lastActivity: session.lastActivity,
      playerInfo: session.playerInfo
    };
  }
  return active;
}

module.exports = {
  createSession,
  validateSession,
  getSession,
  endSession,
  isAuthorized,
  cleanupExpiredSessions,
  getActiveSessions,
  generateConnectionId
};
