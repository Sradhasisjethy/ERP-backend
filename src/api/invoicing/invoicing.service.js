const { sequelize } = require('../../config/database');
const { searchWhere } = require('../../utils/pagination');
const { SalesInvoice } = require('./salesInvoice.model');
const { SalesInvoiceLine } = require('./salesInvoiceLine.model');
const { SalesInvoiceChallan } = require('./salesInvoiceChallan.model');
const { DeliveryChallan } = require('../dispatch/deliveryChallan.model');
const { DeliveryChallanLine } = require('../dispatch/deliveryChallanLine.model');
const { SalesOrder } = require('../sales/salesOrder.model');
const { SalesOrderLine } = require('../sales/salesOrderLine.model');
const { Product } = require('../products/product.model');
const { HsnCode } = require('../products/hsnCode.model');
const { Party } = require('../parties/party.model');
const { PartyAddress } = require('../parties/partyAddress.model');
const { determineTax, splitTax } = require('./taxDetermination');
const { Factory } = require('../factory/factory.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { LedgerService } = require('../ledger/ledger.service');
const { JournalEntry } = require('../ledger/journalEntry.model');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { addPaise } = require('../../utils/money');

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

// Rounds to the nearest rupee (BR: "rounding"), returning both the rounded
// total and the paise adjustment needed to balance the journal against it.
const roundToRupee = (paise) => {
  const rounded = Math.round(paise / 100) * 100;
  return { rounded, roundOff: rounded - paise };
};

class InvoicingService {
  static async listInvoices(page, limit, { customerPartyId, status, search, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (customerPartyId) where.customerPartyId = customerPartyId;
    if (status) where.status = status;

    if (search) Object.assign(where, searchWhere(search, ['invoiceNumber']));
    return SalesInvoice.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Party, as: 'customer' }],
      order: [['invoiceDate', 'DESC']],
    });
  }

  static async getInvoice(id) {
    const invoice = await SalesInvoice.findByPk(id, {
      include: [
        { model: Party, as: 'customer' },
        { model: SalesInvoiceLine, as: 'lines', include: [{ model: Product, as: 'product' }] },
        { model: SalesInvoiceChallan, as: 'challanLinks', include: [{ model: DeliveryChallan, as: 'deliveryChallan' }] },
      ],
    });
    if (!invoice) throw new NotFoundError('Sales invoice not found');
    return invoice;
  }

  // M20/M21, BR-15: creates one invoice from one or more not-yet-invoiced
  // DISPATCHED challans (single or consolidated), computing GST per line from
  // each product's HSN and posting a balanced journal (BR-18).
  static async createInvoiceFromChallans({ challanIds, invoiceDate }) {
    if (!challanIds || !challanIds.length) throw new ValidationError('At least one delivery challan is required');

    return sequelize.transaction(async (transaction) => {
      const challans = await DeliveryChallan.findAll({
        where: { id: challanIds },
        include: [{ model: DeliveryChallanLine, as: 'lines', include: [{ model: Product, as: 'product', include: [{ model: HsnCode, as: 'hsnCode' }] }] }],
        transaction,
      });
      if (challans.length !== challanIds.length) throw new NotFoundError('One or more delivery challans not found');

      const factoryId = challans[0].factoryId;
      const salesOrderId = challans[0].salesOrderId;
      for (const challan of challans) {
        if (challan.status !== 'DISPATCHED') throw new ValidationError(`Challan ${challan.challanNumber} is not DISPATCHED`);
        if (challan.invoiced) throw new ValidationError(`Challan ${challan.challanNumber} has already been invoiced`);
        if (challan.factoryId !== factoryId) throw new ValidationError('All challans must be from the same factory');
        // "Single & consolidated" (BR-15) is scoped to one sales order — each
        // order carries its own agreed rates, so mixing orders would mean
        // guessing which rate applies. Consolidate challans within an order instead.
        if (challan.salesOrderId !== salesOrderId) throw new ValidationError('All challans must belong to the same sales order');
      }

      const salesOrderLines = await SalesOrderLine.findAll({ where: { salesOrderId }, transaction });
      const rateByLineId = Object.fromEntries(salesOrderLines.map((l) => [l.id, l.ratePaise]));

      const salesOrder = await SalesOrder.findByPk(salesOrderId, { transaction });
      const resolvedCustomer = await Party.findByPk(salesOrder.customerPartyId, { transaction });
      if (!resolvedCustomer) throw new NotFoundError('Customer not found');

      const factory = await Factory.findByPk(factoryId, { transaction });

      // FR-M16-4 / AC-9.1: place of supply follows the SHIPPING address, not
      // the customer's registered state. Falls back to the customer's own
      // state only when no shipping address is on file.
      const shippingAddress = await PartyAddress.findOne({
        where: { partyId: resolvedCustomer.id, isShipping: true, status: 'active' },
        order: [['isDefaultShipping', 'DESC'], ['createdAt', 'ASC']],
        transaction,
      });
      const { isInterState, supplierStateCode, placeOfSupplyCode } = determineTax({
        factory,
        shippingAddress,
        customer: resolvedCustomer,
      });

      const lineInputs = [];
      for (const challan of challans) {
        for (const line of challan.lines) {
          const ratePaise = rateByLineId[line.salesOrderLineId];
          if (ratePaise === undefined) throw new NotFoundError('Source sales order line not found for a challan line');

          const taxableAmountPaise = Math.round(Number(line.dispatchedQty) * ratePaise);
          const gstRatePercent = Number(line.product?.hsnCode?.gstRatePercent || 0);
          const taxPaise = Math.round((taxableAmountPaise * gstRatePercent) / 100);

          lineInputs.push({
            productId: line.productId,
            hsnCode: line.product?.hsnCode?.code || null,
            quantity: line.dispatchedQty,
            ratePaise,
            gstRatePercent,
            taxableAmountPaise,
            ...splitTax(taxPaise, isInterState),
            lineTotalPaise: taxableAmountPaise + taxPaise,
          });
        }
      }

      const subtotalPaise = addPaise(...lineInputs.map((l) => l.taxableAmountPaise));
      const cgstPaise = addPaise(...lineInputs.map((l) => l.cgstPaise));
      const sgstPaise = addPaise(...lineInputs.map((l) => l.sgstPaise));
      const igstPaise = addPaise(...lineInputs.map((l) => l.igstPaise));
      const rawTotal = subtotalPaise + cgstPaise + sgstPaise + igstPaise;
      const { rounded: totalPaise, roundOff: roundOffPaise } = roundToRupee(rawTotal);

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('SALES_INVOICE', {
        factoryId,
        financialYearId,
        prefix: 'INV',
        transaction,
      });

      const invoice = await SalesInvoice.create(
        {
          placeOfSupplyCode,
          supplierStateCode,
          shippingAddressId: shippingAddress?.id || null,
          factoryId,
          invoiceNumber: documentNumber,
          customerPartyId: resolvedCustomer.id,
          invoiceDate,
          subtotalPaise,
          cgstPaise,
          sgstPaise,
          igstPaise,
          roundOffPaise,
          totalPaise,
        },
        { transaction }
      );

      await SalesInvoiceLine.bulkCreate(
        lineInputs.map((l) => ({ ...l, salesInvoiceId: invoice.id })),
        { transaction, individualHooks: true, validate: true }
      );
      await SalesInvoiceChallan.bulkCreate(
        challans.map((c) => ({ salesInvoiceId: invoice.id, deliveryChallanId: c.id })),
        { transaction, individualHooks: true, validate: true }
      );
      await DeliveryChallan.update({ invoiced: true, invoicedAt: new Date() }, { where: { id: challanIds }, transaction });

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
        narration: `Sales invoice ${documentNumber}`,
        lines: journalLines,
        transaction,
      });

      return this.getInvoice(invoice.id);
    });
  }

  static async cancelInvoice(id, reason) {
    const invoice = await this.getInvoice(id);
    if (invoice.status !== 'POSTED') throw new ValidationError(`Only a POSTED invoice can be cancelled (current status: ${invoice.status})`);
    if (!reason) throw new ValidationError('A cancellation reason is required');

    // Cancelling reverses the receivable this invoice raised. If a receipt has
    // already been allocated to it, that receipt's credit stays behind and the
    // customer's ledger ends up showing money we never owed them — the account
    // goes negative and receivables stop reconciling. The receipt has to be
    // cancelled (or re-allocated) first; a credit note is the correct
    // instrument for reversing an invoice that has genuinely been paid.
    const { getInvoiceAllocatedAmount } = require('../payments/payments.service');
    const allocated = await getInvoiceAllocatedAmount('SALES', invoice.id);
    if (allocated > 0) {
      throw new ValidationError(
        `This invoice cannot be cancelled — ${allocated} paise has been received against it. ` +
          'Cancel or re-allocate the receipt first, or raise a credit note instead.'
      );
    }

    return sequelize.transaction(async (transaction) => {
      const originalEntry = await JournalEntry.findOne({
        where: { referenceType: 'SalesInvoice', referenceId: invoice.id },
        transaction,
      });
      if (originalEntry) await LedgerService.reverseJournal(originalEntry.id, reason, transaction);

      const challanIds = invoice.challanLinks.map((c) => c.deliveryChallanId);
      await DeliveryChallan.update({ invoiced: false, invoicedAt: null }, { where: { id: challanIds }, transaction });

      await invoice.update({ status: 'CANCELLED', cancelReason: reason }, { transaction });
      return this.getInvoice(id);
    });
  }
}

module.exports = { InvoicingService };
