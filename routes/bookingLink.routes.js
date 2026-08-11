const express = require('express');
const router = express.Router();
const {
  getBookingRequests,
  generateBookingLink
} = require('../controllers/bookingLink.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

// All endpoints here require authentication
router.use(authenticateToken);

router.get('/', getBookingRequests);
router.post('/', generateBookingLink);

module.exports = router;
