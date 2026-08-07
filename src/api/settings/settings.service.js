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

  static async delete(key) {
    const setting = await this.getByKey(key);
    await setting.destroy();
    return true;
  }
}

module.exports = { SettingsService };
