/**
 * Maintenance & Cleanup Service for CardArena
 * Prevents memory leaks by cleaning up stale data periodically
 */

const config = require('./config');
const logger = require('./logger');
const auth = require('./auth');

const CONTEXT = 'Maintenance';

// Cleanup interval (1 hour by default)
const CLEANUP_INTERVAL = parseInt(process.env.CLEANUP_INTERVAL) || 3600000;

let cleanupTimer = null;
let stats = {
  roomsCleaned: 0,
  sessionsExpired: 0,
  rateLimitsCleared: 0,
  lastCleanup: null
};

/**
 * Get current memory usage (Node.js)
 */
function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024), // MB
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024),
    rss: Math.round(mem.rss / 1024 / 1024) // Total process memory
  };
}

/**
 * Get game-handler state for cleanup
 * Needs to be passed in since maintenance module doesn't have direct access
 */
function cleanupStaleData(gameHandler) {
  const beforeMem = getMemoryUsage();
  const startTime = Date.now();

  let cleanupStats = {
    idleRoomsDeleted: 0,
    emptyRoomsDeleted: 0,
    expiredSessionsRemoved: 0,
    rateLimitEntriesCleared: 0
  };

  // Access game handler internals (passed via callback)
  const state = gameHandler.getState?.();
  if (!state) {
    logger.warn(CONTEXT, 'Unable to access game handler state');
    return null;
  }

  const { rooms, disconnectedPlayers, messageRateLimits } = state;
  const now = Date.now();

  // Clean up idle rooms (no human players, older than idle timeout)
  if (rooms) {
    for (const [roomId, room] of Object.entries(rooms)) {
      const humanPlayers = room.players?.filter(p => !p.isBot) || [];
      
      // Remove rooms with no human players
      if (humanPlayers.length === 0) {
        const roomAge = now - (room.createdAt || 0);
        if (roomAge > config.IDLE_ROOM_TIMEOUT) {
          delete rooms[roomId];
          cleanupStats.idleRoomsDeleted++;
          logger.debug(CONTEXT, 'Deleted idle room with no players', { 
            roomId, 
            ageMinutes: Math.round(roomAge / 60000) 
          });
        }
      }

      // Remove old game states from rooms that have been playing for too long
      if (room.gameState && room.status === 'playing') {
        const gameAge = now - (room.gameStartedAt || 0);
        // Delete game state if game is older than 24 hours (staleness indicator)
        if (gameAge > 86400000) {
          delete room.gameState;
          logger.debug(CONTEXT, 'Cleared stale game state', { roomId });
        }
      }
    }
  }

  // Clean up disconnected players past grace period
  if (disconnectedPlayers) {
    for (const [playerId, disconnect] of disconnectedPlayers.entries()) {
      const timeSinceDisconnect = now - disconnect.disconnectedAt;
      if (timeSinceDisconnect > config.RECONNECT_GRACE_PERIOD) {
        disconnectedPlayers.delete(playerId);
        logger.debug(CONTEXT, 'Removed expired disconnected player', { 
          playerId,
          minutesAgo: Math.round(timeSinceDisconnect / 60000)
        });
      }
    }
  }

  // Clean up rate limit entries for inactive players (older than 1 hour)
  if (messageRateLimits) {
    for (const [playerId, limit] of messageRateLimits.entries()) {
      if (now - limit.resetTime > 3600000) {
        messageRateLimits.delete(playerId);
        cleanupStats.rateLimitEntriesCleared++;
      }
    }
  }

  // Clean up expired sessions (24 hours of inactivity)
  const expiredSessionCount = auth.cleanupExpiredSessions(86400000);
  cleanupStats.expiredSessionsRemoved = expiredSessionCount;

  // Update stats
  stats.roomsCleaned += cleanupStats.idleRoomsDeleted + cleanupStats.emptyRoomsDeleted;
  stats.sessionsExpired += expiredSessionCount;
  stats.rateLimitsCleared += cleanupStats.rateLimitEntriesCleared;
  stats.lastCleanup = new Date();

  const elapsed = Date.now() - startTime;
  const afterMem = getMemoryUsage();

  logger.info(CONTEXT, 'Cleanup cycle completed', {
    idleRoomsDeleted: cleanupStats.idleRoomsDeleted,
    emptyRoomsDeleted: cleanupStats.emptyRoomsDeleted,
    expiredSessionsRemoved: expiredSessionCount,
    rateLimitEntriesCleared: cleanupStats.rateLimitEntriesCleared,
    elapsedMs: elapsed,
    heapBefore: beforeMem.heapUsed,
    heapAfter: afterMem.heapUsed,
    heapDifference: beforeMem.heapUsed - afterMem.heapUsed
  });

  return cleanupStats;
}

/**
 * Get memory and state statistics
 */
function getStats(gameHandler) {
  const state = gameHandler.getState?.();
  const roomCount = state?.rooms ? Object.keys(state.rooms).length : 0;
  const clientCount = state?.clients?.size || 0;
  const disconnectedCount = state?.disconnectedPlayers?.size || 0;

  return {
    memory: getMemoryUsage(),
    roomCount,
    clientCount,
    disconnectedCount,
    activeSessions: auth.getActiveSessions(),
    lifetimeStats: stats
  };
}

/**
 * Start periodic cleanup
 */
function startMaintenance(gameHandler) {
  if (cleanupTimer) {
    logger.warn(CONTEXT, 'Maintenance already running');
    return;
  }

  logger.info(CONTEXT, 'Starting maintenance service', { intervalMs: CLEANUP_INTERVAL });

  // Run first cleanup after 5 minutes, then every CLEANUP_INTERVAL
  setTimeout(() => {
    cleanupStaleData(gameHandler);
    
    cleanupTimer = setInterval(() => {
      cleanupStaleData(gameHandler);
    }, CLEANUP_INTERVAL);
  }, 300000);
}

/**
 * Stop periodic cleanup
 */
function stopMaintenance() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    logger.info(CONTEXT, 'Maintenance service stopped');
  }
}

/**
 * Force immediate cleanup
 */
function cleanupNow(gameHandler) {
  logger.info(CONTEXT, 'Forcing immediate cleanup');
  return cleanupStaleData(gameHandler);
}

module.exports = {
  startMaintenance,
  stopMaintenance,
  cleanupNow,
  getStats,
  getMemoryUsage
};
