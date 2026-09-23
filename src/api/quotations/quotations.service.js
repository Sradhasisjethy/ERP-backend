const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { searchWhere } = require('../../utils/pagination');
const { Quotation, QuotationLine } = require('./quotation.model');
const { Party } = require('../parties/party.model');
const { Product } = require('../products/product.model');
const { Factory } = require('../factory/factory.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { priceLines, resolveCustomer } = require('../retail/counterSale.service');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { getUserId } = require('../../core/tenantContext');

/**
 * Quotations.
 *
 * Pricing goes through the counter sale's `priceLines` — the same bundle
 * expansion, discount-before-tax rule, GST split and rupee rounding — so a
 * quotation and the invoice that eventually follows it are computed by one
 * piece of code and cannot disagree about how a price becomes a total.
 * Stock is not checked: a quote is a price, not a promise of what is in the
 * yard today.
 *
 * Lifecycle: DRAFT → SENT → ACCEPTED → CONVERTED, with REJECTED and CANCELLED
 * as dead ends. Expiry is not a stored status; a quote past `validUntil` is
 * expired whatever it says, and conversion refuses it until the date is moved.
 */

const EDITABLE = ['DRAFT', 'SENT'];
const CONVERTIBLE = ['DRAFT', 'SENT', 'ACCEPTED'];

const TRANSITIONS = {
  SENT: ['DRAFT'],
  ACCEPTED: ['DRAFT', 'SENT'],
  REJECTED: ['DRAFT', 'SENT', 'ACCEPTED'],
  CANCELLED: ['DRAFT', 'SENT', 'ACCEPTED'],
};

const MONEY = ['discountPaise', 'subtotalPaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'roundOffPaise', 'totalPaise'];
const LINE_MONEY = ['ratePaise', 'discountPaise', 'taxableAmountPaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'lineTotalPaise'];

const numbers = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, Number(obj[k])]));

const today = () => new Date().toISOString().slice(0, 10);

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

const view = (q) => {
  const json = q.toJSON();
  return {
    ...json,
    ...numbers(json, MONEY),
    isExpired: CONVERTIBLE.includes(json.status) && String(json.validUntil) < today(),
    buyerName: json.customer?.name || json.prospectName || null,
    lines: (json.lines || [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((l) => ({ ...l, ...numbers(l, LINE_MONEY), quantity: Number(l.quantity), discountPercent: Number(l.discountPercent), gstRatePercent: Number(l.gstRatePercent) })),
  };
};

class QuotationsService {
  static async list(page, limit, { status, customerPartyId, search, baseWhere = {} } = {}) {
    const where = { ...baseWhere };
    if (status === 'EXPIRED') {
      where.status = { [Op.in]: CONVERTIBLE };
      where.validUntil = { [Op.lt]: today() };
    } else if (status) {
      where.status = status;
    }
    if (customerPartyId) where.customerPartyId = customerPartyId;
    if (search) Object.assign(where, searchWhere(search, ['quotationNumber', 'prospectName']));
    const { rows, count } = await Quotation.findAndCountAll({
      where, limit, offset: (page - 1) * limit, distinct: true,
      include: [{ model: Party, as: 'customer', attributes: ['id', 'name'] }],
      order: [['quotationDate', 'DESC'], ['createdAt', 'DESC']],
    });
    return { rows: rows.map(view), count };
  }

  static async get(id, transaction) {
    const q = await Quotation.findByPk(id, {
      include: [
        { model: QuotationLine, as: 'lines', include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'code'] }] },
        { model: Party, as: 'customer' },
        { model: Factory, as: 'factory', attributes: ['id', 'name', 'code', 'state'] },
      ],
      transaction,
    });
    if (!q) throw new NotFoundError('Quotation not found');
    return q;
  }

  static async getView(id) {
    return view(await this.get(id));
  }

  /** Who the quote is for: an existing customer, or a prospect held on the quotation itself. */
  static async buyer({ customerPartyId, prospect }, transaction) {
    if (customerPartyId) {
      const party = await Party.findByPk(customerPartyId, { transaction });
      if (!party || party.partyType !== 'CUSTOMER') throw new NotFoundError('Customer not found');
      return { customerPartyId: party.id, taxCustomer: party, fields: { prospectName: null, prospectPhone: null, prospectState: null, prospectGstin: null } };
    }
    if (!prospect?.name || !String(prospect.name).trim()) {
      throw new ValidationError('Choose a customer, or give the name of the person you are quoting');
    }
    const fields = {
      prospectName: String(prospect.name).trim(),
      prospectPhone: prospect.phone ? String(prospect.phone).trim() : null,
      prospectState: prospect.state || null,
      prospectGstin: prospect.gstin ? String(prospect.gstin).trim().toUpperCase() : null,
    };
    return { customerPartyId: null, taxCustomer: { state: fields.prospectState, gstin: fields.prospectGstin }, fields };
  }

  static async price({ factory, taxCustomer, customerPartyId, lines, onDate, transaction }) {
    // A prospect with no state is quoted as local — the same presumption the
    // counter makes — rather than refused.
    const customer = { ...taxCustomer, state: taxCustomer.state || factory.state };
    return priceLines({
      factory, customer, lines, partyId: customerPartyId, onDate, checkStock: false,
      priceTypes: ['WHOLESALE', 'RETAIL'], transaction,
    });
  }

  static async writeLines(quotationId, lineInputs, transaction) {
    await QuotationLine.destroy({ where: { quotationId }, transaction });
    await QuotationLine.bulkCreate(
      lineInputs.map((l, index) => ({
        quotationId,
        productId: l.productId,
        bundleParentProductId: l.bundleParentProductId || null,
        hsnCode: l.hsnCode,
        quantity: l.quantity,
        ratePaise: l.ratePaise,
        discountPercent: l.discountPercent || 0,
        discountPaise: l.discountPaise || 0,
        taxableAmountPaise: l.taxableAmountPaise,
        gstRatePercent: l.gstRatePercent,
        cgstPaise: l.cgstPaise,
        sgstPaise: l.sgstPaise,
        igstPaise: l.igstPaise,
        lineTotalPaise: l.lineTotalPaise,
        sortOrder: index,
      })),
      // individualHooks: the scoped-model hook that stamps tenantId runs per
      // row, and a plain bulk insert would leave it null.
      { transaction, individualHooks: true, validate: true }
    );
  }

  static validateDates(quotationDate, validUntil) {
    if (validUntil < quotationDate) throw new ValidationError('A quotation cannot expire before the date it is issued');
  }

  static async create({ factoryId, quotationDate, validUntil, customerPartyId, prospect, lines, notes, terms, leadId }) {
    this.validateDates(quotationDate, validUntil);
    return sequelize.transaction(async (transaction) => {
      const factory = await Factory.findByPk(factoryId, { transaction });
      if (!factory) throw new NotFoundError('Factory not found');
      const who = await this.buyer({ customerPartyId, prospect }, transaction);
      const priced = await this.price({ factory, taxCustomer: who.taxCustomer, customerPartyId: who.customerPartyId, lines, onDate: quotationDate, transaction });

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('QUOTATION', { factoryId, financialYearId, prefix: 'QT', transaction });

      const quotation = await Quotation.create(
        {
          factoryId, quotationNumber: documentNumber, quotationDate, validUntil,
          customerPartyId: who.customerPartyId, ...who.fields, leadId: leadId || null,
          status: 'DRAFT', ...priced.totals,
          notes: notes || null, terms: terms || null, createdBy: getUserId() || null,
        },
        { transaction }
      );
      await this.writeLines(quotation.id, priced.lineInputs, transaction);

      if (leadId) {
        const { CrmService } = require('../crm/crm.service');
        await CrmService.markQuoted(leadId, transaction);
      }

      return view(await this.get(quotation.id, transaction));
    });
  }

  /** Re-prices from scratch on every edit, so totals always match the lines. */
  static async update(id, input) {
    return sequelize.transaction(async (transaction) => {
      const quotation = await this.get(id, transaction);
      if (!EDITABLE.includes(quotation.status)) {
        throw new ValidationError(`A ${quotation.status.toLowerCase()} quotation cannot be edited — only draft and sent ones`);
      }
      const quotationDate = input.quotationDate || quotation.quotationDate;
      const validUntil = input.validUntil || quotation.validUntil;
      this.validateDates(quotationDate, validUntil);

      const who = await this.buyer(
        input.customerPartyId !== undefined || input.prospect !== undefined
          ? { customerPartyId: input.customerPartyId, prospect: input.prospect }
          : { customerPartyId: quotation.customerPartyId, prospect: { name: quotation.prospectName, phone: quotation.prospectPhone, state: quotation.prospectState, gstin: quotation.prospectGstin } },
        transaction
      );
      // Existing lines are re-sent without their accessories; the bundle rule
      // adds those again, so an edit cannot double them.
      const lines = input.lines || quotation.lines
        .filter((l) => !l.bundleParentProductId)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((l) => ({ productId: l.productId, quantity: Number(l.quantity), ratePaise: Number(l.ratePaise), discountPercent: Number(l.discountPercent) }));

      const priced = await this.price({ factory: quotation.factory, taxCustomer: who.taxCustomer, customerPartyId: who.customerPartyId, lines, onDate: quotationDate, transaction });

      await quotation.update(
        {
          quotationDate, validUntil, customerPartyId: who.customerPartyId, ...who.fields, ...priced.totals,
          ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
          ...(input.terms !== undefined ? { terms: input.terms || null } : {}),
        },
        { transaction }
      );
      await this.writeLines(quotation.id, priced.lineInputs, transaction);
      return view(await this.get(id, transaction));
    });
  }

  static async setStatus(id, status, reason) {
    const quotation = await this.get(id);
    if (!TRANSITIONS[status]?.includes(quotation.status)) {
      throw new ValidationError(`A ${quotation.status.toLowerCase()} quotation cannot be marked ${status.toLowerCase()}`);
    }
    if (['REJECTED', 'CANCELLED'].includes(status) && !String(reason || '').trim()) {
      throw new ValidationError('Give a reason — it is what tells you later why this one was lost');
    }
    await quotation.update({ status, statusReason: reason ? String(reason).trim() : quotation.statusReason });
    return this.getView(id);
  }

  /**
   * Turns an accepted offer into a sales order.
   *
   * The order is raised through SalesService.createSalesOrder — the same path
   * as an order typed by hand — so credit limits, bundle expansion and
   * numbering all apply unchanged. Each line goes across at its net rate
   * (quoted rate less discount): sales orders carry no discount of their own.
   * Accessory lines are not sent; the order's own bundle expansion adds them.
   *
   * The quotation is claimed first (CONVERTED, conditional on its current
   * status) so two people converting at once cannot raise two orders; if the
   * order is then refused — a credit block, say — the claim is released.
   */
  static async convert(id, { orderDate, expectedDeliveryDate, allowCreditOverride = false, canOverrideMandatory = false }) {
    const quotation = await this.get(id);
    if (!CONVERTIBLE.includes(quotation.status)) {
      throw new ValidationError(`A ${quotation.status.toLowerCase()} quotation cannot be converted`);
    }
    if (String(quotation.validUntil) < today()) {
      throw new ValidationError(`This quotation expired on ${quotation.validUntil} — extend its validity first if the price still stands`);
    }

    const previousStatus = quotation.status;
    const [claimed] = await Quotation.update(
      { status: 'CONVERTED', convertedAt: new Date() },
      { where: { id, status: previousStatus } }
    );
    if (!claimed) throw new ValidationError('This quotation was changed by someone else — reload it and try again');

    try {
      let customerPartyId = quotation.customerPartyId;
      if (!customerPartyId) {
        const party = await sequelize.transaction((transaction) => resolveCustomer(
          { name: quotation.prospectName, phone: quotation.prospectPhone, state: quotation.prospectState, gstin: quotation.prospectGstin },
          quotation.factory,
          transaction
        ));
        customerPartyId = party.id;
      }

      const typed = quotation.lines.filter((l) => !l.bundleParentProductId).sort((a, b) => a.sortOrder - b.sortOrder);
      const lines = typed.map((l) => ({
        productId: l.productId,
        orderedQty: Number(l.quantity),
        ratePaise: Math.round(Number(l.taxableAmountPaise) / Number(l.quantity)),
      }));

      // ₹100 quoted over 3 pieces is ₹33.33 each, and a rate is whole paise, so
      // the order can differ from the quote by a paisa or two. Reported rather
      // than left for someone to find on the invoice.
      const quotedPaise = typed.reduce((sum, l) => sum + Number(l.taxableAmountPaise), 0);
      const orderedPaise = lines.reduce((sum, l) => sum + Math.round(l.orderedQty * l.ratePaise), 0);
      const roundingDifferencePaise = orderedPaise - quotedPaise;

      const { SalesService } = require('../sales/sales.service');
      const { order, creditWarning } = await SalesService.createSalesOrder({
        factoryId: quotation.factoryId,
        customerPartyId,
        orderDate: orderDate || today(),
        ...(expectedDeliveryDate ? { expectedDeliveryDate } : {}),
        poReferenceNumber: `Quotation ${quotation.quotationNumber}`,
        lines,
        allowCreditOverride,
        canOverrideMandatory,
      });

      await Quotation.update({ salesOrderId: order.id, customerPartyId }, { where: { id } });
      return { quotation: await this.getView(id), order, creditWarning, roundingDifferencePaise };
    } catch (err) {
      await Quotation.update({ status: previousStatus, convertedAt: null }, { where: { id } });
      throw err;
    }
  }
}

module.exports = { QuotationsService };
