const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./hr.controller');
const schema = require('./hr.schema');

const hrRouter = Router();

hrRouter.use(authenticate, tenantScope, auditContext);

// Leave types are configuration, so maintaining them goes with the rest of the
// HR setup rather than with applying for leave.
hrRouter.get('/leave-types', authorize('LEAVE_READ'), controller.listLeaveTypes);
hrRouter.post('/leave-types', authorize('LEAVE_MODIFY'), validate(schema.createLeaveTypeSchema), controller.createLeaveType);
hrRouter.put('/leave-types/:id', authorize('LEAVE_MODIFY'), validate(schema.updateLeaveTypeSchema), controller.updateLeaveType);

hrRouter.get('/leave-balances', authorize('LEAVE_READ'), validate(schema.balanceQuerySchema, 'query'), controller.leaveBalances);
hrRouter.get('/leave-requests', authorize('LEAVE_READ'), validate(schema.leaveListQuerySchema, 'query'), controller.listLeaveRequests);
hrRouter.post('/leave-requests', authorize('LEAVE_CREATE'), validate(schema.applyLeaveSchema), controller.applyForLeave);
hrRouter.get('/leave-requests/:id', authorize('LEAVE_READ'), controller.getLeaveRequest);
// Deciding is its own grant: raising a request and approving one are different
// jobs, the same split purchase indents use (FR-M11-1).
hrRouter.put('/leave-requests/:id/decision', authorize('LEAVE_APPROVE'), validate(schema.decideLeaveSchema), controller.decideLeave);
hrRouter.put('/leave-requests/:id/cancel', authorize('LEAVE_MODIFY'), controller.cancelLeave);

hrRouter.get('/attendance/roster', authorize('STAFF_ATTENDANCE_READ'), validate(schema.rosterQuerySchema, 'query'), controller.attendanceRoster);
hrRouter.get('/attendance/summary', authorize('STAFF_ATTENDANCE_READ'), validate(schema.summaryQuerySchema, 'query'), controller.attendanceSummary);
hrRouter.get('/attendance', authorize('STAFF_ATTENDANCE_READ'), validate(schema.attendanceListQuerySchema, 'query'), controller.listAttendance);
hrRouter.post('/attendance', authorize('STAFF_ATTENDANCE_CREATE'), validate(schema.markAttendanceSchema), controller.markAttendance);

module.exports = { hrRouter };
