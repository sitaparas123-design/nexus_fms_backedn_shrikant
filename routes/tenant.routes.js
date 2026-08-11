const express = require('express');
const router = express.Router();
const {
  getTenants,
  getTenantById,
  createTenant,
  updateTenant,
  deleteTenant,
} = require('../controllers/tenant.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

const photoUpload = require('../middleware/photoUpload.middleware');

// All resident routes require JWT authentication
router.use(authenticateToken);

// Read Endpoints (Accessible by Office Admin & Maintenance Staff)
router.get('/', getTenants);
router.get('/:id', getTenantById);

// Write / Management Endpoints (Strictly Office Admin Only)
router.post('/', authorizeRoles('OFFICE_ADMIN'), photoUpload.single('document'), createTenant);
router.put('/:id', authorizeRoles('OFFICE_ADMIN'), photoUpload.single('document'), updateTenant);
router.delete('/:id', authorizeRoles('OFFICE_ADMIN'), deleteTenant);

module.exports = router;
