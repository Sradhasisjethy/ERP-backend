const { z } = require('zod');
const dotenv = require('dotenv');

dotenv.config();

/**
 * Secret strength is checked at boot, not left to review.
 *
 * JWT_SECRET is the entire authentication boundary. Tenant scoping is applied
 * from the claims inside the token — CLS picks up `tenantId` after the
 * signature has been verified — so anyone who can guess or look up the signing
 * key can mint a token for any tenant and read the whole database. Both repos
 * are public, which means every placeholder below is public knowledge.
 *
 * The check runs in every environment on purpose. A weak secret in development
 * is the one that gets promoted, and the failure message says exactly what to
 * run, so the cost of the strict version is one command.
 */
const PLACEHOLDER = new RegExp(
  [
    '^change[-_ ]?me',
    '^super[-_ ]?secret',
    '^secret',
    '^password',
    '^changeit',
    '^please[-_ ]?change',
    '^your[-_ ]?',
    '^example',
    '^sample',
    '^test',
    '^dev',
    '^default',
  ].join('|'),
  'i'
);

/**
 * A secret that is one short block repeated — "0123456789abcdef" twice, say —
 * has the entropy of the block, not of its length. The 32-character floor
 * alone would wave that through.
 */
const isRepeatedBlock = (value) => {
  for (let size = 1; size <= value.length / 2; size += 1) {
    if (value.length % size !== 0) continue;
    if (value.slice(0, size).repeat(value.length / size) === value) return true;
  }
  return false;
};

const secretProblem = (value) => {
  if (value.length < 32) return `is only ${value.length} characters; it must be at least 32`;
  if (PLACEHOLDER.test(value)) return 'is a placeholder value from .env.example';
  if (isRepeatedBlock(value)) return 'is one short block repeated, so its real entropy is far below its length';
  return null;
};

const GENERATE = 'Generate one with:  openssl rand -hex 32';

const envSchema = z
  .object({
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
    JWT_ACCESS_EXPIRATION: z.string().default('1h'),
    ENCRYPTION_KEY: z.string().length(32, 'Encryption key must be 32 characters'),
    CORS_ORIGIN: z.string(),
    /**
     * The zone the database connection computes dates in.
     *
     * Sequelize pins every Postgres connection's TimeZone, and left unset it
     * pins it to UTC — overriding whatever the server is configured for. Ten
     * report expressions use CURRENT_DATE (receivables ageing, overdue orders,
     * days pending, stock ageing and dead stock), and the curing promotion
     * compares against NOW(). Under UTC all of them read the previous day
     * between 00:00 and 05:30 IST: an invoice due today shows as overdue, a lot
     * that finished curing at midnight stays held until 05:30.
     *
     * Must match the tenant's `timezone` setting — tests/report-dates.test.js
     * fails if the two disagree. A deployment serving tenants in genuinely
     * different zones needs the date bound per-request instead; this single
     * value is correct while every tenant shares one.
     */
    APP_TIMEZONE: z
      .string()
      .default('Asia/Kolkata')
      .refine(
        (zone) => {
          try {
            new Intl.DateTimeFormat('en-CA', { timeZone: zone });
            return true;
          } catch {
            return false;
          }
        },
        { message: 'APP_TIMEZONE must be an IANA zone name, e.g. Asia/Kolkata' }
      ),
    RATE_LIMIT_ENABLED: z.enum(['true', 'false']).default('false'),
    // Hops of reverse proxy in front of this process. Express reads the client
    // IP from the right-hand end of X-Forwarded-For counting back this many
    // hops; every rate limiter buckets on that IP.
    //
    // 0 (the default) means "no proxy": req.ip is the socket address and
    // X-Forwarded-For is ignored, so a client cannot spoof its way into a
    // fresh bucket. Behind nginx or an ALB this MUST be set to the real hop
    // count — left at 0, every request appears to come from the proxy's
    // address, all traffic shares one bucket, and the login limiter throttles
    // the whole tenant instead of the attacker.
    //
    // Deliberately not defaulted to 1 in production: guessing the topology is
    // wrong half the time, and the wrong guess in this direction lets a header
    // defeat the limiter silently.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    // Ceiling on a synchronous report export. There is no durable job queue in
    // this deployment, so exports run inline; above this many rows the request is
    // refused with an actionable message rather than blocking a worker for
    // minutes. See api/reports/lib/runner.js.
    REPORT_EXPORT_MAX_ROWS: z.coerce.number().int().min(100).max(500000).default(50000),
  })
  .superRefine((value, ctx) => {
    const reject = (path, message) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY']) {
      const problem = secretProblem(value[key] || '');
      if (problem) reject(key, `${key} ${problem}. ${GENERATE}`);
    }

    // Reusing one secret for both means a refresh token is accepted wherever an
    // access token is, which erases the point of having a short-lived access
    // token at all.
    if (value.JWT_SECRET && value.JWT_SECRET === value.JWT_REFRESH_SECRET) {
      reject(
        'JWT_REFRESH_SECRET',
        `JWT_REFRESH_SECRET must differ from JWT_SECRET — sharing one key lets a refresh token pass as an access token. ${GENERATE}`
      );
    }
  });

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  // format() nests the messages inside an object tree, which buries a
  // one-line remediation like "run openssl rand -hex 32". Print the issues
  // flat first so the fix is the thing you actually see.
  console.error('\nInvalid environment variables:\n');
  for (const issue of parsedEnv.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  console.error('');
  process.exit(1);
}

const env = parsedEnv.data;

module.exports = { env, secretProblem, isRepeatedBlock };
