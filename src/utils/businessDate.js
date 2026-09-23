const { env } = require('../config/env');
const { isoDateInZone } = require('./dateDisplay');
const { ValidationError } = require('../core/AppError');

/**
 * "Today" where the business is, not where the server is (BR: APP_TIMEZONE).
 * A plant in Odisha closing its books at 11pm must not be told it is tomorrow
 * because the server runs in UTC.
 */
const todayLocal = () => isoDateInZone(new Date(), env.APP_TIMEZONE);

/**
 * Refuses a date that has not happened yet.
 *
 * Posting into the future is a mistyped year, not an intention: a depreciation
 * run "up to 2036" would charge ten years of depreciation in one go, and a
 * voucher dated next month sits invisible in every statement until it arrives.
 * Used by the modules where a wrong date silently moves money.
 */
const assertNotFuture = (date, what) => {
  const day = String(date).slice(0, 10);
  const today = todayLocal();
  if (day > today) {
    throw new ValidationError(`${what} cannot be in the future — today is ${today}`);
  }
  return day;
};

module.exports = { todayLocal, assertNotFuture };
