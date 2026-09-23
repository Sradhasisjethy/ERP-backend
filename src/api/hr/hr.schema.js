const { z } = require('zod');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times are HH:MM');
const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY'];

const createLeaveTypeSchema = z.object({
  body: z.object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(80),
    // 0 means there is no yearly quota — unpaid or exceptional leave.
    daysPerYear: z.coerce.number().min(0).max(365).optional(),
    isPaid: z.boolean().optional(),
    description: z.string().max(500).optional(),
  }),
});

const updateLeaveTypeSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    daysPerYear: z.coerce.number().min(0).max(365).optional(),
    isPaid: z.boolean().optional(),
    isActive: z.boolean().optional(),
    description: z.string().max(500).optional().nullable(),
  }),
});

const applyLeaveSchema = z.object({
  body: z.object({
    employeeId: z.string().uuid(),
    leaveTypeId: z.string().uuid(),
    fromDate: isoDate,
    toDate: isoDate,
    // Halves are allowed; omit for the whole span.
    days: z.coerce.number().positive().optional(),
    reason: z.string().max(1000).optional(),
  }),
});

const decideLeaveSchema = z.object({
  body: z.object({
    status: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().max(1000).optional(),
  }),
});

const leaveListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  employeeId: z.string().uuid().optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const balanceQuerySchema = z.object({
  employeeId: z.string().uuid(),
  date: isoDate.optional(),
});

const markAttendanceSchema = z.object({
  body: z.object({
    attendanceDate: isoDate,
    factoryId: z.string().uuid().optional(),
    entries: z
      .array(
        z.object({
          employeeId: z.string().uuid(),
          status: z.enum(ATTENDANCE_STATUSES),
          inTime: time.optional(),
          outTime: time.optional(),
          note: z.string().max(500).optional(),
        })
      )
      .min(1),
  }),
});

const attendanceListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(200).default(10),
  employeeId: z.string().uuid().optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const rosterQuerySchema = z.object({ date: isoDate });

const summaryQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  employeeId: z.string().uuid().optional(),
});

module.exports = {
  createLeaveTypeSchema, updateLeaveTypeSchema, applyLeaveSchema, decideLeaveSchema,
  leaveListQuerySchema, balanceQuerySchema, markAttendanceSchema, attendanceListQuerySchema,
  rosterQuerySchema, summaryQuerySchema, ATTENDANCE_STATUSES,
};
