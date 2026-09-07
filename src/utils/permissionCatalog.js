/**
 * The single source of truth for what can be granted to a role.
 *
 * Permissions are `<RESOURCE>_<ACTION>` pairs. The four actions map one-to-one
 * onto HTTP verbs, which is what lets the route guards stay mechanical:
 *
 *   READ    GET      CREATE  POST
 *   MODIFY  PUT/PATCH        DELETE  DELETE
 *
 * Anything that isn't ordinary CRUD — approving an indent, overriding credit
 * control, seeing rate columns at all — is a named grant on the resource
 * instead, because those deliberately do NOT come along with write access.
 *
 * Backwards compatibility: roles created before this file existed hold the old
 * coarse `<RESOURCE>_WRITE` codes, and so do the seeds and several tests. Those
 * still work — `expandPermissions` widens a stored `_WRITE` into the three write
 * actions at the moment a user's effective permission set is resolved. Nothing
 * writes `_WRITE` any more, but nothing breaks if it's already in the database.
 */

const Actions = Object.freeze({
  READ: 'READ',
  CREATE: 'CREATE',
  MODIFY: 'MODIFY',
  DELETE: 'DELETE',
});

const CRUD = [Actions.READ, Actions.CREATE, Actions.MODIFY, Actions.DELETE];
const READ_ONLY = [Actions.READ];

/** Wildcard held by the seeded Platform Admin role. */
const WILDCARD = '*';

/**
 * The Reports module is gated per category rather than by one blanket
 * REPORT_READ, because "may see the stock ageing report" and "may see every
 * customer's outstanding balance" are not the same decision.
 *
 * Each category yields two codes: `REPORT_<CATEGORY>_READ` (open the reports)
 * and the named grant `REPORT_<CATEGORY>_EXPORT` (download the full filtered
 * result set). Export is a grant, not an action, for the same reason
 * PURCHASE_APPROVE is: it deliberately does not come along with read access.
 *
 * Several UI categories share one permission key on purpose — stock ageing is
 * inventory data, and payments/expenses are finance data. The nav shows 14
 * tabs; access is decided by these 11 keys.
 */
const REPORT_CATEGORIES = Object.freeze([
  { key: 'SALES', label: 'Sales Reports' },
  { key: 'ORDER', label: 'Order Reports' },
  { key: 'PURCHASE', label: 'Purchase Reports' },
  { key: 'PRODUCTION', label: 'Production Reports' },
  { key: 'INVENTORY', label: 'Inventory & Stock Ageing Reports' },
  { key: 'CUSTOMER', label: 'Customer Reports' },
  { key: 'VENDOR', label: 'Vendor Reports' },
  { key: 'CONTRACTOR', label: 'Contractor Reports' },
  { key: 'LABOUR', label: 'Labour Reports' },
  { key: 'FINANCE', label: 'Finance, Payment & Expense Reports' },
  { key: 'ANALYTICS', label: 'Management Analytics' },
]);

const REPORT_CATEGORY_RESOURCES = Object.freeze(
  REPORT_CATEGORIES.map(({ key, label }) => ({
    key: `REPORT_${key}`,
    label,
    actions: READ_ONLY,
    grants: [
      {
        code: `REPORT_${key}_EXPORT`,
        label: `Export ${label.toLowerCase()}`,
        description: 'Download the full filtered result set as Excel, PDF or CSV — not just the visible page.',
      },
    ],
  }))
);

/**
 * Modules mirror the sidebar so an admin granting access reads the same words
 * they see in the nav. `resources[].key` is the permission prefix and must not
 * change — it's baked into every authorize() call and into stored role rows.
 */
const PERMISSION_CATALOG = Object.freeze([
  {
    module: 'Administration',
    description: 'Tenant setup, access control and system configuration',
    resources: [
      { key: 'EMPLOYEE', label: 'Users', actions: CRUD },
      { key: 'ROLE', label: 'Roles & Permissions', actions: CRUD },
      { key: 'ORG', label: 'Organization Structure', actions: CRUD },
      { key: 'FACTORY', label: 'Locations & Financial Years', actions: CRUD },
      { key: 'SETTINGS', label: 'System Settings', actions: CRUD },
      {
        key: 'MIGRATION',
        label: 'Data Migration',
        actions: [],
        grants: [
          { code: 'MIGRATION_RUN', label: 'Run migration', description: 'One-time opening-balance import. High blast radius.' },
        ],
      },
    ],
  },
  {
    module: 'Masters',
    description: 'Reference data the rest of the system is built on',
    resources: [
      { key: 'PARTY', label: 'Parties (Customers, Vendors, Contractors, Labour)', actions: CRUD },
      { key: 'PRODUCT', label: 'Products, BOM, UoM & Categories', actions: CRUD },
      { key: 'VEHICLE', label: 'Vehicles', actions: CRUD },
      { key: 'PRICING', label: 'Price Lists', actions: CRUD },
    ],
  },
  {
    module: 'Sales',
    description: 'Orders through to invoices and returns',
    resources: [
      {
        key: 'SALES',
        label: 'Sales Orders',
        actions: CRUD,
        grants: [
          { code: 'SALES_CREDIT_OVERRIDE', label: 'Override credit block', description: 'Turns a credit-limit block into a warning (BR-13).' },
          { code: 'VIEW_PO_ATTACHMENTS', label: 'View PO attachments', description: 'Customer purchase-order files (BR-28).' },
          {
            code: 'SALES_BUNDLE_OVERRIDE_MANDATORY',
            label: 'Remove a mandatory bundle item',
            description: 'Takes an accessory the product does not work without off an order. Every removal is recorded with its reason.',
          },
        ],
      },
      { key: 'DISPATCH', label: 'Delivery Challans', actions: CRUD },
      { key: 'INVOICE', label: 'Sales Invoices', actions: CRUD },
      { key: 'RETURN', label: 'Returns & Credit/Debit Notes', actions: CRUD },
    ],
  },
  {
    module: 'Purchase',
    description: 'Indents, purchase orders and goods receipts',
    resources: [
      {
        key: 'PURCHASE',
        label: 'Purchasing',
        actions: CRUD,
        grants: [
          { code: 'PURCHASE_APPROVE', label: 'Approve indents', description: 'Deliberately separate from raising one (FR-M11-1).' },
        ],
      },
    ],
  },
  {
    module: 'Production',
    description: 'Plans, entries and wastage',
    resources: [
      {
        key: 'PRODUCTION',
        label: 'Production',
        actions: CRUD,
        grants: [
          { code: 'PRODUCTION_APPROVE_VARIANCE', label: 'Approve variance', description: 'Sign off a variance beyond the configured threshold (BR-09).' },
        ],
      },
      { key: 'WASTAGE', label: 'Wastage', actions: CRUD },
      {
        key: 'QUALITY',
        label: 'Quality Control',
        actions: CRUD,
      },
    ],
  },
  {
    module: 'Inventory',
    description: 'Stock, movement and transfers',
    resources: [
      {
        key: 'INVENTORY',
        label: 'Stock & Lots',
        actions: CRUD,
        grants: [
          { code: 'OVERRIDE_CURING', label: 'Override curing period', description: 'Release stock before curing completes (BR-08).' },
          { code: 'OVERRIDE_LOT_SELECTION', label: 'Override FIFO lot selection', description: 'Pick a specific lot instead of FIFO (BR-03).' },
        ],
      },
      { key: 'TRANSFER', label: 'Stock Transfers', actions: CRUD },
    ],
  },
  {
    module: 'Workforce',
    description: 'Contractor and labour operations',
    resources: [
      { key: 'CONTRACTOR', label: 'Contractors', actions: CRUD },
      { key: 'LABOUR', label: 'Labour & Attendance', actions: CRUD },
    ],
  },
  {
    module: 'Finance',
    description: 'Money in, money out, and the books',
    resources: [
      { key: 'RECEIPT', label: 'Receipts', actions: CRUD },
      { key: 'PAYMENT', label: 'Payments', actions: CRUD },
      { key: 'EXPENSE', label: 'Expenses', actions: CRUD },
      { key: 'FINANCE_ADJUSTMENT', label: 'Finance Adjustments', actions: CRUD },
      { key: 'LEDGER', label: 'Ledger & Trial Balance', actions: READ_ONLY },
      { key: 'GSTR', label: 'GST Returns', actions: READ_ONLY },
      {
        key: 'RATES',
        label: 'Rates & Amounts',
        actions: [],
        grants: [
          {
            code: 'VIEW_RATES',
            label: 'View rates and amounts',
            description: 'Without this, money fields are stripped from API responses entirely (BR-27) — it is not a route gate.',
          },
        ],
      },
    ],
  },
  {
    module: 'Reports & Analytics',
    description: 'Saved reports, dashboards and document search',
    resources: [
      { key: 'REPORT', label: 'Saved Reports', actions: CRUD },
      { key: 'ANALYTICS', label: 'Analytics & Dashboards', actions: READ_ONLY },
    ],
  },
  {
    module: 'Reports',
    description:
      'The Reports module, gated per category. READ opens the reports in that category; EXPORT is a separate grant because ' +
      'downloading a whole filtered result set is a materially different act from reading one page of it on screen.',
    resources: REPORT_CATEGORY_RESOURCES,
  },
  {
    module: 'Audit',
    description: 'Who changed what',
    resources: [{ key: 'AUDIT', label: 'Audit Log', actions: READ_ONLY }],
  },
]);

const permissionCode = (resourceKey, action) => `${resourceKey}_${action}`;

/** Every grantable code, in catalog order. */
const ALL_PERMISSIONS = Object.freeze(
  PERMISSION_CATALOG.flatMap((module) =>
    module.resources.flatMap((resource) => [
      ...resource.actions.map((action) => permissionCode(resource.key, action)),
      ...(resource.grants || []).map((grant) => grant.code),
    ])
  )
);

const ALL_PERMISSION_SET = new Set(ALL_PERMISSIONS);

/**
 * `<RESOURCE>_WRITE` -> the three write actions. Only resources that actually
 * accept writes get an alias, so a stale `LEDGER_WRITE` stays meaningless.
 */
const LEGACY_WRITE_ALIASES = Object.freeze(
  Object.fromEntries(
    PERMISSION_CATALOG.flatMap((module) => module.resources)
      .filter((resource) => resource.actions.includes(Actions.CREATE))
      .map((resource) => [
        permissionCode(resource.key, 'WRITE'),
        [
          permissionCode(resource.key, Actions.CREATE),
          permissionCode(resource.key, Actions.MODIFY),
          permissionCode(resource.key, Actions.DELETE),
        ],
      ])
  )
);

/** True for a code a role is allowed to store — new codes and legacy aliases both. */
const isKnownPermission = (code) =>
  code === WILDCARD || ALL_PERMISSION_SET.has(code) || Object.hasOwn(LEGACY_WRITE_ALIASES, code);

/**
 * Turn what a role *stores* into what its holders can *do*.
 *
 * Called once per request path that resolves a user (login and /auth/me), not
 * per authorize() check, so the cost is paid once and every downstream check
 * stays a plain Set lookup.
 */
const expandPermissions = (permissions = []) => {
  const effective = new Set();

  for (const permission of permissions) {
    // The wildcard is deliberately NOT expanded here. It travels in the JWT, and
    // inlining all ~110 codes pushes the auth cookie towards the browser's 4KB
    // per-cookie limit; `holdsPermission` understands `*` directly instead.
    const aliased = LEGACY_WRITE_ALIASES[permission];
    if (aliased) {
      // The old coarse code also implied read on the same resource.
      effective.add(permission.replace(/_WRITE$/, `_${Actions.READ}`));
      aliased.forEach((code) => effective.add(code));
      continue;
    }

    effective.add(permission);
  }

  return [...effective];
};

/**
 * Does this already-expanded permission list satisfy `required`?
 * The one place `*` is interpreted, so callers never have to remember it.
 */
const holdsPermission = (permissions, required) =>
  Array.isArray(permissions) && (permissions.includes(WILDCARD) || permissions.includes(required));

/** Drop unknown codes, de-duplicate, and return them in a stable catalog order. */
const normalizePermissions = (permissions = []) => {
  const requested = new Set(permissions.filter(isKnownPermission));
  const ordered = ALL_PERMISSIONS.filter((code) => requested.has(code));
  const legacy = Object.keys(LEGACY_WRITE_ALIASES).filter((code) => requested.has(code));
  return requested.has(WILDCARD) ? [WILDCARD] : [...ordered, ...legacy];
};

module.exports = {
  Actions,
  WILDCARD,
  PERMISSION_CATALOG,
  REPORT_CATEGORIES,
  ALL_PERMISSIONS,
  LEGACY_WRITE_ALIASES,
  permissionCode,
  isKnownPermission,
  expandPermissions,
  holdsPermission,
  normalizePermissions,
};
