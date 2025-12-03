/**
 * Logger utility for MCP Gateway
 */

import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  let log = `${timestamp} [${level}]: ${message}`;
  if (Object.keys(meta).length > 0) {
    log += ` ${JSON.stringify(meta)}`;
  }
  if (stack) {
    log += `\n${stack}`;
  }
  return log;
});

export function createLogger(level: string = 'info'): winston.Logger {
  return winston.createLogger({
    level,
    format: combine(
      errors({ stack: true }),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      colorize(),
      logFormat
    ),
    transports: [
      new winston.transports.Console(),
    ],
    exceptionHandlers: [
      new winston.transports.Console(),
    ],
    rejectionHandlers: [
      new winston.transports.Console(),
    ],
  });
}

// Default logger instance
export const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

