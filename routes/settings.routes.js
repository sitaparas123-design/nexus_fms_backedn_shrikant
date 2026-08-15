const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { getSettings, updateSettings } = require('../controllers/settings.controller');

router.use(authenticateToken);
router.use(authorizeRoles('OFFICE_ADMIN'));

router.get('/', getSettings);
router.put('/', updateSettings);

module.exports = router;
