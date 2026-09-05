const { Op } = require('sequelize');
const { searchWhere, toOrder } = require('../../utils/pagination');
const { Vehicle } = require('./vehicle.model');
const { Party } = require('../parties/party.model');
const { NotFoundError, ConflictError, ValidationError } = require('../../core/AppError');

const SORTABLE = ['registrationNumber', 'vehicleType', 'ownership', 'status', 'createdAt'];

/**
 * Registrations are compared with spaces and hyphens stripped and the rest
 * upper-cased, because "OD 02 AB 1234" and "od-02-ab-1234" are the same lorry
 * and letting both exist defeats the entire purpose of the master.
 */
const normalise = (reg) => String(reg || '').toUpperCase().replace(/[\s-]/g, '');

class VehicleService {
  static async list(page, limit, { status, vehicleType, ownership, search, sortBy, sortDir } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (status) where.status = status;
    if (vehicleType) where.vehicleType = vehicleType;
    if (ownership) where.ownership = ownership;
    if (search) Object.assign(where, searchWhere(search, ['registrationNumber', 'driverName']));

    return Vehicle.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Party, as: 'transporter' }],
      order: toOrder(sortBy, sortDir, SORTABLE, [['registrationNumber', 'ASC']]),
    });
  }

  static async get(id) {
    const vehicle = await Vehicle.findByPk(id, { include: [{ model: Party, as: 'transporter' }] });
    if (!vehicle) throw new NotFoundError('Vehicle not found');
    return vehicle;
  }

  static async assertRegistrationFree(registrationNumber, excludeId) {
    const target = normalise(registrationNumber);
    const candidates = await Vehicle.findAll({ attributes: ['id', 'registrationNumber'] });
    const clash = candidates.find((v) => normalise(v.registrationNumber) === target && v.id !== excludeId);
    if (clash) {
      throw new ConflictError(
        `Vehicle ${clash.registrationNumber} is already registered — the same number cannot be added twice, however it is spaced or punctuated.`
      );
    }
  }

  /**
   * A lorry that is not ours belongs to somebody, and that somebody is who gets
   * chased when it turns up late or damages a load. Recording the ownership as
   * HIRED without naming the transporter leaves the challan pointing at nobody,
   * which is the free-text mess this master exists to replace.
   */
  static async assertTransporter(data) {
    // Only HIRED actually stores a transporter (see create/update below), so it
    // is the only ownership that can meaningfully require one. MARKET and
    // ATTACHED lorries are one-off or loosely tied and have nobody standing
    // behind them on the master.
    if (data.ownership !== 'HIRED') return;

    if (!data.transporterPartyId) {
      throw new ValidationError('A hired vehicle needs the transporter it belongs to');
    }

    const party = await Party.findByPk(data.transporterPartyId);
    if (!party) throw new NotFoundError('Transporter not found');
    if (party.status !== 'active') throw new ValidationError('That transporter is inactive');
  }

  static async create(data) {
    await this.assertRegistrationFree(data.registrationNumber);
    await this.assertTransporter(data);
    const vehicle = await Vehicle.create({
      ...data,
      registrationNumber: String(data.registrationNumber).trim().toUpperCase(),
      // An owned lorry has no transporter, whatever the form sent.
      transporterPartyId: data.ownership === 'HIRED' ? data.transporterPartyId : null,
    });
    return this.get(vehicle.id);
  }

  static async update(id, data) {
    const vehicle = await this.get(id);
    if (data.registrationNumber) await this.assertRegistrationFree(data.registrationNumber, id);

    const ownership = data.ownership || vehicle.ownership;
    // A partial edit that touches neither field must not read as "transporter
    // removed" — fall back to the one already on record.
    const transporterPartyId =
      'transporterPartyId' in data ? data.transporterPartyId : vehicle.transporterPartyId;
    await this.assertTransporter({ ...data, ownership, transporterPartyId });

    await vehicle.update({
      ...data,
      ...(data.registrationNumber ? { registrationNumber: String(data.registrationNumber).trim().toUpperCase() } : {}),
      ...(ownership === 'HIRED' ? {} : { transporterPartyId: null }),
    });
    return this.get(id);
  }

  /**
   * Deactivates rather than deletes.
   *
   * Challans store the registration as text, so a delete would not orphan a
   * foreign key — but it would silently erase the only record of whose lorry
   * carried a signed, printed document. Every other master in this system
   * takes the same line (see core/masterGuards.js).
   */
  static async remove(id) {
    const vehicle = await this.get(id);
    if (vehicle.status === 'inactive') {
      throw new ValidationError('This vehicle is already inactive');
    }
    await vehicle.update({ status: 'inactive' });
    return { deactivated: true };
  }

  /**
   * Registrations that are expiring or already expired, for the compliance
   * nudge on the list screen. `withinDays` 0 means "already expired".
   */
  static async listExpiring(withinDays = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + Number(withinDays));
    const iso = cutoff.toISOString().slice(0, 10);

    return Vehicle.findAll({
      where: {
        status: 'active',
        [Op.or]: [
          { insuranceExpiry: { [Op.lte]: iso } },
          { fitnessExpiry: { [Op.lte]: iso } },
          { permitExpiry: { [Op.lte]: iso } },
        ],
      },
      order: [['registrationNumber', 'ASC']],
    });
  }
}

module.exports = { VehicleService };
