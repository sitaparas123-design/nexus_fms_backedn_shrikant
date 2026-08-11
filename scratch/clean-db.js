const { pool } = require('../config/db');

async function clean() {
  try {
    console.log('🧹 Cleaning leftover audit records...');
    await pool.query("DELETE FROM users WHERE email IN ('staffA.audit@nexusfms.com', 'staffB.audit@nexusfms.com')");
    console.log('✅ Leftovers deleted.');
    process.exit(0);
  } catch (err) {
    console.error('Error cleaning db:', err);
    process.exit(1);
  }
}

clean();
