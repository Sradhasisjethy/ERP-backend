const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { SalesInvoice } = require('../invoicing/salesInvoice.model');
const { SalesInvoiceLine } = require('../invoicing/salesInvoiceLine.model');
const { InvoicingService } = require('../invoicing/invoicing.service');
const { determineTax, splitTax } = require('../invoicing/taxDetermination');
const { Party } = require('../parties/party.model');
const { Product } = require('../products/product.model');
const { HsnCode } = require('../products/hsnCode.model');
const { Factory } = require('../factory/factory.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { StockLot } = require('../inventory/stockLot.model');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { ReservationService } = require('../inventory/reservation.service');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { LedgerService } = require('../ledger/ledger.service');
const { PaymentsService } = require('../payments/payments.service');
const { PricingService } = require('../pricing/pricing.service');
const { BundleExpansionService } = require('../bundles/bundleExpansion.service');
const { OverrideReasonCode } = require('../bundles/overrideReasonCode.model');
const { AuditLog } = require('../audit/auditLog.model');
const { getUserId, getIp } = require('../../core/tenantContext');
const { addPaise } = require('../../utils/money');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../core/AppError');

/**
 * B2C counter sales.
 *
 * The B2B chain is order -> reservation -> challan -> invoice, which suits a
 * contractor buying on agreed rates and credit terms. A walk-in buying a pallet
 * of pavers has no order to dispatch against, so before this there was no way
 * to sell to them at all.
 *
 * What a counter sale skips, and why:
 *   - the sales order      nothing to plan against; the sale is the event
 *   - the reservation      stock is taken now, not promised for later
 *   - the credit check     the money is collected at the counter
 *   - the delivery challan the tax invoice is raised at the moment of sale, and
 *                          goods moving WITH an invoice need no separate
 *                          challan under GST
 *
 * What it deliberately does NOT skip:
 *   - curing (BR-08) and the QC gate (QC-01), both enforced inside consumeFifo
 *   - FIFO lot consumption (BR-01..BR-05) and the stock ledger
 *   - reservations held by confirmed B2B orders — see assertFreeStock below
 *   - GST determination, document numbering, and double-entry posting
 *
 * Everything lands in one transaction. A counter sale that produced an invoice
 * but no stock movement, or took money without an invoice, is worse than one
 * that fails outright.
 */

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

const roundToRupee = (paise) => {
  const rounded = Math.round(paise / 100) * 100;
  return { rounded, roundOff: rounded - paise };
};

/**
 * Finds or creates the party a counter sale bills to.
 *
 * A party per walk-in rather than one shared "Cash Customer": repeat buyers get
 * a purchase history, the receivables ledger stays per-person, and GSTR-1 keeps
 * splitting B2B from B2C on GSTIN presence exactly as it does now. A walk-in
 * who happens to be GST-registered gives their GSTIN and correctly lands in the
 * B2B section — the counter is a process, not a tax category.
 *
 * Matching is on phone because it is the only thing a counter customer reliably
 * gives that is theirs alone. Name matching would merge two different people
 * called Ramesh Sahoo into one ledger.
 */
const resolveCustomer = async (customer, factory, transaction) => {
  if (customer.partyId) {
    const existing = await Party.findByPk(customer.partyId, { transaction });
    if (!existing || existing.partyType !== 'CUSTOMER') throw new NotFoundError('Customer not found');
    return existing;
  }

  if (!customer.name || !String(customer.name).trim()) {
    throw new ValidationError('A counter sale needs either an existing customer or a name for the walk-in buyer');
  }

  if (customer.phone) {
    const found = await Party.findOne({
      where: { partyType: 'CUSTOMER', phone: String(customer.phone).trim() },
      transaction,
    });
    if (found) return found;
  }

  return Party.create(
    {
      partyType: 'CUSTOMER',
      name: String(customer.name).trim(),
      phone: customer.phone ? String(customer.phone).trim() : null,
      // Blank GSTIN is the norm here and is what puts the sale in the B2C half
      // of GSTR-1. It is not defaulted to anything.
      gstin: customer.gstin ? String(customer.gstin).trim().toUpperCase() : null,
      // Place of supply needs a state. A buyer standing at the counter is
      // presumed to be taking delivery in the factory's own state unless they
      // say otherwise, which is both the common case and the conservative one:
      // it yields CGST+SGST rather than silently treating a local sale as
      // inter-state.
      state: customer.state || factory.state,
      address: customer.address || null,
      status: 'active',
    },
    { transaction }
  );
};

/**
 * Refuses to sell stock that a confirmed B2B order is already holding.
 *
 * consumeFifo checks physical lot quantity and nothing else, which is right for
 * a dispatch: the reservation being drawn down belongs to the very order being
 * dispatched. A counter sale has no reservation of its own, so the same check
 * would happily hand a walk-in the 200 pavers reserved against tomorrow's
 * contractor delivery — the stock ledger would balance perfectly and the order
 * would fail at dispatch with no explanation of where the goods went.
 *
 * `available` is `sellable - reserved`, the same figure the availability screen
 * shows, so a refusal here matches what the salesperson was looking at.
 *
 * The lots are locked FOR UPDATE first. Without that, two counter sales for the
 * same product both read the same availability, both pass, and both consume.
 */
const assertFreeStock = async (factoryId, productId, quantity, transaction = null) => {
  await StockLedgerService.promoteEligibleLots(factoryId, transaction);

  // Locked only when there is a transaction to hold the lock. A quote reads
  // without one and must not try to: `FOR UPDATE` outside a transaction is
  // released immediately and would be pointless, and reaching for
  // `transaction.LOCK` on null throws.
  if (transaction) {
    await StockLot.findAll({
      where: { factoryId, productId, qtyAvailable: { [Op.gt]: 0 } },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  const availability = await ReservationService.getAvailability(factoryId, productId, transaction);
  if (Number(quantity) > availability.available) {
    const product = await Product.findByPk(productId, { attributes: ['name', 'code'], transaction });
    const label = product ? `"${product.name || product.code}"` : 'this product';
    throw new ValidationError(
      `Not enough free stock for ${label}: ${availability.available} available to sell, ${quantity} requested. ` +
        `On hand ${availability.onHand}, of which ${availability.reserved} is reserved against open orders` +
        (availability.curing ? `, ${availability.curing} still curing` : '') +
        (availability.awaitingQc ? `, ${availability.awaitingQc} awaiting QC` : '') +
        '.'
    );
  }
};

/**
 * Whether this accessory may be taken off the sale, and on what grounds.
 *
 * The same discipline the sales-order flow applies (BundleDocumentService
 * .suppress): a reason from the configured list, a note where that reason asks
 * for one, and a mandatory component only by someone holding the override
 * permission. The point is not to make removal difficult — a customer who does
 * not want a gasket must be able to decline one, and a clerk who cannot remove
 * it will simply sell it anyway, putting goods on a GST invoice that never left
 * the yard. The point is that every removal has a named reason and a named
 * person behind it, which is what makes the pattern of removals worth reading.
 */
const assertRemovable = async (component, override, { canOverrideMandatory }) => {
  const reason = await OverrideReasonCode.findOne({
    where: { code: override.reasonCode || '', isActive: true },
  });
  if (!reason) throw new ValidationError('Choose a reason for removing this item');
  if (reason.requiresNote && !String(override.reasonNote || '').trim()) {
    throw new ValidationError(`"${reason.label}" needs a note explaining what happened`);
  }

  // A mandatory component is one the product does not work without. Removing it
  // is allowed, but only by someone trusted to make that call.
  if (component.isMandatory && !canOverrideMandatory) {
    throw new ForbiddenError(
      'That item is part of the product and can only be removed by someone with the mandatory-override permission'
    );
  }
};

/**
 * Adds the accessories a bundle rule attaches to a product (BR-23).
 *
 * A pipe sold on a sales order comes with its gasket, because the order flow
 * expands bundle rules. Without this, the same pipe sold across the counter
 * went out without one — the customer left short of a part the rule says is
 * mandatory, and the two channels reported different revenue and different
 * stock movements for the same sale.
 *
 * What gets added is decided by `reconcile`, not second-guessed here. It splits
 * a rule's components two ways: `components` are the ones that go in (the rule
 * marks them `defaultSelected`), and `optional` are "offered in the picker,
 * never auto-created". A DETACHed component is one the rule has since dropped.
 *
 * Filtering these again on `isMandatory` — as this first did — adds nothing and
 * silently breaks the feature. `isMandatory` governs whether an accessory may
 * be REMOVED from a line, not whether it is put there: every component in this
 * deployment is `isMandatory: false` with `defaultSelected: true`, so that
 * check excluded all of them and no accessory ever appeared.
 *
 * The accessory carries the bundle's own agreed price rather than being priced
 * again from the retail list — that price is part of the rule.
 */
const withBundleAccessories = async (lines, onDate, { canOverrideMandatory = false, removals = null } = {}) => {
  const expanded = [];

  for (const line of lines) {
    expanded.push(line);

    const overrides = new Map(
      (line.accessoryOverrides || []).map((o) => [o.componentProductId, o])
    );

    const result = await BundleExpansionService.reconcile({
      parentProductId: line.productId,
      newParentQty: Number(line.quantity),
      context: { onDate },
    });

    for (const component of result.components || []) {
      if (component.action === 'DETACH') continue;

      const override = overrides.get(component.componentProductId);

      if (override?.removed) {
        await assertRemovable(component, override, { canOverrideMandatory });
        // Collected rather than logged here: nothing should be written for a
        // quote, and a sale has no invoice to hang the record on until later.
        if (removals) {
          removals.push({
            parentProductId: line.productId,
            componentProductId: component.componentProductId,
            productName: component.productName,
            qty: component.qty,
            ratePaise: component.unitPricePaise,
            reasonCode: override.reasonCode,
            reasonNote: override.reasonNote || null,
            wasMandatory: !!component.isMandatory,
          });
        }
        continue;
      }

      expanded.push({
        productId: component.componentProductId,
        // An accessory the counter re-typed keeps what was typed; otherwise it
        // follows the parent quantity through the rule's scaling.
        quantity: override?.qty !== undefined && override.qty !== null ? Number(override.qty) : component.qty,
        ratePaise:
          override?.ratePaise !== undefined && override.ratePaise !== null
            ? Number(override.ratePaise)
            : component.unitPricePaise,
        discountPercent: override?.discountPercent ?? 0,
        bundleParentProductId: line.productId,
      });
    }
  }

  return expanded;
};

/**
 * Prices a set of counter-sale lines: per-line tax, and the invoice totals.
 *
 * Shared by the real sale and by the quote the counter screen shows before
 * anything is committed, so the figure the customer is asked to pay is the
 * figure the invoice is actually raised for. The alternative — recomputing GST
 * and rupee rounding in the browser — would be two implementations of the same
 * money arithmetic that must agree to the paisa, which is the shape of bug this
 * codebase has already produced more than once.
 *
 * `customer` needs only a state and possibly a GSTIN, and is never written to,
 * so a quote can pass the raw form input without creating a party for someone
 * who may yet walk away.
 */
const priceLines = async ({ factory, customer, lines, partyId = null, onDate = null, checkStock = true, canOverrideMandatory = false, removals = null, transaction = null }) => {
  // No shipping address: the goods change hands at the counter, so place of
  // supply falls back to the customer's own state. A registered buyer's GSTIN
  // still wins, which is what determineTax already prefers.
  const { isInterState, supplierStateCode, placeOfSupplyCode } = determineTax({
    factory,
    shippingAddress: null,
    customer,
  });

  // Accessories are resolved before anything is priced, so a bundle component
  // goes through exactly the same tax, rounding and stock checks as a line
  // someone typed.
  const allLines = await withBundleAccessories(lines, onDate, { canOverrideMandatory, removals });

  const lineInputs = [];
  for (const line of allLines) {
    const quantity = Number(line.quantity);
    if (!(quantity > 0)) throw new ValidationError('Every counter sale line needs a positive quantity');

    const product = await Product.findByPk(line.productId, {
      include: [{ model: HsnCode, as: 'hsnCode' }],
      transaction,
    });
    if (!product) throw new NotFoundError(`Product ${line.productId} not found`);

    // An explicit rate from the counter wins; otherwise the RETAIL price list,
    // then the product's own selling price. Selling at zero because nobody
    // priced the item is the failure mode worth being loud about.
    const ratePaise =
      line.ratePaise !== undefined && line.ratePaise !== null
        ? Number(line.ratePaise)
        : await PricingService.resolveRate(line.productId, { partyId, priceType: 'RETAIL' });

    if (ratePaise === null || ratePaise === undefined) {
      throw new ValidationError(
        `No price could be found for "${product.name || product.code}" — enter a rate, or set one on the RETAIL price list.`
      );
    }
    if (Number(ratePaise) < 0) throw new ValidationError('A rate cannot be negative');

    // Left on for quotes too: quoting a price for something that cannot be sold
    // only wastes the counter's time, and the message names what is reserved so
    // the clerk can explain why.
    if (checkStock) await assertFreeStock(factory.id, line.productId, quantity, transaction);

    // A discount given at the time of supply and shown on the invoice comes off
    // the taxable value before GST is charged (s.15(3)(a) CGST Act). Applying
    // it after tax would overcharge the customer and overstate output GST.
    const discountPercent = Number(line.discountPercent || 0);
    if (discountPercent < 0 || discountPercent > 100) {
      throw new ValidationError('A discount must be between 0 and 100 percent');
    }
    const grossAmountPaise = Math.round(quantity * Number(ratePaise));
    const discountPaise = Math.round((grossAmountPaise * discountPercent) / 100);
    const taxableAmountPaise = grossAmountPaise - discountPaise;

    const gstRatePercent = Number(product.hsnCode?.gstRatePercent || 0);
    const taxPaise = Math.round((taxableAmountPaise * gstRatePercent) / 100);

    lineInputs.push({
      productId: line.productId,
      productName: product.name,
      hsnCode: product.hsnCode?.code || null,
      quantity,
      ratePaise: Number(ratePaise),
      discountPercent,
      discountPaise,
      gstRatePercent,
      taxableAmountPaise,
      ...splitTax(taxPaise, isInterState),
      lineTotalPaise: taxableAmountPaise + taxPaise,
      overrideLotId: line.overrideLotId,
      overrideLotReason: line.overrideLotReason,
      // Presentation only — tells the counter screen which rows the bundle rule
      // added rather than the clerk. Stripped before the line is written.
      bundleParentProductId: line.bundleParentProductId || null,
    });
  }

  // Reported separately from the subtotal: "you saved X" is the thing a counter
  // customer asks about, and the invoice has to be able to show gross less
  // discount rather than only the net it was taxed on.
  const discountPaise = addPaise(...lineInputs.map((l) => l.discountPaise || 0));
  const subtotalPaise = addPaise(...lineInputs.map((l) => l.taxableAmountPaise));
  const cgstPaise = addPaise(...lineInputs.map((l) => l.cgstPaise));
  const sgstPaise = addPaise(...lineInputs.map((l) => l.sgstPaise));
  const igstPaise = addPaise(...lineInputs.map((l) => l.igstPaise));
  const rawTotal = subtotalPaise + cgstPaise + sgstPaise + igstPaise;
  const { rounded: totalPaise, roundOff: roundOffPaise } = roundToRupee(rawTotal);

  return {
    lineInputs,
    isInterState,
    supplierStateCode,
    placeOfSupplyCode,
    totals: { discountPaise, subtotalPaise, cgstPaise, sgstPaise, igstPaise, roundOffPaise, totalPaise },
  };
};

class CounterSaleService {
  /**
   * What this sale would come to, without committing anything.
   *
   * The counter has to tell the customer what to pay before the sale is made,
   * and the payment must settle the invoice exactly. Rather than have the
   * browser reimplement GST determination, per-line rounding and the
   * round-to-rupee adjustment — and drift from the server by a paisa — the
   * screen asks the server the same question it will answer for real.
   *
   * Creates nothing: no party for a walk-in who may not buy, no document
   * number, no stock movement. It does still check free stock, so a quote for
   * something that cannot be sold fails here rather than at the till.
   */
  static async quote({ factoryId, customer, lines, invoiceDate, canOverrideMandatory = false }) {
    if (!lines || !lines.length) throw new ValidationError('A counter sale needs at least one line');

    const factory = await Factory.findByPk(factoryId);
    if (!factory) throw new NotFoundError('Factory not found');

    // An existing party is read for its state and its party-specific pricing; a
    // walk-in is priced from what has been typed so far, with the factory's
    // state standing in exactly as it will when the party is created.
    const existing = customer?.partyId ? await Party.findByPk(customer.partyId) : null;
    if (customer?.partyId && (!existing || existing.partyType !== 'CUSTOMER')) {
      throw new NotFoundError('Customer not found');
    }
    const taxCustomer = existing || {
      gstin: customer?.gstin || null,
      state: customer?.state || factory.state,
    };

    const { lineInputs, totals, isInterState } = await priceLines({
      factory,
      customer: taxCustomer,
      partyId: existing?.id || null,
      lines,
      // Bundle rules are versioned by date, so a quote must resolve them on the
      // same day the sale will be dated.
      onDate: invoiceDate || undefined,
      canOverrideMandatory,
    });

    return { lines: lineInputs, ...totals, isInterState };
  }

  /**
   * Sells stock across the counter: invoice, stock issue and receipt in one
   * transaction.
   *
   * @param factoryId     the selling plant; also the supplier state for GST
   * @param invoiceDate   date of sale
   * @param customer      { partyId } for a known buyer, or { name, phone?,
   *                      state?, gstin?, address? } for a walk-in
   * @param lines         [{ productId, quantity, ratePaise?, overrideLotId?,
   *                      overrideLotReason? }] — rate falls back to the RETAIL
   *                      price list, then the product's selling price
   * @param delivery      { vehicleNumber, driverName? } when the goods are
   *                      being sent out rather than carried away; null when the
   *                      customer collects
   * @param payment       { modes: [{ mode, amountPaise, ... }] } collected now,
   *                      or null to raise the invoice on credit
   */
  static async createCounterSale({ factoryId, invoiceDate, customer, lines, delivery = null, payment = null, canOverrideMandatory = false }) {
    if (!lines || !lines.length) throw new ValidationError('A counter sale needs at least one line');
    if (delivery && !delivery.vehicleNumber) {
      throw new ValidationError('A vehicle number is required when the goods are being delivered');
    }

    return sequelize.transaction(async (transaction) => {
      const factory = await Factory.findByPk(factoryId, { transaction });
      if (!factory) throw new NotFoundError('Factory not found');

      const resolvedCustomer = await resolveCustomer(customer || {}, factory, transaction);

      // Filled by priceLines as it walks the bundle rules; written to the audit
      // log once there is an invoice to point at.
      const removals = [];

      const { lineInputs, totals, supplierStateCode, placeOfSupplyCode } = await priceLines({
        factory,
        customer: resolvedCustomer,
        partyId: resolvedCustomer.id,
        lines,
        onDate: invoiceDate,
        canOverrideMandatory,
        removals,
        transaction,
      });
      const { subtotalPaise, cgstPaise, sgstPaise, igstPaise, roundOffPaise, totalPaise } = totals;

      const financialYearId = await getCurrentFinancialYearId(transaction);
      // The same INV series as a B2B invoice, on purpose. These are tax
      // invoices from one business under one GSTIN; a parallel series would
      // create two numbering runs to reconcile in GSTR-1 for no benefit.
      const { documentNumber } = await DocumentNumberingService.allocate('SALES_INVOICE', {
        factoryId,
        financialYearId,
        prefix: 'INV',
        transaction,
      });

      const invoice = await SalesInvoice.create(
        {
          factoryId,
          invoiceNumber: documentNumber,
          customerPartyId: resolvedCustomer.id,
          invoiceDate,
          placeOfSupplyCode,
          supplierStateCode,
          shippingAddressId: null,
          saleChannel: 'COUNTER',
          vehicleNumber: delivery?.vehicleNumber || null,
          driverName: delivery?.driverName || null,
          subtotalPaise,
          cgstPaise,
          sgstPaise,
          igstPaise,
          roundOffPaise,
          totalPaise,
        },
        { transaction }
      );

      // productName is carried for the quote's benefit and is not a column;
      // the lot override fields belong to the stock issue below, not the line.
      await SalesInvoiceLine.bulkCreate(
        lineInputs.map(({ overrideLotId, overrideLotReason, productName, bundleParentProductId, ...l }) => ({ ...l, salesInvoiceId: invoice.id })),
        { transaction, individualHooks: true, validate: true }
      );

      // Stock leaves against the invoice itself — there is no challan to hang
      // it on. referenceType 'SalesInvoice' is what cancelInvoice looks for
      // when it puts the goods back.
      for (const line of lineInputs) {
        await StockLedgerService.consumeFifo({
          factoryId,
          productId: line.productId,
          quantity: line.quantity,
          movementType: 'SALE_OUT',
          referenceType: 'SalesInvoice',
          referenceId: invoice.id,
          overrideLotId: line.overrideLotId,
          overrideReason: line.overrideLotReason,
          transaction,
        });
      }

      const journalLines = [
        { accountKey: 'ACCOUNTS_RECEIVABLE', partyId: resolvedCustomer.id, debitPaise: totalPaise, creditPaise: 0 },
        { accountKey: 'SALES_REVENUE', debitPaise: 0, creditPaise: subtotalPaise },
      ];
      if (cgstPaise) journalLines.push({ accountKey: 'GST_OUTPUT_CGST', debitPaise: 0, creditPaise: cgstPaise });
      if (sgstPaise) journalLines.push({ accountKey: 'GST_OUTPUT_SGST', debitPaise: 0, creditPaise: sgstPaise });
      if (igstPaise) journalLines.push({ accountKey: 'GST_OUTPUT_IGST', debitPaise: 0, creditPaise: igstPaise });
      if (roundOffPaise > 0) journalLines.push({ accountKey: 'ROUND_OFF', debitPaise: 0, creditPaise: roundOffPaise });
      if (roundOffPaise < 0) journalLines.push({ accountKey: 'ROUND_OFF', debitPaise: -roundOffPaise, creditPaise: 0 });

      await LedgerService.postJournal({
        factoryId,
        entryDate: invoiceDate,
        referenceType: 'SalesInvoice',
        referenceId: invoice.id,
        narration: `Counter sale ${documentNumber}`,
        lines: journalLines,
        transaction,
      });

      // The receipt runs through PaymentsService rather than being posted here,
      // so a counter receipt is the same object as any other — same numbering,
      // same allocation rules, same cheque lifecycle, and it shows up on the
      // payments screen. It is handed this transaction explicitly so the sale
      // stays all-or-nothing; left to open its own, it could not see the
      // invoice this transaction had just created.
      let receipt = null;
      if (payment) {
        const tendered = addPaise(...payment.modes.map((m) => Number(m.amountPaise)));
        if (tendered !== totalPaise) {
          throw new ValidationError(
            `Payment of ${tendered} paise does not match the invoice total of ${totalPaise} paise. ` +
              'Counter sales are settled in full; use a credit sale if the balance is to be collected later.'
          );
        }
        receipt = await PaymentsService.createReceipt({
          factoryId,
          customerPartyId: resolvedCustomer.id,
          receiptDate: invoiceDate,
          modes: payment.modes,
          allocations: [{ invoiceId: invoice.id, allocatedAmountPaise: totalPaise }],
          transaction,
        });
      }

      // An accessory the rule wanted and the counter took off. Recorded against
      // the invoice so "which accessories get dropped, by whom, and why" is a
      // question the audit log can answer — that reporting is what changes
      // behaviour, not making the button awkward to press.
      for (const removal of removals) {
        await AuditLog.create(
          {
            userId: getUserId() || null,
            entityType: 'CounterSaleAccessory',
            entityId: invoice.id,
            action: 'REMOVE',
            beforeSnapshot: {
              productId: removal.componentProductId,
              productName: removal.productName,
              qty: removal.qty,
              ratePaise: removal.ratePaise,
              parentProductId: removal.parentProductId,
              wasMandatory: removal.wasMandatory,
            },
            afterSnapshot: { reasonCode: removal.reasonCode, reasonNote: removal.reasonNote },
            ipAddress: getIp() || null,
          },
          { transaction }
        );
      }

      return {
        invoice: await InvoicingService.getInvoice(invoice.id),
        receipt,
        customer: resolvedCustomer,
        removedAccessories: removals,
      };
    });
  }
}

module.exports = { CounterSaleService, resolveCustomer, assertFreeStock };
