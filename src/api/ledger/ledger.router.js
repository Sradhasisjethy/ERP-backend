const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./ledger.controller');
const schema = require('./ledger.schema');

const ledgerRouter = Router();

ledgerRouter.use(authenticate, tenantScope, auditContext);

// Reading the chart stays on LEDGER_READ, as it always has, so every screen
// that already lists accounts keeps working. Maintaining it is ACCOUNT_*.
ledgerRouter.get('/accounts', authorize('LEDGER_READ'), validate(schema.accountListQuerySchema, 'query'), controller.listAccounts);
ledgerRouter.get('/account-groups', authorize('LEDGER_READ'), controller.listAccountGroups);
ledgerRouter.post('/accounts', authorize('ACCOUNT_CREATE'), validate(schema.createAccountSchema), controller.createAccount);
ledgerRouter.put('/accounts/:id', authorize('ACCOUNT_MODIFY'), validate(schema.updateAccountSchema), controller.updateAccount);

ledgerRouter.get('/trial-balance', authorize('LEDGER_READ'), validate(schema.trialBalanceQuerySchema, 'query'), controller.getTrialBalance);
ledgerRouter.get('/party/:partyId', authorize('LEDGER_READ'), validate(schema.partyLedgerQuerySchema, 'query'), controller.getPartyLedger);
ledgerRouter.get('/profit-and-loss', authorize('LEDGER_READ'), validate(schema.profitAndLossQuerySchema, 'query'), controller.getProfitAndLoss);
ledgerRouter.get('/balance-sheet', authorize('LEDGER_READ'), validate(schema.balanceSheetQuerySchema, 'query'), controller.getBalanceSheet);
ledgerRouter.get('/cash-book', authorize('LEDGER_READ'), validate(schema.cashBookQuerySchema, 'query'), controller.getCashBook);

ledgerRouter.get('/vouchers', authorize('JOURNAL_READ'), validate(schema.voucherListQuerySchema, 'query'), controller.listVouchers);
ledgerRouter.post('/vouchers', authorize('JOURNAL_CREATE'), validate(schema.createVoucherSchema), controller.createVoucher);
ledgerRouter.get('/vouchers/:id', authorize('JOURNAL_READ'), controller.getVoucher);
ledgerRouter.put('/vouchers/:id/cancel', authorize('JOURNAL_MODIFY'), validate(schema.cancelVoucherSchema), controller.cancelVoucher);

module.exports = { ledgerRouter };
