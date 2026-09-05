/**
 * Session revocation.
 *
 * A refresh token used to be a bare signed JWT: valid for seven days, accepted
 * from anyone holding it, and impossible to withdraw. Logout cleared cookies
 * and nothing else, so a copied token outlived the session that made it, a
 * password reset ended nothing, and disabling an account was advisory.
 *
 * These tests are about the withdrawal, not the happy path — every one of them
 * describes something that silently worked before it should not have.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, RefreshToken } = require('../src/models/index');
const { env } = require('../src/config/env');

const PASSWORD = 'password123';
let tenantId;

const cookieOf = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0].split('=').slice(1).join('=') : null;
};

const login = (email = 'user@session.co') =>
  request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });

const refreshWith = (token) =>
  request(app).post('/api/v1/auth/refresh').set('Cookie', `refreshToken=${token}`).send({});

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Session Co', slug: 'session-co', status: 'active' });
  tenantId = tenant.id;

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'user@session.co', passwordHash, firstName: 'Session', lastName: 'User', role: 'EMPLOYEE' },
    { validate: false }
  );
});

afterAll(async () => {
  await sequelize.close();
});

describe('a refresh token is only valid while it is on record', () => {
  it('records the token at login, and accepts it', async () => {
    const res = await login();
    expect(res.status).toBe(200);

    const token = cookieOf(res, 'refreshToken');
    const { jti } = jwt.decode(token);

    const stored = await RefreshToken.unscoped().findOne({ where: { jti } });
    expect(stored).not.toBeNull();
    expect(stored.revokedAt).toBeNull();

    expect((await refreshWith(token)).status).toBe(200);
  });

  it('refuses a signature-valid token that was never issued here', async () => {
    // Exactly what an attacker who obtained the signing secret would mint, and
    // exactly what the old code accepted without question.
    const forged = jwt.sign(
      { userId: (await User.unscoped().findOne({ where: { email: 'user@session.co' } })).id, jti: '00000000-0000-4000-8000-000000000000' },
      env.JWT_REFRESH_SECRET,
      { expiresIn: '7d', algorithm: 'HS256' }
    );

    expect((await refreshWith(forged)).status).toBe(401);
  });

  it('refuses a token with no jti at all', async () => {
    const legacy = jwt.sign(
      { userId: (await User.unscoped().findOne({ where: { email: 'user@session.co' } })).id },
      env.JWT_REFRESH_SECRET,
      { expiresIn: '7d', algorithm: 'HS256' }
    );

    expect((await refreshWith(legacy)).status).toBe(401);
  });
});

describe('rotation', () => {
  it('spends the presented token and issues a fresh one', async () => {
    const first = cookieOf(await login(), 'refreshToken');
    const res = await refreshWith(first);
    const second = cookieOf(res, 'refreshToken');

    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    const spent = await RefreshToken.unscoped().findOne({ where: { jti: jwt.decode(first).jti } });
    expect(spent.revokedAt).not.toBeNull();
    expect(spent.revokedReason).toBe('ROTATED');
    expect(spent.replacedBy).toBe(jwt.decode(second).jti);

    expect((await refreshWith(second)).status).toBe(200);
  });

  it('treats a replayed token as theft and ends every session', async () => {
    const first = cookieOf(await login(), 'refreshToken');
    const second = cookieOf(await refreshWith(first), 'refreshToken');

    // The legitimate holder has moved on to `second`. Anyone still presenting
    // `first` has a copy, so the whole chain is closed rather than just this
    // token refused.
    expect((await refreshWith(first)).status).toBe(401);
    expect((await refreshWith(second)).status).toBe(401);

    const user = await User.unscoped().findOne({ where: { email: 'user@session.co' } });
    const live = await RefreshToken.unscoped().count({ where: { userId: user.id, revokedAt: null } });
    expect(live).toBe(0);
  });
});

describe('logout', () => {
  it('ends the session for real, not just in this browser', async () => {
    const token = cookieOf(await login(), 'refreshToken');

    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', `refreshToken=${token}`).send({});
    expect(out.status).toBe(200);

    // Clearing the cookie never stopped a copy of the token from working.
    expect((await refreshWith(token)).status).toBe(401);
  });

  it('leaves the user\'s other devices signed in', async () => {
    const laptop = cookieOf(await login(), 'refreshToken');
    const phone = cookieOf(await login(), 'refreshToken');

    await request(app).post('/api/v1/auth/logout').set('Cookie', `refreshToken=${laptop}`).send({});

    // Signing out of one device must not sign you out of the others; that is
    // why this is a per-token allowlist rather than a per-user counter.
    expect((await refreshWith(laptop)).status).toBe(401);
    expect((await refreshWith(phone)).status).toBe(200);
  });

  it('succeeds even with no token to end', async () => {
    expect((await request(app).post('/api/v1/auth/logout').send({})).status).toBe(200);
  });
});

describe('password reset', () => {
  it('closes every session the old password could reach', async () => {
    const laptop = cookieOf(await login(), 'refreshToken');
    const phone = cookieOf(await login(), 'refreshToken');

    const user = await User.unscoped().findOne({ where: { email: 'user@session.co' } });
    const { authService } = require('../src/api/auth/auth.service');

    const crypto = require('crypto');
    const raw = crypto.randomBytes(32).toString('hex');
    await user.update({
      resetPasswordToken: crypto.createHash('sha256').update(raw).digest('hex'),
      resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000),
    });

    await authService.resetPassword(raw, 'brand-new-password');

    // Someone resetting a password has usually lost control of the account;
    // leaving working tokens behind hands the intruder another seven days.
    expect((await refreshWith(laptop)).status).toBe(401);
    expect((await refreshWith(phone)).status).toBe(401);
  });
});

describe('the access-token cookie', () => {
  it('lives exactly as long as the token it carries', async () => {
    // The reset above changed the password; this signs in with the new one.
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@session.co', password: 'brand-new-password' });
    expect(res.status).toBe(200);
    const setCookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('accessToken='));
    const maxAge = Number(/Max-Age=(\d+)/i.exec(setCookie)?.[1]);

    const claims = jwt.decode(cookieOf(res, 'accessToken'));
    const tokenSeconds = claims.exp - claims.iat;

    // These used to disagree — an hour-long token in a fifteen-minute cookie —
    // so the browser threw away a token that was still perfectly good.
    expect(Math.abs(maxAge - tokenSeconds)).toBeLessThanOrEqual(5);
  });
});
