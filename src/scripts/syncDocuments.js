const { sequelize } = require('../config/database');
require('../models/index');

async function run() {
  try {
    const { EmployeeDocument } = require('../api/users/employeeDocument.model');
    await EmployeeDocument.sync({ alter: true });
    console.log('EmployeeDocument table synced successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Error syncing:', err);
    process.exit(1);
  }
}

run();
