const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BundleRule } = require('./bundleRule.model');
const { BundleComponent } = require('./bundleComponent.model');
const { OverrideReasonCode } = require('./overrideReasonCode.model');
const { Product } = require('../products/product.model');
const { Uom } = require('../products/uom.model');
const { assertUsableProducts } = require('../../core/masterGuards');
const { NotFoundError, ValidationError, ConflictError } = require('../../core/AppError');
const { toOrder } = require('../../utils/pagination');

const SORTABLE = ['code', 'name', 'version', 'status', 'effectiveFrom', 'createdAt'];

/**
 * Bundle rule master — the draft/publish lifecycle. See spec §8, Phase 4.
 *
 * The reason this is a lifecycle rather than a plain edit screen: a rule is
 * quoted to customers. Editing an ACTIVE one in place would silently change
 * what every open order means, which is the single behaviour salespeople find
 * hardest to trust. So an ACTIVE rule is immutable, and a change is a new
 * version that supersedes it from a date — leaving every order already raised
 * pointing at exactly the rule it was sold under.
 */
class BundleRulesService {
  static async list(page = 1, limit = 20, { parentProductId, status, search, sortBy, sortDir } = {}) {
    const where = {};
    if (parentProductId) where.parentProductId = parentProductId;
    if (status) where.status = status;
    if (search) {
      where[Op.or] = [{ code: { [Op.iLike]: `%${search}%` } }, { name: { [Op.iLike]: `%${search}%` } }];
    }

    return BundleRule.findAndCountAll({
      where,
      include: [
        {
          model: BundleComponent, as: 'components',
          // The unit and the item's name so the editor can render a component
          // without a second round trip per row.
          include: [
            { model: Uom, as: 'uom', attributes: ['id', 'name', 'code'] },
            { model: Product, as: 'componentProduct', attributes: ['id', 'name', 'code'] },
          ],
        },
        { model: Product, as: 'parentProduct', attributes: ['id', 'name', 'code'] },
      ],
      order: toOrder(sortBy, sortDir, SORTABLE, [['code', 'ASC'], ['version', 'DESC']]),
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });
  }

  static async get(id) {
    const rule = await BundleRule.findByPk(id, {
      include: [
        {
          model: BundleComponent, as: 'components',
          // The unit and the item's name so the editor can render a component
          // without a second round trip per row.
          include: [
            { model: Uom, as: 'uom', attributes: ['id', 'name', 'code'] },
            { model: Product, as: 'componentProduct', attributes: ['id', 'name', 'code'] },
          ],
        },
        { model: Product, as: 'parentProduct', attributes: ['id', 'name', 'code'] },
      ],
    });
    if (!rule) throw new NotFoundError('Bundle rule not found');
    return rule;
  }

  static async _assertComponents(parentProductId, components) {
    if (!components?.length) throw new ValidationError('A bundle needs at least one component');

    const productIds = components.map((c) => c.componentProductId);

    const duplicate = productIds.find((id, i) => productIds.indexOf(id) !== i);
    if (duplicate) throw new ValidationError('The same item appears twice in this bundle — combine them into one line');

    // A bundle that contains itself expands forever.
    if (productIds.includes(parentProductId)) {
      throw new ValidationError('A product cannot be an accessory of itself');
    }

    await assertUsableProducts(Product, [parentProductId, ...productIds]);

    // The unit has to be the product's own. Expansion writes a component's
    // quantity straight onto an order line and converts nothing, so a bundle
    // saying "2 MTR of cable" for a product stocked in NOS would put 2 of the
    // wrong thing on the order — silently, with no error anywhere.
    const products = await Product.findAll({
      where: { id: { [Op.in]: productIds } },
      attributes: ['id', 'name', 'uomId'],
    });
    const uomByProduct = new Map(products.map((p) => [p.id, p]));

    for (const component of components) {
      const product = uomByProduct.get(component.componentProductId);
      if (!product) continue;   // assertUsableProducts already covers this
      if (component.uomId && component.uomId !== product.uomId) {
        throw new ValidationError(
          `"${product.name}" is measured in its own unit — a bundle cannot restate it in another one.`
        );
      }
    }
  }

  /** New rules always start as drafts; publishing is a separate, deliberate act. */
  static async create({ code, name, parentProductId, components, effectiveFrom, priority, bundleType, taxTreatment }) {
    return sequelize.transaction(async (transaction) => {
      await this._assertComponents(parentProductId, components);

      const existing = await BundleRule.findOne({
        where: { code },
        order: [['version', 'DESC']],
        transaction,
      });
      // The code is the bundle's identity across every version, so it is never
      // reused for a different bundle — not even after the old one is archived.
      // The message names the state, because "publish a new version" reads as
      // impossible advice when the rule you are being pointed at is archived.
      if (existing) {
        throw new ConflictError(
          `Bundle code "${code}" already belongs to "${existing.name}" (${existing.status.toLowerCase()}). ` +
            'Open that bundle and choose "New version" to change it, or pick a different code.'
        );
      }

      const rule = await BundleRule.create(
        {
          code, name, parentProductId, effectiveFrom,
          priority: priority ?? 100,
          bundleType: bundleType || 'EXPLODED',
          taxTreatment: taxTreatment || 'INDEPENDENT',
          version: 1,
          status: 'DRAFT',
        },
        { transaction }
      );

      await this._replaceComponents(rule.id, components, transaction);
      return this.get(rule.id);
    });
  }

  static async _replaceComponents(bundleRuleId, components, transaction) {
    // The unit is always the product's own — _assertComponents refuses anything
    // else — so it is resolved here rather than trusted from the caller.
    const products = await Product.findAll({
      where: { id: { [Op.in]: components.map((c) => c.componentProductId) } },
      attributes: ['id', 'uomId'],
      transaction,
    });
    const uomByProduct = new Map(products.map((p) => [p.id, p.uomId]));

    await BundleComponent.destroy({ where: { bundleRuleId }, transaction });
    await BundleComponent.bulkCreate(
      components.map((c, index) => ({
        bundleRuleId,
        componentProductId: c.componentProductId,
        quantity: c.quantity,
        scalingMode: c.scalingMode || 'PROPORTIONAL',
        // Falls back to the product's own unit when the caller omits it, which
        // is the only value it is allowed to take (see _assertComponents).
        uomId: uomByProduct.get(c.componentProductId) || c.uomId,
        isMandatory: c.isMandatory ?? false,
        defaultSelected: c.defaultSelected ?? true,
        sequence: c.sequence ?? index + 1,
      })),
      { transaction, individualHooks: true, validate: true }
    );
  }

  /** Only a draft can be edited. An ACTIVE rule is what orders were quoted from. */
  static async update(id, { components, ...data }) {
    return sequelize.transaction(async (transaction) => {
      const rule = await BundleRule.findByPk(id, { transaction });
      if (!rule) throw new NotFoundError('Bundle rule not found');
      if (rule.status !== 'DRAFT') {
        throw new ValidationError(
          `This bundle is ${rule.status} and orders have been quoted from it. Create a new version instead of editing it.`
        );
      }

      if (components) {
        await this._assertComponents(data.parentProductId || rule.parentProductId, components);
        await this._replaceComponents(rule.id, components, transaction);
      }

      // The code identifies the bundle across its versions, so it is not editable.
      delete data.code;
      delete data.version;
      delete data.status;

      await rule.update(data, { transaction });
      return this.get(rule.id);
    });
  }

  /**
   * Makes a draft live, and closes the version it replaces.
   *
   * The outgoing version is given an `effectiveTo` of the day before rather
   * than being deleted: reports and any order still referencing it must be able
   * to resolve what it said.
   */
  static async publish(id, { effectiveFrom, publishedBy } = {}) {
    return sequelize.transaction(async (transaction) => {
      const rule = await BundleRule.findByPk(id, {
        include: [{ model: BundleComponent, as: 'components' }],
        transaction,
      });
      if (!rule) throw new NotFoundError('Bundle rule not found');
      if (rule.status !== 'DRAFT') throw new ValidationError('Only a draft bundle can be published');
      if (!rule.components?.length) throw new ValidationError('A bundle needs at least one component before it can be published');

      const startsOn = effectiveFrom || rule.effectiveFrom;

      // Superseding follows the version lineage — the `code` — not the product.
      // A product can carry more than one bundle at once (a starter kit and a
      // seasonal promotion, say), and `priority` decides between them at
      // expansion time. Closing every rule on the product would silently
      // retire bundles nobody asked to change.
      const current = await BundleRule.findOne({
        where: { code: rule.code, status: 'ACTIVE', id: { [Op.ne]: rule.id } },
        order: [['version', 'DESC']],
        transaction,
      });

      if (current) {
        if (startsOn <= current.effectiveFrom) {
          throw new ValidationError(
            `Version ${current.version} of this bundle starts on ${current.effectiveFrom}. A replacement has to start after that.`
          );
        }
        await current.update(
          { status: 'SUPERSEDED', effectiveTo: this._dayBefore(startsOn) },
          { transaction }
        );
      }

      await rule.update(
        {
          status: 'ACTIVE',
          effectiveFrom: startsOn,
          version: current ? Number(current.version) + 1 : rule.version,
          publishedBy: publishedBy || null,
          publishedAt: new Date(),
        },
        { transaction }
      );

      return this.get(rule.id);
    });
  }

  static _dayBefore(date) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Starts a new draft from an existing rule.
   *
   * This is the supported way to change a live bundle: copy, edit the copy,
   * publish it from a date. The copy keeps the code so the two are recognisably
   * the same bundle at different versions.
   */
  static async newVersion(id) {
    return sequelize.transaction(async (transaction) => {
      const source = await this.get(id);

      const pending = await BundleRule.findOne({
        where: { code: source.code, status: 'DRAFT' },
        transaction,
      });
      if (pending) throw new ConflictError('There is already an unpublished draft of this bundle');

      const latest = await BundleRule.findOne({
        where: { code: source.code },
        order: [['version', 'DESC']],
        transaction,
      });

      const draft = await BundleRule.create(
        {
          code: source.code,
          name: source.name,
          parentProductId: source.parentProductId,
          bundleType: source.bundleType,
          taxTreatment: source.taxTreatment,
          priority: source.priority,
          effectiveFrom: source.effectiveFrom,
          version: Number(latest.version) + 1,
          status: 'DRAFT',
        },
        { transaction }
      );

      await this._replaceComponents(draft.id, source.components, transaction);
      return this.get(draft.id);
    });
  }

  /** Takes a rule out of use without deleting what it said. */
  static async archive(id) {
    const rule = await BundleRule.findByPk(id);
    if (!rule) throw new NotFoundError('Bundle rule not found');
    if (rule.status === 'ARCHIVED') return this.get(id);

    await rule.update({ status: 'ARCHIVED', effectiveTo: rule.effectiveTo || new Date().toISOString().slice(0, 10) });
    return this.get(id);
  }
}

/**
 * The controlled list of reasons an accessory was taken off an order.
 *
 * Deliberately a master rather than a free-text box: "not needed" typed ten
 * thousand times answers nothing, while "customer already has one" and "too
 * expensive" call for completely different responses from the business.
 */
class OverrideReasonCodesService {
  static async list({ includeInactive = false } = {}) {
    return OverrideReasonCode.findAll({
      where: includeInactive ? {} : { isActive: true },
      order: [['label', 'ASC']],
    });
  }

  static async create({ code, label, requiresNote }) {
    const normalised = String(code).trim().toUpperCase();
    if (await OverrideReasonCode.findOne({ where: { code: normalised } })) {
      throw new ConflictError(`A reason with code "${normalised}" already exists`);
    }
    return OverrideReasonCode.create({ code: normalised, label, requiresNote: requiresNote ?? false });
  }

  static async update(code, data) {
    const reason = await OverrideReasonCode.findOne({ where: { code } });
    if (!reason) throw new NotFoundError('Reason code not found');

    delete data.code;
    await reason.update(data);
    return reason;
  }

  /**
   * Deactivates rather than deletes. Suppression rows point at the code, and
   * past orders have to keep explaining themselves.
   */
  static async deactivate(code) {
    const reason = await OverrideReasonCode.findOne({ where: { code } });
    if (!reason) throw new NotFoundError('Reason code not found');
    await reason.update({ isActive: false });
    return reason;
  }
}

module.exports = { BundleRulesService, OverrideReasonCodesService };
