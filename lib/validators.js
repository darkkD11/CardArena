/**
 * Validators for CardArena
 * Input validation and sanitization functions
 */

const config = require('./config');

/**
 * Encode dangerous characters as HTML entities
 */
function encodeHtmlEntity(str) {
  const htmlEntities = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, char => htmlEntities[char]);
}

/**
 * Sanitize a string: trim, limit length, escape HTML entities
 */
function sanitizeString(str, maxLength = config.MAX_NAME_LENGTH) {
  if (typeof str !== 'string') return '';
  return encodeHtmlEntity(str.trim().slice(0, maxLength));
}

/**
 * Validate player ID format (alphanumeric with underscores and hyphens)
 */
function isValidId(id) {
  if (typeof id !== 'string') return false;
  return /^[a-zA-Z0-9_-]{1,30}$/.test(id);
}

/**
 * Validate avatar index (0-19)
 */
function isValidAvatar(avatar) {
  const num = Number(avatar);
  return Number.isInteger(num) && num >= 0 && num < 20;
}

/**
 * Validate max players count (2-8)
 */
function isValidMaxPlayers(n) {
  const num = Number(n);
  return Number.isInteger(num) && num >= config.MIN_PLAYERS && num <= config.MAX_PLAYERS;
}

/**
 * Validate difficulty level
 */
function isValidDifficulty(diff) {
  return config.VALID_DIFFICULTIES.includes(diff);
}

/**
 * Validate card rank
 */
function isValidRank(rank) {
  return config.VALID_RANKS.includes(rank);
}

/**
 * Validate and sanitize player object
 */
function sanitizePlayer(player) {
  if (!player || typeof player !== 'object') return null;
  if (!isValidId(player.id)) return null;

  return {
    id: player.id,
    name: sanitizeString(player.name, config.MAX_NAME_LENGTH) || 'Player',
    avatar: isValidAvatar(player.avatar) ? Number(player.avatar) : 0
  };
}

module.exports = {
  sanitizeString,
  sanitizePlayer,
  encodeHtmlEntity,
  isValidId,
  isValidAvatar,
  isValidMaxPlayers,
  isValidDifficulty,
  isValidRank
};
