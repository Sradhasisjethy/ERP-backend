const { User } = require('../api/users/user.model');
const { Tenant } = require('../api/organization/tenant.model');
const { Organization } = require('../api/organization/organization.model');
const { Office } = require('../api/organization/office.model');
const { Department } = require('../api/organization/department.model');
const { AdGroup } = require('../api/roles/role.model');
const { AdGroupMember } = require('../api/roles/adGroupMember.model');
const { TenantSettings } = require('../api/settings/settings.model');
const { Factory } = require('../api/factory/factory.model');
const { FinancialYear } = require('../api/factory/financialYear.model');
const { UserFactory } = require('../api/factory/userFactory.model');
const { DocumentSeries } = require('../api/documentSeries/documentSeries.model');
const { AuditLog } = require('../api/audit/auditLog.model');
const { Uom } = require('../api/products/uom.model');
const { ProductCategory } = require('../api/products/productCategory.model');
const { HsnCode } = require('../api/products/hsnCode.model');
const { Product } = require('../api/products/product.model');
const { MixDesign } = require('../api/products/mixDesign.model');
const { MixDesignLine } = require('../api/products/mixDesignLine.model');
const { Party } = require('../api/parties/party.model');
const { LabourWageProfile } = require('../api/parties/labourWageProfile.model');
const { PriceList } = require('../api/pricing/priceList.model');
const { PriceListItem } = require('../api/pricing/priceListItem.model');
const { StockLot } = require('../api/inventory/stockLot.model');
const { StockLedgerEntry } = require('../api/inventory/stockLedgerEntry.model');
const { StockReservation } = require('../api/inventory/stockReservation.model');
const { StockAdjustment } = require('../api/inventory/stockAdjustment.model');
const { PurchaseOrder } = require('../api/purchasing/purchaseOrder.model');
const { PurchaseOrderLine } = require('../api/purchasing/purchaseOrderLine.model');
const { GoodsReceipt } = require('../api/purchasing/goodsReceipt.model');
const { GoodsReceiptLine } = require('../api/purchasing/goodsReceiptLine.model');
const { PurchaseInvoice } = require('../api/purchasing/purchaseInvoice.model');
const { StockTransfer } = require('../api/transfer/stockTransfer.model');
const { StockTransferLine } = require('../api/transfer/stockTransferLine.model');
const { SalesOrder } = require('../api/sales/salesOrder.model');
const { SalesOrderLine } = require('../api/sales/salesOrderLine.model');
const { ProductionPlan } = require('../api/production/productionPlan.model');
const { ProductionPlanLine } = require('../api/production/productionPlanLine.model');
const { ProductionEntry } = require('../api/production/productionEntry.model');
const { MaterialConsumption } = require('../api/production/materialConsumption.model');
const { WastageRecord } = require('../api/production/wastageRecord.model');
const { DeliveryChallan } = require('../api/dispatch/deliveryChallan.model');
const { DeliveryChallanLine } = require('../api/dispatch/deliveryChallanLine.model');
const { Account } = require('../api/ledger/account.model');
const { JournalEntry } = require('../api/ledger/journalEntry.model');
const { JournalLine } = require('../api/ledger/journalLine.model');
const { SalesInvoice } = require('../api/invoicing/salesInvoice.model');
const { SalesInvoiceLine } = require('../api/invoicing/salesInvoiceLine.model');
const { SalesInvoiceChallan } = require('../api/invoicing/salesInvoiceChallan.model');
const { SalesReturn } = require('../api/returns/salesReturn.model');
const { SalesReturnLine } = require('../api/returns/salesReturnLine.model');
const { PurchaseReturn } = require('../api/returns/purchaseReturn.model');
const { PurchaseReturnLine } = require('../api/returns/purchaseReturnLine.model');
const { CreditNote } = require('../api/returns/creditNote.model');
const { DebitNote } = require('../api/returns/debitNote.model');
const { Receipt } = require('../api/payments/receipt.model');
const { Payment } = require('../api/payments/payment.model');
const { PaymentAllocation } = require('../api/payments/paymentAllocation.model');
const { ContractorMaterialIssue } = require('../api/workforce/contractorMaterialIssue.model');
const { ContractorMaterialIssueLine } = require('../api/workforce/contractorMaterialIssueLine.model');
const { ContractorProductionEntry } = require('../api/workforce/contractorProductionEntry.model');
const { AttendanceRecord } = require('../api/workforce/attendanceRecord.model');
const { Advance } = require('../api/workforce/advance.model');
const { Expense } = require('../api/expenses/expense.model');
const { SavedReport } = require('../api/reports/savedReport.model');
const { UomConversion } = require('../api/products/uomConversion.model');
const { PartyAddress } = require('../api/parties/partyAddress.model');
const { Cheque } = require('../api/payments/cheque.model');
const { PurchaseIndent, PurchaseIndentLine } = require('../api/purchasing/purchaseIndent.model');
const { Notification } = require('../api/notifications/notification.model');

// Tenant associations
Tenant.hasMany(Organization, { foreignKey: 'tenantId' });
Organization.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(Office, { foreignKey: 'tenantId' });
Office.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(Department, { foreignKey: 'tenantId' });
Department.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(User, { foreignKey: 'tenantId' });
User.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(AdGroup, { foreignKey: 'tenantId' });
AdGroup.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(AdGroupMember, { foreignKey: 'tenantId' });
AdGroupMember.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(TenantSettings, { foreignKey: 'tenantId' });
TenantSettings.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(Factory, { foreignKey: 'tenantId' });
Factory.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(FinancialYear, { foreignKey: 'tenantId' });
FinancialYear.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(UserFactory, { foreignKey: 'tenantId' });
UserFactory.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(DocumentSeries, { foreignKey: 'tenantId' });
DocumentSeries.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(AuditLog, { foreignKey: 'tenantId' });
AuditLog.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(Uom, { foreignKey: 'tenantId' });
Uom.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(ProductCategory, { foreignKey: 'tenantId' });
ProductCategory.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(HsnCode, { foreignKey: 'tenantId' });
HsnCode.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(Product, { foreignKey: 'tenantId' });
Product.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(MixDesign, { foreignKey: 'tenantId' });
MixDesign.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(MixDesignLine, { foreignKey: 'tenantId' });
MixDesignLine.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(Party, { foreignKey: 'tenantId' });
Party.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(LabourWageProfile, { foreignKey: 'tenantId' });
LabourWageProfile.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(PriceList, { foreignKey: 'tenantId' });
PriceList.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(PriceListItem, { foreignKey: 'tenantId' });
PriceListItem.belongsTo(Tenant, { foreignKey: 'tenantId' });

// Organization associations
Organization.hasMany(Office, { foreignKey: 'organizationId' });

Organization.hasMany(Department, { foreignKey: 'organizationId' });
Department.belongsTo(Organization, { foreignKey: 'organizationId' });

Organization.hasMany(User, { foreignKey: 'organizationId' });
User.belongsTo(Organization, { foreignKey: 'organizationId' });

Organization.hasMany(Factory, { foreignKey: 'organizationId' });
Factory.belongsTo(Organization, { foreignKey: 'organizationId' });

// Office associations
Office.hasMany(User, { foreignKey: 'officeId' });
User.belongsTo(Office, { foreignKey: 'officeId' });

// Department associations
Department.hasMany(User, { foreignKey: 'departmentId' });
User.belongsTo(Department, { foreignKey: 'departmentId' });

// AdGroupMember associations
User.hasMany(AdGroupMember, { foreignKey: 'employeeId' });
AdGroupMember.belongsTo(User, { foreignKey: 'employeeId' });

// Factory / financial year / user-factory scoping (BR-29, M01)
Factory.hasMany(UserFactory, { foreignKey: 'factoryId' });
UserFactory.belongsTo(Factory, { foreignKey: 'factoryId' });

User.hasMany(UserFactory, { foreignKey: 'userId' });
UserFactory.belongsTo(User, { foreignKey: 'userId' });

FinancialYear.hasMany(DocumentSeries, { foreignKey: 'financialYearId' });
DocumentSeries.belongsTo(FinancialYear, { foreignKey: 'financialYearId' });

// Audit log (BR-30, M17)
User.hasMany(AuditLog, { foreignKey: 'userId' });
AuditLog.belongsTo(User, { foreignKey: 'userId' });

// Party extensions (M04)
Party.hasOne(LabourWageProfile, { as: 'wageProfile', foreignKey: 'partyId' });

module.exports = {
  User,
  Tenant,
  Organization,
  Office,
  Department,
  AdGroup,
  AdGroupMember,
  TenantSettings,
  Factory,
  FinancialYear,
  UserFactory,
  DocumentSeries,
  AuditLog,
  Uom,
  ProductCategory,
  HsnCode,
  Product,
  MixDesign,
  MixDesignLine,
  Party,
  LabourWageProfile,
  PriceList,
  PriceListItem,
  StockLot,
  StockLedgerEntry,
  StockReservation,
  StockAdjustment,
  PurchaseOrder,
  PurchaseOrderLine,
  GoodsReceipt,
  GoodsReceiptLine,
  PurchaseInvoice,
  StockTransfer,
  StockTransferLine,
  SalesOrder,
  SalesOrderLine,
  ProductionPlan,
  ProductionPlanLine,
  ProductionEntry,
  MaterialConsumption,
  WastageRecord,
  DeliveryChallan,
  DeliveryChallanLine,
  Account,
  JournalEntry,
  JournalLine,
  SalesInvoice,
  SalesInvoiceLine,
  SalesInvoiceChallan,
  SalesReturn,
  SalesReturnLine,
  PurchaseReturn,
  PurchaseReturnLine,
  CreditNote,
  DebitNote,
  Receipt,
  Payment,
  PaymentAllocation,
  ContractorMaterialIssue,
  ContractorMaterialIssueLine,
  ContractorProductionEntry,
  AttendanceRecord,
  Advance,
  Expense,
  SavedReport,
  UomConversion,
  PartyAddress,
  Cheque,
  PurchaseIndent,
  PurchaseIndentLine,
  Notification,
};
