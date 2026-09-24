'use strict';

/**
 * Restores the unique indexes a database built by `sequelize.sync()` never got.
 *
 * Every one of these is already created by an earlier migration. A database
 * built from the migrations therefore has them all and this file does nothing —
 * every statement is IF NOT EXISTS. It exists for the other case: the
 * development database was built by `sync()`, which creates tables from the
 * models and knows nothing about `queryInterface.addIndex`. It was missing 44
 * of the 61 this asserts, checked on 2026-09-24.
 *
 * That is not cosmetic. Among the missing were
 * `sales_invoices_tenant_number_unique` and its equivalents on challans,
 * orders, receipts and payments — the constraints that stop two concurrent
 * requests being handed the same document number. The allocator reads the last
 * number and writes the next one, so the index is the only thing that makes it
 * safe under load; without it, two invoices can be issued with one number, and
 * for a GST invoice series that is a filing problem, not a tidiness problem.
 *
 * `financial_years_tenant_code_unique` is deliberately NOT here: the
 * development database holds two financial years coded 2027-28 for one tenant,
 * so creating it would fail. Resolve those two rows and the original migration
 * already covers it.
 */
const INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS accounts_tenant_code_unique ON public.accounts USING btree (\"tenantId\", code);",
  "CREATE UNIQUE INDEX IF NOT EXISTS ad_group_members_group_employee_unique ON public.ad_group_members USING btree (\"adGroupId\", \"employeeId\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS advances_tenant_number_unique ON public.advances USING btree (\"tenantId\", \"advanceNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS attendance_records_labour_date_unique ON public.attendance_records USING btree (\"tenantId\", \"labourPartyId\", \"attendanceDate\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS bundle_components_rule_product_unique ON public.bundle_components USING btree (\"bundleRuleId\", \"componentProductId\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS bundle_rules_tenant_code_version_unique ON public.bundle_rules USING btree (\"tenantId\", code, version);",
  "CREATE UNIQUE INDEX IF NOT EXISTS bundle_suppressions_parent_product_unique ON public.bundle_component_suppressions USING btree (\"parentLineId\", \"componentProductId\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open_per_till ON public.cash_register_sessions USING btree (\"tenantId\", \"factoryId\", COALESCE(\"accountId\", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (status = 'OPEN'::enum_cash_register_sessions_status);",
  "CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_tenant_number_unique ON public.cash_register_sessions USING btree (\"tenantId\", \"sessionNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS contractor_material_issues_tenant_number_unique ON public.contractor_material_issues USING btree (\"tenantId\", \"issueNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS contractor_production_entries_tenant_number_unique ON public.contractor_production_entries USING btree (\"tenantId\", \"entryNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_tenant_number_unique ON public.credit_notes USING btree (\"tenantId\", \"noteNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS debit_notes_tenant_number_unique ON public.debit_notes USING btree (\"tenantId\", \"noteNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS delivery_challans_tenant_number_unique ON public.delivery_challans USING btree (\"tenantId\", \"challanNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS depreciation_runs_tenant_number_unique ON public.depreciation_runs USING btree (\"tenantId\", \"runNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS document_series_unique_with_factory ON public.document_series USING btree (\"tenantId\", \"documentType\", \"financialYearId\", \"factoryId\") WHERE (\"factoryId\" IS NOT NULL);",
  "CREATE UNIQUE INDEX IF NOT EXISTS document_series_unique_without_factory ON public.document_series USING btree (\"tenantId\", \"documentType\", \"financialYearId\") WHERE (\"factoryId\" IS NULL);",
  "CREATE UNIQUE INDEX IF NOT EXISTS employees_email_key ON public.employees USING btree (email);",
  "CREATE UNIQUE INDEX IF NOT EXISTS expenses_tenant_number_unique ON public.expenses USING btree (\"tenantId\", \"expenseNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS factories_tenant_code_unique ON public.factories USING btree (\"tenantId\", code);",
  "CREATE UNIQUE INDEX IF NOT EXISTS fixed_assets_tenant_number_unique ON public.fixed_assets USING btree (\"tenantId\", \"assetNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS goods_receipts_tenant_number_unique ON public.goods_receipts USING btree (\"tenantId\", \"grnNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS hsn_codes_tenant_code_unique ON public.hsn_codes USING btree (\"tenantId\", code);",
  "CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_tenant_key_unique ON public.idempotency_keys USING btree (\"tenantId\", key);",
  "CREATE UNIQUE INDEX IF NOT EXISTS journal_vouchers_tenant_number_unique ON public.journal_vouchers USING btree (\"tenantId\", \"voucherNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"labour_wage_profiles_partyId_key\" ON public.labour_wage_profiles USING btree (\"partyId\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS leads_tenant_number_unique ON public.leads USING btree (\"tenantId\", \"leadNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS leave_types_tenant_code_unique ON public.leave_types USING btree (\"tenantId\", code);",
  "CREATE UNIQUE INDEX IF NOT EXISTS mix_designs_one_active_per_product ON public.mix_designs USING btree (\"tenantId\", \"productId\") WHERE (\"isActive\" = true);",
  "CREATE UNIQUE INDEX IF NOT EXISTS notifications_tenant_dedupe_unique ON public.notifications USING btree (\"tenantId\", \"dedupeKey\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS office_departments_office_dept_unique ON public.office_departments USING btree (\"officeId\", \"departmentId\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS override_reason_codes_tenant_code_unique ON public.override_reason_codes USING btree (\"tenantId\", code);",
  "CREATE UNIQUE INDEX IF NOT EXISTS parties_tenant_code_unique ON public.parties USING btree (\"tenantId\", code) WHERE (code IS NOT NULL);",
  "CREATE UNIQUE INDEX IF NOT EXISTS parties_tenant_type_gstin_unique ON public.parties USING btree (\"tenantId\", \"partyType\", gstin) WHERE (gstin IS NOT NULL);",
  "CREATE UNIQUE INDEX IF NOT EXISTS payments_tenant_number_unique ON public.payments USING btree (\"tenantId\", \"paymentNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS price_list_items_list_product_unique ON public.price_list_items USING btree (\"priceListId\", \"productId\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS product_categories_tenant_code_unique ON public.product_categories USING btree (\"tenantId\", code) WHERE (code IS NOT NULL);",
  "CREATE UNIQUE INDEX IF NOT EXISTS production_entries_tenant_number_unique ON public.production_entries USING btree (\"tenantId\", \"entryNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS products_tenant_code_unique ON public.products USING btree (\"tenantId\", code);",
  "CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_grn_posted_unique ON public.purchase_invoices USING btree (\"tenantId\", \"goodsReceiptId\") WHERE (status = 'POSTED'::enum_purchase_invoices_status);",
  "CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_vendor_number_unique ON public.purchase_invoices USING btree (\"tenantId\", \"vendorPartyId\", \"vendorInvoiceNumber\") WHERE (status = 'POSTED'::enum_purchase_invoices_status);",
  "CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_tenant_number_unique ON public.purchase_orders USING btree (\"tenantId\", \"poNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS purchase_returns_tenant_number_unique ON public.purchase_returns USING btree (\"tenantId\", \"returnNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS quality_inspections_tenant_number_unique ON public.quality_inspections USING btree (\"tenantId\", \"inspectionNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS quotations_tenant_number_unique ON public.quotations USING btree (\"tenantId\", \"quotationNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS receipts_tenant_number_unique ON public.receipts USING btree (\"tenantId\", \"receiptNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_jti_unique ON public.refresh_tokens USING btree (jti);",
  "CREATE UNIQUE INDEX IF NOT EXISTS sales_invoice_challans_challan_unique ON public.sales_invoice_challans USING btree (\"deliveryChallanId\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS sales_invoices_tenant_number_unique ON public.sales_invoices USING btree (\"tenantId\", \"invoiceNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_tenant_number_unique ON public.sales_orders USING btree (\"tenantId\", \"orderNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS sales_returns_tenant_number_unique ON public.sales_returns USING btree (\"tenantId\", \"returnNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS staff_attendance_employee_date_unique ON public.staff_attendance USING btree (\"tenantId\", \"employeeId\", \"attendanceDate\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS stock_adjustments_tenant_number_unique ON public.stock_adjustments USING btree (\"tenantId\", \"adjustmentNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS stock_lots_tenant_number_unique ON public.stock_lots USING btree (\"tenantId\", \"lotNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_tenant_number_unique ON public.stock_transfers USING btree (\"tenantId\", \"transferNumber\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS tenant_settings_key_unique ON public.tenant_settings USING btree (\"tenantId\", key);",
  "CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_key ON public.tenants USING btree (slug);",
  "CREATE UNIQUE INDEX IF NOT EXISTS uoms_tenant_code_unique ON public.uoms USING btree (\"tenantId\", code);",
  "CREATE UNIQUE INDEX IF NOT EXISTS user_factories_factory_user_unique ON public.user_factories USING btree (\"factoryId\", \"userId\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS vehicles_tenant_registration_unique ON public.vehicles USING btree (\"tenantId\", \"registrationNumber\");",
];

module.exports = {
  async up(queryInterface) {
    for (const statement of INDEXES) {
      await queryInterface.sequelize.query(statement);
    }
  },

  /**
   * Deliberately empty. These indexes belong to the migrations that created
   * them; dropping them here would take them out of databases that were always
   * correct.
   */
  async down() {},
};

