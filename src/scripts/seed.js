const { sequelize } = require('../config/database');
const {
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
} = require('../models/index');
const bcrypt = require('bcryptjs');
const cls = require('cls-hooked');
const { EmployeeStatus, EmployeeType, SystemRoles } = require('../utils/constants');
const { NAMESPACE_NAME } = require('../core/tenantContext');
const { StockLedgerService } = require('../api/inventory/stockLedger.service');

// StockLedgerService (like every BaseAuditedModel hook) reads tenantId from
// CLS rather than a parameter, because that's how request-scoped tenant
// isolation works everywhere else in the app. The seed script has no
// request, so this opens the same kind of session by hand.
const runInTenantContext = (tenantId, fn) => {
  const session = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
  return session.runAndReturn(() => {
    session.set('tenantId', tenantId);
    return fn();
  });
};

const seedDatabase = async () => {
  try {
    console.log('Starting database seed...');

    // Sync DB
    await sequelize.sync({ force: true });
    console.log('Database synced with force: true');

    // a. 1 Tenant
    const tenant = await Tenant.create({
      name: 'Acme Corporation',
      slug: 'acme-corp',
      status: 'active',
    });
    const tenantId = tenant.get('id');
    console.log(`Created Tenant: ${tenant.get('name')}`);

    // b. 1 Organization
    const org = await Organization.create({
      tenantId,
      name: 'Acme Global',
      code: 'ACM',
      status: 'active',
    });
    const organizationId = org.get('id');
    console.log(`Created Organization: ${org.get('name')}`);

    // c. 3 Offices
    const offices = await Promise.all([
      Office.create({ tenantId, organizationId, name: 'New York HQ', city: 'New York', country: 'USA', status: 'active' }),
      Office.create({ tenantId, organizationId, name: 'London Office', city: 'London', country: 'UK', status: 'active' }),
      Office.create({ tenantId, organizationId, name: 'Bangalore Tech Hub', city: 'Bangalore', country: 'India', status: 'active' }),
    ]);
    console.log(`Created ${offices.length} Offices`);

    // d. 6 Departments
    const departmentsData = [
      { name: 'Engineering', code: 'ENG' },
      { name: 'Product', code: 'PROD' },
      { name: 'Marketing', code: 'MKT' },
      { name: 'Sales', code: 'SALES' },
      { name: 'Human Resources', code: 'HR' },
      { name: 'Finance', code: 'FIN' },
    ];

    const departments = await Promise.all(
      departmentsData.map((d) =>
        Department.create({
          tenantId,
          organizationId,
          name: d.name,
          code: d.code,
          status: 'active',
        })
      )
    );
    console.log(`Created ${departments.length} Departments`);

    // f. 5 Roles (created before employees so the first employee can be assigned one)
    const rolesData = [
      { name: 'Platform Admin', description: 'Full system access', permissions: ['*'] },
      {
        // Can onboard and edit people but not delete them — the kind of split the
        // coarse EMPLOYEE_WRITE this used to hold couldn't express.
        name: 'HR Manager',
        description: 'HR capabilities',
        permissions: ['EMPLOYEE_READ', 'EMPLOYEE_CREATE', 'EMPLOYEE_MODIFY', 'ORG_READ', 'SETTINGS_READ'],
      },
      {
        name: 'Engineering Lead',
        description: 'Engineering team management',
        permissions: ['EMPLOYEE_READ', 'ORG_READ'],
      },
      { name: 'Employee', description: 'Standard access', permissions: ['EMPLOYEE_READ'] },
      { name: 'Guest', description: 'Limited access', permissions: [] },
    ];

    const roles = await Promise.all(
      rolesData.map((r) =>
        AdGroup.create({
          tenantId,
          name: r.name,
          description: r.description,
          permissions: r.permissions,
          status: 'active',
        })
      )
    );
    console.log(`Created ${roles.length} Roles`);

    // e. 20 Employees
    const names = [
      'John Smith', 'Sarah Johnson', 'Raj Patel', 'Emily Chen', 'Michael Brown',
      'Jessica Davis', 'David Miller', 'Ashley Wilson', 'James Moore', 'Amanda Taylor',
      'Robert Anderson', 'Melissa Thomas', 'William Jackson', 'Stephanie White', 'Joseph Harris',
      'Rebecca Martin', 'Charles Thompson', 'Laura Garcia', 'Thomas Martinez', 'Michelle Robinson',
    ];

    const employees = [];
    for (let i = 0; i < 20; i++) {
      const [firstName, lastName] = names[i].split(' ');
      let status = EmployeeStatus.ACTIVE;
      if (i >= 15 && i < 17) status = EmployeeStatus.ONBOARDING;
      else if (i >= 17 && i < 19) status = EmployeeStatus.TERMINATED;
      else if (i === 19) status = EmployeeStatus.INACTIVE;

      const employee = await User.create(
        {
          tenantId,
          organizationId,
          firstName,
          lastName,
          email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@acme.corp`,
          employeeCode: `EMP-${String(i + 1).padStart(3, '0')}`,
          employeeType: EmployeeType.FULL_TIME,
          status,
          departmentId: departments[i % departments.length].id,
          officeId: offices[i % offices.length].id,
          passwordHash: await bcrypt.hash('12345678', 10),
          role: i === 0 ? SystemRoles.PLATFORM_ADMIN : SystemRoles.EMPLOYEE,
        },
        { validate: false }
      );
      employees.push(employee);
    }
    console.log(`Created ${employees.length} Employees`);

    // Assign the second employee (a non-bypass role) the "HR Manager" role so the RBAC
    // wiring (JWT permissions <- AdGroupMember -> AdGroup) can be exercised end to end.
    const hrManagerRole = roles.find((r) => r.name === 'HR Manager');
    await AdGroupMember.create({
      tenantId,
      adGroupId: hrManagerRole.id,
      employeeId: employees[1].id,
    });
    console.log(`Assigned "HR Manager" role to ${employees[1].email}`);

    // g. 5 Settings
    const settingsData = [
      { key: 'timezone', value: 'America/New_York', category: 'general' },
      { key: 'dateFormat', value: 'MM/DD/YYYY', category: 'general' },
      { key: 'language', value: 'en', category: 'general' },
      { key: 'sessionTimeout', value: '30', category: 'security' },
      { key: 'passwordMinLength', value: '8', category: 'security' },
    ];

    const settings = await Promise.all(
      settingsData.map((s) =>
        TenantSettings.create({
          tenantId,
          key: s.key,
          value: s.value,
          category: s.category,
        })
      )
    );
    console.log(`Created ${settings.length} Settings`);

    // h. Financial Year (current)
    const financialYear = await FinancialYear.create({
      tenantId,
      code: '2026-27',
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      isCurrent: true,
    });
    console.log(`Created Financial Year: ${financialYear.code}`);

    // i. Factories (BRD: Bhuasuni Precast — multiple factory locations)
    const factories = await Promise.all([
      Factory.create({ tenantId, organizationId, name: 'Bhubaneswar Plant', code: 'BBSR', city: 'Bhubaneswar', state: 'Odisha' }),
      Factory.create({ tenantId, organizationId, name: 'Cuttack Plant', code: 'CTC', city: 'Cuttack', state: 'Odisha' }),
    ]);
    console.log(`Created ${factories.length} Factories`);

    await UserFactory.create({ tenantId, factoryId: factories[0].id, userId: employees[1].id });
    console.log(`Assigned ${employees[1].email} to ${factories[0].name}`);

    // j. Product / BOM masters
    const uoms = await Promise.all([
      Uom.create({ tenantId, name: 'Numbers', code: 'NOS' }),
      Uom.create({ tenantId, name: 'Kilogram', code: 'KG' }),
      Uom.create({ tenantId, name: 'Cubic Meter', code: 'CUM' }),
      Uom.create({ tenantId, name: 'Bag', code: 'BAG' }),
    ]);
    console.log(`Created ${uoms.length} UoMs`);

    const category = await ProductCategory.create({ tenantId, name: 'Precast Concrete', code: 'PRECAST' });
    const rawMaterialCategory = await ProductCategory.create({ tenantId, name: 'Raw Materials', code: 'RAWMAT' });
    console.log('Created 2 Product Categories');

    const hsnCode = await HsnCode.create({ tenantId, code: '6810', description: 'Articles of cement, concrete', gstRatePercent: 18 });
    console.log(`Created HSN Code: ${hsnCode.code}`);

    const nosUom = uoms.find((u) => u.code === 'NOS');
    const kgUom = uoms.find((u) => u.code === 'KG');
    const bagUom = uoms.find((u) => u.code === 'BAG');
    const cumUom = uoms.find((u) => u.code === 'CUM');

    const [cement, sand, aggregate, precastSlab] = await Promise.all([
      Product.create({ tenantId, categoryId: rawMaterialCategory.id, uomId: bagUom.id, name: 'Cement (OPC 43)', code: 'RM-CEMENT', productType: 'RAW_MATERIAL' }),
      Product.create({ tenantId, categoryId: rawMaterialCategory.id, uomId: cumUom.id, name: 'Sand', code: 'RM-SAND', productType: 'RAW_MATERIAL' }),
      Product.create({ tenantId, categoryId: rawMaterialCategory.id, uomId: cumUom.id, name: 'Aggregate 20mm', code: 'RM-AGG20', productType: 'RAW_MATERIAL' }),
      Product.create({
        tenantId,
        categoryId: category.id,
        uomId: nosUom.id,
        hsnId: hsnCode.id,
        name: 'Precast Boundary Slab 6ft',
        code: 'FG-SLAB-6FT',
        productType: 'FINISHED_GOOD',
        curingDays: 14,
        standardCostPaise: 45000,
      }),
    ]);
    console.log('Created 4 Products (3 raw materials, 1 finished good)');

    const mixDesign = await MixDesign.create({ tenantId, productId: precastSlab.id, name: 'Standard Mix v1', version: 1, isActive: true });
    await MixDesignLine.bulkCreate([
      { tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: cement.id, quantityPerUnit: 0.5, uomId: bagUom.id },
      { tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: sand.id, quantityPerUnit: 0.08, uomId: cumUom.id },
      { tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: aggregate.id, quantityPerUnit: 0.05, uomId: cumUom.id },
    ]);
    console.log(`Created Mix Design "${mixDesign.name}" with 3 lines for ${precastSlab.name}`);

    // Stock the raw materials at the first factory so Production Entry has
    // something to consume out of the box — otherwise BR-04 correctly blocks
    // every casting attempt with "insufficient stock" on a fresh database.
    await runInTenantContext(tenantId, async () => {
      await sequelize.transaction(async (transaction) => {
        for (const [product, quantity] of [
          [cement, 500],
          [sand, 200],
          [aggregate, 200],
        ]) {
          const lot = await StockLedgerService.createLot({
            factoryId: factories[0].id,
            productId: product.id,
            lotNumber: `SEED-${product.code}`,
            originType: 'PURCHASE',
            originId: '00000000-0000-0000-0000-000000000000',
            originDate: '2026-08-01',
            quantity,
            transaction,
          });
          await StockLedgerService.postEntry({
            factoryId: factories[0].id,
            productId: product.id,
            lotId: lot.id,
            movementType: 'PURCHASE_IN',
            direction: 'IN',
            quantity,
            referenceType: 'SeedData',
            referenceId: lot.id,
            transaction,
          });
        }
      });
    });
    console.log(`Stocked raw materials at ${factories[0].name}`);

    // k. Party masters (Customer/Vendor/Contractor/Labour/Sales Reference)
    const [customer, vendor, contractor, labour] = await Promise.all([
      Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Kalinga Builders Pvt Ltd', gstin: '21AAAAA0000A1Z5', city: 'Bhubaneswar', state: 'Odisha', creditLimitPaise: 50000000 }),
      Party.create({ tenantId, partyType: 'VENDOR', name: 'Odisha Cement Suppliers', gstin: '21BBBBB0000B1Z5', city: 'Cuttack', state: 'Odisha' }),
      Party.create({ tenantId, partyType: 'CONTRACTOR', name: 'Rabi Casting Contractor', phone: '9800000001' }),
      Party.create({ tenantId, partyType: 'LABOUR', name: 'Suresh Mallick', phone: '9800000002' }),
    ]);
    console.log('Created 4 Parties (customer, vendor, contractor, labour)');

    await LabourWageProfile.create({ tenantId, partyId: labour.id, dailyWagePaise: 60000, overtimeRateMultiplier: 1.5 });
    console.log(`Created wage profile for ${labour.name}`);

    // l. Default retail price list
    const priceList = await PriceList.create({ tenantId, name: 'Standard Retail', priceType: 'RETAIL', isDefault: true });
    await PriceListItem.create({ tenantId, priceListId: priceList.id, productId: precastSlab.id, ratePaise: 65000 });
    console.log(`Created price list "${priceList.name}" with 1 item`);

    console.log('\n--- Seeding Summary ---');
    console.log(`Tenant: 1`);
    console.log(`Organizations: 1`);
    console.log(`Offices: ${offices.length}`);
    console.log(`Departments: ${departments.length}`);
    console.log(`Employees: ${employees.length}`);
    console.log(`Roles: ${roles.length}`);
    console.log(`Settings: ${settings.length}`);
    console.log(`Factories: ${factories.length}`);
    console.log(`Products: 4 (+ 1 Mix Design)`);
    console.log(`Parties: 4`);
    console.log('Seeding completed successfully!');

    process.exit(0);
  } catch (error) {
    console.error('Error during seeding:', error);
    process.exit(1);
  }
};

seedDatabase();
