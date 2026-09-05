const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { SalesOrder } = require('../sales/salesOrder.model');
const { SalesOrderLine } = require('../sales/salesOrderLine.model');
const { Product } = require('../products/product.model');
const { BundleRule } = require('./bundleRule.model');
const { BundleComponent } = require('./bundleComponent.model');
const { BundleComponentSuppression } = require('./bundleComponentSuppression.model');
const { BundleOverrideAudit } = require('./bundleOverrideAudit.model');
const { OverrideReasonCode } = require('./overrideReasonCode.model');
const { BundleExpansionService } = require('./bundleExpansion.service');
const { ReservationService } = require('../inventory/reservation.service');
const { PricingService } = require('../pricing/pricing.service');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../core/AppError');
const { addPaise } = require('../../utils/money');

/**
 * Applies bundle expansion to a sales order. See docs/specs/bundle-kitting.md §4/§5.
 *
 * The division of labour matters and is easy to erode:
 *
 *   BundleExpansionService  decides what the document *should* look like. Pure.
 *   BundleDocumentService   makes the document look like that. Writes.
 *
 * Every operation here — change a quantity, remove an accessory, put one back,
 * add an optional extra — does the same two things: adjust the one fact the
 * user changed, then re-run expansion over the result. There is deliberately no
 * per-action expansion logic, because that is how the add path and the edit
 * path drift apart and start producing different documents from the same
 * inputs (§4).
 */

/** Money on a line, to the paisa. Quantities are decimal, money never is. */
const lineTotal = (line) => Math.round(Number(line.orderedQty) * Number(line.ratePaise));

class BundleDocumentService {
  /**
   * Runs `fn` in the caller's transaction when there is one, and opens its own
   * otherwise.
   *
   * Nesting matters here: `sequelize.transaction()` called inside another
   * transaction in this codebase does NOT create a savepoint — it opens a
   * second, independent transaction on a second connection, which cannot see
   * the first one's uncommitted rows. Expansion called from order creation was
   * therefore looking for a parent line that had been inserted but not yet
   * committed, and failing with "that order line no longer exists". Reusing the
   * caller's transaction is also what keeps a five-connection pool from
   * deadlocking against itself.
   */
  static _run(transaction, fn) {
    return transaction ? fn(transaction) : sequelize.transaction(fn);
  }

  // ---- reads -------------------------------------------------------------

  static async _loadParent(parentLineId) {
    const parent = await SalesOrderLine.findByPk(parentLineId);
    if (!parent) throw new NotFoundError('That order line no longer exists');

    const order = await SalesOrder.findByPk(parent.salesOrderId);
    if (!order) throw new NotFoundError('That sales order no longer exists');

    return { parent, order };
  }

  /**
   * Bundles are edited while the order is still being negotiated. Once it is
   * CONFIRMED it holds stock reservations and may have dispatches against it,
   * so silently re-expanding it would invalidate both — the same reasoning that
   * restricts line edits to DRAFT in sales.service.js.
   */
  static _assertEditable(order) {
    if (order.status !== 'DRAFT') {
      throw new ValidationError(
        `This order is ${order.status} and its lines can no longer be changed. Cancel or short-close it instead.`
      );
    }
  }

  static async _componentLines(parentLineId) {
    return SalesOrderLine.findAll({ where: { parentLineId }, order: [['createdAt', 'ASC']] });
  }

  static async _suppressedProductIds(parentLineId) {
    const rows = await BundleComponentSuppression.findAll({
      where: { parentLineId },
      attributes: ['componentProductId'],
    });
    return rows.map((r) => r.componentProductId);
  }

  // ---- the one write path ------------------------------------------------

  /**
   * Re-runs expansion for a parent line and makes the document match the plan.
   *
   * Called by every mutation below. `newQty` defaults to what the parent line
   * already says, so most callers change one fact and then just ask for a
   * reconcile.
   */
  /**
   * `refresh` is the only way an open order picks up a newer rule version.
   * Without it the line keeps the rule it was sold under, whatever has been
   * published since — see spec test 10.
   */
  static async reconcileLine(parentLineId, { newQty, onDate, refresh = false, transaction: outer } = {}) {
    return this._run(outer, async (transaction) => {
      const { parent, order } = await this._loadParent(parentLineId);
      this._assertEditable(order);

      const qty = newQty === undefined ? Number(parent.orderedQty) : Number(newQty);

      const present = await this._componentLines(parentLineId);
      const plan = await BundleExpansionService.reconcile({
        parentProductId: parent.productId,
        parentLineId,
        newParentQty: qty,
        presentComponents: present.map((l) => ({
          lineId: l.id,
          componentProductId: l.productId,
          qty: Number(l.orderedQty),
          systemQty: l.systemQty === null ? null : Number(l.systemQty),
          unitPricePaise: Number(l.ratePaise),
          systemUnitPricePaise: l.systemUnitPricePaise === null ? null : Number(l.systemUnitPricePaise),
          syncState: l.syncState,
          origin: l.origin,
        })),
        suppressedProductIds: await this._suppressedProductIds(parentLineId),
        frozenSnapshot: refresh ? null : parent.bundleSnapshot || null,
        context: {
          factoryId: order.factoryId,
          partyId: order.customerPartyId,
          onDate: onDate || order.orderDate,
        },
      });

      // The parent carries the rule it was expanded under, frozen (invariant 3).
      await parent.update(
        {
          orderedQty: qty,
          lineRole: plan.bundleRuleId ? 'PARENT' : parent.lineRole,
          bundleRuleId: plan.bundleRuleId,
          bundleRuleVersion: plan.bundleRuleVersion,
          bundleSnapshot: plan.snapshot,
        },
        { transaction }
      );

      for (const entry of plan.components) {
        if (entry.action === 'CREATE') {
          await SalesOrderLine.create(
            {
              salesOrderId: order.id,
              productId: entry.componentProductId,
              orderedQty: entry.qty,
              ratePaise: entry.unitPricePaise,
              productionRequired: await this._productionRequired(order, entry.componentProductId, entry.qty, transaction),
              lineRole: 'COMPONENT',
              parentLineId,
              bundleRuleId: plan.bundleRuleId,
              bundleRuleVersion: plan.bundleRuleVersion,
              bundleSnapshot: plan.snapshot,
              origin: entry.origin,
              syncState: entry.syncState,
              systemQty: entry.systemQty,
              systemUnitPricePaise: entry.systemUnitPricePaise,
            },
            { transaction }
          );
          continue;
        }

        const line = present.find((l) => l.id === entry.lineId);
        if (!line) continue;

        if (entry.action === 'DETACH') {
          await line.update({ syncState: 'DETACHED' }, { transaction });
          continue;
        }

        await line.update(
          {
            orderedQty: entry.qty,
            ratePaise: entry.unitPricePaise,
            productionRequired: await this._productionRequired(order, entry.componentProductId, entry.qty, transaction),
            systemQty: entry.systemQty,
            systemUnitPricePaise: entry.systemUnitPricePaise,
            syncState: entry.syncState,
            origin: entry.origin,
          },
          { transaction }
        );
      }

      await this._recomputeOrderTotal(order.id, transaction);

      return { plan, warnings: plan.warnings, orderId: order.id, parentLineId };
    });
  }

  /**
   * BR-12: whatever available stock cannot cover has to be made. A component
   * line is real demand on the plant — leaving it at zero would under-state the
   * production sheet by exactly the accessories the bundle just added.
   */
  static async _productionRequired(order, productId, qty, transaction) {
    const availability = await ReservationService.getAvailability(order.factoryId, productId, transaction);
    return Math.max(0, Number(qty) - Number(availability.available));
  }

  static async _recomputeOrderTotal(salesOrderId, transaction) {
    const lines = await SalesOrderLine.findAll({ where: { salesOrderId }, transaction });
    await SalesOrder.update(
      { totalAmountPaise: addPaise(...lines.map(lineTotal)) },
      { where: { id: salesOrderId }, transaction }
    );
  }

  static async _audit(fields) {
    await BundleOverrideAudit.create({ ...fields, occurredAt: new Date() });
  }

  // ---- commands ----------------------------------------------------------

  /** First expansion of a newly added parent line. */
  static async expandLine(parentLineId, { qty, onDate, transaction } = {}) {
    return this.reconcileLine(parentLineId, { newQty: qty, onDate, transaction });
  }

  /** The parent quantity changed; components follow, overrides do not. */
  static async changeParentQty(parentLineId, qty, { transaction } = {}) {
    if (!(Number(qty) > 0)) throw new ValidationError('Quantity must be more than zero');
    return this.reconcileLine(parentLineId, { newQty: qty, transaction });
  }

  /**
   * Take an accessory off this line and make it stay off.
   *
   * Deleting the line alone would not survive the next quantity change —
   * expansion would see the component missing and add it back. The tombstone is
   * what records that its absence is a decision (invariant 4).
   */
  static async suppress(parentLineId, componentProductId, { reasonCode, reasonNote, canOverrideMandatory = false, transaction: outer } = {}) {
    return this._run(outer, async (transaction) => {
      const { parent, order } = await this._loadParent(parentLineId);
      this._assertEditable(order);

      const reason = await OverrideReasonCode.findOne({ where: { code: reasonCode, isActive: true }, transaction });
      if (!reason) throw new ValidationError('Choose a reason for removing this item');
      if (reason.requiresNote && !String(reasonNote || '').trim()) {
        throw new ValidationError(`"${reason.label}" needs a note explaining what happened`);
      }

      // A component the business marked mandatory is one the product does not
      // work without — a slab with no reinforcement, a pump with no starter.
      // Removing it is allowed, but only by someone trusted to make that call,
      // and never silently.
      const ruleComponent = await this._ruleComponent(parent, componentProductId, transaction);
      if (ruleComponent?.isMandatory && !canOverrideMandatory) {
        const error = new ForbiddenError(
          'That item is part of the product and can only be removed by someone with the mandatory-override permission'
        );
        error.code = 'BUNDLE_MANDATORY_COMPONENT';
        throw error;
      }

      const line = await SalesOrderLine.findOne({
        where: { parentLineId, productId: componentProductId },
        transaction,
      });

      await BundleComponentSuppression.upsert(
        {
          salesOrderId: order.id,
          parentLineId,
          componentProductId,
          reasonCode,
          reasonNote: reasonNote || null,
          suppressedAt: new Date(),
        },
        { transaction }
      );

      if (line) await line.destroy({ transaction });

      await this._audit({
        salesOrderId: order.id,
        lineId: line ? line.id : null,
        parentLineId,
        componentProductId,
        action: 'SUPPRESSED',
        beforeValue: line ? { qty: Number(line.orderedQty), ratePaise: Number(line.ratePaise) } : null,
        afterValue: null,
        reasonCode,
        reasonNote: reasonNote || null,
      });

      await this._recomputeOrderTotal(order.id, transaction);
      return { orderId: order.id, parentLineId };
    });
  }

  /**
   * Put a removed accessory back.
   *
   * Deliberately returns it to SYNCED rather than to whatever it was before:
   * "put it back" is what a salesperson means, and it makes the line resume
   * scaling with the parent (§5).
   */
  static async restore(parentLineId, componentProductId, { transaction: outer } = {}) {
    return this._run(outer, async (transaction) => {
      const { order } = await this._loadParent(parentLineId);
      this._assertEditable(order);

      const removed = await BundleComponentSuppression.destroy({
        where: { parentLineId, componentProductId },
        transaction,
      });
      if (!removed) throw new NotFoundError('That item was not removed from this line');

      await this._audit({
        salesOrderId: order.id,
        parentLineId,
        componentProductId,
        action: 'RESTORED',
      });

      return this.reconcileLine(parentLineId, { transaction });
    });
  }

  /**
   * Add an accessory the rule offers but does not add by default.
   *
   * Expansion will not create these — that is what `defaultSelected = false`
   * means — so this creates the line, and every later reconcile then maintains
   * it like any other component.
   */
  static async addOptional(parentLineId, componentProductId, { qty, transaction: outer } = {}) {
    const created = await this._run(outer, async (transaction) => {
      const { parent, order } = await this._loadParent(parentLineId);
      this._assertEditable(order);

      const ruleComponent = await this._ruleComponent(parent, componentProductId, transaction);
      if (!ruleComponent) {
        throw new ValidationError('That item is not offered as an accessory for this product');
      }

      const existing = await SalesOrderLine.findOne({
        where: { parentLineId, productId: componentProductId },
        transaction,
      });
      if (existing) throw new ValidationError('That accessory is already on this line');

      // Adding it back explicitly overrides an earlier removal (§5).
      await BundleComponentSuppression.destroy({ where: { parentLineId, componentProductId }, transaction });

      const targetQty =
        qty !== undefined
          ? Number(qty)
          : ruleComponent.scalingMode === 'PROPORTIONAL'
            ? Number(ruleComponent.quantity) * Number(parent.orderedQty)
            : Number(ruleComponent.quantity);

      const ratePaise = Number(
        (await PricingService.resolveRate(componentProductId, { partyId: order.customerPartyId })) ?? 0
      );

      const line = await SalesOrderLine.create(
        {
          salesOrderId: order.id,
          productId: componentProductId,
          orderedQty: targetQty,
          ratePaise,
          productionRequired: await this._productionRequired(order, componentProductId, targetQty, transaction),
          lineRole: 'COMPONENT',
          parentLineId,
          bundleRuleId: parent.bundleRuleId,
          bundleRuleVersion: parent.bundleRuleVersion,
          bundleSnapshot: parent.bundleSnapshot,
          origin: 'RULE_OPTIONAL',
          syncState: 'SYNCED',
          systemQty: targetQty,
          systemUnitPricePaise: ratePaise,
        },
        { transaction }
      );

      await this._audit({
        salesOrderId: order.id,
        lineId: line.id,
        parentLineId,
        componentProductId,
        action: 'OPTIONAL_ADDED',
        afterValue: { qty: targetQty, ratePaise },
      });

      return line;
    });

    await this.reconcileLine(parentLineId, { transaction: outer });
    return created;
  }

  /** A typed quantity. From here the system stops owning this line's quantity. */
  static async changeComponentQty(parentLineId, componentProductId, qty, { transaction: outer } = {}) {
    if (!(Number(qty) > 0)) throw new ValidationError('Quantity must be more than zero');

    await this._run(outer, async (transaction) => {
      const { order } = await this._loadParent(parentLineId);
      this._assertEditable(order);

      const line = await SalesOrderLine.findOne({ where: { parentLineId, productId: componentProductId }, transaction });
      if (!line) throw new NotFoundError('That accessory is not on this line');

      const before = Number(line.orderedQty);
      await line.update({ orderedQty: Number(qty), syncState: 'QTY_OVERRIDDEN' }, { transaction });

      await this._audit({
        salesOrderId: order.id,
        lineId: line.id,
        parentLineId,
        componentProductId,
        action: 'QTY_CHANGED',
        beforeValue: { qty: before },
        afterValue: { qty: Number(qty) },
      });
    });

    return this.reconcileLine(parentLineId, { transaction: outer });
  }

  /** Hand the line back to the system: it returns to the suggested quantity. */
  static async resetComponent(parentLineId, componentProductId, { transaction: outer } = {}) {
    await this._run(outer, async (transaction) => {
      const { order } = await this._loadParent(parentLineId);
      this._assertEditable(order);

      const line = await SalesOrderLine.findOne({ where: { parentLineId, productId: componentProductId }, transaction });
      if (!line) throw new NotFoundError('That accessory is not on this line');

      const before = { qty: Number(line.orderedQty), ratePaise: Number(line.ratePaise), syncState: line.syncState };
      await line.update({ syncState: 'SYNCED' }, { transaction });

      await this._audit({
        salesOrderId: order.id,
        lineId: line.id,
        parentLineId,
        componentProductId,
        action: 'RESET',
        beforeValue: before,
        afterValue: { syncState: 'SYNCED', qty: line.systemQty === null ? null : Number(line.systemQty) },
      });
    });

    // The reconcile is what actually moves the quantity back to systemQty.
    return this.reconcileLine(parentLineId, { transaction: outer });
  }

  /**
   * Delete a parent and everything that came with it.
   *
   * The tombstones go too. They are keyed by line id, and leaving them behind
   * would suppress components on whatever line inherited the id later — a bug
   * that would surface as an accessory mysteriously refusing to appear.
   */
  static async deleteParentLine(parentLineId, { transaction: outer } = {}) {
    return this._run(outer, async (transaction) => {
      const { parent, order } = await this._loadParent(parentLineId);
      this._assertEditable(order);

      await BundleComponentSuppression.destroy({ where: { parentLineId }, transaction });
      await SalesOrderLine.destroy({ where: { parentLineId }, transaction });
      await parent.destroy({ transaction });

      await this._recomputeOrderTotal(order.id, transaction);
      return { orderId: order.id };
    });
  }

  /**
   * Deliberately re-expands against the current rule.
   *
   * Everything else on this service leaves an open order alone when a new rule
   * version is published, because a customer was quoted a particular set of
   * accessories and a background change to it is indistinguishable from a bug.
   * This is the explicit "yes, bring this order up to date" action — and it
   * still honours suppressions and overrides, so it re-plans rather than
   * discarding what the salesperson decided.
   */
  static async refreshToLatestRule(parentLineId, { transaction } = {}) {
    return this.reconcileLine(parentLineId, { refresh: true, transaction });
  }

  // ---- pickers -----------------------------------------------------------

  /**
   * What can still be put on this line: accessories the rule offers that are
   * not currently present.
   *
   * Two different things end up here — an optional extra never added, and a
   * component that was removed — and the UI shows them differently (a picker
   * versus a one-tap restore tray), so each entry says which it is rather than
   * making the caller work it out.
   */
  static async availableAccessories(parentLineId) {
    const { parent } = await this._loadParent(parentLineId);

    const components = await this._ruleComponents(parent);
    if (!components.length) return [];

    const present = new Set((await this._componentLines(parentLineId)).map((l) => l.productId));
    const suppressed = new Set(await this._suppressedProductIds(parentLineId));

    const missing = components.filter((c) => !present.has(c.componentProductId));
    if (!missing.length) return [];

    const products = await Product.findAll({ where: { id: { [Op.in]: missing.map((c) => c.componentProductId) } } });
    const nameById = new Map(products.map((p) => [p.id, p.name]));

    return missing
      .map((c) => ({
        componentProductId: c.componentProductId,
        productName: nameById.get(c.componentProductId) || null,
        suggestedQty:
          c.scalingMode === 'PROPORTIONAL'
            ? Number(c.quantity) * Number(parent.orderedQty)
            : Number(c.quantity),
        isMandatory: c.isMandatory,
        isSuppressed: suppressed.has(c.componentProductId),
        sequence: c.sequence,
      }))
      .sort((a, b) => a.sequence - b.sequence);
  }

  // ---- rule lookup -------------------------------------------------------

  /**
   * The rule's components as the parent line froze them.
   *
   * Read from the line's own snapshot rather than from the live rule, so an
   * order opened months later offers exactly the accessories it was sold with
   * (invariant 3). Falls back to the live rule only for a line expanded before
   * a snapshot existed.
   */
  static async _ruleComponents(parent, transaction) {
    if (parent.bundleSnapshot?.components?.length) return parent.bundleSnapshot.components;
    if (!parent.bundleRuleId) return [];

    const rule = await BundleRule.findByPk(parent.bundleRuleId, {
      include: [{ model: BundleComponent, as: 'components' }],
      transaction,
    });
    return (rule?.components || []).map((c) => ({
      componentProductId: c.componentProductId,
      quantity: Number(c.quantity),
      scalingMode: c.scalingMode,
      isMandatory: c.isMandatory,
      defaultSelected: c.defaultSelected,
      sequence: c.sequence,
    }));
  }

  static async _ruleComponent(parent, componentProductId, transaction) {
    const components = await this._ruleComponents(parent, transaction);
    return components.find((c) => c.componentProductId === componentProductId) || null;
  }
}

module.exports = { BundleDocumentService };
