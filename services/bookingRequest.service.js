const { pool } = require('../config/db');
const crypto = require('crypto');
const NotificationService = require('./notification.service');

const triggerAutoBookingRequest = async (workOrderId) => {
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
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days expiry

    // 4. Create or reset booking request with fresh secure token
    await pool.query(
      `INSERT INTO booking_requests (work_order_id, secure_token, status, expires_at, booked_date, booked_time_slot, booked_at)
       VALUES (?, ?, 'WAITING_FOR_BOOKING', ?, NULL, NULL, NULL)
       ON DUPLICATE KEY UPDATE 
         secure_token = COALESCE(booking_requests.secure_token, VALUES(secure_token)),
         status = 'WAITING_FOR_BOOKING',
         expires_at = VALUES(expires_at),
         booked_date = NULL,
         booked_time_slot = NULL,
         booked_at = NULL,
         reminder_count = 0,
         last_reminder_at = NULL`,
      [workOrderId, token, expiresAt]
    );

    // 5. Send Notification
    const publicAppUrl = process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'http://localhost:5173';
    const bookingLink = `${publicAppUrl}/public/book-appointment/${token}`;

    const dispatcher = require('./notification.service');
    
    if (job.resident_name) {
      await dispatcher.dispatch({
        recipientUserId: null,
        recipientRole: 'TENANT',
        type: 'BOOKING_REQUEST',
        title: 'Please Book Your Maintenance Appointment',
        messageTemplate: `Hi {{resident_name}},\n\nPlease book an appointment for your maintenance job using the secure link below:\n{{bookingLink}}\n\nOur team will review your selected appointment.`,
        structuredData: {
          resident_name: job.resident_name || 'Resident',
          bookingLink
        },
        actionUrl: bookingLink,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        channels: ['EMAIL', 'SMS'],
        contactEmail: job.resident_email,
        contactPhone: job.resident_phone
      });
    }
    
    console.log(`[BookingRequestService] Auto booking request generated for Job #${workOrderId}`);

  } catch (err) {
    console.error(`[BookingRequestService] Error triggering auto booking request for Job #${workOrderId}:`, err);
  }
};

module.exports = {
  triggerAutoBookingRequest
};
