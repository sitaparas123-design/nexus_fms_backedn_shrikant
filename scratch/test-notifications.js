const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');
const http = require('http');

const PORT = 5000;
const BASE_URL = `http://localhost:${PORT}/api/v1`;

function makeRequest(method, reqPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${reqPath}`);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let payload = null;
    if (body) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const options = { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

async function testNotifications() {
  console.log('=======================================================');
  console.log('🛡️  Running Notification System Integration & Security Tests');
  console.log('=======================================================');

  try {
    // 1. Get Tokens
    console.log('[Test 1] Login Admin & Staff...');
    const adminRes = await makeRequest('POST', '/auth/login', { email: 'admin@nexusfms.com', password: 'Password123!' });
    const staffRes = await makeRequest('POST', '/auth/login', { email: 'staff@nexusfms.com', password: 'Password123!' });
    
    const adminToken = adminRes.body.token;
    const staffToken = staffRes.body.token;
    const adminUser = adminRes.body.user;
    const staffUser = staffRes.body.user;

    console.log(`  Admin User ID: ${adminUser.id}, Staff User ID: ${staffUser.id}`);

    // 2. Create mock notification for Admin
    console.log('[Test 2] Persisting mock notification for Admin...');
    await notificationService.createNotification({
      recipientUserId: adminUser.id,
      type: 'NEW_QUOTE_REQUEST',
      title: 'Test Quote Request',
      message: 'Testing notifications workflow'
    });

    // 3. Fetch notifications as Admin
    console.log('[Test 3] Fetching notifications as Admin...');
    const getAdminNotifs = await makeRequest('GET', '/notifications', null, adminToken);
    if (getAdminNotifs.status !== 200 || getAdminNotifs.body.unreadCount < 1) {
      throw new Error(`Admin fetch failed: Status ${getAdminNotifs.status}, unreadCount=${getAdminNotifs.body.unreadCount}`);
    }
    console.log(`  ✅ Passed! Admin notifications fetched. Unread count: ${getAdminNotifs.body.unreadCount}`);

    const notif = getAdminNotifs.body.data.find(n => n.title === 'Test Quote Request');
    if (!notif) throw new Error('Test notification not found in Admin fetch.');

    // 4. Security Check: Staff attempting to mark Admin's notification as read (IDOR)
    console.log('[Test 4] IDOR Security Test: Staff attempting to read Admin notification...');
    const staffReadRes = await makeRequest('PUT', `/notifications/${notif.id}/read`, null, staffToken);
    if (staffReadRes.status !== 403) {
      throw new Error(`Security violation! Staff was able to read Admin's notification or got status ${staffReadRes.status}`);
    }
    console.log('  ✅ Passed! Staff attempt was rejected with 403 Forbidden.');

    // 5. Admin marks notification as read
    console.log('[Test 5] Admin marking notification as read...');
    const adminReadRes = await makeRequest('PUT', `/notifications/${notif.id}/read`, null, adminToken);
    if (adminReadRes.status !== 200) {
      throw new Error(`Admin failed to mark notification read: Status ${adminReadRes.status}`);
    }
    console.log('  ✅ Passed! Notification marked as read successfully.');

    // 6. Cleanup notification from database
    console.log('[Cleanup] Deleting test notification...');
    await pool.query('DELETE FROM notifications WHERE id = ?', [notif.id]);
    console.log('  ✅ Cleanup complete.');

    console.log('\n🎉 [ALL NOTIFICATION SYSTEM CHECKS PASSED]');
    process.exit(0);
  } catch (err) {
    console.error('❌ Notification test suite failed:', err.message);
    process.exit(1);
  }
}

testNotifications();
