const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { getSettings, updateSettings } = require('../controllers/settings.controller');

router.get('/', authenticateToken, getSettings);
router.put('/', authenticateToken, updateSettings);

module.exports = router;
