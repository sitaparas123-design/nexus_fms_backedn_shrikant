const express = require('express');
const router = express.Router();
const {
  getStaff,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff,
} = require('../controllers/staff.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

const {
  getMyAssignedJobs,
  getMyAssignedJobById,
  submitWorkReport,
  uploadCompletionPhotos,
  markJobComplete,
} = require('../controllers/staffCompletion.controller');
const photoUpload = require('../middleware/photoUpload.middleware');

// All staff routes require JWT authentication
router.use(authenticateToken);

// Technician Assigned Work Orders Endpoints (Must be mounted before /:id)
router.get('/my-jobs', getMyAssignedJobs);
router.get('/my-jobs/:id', getMyAssignedJobById);
router.post('/jobs/:id/report', submitWorkReport);
router.post('/jobs/:id/photos', photoUpload.array('photos', 5), uploadCompletionPhotos);
router.put('/jobs/:id/complete', markJobComplete);

// Read Endpoints (Accessible by Office Admin & Maintenance Staff)
router.get('/', getStaff);
router.get('/:id', getStaffById);

// Write / Management Endpoints
router.post('/', authorizeRoles('OFFICE_ADMIN'), photoUpload.single('avatar'), createStaff);
router.put('/:id', photoUpload.single('avatar'), updateStaff);
router.delete('/:id', authorizeRoles('OFFICE_ADMIN'), deleteStaff);

module.exports = router;
