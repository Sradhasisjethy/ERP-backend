const { Op } = require('sequelize');
const { Party } = require('./party.model');
const { LabourWageProfile } = require('./labourWageProfile.model');
const { PartyAddress } = require('./partyAddress.model');
const { dropMaskedSensitive, currentActor } = require('./partySensitive');
const { hasPermission } = require('../../middlewares/authorize');
const { toOrder, containsPattern } = require('../../utils/pagination');
const { assertNoDependents, assertUnique } = require('../../core/masterGuards');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../core/AppError');
const { isIsoDate } = require('../../utils/zodFields');
const { todayLocal } = require('../../utils/businessDate');

const MIN_LABOUR_AGE = 18;

/**
 * Party fields whose change is a decision beyond PARTY_MODIFY. Enforced here,
 * not in the router, so the master-data import (which calls this service
 * directly) is held to the same rule as the edit dialog.
 *
 * What is refused is a *change*: the edit form re-sends every field it shows,
 * so a value equal to the stored one passes, and masked values are dropped as
 * "unchanged" before this runs.
 */
const FIELD_GRANTS = Object.freeze([
  {
    // Loosening these is how an order gets past BR-13 credit control.
    permission: 'SALES_CREDIT_OVERRIDE',
    fields: ['creditLimitPaise', 'creditAgeingDays', 'creditAction'],
    message: 'Changing credit terms needs the Credit override permission',
  },
  {
    // Where money is paid to, who it is paid to, and what a broker earns —
    // editing these on an existing party is how a payment gets diverted.
    permission: 'PARTY_SENSITIVE_MODIFY',
    fields: [
      'bankAccountNumber', 'bankIfsc', 'bankName', 'bankBranch', 'beneficiaryName',
      'pan', 'aadhaarNumber', 'esicNumber', 'esicIpNumber', 'uanNumber',
      'commissionType', 'commissionValue',
    ],
    message: 'Changing bank, identity or commission details needs the Edit party identity, bank and commission details permission',
  },
]);

const WAGE_GRANT = {
  permission: 'LABOUR_MODIFY',
  fields: ['dailyWagePaise', 'overtimeRateMultiplier', 'effectiveFrom'],
  message: "Changing a labourer's wage needs the Labour edit permission",
};

/**
 * What a new party may carry without the credit grant. creditAgeingDays is
 * left out on purpose: the party form sends its 30-day credit period on every
 * new party, and on its own it blocks nothing — credit control only bites once
 * creditAction and a limit are set, and both of those are checked.
 */
const CREDIT_DEFAULTS_ON_CREATE = Object.freeze({ creditLimitPaise: 0, creditAction: 'NONE' });

// DECIMAL and BIGINT come back from Postgres as strings, so numbers are
// compared as numbers; blank, null and absent all mean "no value".
const NUMERIC_FIELDS = new Set(['creditLimitPaise', 'creditAgeingDays', 'commissionValue', 'dailyWagePaise', 'overtimeRateMultiplier']);
const comparable = (field, value) => {
  if (value === undefined || value === null || value === '') return NUMERIC_FIELDS.has(field) ? 0 : null;
  return NUMERIC_FIELDS.has(field) ? Number(value) : String(value).trim();
};
const isSent = (data, field) => Object.hasOwn(data, field) && data[field] !== undefined;
const changedFrom = (data, current, fields) =>
  fields.filter((field) => isSent(data, field) && comparable(field, data[field]) !== comparable(field, current?.[field]));

/**
 * Refuses the first rule whose fields this request changes and the actor lacks
 * the grant for. `actor` undefined means "not passed" (the importer) and is
 * recovered from the request's CLS session; no actor at all is refused rather
 * than waved through, so a new caller cannot skip the check by accident.
 */
const assertFieldGrants = async (violations, actor) => {
  const needed = violations.filter(({ fields }) => fields.length);
  if (!needed.length) return;
  const who = actor === undefined ? await currentActor() : actor;
  for (const { permission, fields, message } of needed) {
    if (!hasPermission(who, permission)) throw new ForbiddenError(`${message} (${fields.join(', ')})`);
  }
};

/**
 * Statutory checks on a labourer, enforced here and not only in the browser:
 * the Factories Act / Child Labour Act minimum age, and a 12-digit Aadhaar.
 * Runs after dropMaskedSensitive, so a masked value the edit form sent back
 * ("unchanged") is already gone, and only checks fields present in this
 * request — a stored legacy value does not block an unrelated edit.
 * Returns the data with the Aadhaar's spaces stripped, as the form sends it.
 */
const checkLabourStatutory = (data, partyType) => {
  if (partyType !== 'LABOUR') return data;
  const clean = { ...data };

  if (typeof clean.aadhaarNumber === 'string' && clean.aadhaarNumber !== '') {
    clean.aadhaarNumber = clean.aadhaarNumber.replace(/\s+/g, '');
    if (!/^\d{12}$/.test(clean.aadhaarNumber)) {
      throw new ValidationError('Aadhaar number must be exactly 12 digits');
    }
  }

  if (clean.dateOfBirth !== undefined && clean.dateOfBirth !== null) {
    const dob = String(clean.dateOfBirth);
    if (!isIsoDate(dob)) throw new ValidationError('dateOfBirth must be a date in YYYY-MM-DD format');
    // Their 18th birthday as a date string; ISO dates compare correctly as
    // strings, and a 29 Feb birthday falls after 28 Feb in a common year.
    const adultOn = `${String(Number(dob.slice(0, 4)) + MIN_LABOUR_AGE).padStart(4, '0')}${dob.slice(4)}`;
    if (adultOn > todayLocal()) {
      throw new ValidationError(`A worker must be at least ${MIN_LABOUR_AGE} years old (Factories Act & Child Labour (Prohibition) Act)`);
    }
  }
  return clean;
};

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
  static async listParties(page, limit, { search, status, partyType, partyTypes, sortBy, sortDir, canViewSensitive = false } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: containsPattern(search) } },
        { code: { [Op.iLike]: containsPattern(search) } },
        { gstin: { [Op.iLike]: containsPattern(search) } },
        { phone: { [Op.iLike]: containsPattern(search) } },
        // Only for a caller who may see Aadhaar: otherwise the search box is
        // an oracle that confirms whether a given number is on file.
        ...(canViewSensitive ? [{ aadhaarNumber: { [Op.iLike]: containsPattern(search) } }] : []),
        { badgeNumber: { [Op.iLike]: containsPattern(search) } },
      ];
    }
    if (status) where.status = status;
    // `partyTypes` narrows to several kinds at once, for pickers like "Vendor /
    // Contractor / Labour" that would otherwise have to ask for every party and
    // offer customers on a money-out form.
    if (Array.isArray(partyTypes) && partyTypes.length) where.partyType = { [Op.in]: partyTypes };
    else if (partyType) where.partyType = partyType;

    // withSensitive: the controller masks these per caller; loading them here
    // is what lets a PARTY_SENSITIVE_READ holder see the real values.
    return Party.scope('withSensitive').findAndCountAll({
      where,
      limit,
      offset,
      include: [
        { model: LabourWageProfile, as: 'wageProfile', required: false },
        { model: Party, as: 'contractor', attributes: ['id', 'name', 'code'], required: false },
      ],
      order: toOrder(sortBy, sortDir, SORTABLE, [['name', 'ASC']]),
    });
  }

  static async getParty(id) {
    const party = await Party.scope('withSensitive').findByPk(id, {
      include: [
        { model: LabourWageProfile, as: 'wageProfile', required: false },
        { model: Party, as: 'contractor', attributes: ['id', 'name', 'code'], required: false },
      ],
    });
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
  static async assertNotDuplicate(data, excludeId, { skipCode = false } = {}) {
    if (data.code && !skipCode) {
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

  /**
   * `preVerified` — the importer has already proved this party code is free,
   * for the whole file in one query. The GSTIN check is NOT skipped: the
   * importer matches on code and knows nothing about which GSTINs are taken,
   * and two customers sharing one is a GST return that gets rejected.
   * See ProductsService.createProduct for the full reasoning.
   */
  static async createParty(data, { preVerified = false, actor } = {}) {
    // An exported-masked workbook re-imported as new rows must not store bullets.
    data = checkLabourStatutory(dropMaskedSensitive(data), data.partyType);
    // Bank and identity details are allowed on create — a new party has no
    // existing account to divert — so only the credit terms are checked.
    const [credit] = FIELD_GRANTS;
    await assertFieldGrants(
      [{ ...credit, fields: changedFrom(data, CREDIT_DEFAULTS_ON_CREATE, Object.keys(CREDIT_DEFAULTS_ON_CREATE)) }],
      actor
    );
    await this.assertNotDuplicate(data, null, { skipCode: preVerified });
    return Party.create(data);
  }

  static async updateParty(id, data, { preVerified = false, actor } = {}) {
    // The edit form round-trips the masked value it was shown; that means
    // "unchanged", not "replace the Aadhaar with bullets".
    data = dropMaskedSensitive(data);
    const party = await this.getParty(id);
    data = checkLabourStatutory(data, data.partyType || party.partyType);
    // After the mask drop and Aadhaar normalising, so only a real change counts.
    await assertFieldGrants(
      FIELD_GRANTS.map((rule) => ({ ...rule, fields: changedFrom(data, party, rule.fields) })),
      actor
    );
    // partyType is immutable once set (the UI disables it too) — reclassifying
    // a party that already has documents would silently move them between the
    // receivables and payables sides of the books.
    if (data.partyType && data.partyType !== party.partyType) {
      const used = await this.countDependents(id);
      if (used) throw new ValidationError('This party already has documents against it — its type can no longer be changed');
    }
    await this.assertNotDuplicate({ partyType: party.partyType, ...data }, id, { skipCode: preVerified });
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
  static async upsertWageProfile(partyId, data, { actor } = {}) {
    const party = await this.getParty(partyId);
    if (party.partyType !== 'LABOUR') {
      throw new ValidationError('Wage profiles can only be set for LABOUR parties');
    }
    // The party form re-saves the profile with every labour edit, so only a
    // real change needs LABOUR_MODIFY; a first profile always is one.
    const fields = party.wageProfile
      ? changedFrom(data, party.wageProfile, WAGE_GRANT.fields)
      : WAGE_GRANT.fields.filter((field) => isSent(data, field));
    await assertFieldGrants([{ ...WAGE_GRANT, fields }], actor);

    const [profile] = await LabourWageProfile.findOrCreate({
      where: { partyId },
      defaults: { partyId, ...data },
    });
    await profile.update(data);
    return profile;
  }
}

module.exports = { PartiesService };
