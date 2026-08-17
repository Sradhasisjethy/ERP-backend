const { ValidationError } = require('../../core/AppError');

/**
 * GST state codes, used to decide intra- vs inter-state supply.
 * Names are matched case- and punctuation-insensitively so that data entered
 * as "Odisha", "ODISHA" or "Orissa" all resolve to 21.
 */
const STATE_CODES = Object.freeze({
  'jammu and kashmir': '01', 'himachal pradesh': '02', punjab: '03', chandigarh: '04',
  uttarakhand: '05', 'uttaranchal': '05', haryana: '06', delhi: '07', 'nct of delhi': '07',
  rajasthan: '08', 'uttar pradesh': '09', bihar: '10', sikkim: '11',
  'arunachal pradesh': '12', nagaland: '13', manipur: '14', mizoram: '15',
  tripura: '16', meghalaya: '17', assam: '18', 'west bengal': '19', jharkhand: '20',
  odisha: '21', orissa: '21', chhattisgarh: '22', chattisgarh: '22',
  'madhya pradesh': '23', gujarat: '24', 'dadra and nagar haveli and daman and diu': '26',
  maharashtra: '27', karnataka: '29', goa: '30', lakshadweep: '31', kerala: '32',
  'tamil nadu': '33', puducherry: '34', pondicherry: '34',
  'andaman and nicobar islands': '35', telangana: '36', 'andhra pradesh': '37',
  ladakh: '38', 'other territory': '97',
});

const normalise = (name) => String(name || '').trim().toLowerCase().replace(/[.\-_]/g, ' ').replace(/\s+/g, ' ');

/** Resolves a state name to its GST code; returns null when unknown. */
const stateCodeFor = (state) => {
  if (!state) return null;
  const raw = String(state).trim();
  // Already a two-digit code.
  if (/^\d{2}$/.test(raw)) return raw;
  return STATE_CODES[normalise(raw)] || null;
};

/**
 * The first two characters of a GSTIN are the state code, so a supplied GSTIN
 * is the most authoritative source of place of supply when present.
 */
const stateCodeFromGstin = (gstin) => {
  if (!gstin || typeof gstin !== 'string') return null;
  const prefix = gstin.trim().slice(0, 2);
  return /^\d{2}$/.test(prefix) ? prefix : null;
};

/**
 * FR-M16-4 / AC-9.1 — determines which tax heads apply.
 *
 * Supplier state comes from the factory (its own GSTIN/state, falling back to
 * the company's). Place of supply comes from the SHIPPING address, because GST
 * follows where the goods go, not where the customer is registered.
 *
 * Never hard-coded to a particular state: both sides are resolved from data.
 */
const determineTax = ({ factory, shippingAddress, customer }) => {
  const supplierCode =
    stateCodeFromGstin(factory?.gstin) || stateCodeFor(factory?.stateCode) || stateCodeFor(factory?.state);

  const placeOfSupplyCode =
    stateCodeFor(shippingAddress?.stateCode) ||
    stateCodeFromGstin(shippingAddress?.gstin) ||
    stateCodeFor(shippingAddress?.state) ||
    stateCodeFromGstin(customer?.gstin) ||
    stateCodeFor(customer?.state);

  if (!supplierCode) {
    throw new ValidationError(
      'This factory has no state (or GSTIN) configured, so GST cannot be determined — set it under Factories.'
    );
  }
  if (!placeOfSupplyCode) {
    throw new ValidationError(
      'No place of supply could be determined — set a state on the customer’s shipping address.'
    );
  }

  const isInterState = supplierCode !== placeOfSupplyCode;
  return {
    supplierStateCode: supplierCode,
    placeOfSupplyCode,
    isInterState,
    heads: isInterState ? ['IGST'] : ['CGST', 'SGST'],
  };
};

/**
 * Splits a tax amount across the applicable heads.
 * The CGST/SGST halves are split so they always re-add to the original — the
 * remainder goes to SGST rather than rounding both halves independently, which
 * would lose a paisa on odd amounts and stop the invoice footing exactly.
 */
const splitTax = (taxPaise, isInterState) => {
  const total = Math.round(Number(taxPaise) || 0);
  if (isInterState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: total };
  const half = Math.round(total / 2);
  return { cgstPaise: half, sgstPaise: total - half, igstPaise: 0 };
};

module.exports = { determineTax, splitTax, stateCodeFor, stateCodeFromGstin, STATE_CODES };
