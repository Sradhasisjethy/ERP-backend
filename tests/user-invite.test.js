const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { Tenant, User } = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

beforeAll(async () => {
  await sequelize.sync({ force: true });

  const tenant = await Tenant.create({ name: 'Invite Test Co', slug: 'invite-test-co', status: 'active' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    {
      tenantId: tenant.id,
      email: 'admin@invite-test.co',
      passwordHash,
      firstName: 'Admin',
      lastName: 'User',
      role: 'PLATFORM_ADMIN',
    },
    { validate: false }
  );

  const login = await request(app).post('/api/v1/auth/login').send({ email: 'admin@invite-test.co', password: PASSWORD });
  adminCookie = extractCookie(login, 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('User Onboarding & Password Setup Invite', () => {
  it('creates an employee without password and assigns resetPasswordToken', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set('Cookie', adminCookie)
      .send({
        email: 'newemployee@invite-test.co',
        firstName: 'John',
        lastName: 'Doe',
        role: 'EMPLOYEE',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe('newemployee@invite-test.co');

    // Verify User record in database has a resetPasswordToken and resetPasswordExpires
    const createdUser = await User.scope('withPassword').findOne({ where: { email: 'newemployee@invite-test.co' } });
    expect(createdUser).toBeTruthy();
    expect(createdUser.resetPasswordToken).toBeTruthy();
    expect(createdUser.resetPasswordExpires).toBeTruthy();
  });
});
