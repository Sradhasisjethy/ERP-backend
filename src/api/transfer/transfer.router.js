const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { listTransfers, getTransfer, initiateTransfer, receiveTransfer, cancelTransfer } = require('./transfer.controller');
const { initiateTransferSchema, receiveTransferSchema, cancelTransferSchema, listQuerySchema } = require('./transfer.schema');

const transferRouter = Router();

// BR-29: refuse any request naming a factory this user cannot access.
transferRouter.use(authenticate, tenantScope, auditContext, enforceFactoryScope);

transferRouter.get('/', authorize('TRANSFER_READ'), validate(listQuerySchema, 'query'), listTransfers);
transferRouter.post('/', authorize('TRANSFER_CREATE'), validate(initiateTransferSchema), initiateTransfer);
transferRouter.get('/:id', authorize('TRANSFER_READ'), getTransfer);
transferRouter.put('/:id/receive', authorize('TRANSFER_MODIFY'), validate(receiveTransferSchema), receiveTransfer);
transferRouter.put('/:id/cancel', authorize('TRANSFER_MODIFY'), validate(cancelTransferSchema), cancelTransfer);

module.exports = { transferRouter };
