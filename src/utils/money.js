// All monetary values in this system are stored and computed as integer paise
// (BR-17: no floating-point arithmetic on money, anywhere). These helpers are the
// only place rupee<->paise conversion and display formatting should happen.

const toPaise = (rupees) => {
  if (rupees === null || rupees === undefined || rupees === '') return 0;
  const value = Number(rupees);
  if (!Number.isFinite(value)) {
    throw new TypeError(`Cannot convert "${rupees}" to paise: not a finite number`);
  }
  return Math.round(value * 100);
};

const fromPaise = (paise) => {
  const value = Number(paise) || 0;
  return value / 100;
};

const formatINR = (paise) => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(fromPaise(paise));
};

const addPaise = (...amounts) => amounts.reduce((sum, a) => sum + (Number(a) || 0), 0);

module.exports = { toPaise, fromPaise, formatINR, addPaise };
