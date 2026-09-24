const { Op } = require('sequelize');
const { Party } = require('../../parties/party.model');
const { PartiesService } = require('../../parties/parties.service');

/**
 * Customers, vendors, contractors, labour and sales references — one file.
 *
 * `parties.code` is nullable in the schema (the screens allow a party with no
 * code), but the importer **requires** it: without a stable business key a
 * second upload of the same file would create a second copy of every party. The
 * service already refuses a duplicate code, so requiring it here costs nothing
 * and makes the file re-importable, which is the whole point.
 *
 * Party type is deliberately not updatable through import. `updateParty`
 * refuses to reclassify a party that already has documents — moving one between
 * the receivable and payable sides of the books is not something a spreadsheet
 * should be able to do by accident.
 */

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const partyTypes = {
  Customer: 'CUSTOMER',
  Vendor: 'VENDOR',
  Contractor: 'CONTRACTOR',
  Labour: 'LABOUR',
  'Sales Reference': 'SALES_REF',
};

const parties = {
  key: 'parties',
  label: 'Parties',
  fileBase: 'Parties',
  resource: 'PARTY',
  businessKey: 'code',
  businessKeyHeader: 'Party Code',
  notes: [
    {
      key: 'Party Type',
      value: 'Set when the party is created. On an update it is checked against the existing record and a change is refused once the party has documents against it.',
    },
    { key: 'GSTIN', value: '15 characters, for example 21ABCDE1234F1Z5. Leave blank for an unregistered party.' },
  ],
  columns: [
    { header: 'ID', field: 'id', type: 'text', readOnly: true, note: 'Filled in by Export. Leave blank for a new record.' },
    { header: 'Party Code', field: 'code', type: 'code', required: true, maxLength: 50, example: 'CUST-0001', note: 'unique; used to match an existing party' },
    {
      header: 'Party Type', field: 'partyType', type: 'enum', required: true,
      values: Object.keys(partyTypes), enumMap: partyTypes, example: 'Customer',
    },
    { header: 'Name', field: 'name', type: 'text', required: true, maxLength: 255, example: 'Sradhasis Constructions' },
    { header: 'Legal Name', field: 'legalName', type: 'text', maxLength: 255, example: 'Sradhasis Constructions Pvt Ltd' },
    {
      header: 'GSTIN', field: 'gstin', type: 'code', maxLength: 15, example: '21ABCDE1234F1Z5',
      pattern: GSTIN_PATTERN, patternMessage: 'GSTIN must be 15 characters, for example 21ABCDE1234F1Z5',
    },
    { header: 'PAN', field: 'pan', type: 'code', maxLength: 10, example: 'ABCDE1234F' },
    { header: 'Phone', field: 'phone', type: 'text', maxLength: 20, example: '9876543210' },
    { header: 'Email', field: 'email', type: 'email', maxLength: 255, example: 'accounts@sradhasis.co.in' },
    { header: 'Address', field: 'address', type: 'text', maxLength: 500, example: 'Plot 42, Industrial Estate' },
    { header: 'City', field: 'city', type: 'text', maxLength: 100, example: 'Bhubaneswar' },
    { header: 'State', field: 'state', type: 'text', maxLength: 100, example: 'Odisha', note: 'drives the place of supply, so spell it as it appears on the GSTIN' },
    { header: 'Pincode', field: 'pincode', type: 'text', maxLength: 10, example: '751010' },
    { header: 'Payment Terms', field: 'paymentTerms', type: 'text', maxLength: 100, example: 'Net 30' },
    { header: 'Credit Period Days', field: 'creditPeriodDays', type: 'integer', min: 0, max: 3650, example: 30 },
    { header: 'Credit Limit (Rs)', field: 'creditLimitPaise', type: 'money', rate: true, example: 500000, note: 'BR-13 blocks a new order above this' },
    { header: 'Credit Ageing Days', field: 'creditAgeingDays', type: 'integer', min: 0, max: 3650, example: 45 },
    { header: 'Bank Account Number', field: 'bankAccountNumber', type: 'text', maxLength: 50, example: '' },
    { header: 'Bank IFSC', field: 'bankIfsc', type: 'code', maxLength: 11, example: '' },
    { header: 'Bank Name', field: 'bankName', type: 'text', maxLength: 100, example: '' },
    {
      header: 'Status', field: 'status', type: 'enum', values: ['Active', 'Inactive'],
      enumMap: { Active: 'active', Inactive: 'inactive' }, example: 'Active',
      note: 'an inactive party cannot be put on a new document',
    },
  ],
  examples: [
    { code: 'CUST-0001', partyType: 'Customer', name: 'Sradhasis Constructions', legalName: 'Sradhasis Constructions Pvt Ltd', gstin: '21ABCDE1234F1Z5', pan: 'ABCDE1234F', phone: '9876543210', email: 'accounts@sradhasis.co.in', address: 'Plot 42, Industrial Estate', city: 'Bhubaneswar', state: 'Odisha', pincode: '751010', paymentTerms: 'Net 30', creditPeriodDays: 30, creditLimitPaise: 500000, creditAgeingDays: 45, bankAccountNumber: '', bankIfsc: '', bankName: '', status: 'Active' },
    { code: 'VEND-0001', partyType: 'Vendor', name: 'Odisha Cement Traders', legalName: '', gstin: '', pan: '', phone: '9438000000', email: '', address: 'NH-16, Cuttack Road', city: 'Cuttack', state: 'Odisha', pincode: '753001', paymentTerms: 'Net 15', creditPeriodDays: 15, creditLimitPaise: '', creditAgeingDays: '', bankAccountNumber: '50100234567890', bankIfsc: 'HDFC0000123', bankName: 'HDFC Bank', status: 'Active' },
  ],
  load: async ({ query = {} }) =>
    Party.findAll({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.partyType ? { partyType: query.partyType } : {}),
        ...(query.search
          ? { [Op.or]: ['name', 'code', 'gstin', 'phone'].map((column) => ({ [column]: { [Op.iLike]: `%${query.search}%` } })) }
          : {}),
      },
      order: [['name', 'ASC']],
    }),
  create: (values, context, options) => PartiesService.createParty(values, options),
  update: (record, values, context, options) => {
    // partyType travels in the file so the sheet is readable, but only the
    // create path may set it. Sending it on an update would ask the service to
    // reclassify the party on every re-import of an unchanged file.
    const { partyType, ...rest } = values;
    return PartiesService.updateParty(record.id, rest, options);
  },
  /** Refuses a file that quietly reclassifies an existing party. */
  checkUpdate: (record, values) => {
    if (values.partyType && values.partyType !== record.partyType) {
      return `${record.name} is already a ${String(record.partyType).toLowerCase().replace('_', ' ')} — a party type cannot be changed by import`;
    }
    return null;
  },
};

module.exports = { parties };
