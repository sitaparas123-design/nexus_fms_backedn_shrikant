const express = require('express');
const router = express.Router();
const photoUpload = require('../middleware/photoUpload.middleware');
const {
  getMyAssignedJobs,
  getMyAssignedJobById,
  submitWorkReport,
  uploadCompletionPhotos,
  markJobComplete,
  getJobCompletionEvidence,
} = require('../controllers/staffCompletion.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

// All staff completion routes require JWT authentication
router.use(authenticateToken);

// Assigned Work Orders List & Details
router.get('/my-jobs', getMyAssignedJobs);
router.get('/my-jobs/:id', getMyAssignedJobById);

// Completion Report Submission, Photo Proof Uploads & Explicit Completion Action
router.post('/jobs/:id/report', submitWorkReport);
router.post('/jobs/:id/photos', photoUpload.array('photos', 5), uploadCompletionPhotos);
router.put('/jobs/:id/complete', markJobComplete);

module.exports = {
  staffCompletionRouter: router,
  getJobCompletionEvidence,
};
