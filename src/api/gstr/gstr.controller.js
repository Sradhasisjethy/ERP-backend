const { asyncHandler } = require('../../core/asyncHandler');
const { GstrService } = require('./gstr.service');
const { sendSuccess } = require('../../utils/response');
const { hasViewRates } = require('../../utils/fieldMasking');

// GSTR-1/3B payloads nest money fields inside arrays (b2b/b2c rows, hsnSummary,
// creditDebitNotes, outwardSupplies/itcAvailable/netTaxPayable) — deeper than
// the generic maskRateFields helper reaches, so BR-27 masking is done
// explicitly here, the same way analytics.controller.js and
// ledger.controller.js#getPartyLedger handle their own nested shapes.
const MONEY_FIELDS_GSTR1_ROW = ['taxableValuePaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'totalPaise', 'totalValuePaise', 'valuePaise'];

const maskGstr1 = (data) => ({
  ...data,
  summary: Object.fromEntries(Object.entries(data.summary).map(([k, v]) => [k, MONEY_FIELDS_GSTR1_ROW.includes(k) ? null : v])),
  b2b: data.b2b.map((row) => ({ ...row, ...Object.fromEntries(MONEY_FIELDS_GSTR1_ROW.filter((f) => f in row).map((f) => [f, null])) })),
  b2c: data.b2c.map((row) => ({ ...row, ...Object.fromEntries(MONEY_FIELDS_GSTR1_ROW.filter((f) => f in row).map((f) => [f, null])) })),
  hsnSummary: data.hsnSummary.map((row) => ({ ...row, ...Object.fromEntries(MONEY_FIELDS_GSTR1_ROW.filter((f) => f in row).map((f) => [f, null])) })),
  creditDebitNotes: data.creditDebitNotes.map((row) => ({ ...row, ...Object.fromEntries(MONEY_FIELDS_GSTR1_ROW.filter((f) => f in row).map((f) => [f, null])) })),
});

const maskGstr3b = (data) => ({
  ...data,
  outwardSupplies: Object.fromEntries(Object.entries(data.outwardSupplies).map(([k, v]) => [k, typeof v === 'number' ? null : v])),
  itcAvailable: Object.fromEntries(Object.entries(data.itcAvailable).map(([k, v]) => [k, typeof v === 'number' ? null : v])),
  netTaxPayable: Object.fromEntries(Object.entries(data.netTaxPayable).map(([k, v]) => [k, typeof v === 'number' ? null : v])),
});

const getGstr1 = asyncHandler(async (req, res) => {
  const { factoryId, fromDate, toDate } = req.query;
  const data = await GstrService.getGstr1(factoryId, { fromDate, toDate });
  sendSuccess(res, hasViewRates(req) ? data : maskGstr1(data), 'GSTR-1 data retrieved successfully');
});

const getGstr3b = asyncHandler(async (req, res) => {
  const { factoryId, fromDate, toDate } = req.query;
  const data = await GstrService.getGstr3b(factoryId, { fromDate, toDate });
  sendSuccess(res, hasViewRates(req) ? data : maskGstr3b(data), 'GSTR-3B data retrieved successfully');
});

module.exports = { getGstr1, getGstr3b, maskGstr1, maskGstr3b };
