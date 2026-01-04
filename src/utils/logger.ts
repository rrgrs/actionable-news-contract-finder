import winston from 'winston';

// Export Logger type for use in other modules
export type Logger = winston.Logger;

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  verbose: 4,
};

// Define colors for each level (for console output)
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue',
  verbose: 'cyan',
};

// Add colors to winston
winston.addColors(colors);

// Custom format for human-readable console output
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
    let output = `${timestamp} [${level}]`;
    if (service) {
      output += ` [${service}]`;
    }
    output += ` ${message}`;

    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      // Format metadata nicely for console
      const metaStr = Object.entries(meta)
        .map(([key, value]) => {
          if (typeof value === 'object') {
            return `${key}=${JSON.stringify(value)}`;
          }
          return `${key}=${value}`;
        })
        .join(' ');
      if (metaStr) {
        output += ` | ${metaStr}`;
      }
    }

    return output;
  }),
);

// Create the logger instance
const logger = winston.createLogger({
  levels,
  level: process.env.LOG_LEVEL || 'info', // Default to 'info', can be set via LOG_LEVEL env var
  transports: [
    // Console transport with human-readable format
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

// Create child loggers for different services
export function createLogger(service: string) {
  return logger.child({ service });
}

// Export the base logger as default
export default logger;

// Helper function to log article processing details
export function logArticleProcessing(
  logger: winston.Logger,
  article: { id: string; title: string; url?: string },
  actionable: boolean,
  reason?: string,
  relevanceScore?: number,
) {
  logger.debug('Article processing result', {
    articleId: article.id,
    title: article.title.substring(0, 100),
    url: article.url,
    actionable,
    reason,
    relevanceScore,
  });
}

// Helper function to log contract validation
export function logContractValidation(
  logger: winston.Logger,
  contractId: string,
  platform: string,
  newsId: string,
  relevant: boolean,
  action?: string,
  confidence?: number,
) {
  logger.debug('Contract validation result', {
    contractId,
    platform,
    newsId,
    relevant,
    action,
    confidence,
  });
}

// Helper function to log API calls
export function logApiCall(
  logger: winston.Logger,
  service: string,
  endpoint: string,
  duration: number,
  success: boolean,
  error?: string,
) {
  const level = success ? 'debug' : 'warn';
  logger.log(level, `API call to ${service}`, {
    endpoint,
    duration: `${duration}ms`,
    success,
    error,
  });
}
