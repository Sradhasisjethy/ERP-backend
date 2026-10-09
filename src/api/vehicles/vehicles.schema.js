const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH } = require('../../utils/zodFields');

const vehicleBody = {
  registrationNumber: z.string().trim().min(4).max(20),
  vehicleType: z.enum(['TRUCK', 'TRAILER', 'TIPPER', 'TRANSIT_MIXER', 'PICKUP', 'OTHER']).optional(),
  bodyConfiguration: z.string().trim().max(MAX_STRING).optional(),
  capacityTonnes: z.coerce.number().positive().finite().optional(),
  tareWeightTonnes: z.coerce.number().min(0).finite().optional(),
  grossVehicleWeightTonnes: z.coerce.number().min(0).finite().optional(),
  ownership: z.enum(['OWNED', 'HIRED', 'MARKET', 'ATTACHED']).optional(),
  transporterPartyId: z.string().uuid().optional().nullable().or(z.literal('')),
  driverName: z.string().trim().max(MAX_STRING).optional(),
  driverPhone: z.string().trim().max(MAX_STRING).optional(),
  driverLicenseNumber: z.string().trim().max(MAX_STRING).optional(),
  insuranceExpiry: isoDate.optional().nullable().or(z.literal('')),
  fitnessExpiry: isoDate.optional().nullable().or(z.literal('')),
  permitExpiry: isoDate.optional().nullable().or(z.literal('')),
  puccExpiry: isoDate.optional().nullable().or(z.literal('')),
  fastagNumber: z.string().trim().max(MAX_STRING).optional(),
  gpsDeviceId: z.string().trim().max(MAX_STRING).optional(),
  status: z.enum(['active', 'maintenance', 'blacklisted', 'inactive']).optional(),
  blacklistReason: z.string().trim().max(MAX_TEXT).optional(),
  notes: z.string().trim().max(MAX_TEXT).optional(),
};

const createVehicleSchema = z.object({ body: z.object(vehicleBody) });
const updateVehicleSchema = z.object({
  body: z.object({ ...vehicleBody, registrationNumber: vehicleBody.registrationNumber.optional() }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['active', 'maintenance', 'blacklisted', 'inactive']).optional(),
  vehicleType: z.enum(['TRUCK', 'TRAILER', 'TIPPER', 'TRANSIT_MIXER', 'PICKUP', 'OTHER']).optional(),
  ownership: z.enum(['OWNED', 'HIRED', 'MARKET', 'ATTACHED']).optional(),
});

module.exports = { createVehicleSchema, updateVehicleSchema, listQuerySchema };
