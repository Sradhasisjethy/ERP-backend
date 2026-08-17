const { Op } = require('sequelize');
const { UomConversion } = require('./uomConversion.model');
const { Uom } = require('./uom.model');
const { searchWhere } = require('../../utils/pagination');
const { NotFoundError, ValidationError } = require('../../core/AppError');

class UomService {
  static async list(page, limit, { search, status } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (status) where.status = status;
    return UomConversion.findAndCountAll({
      where,
      limit,
      offset,
      include: [
        { model: Uom, as: 'fromUom', ...(search ? { where: searchWhere(search, ['name', 'code']), required: true } : {}) },
        { model: Uom, as: 'toUom' },
      ],
      order: [['createdAt', 'DESC']],
    });
  }

  static async create({ fromUomId, toUomId, factor }) {
    if (fromUomId === toUomId) throw new ValidationError('A unit cannot be converted to itself');
    if (Number(factor) <= 0) throw new ValidationError('Conversion factor must be greater than zero');

    // Reject a pair that already exists in either direction — two independent
    // definitions of the same relationship will drift apart the moment one is
    // edited, and callers can't tell which one is authoritative.
    const existing = await UomConversion.findOne({
      where: {
        [Op.or]: [
          { fromUomId, toUomId },
          { fromUomId: toUomId, toUomId: fromUomId },
        ],
      },
    });
    if (existing) {
      throw new ValidationError('A conversion between these two units already exists (it applies in both directions)');
    }

    return UomConversion.create({ fromUomId, toUomId, factor });
  }

  static async update(id, data) {
    const conversion = await UomConversion.findByPk(id);
    if (!conversion) throw new NotFoundError('UoM conversion not found');
    if (data.factor !== undefined && Number(data.factor) <= 0) {
      throw new ValidationError('Conversion factor must be greater than zero');
    }
    return conversion.update(data);
  }

  static async remove(id) {
    const conversion = await UomConversion.findByPk(id);
    if (!conversion) throw new NotFoundError('UoM conversion not found');
    await conversion.destroy();
  }

  /**
   * Converts a quantity between units.
   *
   * Resolution order:
   *   1. same unit            -> identity
   *   2. a direct conversion  -> multiply by factor
   *   3. the inverse pair     -> divide by factor
   *   4. one hop via a shared intermediate unit (Bag -> Kg -> Tonne)
   *
   * Deliberately stops at one hop. An unbounded graph search would silently
   * find long, lossy chains and make the result hard to explain to a user
   * looking at a BOM; if a two-hop conversion is genuinely needed, defining the
   * direct pair is clearer than having the system guess a route.
   */
  static async convert(quantity, fromUomId, toUomId) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty)) throw new ValidationError('Quantity must be a number');
    if (fromUomId === toUomId) return qty;

    const direct = await UomConversion.findOne({ where: { fromUomId, toUomId, status: 'active' } });
    if (direct) return qty * Number(direct.factor);

    const inverse = await UomConversion.findOne({ where: { fromUomId: toUomId, toUomId: fromUomId, status: 'active' } });
    if (inverse) return qty / Number(inverse.factor);

    const fromLinks = await UomConversion.findAll({
      where: { status: 'active', [Op.or]: [{ fromUomId }, { toUomId: fromUomId }] },
    });
    for (const link of fromLinks) {
      const midId = link.fromUomId === fromUomId ? link.toUomId : link.fromUomId;
      const toMid = link.fromUomId === fromUomId ? Number(link.factor) : 1 / Number(link.factor);

      const second = await UomConversion.findOne({
        where: {
          status: 'active',
          [Op.or]: [
            { fromUomId: midId, toUomId },
            { fromUomId: toUomId, toUomId: midId },
          ],
        },
      });
      if (!second) continue;
      const midToTarget = second.fromUomId === midId ? Number(second.factor) : 1 / Number(second.factor);
      return qty * toMid * midToTarget;
    }

    const [from, to] = await Promise.all([Uom.findByPk(fromUomId), Uom.findByPk(toUomId)]);
    throw new ValidationError(
      `No conversion is defined between ${from?.code || 'that unit'} and ${to?.code || 'that unit'}`
    );
  }
}

module.exports = { UomService };
