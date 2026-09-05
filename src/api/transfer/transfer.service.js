const { sequelize } = require('../../config/database');
const { searchWhere } = require('../../utils/pagination');
const { StockTransfer } = require('./stockTransfer.model');
const { StockTransferLine } = require('./stockTransferLine.model');
const { StockLot } = require('../inventory/stockLot.model');
const { StockLedgerEntry } = require('../inventory/stockLedgerEntry.model');
const { Product } = require('../products/product.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { NotFoundError, ValidationError } = require('../../core/AppError');

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

class TransferService {
  static async listTransfers(page, limit, { fromFactoryId, toFactoryId, status, search , baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (fromFactoryId) where.fromFactoryId = fromFactoryId;
    if (toFactoryId) where.toFactoryId = toFactoryId;
    if (status) where.status = status;

    if (search) Object.assign(where, searchWhere(search, ['transferNumber', 'vehicleNumber']));
    return StockTransfer.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: StockTransferLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
      order: [['initiatedDate', 'DESC']],
    });
  }

  static async getTransfer(id) {
    const transfer = await StockTransfer.findByPk(id, {
      include: [
        {
          model: StockTransferLine,
          as: 'lines',
          include: [
            { model: Product, as: 'product' },
            { model: StockLot, as: 'sourceLot' },
            { model: StockLot, as: 'destinationLot' },
          ],
        },
      ],
    });
    if (!transfer) throw new NotFoundError('Stock transfer not found');
    return transfer;
  }

  static async initiateTransfer({ lines, ...data }) {
    if (data.fromFactoryId === data.toFactoryId) {
      throw new ValidationError('Source and destination factory must be different');
    }
    if (!lines || !lines.length) throw new ValidationError('A transfer requires at least one line');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('STOCK_TRANSFER', {
        factoryId: data.fromFactoryId,
        financialYearId,
        prefix: 'TRF',
        transaction,
      });

      const transfer = await StockTransfer.create({ ...data, transferNumber: documentNumber }, { transaction });

      for (const line of lines) {
        await StockLedgerService.postEntry({
          factoryId: data.fromFactoryId,
          productId: line.productId,
          lotId: line.sourceLotId,
          movementType: 'TRANSFER_OUT',
          direction: 'OUT',
          quantity: line.quantity,
          referenceType: 'StockTransfer',
          referenceId: transfer.id,
          transaction,
        });

        await StockTransferLine.create({ ...line, stockTransferId: transfer.id }, { transaction });
      }

      return this.getTransfer(transfer.id);
    });
  }

  static async receiveTransfer(id, { receivedDate, lines }) {
    const transfer = await this.getTransfer(id);
    if (transfer.status !== 'IN_TRANSIT') {
      throw new ValidationError(`Only an IN_TRANSIT transfer can be received (current status: ${transfer.status})`);
    }
    if (!lines || !lines.length) throw new ValidationError('Receipt requires at least one line');

    return sequelize.transaction(async (transaction) => {
      for (let i = 0; i < lines.length; i++) {
        const receipt = lines[i];
        const line = transfer.lines.find((l) => l.id === receipt.lineId);
        if (!line) throw new NotFoundError(`Transfer line ${receipt.lineId} not found on this transfer`);

        const sourceLot = await StockLot.findByPk(line.sourceLotId, { transaction });
        if (!sourceLot) throw new NotFoundError('Source lot not found');

        const receivedQuantity = receipt.receivedQuantity ?? line.quantity;
        if (Number(receivedQuantity) > Number(line.quantity)) {
          throw new ValidationError('Received quantity cannot exceed the quantity sent');
        }

        const seq = String(i + 1).padStart(2, '0');
        const destinationLot = await StockLedgerService.createLot({
          factoryId: transfer.toFactoryId,
          productId: line.productId,
          lotNumber: `${transfer.transferNumber}-${seq}`,
          originType: 'TRANSFER_IN',
          originId: line.id,
          // Preserve the source lot's own origin date/curing clock (BR-02) —
          // a transfer doesn't reset how long a lot has been curing/ageing.
          originDate: sourceLot.originDate,
          curingDaysOverride: sourceLot.curingDays,
          quantity: receivedQuantity,
          transaction,
        });

        await StockLedgerService.postEntry({
          factoryId: transfer.toFactoryId,
          productId: line.productId,
          lotId: destinationLot.id,
          movementType: 'TRANSFER_IN',
          direction: 'IN',
          quantity: receivedQuantity,
          referenceType: 'StockTransfer',
          referenceId: transfer.id,
          transaction,
        });

        await line.update({ receivedQuantity, destinationLotId: destinationLot.id }, { transaction });
      }

      await transfer.update({ status: 'RECEIVED', receivedDate }, { transaction });
      return this.getTransfer(id);
    });
  }

  static async cancelTransfer(id, reason) {
    const transfer = await this.getTransfer(id);
    if (transfer.status !== 'IN_TRANSIT') {
      throw new ValidationError(`Only an IN_TRANSIT transfer can be cancelled (current status: ${transfer.status})`);
    }
    if (!reason) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      for (const line of transfer.lines) {
        const outEntry = await StockLedgerEntry.findOne({
          where: { referenceType: 'StockTransfer', referenceId: transfer.id, lotId: line.sourceLotId, movementType: 'TRANSFER_OUT' },
          transaction,
        });
        await StockLedgerService.reverseEntry(outEntry.id, reason, transaction);
      }
      await transfer.update({ status: 'CANCELLED', cancelReason: reason }, { transaction });
      return this.getTransfer(id);
    });
  }
}

module.exports = { TransferService };
