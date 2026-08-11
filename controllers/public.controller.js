const crypto = require('crypto');
const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');


// @desc    Get public request information by secure token (NO LOGIN REQUIRED)
// @route   GET /api/v1/public/request/:token
// @access  Public (No Auth Token Required)
const getPublicRequestByToken = async (req, res, next) => {
  try {
    const { token } = req.params;

    // 1. Check quote_requests table
    const [quoteRows] = await pool.query(
      `SELECT q.*, w.job_number, w.title, w.resident_name, w.property_address, w.description as job_desc
       FROM quote_requests q
       JOIN work_orders w ON q.work_order_id = w.id
       WHERE q.secure_token = ?`,
      [token]
    );

    if (quoteRows.length > 0) {
      const q = quoteRows[0];
      return res.status(200).json({
        success: true,
        type: 'QUOTE_UPLOAD',
        data: {
          requestId: q.id,
          workOrderId: q.work_order_id,
          jobNumber: q.job_number,
          title: q.title,
          residentName: q.resident_name,
          address: q.property_address,
          description: q.job_desc,
          status: q.status,
          expiresAt: q.expires_at,
          secureToken: q.secure_token,
        },
      });
    }

    // 2. Check booking_requests table
    const [bookingRows] = await pool.query(
      `SELECT b.*, w.job_number, w.title, w.resident_name, w.property_address, w.description as job_desc
       FROM booking_requests b
       JOIN work_orders w ON b.work_order_id = w.id
       WHERE b.secure_token = ?`,
      [token]
    );

    if (bookingRows.length > 0) {
      const b = bookingRows[0];
      return res.status(200).json({
        success: true,
        type: 'BOOKING',
        data: {
          requestId: b.id,
          workOrderId: b.work_order_id,
          jobNumber: b.job_number,
          title: b.title,
          residentName: b.resident_name,
          address: b.property_address,
          description: b.job_desc,
          selectedDate: b.booked_date,
          selectedTimeSlot: b.booked_time_slot,
          status: b.status,
          expiresAt: b.expires_at,
          secureToken: b.secure_token,
        },
      });
    }

    // 3. Fallback check work_orders table
    const [jobRows] = await pool.query(
      `SELECT w.* FROM work_orders w WHERE w.secure_token = ?`,
      [token]
    );

    if (jobRows.length > 0) {
      const j = jobRows[0];
      return res.status(200).json({
        success: true,
        type: 'GENERIC_PORTAL',
        data: {
          workOrderId: j.id,
          jobNumber: j.job_number,
          title: j.title,
          residentName: j.resident_name,
          address: j.property_address,
          description: j.description,
          stage: j.pipeline_stage,
          secureToken: j.secure_token,
        },
      });
    }

    res.status(404).json({
      success: false,
      message: 'Invalid or expired secure token link.',
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Submit Resident Photo/Video Uploads & Description (NO LOGIN REQUIRED)
// @route   POST /api/v1/public/quote-request/:token/upload
// @access  Public (No Auth Token Required)
const submitPublicQuoteUpload = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { token } = req.params;
    const { resident_notes, notes, residentComments, comments } = req.body;
    const userNotes = (resident_notes || notes || residentComments || comments || '').trim();
    const noteText = userNotes || 'Resident uploaded photos/videos for review.';


    // Verify secure token in quote_requests or work_orders
    const [quoteRows] = await connection.query(
      `SELECT q.id as request_id, q.work_order_id, q.status 
       FROM quote_requests q WHERE q.secure_token = ?`,
      [token]
    );

    let workOrderId = null;
    let requestId = null;

    if (quoteRows.length > 0) {
      workOrderId = quoteRows[0].work_order_id;
      requestId = quoteRows[0].request_id || quoteRows[0].id;
    } else {
      const [jobRows] = await connection.query(
        'SELECT id FROM work_orders WHERE secure_token = ?',
        [token]
      );
      if (jobRows.length > 0) {
        workOrderId = jobRows[0].id;
        const [existQr] = await connection.query('SELECT id FROM quote_requests WHERE work_order_id = ?', [workOrderId]);
        if (existQr.length > 0) {
          requestId = existQr[0].id;
        } else {
          const [insQr] = await connection.query(
            'INSERT INTO quote_requests (work_order_id, secure_token, status) VALUES (?, ?, ?)',
            [workOrderId, token, 'PENDING']
          );
          requestId = insQr.insertId;
        }
      }
    }


    if (!workOrderId) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired quote request token.',
      });
    }

    const files = req.files || [];
    if (files.length === 0 && !userNotes) {
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Please upload at least one photo/video or provide a description.',
      });
    }

    await connection.beginTransaction();

    const savedMediaList = [];

    // Save uploaded media files into customer_media_uploads
    for (const file of files) {
      const mediaType = file.mimetype.startsWith('video') ? 'VIDEO' : 'PHOTO';
      const fileUrl = `/uploads/${file.filename}`;

      const [mediaRes] = await connection.query(
        `INSERT INTO customer_media_uploads 
          (work_order_id, quote_request_id, media_type, file_path, file_name, file_size_bytes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [workOrderId, requestId, mediaType, fileUrl, file.originalname, file.size]
      );

      savedMediaList.push({
        id: mediaRes.insertId,
        mediaType,
        filePath: fileUrl,
        fileName: file.originalname,
      });
    }

    // Update quote_requests status & report
    if (requestId) {
      await connection.query(
        'UPDATE quote_requests SET status = ?, resident_description_report = ?, submitted_at = NOW() WHERE id = ?',
        ['SUBMITTED', userNotes || null, requestId]
      );
    }

    // Update work order description with resident upload notes (remains in 'Quotes' stage until Admin sends Quote)
    await connection.query(
      `UPDATE work_orders SET 
        pipeline_stage = 'Quotes',
        description = CASE 
          WHEN description IS NULL OR description = '' THEN ? 
          ELSE CONCAT(description, '\n\n[Resident Upload Notes]: ', ?) 
        END
       WHERE id = ?`,
      [noteText, noteText, workOrderId]

    );

    const [admins] = await connection.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
    const [woRows] = await connection.query("SELECT title, resident_name, property_address FROM work_orders WHERE id = ?", [workOrderId]);
    const jobTitle = woRows[0]?.title || 'Repair Job';
    const resName = woRows[0]?.resident_name || 'Resident';
    const resAddress = woRows[0]?.property_address || 'Property';

    for (const admin of admins) {
      await notificationService.createNotification({
        recipientUserId: admin.id,
        type: 'QUOTE_PHOTOS_SUBMITTED',
        title: 'Resident submitted repair photos',
        message: `Photos uploaded for ${jobTitle} by ${resName} at ${resAddress}`,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        actionUrl: `/admin/quote-requests`
      }, connection);
    }

    await connection.commit();
    connection.release();

    res.status(200).json({
      success: true,
      message: 'Photo/Video report submitted successfully.',
      data: {
        workOrderId,
        filesUploaded: savedMediaList.length,
        media: savedMediaList,
      },
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
};

const { calculateStaffAvailableSlots } = require('../services/availability.service');

// @desc    Submit Resident Slot Booking Confirmation (NO LOGIN REQUIRED)
// @route   POST /api/v1/public/booking/:token/confirm
// @access  Public (No Auth Token Required)
const submitPublicBooking = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { token } = req.params;
    const { booking_date, selectedDate, time_slot, selectedTimeSlot } = req.body;

    const dateVal = (booking_date || selectedDate || '').trim();
    const slotVal = (time_slot || selectedTimeSlot || '').trim();

    if (!dateVal || !slotVal) {
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Booking Date and Time Slot are required.',
      });
    }

    await connection.beginTransaction();

    // Verify token & lock work order row
    const [bookingRows] = await connection.query(
      `SELECT b.id as request_id, b.work_order_id, w.assigned_staff_id, w.duration_hours 
       FROM booking_requests b
       JOIN work_orders w ON b.work_order_id = w.id
       WHERE b.secure_token = ? FOR UPDATE`,
      [token]
    );

    let workOrderId = null;
    let requestId = null;
    let assignedStaffId = null;
    let durationHours = 1.5;

    if (bookingRows.length > 0) {
      workOrderId = bookingRows[0].work_order_id;
      requestId = bookingRows[0].request_id;
      assignedStaffId = bookingRows[0].assigned_staff_id;
      durationHours = parseFloat(bookingRows[0].duration_hours || 1.5);
    } else {
      const [jobRows] = await connection.query(
        'SELECT id, assigned_staff_id, duration_hours FROM work_orders WHERE secure_token = ? FOR UPDATE',
        [token]
      );
      if (jobRows.length > 0) {
        workOrderId = jobRows[0].id;
        assignedStaffId = jobRows[0].assigned_staff_id;
        durationHours = parseFloat(jobRows[0].duration_hours || 1.5);
      }
    }

    if (!workOrderId) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired booking token.',
      });
    }

    // Validate Slot Availability & Overlapping Booking Prevention
    if (assignedStaffId) {
      const availabilityResult = await calculateStaffAvailableSlots(assignedStaffId, dateVal, durationHours, connection);
      const isSlotValid = availabilityResult.availableSlots.some(s => s.timeSlot === slotVal || s.startTime === slotVal);

      if (!isSlotValid) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({
          success: false,
          message: `Booking Rejected: Slot '${slotVal}' on ${dateVal} is no longer available (Outside shift, during break, or already booked).`,
        });
      }
    }

    if (requestId) {
      await connection.query(
        'UPDATE booking_requests SET booked_date = ?, booked_time_slot = ?, status = ?, booked_at = NOW() WHERE id = ?',
        [dateVal, slotVal, 'CONFIRMED', requestId]
      );
    }

    // Update work_orders scheduled date/time and move stage to 'Jobs'
    await connection.query(
      `UPDATE work_orders SET 
        scheduled_date = ?,
        scheduled_time_slot = ?,
        pipeline_stage = 'Jobs'
       WHERE id = ?`,
      [dateVal, slotVal, workOrderId]
    );

    const [woRows] = await connection.query("SELECT title, resident_name, property_address, assigned_staff_id FROM work_orders WHERE id = ?", [workOrderId]);
    const jobTitle = woRows[0]?.title || 'Repair Job';
    const resName = woRows[0]?.resident_name || 'Resident';
    const resAddress = woRows[0]?.property_address || 'Property';
    const targetStaffId = woRows[0]?.assigned_staff_id;

    // 1. Notify Admins
    const [admins] = await connection.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
    for (const admin of admins) {
      await notificationService.createNotification({
        recipientUserId: admin.id,
        type: 'BOOKING_CONFIRMED',
        title: 'New booking confirmed',
        message: `${jobTitle} booked on ${dateVal} at ${slotVal} for ${resName}`,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        actionUrl: `/admin/calendar`
      }, connection);
    }

    // 2. Notify assigned technician if present
    if (targetStaffId) {
      const [spUser] = await connection.query('SELECT user_id FROM staff_profiles WHERE id = ?', [targetStaffId]);
      if (spUser.length > 0) {
        await notificationService.createNotification({
          recipientUserId: spUser[0].user_id,
          type: 'BOOKING_CONFIRMED',
          title: 'Resident booking confirmed',
          message: `Booking confirmed for ${jobTitle} on ${dateVal} at ${slotVal}`,
          relatedEntityType: 'work_orders',
          relatedEntityId: workOrderId,
          actionUrl: `/maintenance/my-tasks`
        }, connection);
      }
    }

    await connection.commit();
    connection.release();

    res.status(200).json({
      success: true,
      message: 'Booking slot confirmed successfully.',
      data: {
        workOrderId,
        scheduledDate: dateVal,
        scheduledTimeSlot: slotVal,
        stage: 'Jobs',
      },
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
};

// @desc    Generate Cryptographic Public Secure Link (Office Admin Only)
// @route   POST /api/v1/jobs/:id/generate-link
// @access  Private (Office Admin & Staff)
const generatePublicRequestLink = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type } = req.body; // 'QUOTE_UPLOAD' or 'BOOKING'

    const [jobs] = await pool.query('SELECT id, job_number, resident_name FROM work_orders WHERE id = ?', [id]);
    if (jobs.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const secureToken = `tok_${crypto.randomBytes(32).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days expiration

    const linkType = type === 'BOOKING' ? 'BOOKING' : 'QUOTE_UPLOAD';

    if (linkType === 'QUOTE_UPLOAD') {
      await pool.query(
        `INSERT INTO quote_requests (work_order_id, secure_token, status, expires_at) 
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE secure_token = ?, status = ?, expires_at = ?`,
        [id, secureToken, 'PENDING', expiresAt, secureToken, 'PENDING', expiresAt]
      );
    } else {
      await pool.query(
        `INSERT INTO booking_requests (work_order_id, secure_token, status, expires_at) 
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE secure_token = ?, status = ?, expires_at = ?`,
        [id, secureToken, 'PENDING', expiresAt, secureToken, 'PENDING', expiresAt]
      );
    }

    if (linkType === 'BOOKING') {
      const [admins] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      const residentName = jobs[0].resident_name || 'Resident';
      for (const admin of admins) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          type: 'BOOKING_LINK_SENT',
          title: 'Booking link sent — waiting for resident',
          message: `Booking link sent to ${residentName} for Job #${jobs[0].job_number}`,
          relatedEntityType: 'work_orders',
          relatedEntityId: id,
          actionUrl: `/admin/booking-links`
        });
      }
    }

    const linkUrl = `/public/${linkType.toLowerCase().replace('_', '-')}/${secureToken}`;

    res.status(201).json({
      success: true,
      message: 'Public secure link generated successfully.',
      data: {
        workOrderId: id,
        type: linkType,
        secureToken,
        expiresAt,
        linkUrl,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getPublicRequestByToken,
  submitPublicQuoteUpload,
  submitPublicBooking,
  generatePublicRequestLink,
};
