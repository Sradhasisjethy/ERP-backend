/**
 * Reference data for the DPDP module: the starter notice a business edits
 * before publishing, and the retention categories the nightly job can act on.
 *
 * The starter notice is a draft, never published automatically. Its lawful
 * bases are this codebase's best reading of s.7 for a precast plant and are
 * there to be checked by whoever signs the notice, not relied on as advice.
 */

/** Rule 14(3): grievances must be answered within 90 days at the outside. */
const MAX_RESPONSE_DAYS = 90;

/**
 * Rule 6(1)(e) and Rule 8(3): logs of processing are kept for at least a
 * year, so no retention rule may purge or mask them sooner.
 */
const MIN_LOG_RETENTION_DAYS = 365;

/** Rule 7(2)(b): the detailed breach report is due within 72 hours. */
const BOARD_REPORT_HOURS = 72;

const LAWFUL_BASES = ['CONSENT', 'LEGITIMATE_USE'];

const STARTER_PURPOSES = [
  {
    code: 'EMPLOYMENT_ADMIN',
    label: 'Employment administration',
    description: 'Keeping your staff record, role, reporting line, attendance and leave so you can work here and be paid.',
    dataItems: ['Name', 'Employee code', 'Work email', 'Phone', 'Address', 'Gender', 'Joining and leaving dates', 'Attendance', 'Leave requests', 'Uploaded HR documents'],
    principalTypes: ['USER'],
    lawfulBasis: 'LEGITIMATE_USE',
    legalReference: 'DPDP Act s.7(i) - employment purposes',
    retention: 'For the employment, then as labour, tax and PF law requires',
    optional: false,
  },
  {
    code: 'SYSTEM_SECURITY',
    label: 'Sign-in and security records',
    description: 'Recording who signed in and changed what, from which IP address, to protect the business and its records.',
    dataItems: ['Sign-in times', 'IP address', 'Browser', 'Audit trail of changes'],
    principalTypes: ['USER'],
    lawfulBasis: 'LEGITIMATE_USE',
    legalReference: 'DPDP Act s.7(i); DPDP Rules r.6(1)(e) - logs kept for one year',
    retention: 'At least one year',
    optional: false,
  },
  {
    code: 'LABOUR_ENGAGEMENT',
    label: 'Engaging labour and contractors',
    description: 'Identifying workers, recording attendance and wages, paying them, and meeting ESIC, EPF and wage-register duties.',
    dataItems: ['Name', 'Phone', 'Address', 'Aadhaar', 'Date of birth', 'Gender', 'Bank account and IFSC', 'ESIC / UAN', 'Emergency contact', 'Attendance', 'Wages and advances'],
    principalTypes: ['PARTY'],
    lawfulBasis: 'LEGITIMATE_USE',
    legalReference: 'DPDP Act s.7(i) and s.7(a); Code on Wages, ESI and EPF law',
    retention: 'While engaged, then as wage, ESIC and EPF law requires',
    optional: false,
  },
  {
    code: 'ORDERS_AND_BILLING',
    label: 'Orders, delivery and billing',
    description: 'Quoting, delivering, invoicing and collecting payment for what you buy from us.',
    dataItems: ['Name', 'Phone', 'Email', 'Billing and delivery address', 'GSTIN', 'PAN'],
    principalTypes: ['PARTY'],
    lawfulBasis: 'LEGITIMATE_USE',
    legalReference: 'DPDP Act s.7(a) - provided voluntarily for this purpose; CGST Act s.36 record keeping',
    retention: 'Invoices and accounts: as GST and income-tax law requires',
    optional: false,
  },
  {
    code: 'VENDOR_PAYMENTS',
    label: 'Paying suppliers',
    description: 'Paying you for goods and services, and deducting tax where the law requires it.',
    dataItems: ['Name', 'Bank account and IFSC', 'Beneficiary name', 'PAN', 'GSTIN'],
    principalTypes: ['PARTY'],
    lawfulBasis: 'LEGITIMATE_USE',
    legalReference: 'DPDP Act s.7(a); Income-tax Act TDS provisions',
    retention: 'As GST and income-tax law requires',
    optional: false,
  },
  {
    code: 'SALES_FOLLOW_UP',
    label: 'Following up your enquiry',
    description: 'Calling or writing to you about the enquiry you made, and sending a quotation.',
    dataItems: ['Name', 'Contact person', 'Phone', 'Email', 'City and state', 'Your requirement'],
    principalTypes: ['LEAD'],
    lawfulBasis: 'CONSENT',
    legalReference: 'DPDP Act s.6',
    retention: 'Until the enquiry is closed, then the period in the retention schedule',
    optional: false,
  },
  {
    code: 'MARKETING',
    label: 'Offers and product updates',
    description: 'Telling you about new products, price changes and offers. You can say no and still buy from us.',
    dataItems: ['Name', 'Phone', 'Email'],
    principalTypes: ['LEAD', 'PARTY'],
    lawfulBasis: 'CONSENT',
    legalReference: 'DPDP Act s.6',
    retention: 'Until you withdraw consent',
    optional: true,
  },
];

const STARTER_PROCESSORS = [
  { name: 'Brevo (email delivery)', purpose: 'Sends sign-in, invitation and password-reset emails to staff', location: 'To be confirmed' },
  { name: 'Render (application hosting)', purpose: 'Runs the ERP server', location: 'To be confirmed' },
  { name: 'Vercel (web hosting)', purpose: 'Serves the ERP web pages', location: 'To be confirmed' },
  { name: 'Database host', purpose: 'Stores all ERP data', location: 'To be confirmed' },
];

const STARTER_SUMMARY =
  'We collect only the personal data we need to employ our staff, engage labour, serve customers, pay suppliers and answer enquiries. ' +
  'Each purpose, the data used for it and how long we keep it are listed below. You may ask to see, correct or erase your data, ' +
  'withdraw any consent you gave, nominate someone to act for you, or raise a grievance with the contact named here. ' +
  'If you are not satisfied with our answer you may complain to the Data Protection Board of India.';

/**
 * Retention categories the nightly job can act on. `minDays` is the floor a
 * business may not set below; defaults lean long because the rules start
 * switched off and an owner shortens them deliberately.
 */
const RETENTION_CATEGORIES = Object.freeze({
  LOST_LEADS: {
    label: 'Enquiries marked lost',
    description: 'Contact details of enquiries closed as lost, counted from when the lead was last changed.',
    defaultDays: 365,
    minDays: 30,
  },
  DORMANT_LEADS: {
    label: 'Enquiries nobody has touched',
    description: 'Open enquiries never converted to a customer and not changed for the whole period.',
    defaultDays: 730,
    minDays: 90,
  },
  INACTIVE_LABOUR: {
    label: 'Labour no longer engaged',
    description: 'Identity, bank and contact details of inactive labour. Name, attendance and wages stay for the wage register.',
    defaultDays: 1095,
    minDays: 365,
  },
  INACTIVE_INDIVIDUAL_CUSTOMERS: {
    label: 'Individual customers who stopped buying',
    description: 'Contact and identity details of inactive customers without a GSTIN. Invoices keep the name and state.',
    defaultDays: 2920,
    minDays: 365,
  },
  FORMER_EMPLOYEES: {
    label: 'Former employees',
    description: 'Contact details, address, documents and leave reasons of deactivated staff. Name stays on the audit trail.',
    defaultDays: 2920,
    minDays: 365,
  },
  AUDIT_LOG_SNAPSHOTS: {
    label: 'Personal values in old audit rows',
    description: 'Masks personal fields inside audit-trail snapshots older than the period. Who did what, and when, is kept.',
    defaultDays: 2920,
    minDays: MIN_LOG_RETENTION_DAYS,
  },
});

module.exports = {
  MAX_RESPONSE_DAYS,
  MIN_LOG_RETENTION_DAYS,
  BOARD_REPORT_HOURS,
  LAWFUL_BASES,
  STARTER_PURPOSES,
  STARTER_PROCESSORS,
  STARTER_SUMMARY,
  RETENTION_CATEGORIES,
};
