const cls = require('cls-hooked');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, Organization, Factory, Party } = require('../src/models/index');
const { LedgerService } = require('../src/api/ledger/ledger.service');
const { NAMESPACE_NAME } = require('../src/core/tenantContext');

let tenantId;
let factoryA; // allowNegativeCash: false
let factoryB; // allowNegativeCash: true
let customer;

const runInTenantContext = (fn) => {
  const session = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
  return session.runAndReturn(() => {
    session.set('tenantId', tenantId);
    return fn();
  });
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-ledger', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  factoryA = await Factory.create({ tenantId, organizationId: org.id, name: 'Ledger Factory A', code: 'LFA', allowNegativeCash: false });
  factoryB = await Factory.create({ tenantId, organizationId: org.id, name: 'Ledger Factory B', code: 'LFB', allowNegativeCash: true });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Ledger Test Customer' });
});

afterAll(async () => {
  await sequelize.close();
});

describe('LedgerService core (M30, BR-18, BR-21)', () => {
  it('rejects an unbalanced journal', async () => {
    await runInTenantContext(() =>
      sequelize.transaction(async (t) => {
        await expect(
          LedgerService.postJournal({
            factoryId: factoryA.id,
            entryDate: '2026-08-15',
            referenceType: 'Test',
            referenceId: '00000000-0000-0000-0000-000000000001',
            lines: [
              { accountKey: 'ACCOUNTS_RECEIVABLE', partyId: customer.id, debitPaise: 1000, creditPaise: 0 },
              { accountKey: 'SALES_REVENUE', debitPaise: 0, creditPaise: 900 },
            ],
            transaction: t,
          })
        ).rejects.toThrow(/not balanced/);
      })
    );
  });

  it('rejects a journal line on a party-control account with no partyId', async () => {
    await runInTenantContext(() =>
      sequelize.transaction(async (t) => {
        await expect(
          LedgerService.postJournal({
            factoryId: factoryA.id,
            entryDate: '2026-08-15',
            referenceType: 'Test',
            referenceId: '00000000-0000-0000-0000-000000000002',
            lines: [
              { accountKey: 'ACCOUNTS_RECEIVABLE', debitPaise: 1000, creditPaise: 0 },
              { accountKey: 'SALES_REVENUE', debitPaise: 0, creditPaise: 1000 },
            ],
            transaction: t,
          })
        ).rejects.toThrow(/requires a partyId/);
      })
    );
  });

  it('posts a balanced journal and updates the trial balance', async () => {
    await runInTenantContext(() =>
      sequelize.transaction(async (t) => {
        const entry = await LedgerService.postJournal({
          factoryId: factoryA.id,
          entryDate: '2026-08-15',
          referenceType: 'Test',
          referenceId: '00000000-0000-0000-0000-000000000003',
          narration: 'Test sale',
          lines: [
            { accountKey: 'ACCOUNTS_RECEIVABLE', partyId: customer.id, debitPaise: 118000, creditPaise: 0 },
            { accountKey: 'SALES_REVENUE', debitPaise: 0, creditPaise: 100000 },
            { accountKey: 'GST_OUTPUT_CGST', debitPaise: 0, creditPaise: 9000 },
            { accountKey: 'GST_OUTPUT_SGST', debitPaise: 0, creditPaise: 9000 },
          ],
          transaction: t,
        });
        expect(entry.totalDebitPaise).toBe('118000');
        expect(entry.totalCreditPaise).toBe('118000');
      })
    );

    const trialBalance = await LedgerService.getTrialBalance(factoryA.id);
    const ar = trialBalance.find((a) => a.code === '1100');
    expect(ar.balancePaise).toBe(118000);
    const sales = trialBalance.find((a) => a.code === '4000');
    expect(sales.balancePaise).toBe(-100000); // credit-normal account, negative in debit-minus-credit terms

    const outstanding = await LedgerService.getPartyOutstanding(customer.id);
    expect(outstanding).toBe(118000);
  });

  it('blocks a cash-account credit that would take factory cash negative (BR-21)', async () => {
    await runInTenantContext(() =>
      sequelize.transaction(async (t) => {
        await expect(
          LedgerService.postJournal({
            factoryId: factoryA.id,
            entryDate: '2026-08-15',
            referenceType: 'Test',
            referenceId: '00000000-0000-0000-0000-000000000004',
            lines: [
              { accountKey: 'FACTORY_EXPENSE', debitPaise: 5000, creditPaise: 0 },
              { accountKey: 'CASH', debitPaise: 0, creditPaise: 5000 },
            ],
            transaction: t,
          })
        ).rejects.toThrow(/Insufficient cash/);
      })
    );
  });

  it('allows negative cash at a factory that explicitly permits it', async () => {
    await runInTenantContext(() =>
      sequelize.transaction(async (t) => {
        const entry = await LedgerService.postJournal({
          factoryId: factoryB.id,
          entryDate: '2026-08-15',
          referenceType: 'Test',
          referenceId: '00000000-0000-0000-0000-000000000005',
          lines: [
            { accountKey: 'FACTORY_EXPENSE', debitPaise: 5000, creditPaise: 0 },
            { accountKey: 'CASH', debitPaise: 0, creditPaise: 5000 },
          ],
          transaction: t,
        });
        expect(entry).toBeTruthy();
      })
    );
  });

  it('reverses a journal without touching the original (BR-05-style)', async () => {
    let entryId;
    await runInTenantContext(() =>
      sequelize.transaction(async (t) => {
        const entry = await LedgerService.postJournal({
          factoryId: factoryA.id,
          entryDate: '2026-08-16',
          referenceType: 'Test',
          referenceId: '00000000-0000-0000-0000-000000000006',
          lines: [
            { accountKey: 'ACCOUNTS_RECEIVABLE', partyId: customer.id, debitPaise: 5000, creditPaise: 0 },
            { accountKey: 'SALES_REVENUE', debitPaise: 0, creditPaise: 5000 },
          ],
          transaction: t,
        });
        entryId = entry.id;
      })
    );

    const outstandingBefore = await LedgerService.getPartyOutstanding(customer.id);

    await runInTenantContext(() =>
      sequelize.transaction((t) => LedgerService.reverseJournal(entryId, 'Correction', t))
    );

    const outstandingAfter = await LedgerService.getPartyOutstanding(customer.id);
    expect(outstandingAfter).toBe(outstandingBefore - 5000);
  });

  it('builds a running-balance cash book for a factory', async () => {
    await runInTenantContext(() =>
      sequelize.transaction(async (t) => {
        await LedgerService.postJournal({
          factoryId: factoryA.id,
          entryDate: '2026-08-17',
          referenceType: 'Test',
          referenceId: '00000000-0000-0000-0000-000000000007',
          narration: 'Cash sale',
          lines: [
            { accountKey: 'CASH', debitPaise: 20000, creditPaise: 0 },
            { accountKey: 'SALES_REVENUE', debitPaise: 0, creditPaise: 20000 },
          ],
          transaction: t,
        });
      })
    );

    // getCashBook now returns a full statement — opening balance, rows and a
    // closing balance — so `opening + in − out = closing` can be checked. It
    // used to return a bare array whose running balance always started at zero
    // regardless of the date window.
    const cashBook = await LedgerService.getCashBook(factoryA.id, {});
    expect(cashBook.rows.length).toBeGreaterThan(0);
    expect(cashBook.openingBalancePaise + cashBook.totalInPaise - cashBook.totalOutPaise).toBe(cashBook.closingBalancePaise);
    const last = cashBook.rows[cashBook.rows.length - 1];
    expect(last.runningBalancePaise).toBe(20000);
  });
});
