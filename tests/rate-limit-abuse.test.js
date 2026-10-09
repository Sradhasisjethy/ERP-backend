const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { env } = require('../src/config/env');
const {
  buildApiLimiter,
  buildForgotPasswordLimiter,
  resolveLimits,
  FORGOT_PASSWORD_REPLY,
} = require('../src/middlewares/rateLimiter');

/**
 * Limiting is off under NODE_ENV=test, so these mount the limiter factories
 * with production settings on a throwaway app. No database is touched.
 *
 * What they guard:
 *  - signed-in users get a bucket each, so an office behind one IP (or a proxy
 *    with TRUST_PROXY_HOPS=0) is not throttled as one person;
 *  - that bucket is only granted for a token we signed — a forged one cannot
 *    mint itself fresh buckets;
 *  - health probes are never refused;
 *  - forgot-password cannot mail one address without end, and the throttled
 *    reply cannot be told apart from a real one.
 */

const userToken = (userId) => jwt.sign({ userId }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });

const apiApp = () => {
  const app = express();
  app.use(buildApiLimiter({ enabled: true, nodeEnv: 'production' }));
  app.get(['/health', '/health/live', '/health/ready'], (req, res) => res.json({ status: 'ok' }));
  app.get('/api/v1/ping', (req, res) => res.json({ success: true }));
  return app;
};

const hammer = async (app, n, build) => {
  const statuses = [];
  for (let i = 0; i < n; i += 1) {
    statuses.push((await build(request(app))).status);
  }
  return statuses;
};

describe('API limiter keys on the verified user, not the shared IP', () => {
  it('keeps a production shape the older audit test still reads', () => {
    const limits = resolveLimits('production');
    expect(limits.api).toBe(100);
    expect(limits.apiUser).toBe(1500);
    expect(limits.auth).toBe(10);
  });

  it('lets two signed-in users on one IP make 150 requests each', async () => {
    const app = apiApp();
    const a = await hammer(app, 150, (r) => r.get('/api/v1/ping').set('Authorization', `Bearer ${userToken('user-a')}`));
    // The second user reads the token from the cookie, as the SPA does.
    const b = await hammer(app, 150, (r) => r.get('/api/v1/ping').set('Cookie', `theme=dark; accessToken=${userToken('user-b')}`));
    expect(a.filter((s) => s !== 200)).toEqual([]);
    expect(b.filter((s) => s !== 200)).toEqual([]);
  });

  it('treats a forged token as anonymous: the per-IP limit applies', async () => {
    const app = apiApp();
    const forged = (i) => jwt.sign({ userId: `fake-${i}` }, 'not-the-server-secret', { algorithm: 'HS256' });
    // A different forged id on every request: were the id trusted, each would get a fresh bucket.
    const statuses = [];
    for (let i = 0; i < 101; i += 1) {
      statuses.push((await request(app).get('/api/v1/ping').set('Authorization', `Bearer ${forged(i)}`)).status);
    }
    expect(statuses.slice(0, 100).every((s) => s === 200)).toBe(true);
    expect(statuses[100]).toBe(429);

    const refused = await request(app).get('/api/v1/ping');
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, message: expect.any(String) });
    expect(refused.headers['ratelimit-limit']).toBe('100');

    // A real user on the same, now exhausted, IP is unaffected.
    const user = await request(app).get('/api/v1/ping').set('Authorization', `Bearer ${userToken('user-c')}`);
    expect(user.status).toBe(200);
  });

  it('never limits the health probes', async () => {
    const app = apiApp();
    await hammer(app, 100, (r) => r.get('/api/v1/ping'));
    expect((await request(app).get('/api/v1/ping')).status).toBe(429);
    for (const probe of ['/health', '/health/live', '/health/ready', '/health/']) {
      const statuses = await hammer(app, 5, (r) => r.get(probe));
      expect([probe, statuses.every((s) => s === 200)]).toEqual([probe, true]);
    }
  });
});

describe('forgot-password is limited per recipient, silently', () => {
  const forgotApp = (spy) => {
    const app = express();
    app.use(express.json());
    app.post('/auth/forgot-password', buildForgotPasswordLimiter({ enabled: true, nodeEnv: 'production' }), (req, res) => {
      spy(req.body.email);
      res.status(200).json(FORGOT_PASSWORD_REPLY);
    });
    return app;
  };

  it('answers the 4th request for one address with the normal reply, without running the handler', async () => {
    const spy = jest.fn();
    const app = forgotApp(spy);
    const variants = ['victim@example.com', ' Victim@Example.com', 'VICTIM@EXAMPLE.COM  ', 'victim@example.COM'];
    const replies = [];
    for (const email of variants) {
      replies.push(await request(app).post('/auth/forgot-password').send({ email }));
    }
    expect(spy).toHaveBeenCalledTimes(3);
    const fourth = replies[3];
    expect(fourth.status).toBe(200);
    expect(fourth.body).toEqual(replies[0].body);
    expect(fourth.body).toEqual(FORGOT_PASSWORD_REPLY);
    // No headers that would give the throttling away.
    expect(fourth.headers['ratelimit-remaining']).toBeUndefined();
    expect(fourth.headers['retry-after']).toBeUndefined();

    // Someone else's address has its own allowance.
    const other = await request(app).post('/auth/forgot-password').send({ email: 'someone@example.com' });
    expect(other.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy).toHaveBeenLastCalledWith('someone@example.com');
  });

  it('matches what the real route sends, so a throttled reply is indistinguishable', () => {
    // auth.service.js does not export its constant; read the source instead.
    const service = fs.readFileSync(path.join(__dirname, '../src/api/auth/auth.service.js'), 'utf8');
    const controller = fs.readFileSync(path.join(__dirname, '../src/api/auth/auth.controller.js'), 'utf8');
    expect(service).toContain(`'${FORGOT_PASSWORD_REPLY.data.message}'`);
    expect(service).toMatch(/return \{ message: FORGOT_PASSWORD_MESSAGE \}/);
    expect(controller).toContain(`sendSuccess(res, result, '${FORGOT_PASSWORD_REPLY.message}')`);
  });
});
