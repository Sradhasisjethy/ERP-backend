const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { listAccounts, getTrialBalance, getPartyLedger, getCashBook } = require('./ledger.controller');
const { trialBalanceQuerySchema, partyLedgerQuerySchema, cashBookQuerySchema } = require('./ledger.schema');

const ledgerRouter = Router();

ledgerRouter.use(authenticate, tenantScope, auditContext);

ledgerRouter.get('/accounts', authorize('LEDGER_READ'), listAccounts);
ledgerRouter.get('/trial-balance', authorize('LEDGER_READ'), validate(trialBalanceQuerySchema, 'query'), getTrialBalance);
ledgerRouter.get('/party/:partyId', authorize('LEDGER_READ'), validate(partyLedgerQuerySchema, 'query'), getPartyLedger);
ledgerRouter.get('/cash-book', authorize('LEDGER_READ'), validate(cashBookQuerySchema, 'query'), getCashBook);

module.exports = { ledgerRouter };
