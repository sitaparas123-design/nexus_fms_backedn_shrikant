const express = require('express');
const router = express.Router();
const {
  getQuoteRequests,
  generateQuoteRequest,
  updateQuoteRequestStatus
} = require('../controllers/quoteRequest.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

// All endpoints here require authentication
router.use(authenticateToken);

router.get('/', getQuoteRequests);
router.post('/', generateQuoteRequest);
router.put('/:token/status', updateQuoteRequestStatus);

module.exports = router;
