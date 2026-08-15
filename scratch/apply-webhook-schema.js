const { pool } = require('../config/db');

async function run() {
  try {
    console.log('Adding external_reference_id to work_orders...');
    const [cols] = await pool.query(`SHOW COLUMNS FROM work_orders LIKE 'external_reference_id'`);
    if (cols.length === 0) {
      await pool.query(`ALTER TABLE work_orders ADD COLUMN external_reference_id VARCHAR(100) UNIQUE DEFAULT NULL AFTER secure_token`);
      console.log('✅ Added external_reference_id to work_orders');
    } else {
      console.log('⚡ external_reference_id already exists');
    }

    console.log('Creating work_order_attachments table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`work_order_attachments\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`work_order_id\` BIGINT NOT NULL,
        \`file_name\` VARCHAR(255) NOT NULL,
        \`file_path\` VARCHAR(500) NOT NULL,
        \`file_size_bytes\` BIGINT DEFAULT NULL,
        \`mime_type\` VARCHAR(100) DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`fk_wo_attachments_wo\` FOREIGN KEY (\`work_order_id\`) REFERENCES \`work_orders\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ work_order_attachments table created/verified');

    console.log('Done!');
  } catch (e) {
    console.error('Error applying schema changes:', e);
  } finally {
    process.exit(0);
  }
}

run();
