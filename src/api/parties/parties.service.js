const { Op } = require('sequelize');
const { Party } = require('./party.model');
const { LabourWageProfile } = require('./labourWageProfile.model');
const { PartyAddress } = require('./partyAddress.model');
const { toOrder } = require('../../utils/pagination');
const { assertNoDependents, assertUnique } = require('../../core/masterGuards');
const { NotFoundError, ValidationError } = require('../../core/AppError');

/**
 * Every transactional table that points at a party. A party named on any of
 * them is history and must not be physically removed — deactivating it keeps
 * the ledger, invoices and reports readable while stopping new documents.
 *
 * Required lazily to avoid a require cycle: the sales/purchasing models import
 * Party for their associations.
 */
const partyDependencies = () => {
  const {
    SalesOrder, SalesInvoice, SalesReturn, CreditNote,
    PurchaseOrder, PurchaseInvoice, GoodsReceipt, PurchaseReturn, DebitNote,
    Receipt, Payment, Expense, JournalLine, PriceList,
    ContractorMaterialIssue, ContractorProductionEntry, AttendanceRecord, Advance,
  } = require('../../models');

  return [
    { model: SalesOrder, column: 'customerPartyId', label: 'sales order' },
    { model: SalesInvoice, column: 'customerPartyId', label: 'sales invoice' },
    { model: SalesReturn, column: 'customerPartyId', label: 'sales return' },
    { model: CreditNote, column: 'customerPartyId', label: 'credit note' },
    // DeliveryChallan and PurchaseIndent carry no party column of their own —
    // a challan reaches its customer through salesOrderId and an indent
    // reaches its vendor through purchaseOrderId, so both are already covered
    // by the SalesOrder / PurchaseOrder entries above.
    { model: PurchaseOrder, column: 'vendorPartyId', label: 'purchase order' },
    { model: PurchaseInvoice, column: 'vendorPartyId', label: 'purchase invoice' },
    { model: GoodsReceipt, column: 'vendorPartyId', label: 'goods receipt' },
    { model: PurchaseReturn, column: 'vendorPartyId', label: 'purchase return' },
    { model: DebitNote, column: 'vendorPartyId', label: 'debit note' },
    { model: Receipt, column: 'customerPartyId', label: 'receipt' },
    { model: Payment, column: 'partyId', label: 'payment' },
    { model: Expense, column: 'paidToPartyId', label: 'expense' },
    { model: JournalLine, column: 'partyId', label: 'ledger posting' },
    { model: PriceList, column: 'partyId', label: 'price list' },
    { model: ContractorMaterialIssue, column: 'contractorPartyId', label: 'contractor material issue' },
    { model: ContractorProductionEntry, column: 'contractorPartyId', label: 'contractor production entry' },
    { model: AttendanceRecord, column: 'labourPartyId', label: 'attendance record' },
    { model: Advance, column: 'partyId', label: 'advance' },
  ];
};

const SORTABLE = ['name', 'code', 'partyType', 'city', 'state', 'status', 'creditLimitPaise', 'createdAt'];

class PartiesService {
  static async listParties(page, limit, { search, status, partyType, sortBy, sortDir } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { code: { [Op.iLike]: `%${search}%` } },
        { gstin: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (status) where.status = status;
    if (partyType) where.partyType = partyType;

    return Party.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: LabourWageProfile, as: 'wageProfile', required: false }],
      order: toOrder(sortBy, sortDir, SORTABLE, [['name', 'ASC']]),
    });
  }

  static async getParty(id) {
    const party = await Party.findByPk(id, { include: [{ model: LabourWageProfile, as: 'wageProfile', required: false }] });
    if (!party) throw new NotFoundError('Party not found');
    return party;
  }

  /**
   * Duplicate control. `code` is unique tenant-wide; `gstin` is unique *per
   * party type* on purpose — the same legal entity is routinely both a
   * customer and a supplier, and blocking that would force a fake GSTIN on one
   * of the two records. Two CUSTOMER rows sharing a GSTIN, though, is always a
   * data-entry mistake, and it is the mistake that splits a customer's
   * receivables across two ledgers.
   */
  static async assertNotDuplicate(data, excludeId) {
    if (data.code) {
      await assertUnique(Party, { code: data.code }, excludeId, `A party with code "${data.code}" already exists`);
    }
    if (data.gstin && data.partyType) {
      await assertUnique(
        Party,
        { gstin: data.gstin, partyType: data.partyType },
        excludeId,
        `A ${data.partyType.toLowerCase().replace('_', ' ')} with GSTIN ${data.gstin} already exists`
      );
    }
  }

  static async createParty(data) {
    await this.assertNotDuplicate(data);
    return Party.create(data);
  }

  static async updateParty(id, data) {
    const party = await this.getParty(id);
    // partyType is immutable once set (the UI disables it too) — reclassifying
    // a party that already has documents would silently move them between the
    // receivables and payables sides of the books.
    if (data.partyType && data.partyType !== party.partyType) {
      const used = await this.countDependents(id);
      if (used) throw new ValidationError('This party already has documents against it — its type can no longer be changed');
    }
    await this.assertNotDuplicate({ partyType: party.partyType, ...data }, id);
    return party.update(data);
  }

  static async countDependents(id) {
    let total = 0;
    for (const { model, column } of partyDependencies()) {
      total += await model.count({ where: { [column]: id } });
      if (total) break;
    }
    return total;
  }

  static async deleteParty(id) {
    const party = await this.getParty(id);
    await assertNoDependents(partyDependencies(), id, 'party');
    // Addresses and the wage profile are extensions of the party itself, not
    // history that stands on its own — they go with it (both are ON DELETE
    // CASCADE in the schema; removed explicitly so the intent is visible here).
    await PartyAddress.destroy({ where: { partyId: id } });
    await LabourWageProfile.destroy({ where: { partyId: id } });
    await party.destroy();
    return true;
  }

  // --- Labour wage profile (1:1 extension, only meaningful for partyType=LABOUR) ---
  static async upsertWageProfile(partyId, data) {
    const party = await this.getParty(partyId);
    if (party.partyType !== 'LABOUR') {
      throw new ValidationError('Wage profiles can only be set for LABOUR parties');
    }

    const [profile] = await LabourWageProfile.findOrCreate({
      where: { partyId },
      defaults: { partyId, ...data },
    });
    await profile.update(data);
    return profile;
  }
}

module.exports = { PartiesService };
