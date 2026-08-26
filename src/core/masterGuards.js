const { Op } = require('sequelize');
const { ValidationError, ConflictError } = require('./AppError');

/**
 * Integrity guards shared by every master-data service.
 *
 * Two rules drive this file:
 *
 *  1. **A master that history depends on is never physically deleted.** The
 *     migrations put `onDelete: RESTRICT` on most transactional foreign keys,
 *     so Postgres already refuses the worst cases — but it refuses them as a
 *     generic "references a record that does not exist or is still in use"
 *     400, which tells the user nothing about *what* is using it. Worse, two
 *     references were declared CASCADE (`mix_designs.productId` and
 *     `price_list_items.productId`), so deleting a product that had never been
 *     transacted silently destroyed every BOM version and price row for it.
 *     Checking here means the answer is decided by the application, names the
 *     blocking record, and points at deactivation as the correct action.
 *
 *  2. **A transaction may only reference a live master of the right kind.**
 *     A foreign key proves `customerPartyId` is *a* party; it cannot prove it
 *     is a CUSTOMER rather than a labourer, nor that it is still active. Those
 *     are business rules and belong here.
 */

/**
 * Refuses the delete when any dependent row exists.
 *
 * @param {Array<{model: object, column: string, label: string}>} dependencies
 * @param {string} id - the master's primary key
 * @param {string} subject - how to name the master in the error, e.g. "product"
 */
const assertNoDependents = async (dependencies, id, subject) => {
  for (const { model, column, label } of dependencies) {
    const count = await model.count({ where: { [column]: id } });
    if (count > 0) {
      throw new ConflictError(
        `This ${subject} cannot be deleted — it is used by ${count} ${label}${count === 1 ? '' : 's'}. ` +
          `Set its status to inactive instead, so existing records keep their history.`
      );
    }
  }
};

/**
 * Rejects a duplicate on a business key before it reaches the database, so the
 * user gets "a customer with code CUST-01 already exists" rather than the
 * unique-index driver message. The DB constraint is still the real guarantee —
 * this check is racy by nature and only exists for the error text.
 *
 * @param {object} model
 * @param {object} where - the business key
 * @param {string} excludeId - the record being updated, if any
 * @param {string} message
 */
const assertUnique = async (model, where, excludeId, message) => {
  const scoped = excludeId ? { ...where, id: { [Op.ne]: excludeId } } : where;
  if (await model.count({ where: scoped })) throw new ConflictError(message);
};

/**
 * Resolves a party and proves it is the right kind and still usable.
 * Returns the party so callers don't have to fetch it twice.
 */
const assertUsableParty = async (Party, partyId, expectedType, transaction) => {
  const label = expectedType.toLowerCase().replace('_', ' ');
  const party = await Party.findByPk(partyId, { transaction });
  if (!party) throw new ValidationError(`No such ${label} exists`);
  if (party.partyType !== expectedType) {
    throw new ValidationError(
      `"${party.name}" is a ${party.partyType.toLowerCase().replace('_', ' ')}, not a ${label} — pick a ${label} instead`
    );
  }
  if (party.status !== 'active') {
    throw new ValidationError(`"${party.name}" is inactive and cannot be used on a new document`);
  }
  return party;
};

/**
 * Proves every product on a document's lines exists, belongs to this tenant
 * and is still active. Batched into one query — a 40-line order should not
 * cost 40 round trips.
 */
const assertUsableProducts = async (Product, productIds, transaction) => {
  const unique = [...new Set(productIds.filter(Boolean))];
  if (!unique.length) return [];

  const products = await Product.findAll({ where: { id: { [Op.in]: unique } }, transaction });
  if (products.length !== unique.length) {
    throw new ValidationError('One or more lines reference a product that does not exist');
  }

  const inactive = products.filter((p) => p.status !== 'active');
  if (inactive.length) {
    throw new ValidationError(
      `${inactive.map((p) => `"${p.name}"`).join(', ')} ${inactive.length === 1 ? 'is' : 'are'} inactive and cannot be used on a new document`
    );
  }
  return products;
};

module.exports = { assertNoDependents, assertUnique, assertUsableParty, assertUsableProducts };
