const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { MixDesign } = require('./mixDesign.model');
const { MixDesignLine } = require('./mixDesignLine.model');
const { Product } = require('./product.model');
const { Uom } = require('./uom.model');
const { UomService } = require('./uom.service');
const { toOrder } = require('../../utils/pagination');
const { NotFoundError, ValidationError } = require('../../core/AppError');

const SORTABLE = ['name', 'version', 'status', 'effectiveFrom', 'createdAt'];

const withLines = {
  include: [
    {
      model: MixDesignLine, as: 'lines',
      include: [
        // The material's own unit is nested because explode() converts into it
        // and callers need to label the result with it.
        { model: Product, as: 'rawMaterial', include: [{ model: Uom, as: 'uom' }] },
        { model: Uom, as: 'uom' },
      ],
    },
    { model: Product, as: 'product' },
  ],
};

/**
 * M03 — Bill of Materials (mix design) versioning.
 *
 * The rule that shapes this whole service is FR-M03-8/FR-M03-9 (AC-2.1):
 * which version applies is decided by the **production date**, and no version
 * is ever deleted. A production entry made in April must keep explaining
 * itself with April's recipe even after May's recipe is activated.
 */
class BomService {
  static async get(id, transaction) {
    const bom = await MixDesign.findByPk(id, { ...withLines, transaction });
    if (!bom) throw new NotFoundError('Mix design not found');
    return bom;
  }

  static async list(page, limit, { productId, status, search, sortBy, sortDir } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (productId) where.productId = productId;
    if (status) where.status = status;
    if (search) where.name = { [Op.iLike]: `%${search}%` };

    return MixDesign.findAndCountAll({
      where,
      limit,
      offset,
      ...withLines,
      order: toOrder(sortBy, sortDir, SORTABLE, [['productId', 'ASC'], ['version', 'DESC']]),
    });
  }

  /**
   * FR-M03-4: a BOM may not consume, directly or through any depth of
   * sub-assembly, the product it produces.
   *
   * Without this a recipe can name its own output as an input. Nothing stops
   * it being saved, and the damage lands later and far away: `explode()`
   * recurses forever on a nested BOM, the cost rollup never terminates, and a
   * production entry against the recipe books a consumption of the very good
   * it is creating — so the stock ledger nets to nonsense and the variance
   * report blames the operator.
   *
   * The walk is breadth-first over the *active* recipe of each component,
   * which is the version production will actually resolve. `visited` bounds it
   * even if a cycle already exists in data written before this check.
   *
   * @param {string} outputProductId - the product this BOM produces
   * @param {string[]} componentIds   - the product ids on its lines
   */
  static async assertNoCycle(outputProductId, componentIds, transaction) {
    if (componentIds.includes(outputProductId)) {
      throw new ValidationError('A bill of materials cannot list the product it produces as one of its own components');
    }

    const visited = new Set([outputProductId]);
    let frontier = [...new Set(componentIds)];

    while (frontier.length) {
      const unseen = frontier.filter((id) => !visited.has(id));
      if (!unseen.length) break;
      unseen.forEach((id) => visited.add(id));

      const subAssemblies = await MixDesign.findAll({
        where: { productId: { [Op.in]: unseen }, status: { [Op.in]: ['ACTIVE', 'SUPERSEDED'] } },
        include: [{ model: MixDesignLine, as: 'lines', attributes: ['rawMaterialProductId'] }],
        transaction,
      });

      const next = [];
      for (const bom of subAssemblies) {
        for (const line of bom.lines) {
          if (line.rawMaterialProductId === outputProductId) {
            const culprit = await Product.findByPk(bom.productId, { attributes: ['name'], transaction });
            throw new ValidationError(
              `That would create a circular bill of materials — "${culprit ? culprit.name : 'a component'}" already depends on this product`
            );
          }
          next.push(line.rawMaterialProductId);
        }
      }
      frontier = next;
    }
  }

  /**
   * Validates the component lines themselves: every raw material must resolve
   * inside this tenant (the tenant-scoped find is what makes a foreign id from
   * another tenant fail), each may appear only once, and each must be active.
   */
  static async assertLinesValid(productId, lines, transaction) {
    const ids = lines.map((l) => l.rawMaterialProductId);

    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) {
      const product = await Product.findByPk(duplicate, { attributes: ['name'], transaction });
      throw new ValidationError(
        `"${product ? product.name : 'A component'}" appears more than once — combine the lines into a single quantity`
      );
    }

    const products = await Product.findAll({ where: { id: { [Op.in]: [...new Set(ids)] } }, transaction });
    if (products.length !== new Set(ids).size) {
      throw new ValidationError('One or more component lines reference a product that does not exist');
    }
    const inactive = products.filter((p) => p.status !== 'active');
    if (inactive.length) {
      throw new ValidationError(`${inactive.map((p) => `"${p.name}"`).join(', ')} is inactive and cannot be added to a bill of materials`);
    }

    const uomIds = [...new Set(lines.map((l) => l.uomId).filter(Boolean))];
    if (uomIds.length && (await Uom.count({ where: { id: { [Op.in]: uomIds } } })) !== uomIds.length) {
      throw new ValidationError('One or more component lines reference a unit of measure that does not exist');
    }

    await this.assertNoCycle(productId, ids, transaction);
  }

  /**
   * FR-M03-8 / AC-2.1: resolves the version in force on a given date.
   *
   * Picks the newest ACTIVE-or-SUPERSEDED version whose effectiveFrom is on or
   * before `onDate`. SUPERSEDED versions stay eligible on purpose — that is
   * exactly what makes a backdated entry reproduce the historical recipe
   * instead of silently adopting today's.
   */
  static async resolveForDate(productId, onDate, transaction) {
    const date = onDate || new Date().toISOString().slice(0, 10);

    const candidates = await MixDesign.findAll({
      where: {
        productId,
        // `isActive` is accepted alongside `status` so rows created before the
        // status lifecycle existed (and any caller that still sets only the
        // boolean) keep resolving. The two are kept in lock-step on write.
        [Op.and]: [
          { [Op.or]: [{ status: { [Op.in]: ['ACTIVE', 'SUPERSEDED'] } }, { isActive: true }] },
          { [Op.or]: [{ effectiveFrom: { [Op.lte]: date } }, { effectiveFrom: null }] },
        ],
      },
      // The material and its unit come with the line. Without them the
      // production entry screen renders a row per material with no name on it —
      // an operator is asked to confirm a quantity of something unnamed.
      include: [
        {
          model: MixDesignLine, as: 'lines',
          include: [
            { model: Product, as: 'rawMaterial', attributes: ['id', 'name', 'code'] },
            { model: Uom, as: 'uom', attributes: ['id', 'name', 'code'] },
          ],
        },
      ],
      order: [
        // NULLS LAST so a dated version always beats an undated legacy one.
        [sequelize.literal('"MixDesign"."effectiveFrom" DESC NULLS LAST')],
        ['version', 'DESC'],
      ],
      transaction,
    });

    if (!candidates.length) {
      throw new ValidationError('No mix design is effective for this product on that date — activate one first');
    }
    return candidates[0];
  }

  /**
   * Creates a new version. It starts as a DRAFT (FR-M03-6) so an in-progress
   * recipe can never affect production mid-edit.
   *
   * `activate: true` creates and activates in one step — the common case when
   * defining a product's first BOM, where there is nothing to supersede and
   * leaving it as a draft would just mean the product can't be produced.
   */
  static async create({ productId, name, lines, effectiveFrom, outputQuantity = 1, bomType = 'MANUFACTURING', activate = false, laborCostPaise = 0, overheadCostPaise = 0 }) {
    if (!lines?.length) throw new ValidationError('A mix design requires at least one component line');

    const created = await this.createDraft({ productId, name, lines, effectiveFrom, outputQuantity, bomType, laborCostPaise, overheadCostPaise });
    return activate ? this.activate(created.id, { effectiveFrom }) : created;
  }

  static async createDraft({ productId, name, lines, effectiveFrom, outputQuantity = 1, bomType = 'MANUFACTURING', laborCostPaise = 0, overheadCostPaise = 0 }) {
    return sequelize.transaction(async (transaction) => {
      if (!(await Product.count({ where: { id: productId }, transaction }))) {
        throw new ValidationError('The product this bill of materials is for does not exist');
      }
      await this.assertLinesValid(productId, lines, transaction);

      const latest = await MixDesign.findOne({
        where: { productId },
        order: [['version', 'DESC']],
        transaction,
      });
      const version = latest ? Number(latest.version) + 1 : 1;

      const bom = await MixDesign.create(
        {
          productId,
          name,
          version,
          effectiveFrom: effectiveFrom || new Date().toISOString().slice(0, 10),
          outputQuantity,
          bomType,
          status: 'DRAFT',
          isActive: false,
          laborCostPaise: Number(laborCostPaise) || 0,
          overheadCostPaise: Number(overheadCostPaise) || 0,
        },
        { transaction }
      );

      await MixDesignLine.bulkCreate(
        lines.map((line) => ({
          mixDesignId: bom.id,
          rawMaterialProductId: line.rawMaterialProductId,
          quantityPerUnit: line.quantityPerUnit,
          uomId: line.uomId,
          wastagePercent: line.wastagePercent || 0,
          isOptional: !!line.isOptional,
        })),
        { transaction, individualHooks: true, validate: true }
      );

      return this.get(bom.id);
    });
  }

  /** Only a DRAFT may be edited — an ACTIVE or SUPERSEDED version is history. */
  static async update(id, { lines, ...data }) {
    return sequelize.transaction(async (transaction) => {
      const bom = await MixDesign.findByPk(id, { transaction });
      if (!bom) throw new NotFoundError('Mix design not found');
      if (bom.status !== 'DRAFT') {
        throw new ValidationError(
          `Only a DRAFT mix design can be edited (this one is ${bom.status}). Create a new version instead — production history must stay explainable.`
        );
      }

      await bom.update(data, { transaction });

      if (lines) {
        if (!lines.length) throw new ValidationError('A mix design requires at least one component line');
        await this.assertLinesValid(bom.productId, lines, transaction);
        await MixDesignLine.destroy({ where: { mixDesignId: id }, transaction });
        await MixDesignLine.bulkCreate(
          lines.map((line) => ({
            mixDesignId: id,
            rawMaterialProductId: line.rawMaterialProductId,
            quantityPerUnit: line.quantityPerUnit,
            uomId: line.uomId,
            wastagePercent: line.wastagePercent || 0,
            isOptional: !!line.isOptional,
          })),
          { transaction, individualHooks: true, validate: true }
        );
      }

      return this.get(id);
    });
  }

  /**
   * FR-M03-8: activating a version supersedes the current one. The outgoing
   * version is marked SUPERSEDED and linked to its replacement — never deleted,
   * so historical entries still resolve.
   */
  static async activate(id, { effectiveFrom } = {}) {
    return sequelize.transaction(async (transaction) => {
      const bom = await MixDesign.findByPk(id, { transaction });
      if (!bom) throw new NotFoundError('Mix design not found');
      if (bom.status === 'ACTIVE') return this.get(id);
      if (bom.status === 'SUPERSEDED') {
        throw new ValidationError('A superseded mix design cannot be reactivated — create a new version from it instead');
      }

      const lines = await MixDesignLine.findAll({ where: { mixDesignId: id }, attributes: ['rawMaterialProductId'], transaction });
      if (!lines.length) throw new ValidationError('A mix design with no component lines cannot be activated');
      // Re-checked here, not just on write: another product's BOM may have
      // been activated since this draft was saved, closing a loop that did not
      // exist at the time. Activation is the moment production starts using it.
      await this.assertNoCycle(bom.productId, lines.map((l) => l.rawMaterialProductId), transaction);

      const current = await MixDesign.findOne({ where: { productId: bom.productId, status: 'ACTIVE' }, transaction });
      if (current) {
        await current.update(
          { status: 'SUPERSEDED', isActive: false, supersededAt: new Date(), supersededByMixDesignId: bom.id },
          { transaction }
        );
      }

      await bom.update(
        {
          status: 'ACTIVE',
          isActive: true,
          effectiveFrom: effectiveFrom || bom.effectiveFrom || new Date().toISOString().slice(0, 10),
        },
        { transaction }
      );

      return this.get(id);
    });
  }

  /**
   * FR-M03-9: versions are never deleted. A DRAFT that was never activated has
   * no history to protect, so that one case is allowed; anything else is
   * refused rather than silently orphaning production entries.
   */
  static async remove(id) {
    const bom = await MixDesign.findByPk(id);
    if (!bom) throw new NotFoundError('Mix design not found');
    if (bom.status !== 'DRAFT') {
      throw new ValidationError(
        'Mix design versions are never deleted — production history must remain explainable. Only an unused DRAFT can be discarded.'
      );
    }
    await MixDesignLine.destroy({ where: { mixDesignId: id } });
    await bom.destroy();
  }

  /** Creates a new DRAFT that starts as a copy of an existing version. */
  static async cloneAsDraft(id, { name } = {}) {
    const source = await this.get(id);
    return this.create({
      productId: source.productId,
      name: name || `${source.name} (copy)`,
      effectiveFrom: source.effectiveFrom || new Date().toISOString().slice(0, 10),
      outputQuantity: source.outputQuantity,
      bomType: source.bomType,
      laborCostPaise: source.laborCostPaise != null ? Number(source.laborCostPaise) : 0,
      overheadCostPaise: source.overheadCostPaise != null ? Number(source.overheadCostPaise) : 0,
      lines: source.lines.map((l) => ({
        rawMaterialProductId: l.rawMaterialProductId,
        quantityPerUnit: l.quantityPerUnit,
        uomId: l.uomId,
        wastagePercent: l.wastagePercent,
        isOptional: l.isOptional,
      })),
    });
  }

  /**
   * Explodes a BOM into the material actually required for `outputQty`,
   * including each line's wastage allowance (FR-M08-5, FR-M10-1).
   *
   * Quantities are converted into the raw material's own stocking unit when
   * the BOM line is expressed in a different one — a line written as "2 Bags of
   * cement" must consume 100 Kg if cement is stocked in Kg.
   */
  static async explode(mixDesignId, outputQty, transaction) {
    const bom = await this.get(mixDesignId, transaction);
    const perOutput = Number(outputQty) / Number(bom.outputQuantity || 1);

    const requirements = [];
    for (const line of bom.lines) {
      const base = Number(line.quantityPerUnit) * perOutput;
      const withWastage = base * (1 + Number(line.wastagePercent || 0) / 100);

      const stockUomId = line.rawMaterial?.uomId;
      let quantity = withWastage;
      let converted = false;
      if (stockUomId && line.uomId && stockUomId !== line.uomId) {
        try {
          quantity = await UomService.convert(withWastage, line.uomId, stockUomId);
          converted = true;
        } catch (error) {
          // Name the material and both units. Unqualified, this surfaces on the
          // casting screen as "No conversion is defined between that unit and
          // that unit" — true, but it does not say which of a dozen materials
          // is at fault or what to go and add.
          throw new ValidationError(
            `${line.rawMaterial?.name || 'A material'} is measured in ${line.rawMaterial?.uom?.code || 'its own unit'} ` +
              `but this recipe asks for ${line.uom?.code || 'another unit'}, and no conversion between them exists. ` +
              `Add one under Masters → Products → UoM Conversions, or write the recipe line in ${line.rawMaterial?.uom?.code || 'the stocking unit'}.`
          );
        }
      }

      requirements.push({
        rawMaterialProductId: line.rawMaterialProductId,
        rawMaterialName: line.rawMaterial?.name,
        bomQuantity: Number(base.toFixed(4)),
        wastagePercent: Number(line.wastagePercent || 0),
        quantity: Number(quantity.toFixed(4)),
        uomId: stockUomId || line.uomId,
        // The code as well as the id. `quantity` is in the material's stocking
        // unit, so a caller showing it beside the BOM's unit would label 7.75
        // CUM as "KG" — which is how the screen misled in the first place.
        uomCode: converted ? line.rawMaterial?.uom?.code || null : line.uom?.code || null,
        bomUomCode: line.uom?.code || null,
        convertedFromUomId: converted ? line.uomId : null,
        isOptional: !!line.isOptional,
      });
    }
    return { mixDesignId: bom.id, version: bom.version, outputQty: Number(outputQty), requirements };
  }

  /** FR-M03-10: material cost per output unit at current standard costs. */
  static async costRollup(mixDesignId) {
    const { requirements } = await this.explode(mixDesignId, 1);
    const products = await Product.findAll({
      where: { id: { [Op.in]: requirements.map((r) => r.rawMaterialProductId) } },
      attributes: ['id', 'name', 'standardCostPaise'],
    });
    const costById = new Map(products.map((p) => [p.id, Number(p.standardCostPaise || 0)]));

    const lines = requirements.map((r) => ({
      ...r,
      unitCostPaise: costById.get(r.rawMaterialProductId) || 0,
      lineCostPaise: Math.round(r.quantity * (costById.get(r.rawMaterialProductId) || 0)),
    }));

    return { mixDesignId, lines, totalCostPaise: lines.reduce((sum, l) => sum + l.lineCostPaise, 0) };
  }
}

module.exports = { BomService };
