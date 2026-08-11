const { pool } = require('../config/db');

async function run() {
  try {
    console.log('Adding document_url to residents table...');
    await pool.query('ALTER TABLE residents ADD COLUMN document_url VARCHAR(255) DEFAULT NULL');
    console.log('✅ Column added successfully.');
    process.exit(0);
  } catch (err) {
    if (err.code === 'ER_DUP_COLUMN_NAME') {
      console.log('✅ Column already exists.');
      process.exit(0);
    } else {
      console.error('Error adding column:', err);
      process.exit(1);
    }
  }
}

run();
