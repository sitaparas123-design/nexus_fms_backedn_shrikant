const { pool } = require('../config/db');
const { calculateStaffAvailableSlots, timeToMinutes } = require('../services/availability.service');
const notificationService = require('../services/notification.service');

// Helper to resolve staff profile ID from logged in user ID
const getStaffProfileId = async (userId) => {
  const [rows] = await pool.query('SELECT id FROM staff_profiles WHERE user_id = ?', [userId]);
  return rows.length > 0 ? rows[0].id : null;
};

// Helper to format raw database row to Frontend job object
const formatJobRow = (r) => ({
  id: r.id,
  jobNumber: r.job_number,
  section: r.pipeline_stage,
  title: r.title,
  tenantId: r.resident_id || null,
  tenantName: r.live_resident_name || r.resident_name,
  contactPhone: r.live_contact_phone || r.contact_phone,
  contactEmail: r.live_contact_email || r.contact_email || '',
  address: r.live_property_address || r.property_address,
  description: r.description || '',
  durationHours: parseFloat(r.duration_hours || 1.5),
  assignedStaffId: r.assigned_staff_id || null,
  assignedStaffCode: r.staff_code || (r.assigned_staff_id ? `STF-${100 + r.assigned_staff_id}` : null),
  assignedStaffName: r.staff_name || null,
  assignedStaffColor: r.staff_color || '#009bf2',
  quoteAmount: r.quote_amount ? parseFloat(r.quote_amount) : null,
  scheduledDate: r.scheduled_date ? String(r.scheduled_date).substring(0, 10) : null,
  scheduledTimeSlot: r.scheduled_time_slot || null,
  secureToken: r.secure_token,
  createdAt: r.created_at ? String(r.created_at).substring(0, 10) : null,
});

// @desc    Get calendar grid dispatches & dynamic staff list
// @route   GET /api/v1/calendar
// @access  Private (Office Admin & Maintenance Staff)
const getCalendar = async (req, res, next) => {
  try {
    const { start, end, staffId } = req.query;
    const staffProfileId = await getStaffProfileId(req.user.id);

    // 1. Fetch Dynamic Staff List from MySQL (No hardcoding)
    const [staffRows] = await pool.query(
      `SELECT 
        sp.id as profile_id,
        sp.staff_code,
        sp.role_title,
        sp.color_hex,
        sp.working_days_json,
        sp.work_start_time,
        sp.work_end_time,
        sp.break_start_time,
        sp.break_end_time,
        u.full_name as name,
        u.email
       FROM staff_profiles sp
       JOIN users u ON sp.user_id = u.id
       ORDER BY sp.created_at ASC`
    );

    const staffList = staffRows.map(s => ({
      id: s.profile_id,
      staffCode: s.staff_code,
      name: s.name,
      email: s.email,
      role: s.role_title,
      color: s.color_hex,
      workingDays: s.working_days_json || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      workingHours: {
        start: s.work_start_time ? String(s.work_start_time).substring(0, 5) : '08:00',
        end: s.work_end_time ? String(s.work_end_time).substring(0, 5) : '17:00',
      },
      breakTime: {
        start: s.break_start_time ? String(s.break_start_time).substring(0, 5) : '12:00',
        end: s.break_end_time ? String(s.break_end_time).substring(0, 5) : '13:00',
      },
    }));

    // 2. Strict Authorization Check for Maintenance Staff
    if (req.user.role === 'MAINTENANCE_STAFF') {
      if (staffId) {
        const cleanRequestedStaffId = parseInt(String(staffId).replace(/^(stf-|usr-)/, ''), 10);
        if (cleanRequestedStaffId !== staffProfileId) {
          return res.status(403).json({
            success: false,
            message: 'Forbidden. Maintenance Staff can only view their own calendar schedule.',
          });
        }
      }
    }

    // 3. Build Work Orders Query
    let sql = `
      SELECT 
        w.*,
        r.full_name as live_resident_name,
        r.phone as live_contact_phone,
        r.email as live_contact_email,
        r.address as live_property_address,
        u.full_name as staff_name,
        sp.color_hex as staff_color,
        sp.staff_code
      FROM work_orders w
      LEFT JOIN residents r ON w.resident_id = r.id
      LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
      LEFT JOIN users u ON sp.user_id = u.id
      WHERE w.scheduled_date IS NOT NULL
    `;

    const queryParams = [];

    // Filter by Staff ID
    if (req.user.role === 'MAINTENANCE_STAFF') {
      sql += ' AND w.assigned_staff_id = ?';
      queryParams.push(staffProfileId);
    } else if (staffId && staffId !== 'ALL') {
      const cleanId = parseInt(String(staffId).replace(/^(stf-|usr-)/, ''), 10);
      sql += ' AND w.assigned_staff_id = ?';
      queryParams.push(cleanId);
    }

    // Filter by Date Range
    if (start && start.trim() !== '') {
      sql += ' AND w.scheduled_date >= ?';
      queryParams.push(start.trim());
    }
    if (end && end.trim() !== '') {
      sql += ' AND w.scheduled_date <= ?';
      queryParams.push(end.trim());
    }

    sql += ' ORDER BY w.scheduled_date ASC, w.scheduled_time_slot ASC';

    const [jobRows] = await pool.query(sql, queryParams);
    const calendarJobs = jobRows.map(formatJobRow);

    res.status(200).json({
      success: true,
      staffCount: staffList.length,
      staff: staffList,
      count: calendarJobs.length,
      data: calendarJobs,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get Public Booking Available Slots by Secure Token (TOKEN-SCOPED)
// @route   GET /api/v1/public/booking/:token/available-slots
// @access  Public (No Auth Token Required)
const getPublicBookingAvailableSlots = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Target date query parameter (?date=YYYY-MM-DD) is required.',
      });
    }

    // 1. Resolve Work Order & Assigned Technician from Token
    const [bookingRows] = await pool.query(
      `SELECT b.id as request_id, b.work_order_id, w.assigned_staff_id, w.duration_hours, w.title, w.resident_name
       FROM booking_requests b
       JOIN work_orders w ON b.work_order_id = w.id
       WHERE b.secure_token = ?`,
      [token]
    );

    let workOrderId = null;
    let staffProfileId = null;
    let durationHours = 1.5;

    if (bookingRows.length > 0) {
      workOrderId = bookingRows[0].work_order_id;
      staffProfileId = bookingRows[0].assigned_staff_id;
      durationHours = parseFloat(bookingRows[0].duration_hours || 1.5);
    } else {
      const [jobRows] = await pool.query(
        'SELECT id, assigned_staff_id, duration_hours FROM work_orders WHERE secure_token = ?',
        [token]
      );
      if (jobRows.length > 0) {
        workOrderId = jobRows[0].id;
        staffProfileId = jobRows[0].assigned_staff_id;
        durationHours = parseFloat(jobRows[0].duration_hours || 1.5);
      }
    }

    if (!workOrderId) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired secure booking token.',
      });
    }

    if (!staffProfileId) {
      return res.status(400).json({
        success: false,
        message: 'No technician is currently assigned to this work order. Please contact Office Admin.',
      });
    }

    // 2. Calculate Available Slots for the Assigned/Eligible Technician
    const availabilityResult = await calculateStaffAvailableSlots(staffProfileId, date, durationHours);

    res.status(200).json({
      success: true,
      workOrderId,
      durationHours,
      availability: availabilityResult,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Dispatch / Reschedule Work Order on Technician Calendar (WITH DOUBLE-BOOKING LOCK)
// @route   POST /api/v1/calendar/dispatch
// @access  Private (Office Admin & Staff)
const dispatchJob = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const {
      workOrderId, id, jobId, work_order_id,
      assignedStaffId, staffId, assigned_staff_id,
      scheduledDate, date, scheduled_date,
      scheduledTimeSlot, timeSlot, time_slot, scheduled_time_slot,
      durationHours, duration_hours
    } = req.body;

    const targetJobId = workOrderId || id || jobId || work_order_id;
    let targetStaffId = assignedStaffId || staffId || assigned_staff_id;
    const targetDate = String(scheduledDate || date || scheduled_date || '').trim();
    const targetSlot = String(scheduledTimeSlot || timeSlot || time_slot || scheduled_time_slot || '').trim();


    if (!targetJobId || !targetDate || !targetSlot) {
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Work Order ID, Scheduled Date, and Scheduled Time Slot are required.',
      });
    }

    if (targetStaffId && typeof targetStaffId === 'string') {
      targetStaffId = parseInt(targetStaffId.replace(/^(stf-|usr-)/, ''), 10);
    }

    await connection.beginTransaction();

    // 1. Lock Target Work Order Row (SELECT ... FOR UPDATE)
    const [jobRows] = await connection.query(
      'SELECT id, assigned_staff_id, duration_hours FROM work_orders WHERE id = ? FOR UPDATE',
      [targetJobId]
    );

    if (jobRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${targetJobId}`,
      });
    }

    const job = jobRows[0];
    const finalStaffId = targetStaffId || job.assigned_staff_id;
    const finalDuration = durationHours ? parseFloat(durationHours) : parseFloat(job.duration_hours || 1.5);

    if (!finalStaffId) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Assigned Technician ID is required for calendar dispatch.',
      });
    }

    // 2. Validate Slot Availability & Overlap Protection
    const availabilityResult = await calculateStaffAvailableSlots(finalStaffId, targetDate, finalDuration, connection);

    if (!availabilityResult.success) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: `Booking Rejected: ${availabilityResult.reason}`,
      });
    }

    // Check if targetSlot exists in calculated valid slots
    const isSlotValid = availabilityResult.availableSlots.some(s => s.timeSlot === targetSlot || s.startTime === targetSlot);

    if (!isSlotValid) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: `Booking Rejected: Slot '${targetSlot}' is unavailable for technician ID ${finalStaffId} on ${targetDate} (Outside shift, during break, or overlapping existing job).`,
      });
    }

    // 3. Commit Dispatch / Booking Update
    await connection.query(
      `UPDATE work_orders SET 
        assigned_staff_id = ?,
        scheduled_date = ?,
        scheduled_time_slot = ?,
        pipeline_stage = 'Jobs'
       WHERE id = ?`,
      [finalStaffId, targetDate, targetSlot, targetJobId]
    );

    await connection.commit();
    connection.release();

    const [updatedRows] = await pool.query(
      `SELECT 
        w.*,
        r.full_name as live_resident_name,
        r.phone as live_contact_phone,
        r.email as live_contact_email,
        r.address as live_property_address,
        u.full_name as staff_name,
        sp.color_hex as staff_color,
        sp.staff_code
       FROM work_orders w
       LEFT JOIN residents r ON w.resident_id = r.id
       LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
       LEFT JOIN users u ON sp.user_id = u.id
       WHERE w.id = ?`,
      [targetJobId]
    );

    // Create Notification for the assigned staff
    try {
      const [staffUserRows] = await pool.query(
        "SELECT user_id FROM staff_profiles WHERE id = ?",
        [finalStaffId]
      );
      
      if (staffUserRows.length > 0) {
        await notificationService.createNotification({
          recipientUserId: staffUserRows[0].user_id,
          type: 'TASK_ASSIGNED',
          title: 'New Task Assigned',
          message: `You have been assigned to Work Order #${targetJobId} on ${targetDate} at ${targetSlot}.`,
          relatedEntityType: 'work_orders',
          relatedEntityId: parseInt(targetJobId, 10),
          actionUrl: '/admin/calendar'
        });
      }
    } catch (notifErr) {
      console.error('[Notification] Failed to notify on job dispatch:', notifErr);
    }

    res.status(200).json({
      success: true,
      message: `Work order ID ${targetJobId} dispatched successfully for ${targetDate} (${targetSlot}).`,
      data: formatJobRow(updatedRows[0]),
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
};

module.exports = {
  getCalendar,
  getPublicBookingAvailableSlots,
  dispatchJob,
};
