const { Op } = require('sequelize');
const { SalesInvoice } = require('../invoicing/salesInvoice.model');
const { SalesInvoiceLine } = require('../invoicing/salesInvoiceLine.model');
const { SalesReturn } = require('../returns/salesReturn.model');
const { CreditNote } = require('../returns/creditNote.model');
const { PurchaseInvoice } = require('../purchasing/purchaseInvoice.model');
const { GoodsReceipt } = require('../purchasing/goodsReceipt.model');
const { GoodsReceiptLine } = require('../purchasing/goodsReceiptLine.model');
const { Product } = require('../products/product.model');
const { HsnCode } = require('../products/hsnCode.model');
const { Party } = require('../parties/party.model');
const { Factory } = require('../factory/factory.model');
const { ValidationError, NotFoundError } = require('../../core/AppError');

/**
 * M31: read-only export of the data an accountant needs to file GSTR-1
 * (outward supplies) and GSTR-3B (summary return) on the government portal.
 * Nothing here posts to the ledger — it derives figures from documents that
 * already exist (SalesInvoice for output tax, GoodsReceipt/PurchaseInvoice +
 * HSN rates for input tax credit, since PurchaseInvoice itself is a lightweight
 * payable record without its own GST breakdown — see purchaseInvoice.model.js).
 *
 * SalesReturn/CreditNote reduce a customer's dues but don't carry a GST-rate
 * breakdown in this schema, so they're surfaced in GSTR-1 (Table 9B, at gross
 * value) for manual entry rather than folded into the GSTR-3B tax figures.
 */
class GstrService {
  static async getFactory(factoryId) {
    const factory = await Factory.findByPk(factoryId);
    if (!factory) throw new NotFoundError('Factory not found');
    return factory;
  }

  static _dateRange(fromDate, toDate) {
    if (!fromDate || !toDate) throw new ValidationError('fromDate and toDate are required');
    return { [Op.gte]: fromDate, [Op.lte]: toDate };
  }

  static async getGstr1(factoryId, { fromDate, toDate }) {
    await this.getFactory(factoryId);
    const dateRange = this._dateRange(fromDate, toDate);

    const invoices = await SalesInvoice.findAll({
      where: { factoryId, status: 'POSTED', invoiceDate: dateRange },
      include: [
        { model: Party, as: 'customer' },
        { model: SalesInvoiceLine, as: 'lines', include: [{ model: Product, as: 'product', include: [{ model: HsnCode, as: 'hsnCode' }] }] },
      ],
      order: [['invoiceDate', 'ASC']],
    });

    const b2b = [];
    const b2c = [];
    const hsnMap = new Map();

    for (const invoice of invoices) {
      const row = {
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        customerName: invoice.customer?.name,
        customerGstin: invoice.customer?.gstin || null,
        placeOfSupply: invoice.customer?.state || null,
        taxableValuePaise: Number(invoice.subtotalPaise),
        cgstPaise: Number(invoice.cgstPaise),
        sgstPaise: Number(invoice.sgstPaise),
        igstPaise: Number(invoice.igstPaise),
        totalPaise: Number(invoice.totalPaise),
      };
      (invoice.customer?.gstin ? b2b : b2c).push(row);

      for (const line of invoice.lines) {
        const hsnCode = line.product?.hsnCode?.code || line.hsnCode || 'UNSPECIFIED';
        const key = `${hsnCode}|${line.gstRatePercent}`;
        if (!hsnMap.has(key)) {
          hsnMap.set(key, {
            hsnCode, gstRatePercent: Number(line.gstRatePercent), totalQuantity: 0,
            taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalValuePaise: 0,
          });
        }
        const bucket = hsnMap.get(key);
        bucket.totalQuantity += Number(line.quantity);
        bucket.taxableValuePaise += Number(line.taxableAmountPaise);
        bucket.cgstPaise += Number(line.cgstPaise);
        bucket.sgstPaise += Number(line.sgstPaise);
        bucket.igstPaise += Number(line.igstPaise);
        bucket.totalValuePaise += Number(line.lineTotalPaise);
      }
    }

    const salesReturns = await SalesReturn.findAll({
      where: { factoryId, status: 'POSTED', returnDate: dateRange },
      include: [{ model: Party, as: 'customer' }, { model: SalesInvoice, as: 'salesInvoice' }],
      order: [['returnDate', 'ASC']],
    });
    const creditNotes = await CreditNote.findAll({
      where: { factoryId, status: 'POSTED', noteDate: dateRange },
      include: [{ model: Party, as: 'customer' }, { model: SalesInvoice, as: 'salesInvoice' }],
      order: [['noteDate', 'ASC']],
    });

    const creditDebitNotes = [
      ...salesReturns.map((r) => ({
        noteType: 'SALES_RETURN', noteNumber: r.returnNumber, noteDate: r.returnDate,
        customerName: r.customer?.name, customerGstin: r.customer?.gstin || null,
        originalInvoiceNumber: r.salesInvoice?.invoiceNumber || null, valuePaise: Number(r.totalAmountPaise),
      })),
      ...creditNotes.map((n) => ({
        noteType: 'CREDIT_NOTE', noteNumber: n.noteNumber, noteDate: n.noteDate,
        customerName: n.customer?.name, customerGstin: n.customer?.gstin || null,
        originalInvoiceNumber: n.salesInvoice?.invoiceNumber || null, valuePaise: Number(n.amountPaise),
      })),
    ].sort((a, b) => new Date(a.noteDate) - new Date(b.noteDate));

    const summary = b2b.concat(b2c).reduce(
      (acc, row) => ({
        taxableValuePaise: acc.taxableValuePaise + row.taxableValuePaise,
        cgstPaise: acc.cgstPaise + row.cgstPaise,
        sgstPaise: acc.sgstPaise + row.sgstPaise,
        igstPaise: acc.igstPaise + row.igstPaise,
        totalPaise: acc.totalPaise + row.totalPaise,
      }),
      { taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0 }
    );

    return {
      period: { fromDate, toDate },
      summary,
      b2b,
      b2c,
      hsnSummary: Array.from(hsnMap.values()),
      creditDebitNotes,
    };
  }

  static async getGstr3b(factoryId, { fromDate, toDate }) {
    const factory = await this.getFactory(factoryId);
    const dateRange = this._dateRange(fromDate, toDate);

    // 3.1(a): Outward taxable supplies — from POSTED sales invoices in the period.
    const invoices = await SalesInvoice.findAll({ where: { factoryId, status: 'POSTED', invoiceDate: dateRange } });
    const outwardSupplies = invoices.reduce(
      (acc, inv) => ({
        taxableValuePaise: acc.taxableValuePaise + Number(inv.subtotalPaise),
        cgstPaise: acc.cgstPaise + Number(inv.cgstPaise),
        sgstPaise: acc.sgstPaise + Number(inv.sgstPaise),
        igstPaise: acc.igstPaise + Number(inv.igstPaise),
      }),
      { taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 }
    );

    // 4. ITC available — derived from goods receipts billed via a POSTED
    // purchase invoice in the period, split CGST+SGST/IGST by vendor vs
    // factory state, at each line's HSN GST rate.
    const purchaseInvoices = await PurchaseInvoice.findAll({
      where: { factoryId, invoiceDate: dateRange },
      include: [
        { model: Party, as: 'vendor' },
        {
          model: GoodsReceipt,
          as: 'goodsReceipt',
          include: [{ model: GoodsReceiptLine, as: 'lines', include: [{ model: Product, as: 'product', include: [{ model: HsnCode, as: 'hsnCode' }] }] }],
        },
      ],
    });

    const itcAvailable = { taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
    for (const pi of purchaseInvoices) {
      const sameState = pi.vendor?.state && factory.state && pi.vendor.state === factory.state;
      for (const line of pi.goodsReceipt?.lines || []) {
        const taxable = Math.round(Number(line.receivedQty) * Number(line.ratePaise));
        const gstRate = Number(line.product?.hsnCode?.gstRatePercent || 0);
        const gstAmount = Math.round((taxable * gstRate) / 100);
        itcAvailable.taxableValuePaise += taxable;
        if (sameState) {
          itcAvailable.cgstPaise += Math.round(gstAmount / 2);
          itcAvailable.sgstPaise += gstAmount - Math.round(gstAmount / 2);
        } else {
          itcAvailable.igstPaise += gstAmount;
        }
      }
    }

    const netTaxPayable = {
      cgstPaise: Math.max(0, outwardSupplies.cgstPaise - itcAvailable.cgstPaise),
      sgstPaise: Math.max(0, outwardSupplies.sgstPaise - itcAvailable.sgstPaise),
      igstPaise: Math.max(0, outwardSupplies.igstPaise - itcAvailable.igstPaise),
    };

    return { period: { fromDate, toDate }, outwardSupplies, itcAvailable, netTaxPayable };
  }
}

module.exports = { GstrService };
