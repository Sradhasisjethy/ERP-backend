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
      // Cancelled bills must not claim input tax credit. Until purchase
      // invoices gained a status there was nothing to filter on here, so the
      // comment above described an intent the code could not honour.
      where: { factoryId, invoiceDate: dateRange, status: 'POSTED' },
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

  /**
   * Tax by GST rate, outward and inward, for the period.
   *
   * Outward is read from the invoice lines as they were raised (their stored
   * rate and tax), the same source GSTR-1 uses. Inward follows GSTR-3B's input
   * tax credit rule — goods-receipt lines on POSTED purchase invoices at the
   * product's HSN rate — so the two sides here add up to the 3B figures.
   */
  static async getTaxRateSummary(factoryId, { fromDate, toDate }) {
    const factory = await this.getFactory(factoryId);
    const dateRange = this._dateRange(fromDate, toDate);
    const rates = new Map();
    const bucket = (rate) => {
      const key = Number(rate || 0);
      if (!rates.has(key)) {
        rates.set(key, {
          gstRatePercent: key,
          outward: { taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
          inward: { taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
        });
      }
      return rates.get(key);
    };

    const invoices = await SalesInvoice.findAll({
      where: { factoryId, status: 'POSTED', invoiceDate: dateRange },
      include: [{ model: SalesInvoiceLine, as: 'lines' }],
    });
    for (const invoice of invoices) {
      for (const line of invoice.lines) {
        const b = bucket(line.gstRatePercent).outward;
        b.taxableValuePaise += Number(line.taxableAmountPaise);
        b.cgstPaise += Number(line.cgstPaise);
        b.sgstPaise += Number(line.sgstPaise);
        b.igstPaise += Number(line.igstPaise);
      }
    }

    const purchaseInvoices = await PurchaseInvoice.findAll({
      where: { factoryId, invoiceDate: dateRange, status: 'POSTED' },
      include: [
        { model: Party, as: 'vendor' },
        {
          model: GoodsReceipt,
          as: 'goodsReceipt',
          include: [{ model: GoodsReceiptLine, as: 'lines', include: [{ model: Product, as: 'product', include: [{ model: HsnCode, as: 'hsnCode' }] }] }],
        },
      ],
    });
    for (const pi of purchaseInvoices) {
      const sameState = pi.vendor?.state && factory.state && pi.vendor.state === factory.state;
      for (const line of pi.goodsReceipt?.lines || []) {
        const rate = Number(line.product?.hsnCode?.gstRatePercent || 0);
        const taxable = Math.round(Number(line.receivedQty) * Number(line.ratePaise));
        const tax = Math.round((taxable * rate) / 100);
        const b = bucket(rate).inward;
        b.taxableValuePaise += taxable;
        if (sameState) {
          b.cgstPaise += Math.round(tax / 2);
          b.sgstPaise += tax - Math.round(tax / 2);
        } else {
          b.igstPaise += tax;
        }
      }
    }

    const withTotal = (side) => ({ ...side, totalTaxPaise: side.cgstPaise + side.sgstPaise + side.igstPaise });
    const rows = [...rates.values()]
      .sort((a, b) => a.gstRatePercent - b.gstRatePercent)
      .map((r) => ({ gstRatePercent: r.gstRatePercent, outward: withTotal(r.outward), inward: withTotal(r.inward) }));

    const sum = (side) => rows.reduce(
      (acc, r) => ({
        taxableValuePaise: acc.taxableValuePaise + r[side].taxableValuePaise,
        totalTaxPaise: acc.totalTaxPaise + r[side].totalTaxPaise,
      }),
      { taxableValuePaise: 0, totalTaxPaise: 0 }
    );

    return { period: { fromDate, toDate }, rows, totals: { outward: sum('outward'), inward: sum('inward') } };
  }

  /**
   * GSTR-9 working papers for a financial year: the annual figures the return
   * asks for, assembled from the same computations as the monthly returns so
   * they reconcile with what was filed month by month.
   *
   *   Table 4   outward taxable supplies, B2B and B2C, with credit notes and
   *             sales returns issued in the year shown alongside
   *   Table 6   input tax credit, as GSTR-3B takes it
   *   Table 9   tax payable on outward supplies, net of ITC, per books
   *   Table 17  HSN-wise summary of outward supplies
   *
   * plus a month-by-month breakdown to reconcile against. This is a working
   * paper for filing, not the return itself: compare it with the portal's
   * auto-drafted figures, which come from the GSTR-1/3B actually filed.
   */
  static async getGstr9(factoryId, { fromDate, toDate }) {
    await this.getFactory(factoryId);
    this._dateRange(fromDate, toDate);
    // An annual return covers a year. A wider range is a mistyped date, and it
    // would run two queries per month for however long it spans.
    const spanDays = (new Date(toDate) - new Date(fromDate)) / 86400000;
    if (spanDays > 400) throw new ValidationError('GSTR-9 covers one financial year — narrow the dates');

    const gstr1 = await this.getGstr1(factoryId, { fromDate, toDate });
    const gstr3b = await this.getGstr3b(factoryId, { fromDate, toDate });

    const sumRows = (rows) => rows.reduce(
      (acc, r) => ({
        taxableValuePaise: acc.taxableValuePaise + r.taxableValuePaise,
        cgstPaise: acc.cgstPaise + r.cgstPaise,
        sgstPaise: acc.sgstPaise + r.sgstPaise,
        igstPaise: acc.igstPaise + r.igstPaise,
      }),
      { taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 }
    );
    const notesValuePaise = gstr1.creditDebitNotes.reduce((s, n) => s + n.valuePaise, 0);

    // Month by month, each month clipped to the requested range.
    const months = [];
    let cursor = new Date(`${fromDate.slice(0, 7)}-01T00:00:00Z`);
    const end = new Date(`${toDate}T00:00:00Z`);
    while (cursor <= end) {
      const monthStart = cursor.toISOString().slice(0, 10);
      const next = new Date(cursor);
      next.setUTCMonth(next.getUTCMonth() + 1);
      const monthEnd = new Date(next.getTime() - 86400000).toISOString().slice(0, 10);
      const from = monthStart < fromDate ? fromDate : monthStart;
      const to = monthEnd > toDate ? toDate : monthEnd;
      const m1 = await this.getGstr1(factoryId, { fromDate: from, toDate: to });
      const m3 = await this.getGstr3b(factoryId, { fromDate: from, toDate: to });
      months.push({
        month: monthStart.slice(0, 7),
        outwardTaxablePaise: m1.summary.taxableValuePaise,
        outwardTaxPaise: m1.summary.cgstPaise + m1.summary.sgstPaise + m1.summary.igstPaise,
        itcPaise: m3.itcAvailable.cgstPaise + m3.itcAvailable.sgstPaise + m3.itcAvailable.igstPaise,
        netPayablePaise: m3.netTaxPayable.cgstPaise + m3.netTaxPayable.sgstPaise + m3.netTaxPayable.igstPaise,
      });
      cursor = next;
    }

    return {
      period: { fromDate, toDate },
      table4: {
        b2b: sumRows(gstr1.b2b),
        b2c: sumRows(gstr1.b2c),
        total: gstr1.summary,
        creditNotesAndReturnsValuePaise: notesValuePaise,
      },
      table6: { itcAvailed: gstr3b.itcAvailable },
      table9: { taxPayable: gstr3b.outwardSupplies, itcUtilised: gstr3b.itcAvailable, netPayable: gstr3b.netTaxPayable },
      table17: { hsnSummary: gstr1.hsnSummary },
      months,
    };
  }
}

module.exports = { GstrService };
