const { pool } = require('../config/db');
const crypto = require('crypto');
const NotificationService = require('./notification.service');

const triggerAutoPhotoRequest = async (workOrderId) => {
  try {
    // 1. Fetch Work Order and resident info
    const [jobRows] = await pool.query(
      `SELECT w.id, w.resident_name, r.email as resident_email, r.phone as resident_phone 
       FROM work_orders w
       LEFT JOIN residents r ON w.resident_id = r.id
       WHERE w.id = ?`,
      [workOrderId]
    );

    if (jobRows.length === 0) return;
    const job = jobRows[0];

    // 3. Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // 4. Create quote request idempotently
    try {
      await pool.query(
        `INSERT IGNORE INTO quote_requests (work_order_id, secure_token, status, expires_at)
         VALUES (?, ?, 'PENDING', ?)`,
        [workOrderId, token, expiresAt]
      );
    } catch (dbErr) {
      if (dbErr.code !== 'ER_DUP_ENTRY') throw dbErr;
    }

    // Check if it was inserted or if it already existed
    const [existingQr] = await pool.query(
      'SELECT secure_token FROM quote_requests WHERE work_order_id = ? AND secure_token = ? LIMIT 1',
      [workOrderId, token]
    );

    if (existingQr.length === 0) {
      // It already existed with a different token, meaning another request generated it.
      return;
    }

    // 5. Send Notification
    const publicAppUrl = process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'http://localhost:5173';
    const uploadLink = `${publicAppUrl}/public/quote-request/${token}`;

    const dispatcher = require('./notification.service');
    
    if (job.resident_name) {
      await dispatcher.dispatch({
        recipientUserId: null, // Depending on if resident mapping to user exists, usually null for external tenant emails without user_id
        recipientRole: 'TENANT',
        type: 'QUOTE_PHOTO_REQUEST',
        title: 'Photos Required for Your Maintenance Quote',
        messageTemplate: `Hi {{resident_name}},\n\nWe require photos/details to prepare the quote for your maintenance request.\n\nPlease use the secure link below to upload the requested photos/details:\n{{uploadLink}}\n\nOnce submitted, the request will be reviewed by our team.`,
        structuredData: {
          resident_name: job.resident_name || 'Resident',
          uploadLink
        },
        actionUrl: uploadLink,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        channels: ['EMAIL', 'SMS'], // Tenant might not have IN_APP
        contactEmail: job.resident_email,
        contactPhone: job.resident_phone
      });
    }
    
    console.log(`[QuoteRequestService] Auto photo request generated for Job #${workOrderId}`);

  } catch (err) {
    console.error(`[QuoteRequestService] Error triggering auto photo request for Job #${workOrderId}:`, err);
  }
};

module.exports = {
  triggerAutoPhotoRequest
};
