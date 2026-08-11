const crypto = require('crypto');
const { pool } = require('../config/db');

// @desc    Get all booking requests/links
// @route   GET /api/v1/booking-links
// @access  Private (JWT Required)
const getBookingRequests = async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        b.id,
        b.secure_token as secureToken,
        b.assignment_preference_staff_id as assignmentPreference,
        b.earliest_date as earliestDate,
        b.internal_notes as internalNotes,
        b.status,
        b.expires_at as expiresAt,
        b.booked_date as bookedDate,
        b.booked_time_slot as bookedTimeSlot,
        b.booked_at as bookedAt,
        b.created_at as createdAt,
        w.resident_name as tenantName,
        w.property_address as address,
        w.description as description,
        w.resident_id as tenantId,
        w.duration_hours as durationHours
      FROM booking_requests b
      JOIN work_orders w ON b.work_order_id = w.id
      ORDER BY b.created_at DESC
    `);

    res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
};

// @desc    Generate a new booking request/link
// @route   POST /api/v1/booking-links
// @access  Private (JWT Required)
const generateBookingLink = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const {
      tenantId,
      description,
      durationHours,
      assignmentPreference,
      earliestDate,
      internalNotes,
      linkExpiryDays
    } = req.body;

    if (!tenantId || !description) {
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: tenantId and description are required.'
      });
    }

    // 1. Fetch resident details
    const [resRows] = await connection.query('SELECT * FROM residents WHERE id = ?', [tenantId]);
    if (resRows.length === 0) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: `Resident not found with ID ${tenantId}`
      });
    }
    const resident = resRows[0];

    // 2. Generate unique job number & secure token
    const randomNumber = Math.floor(1000 + Math.random() * 9000);
    const jobNumber = `JOB-2026-${randomNumber}`;
    const secureToken = `tok_${crypto.randomBytes(16).toString('hex')}`;
    const expiryDays = parseInt(linkExpiryDays || '7', 10);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    let staffPrefId = null;
    if (assignmentPreference && assignmentPreference !== 'ANY') {
      staffPrefId = parseInt(String(assignmentPreference).replace('stf-', ''), 10);
      if (isNaN(staffPrefId)) staffPrefId = null;
    }

    await connection.beginTransaction();

    // 3. Create work order
    const [jobResult] = await connection.query(
      `INSERT INTO work_orders (
        job_number, title, resident_id, resident_name, contact_phone, contact_email,
        property_address, description, duration_hours, pipeline_stage,
        assigned_staff_id, secure_token, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobNumber,
        description,
        resident.id,
        resident.full_name,
        resident.phone,
        resident.email,
        resident.address,
        description,
        parseFloat(durationHours || 1.5),
        'Jobs Waiting Booking',
        staffPrefId,
        secureToken,
        req.user.id
      ]
    );

    const workOrderId = jobResult.insertId;

    // 4. Create booking request
    const [bookingResult] = await connection.query(
      `INSERT INTO booking_requests (
        work_order_id, secure_token, assignment_preference_staff_id, earliest_date, internal_notes, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        workOrderId,
        secureToken,
        staffPrefId,
        earliestDate || null,
        internalNotes || '',
        'WAITING_FOR_BOOKING',
        expiresAt
      ]
    );

    await connection.commit();
    connection.release();

    const referer = req.get('referer') || 'http://localhost:5173/';
    let frontendOrigin = 'http://localhost:5173';
    try {
      frontendOrigin = new URL(referer).origin;
    } catch (e) {
      // ignore
    }

    const publicUrl = `${frontendOrigin}/booking/${secureToken}`;
    const tenantName = resident.full_name;
    const address = resident.address;

    const bookingReqObj = {
      id: bookingResult.insertId,
      secureToken,
      tenantId: resident.id,
      tenantName,
      address,
      description,
      durationHours: parseFloat(durationHours || 1.5),
      assignmentPreference: assignmentPreference || 'ANY',
      earliestDate: earliestDate || null,
      internalNotes: internalNotes || '',
      expiresAt: expiresAt.toISOString().split('T')[0],
      status: 'WAITING_FOR_BOOKING',
      createdAt: new Date().toISOString().split('T')[0]
    };

    const smsMessage = `Hi ${tenantName}, please select a convenient time for your maintenance request "${description}" here: ${publicUrl}`;
    const emailMessage = `Dear ${tenantName},\n\nTo schedule your maintenance visit at ${address}, please select a convenient time slot using the link below:\n\nJob: ${description}\nDuration: ${durationHours} hours\n\nBooking Link:\n${publicUrl}\n\nThank you,\nAP Maintenance Team`;

    res.status(201).json({
      success: true,
      bookingRequest: bookingReqObj,
      publicUrl,
      smsMessage,
      emailMessage
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
};

module.exports = {
  getBookingRequests,
  generateBookingLink
};
