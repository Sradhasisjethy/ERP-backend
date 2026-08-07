const winston = require('winston');

const piiFields = ['password', 'salary', 'ssn', 'bankAccount', 'passwordHash'];

const redactPii = winston.format((info) => {
  if (info.message && typeof info.message === 'object') {
    const redact = (obj) => {
      for (const key in obj) {
        if (piiFields.includes(key)) {
          obj[key] = '***REDACTED***';
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          redact(obj[key]);
        }
      }
    };
    redact(info.message);
  }
  return info;
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(redactPii(), winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

module.exports = { logger };
