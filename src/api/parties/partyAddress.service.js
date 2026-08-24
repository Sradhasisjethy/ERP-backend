const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { PartyAddress } = require('./partyAddress.model');
const { Party } = require('./party.model');
const { stateCodeFor } = require('../invoicing/taxDetermination');
const { NotFoundError, ValidationError } = require('../../core/AppError');

class PartyAddressService {
  static async listForParty(partyId) {
    const party = await Party.findByPk(partyId);
    if (!party) throw new NotFoundError('Party not found');
    return PartyAddress.findAll({
      where: { partyId },
      order: [['isDefaultBilling', 'DESC'], ['isDefaultShipping', 'DESC'], ['createdAt', 'ASC']],
    });
  }

  /**
   * Addresses are always reached through `/parties/:id/addresses/:addressId`,
   * so the address must be verified to belong to the party named in the path.
   * Without that check the party segment is decorative: any address id could
   * be edited or deleted through any party's URL. Tenant scoping still bounds
   * the damage to one tenant, but "edit customer A's delivery address via
   * customer B" is exactly the confusion that reroutes a dispatch.
   */
  static async get(id, partyId) {
    const where = partyId ? { id, partyId } : { id };
    const address = await PartyAddress.findOne({ where });
    if (!address) throw new NotFoundError('Address not found');
    return address;
  }

  /**
   * Derives the GST state code from the state name when the caller didn't
   * supply one. Tax determination compares codes, so an address saved with a
   * name but no code would silently fall back to the customer's own state.
   */
  static withDerivedStateCode(data) {
    if (data.stateCode || !data.state) return data;
    const derived = stateCodeFor(data.state);
    return derived ? { ...data, stateCode: derived } : data;
  }

  static async create(partyId, data) {
    const party = await Party.findByPk(partyId);
    if (!party) throw new NotFoundError('Party not found');

    return sequelize.transaction(async (transaction) => {
      const payload = this.withDerivedStateCode({ ...data, partyId });

      const existingCount = await PartyAddress.count({ where: { partyId }, transaction });
      // The first address becomes the default for whichever kinds it serves —
      // otherwise a party could have addresses but no default, and invoicing
      // would have nothing to pick.
      if (existingCount === 0) {
        payload.isDefaultBilling = payload.isBilling !== false;
        payload.isDefaultShipping = payload.isShipping !== false;
      }

      const address = await PartyAddress.create(payload, { transaction });
      await this.enforceSingleDefault(address, transaction);
      return address;
    });
  }

  static async update(id, data, partyId) {
    return sequelize.transaction(async (transaction) => {
      const address = await PartyAddress.findOne({ where: partyId ? { id, partyId } : { id }, transaction });
      if (!address) throw new NotFoundError('Address not found');
      await address.update(this.withDerivedStateCode(data), { transaction });
      await this.enforceSingleDefault(address, transaction);
      return address;
    });
  }

  /** Only one default of each kind per party. */
  static async enforceSingleDefault(address, transaction) {
    if (address.isDefaultBilling) {
      await PartyAddress.update(
        { isDefaultBilling: false },
        { where: { partyId: address.partyId, id: { [Op.ne]: address.id } }, transaction }
      );
    }
    if (address.isDefaultShipping) {
      await PartyAddress.update(
        { isDefaultShipping: false },
        { where: { partyId: address.partyId, id: { [Op.ne]: address.id } }, transaction }
      );
    }
  }

  static async remove(id, partyId) {
    const address = await this.get(id, partyId);
    if (address.isDefaultBilling || address.isDefaultShipping) {
      const siblings = await PartyAddress.count({ where: { partyId: address.partyId, id: { [Op.ne]: id } } });
      if (siblings > 0) {
        throw new ValidationError('Set another address as the default before deleting this one');
      }
    }
    await address.destroy();
  }

  /** Resolves the address invoicing should use for a party. */
  static async resolveDefault(partyId, kind = 'shipping', transaction) {
    const column = kind === 'billing' ? 'isBilling' : 'isShipping';
    const defaultColumn = kind === 'billing' ? 'isDefaultBilling' : 'isDefaultShipping';
    return PartyAddress.findOne({
      where: { partyId, [column]: true, status: 'active' },
      order: [[defaultColumn, 'DESC'], ['createdAt', 'ASC']],
      transaction,
    });
  }
}

module.exports = { PartyAddressService };
