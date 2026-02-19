/**
 * Configuration for CardArena Server
 * Environment variables override defaults
 */

module.exports = {
  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Player validation
  MAX_NAME_LENGTH: parseInt(process.env.MAX_NAME_LENGTH) || 20,
  MAX_ROOM_NAME_LENGTH: parseInt(process.env.MAX_ROOM_NAME_LENGTH) || 30,
  MAX_CHAT_LENGTH: parseInt(process.env.MAX_CHAT_LENGTH) || 200,
  MAX_PASSWORD_LENGTH: parseInt(process.env.MAX_PASSWORD_LENGTH) || 50,

  // Game difficulty levels
  VALID_DIFFICULTIES: ['easy', 'medium', 'hard'],
  VALID_RANKS: ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'],

  // Heartbeat settings (milliseconds)
  HEARTBEAT_INTERVAL: parseInt(process.env.HEARTBEAT_INTERVAL) || 30000,

  // Connection settings
  RECONNECT_GRACE_PERIOD: parseInt(process.env.RECONNECT_GRACE_PERIOD) || 60000,

  // Rate limiting - messages per second
  RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW) || 1000,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 20,

  // Game rules
  MAX_PLAYERS: parseInt(process.env.MAX_PLAYERS) || 8,
  MIN_PLAYERS: parseInt(process.env.MIN_PLAYERS) || 2,

  // Room cleanup
  MAX_ROOMS: parseInt(process.env.MAX_ROOMS) || 100,
  IDLE_ROOM_TIMEOUT: parseInt(process.env.IDLE_ROOM_TIMEOUT) || 3600000 // 1 hour
};
