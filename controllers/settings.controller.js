const { pool } = require('../config/db');

// @desc    Get system settings
// @route   GET /api/v1/settings
// @access  Private
const getSettings = async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT settings_json FROM system_settings ORDER BY id DESC LIMIT 1');
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Settings not found' });
    }
    let settingsData = rows[0].settings_json;
    if (typeof settingsData === 'string') {
      try {
        settingsData = JSON.parse(settingsData);
      } catch (e) {
        console.error('Failed to parse settings JSON', e);
      }
    }
    res.status(200).json({ success: true, data: settingsData });
  } catch (err) {
    next(err);
  }
};

// @desc    Update system settings
// @route   PUT /api/v1/settings
// @access  Private (Admin only conceptually, though currently just Private)
const updateSettings = async (req, res, next) => {
  try {
    const newSettings = req.body;
    
    // We update the existing row since there's only one active settings row
    await pool.query('UPDATE system_settings SET settings_json = ? ORDER BY id DESC LIMIT 1', [JSON.stringify(newSettings)]);
    
    res.status(200).json({ success: true, message: 'Settings updated successfully', data: newSettings });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getSettings,
  updateSettings
};
