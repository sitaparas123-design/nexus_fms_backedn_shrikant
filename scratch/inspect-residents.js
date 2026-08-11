const { pool } = require('../config/db');

async function inspect() {
  const [residents] = await pool.query('SELECT id, full_name, phone, email, address, document_url FROM residents');
  console.log('--- RESIDENTS ---');
  console.table(residents);
  process.exit(0);
}

inspect();
