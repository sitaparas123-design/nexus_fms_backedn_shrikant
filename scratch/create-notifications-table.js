const { pool } = require('../config/db');

async function createNotificationsTable() {
  try {
    console.log('🚀 Creating notifications table and indexes in MySQL...');
    
    // Create notifications table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`notifications\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\` BIGINT NOT NULL,
        \`notification_type\` VARCHAR(50) NOT NULL,
        \`title\` VARCHAR(255) NOT NULL,
        \`message\` TEXT NOT NULL,
        \`related_entity_type\` VARCHAR(50) DEFAULT NULL,
        \`related_entity_id\` BIGINT DEFAULT NULL,
        \`action_url\` VARCHAR(255) DEFAULT NULL,
        \`is_read\` TINYINT(1) NOT NULL DEFAULT 0,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`read_at\` TIMESTAMP NULL DEFAULT NULL,
        CONSTRAINT \`fk_notifications_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    
    console.log('✅ Notifications table created successfully.');

    // Add indexes (silently ignore if they already exist)
    const indexes = [
      { name: 'idx_notifications_user_id', cols: '(\`user_id\`)' },
      { name: 'idx_notifications_user_unread', cols: '(\`user_id\`, \`is_read\`)' },
      { name: 'idx_notifications_created_at', cols: '(\`created_at\`)' },
      { name: 'idx_notifications_type', cols: '(\`notification_type\`)' },
      { name: 'idx_notifications_entity', cols: '(\`related_entity_type\`, \`related_entity_id\`)' }
    ];

    for (const idx of indexes) {
      try {
        await pool.query(`CREATE INDEX \`${idx.name}\` ON \`notifications\` ${idx.cols};`);
        console.log(`✅ Index ${idx.name} added successfully.`);
      } catch (err) {
        if (err.code === 'ER_DUP_KEYNAME') {
          console.log(`ℹ️ Index ${idx.name} already exists.`);
        } else {
          throw err;
        }
      }
    }
    
    console.log('🎉 Database migration complete.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to run migration:', err);
    process.exit(1);
  }
}

createNotificationsTable();
