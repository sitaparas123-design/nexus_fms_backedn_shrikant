const { pool } = require('../config/db.js');

async function createSettingsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        settings_json JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
    `);
    
    const [rows] = await pool.query('SELECT COUNT(*) as count FROM system_settings');
    if (rows[0].count === 0) {
      const defaultSettings = {
        companyName: 'Nexus FMS Ltd.',
        tagline: 'Facility Management System • nexusfms.com',
        supportPhone: '0121 769 1767',
        supportEmail: 'Info@nexusfms.com',
        businessHoursStart: '08:00',
        businessHoursEnd: '18:00',
        defaultDuration: '1.5',
        autoExpiryDays: '7',
        smsEnabled: true,
        emailEnabled: true,
        autoAssignStaff: false,
        requirePhotoUpload: true,
        reminderHoursBefore: '24',
      };
      await pool.query('INSERT INTO system_settings (settings_json) VALUES (?)', [JSON.stringify(defaultSettings)]);
    }
    
    console.log('system_settings table created and seeded successfully.');
  } catch (err) {
    console.error('Error creating system_settings table:', err);
  } finally {
    process.exit(0);
  }
}

createSettingsTable();
