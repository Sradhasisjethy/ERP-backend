const { TenantSettings } = require('./settings.model');
const { NotFoundError, ConflictError, ValidationError } = require('../../core/AppError');

/**
 * Checks for the settings something downstream hands straight to Intl.
 *
 * `value` is free JSONB, and a locale of 'en_IN' made Intl.NumberFormat throw
 * on every report export for the tenant (export/format.js now falls back too,
 * but a value that can never work should be refused when it is typed, not
 * ignored later). Keys are matched as format.js reads them, `reports.` prefix
 * included. Only strings are accepted for these keys — that is what the
 * settings screen sends.
 */
const isValidTimeZone = (value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const VALUE_CHECKS = {
  locale: {
    ok: (v) => {
      if (v.length > 35) return false;
      try {
        return Intl.getCanonicalLocales(v).length === 1;
      } catch {
        return false;
      }
    },
    message: 'locale must be a BCP 47 language tag such as en-IN',
  },
  currency: {
    ok: (v) => {
      if (!/^[A-Z]{3}$/.test(v)) return false;
      try {
        new Intl.NumberFormat('en', { style: 'currency', currency: v });
        return true;
      } catch {
        return false;
      }
    },
    message: 'currency must be a three-letter ISO 4217 code such as INR',
  },
  timezone: {
    ok: (v) => v.length <= 64 && isValidTimeZone(v),
    message: 'timezone must be an IANA time zone such as Asia/Kolkata',
  },
};
VALUE_CHECKS['reports.locale'] = VALUE_CHECKS.locale;
VALUE_CHECKS['reports.currency'] = VALUE_CHECKS.currency;

const assertValidValue = (key, value) => {
  const check = VALUE_CHECKS[key];
  if (!check) return;
  if (typeof value !== 'string' || !check.ok(value)) throw new ValidationError(check.message);
};

class SettingsService {
  static async list(category) {
    const where = category ? { category } : {};
    return TenantSettings.findAll({ where });
  }

  static async getByKey(key) {
    const setting = await TenantSettings.findOne({ where: { key } });
    if (!setting) throw new NotFoundError('Setting not found');
    return setting;
  }

  /**
   * Creates a setting that does not exist yet. POST used to upsert, so
   * SETTINGS_CREATE alone could overwrite any existing setting — including the
   * navigation menu served to every user at sign-in, which the UI only lets
   * SETTINGS_MODIFY change. Changing an existing key is PUT's job.
   */
  static async create(key, value, category) {
    assertValidValue(key, value);
    const [setting, created] = await TenantSettings.findOrCreate({
      where: { key },
      defaults: { key, value, category: category || 'general' },
    });
    if (!created) throw new ConflictError(`Setting "${key}" already exists — update it instead`);
    return setting;
  }

  static async upsert(key, value, category) {
    assertValidValue(key, value);
    const [setting, created] = await TenantSettings.findOrCreate({
      where: { key },
      defaults: { key, value, category: category || 'general' },
    });

    if (!created) {
      setting.value = value;
      if (category) setting.category = category;
      await setting.save();
    }

    return setting;
  }

  /**
   * The Settings > General display preferences, with defaults, in one call.
   *
   * Printed documents need these and must never fail to print because a tenant
   * has not visited the settings screen, so a missing row is a default rather
   * than an error. Values are stored as JSONB, so a plain string arrives as a
   * string and anything else is ignored rather than trusted.
   */
  static async getDisplayPreferences() {
    const rows = await TenantSettings.findAll({ where: { key: ['dateFormat', 'timezone'] } });
    const value = (key) => {
      const row = rows.find((r) => r.key === key);
      return typeof row?.value === 'string' ? row.value : undefined;
    };
    return { dateFormat: value('dateFormat'), timeZone: value('timezone') };
  }

  static async delete(key) {
    const setting = await this.getByKey(key);
    await setting.destroy();
    return true;
  }
}

module.exports = { SettingsService };
