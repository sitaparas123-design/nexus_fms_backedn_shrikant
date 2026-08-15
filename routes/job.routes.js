const express = require('express');
const router = express.Router();
const {
  getJobs,
  getJobById,
  createJob,
  moveJobStage,
  updateJobStatus,
  deleteJob,
} = require('../controllers/job.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

// All work order routes require JWT authentication
router.use(authenticateToken);

const { getJobCompletionEvidence } = require('../controllers/staffCompletion.controller');

// Read Endpoints (Office Admin, Office Team & Maintenance Staff)
router.get('/', getJobs);
router.get('/:id', getJobById);
router.get('/:id/completion-evidence', authorizeRoles('OFFICE_ADMIN', 'MAINTENANCE_STAFF'), getJobCompletionEvidence);

// Create Endpoint (Office Admin Only)
router.post('/', authorizeRoles('OFFICE_ADMIN'), createJob);

// Move Stage (Office Admin & Maintenance Staff Only)
router.put('/:id/stage', authorizeRoles('OFFICE_ADMIN', 'MAINTENANCE_STAFF'), moveJobStage);

// Update Status/Schedule (Office Admin, Office Team & Maintenance Staff)
router.put('/:id/status', updateJobStatus);

// Delete Endpoint (Office Admin Only)
router.delete('/:id', authorizeRoles('OFFICE_ADMIN'), deleteJob);

module.exports = router;
