const { ForbiddenError } = require('./AppError');
const { hasPermission } = require('../middlewares/authorize');

/**
 * Picking a specific lot instead of FIFO is a named grant (BR-03).
 *
 * OVERRIDE_LOT_SELECTION was defined, seeded into roles and shown in the role
 * editor, but nothing ever checked it: dispatch, production and counter sales
 * passed `overrideLotId` from the body straight to the stock ledger. Anyone who
 * could raise the document could therefore choose the lot — including one still
 * curing or held for QC. The UI never sends the field; this closes the API.
 */
const assertMayOverrideLot = (req, lines) => {
  const overriding = (lines || []).some((line) => line && line.overrideLotId);
  if (overriding && !hasPermission(req.user, 'OVERRIDE_LOT_SELECTION')) {
    throw new ForbiddenError('Choosing a specific lot needs the Override Lot Selection permission');
  }
};

module.exports = { assertMayOverrideLot };
