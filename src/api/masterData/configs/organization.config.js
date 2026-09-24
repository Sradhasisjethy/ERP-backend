const { Op } = require('sequelize');
const { Office } = require('../../organization/office.model');
const { Department } = require('../../organization/department.model');
const { Organization } = require('../../organization/organization.model');
const { OrganizationService } = require('../../organization/organization.service');

/**
 * Offices and departments — the two org-structure masters that are actually
 * lists. Organizations themselves are not importable: a tenant has one or two,
 * they are created during onboarding, and everything else hangs off them.
 *
 * Neither table has a unique index on `code`, so the importer requires one and
 * refuses a file that repeats it. That is the same trade the Parties import
 * makes: the alternative is a second upload silently duplicating the structure.
 */

const STATUS = {
  header: 'Status', field: 'status', type: 'enum', values: ['Active', 'Inactive'],
  enumMap: { Active: 'active', Inactive: 'inactive' }, example: 'Active',
};

const ID_COLUMN = { header: 'ID', field: 'id', type: 'text', readOnly: true, note: 'Filled in by Export. Leave blank for a new record.' };

const ORGANIZATION_COLUMN = {
  header: 'Organization Code', field: 'organizationId', type: 'reference', required: true,
  reference: { master: 'organizations', label: 'the Organizations master' },
  // Office belongsTo Organization, so its export carries the association.
  // Department does not — `organizationId` is a plain foreign key there — so
  // its loader resolves the code itself rather than have an association added
  // to the model for one reader.
  exportValue: (record) => record.Organization?.code || record.organizationCode || null,
  example: 'RPL',
};

const offices = {
  key: 'offices',
  label: 'Offices',
  fileBase: 'Offices',
  resource: 'ORG',
  businessKey: 'code',
  businessKeyHeader: 'Office Code',
  dependsOn: 'The organization named by Organization Code must already exist.',
  columns: [
    ID_COLUMN,
    { header: 'Office Code', field: 'code', type: 'code', required: true, maxLength: 50, example: 'HO-BBSR', note: 'unique; used to match an existing office' },
    { header: 'Office Name', field: 'name', type: 'text', required: true, maxLength: 255, example: 'Head Office Bhubaneswar' },
    ORGANIZATION_COLUMN,
    { header: 'Address', field: 'address', type: 'text', maxLength: 500, example: 'Plot 12, Saheed Nagar' },
    { header: 'City', field: 'city', type: 'text', maxLength: 100, example: 'Bhubaneswar' },
    { header: 'State', field: 'state', type: 'text', maxLength: 100, example: 'Odisha' },
    { header: 'Country', field: 'country', type: 'text', maxLength: 100, example: 'India' },
    { header: 'Pincode', field: 'pincode', type: 'text', maxLength: 20, example: '751007' },
    { header: 'Latitude', field: 'latitude', type: 'number', min: -90, max: 90, example: 20.2961 },
    { header: 'Longitude', field: 'longitude', type: 'number', min: -180, max: 180, example: 85.8245 },
    { header: 'Geofence Radius (m)', field: 'geofenceRadius', type: 'integer', min: 0, example: 200 },
    STATUS,
  ],
  examples: [
    { code: 'HO-BBSR', name: 'Head Office Bhubaneswar', organizationId: 'RPL', address: 'Plot 12, Saheed Nagar', city: 'Bhubaneswar', state: 'Odisha', country: 'India', pincode: '751007', latitude: 20.2961, longitude: 85.8245, geofenceRadius: 200, status: 'Active' },
    { code: 'BR-CTC', name: 'Cuttack Branch', organizationId: 'RPL', address: 'NH-16, Cuttack Road', city: 'Cuttack', state: 'Odisha', country: 'India', pincode: '753001', latitude: '', longitude: '', geofenceRadius: '', status: 'Active' },
  ],
  load: async ({ query = {} }) =>
    Office.findAll({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.organizationId ? { organizationId: query.organizationId } : {}),
        ...(query.search ? { [Op.or]: [{ name: { [Op.iLike]: `%${query.search}%` } }, { code: { [Op.iLike]: `%${query.search}%` } }] } : {}),
      },
      include: [{ model: Organization, attributes: ['id', 'code'] }],
      order: [['code', 'ASC']],
    }),
  create: (values) => OrganizationService.createOffice(values),
  update: (record, values) => OrganizationService.updateOffice(record.id, values),
};

const departments = {
  key: 'departments',
  label: 'Departments',
  fileBase: 'Departments',
  resource: 'ORG',
  businessKey: 'code',
  businessKeyHeader: 'Department Code',
  dependsOn: 'Import Offices before Departments, and a parent department before the departments under it.',
  notes: [
    { key: 'Department Head', value: 'Not set by this import — a head is an employee, and picking one belongs on the Departments screen where you can see who is available.' },
  ],
  columns: [
    ID_COLUMN,
    { header: 'Department Code', field: 'code', type: 'code', required: true, maxLength: 50, example: 'PROD', note: 'unique; used to match an existing department' },
    { header: 'Department Name', field: 'name', type: 'text', required: true, maxLength: 255, example: 'Production' },
    ORGANIZATION_COLUMN,
    {
      header: 'Office Code', field: 'officeId', type: 'reference',
      reference: { master: 'offices', label: 'the Offices master' },
      exportValue: (record) => record.Office?.code || null,
      example: 'HO-BBSR',
    },
    {
      header: 'Parent Department Code', field: 'parentId', type: 'reference',
      reference: { master: 'departments', label: 'the Departments master' },
      exportValue: (record) => record.parentDepartment?.code || null,
      example: '',
    },
    STATUS,
  ],
  examples: [
    { code: 'PROD', name: 'Production', organizationId: 'RPL', officeId: 'HO-BBSR', parentId: '', status: 'Active' },
    { code: 'PROD-QC', name: 'Quality Control', organizationId: 'RPL', officeId: 'HO-BBSR', parentId: 'PROD', status: 'Active' },
  ],
  load: async ({ query = {} }) => {
    const rows = await Department.findAll({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.organizationId ? { organizationId: query.organizationId } : {}),
        ...(query.officeId ? { officeId: query.officeId } : {}),
        ...(query.search ? { [Op.or]: [{ name: { [Op.iLike]: `%${query.search}%` } }, { code: { [Op.iLike]: `%${query.search}%` } }] } : {}),
      },
      include: [
        { model: Office, attributes: ['id', 'code'] },
        { model: Department, as: 'parentDepartment', attributes: ['id', 'code'] },
      ],
      order: [['code', 'ASC']],
    });

    const organizations = new Map(
      (await Organization.findAll({ attributes: ['id', 'code'] })).map((org) => [org.id, org.code])
    );
    return rows.map((row) => ({ ...row.toJSON(), organizationCode: organizations.get(row.organizationId) || null }));
  },
  create: (values) => OrganizationService.createDepartment(values),
  update: (record, values) => OrganizationService.updateDepartment(record.id, values),
};

module.exports = { offices, departments };
