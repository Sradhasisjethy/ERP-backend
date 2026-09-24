const { LeaveType } = require('../../hr/hr.model');
const { HrService } = require('../../hr/hr.service');

/**
 * Leave types — a short list, but one every tenant sets up differently and one
 * that is far quicker to paste from a policy document than to type in one
 * dialog at a time.
 */

const leaveTypes = {
  key: 'leave-types',
  label: 'Leave Types',
  fileBase: 'Leave_Types',
  resource: 'LEAVE',
  businessKey: 'code',
  businessKeyHeader: 'Leave Code',
  notes: [
    { key: 'Days Per Year', value: 'The entitlement for a full financial year (April to March). Half days are allowed, e.g. 7.5.' },
    { key: 'Balances', value: 'Changing Days Per Year changes what everyone is entitled to from that moment. Leave already approved is not re-costed.' },
  ],
  columns: [
    { header: 'ID', field: 'id', type: 'text', readOnly: true, note: 'Filled in by Export. Leave blank for a new record.' },
    { header: 'Leave Code', field: 'code', type: 'code', required: true, maxLength: 20, example: 'CL', note: 'unique; used to match an existing leave type' },
    { header: 'Leave Name', field: 'name', type: 'text', required: true, maxLength: 80, example: 'Casual Leave' },
    { header: 'Days Per Year', field: 'daysPerYear', type: 'number', min: 0, max: 366, example: 12 },
    { header: 'Paid', field: 'isPaid', type: 'boolean', example: 'Yes', note: 'unpaid leave still records attendance, it just does not draw salary' },
    { header: 'Description', field: 'description', type: 'text', maxLength: 255, example: 'Short notice personal leave' },
    {
      header: 'Status', field: 'isActive', type: 'enum', values: ['Active', 'Inactive'],
      enumMap: { Active: true, Inactive: false }, example: 'Active',
    },
  ],
  examples: [
    { code: 'CL', name: 'Casual Leave', daysPerYear: 12, isPaid: 'Yes', description: 'Short notice personal leave', isActive: 'Active' },
    { code: 'LWP', name: 'Leave Without Pay', daysPerYear: 0, isPaid: 'No', description: '', isActive: 'Active' },
  ],
  load: async ({ query = {} }) =>
    LeaveType.findAll({
      where: query.includeInactive === 'true' || query.includeInactive === true ? {} : { isActive: true },
      order: [['code', 'ASC']],
    }),
  create: async (values) => {
    const created = await HrService.createLeaveType(values);
    // createLeaveType has no isActive argument — a type is born active. A file
    // that asks for an inactive one gets it in a second step rather than by
    // widening the service signature for one caller.
    if (values.isActive === false) return HrService.updateLeaveType(created.id, { isActive: false });
    return created;
  },
  update: (record, values) => HrService.updateLeaveType(record.id, values),
};

module.exports = { leaveTypes };
