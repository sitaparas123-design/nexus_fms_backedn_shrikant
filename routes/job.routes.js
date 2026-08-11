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

// Read Endpoints (Office Admin & Maintenance Staff)
router.get('/', getJobs);
router.get('/:id', getJobById);
router.get('/:id/completion-evidence', getJobCompletionEvidence);

// Create / Move Stage / Update Endpoints (Office Admin & Maintenance Staff)
router.post('/', createJob);
router.put('/:id/stage', moveJobStage);
router.put('/:id/status', updateJobStatus);

// Delete Endpoint (Office Admin Only)
router.delete('/:id', authorizeRoles('OFFICE_ADMIN'), deleteJob);

module.exports = router;
