const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');


// Helper to resolve staff profile ID from logged in user ID
const getStaffProfileId = async (userId) => {
  const [rows] = await pool.query('SELECT id FROM staff_profiles WHERE user_id = ?', [userId]);
  if (rows.length > 0) return rows[0].id;
  
  const [uRows] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
  if (uRows.length > 0) {
    const [res] = await pool.query(
      'INSERT INTO staff_profiles (user_id, staff_code, role_title, color_hex) VALUES (?, ?, ?, ?)',
      [userId, `STF-${100 + Number(userId)}`, 'Maintenance Specialist', '#009bf2']
    );
    return res.insertId;
  }
  return null;
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

// @desc    Get all work orders assigned to the authenticated technician
// @route   GET /api/v1/staff/my-jobs
// @access  Private (Maintenance Staff)
const getMyAssignedJobs = async (req, res, next) => {
  try {
    const staffProfileId = await getStaffProfileId(req.user.id);

    if (!staffProfileId && req.user.role !== 'OFFICE_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. No staff profile associated with this account.',
      });
    }

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
    `;

    const queryParams = [];

    // Office Admin views all, Staff views ONLY assigned jobs
    if (req.user.role === 'MAINTENANCE_STAFF') {
      sql += ' WHERE w.assigned_staff_id = ?';
      queryParams.push(staffProfileId);
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

// @desc    Get single assigned work order by ID (with strict ownership check)
// @route   GET /api/v1/staff/my-jobs/:id
// @access  Private (Maintenance Staff & Office Admin)
const getMyAssignedJobById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);

    const [rows] = await pool.query(
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
      WHERE w.id = ? OR w.job_number = ?`,
      [id, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const job = rows[0];

    // Strict Ownership Enforcement: Maintenance Staff can ONLY view their assigned job
    if (req.user.role === 'MAINTENANCE_STAFF' && job.assigned_staff_id !== staffProfileId) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You are not authorized to view another technician’s assigned work order.',
      });
    }

    res.status(200).json({
      success: true,
      data: formatJobRow(job),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Submit Staff Work / Completion Report for Assigned Job
// @route   POST /api/v1/staff/jobs/:id/report
// @access  Private (Maintenance Staff & Office Admin)
const submitWorkReport = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { work_performed, work_report_summary, report_text, workReport, work_report, materials_used } = req.body;

    const reportSummary = (work_performed || work_report_summary || report_text || workReport || work_report || '').trim();

    const materials = (materials_used || '').trim() || null;

    // Reject empty reports
    if (!reportSummary) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Work report summary text cannot be empty.',
      });
    }

    const staffProfileId = await getStaffProfileId(req.user.id);

    const [jobRows] = await pool.query('SELECT id, assigned_staff_id FROM work_orders WHERE id = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const job = jobRows[0];

    // Strict Ownership Check
    if (req.user.role === 'MAINTENANCE_STAFF' && job.assigned_staff_id !== staffProfileId) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You cannot submit a work report for another technician’s job.',
      });
    }

    const targetStaffId = staffProfileId || job.assigned_staff_id;

    // Duplicate Completion Protection: Update existing report if already present for this job
    const [existingReport] = await pool.query(
      'SELECT id FROM staff_job_completions WHERE work_order_id = ?',
      [id]
    );

    let completionId = null;

    if (existingReport.length > 0) {
      completionId = existingReport[0].id;
      await pool.query(
        `UPDATE staff_job_completions SET 
          work_report_summary = ?,
          materials_used = ?,
          staff_id = ?,
          updated_at = NOW()
         WHERE id = ?`,
        [reportSummary, materials, targetStaffId, completionId]
      );
    } else {
      const [insertRes] = await pool.query(
        `INSERT INTO staff_job_completions 
          (work_order_id, staff_id, work_report_summary, materials_used, completion_status, completed_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [id, targetStaffId, reportSummary, materials, 'IN_PROGRESS']
      );
      completionId = insertRes.insertId;
    }

    const [savedReport] = await pool.query('SELECT * FROM staff_job_completions WHERE id = ?', [completionId]);

    res.status(200).json({
      success: true,
      message: 'Work completion report submitted successfully.',
      data: savedReport[0],
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Upload Proof Photos for Assigned Job
// @route   POST /api/v1/staff/jobs/:id/photos
// @access  Private (Maintenance Staff & Office Admin)
const uploadCompletionPhotos = async (req, res, next) => {
  try {
    const { id } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);

    const [jobRows] = await pool.query('SELECT id, assigned_staff_id FROM work_orders WHERE id = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const job = jobRows[0];

    // Strict Ownership Check
    if (req.user.role === 'MAINTENANCE_STAFF' && job.assigned_staff_id !== staffProfileId) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You cannot upload completion photos for another technician’s job.',
      });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Please select at least one photo to upload.',
      });
    }

    const targetStaffId = staffProfileId || job.assigned_staff_id;

    // Ensure staff_job_completions record exists to link completion_id
    const [existingReport] = await pool.query('SELECT id FROM staff_job_completions WHERE work_order_id = ?', [id]);
    let completionId = null;

    if (existingReport.length > 0) {
      completionId = existingReport[0].id;
    } else {
      const [insertRes] = await pool.query(
        `INSERT INTO staff_job_completions 
          (work_order_id, staff_id, work_report_summary, completion_status, completed_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [id, targetStaffId, 'Initial photo upload', 'IN_PROGRESS']
      );
      completionId = insertRes.insertId;
    }

    const savedPhotos = [];

    for (const file of files) {
      const fileUrl = `/uploads/${file.filename}`;
      const [mediaRes] = await pool.query(
        `INSERT INTO staff_completion_media 
          (completion_id, work_order_id, file_name, file_path, file_size_bytes, mime_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [completionId, id, file.originalname, fileUrl, file.size, file.mimetype]
      );

      savedPhotos.push({
        id: mediaRes.insertId,
        fileName: file.originalname,
        filePath: fileUrl,
        fileSize: file.size,
        mimeType: file.mimetype,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Completion proof photos uploaded successfully.',
      data: {
        workOrderId: id,
        completionId,
        photosUploaded: savedPhotos.length,
        photos: savedPhotos,
      },
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Explicitly Mark Work Order as Complete (Moves Stage to 'Completed Jobs')
// @route   PUT /api/v1/staff/jobs/:id/complete
// @access  Private (Maintenance Staff & Office Admin)
const markJobComplete = async (req, res, next) => {
  try {
    const { id } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);

    const [jobRows] = await pool.query('SELECT id, assigned_staff_id, pipeline_stage FROM work_orders WHERE id = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const job = jobRows[0];

    // Strict Ownership Check
    if (req.user.role === 'MAINTENANCE_STAFF' && job.assigned_staff_id !== staffProfileId) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You cannot complete another technician’s work order.',
      });
    }

    // Verify Work Report has been submitted prior to completion
    const [reportRows] = await pool.query(
      'SELECT id, work_report_summary FROM staff_job_completions WHERE work_order_id = ? AND work_report_summary IS NOT NULL',
      [id]
    );

    if (reportRows.length === 0 || !reportRows[0].work_report_summary) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Please submit a work report summary before completing the job.',
      });
    }

    // Verify at least one Completion Proof Photo has been uploaded prior to completion
    const [photoRows] = await pool.query(
      'SELECT COUNT(*) as photoCount FROM staff_completion_media WHERE work_order_id = ?',
      [id]
    );

    if (photoRows[0].photoCount === 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: At least one completion proof photo must be uploaded before completing the job.',
      });
    }

    // Update staff_job_completions status
    await pool.query(
      "UPDATE staff_job_completions SET completion_status = 'COMPLETED', completed_at = NOW() WHERE work_order_id = ?",
      [id]
    );

    // Update work_orders pipeline stage to 'Completed Jobs'
    await pool.query(
      "UPDATE work_orders SET pipeline_stage = 'Completed Jobs' WHERE id = ?",
      [id]
    );

    const [woRows] = await pool.query("SELECT title, assigned_staff_id FROM work_orders WHERE id = ?", [id]);
    const jobTitle = woRows[0]?.title || 'Repair Job';
    const assignedStaffId = woRows[0]?.assigned_staff_id;

    let techName = 'Technician';
    if (assignedStaffId) {
      const [techUser] = await pool.query("SELECT u.full_name FROM staff_profiles sp JOIN users u ON sp.user_id = u.id WHERE sp.id = ?", [assignedStaffId]);
      if (techUser.length > 0) techName = techUser[0].full_name;
    }

    const [admins] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
    for (const admin of admins) {
      await notificationService.createNotification({
        recipientUserId: admin.id,
        type: 'JOB_COMPLETED',
        title: 'Technician task completed',
        message: `Task "${jobTitle}" was marked completed by ${techName}`,
        relatedEntityType: 'work_orders',
        relatedEntityId: id,
        actionUrl: `/admin/pipeline?stage=Completed Jobs`
      });
    }

    const [updatedJobRows] = await pool.query(
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
      message: "Work order marked as 'Completed Jobs' successfully.",
      data: formatJobRow(updatedJobRows[0]),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get Completion Evidence (Report Summary & Photos) for Office Admin / Job View
// @route   GET /api/v1/jobs/:id/completion-evidence
// @access  Private (Office Admin & Assigned Staff)
const getJobCompletionEvidence = async (req, res, next) => {
  try {
    const { id } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);

    const [jobRows] = await pool.query('SELECT id, job_number, title, assigned_staff_id, pipeline_stage FROM work_orders WHERE id = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const job = jobRows[0];

    // Staff Authorization Check: Maintenance Staff can ONLY view evidence for their own assigned job
    if (req.user.role === 'MAINTENANCE_STAFF' && job.assigned_staff_id !== staffProfileId) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You are not authorized to view completion evidence for another technician’s work order.',
      });
    }

    // Fetch report from staff_job_completions
    const [reports] = await pool.query(
      `SELECT 
        c.*,
        u.full_name as staff_name,
        sp.staff_code,
        sp.role_title
       FROM staff_job_completions c
       LEFT JOIN staff_profiles sp ON c.staff_id = sp.id
       LEFT JOIN users u ON sp.user_id = u.id
       WHERE c.work_order_id = ?`,
      [id]
    );

    // Fetch proof photos from staff_completion_media
    const [mediaRows] = await pool.query(
      'SELECT id, file_name, file_path, file_size_bytes, mime_type, created_at FROM staff_completion_media WHERE work_order_id = ?',
      [id]
    );

    res.status(200).json({
      success: true,
      data: {
        workOrderId: job.id,
        jobNumber: job.job_number,
        title: job.title,
        pipelineStage: job.pipeline_stage,
        report: reports.length > 0 ? {
          completionId: reports[0].id,
          staffId: reports[0].staff_id,
          staffName: reports[0].staff_name,
          staffCode: reports[0].staff_code,
          workReportSummary: reports[0].work_report_summary,
          materialsUsed: reports[0].materials_used,
          completionStatus: reports[0].completion_status,
          completedAt: reports[0].completed_at,
        } : null,
        photos: mediaRows.map(m => ({
          id: m.id,
          fileName: m.file_name,
          filePath: m.file_path,
          fileSize: m.file_size_bytes,
          mimeType: m.mime_type,
          uploadedAt: m.created_at,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getMyAssignedJobs,
  getMyAssignedJobById,
  submitWorkReport,
  uploadCompletionPhotos,
  markJobComplete,
  getJobCompletionEvidence,
};
