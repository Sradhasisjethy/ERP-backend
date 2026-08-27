const { z } = require('zod');

const vehicleBody = {
  registrationNumber: z.string().trim().min(4).max(20),
  vehicleType: z.enum(['TRUCK', 'TRAILER', 'TIPPER', 'TRANSIT_MIXER', 'PICKUP', 'OTHER']).optional(),
  capacityTonnes: z.coerce.number().positive().optional(),
  ownership: z.enum(['OWNED', 'HIRED']).optional(),
  transporterPartyId: z.string().uuid().optional().nullable(),
  driverName: z.string().trim().min(1).optional(),
  driverPhone: z.string().trim().min(6).max(20).optional(),
  insuranceExpiry: z.string().optional(),
  fitnessExpiry: z.string().optional(),
  permitExpiry: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  notes: z.string().trim().optional(),
};

const createVehicleSchema = z.object({ body: z.object(vehicleBody) });
const updateVehicleSchema = z.object({
  body: z.object({ ...vehicleBody, registrationNumber: vehicleBody.registrationNumber.optional() }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  vehicleType: z.enum(['TRUCK', 'TRAILER', 'TIPPER', 'TRANSIT_MIXER', 'PICKUP', 'OTHER']).optional(),
  ownership: z.enum(['OWNED', 'HIRED']).optional(),
});

module.exports = { createVehicleSchema, updateVehicleSchema, listQuerySchema };
