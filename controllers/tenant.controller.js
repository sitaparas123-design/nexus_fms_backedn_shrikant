const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');

// @desc    Get all residents / tenants (supports optional search filter)
// @route   GET /api/v1/tenants
// @access  Private (JWT Required)
const getTenants = async (req, res, next) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT id, full_name, phone, email, address, notes, document_url, created_at, updated_at FROM residents';
    const queryParams = [];

    if (search && search.trim() !== '') {
      const term = `%${search.trim()}%`;
      sql += ' WHERE full_name LIKE ? OR phone LIKE ? OR email LIKE ? OR address LIKE ?';
      queryParams.push(term, term, term, term);
    }

    sql += ' ORDER BY created_at DESC';

    const [rows] = await pool.query(sql, queryParams);

    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get single resident by ID
// @route   GET /api/v1/tenants/:id
// @access  Private (JWT Required)
const getTenantById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      'SELECT id, full_name, phone, email, address, notes, document_url, created_at, updated_at FROM residents WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Resident not found with ID ${id}`,
      });
    }

    res.status(200).json({
      success: true,
      data: rows[0],
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Create new resident / tenant
// @route   POST /api/v1/tenants
// @access  Private (Office Admin & Staff)
const createTenant = async (req, res, next) => {
  try {
    const { full_name, name, phone, email, address, notes } = req.body;
    
    // Support both full_name and name keys from frontend
    const residentName = (full_name || name || '').trim();
    const residentPhone = (phone || '').trim();
    const residentAddress = (address || '').trim();
    const residentEmail = email && email.trim() !== '' ? email.trim() : null;
    const residentNotes = notes && notes.trim() !== '' ? notes.trim() : null;

    // Contact Validation: Full Name, Phone, and Address are STRICTLY REQUIRED
    if (!residentName) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Full Name is required.',
      });
    }

    if (!residentPhone) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Phone Number is required.',
      });
    }

    if (!residentAddress) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Property Address is required.',
      });
    }

    const documentPath = req.file ? `/uploads/${req.file.filename}` : null;

    const [result] = await pool.query(
      'INSERT INTO residents (full_name, phone, email, address, notes, document_url) VALUES (?, ?, ?, ?, ?, ?)',
      [residentName, residentPhone, residentEmail, residentAddress, residentNotes, documentPath]
    );

    const [newResidentRows] = await pool.query(
      'SELECT id, full_name, phone, email, address, notes, document_url, created_at, updated_at FROM residents WHERE id = ?',
      [result.insertId]
    );

    // Create Notification
    try {
      const [adminRows] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      for (const admin of adminRows) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          type: 'NEW_TENANT',
          title: 'New Resident Added',
          message: `Resident "${residentName}" has been added to the directory.`,
          relatedEntityType: 'residents',
          relatedEntityId: result.insertId,
          actionUrl: '/admin/tenants'
        });
      }
    } catch (notifErr) {
      console.error('[Notification] Failed to notify on tenant creation:', notifErr);
    }

    res.status(201).json({
      success: true,
      message: 'Resident created successfully.',
      data: newResidentRows[0],
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Update existing resident
// @route   PUT /api/v1/tenants/:id
// @access  Private (Office Admin & Staff)
const updateTenant = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { full_name, name, phone, email, address, notes } = req.body;

    const [existing] = await pool.query('SELECT id, document_url FROM residents WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Resident not found with ID ${id}`,
      });
    }

    const residentName = (full_name || name || '').trim();
    const residentPhone = (phone || '').trim();
    const residentAddress = (address || '').trim();
    const residentEmail = email && email.trim() !== '' ? email.trim() : null;
    const residentNotes = notes && notes.trim() !== '' ? notes.trim() : null;
    const documentPath = req.file ? `/uploads/${req.file.filename}` : existing[0].document_url;

    if (!residentName || !residentPhone || !residentAddress) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Full Name, Phone, and Address are required fields.',
      });
    }

    await pool.query(
      'UPDATE residents SET full_name = ?, phone = ?, email = ?, address = ?, notes = ?, document_url = ? WHERE id = ?',
      [residentName, residentPhone, residentEmail, residentAddress, residentNotes, documentPath, id]
    );

    const [updatedRows] = await pool.query(
      'SELECT id, full_name, phone, email, address, notes, document_url, created_at, updated_at FROM residents WHERE id = ?',
      [id]
    );

    res.status(200).json({
      success: true,
      message: 'Resident updated successfully.',
      data: updatedRows[0],
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Delete resident
// @route   DELETE /api/v1/tenants/:id
// @access  Private (Office Admin Only)
const deleteTenant = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [existing] = await pool.query('SELECT id FROM residents WHERE id = ?', [id]);
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Resident not found with ID ${id}`,
      });
    }

    await pool.query('DELETE FROM residents WHERE id = ?', [id]);

    res.status(200).json({
      success: true,
      message: `Resident ID ${id} deleted successfully.`,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getTenants,
  getTenantById,
  createTenant,
  updateTenant,
  deleteTenant,
};
