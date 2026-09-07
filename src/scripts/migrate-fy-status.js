const { sequelize } = require('../config/database');

async function migrate() {
  try {
    await sequelize.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_financial_years_status') THEN 
          CREATE TYPE enum_financial_years_status AS ENUM('PLANNED', 'ACTIVE', 'SOFT_CLOSED', 'CLOSED'); 
        END IF; 
      END $$;
    `);

    await sequelize.query(`
      ALTER TABLE financial_years ADD COLUMN IF NOT EXISTS status enum_financial_years_status DEFAULT 'PLANNED';
    `);

    await sequelize.query(`
      UPDATE financial_years SET status = 'ACTIVE' WHERE "isCurrent" = true;
    `);

    await sequelize.query(`
      UPDATE financial_years SET status = 'CLOSED' WHERE "isCurrent" = false AND (status IS NULL OR status = 'PLANNED');
    `);

    console.log('✅ financial_years status column synchronized successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

migrate();
