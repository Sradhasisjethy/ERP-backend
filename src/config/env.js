const { z } = require('zod');
const dotenv = require('dotenv');

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DB_HOST: z.string(),
  DB_PORT: z.string(),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  DB_NAME_TEST: z.string().optional(),
  JWT_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),
  ENCRYPTION_KEY: z.string().length(32, 'Encryption key must be 32 characters'),
  CORS_ORIGIN: z.string(),
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']).default('false'),
  // Ceiling on a synchronous report export. There is no durable job queue in
  // this deployment, so exports run inline; above this many rows the request is
  // refused with an actionable message rather than blocking a worker for
  // minutes. See api/reports/lib/runner.js.
  REPORT_EXPORT_MAX_ROWS: z.coerce.number().int().min(100).max(500000).default(50000),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid environment variables', parsedEnv.error.format());
  process.exit(1);
}

const env = parsedEnv.data;

module.exports = { env };
