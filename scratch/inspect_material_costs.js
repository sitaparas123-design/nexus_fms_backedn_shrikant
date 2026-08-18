const path = require('path');
const { pool } = require(path.join(process.cwd(), 'config/db'));

(async () => {
  try {
    const [users] = await pool.query("SELECT id, role, email FROM users WHERE email LIKE '%staff%' OR email LIKE '%tech%'");
    console.log("Users:", users);

    const [profiles] = await pool.query("SELECT id, user_id FROM staff_profiles");
    console.log("Profiles:", profiles);
  } catch (err) {
    console.error("Error inspecting database:", err);
  } finally {
    process.exit(0);
  }
})();
