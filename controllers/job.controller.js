const crypto = require('crypto');
const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');
const QuoteRequestService = require('../services/quoteRequest.service');
const BookingRequestService = require('../services/bookingRequest.service');


// Helper to format any date input to strict YYYY-MM-DD
const formatDateToISO = (d) => {
  if (!d) return null;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const dateObj = new Date(d);
  if (isNaN(dateObj.getTime())) {
    const match = String(d).match(/(\d{4})-(\d{2})-(\d{2})/);
    return match ? match[0] : null;
  }
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Helper to format raw database row to Frontend job object
const formatJobRow = (r, role) => {
  const assignedStaffIds = r.assigned_staff_ids 
    ? (typeof r.assigned_staff_ids === 'string' ? JSON.parse(r.assigned_staff_ids) : r.assigned_staff_ids) 
    : (r.assigned_staff_id ? [r.assigned_staff_id] : []);

  const job = {
    id: r.id,
    jobNumber: r.job_number,
    section: r.pipeline_stage, // Maps to 5 Kanban stages
    title: r.title,
    tenantId: r.resident_id || null,
    tenantName: r.live_resident_name || r.resident_name,
    contactPhone: r.live_contact_phone || r.contact_phone,
    contactEmail: r.live_contact_email || r.contact_email || '',
    address: r.live_property_address || r.property_address,
    description: r.description || '',
    durationHours: parseFloat(r.duration_hours || 1.5),
    assignedStaffId: r.assigned_staff_id || null,
    assignedStaffIds: assignedStaffIds,
    assignedStaffNames: r.assigned_staff_names ? (typeof r.assigned_staff_names === 'string' ? JSON.parse(r.assigned_staff_names) : r.assigned_staff_names) : (r.staff_name ? [r.staff_name] : []),
    priority: r.priority || 'NORMAL',
    latitude: r.latitude || null,
    longitude: r.longitude || null,
    assignedStaffCode: r.staff_code || (r.assigned_staff_id ? `STF-${100 + r.assigned_staff_id}` : null),
    assignedStaffName: r.staff_name || null,
    assignedStaffColor: r.staff_color || '#009bf2',
    managerName: r.manager_name || null,
    quoteAmount: r.quote_amount ? parseFloat(r.quote_amount) : null,
    scheduledDate: formatDateToISO(r.scheduled_date),
    scheduledTimeSlot: r.scheduled_time_slot || null,
    secureToken: r.secure_token,
    createdAt: formatDateToISO(r.created_at),
    bookingStatus: r.booking_status || null,
    
    // Cancellation Properties
    cancellationType: r.cancellation_type || null,
    cancellationReason: r.cancellation_reason || null,
    cancelledBy: r.cancelled_by || null,
    cancellerName: r.canceller_name || null,
    cancelledAt: r.cancelled_at || null,
    previousAppointmentDate: formatDateToISO(r.previous_appointment_date),
    previousAppointmentTime: r.previous_appointment_time || null,
  };

  // Financials
  const quoteAmount = r.quote_amount ? parseFloat(r.quote_amount) : 0;
  const totalMaterialCost = r.total_material_cost ? parseFloat(r.total_material_cost) : 0;
  
  job.quoteAmount = quoteAmount;
  job.totalMaterialCost = totalMaterialCost;
  job.revenue = quoteAmount;
  job.totalJobCost = totalMaterialCost;
  job.profit = job.revenue - job.totalJobCost;
  job.profitMargin = job.revenue > 0 ? ((job.profit / job.revenue) * 100).toFixed(2) + '%' : '0%';

  if (role === 'OFFICE_TEAM') {
    delete job.quoteAmount;
    delete job.totalMaterialCost;
    delete job.revenue;
    delete job.totalJobCost;
    delete job.profit;
    delete job.profitMargin;
  }

  if (role === 'MAINTENANCE_STAFF') {
    delete job.quoteAmount;
    // They CAN see totalMaterialCost (as they entered it), but not revenue/profit
    delete job.revenue;
    delete job.totalJobCost;
    delete job.profit;
    delete job.profitMargin;
  }
  
  return job;
};

// @desc    Get all work orders / jobs (supports section, search, and staff filters)
// @route   GET /api/v1/jobs
// @access  Private (JWT Required)
const getJobs = async (req, res, next) => {
  try {
    const { section, search, staffId } = req.query;

    let sql = `
      SELECT 
        w.*,
        (SELECT SUM(total_cost) FROM job_material_costs jmc WHERE jmc.work_order_id = w.id) AS total_material_cost,
        r.full_name as live_resident_name,
        r.phone as live_contact_phone,
        r.email as live_contact_email,
        r.address as live_property_address,
        u.full_name as staff_name,
        sp.color_hex as staff_color,
        b.status as booking_status,
        u_cancel.full_name as canceller_name
      FROM work_orders w
      LEFT JOIN residents r ON w.resident_id = r.id
      LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
      LEFT JOIN users u ON sp.user_id = u.id
      LEFT JOIN booking_requests b ON w.id = b.work_order_id
      LEFT JOIN users u_cancel ON w.cancelled_by = u_cancel.id
      WHERE 1=1
    `;

    const queryParams = [];

    if (section && section.trim() !== '') {
      sql += ' AND w.pipeline_stage = ?';
      queryParams.push(section.trim());
    }

    // Role-based data isolation
    if (req.user && req.user.role === 'OFFICE_TEAM') {
      sql += " AND w.pipeline_stage IN ('Jobs', 'Jobs Waiting Booking')";
    } else if (req.user && req.user.role === 'MAINTENANCE_STAFF') {
      if (req.user.staffProfileId) {
        sql += ' AND (w.assigned_staff_id = ? OR (w.assigned_staff_ids IS NOT NULL AND JSON_CONTAINS(w.assigned_staff_ids, CAST(? AS JSON), "$")))';
        queryParams.push(req.user.staffProfileId, req.user.staffProfileId);
      } else {
        // If they have no profile yet, they shouldn't see any jobs
        sql += ' AND w.assigned_staff_id = -1';
      }
    } else if (staffId && staffId.trim() !== '' && staffId !== 'ALL') {
      const cleanStaffId = parseInt(staffId.replace(/^(stf-|usr-)/, ''), 10);
      sql += ' AND (w.assigned_staff_id = ? OR (w.assigned_staff_ids IS NOT NULL AND JSON_CONTAINS(w.assigned_staff_ids, CAST(? AS JSON), "$")))';
      queryParams.push(cleanStaffId, cleanStaffId);
    }

    if (search && search.trim() !== '') {
      const term = `%${search.trim()}%`;
      sql += ' AND (w.title LIKE ? OR w.resident_name LIKE ? OR r.full_name LIKE ? OR w.contact_phone LIKE ? OR w.property_address LIKE ? OR w.job_number LIKE ?)';
      queryParams.push(term, term, term, term, term, term);
    }

    sql += ' ORDER BY w.created_at DESC';

    const [rows] = await pool.query(sql, queryParams);

    const jobIds = rows.map(r => r.id);
    let mediaByJob = {};
    let reportByJob = {};
    if (jobIds.length > 0) {
      try {
        const [[mediaRows], [reportRows]] = await Promise.all([
          pool.query(
            'SELECT id, work_order_id, file_name, file_path, file_size_bytes, mime_type, media_type, created_at FROM staff_completion_media WHERE work_order_id IN (?)',
            [jobIds]
          ),
          pool.query(
            'SELECT id, work_order_id, staff_id, work_report_summary, materials_used, completion_status, completed_at FROM staff_job_completions WHERE work_order_id IN (?)',
            [jobIds]
          )
        ]);
        mediaRows.forEach(m => {
          if (!mediaByJob[m.work_order_id]) mediaByJob[m.work_order_id] = [];
          mediaByJob[m.work_order_id].push({
            id: m.id,
            fileName: m.file_name,
            filePath: m.file_path,
            fileSize: m.file_size_bytes,
            mimeType: m.mime_type,
            mediaType: m.media_type,
            uploadedAt: m.created_at,
          });
        });

        reportRows.forEach(r => {
          reportByJob[r.work_order_id] = {
            id: r.id,
            workReportSummary: r.work_report_summary,
            materialsUsed: r.materials_used,
            completionStatus: r.completion_status,
            completedAt: r.completed_at,
          };
        });
      } catch (err) {
        console.warn('[job.controller] Error fetching completion media:', err.message);
      }
    }

    const jobs = rows.map(r => {
      const formatted = formatJobRow(r, req.user ? req.user.role : null);
      formatted.completionPhotos = mediaByJob[r.id] || [];
      formatted.completionReport = reportByJob[r.id] || null;
      return formatted;
    });

    res.status(200).json({
      success: true,
      count: jobs.length,
      data: jobs,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get single work order by ID
// @route   GET /api/v1/jobs/:id
// @access  Private (JWT Required)
const getJobById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      `SELECT 
        w.*,
        (SELECT SUM(total_cost) FROM job_material_costs jmc WHERE jmc.work_order_id = w.id) AS total_material_cost,
        r.full_name as live_resident_name,
        r.phone as live_contact_phone,
        r.email as live_contact_email,
        r.address as live_property_address,
        u.full_name as staff_name,
        sp.color_hex as staff_color,
        u_cancel.full_name as canceller_name
      FROM work_orders w
      LEFT JOIN residents r ON w.resident_id = r.id
      LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
      LEFT JOIN users u ON sp.user_id = u.id
      LEFT JOIN users u_cancel ON w.cancelled_by = u_cancel.id
      WHERE w.id = ? OR w.job_number = ? OR w.secure_token = ?`,
      [id, id, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with identifier '${id}'`,
      });
    }

    // OFFICE_TEAM: can only access booking-relevant stages
    if (req.user && req.user.role === 'OFFICE_TEAM') {
      const allowedStages = ['Jobs', 'Jobs Waiting Booking'];
      if (!allowedStages.includes(rows[0].pipeline_stage)) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden. Office Team can only access booking-stage jobs.',
        });
      }
    }

    let completionPhotos = [];
    let completionReport = null;
    try {
      const [[mediaRows], [reportRows]] = await Promise.all([
        pool.query(
          'SELECT id, work_order_id, file_name, file_path, file_size_bytes, mime_type, media_type, created_at FROM staff_completion_media WHERE work_order_id = ?',
          [rows[0].id]
        ),
        pool.query(
          'SELECT id, work_order_id, staff_id, work_report_summary, materials_used, completion_status, completed_at FROM staff_job_completions WHERE work_order_id = ?',
          [rows[0].id]
        )
      ]);

      completionPhotos = mediaRows.map(m => ({
        id: m.id,
        fileName: m.file_name,
        filePath: m.file_path,
        fileSize: m.file_size_bytes,
        mimeType: m.mime_type,
        mediaType: m.media_type,
        uploadedAt: m.created_at,
      }));

      if (reportRows.length > 0) {
        completionReport = {
          id: reportRows[0].id,
          workReportSummary: reportRows[0].work_report_summary,
          materialsUsed: reportRows[0].materials_used,
          completionStatus: reportRows[0].completion_status,
          completedAt: reportRows[0].completed_at,
        };
      }
    } catch (e) {
      console.warn('[job.controller] Error fetching completion media for single job:', e.message);
    }

    const formatted = formatJobRow(rows[0], req.user ? req.user.role : null);
    formatted.completionPhotos = completionPhotos;
    formatted.completionReport = completionReport;

    res.status(200).json({
      success: true,
      data: formatted,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Create new work order (Contact Search / Auto-fill or Manual Resident Entry)
// @route   POST /api/v1/jobs
// @access  Private (Office Admin & Staff)
const createJob = async (req, res, next) => {
  try {
    const {
      title,
      resident_id, tenantId,
      resident_name, tenantName,
      contact_phone, phone, contactPhone,
      contact_email, email, contactEmail,
      property_address, address,
      description,
      duration_hours, durationHours,
      assigned_staff_id, assignedStaffId,
      manager_name, managerName,
      quote_amount, quoteAmount,
      section, pipeline_stage,
      scheduled_date, scheduledDate,
      scheduled_time_slot, scheduledTimeSlot,
      priority,
      assigned_staff_ids, assignedStaffIds,
    } = req.body;

    let resId = resident_id || tenantId || null;
    let resName = (resident_name || tenantName || '').trim();
    let resPhone = (contact_phone || phone || contactPhone || '').trim();
    let resAddress = (property_address || address || '').trim();
    let resEmail = (contact_email || email || contactEmail || '').trim() || null;

    // 1. If resident_id is passed, fetch real resident details from residents table
    if (resId) {
      const cleanResId = String(resId).replace(/^(ten-|res-)/, '');
      const [resRows] = await pool.query('SELECT * FROM residents WHERE id = ?', [cleanResId]);
      if (resRows.length > 0) {
        const resObj = resRows[0];
        resId = resObj.id;
        resName = resObj.full_name;
        resPhone = resObj.phone;
        resAddress = resObj.address;
        if (resObj.email) resEmail = resObj.email;
      }
    }

    // 2. If resident_id is NOT passed, auto-link or create resident record in residents table
    if (!resId && resName && resPhone && resAddress) {
      const [existingRes] = await pool.query('SELECT id FROM residents WHERE phone = ? OR full_name = ?', [resPhone, resName]);
      if (existingRes.length > 0) {
        resId = existingRes[0].id;
      } else {
        const [newResResult] = await pool.query(
          'INSERT INTO residents (full_name, phone, email, address) VALUES (?, ?, ?, ?)',
          [resName, resPhone, resEmail, resAddress]
        );
        resId = newResResult.insertId;
      }
    }

    const jobTitle = (title || '').trim();
    const jobDesc = (description || '').trim() || null;
    const hours = parseFloat(duration_hours || durationHours || 1.5);
    const stage = pipeline_stage || section || 'Quotes';
    const mgrName = (manager_name || managerName || req.user.full_name || 'Office Admin').trim();
    const quoteVal = quote_amount || quoteAmount ? parseFloat(quote_amount || quoteAmount) : null;
    const schedDate = scheduled_date || scheduledDate || null;
    const schedSlot = scheduled_time_slot || scheduledTimeSlot || null;
    const jobPriority = priority || 'NORMAL';
    const staffIdsArr = assigned_staff_ids || assignedStaffIds || [];
    const staffIdsJson = staffIdsArr.length > 0 ? JSON.stringify(staffIdsArr) : null;

    // Generate mock coordinates near London for demo
    const mockLat = 51.5074 + (Math.random() - 0.5) * 0.1;
    const mockLng = -0.1278 + (Math.random() - 0.5) * 0.1;

    // Contact & Title Validation Enforcement
    if (!jobTitle) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Work order title is required.',
      });
    }

    if (!resName) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Resident Name is required.',
      });
    }

    if (!resPhone) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Contact Phone Number is required.',
      });
    }

    if (!resAddress) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Property Address is required.',
      });
    }

    // Clean & resolve Staff Profile ID (supports profile_id or user_id)
    let rawStaffId = assigned_staff_id || assignedStaffId || (staffIdsArr.length > 0 ? staffIdsArr[0] : null);
    if (rawStaffId) {
      const cleanId = String(rawStaffId).replace(/^(stf-|usr-)/, '');
      const [spRows] = await pool.query(
        'SELECT id FROM staff_profiles WHERE id = ? OR user_id = ?',
        [cleanId, cleanId]
      );
      if (spRows.length > 0) {
        rawStaffId = spRows[0].id;
      } else {
        const [uRows] = await pool.query('SELECT id FROM users WHERE id = ? AND role = "MAINTENANCE_STAFF"', [cleanId]);
        if (uRows.length > 0) {
          const [insRes] = await pool.query(
            'INSERT INTO staff_profiles (user_id, staff_code, role_title, color_hex) VALUES (?, ?, ?, ?)',
            [uRows[0].id, `STF-${100 + Number(uRows[0].id)}`, 'Maintenance Specialist', '#009bf2']
          );
          rawStaffId = insRes.insertId;
        } else {
          rawStaffId = null;
        }
      }
    }


    // Generate unique job number & cryptographically strong 32-byte secure token
    const randomNumber = Math.floor(1000 + Math.random() * 9000);
    const jobNumber = `JOB-2026-${randomNumber}`;
    const secureToken = `tok_${crypto.randomBytes(32).toString('hex')}`;

    const actualMgrEmail = (req.body.actual_manager_email || req.body.manager_email || req.user.email || null);

    const [result] = await pool.query(
      `INSERT INTO work_orders (
        job_number, title, resident_id, resident_name, contact_phone, contact_email,
        property_address, description, duration_hours, pipeline_stage,
        assigned_staff_id, assigned_staff_ids, priority, latitude, longitude,
        manager_name, quote_amount, scheduled_date,
        scheduled_time_slot, secure_token, created_by, manager_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobNumber, jobTitle, resId, resName, resPhone, resEmail,
        resAddress, jobDesc, hours, stage,
        rawStaffId, staffIdsJson, jobPriority, mockLat, mockLng,
        mgrName, quoteVal, schedDate,
        schedSlot, secureToken, req.user.id, actualMgrEmail
      ]
    );

    const [newJobRows] = await pool.query(
      `SELECT 
        w.*,
        (SELECT SUM(total_cost) FROM job_material_costs jmc WHERE jmc.work_order_id = w.id) AS total_material_cost,
        r.full_name as live_resident_name,
        r.phone as live_contact_phone,
        r.email as live_contact_email,
        r.address as live_property_address,
        u.full_name as staff_name,
        sp.color_hex as staff_color
       FROM work_orders w
       LEFT JOIN residents r ON w.resident_id = r.id
       LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
       LEFT JOIN users u ON sp.user_id = u.id
       WHERE w.id = ?`,
      [result.insertId]
    );

    // Notification Triggers
    if (stage === 'Quotes') {
      QuoteRequestService.triggerAutoPhotoRequest(result.insertId);
      
      const [admins] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      for (const admin of admins) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          type: 'NEW_QUOTE_REQUEST',
          title: 'New repair request received',
          message: `${jobTitle} for ${resName} at ${resAddress}`,
          relatedEntityType: 'work_orders',
          relatedEntityId: result.insertId,
          actionUrl: `/admin/pipeline?stage=Quotes`
        });
      }
    }

    if (stage === 'Jobs') {
      BookingRequestService.triggerAutoBookingRequest(result.insertId);
    }

    if (rawStaffId) {
      const [spUser] = await pool.query('SELECT user_id FROM staff_profiles WHERE id = ?', [rawStaffId]);
      if (spUser.length > 0) {
        await notificationService.createNotification({
          recipientUserId: spUser[0].user_id,
          type: 'TASK_ASSIGNED',
          title: 'New task assigned',
          message: `Assigned to ${jobTitle} at ${resAddress}`,
          relatedEntityType: 'work_orders',
          relatedEntityId: result.insertId,
          actionUrl: `/maintenance/my-tasks`
        });
      }
    }

    // Create Notification for new job
    try {
      const [adminRows] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      for (const admin of adminRows) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          type: 'NEW_JOB',
          title: 'New Maintenance Job Created',
          message: `Job #${jobNumber} (${jobTitle}) has been created in ${stage}.`,
          relatedEntityType: 'work_orders',
          relatedEntityId: result.insertId,
          actionUrl: '/admin/pipeline'
        });
      }
    } catch (notifErr) {
      console.error('[Notification] Failed to notify on job creation:', notifErr);
    }

    res.status(201).json({
      success: true,
      message: 'Work order created successfully.',
      data: formatJobRow(newJobRows[0], req.user ? req.user.role : null),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Update work order pipeline stage (Drag & Drop Kanban movement)
// @route   PUT /api/v1/jobs/:id/stage
// @access  Private (Office Admin & Staff)
const moveJobStage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { section, pipeline_stage } = req.body;
    const newStage = pipeline_stage || section;

    const allowedStages = ['Quotes', 'Completed Quotes', 'Jobs', 'Completed Jobs', 'Jobs Waiting Booking'];
    if (!newStage || !allowedStages.includes(newStage)) {
      return res.status(400).json({
        success: false,
        message: `Invalid stage. Must be one of: ${allowedStages.join(', ')}`,
      });
    }

    const [existing] = await pool.query('SELECT id, assigned_staff_id, pipeline_stage FROM work_orders WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    // Maintenance Staff Ownership Check: Staff can ONLY move jobs assigned to them
    if (req.user.role === 'MAINTENANCE_STAFF') {
      const [userStaffProfile] = await pool.query('SELECT id FROM staff_profiles WHERE user_id = ?', [req.user.id]);
      const currentStaffProfileId = userStaffProfile.length > 0 ? userStaffProfile[0].id : null;

      if (!currentStaffProfileId || existing[0].assigned_staff_id !== currentStaffProfileId) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden. Maintenance Staff can only move work orders assigned to them.',
        });
      }
    }

    await pool.query('UPDATE work_orders SET pipeline_stage = ? WHERE id = ?', [newStage, id]);

    if (newStage === 'Quotes' && existing[0].pipeline_stage !== 'Quotes') {
      QuoteRequestService.triggerAutoPhotoRequest(id);
    }

    if (newStage === 'Jobs' && existing[0].pipeline_stage !== 'Jobs') {
      BookingRequestService.triggerAutoBookingRequest(id);
    }

    const [updatedRows] = await pool.query(
      `SELECT 
        w.*,
        (SELECT SUM(total_cost) FROM job_material_costs jmc WHERE jmc.work_order_id = w.id) AS total_material_cost,
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
      [id]
    );

    // Create Notification for Pipeline Update
    try {
      const [adminRows] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      for (const admin of adminRows) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          type: 'PIPELINE_UPDATE',
          title: 'Pipeline Stage Updated',
          message: `Work Order #${id} moved to "${newStage}".`,
          relatedEntityType: 'work_orders',
          relatedEntityId: parseInt(id, 10),
          actionUrl: '/admin/pipeline'
        });
      }
    } catch (notifErr) {
      console.error('[Notification] Failed to notify on pipeline update:', notifErr);
    }

    res.status(200).json({
      success: true,
      message: `Work order moved to stage '${newStage}'.`,
      data: formatJobRow(updatedRows[0], req.user ? req.user.role : null),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Update work order status, quote amount, or assigned staff
// @route   PUT /api/v1/jobs/:id/status
// @access  Private (Office Admin & Staff)
const updateJobStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      pipeline_stage, section,
      assigned_staff_id, assignedStaffId,
      assigned_staff_ids, assignedStaffIds,
      quote_amount, quoteAmount,
      scheduled_date, scheduledDate,
      scheduled_time_slot, scheduledTimeSlot,
      title, description, duration_hours, durationHours,
      property_address, address, priority,
      resident_id, residentId, resident_name, tenantName,
      contact_phone, contactPhone, contact_email, contactEmail,
    } = req.body;

    const [existing] = await pool.query(
      'SELECT id, title, property_address, pipeline_stage, assigned_staff_id, assigned_staff_ids, scheduled_date, scheduled_time_slot FROM work_orders WHERE id = ?',
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    let staffIdsArr = assigned_staff_ids || assignedStaffIds;
    let staffIdsJson = undefined;
    if (staffIdsArr !== undefined) {
      if (Array.isArray(staffIdsArr)) {
        staffIdsJson = staffIdsArr.length > 0 ? JSON.stringify(staffIdsArr) : null;
      }
    }

    let rawStaffId = assigned_staff_id || assignedStaffId;
    if (rawStaffId && typeof rawStaffId === 'string') {
      rawStaffId = rawStaffId.replace(/^(stf-|usr-)/, '');
    }

    // Sync rawStaffId with first element in staffIdsArr if rawStaffId is not passed
    if (rawStaffId === undefined && staffIdsArr !== undefined) {
      rawStaffId = staffIdsArr.length > 0 ? staffIdsArr[0] : null;
    }

    // Strict Role-Based Field Filtering
    // Only OFFICE_ADMIN can update quote amount
    let quoteVal = quote_amount || quoteAmount;
    if (req.user.role !== 'OFFICE_ADMIN') {
      quoteVal = undefined; // Strip it out for OFFICE_TEAM and MAINTENANCE_STAFF
    }

    // Maintenance Staff Ownership Check: Staff can ONLY update jobs assigned to them
    if (req.user.role === 'MAINTENANCE_STAFF') {
      const [userStaffProfile] = await pool.query('SELECT id FROM staff_profiles WHERE user_id = ?', [req.user.id]);
      const currentStaffProfileId = userStaffProfile.length > 0 ? userStaffProfile[0].id : null;

      // Check both primary assigned_staff_id and the multi-select assigned_staff_ids JSON array
      let isOwner = (existing[0].assigned_staff_id === currentStaffProfileId);
      if (!isOwner && existing[0].assigned_staff_ids) {
        const multiIds = typeof existing[0].assigned_staff_ids === 'string'
          ? JSON.parse(existing[0].assigned_staff_ids)
          : existing[0].assigned_staff_ids;
        if (Array.isArray(multiIds) && multiIds.includes(currentStaffProfileId)) {
          isOwner = true;
        }
      }

      if (!currentStaffProfileId || !isOwner) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden. Maintenance Staff can only update work orders assigned to them.',
        });
      }

      // Staff cannot reassign jobs to another technician
      if (rawStaffId && rawStaffId != currentStaffProfileId) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden. Maintenance Staff cannot reassign work orders to another technician.',
        });
      }
    }

    const newStage = pipeline_stage || section;
    const schedDate = scheduled_date !== undefined ? scheduled_date : scheduledDate;
    const schedSlot = scheduled_time_slot !== undefined ? scheduled_time_slot : scheduledTimeSlot;

    const updates = [];
    const values = [];

    if (newStage !== undefined) {
      updates.push('pipeline_stage = ?');
      values.push(newStage);
    }
    if (rawStaffId !== undefined) {
      updates.push('assigned_staff_id = ?');
      values.push(rawStaffId);
    }
    if (staffIdsJson !== undefined) {
      updates.push('assigned_staff_ids = ?');
      values.push(staffIdsJson);
    }
    if (quoteVal !== undefined) {
      updates.push('quote_amount = ?');
      values.push(quoteVal);
    }
    if (schedDate !== undefined) {
      updates.push('scheduled_date = ?');
      values.push(schedDate);
    }
    if (schedSlot !== undefined) {
      updates.push('scheduled_time_slot = ?');
      values.push(schedSlot);
    }
    if (title !== undefined) {
      updates.push('title = ?');
      values.push(title);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    const durVal = duration_hours !== undefined ? duration_hours : durationHours;
    if (durVal !== undefined) {
      updates.push('duration_hours = ?');
      values.push(parseFloat(durVal) || 1.5);
    }
    const addrVal = property_address !== undefined ? property_address : address;
    if (addrVal !== undefined) {
      updates.push('property_address = ?');
      values.push(addrVal);
    }
    if (priority !== undefined) {
      updates.push('priority = ?');
      values.push(priority);
    }
    const resIdVal = resident_id !== undefined ? resident_id : residentId;
    if (resIdVal !== undefined) {
      updates.push('resident_id = ?');
      values.push(resIdVal);
    }
    const resNameVal = resident_name !== undefined ? resident_name : tenantName;
    if (resNameVal !== undefined) {
      updates.push('resident_name = ?');
      values.push(resNameVal);
    }
    const phoneVal = contact_phone !== undefined ? contact_phone : contactPhone;
    if (phoneVal !== undefined) {
      updates.push('contact_phone = ?');
      values.push(phoneVal);
    }
    const emailVal = contact_email !== undefined ? contact_email : contactEmail;
    if (emailVal !== undefined) {
      updates.push('contact_email = ?');
      values.push(emailVal);
    }

    if (updates.length > 0) {
      let updateSql = `UPDATE work_orders SET ${updates.join(', ')} WHERE id = ?`;
      values.push(id);
      await pool.query(updateSql, values);
    }

    // Notification Triggers
    const existingJob = existing[0];
    const prevStaffId = existingJob.assigned_staff_id;
    const prevSchedDate = existingJob.scheduled_date ? String(existingJob.scheduled_date).substring(0, 10) : null;
    const prevSchedSlot = existingJob.scheduled_time_slot;

    let targetStaffId = rawStaffId !== undefined ? (rawStaffId === null ? null : parseInt(rawStaffId, 10)) : prevStaffId;

    if (rawStaffId !== undefined && targetStaffId !== prevStaffId) {
      if (prevStaffId !== null && prevStaffId !== undefined) {
        const [spUser] = await pool.query('SELECT user_id FROM staff_profiles WHERE id = ?', [prevStaffId]);
        if (spUser.length > 0) {
          await notificationService.createNotification({
            recipientUserId: spUser[0].user_id,
            type: 'TASK_REASSIGNED',
            title: 'Task reassigned',
            message: `Task "${existingJob.title}" has been reassigned.`,
            relatedEntityType: 'work_orders',
            relatedEntityId: id,
            actionUrl: '/maintenance/my-tasks'
          });
        }
      }

      if (targetStaffId !== null && targetStaffId !== undefined) {
        const [spUser] = await pool.query('SELECT user_id FROM staff_profiles WHERE id = ?', [targetStaffId]);
        if (spUser.length > 0) {
          await notificationService.createNotification({
            recipientUserId: spUser[0].user_id,
            type: 'TASK_ASSIGNED',
            title: 'New task assigned',
            message: `Assigned to ${existingJob.title} at ${existingJob.property_address}`,
            relatedEntityType: 'work_orders',
            relatedEntityId: id,
            actionUrl: '/maintenance/my-tasks'
          });
        }
      }
    }

    const targetSchedDate = schedDate !== undefined ? (schedDate === null ? null : String(schedDate).substring(0, 10)) : prevSchedDate;
    const targetSchedSlot = schedSlot !== undefined ? (schedSlot === null ? null : schedSlot) : prevSchedSlot;

    if (targetStaffId && (targetSchedDate !== prevSchedDate || targetSchedSlot !== prevSchedSlot)) {
      const [spUser] = await pool.query('SELECT user_id FROM staff_profiles WHERE id = ?', [targetStaffId]);
      if (spUser.length > 0) {
        await notificationService.createNotification({
          recipientUserId: spUser[0].user_id,
          type: 'TASK_SCHEDULE_CHANGED',
          title: 'Your job schedule has been updated',
          message: `Rescheduled to ${targetSchedDate || 'Unscheduled'} at ${targetSchedSlot || 'Unscheduled'}`,
          relatedEntityType: 'work_orders',
          relatedEntityId: id,
          actionUrl: '/maintenance/calendar'
        });
      }
    }

    if (newStage === 'Quotes' && existingJob.pipeline_stage !== 'Quotes') {
      QuoteRequestService.triggerAutoPhotoRequest(id);
    }

    if (newStage === 'Jobs' && existingJob.pipeline_stage !== 'Jobs') {
      BookingRequestService.triggerAutoBookingRequest(id);
    }

    if (newStage === 'Completed Quotes' && existingJob.pipeline_stage !== 'Completed Quotes') {
      const [admins] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      for (const admin of admins) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          type: 'QUOTE_APPROVED',
          title: 'Quote approved and ready for booking',
          message: `Quote for ${existingJob.title} is approved.`,
          relatedEntityType: 'work_orders',
          relatedEntityId: id,
          actionUrl: `/admin/pipeline?stage=Completed Quotes`
        });
      }
    }

    const [updatedRows] = await pool.query(
      `SELECT 
        w.*,
        (SELECT SUM(total_cost) FROM job_material_costs jmc WHERE jmc.work_order_id = w.id) AS total_material_cost,
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
      [id]
    );

    res.status(200).json({
      success: true,
      message: 'Work order updated successfully.',
      data: formatJobRow(updatedRows[0], req.user ? req.user.role : null),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Delete work order
// @route   DELETE /api/v1/jobs/:id
// @access  Private (Office Admin Only)
const deleteJob = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [existing] = await pool.query('SELECT id FROM work_orders WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    await pool.query('DELETE FROM work_orders WHERE id = ?', [id]);

    res.status(200).json({
      success: true,
      message: `Work order ID ${id} deleted successfully.`,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Cancel or reschedule a job by technician
// @route   POST /api/v1/jobs/:id/cancel
// @access  Private (Maintenance Staff Only)
const cancelJob = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { cancellationType, reason, notes } = req.body;
    const hasProof = !!req.file;
    const hasReason = !!(reason && reason.trim());

    // Type-specific validation — do NOT use a generic proof-replaces-reason rule
    if (cancellationType === 'TENANT_CANCELLED') {
      // Tenant: proof OR reason required
      if (!hasProof && !hasReason) {
        connection.release();
        return res.status(400).json({
          success: false,
          message: 'Tenant cancellation requires either a proof screenshot or a written reason.',
        });
      }
    } else if (cancellationType === 'TECHNICIAN_CANCELLED') {
      // Technician: reason is ALWAYS mandatory regardless of proof
      if (!hasReason) {
        connection.release();
        return res.status(400).json({
          success: false,
          message: 'Technician cancellation requires a written reason. Proof alone is not sufficient.',
        });
      }
    } else {
      // Unsupported cancellation type
      connection.release();
      return res.status(400).json({
        success: false,
        message: `Unsupported cancellation type: '${cancellationType}'. Use TENANT_CANCELLED or TECHNICIAN_CANCELLED.`,
      });
    }

    // 1. Validate Job & Staff Ownership
    const [existing] = await connection.query(
      'SELECT id, assigned_staff_id, assigned_staff_ids, scheduled_date, scheduled_time_slot, pipeline_stage, title, resident_name FROM work_orders WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    const job = existing[0];

    if (job.pipeline_stage === 'Completed Jobs') {
      connection.release();
      return res.status(400).json({ success: false, message: 'Cannot cancel an already completed job.' });
    }

    if (req.user.role === 'MAINTENANCE_STAFF') {
      const [userStaffProfile] = await connection.query('SELECT id FROM staff_profiles WHERE user_id = ?', [req.user.id]);
      const currentStaffProfileId = userStaffProfile.length > 0 ? userStaffProfile[0].id : null;

      let isAssigned = (job.assigned_staff_id === currentStaffProfileId);
      if (!isAssigned && job.assigned_staff_ids) {
        const ids = typeof job.assigned_staff_ids === 'string' ? JSON.parse(job.assigned_staff_ids) : job.assigned_staff_ids;
        if (Array.isArray(ids) && ids.includes(currentStaffProfileId)) {
          isAssigned = true;
        }
      }

      if (!currentStaffProfileId || !isAssigned) {
        connection.release();
        return res.status(403).json({
          success: false,
          message: 'Forbidden. Maintenance Staff can only cancel work orders assigned to them.',
        });
      }
    }

    // 2. Validate 48-Hour Rule
    const { validateCancellationWindow } = require('../services/cancellation.service');
    let schedDate = null;
    if (job.scheduled_date) {
      if (job.scheduled_date instanceof Date) {
        const y = job.scheduled_date.getFullYear();
        const m = String(job.scheduled_date.getMonth() + 1).padStart(2, '0');
        const d = String(job.scheduled_date.getDate()).padStart(2, '0');
        schedDate = `${y}-${m}-${d}`;
      } else {
        schedDate = String(job.scheduled_date).substring(0, 10);
      }
    }
    
    if (schedDate && job.scheduled_time_slot) {
      try {
        validateCancellationWindow(schedDate, job.scheduled_time_slot);
      } catch (err) {
        connection.release();
        return res.status(err.status || 403).json({
          success: false,
          message: err.message,
          code: err.code
        });
      }
    }

    await connection.beginTransaction();

    // 3. Update Work Order
    const newStage = 'Jobs Waiting Booking'; // Put back in booking queue
    const priority = cancellationType === 'TECHNICIAN_CANCELLED' ? 'URGENT' : 'NORMAL';

    await connection.query(
      `UPDATE work_orders SET 
        cancellation_type = ?, 
        cancellation_reason = ?, 
        cancelled_by = ?, 
        cancelled_at = NOW(),
        previous_appointment_date = scheduled_date,
        previous_appointment_time = scheduled_time_slot,
        scheduled_date = NULL,
        scheduled_time_slot = NULL,
        pipeline_stage = ?,
        priority = IF(? = 'URGENT', 'URGENT', priority)
       WHERE id = ?`,
      [cancellationType, reason, req.user.id, newStage, priority, id]
    );

    // 4. Create Appointment & Cancellation History Records
    const [historyResult] = await connection.query(
      `INSERT INTO appointment_history (
        work_order_id, action_type, previous_date, previous_time,
        cancellation_type, reason, performed_by, performed_by_role, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, 'CANCELLATION', schedDate, job.scheduled_time_slot,
        cancellationType, reason, req.user.id, req.user.role, notes || null
      ]
    );

    let proofPath = req.file ? (req.file.path || req.file.filename) : null;
    await connection.query(
      `INSERT INTO cancellation_history (
        work_order_id, cancelled_by_user_id, cancellation_type, reason, notes, proof_url
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, cancellationType, reason || 'No reason specified', notes || null, proofPath]
    );

    // 5. Handle File Upload if Tenant Cancelled
    if (req.file) {
       await connection.query(
        `INSERT INTO cancellation_media_uploads (
          work_order_id, appointment_history_id, file_name, file_path, mime_type, file_size_bytes, uploaded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, historyResult.insertId, req.file.originalname, req.file.path, req.file.mimetype, req.file.size, req.user.id]
      );
    }

    // 6. Stop old booking reminder workflow
    await connection.query(
      `UPDATE booking_requests SET status = 'CANCELLED' WHERE work_order_id = ? AND status = 'WAITING_FOR_BOOKING'`,
      [id]
    );

    // 7. Notify Office Team and Admin using the central dispatcher
    const [officeUsers] = await connection.query("SELECT id, role FROM users WHERE role IN ('OFFICE_ADMIN', 'OFFICE_TEAM')");
    const dispatcher = require('../services/notification.service');
    
    const notificationType = cancellationType === 'TECHNICIAN_CANCELLED' ? 'TECHNICIAN_CANCELLED' : 'TENANT_CANCELLED';
    const notificationTitle = cancellationType === 'TECHNICIAN_CANCELLED' ? 'Urgent: Tech Cancelled Job' : 'Job Cancelled by Tenant';
    const messageTemplate = `Job #{{id}} ({{title}}) cancelled. Reason: {{reason}}. Rebooking required.`;

    for (const u of officeUsers) {
      await dispatcher.dispatch({
        recipientUserId: u.id,
        recipientRole: u.role,
        type: notificationType,
        title: notificationTitle,
        messageTemplate,
        structuredData: {
          id,
          title: job.title,
          reason
        },
        relatedEntityType: 'work_orders',
        relatedEntityId: id,
        actionUrl: `/admin/pipeline`,
        channels: ['IN_APP'], // Internal operational notification
        connection
      });
    }

    // Optionally notify Tenant (via central dispatcher)
    if (cancellationType === 'TECHNICIAN_CANCELLED' && job.resident_name) {
       const [residentRows] = await connection.query('SELECT email, phone FROM residents WHERE full_name = ? LIMIT 1', [job.resident_name]);
       const residentEmail = residentRows.length > 0 ? residentRows[0].email : null;
       const residentPhone = residentRows.length > 0 ? residentRows[0].phone : null;

       await dispatcher.dispatch({
         recipientUserId: null,
         recipientRole: 'TENANT',
         type: 'TECHNICIAN_CANCELLED',
         title: 'Appointment Update — New Appointment Required',
         messageTemplate: `Hi {{resident_name}},\n\nWe sincerely apologize, but your upcoming maintenance appointment has been cancelled. Please select a new appointment time using the booking link we will send you shortly.`,
         structuredData: { resident_name: job.resident_name },
         channels: ['EMAIL', 'SMS'],
         contactEmail: residentEmail,
         contactPhone: residentPhone,
         connection
       });
    }

    await connection.commit();
    connection.release();

    // 8. Generate a new booking/rebooking request 
    const { triggerAutoBookingRequest } = require('../services/bookingRequest.service');
    await triggerAutoBookingRequest(id);

    res.status(200).json({
      success: true,
      message: 'Job cancelled successfully.',
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    next(err);
  }
};

module.exports = {
  getJobs,
  getJobById,
  createJob,
  moveJobStage,
  updateJobStatus,
  deleteJob,
  cancelJob,
};
