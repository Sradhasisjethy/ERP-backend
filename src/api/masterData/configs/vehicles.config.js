const { Op } = require('sequelize');
const { Vehicle } = require('../../vehicles/vehicle.model');
const { Party } = require('../../parties/party.model');
const { VehicleService } = require('../../vehicles/vehicles.service');

/**
 * The lorry fleet, matched on its registration number — the one thing about a
 * vehicle that is unique, printed on every challan, and never retyped twice
 * differently.
 *
 * A hired vehicle must name the transporter it belongs to; VehicleService
 * enforces that, and the importer inherits the rule rather than restating it.
 */

const ownerships = { Owned: 'OWNED', Hired: 'HIRED', Market: 'MARKET', Attached: 'ATTACHED' };
const vehicleTypes = {
  Truck: 'TRUCK', Trailer: 'TRAILER', Tipper: 'TIPPER',
  'Transit Mixer': 'TRANSIT_MIXER', Pickup: 'PICKUP', Other: 'OTHER',
};
const statuses = { Active: 'active', Maintenance: 'maintenance', Blacklisted: 'blacklisted', Inactive: 'inactive' };

const vehicles = {
  key: 'vehicles',
  label: 'Vehicles',
  fileBase: 'Vehicles',
  resource: 'VEHICLE',
  businessKey: 'registrationNumber',
  businessKeyHeader: 'Registration Number',
  dependsOn: 'A hired vehicle names its transporter by party code, so import Parties first.',
  notes: [
    { key: 'Hired vehicles', value: 'Ownership "Hired" requires a Transporter Code, and the transporter must be an active party.' },
    { key: 'Expiry dates', value: 'Insurance, fitness, permit and PUCC dates feed the compliance reminder on the vehicle list.' },
  ],
  columns: [
    { header: 'ID', field: 'id', type: 'text', readOnly: true, note: 'Filled in by Export. Leave blank for a new record.' },
    {
      header: 'Registration Number', field: 'registrationNumber', type: 'code', required: true, maxLength: 20,
      example: 'OD02AB1234', note: 'unique; used to match an existing vehicle',
    },
    { header: 'Vehicle Type', field: 'vehicleType', type: 'enum', required: true, values: Object.keys(vehicleTypes), enumMap: vehicleTypes, example: 'Truck' },
    { header: 'Ownership', field: 'ownership', type: 'enum', required: true, values: Object.keys(ownerships), enumMap: ownerships, example: 'Owned' },
    {
      header: 'Transporter Code', field: 'transporterPartyId', type: 'reference',
      reference: { master: 'parties', label: 'the Parties master' },
      exportValue: (record) => record.transporter?.code || null,
      example: '', note: 'required when Ownership is Hired',
    },
    { header: 'Capacity (Tonnes)', field: 'capacityTonnes', type: 'number', min: 0, example: 16 },
    { header: 'Tare Weight (Tonnes)', field: 'tareWeightTonnes', type: 'number', min: 0, example: 7.5 },
    { header: 'Gross Weight (Tonnes)', field: 'grossVehicleWeightTonnes', type: 'number', min: 0, example: 25 },
    { header: 'Body Configuration', field: 'bodyConfiguration', type: 'text', maxLength: 100, example: '10-wheeler open body' },
    { header: 'Driver Name', field: 'driverName', type: 'text', maxLength: 100, example: 'Ramesh Sahoo' },
    { header: 'Driver Phone', field: 'driverPhone', type: 'text', maxLength: 20, example: '9861000000' },
    { header: 'Driver Licence Number', field: 'driverLicenseNumber', type: 'text', maxLength: 30, example: 'OD0220100012345' },
    { header: 'Insurance Expiry', field: 'insuranceExpiry', type: 'date', example: '31/03/2027' },
    { header: 'Fitness Expiry', field: 'fitnessExpiry', type: 'date', example: '30/09/2027' },
    { header: 'Permit Expiry', field: 'permitExpiry', type: 'date', example: '31/12/2026' },
    { header: 'PUCC Expiry', field: 'puccExpiry', type: 'date', example: '30/06/2027' },
    { header: 'FASTag Number', field: 'fastagNumber', type: 'text', maxLength: 30, example: '' },
    { header: 'GPS Device ID', field: 'gpsDeviceId', type: 'text', maxLength: 50, example: '' },
    { header: 'Notes', field: 'notes', type: 'text', maxLength: 500, example: '' },
    { header: 'Status', field: 'status', type: 'enum', values: Object.keys(statuses), enumMap: statuses, example: 'Active' },
  ],
  examples: [
    { registrationNumber: 'OD02AB1234', vehicleType: 'Truck', ownership: 'Owned', transporterPartyId: '', capacityTonnes: 16, tareWeightTonnes: 7.5, grossVehicleWeightTonnes: 25, bodyConfiguration: '10-wheeler open body', driverName: 'Ramesh Sahoo', driverPhone: '9861000000', driverLicenseNumber: 'OD0220100012345', insuranceExpiry: '31/03/2027', fitnessExpiry: '30/09/2027', permitExpiry: '31/12/2026', puccExpiry: '30/06/2027', fastagNumber: '', gpsDeviceId: '', notes: '', status: 'Active' },
    { registrationNumber: 'OD05CD5678', vehicleType: 'Tipper', ownership: 'Hired', transporterPartyId: 'VEND-0001', capacityTonnes: 12, tareWeightTonnes: '', grossVehicleWeightTonnes: '', bodyConfiguration: '', driverName: '', driverPhone: '', driverLicenseNumber: '', insuranceExpiry: '', fitnessExpiry: '', permitExpiry: '', puccExpiry: '', fastagNumber: '', gpsDeviceId: '', notes: 'On hire from Odisha Cement Traders', status: 'Active' },
  ],
  load: async ({ query = {} }) =>
    Vehicle.findAll({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.vehicleType ? { vehicleType: query.vehicleType } : {}),
        ...(query.ownership ? { ownership: query.ownership } : {}),
        ...(query.search
          ? { [Op.or]: ['registrationNumber', 'driverName'].map((column) => ({ [column]: { [Op.iLike]: `%${query.search}%` } })) }
          : {}),
      },
      include: [{ model: Party, as: 'transporter', attributes: ['id', 'code'] }],
      order: [['registrationNumber', 'ASC']],
    }),
  create: (values) => VehicleService.create(values),
  update: (record, values) => VehicleService.update(record.id, values),
};

module.exports = { vehicles };
