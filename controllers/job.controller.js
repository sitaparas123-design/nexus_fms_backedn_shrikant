const crypto = require('crypto');
const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');


// Helper to format raw database row to Frontend job object
const formatJobRow = (r) => ({
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
  assignedStaffCode: r.staff_code || (r.assigned_staff_id ? `STF-${100 + r.assigned_staff_id}` : null),
  assignedStaffName: r.staff_name || null,
  assignedStaffColor: r.staff_color || '#009bf2',
  managerName: r.manager_name || null,
  quoteAmount: r.quote_amount ? parseFloat(r.quote_amount) : null,
  scheduledDate: r.scheduled_date ? String(r.scheduled_date).substring(0, 10) : null,
  scheduledTimeSlot: r.scheduled_time_slot || null,
  secureToken: r.secure_token,
  createdAt: r.created_at ? String(r.created_at).substring(0, 10) : null,
});

// @desc    Get all work orders / jobs (supports section, search, and staff filters)
// @route   GET /api/v1/jobs
// @access  Private (JWT Required)
const getJobs = async (req, res, next) => {
  try {
    const { section, search, staffId } = req.query;

    let sql = `
      SELECT 
        w.*,
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
      WHERE 1=1
    `;

    const queryParams = [];

    if (section && section.trim() !== '') {
      sql += ' AND w.pipeline_stage = ?';
      queryParams.push(section.trim());
    }

    // Role-based data isolation
    if (req.user && req.user.role === 'MAINTENANCE_STAFF') {
      if (req.user.staffProfileId) {
        sql += ' AND w.assigned_staff_id = ?';
        queryParams.push(req.user.staffProfileId);
      } else {
        // If they have no profile yet, they shouldn't see any jobs
        sql += ' AND w.assigned_staff_id = -1';
      }
    } else if (staffId && staffId.trim() !== '' && staffId !== 'ALL') {
      const cleanStaffId = staffId.replace(/^(stf-|usr-)/, '');
      sql += ' AND w.assigned_staff_id = ?';
      queryParams.push(cleanStaffId);
    }

    if (search && search.trim() !== '') {
      const term = `%${search.trim()}%`;
      sql += ' AND (w.title LIKE ? OR w.resident_name LIKE ? OR r.full_name LIKE ? OR w.contact_phone LIKE ? OR w.property_address LIKE ? OR w.job_number LIKE ?)';
      queryParams.push(term, term, term, term, term, term);
    }

    sql += ' ORDER BY w.created_at DESC';

    const [rows] = await pool.query(sql, queryParams);
    const jobs = rows.map(formatJobRow);

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
      WHERE w.id = ? OR w.job_number = ? OR w.secure_token = ?`,
      [id, id, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with identifier '${id}'`,
      });
    }

    res.status(200).json({
      success: true,
      data: formatJobRow(rows[0]),
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
    let rawStaffId = assigned_staff_id || assignedStaffId || null;
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

    const [result] = await pool.query(
      `INSERT INTO work_orders (
        job_number, title, resident_id, resident_name, contact_phone, contact_email,
        property_address, description, duration_hours, pipeline_stage,
        assigned_staff_id, manager_name, quote_amount, scheduled_date,
        scheduled_time_slot, secure_token, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobNumber, jobTitle, resId, resName, resPhone, resEmail,
        resAddress, jobDesc, hours, stage,
        rawStaffId, mgrName, quoteVal, schedDate,
        schedSlot, secureToken, req.user.id
      ]
    );

    const [newJobRows] = await pool.query(
      `SELECT 
        w.*,
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
      data: formatJobRow(newJobRows[0]),
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

    const [existing] = await pool.query('SELECT id, assigned_staff_id FROM work_orders WHERE id = ?', [id]);
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
      data: formatJobRow(updatedRows[0]),
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
      quote_amount, quoteAmount,
      scheduled_date, scheduledDate,
      scheduled_time_slot, scheduledTimeSlot,
    } = req.body;

    const [existing] = await pool.query(
      'SELECT id, title, property_address, pipeline_stage, assigned_staff_id, scheduled_date, scheduled_time_slot FROM work_orders WHERE id = ?',
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    let rawStaffId = assigned_staff_id || assignedStaffId;
    if (rawStaffId && typeof rawStaffId === 'string') {
      rawStaffId = rawStaffId.replace(/^(stf-|usr-)/, '');
    }

    // Maintenance Staff Ownership Check: Staff can ONLY update jobs assigned to them
    if (req.user.role === 'MAINTENANCE_STAFF') {
      const [userStaffProfile] = await pool.query('SELECT id FROM staff_profiles WHERE user_id = ?', [req.user.id]);
      const currentStaffProfileId = userStaffProfile.length > 0 ? userStaffProfile[0].id : null;

      if (!currentStaffProfileId || existing[0].assigned_staff_id !== currentStaffProfileId) {
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
    const quoteVal = quote_amount || quoteAmount;
    const schedDate = scheduled_date || scheduledDate;
    const schedSlot = scheduled_time_slot || scheduledTimeSlot;

    await pool.query(
      `UPDATE work_orders SET
        pipeline_stage = COALESCE(?, pipeline_stage),
        assigned_staff_id = COALESCE(?, assigned_staff_id),
        quote_amount = COALESCE(?, quote_amount),
        scheduled_date = COALESCE(?, scheduled_date),
        scheduled_time_slot = COALESCE(?, scheduled_time_slot)
       WHERE id = ?`,
      [newStage || null, rawStaffId || null, quoteVal || null, schedDate || null, schedSlot || null, id]
    );

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
      data: formatJobRow(updatedRows[0]),
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

module.exports = {
  getJobs,
  getJobById,
  createJob,
  moveJobStage,
  updateJobStatus,
  deleteJob,
};
