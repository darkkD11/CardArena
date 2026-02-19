/**
 * Structured logging utility for CardArena
 * Provides consistent log format with levels: debug, info, warn, error
 */

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const CURRENT_LEVEL = LOG_LEVELS[LOG_LEVEL] || LOG_LEVELS.info;

function formatTimestamp() {
  return new Date().toISOString();
}

function formatLog(level, context, message, data) {
  const timestamp = formatTimestamp();
  const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] [${context}]${dataStr} ${message}`;
}

const logger = {
  debug(context, message, data) {
    if (CURRENT_LEVEL <= LOG_LEVELS.debug) {
      console.log(formatLog('debug', context, message, data));
    }
  },

  info(context, message, data) {
    if (CURRENT_LEVEL <= LOG_LEVELS.info) {
      console.log(formatLog('info', context, message, data));
    }
  },

  warn(context, message, data) {
    if (CURRENT_LEVEL <= LOG_LEVELS.warn) {
      console.warn(formatLog('warn', context, message, data));
    }
  },

  error(context, message, data) {
    if (CURRENT_LEVEL <= LOG_LEVELS.error) {
      console.error(formatLog('error', context, message, data));
    }
  }
};

module.exports = logger;
