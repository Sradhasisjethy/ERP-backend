const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { auditContext } = require('../../middlewares/auditContext');
const { validate } = require('../../middlewares/validate');
const controller = require('./notifications.controller');
const schema = require('./notifications.schema');

const notificationsRouter = Router();

// BR-29: refuse any request naming a factory this user cannot access.
notificationsRouter.use(authenticate, tenantScope, auditContext, enforceFactoryScope);

// Deliberately not permission-gated beyond authentication: every user needs
// their own notification centre (FR-M24-1), and the money inside alert
// metadata is masked per-permission in the controller instead.
notificationsRouter.get('/', validate(schema.listQuerySchema, 'query'), controller.list);
notificationsRouter.get('/unread-count', controller.unreadCount);
notificationsRouter.put('/read-all', controller.markAllRead);
notificationsRouter.put('/:id/read', controller.markRead);

module.exports = { notificationsRouter };
