const { pool } = require('../config/db');

async function inspect() {
  const [users] = await pool.query('SELECT id, email, role, full_name FROM users');
  const [profiles] = await pool.query('SELECT * FROM staff_profiles');
  console.log('--- USERS ---');
  console.table(users);
  console.log('--- PROFILES ---');
  console.table(profiles);
  process.exit(0);
}

inspect();
