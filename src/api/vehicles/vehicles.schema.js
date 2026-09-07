const { z } = require('zod');

const vehicleBody = {
  registrationNumber: z.string().trim().min(4).max(20),
  vehicleType: z.enum(['TRUCK', 'TRAILER', 'TIPPER', 'TRANSIT_MIXER', 'PICKUP', 'OTHER']).optional(),
  bodyConfiguration: z.string().trim().optional(),
  capacityTonnes: z.coerce.number().positive().optional(),
  tareWeightTonnes: z.coerce.number().min(0).optional(),
  grossVehicleWeightTonnes: z.coerce.number().min(0).optional(),
  ownership: z.enum(['OWNED', 'HIRED', 'MARKET', 'ATTACHED']).optional(),
  transporterPartyId: z.string().uuid().optional().nullable().or(z.literal('')),
  driverName: z.string().trim().optional(),
  driverPhone: z.string().trim().optional(),
  driverLicenseNumber: z.string().trim().optional(),
  insuranceExpiry: z.string().optional().nullable().or(z.literal('')),
  fitnessExpiry: z.string().optional().nullable().or(z.literal('')),
  permitExpiry: z.string().optional().nullable().or(z.literal('')),
  puccExpiry: z.string().optional().nullable().or(z.literal('')),
  fastagNumber: z.string().trim().optional(),
  gpsDeviceId: z.string().trim().optional(),
  status: z.enum(['active', 'maintenance', 'blacklisted', 'inactive']).optional(),
  blacklistReason: z.string().trim().optional(),
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
  status: z.enum(['active', 'maintenance', 'blacklisted', 'inactive']).optional(),
  vehicleType: z.enum(['TRUCK', 'TRAILER', 'TIPPER', 'TRANSIT_MIXER', 'PICKUP', 'OTHER']).optional(),
  ownership: z.enum(['OWNED', 'HIRED', 'MARKET', 'ATTACHED']).optional(),
});

module.exports = { createVehicleSchema, updateVehicleSchema, listQuerySchema };
