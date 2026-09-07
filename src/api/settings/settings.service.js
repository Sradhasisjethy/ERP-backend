const { TenantSettings } = require('./settings.model');
const { NotFoundError } = require('../../core/AppError');

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

  static async upsert(key, value, category) {
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
