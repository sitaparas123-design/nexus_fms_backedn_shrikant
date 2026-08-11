const express = require('express');
const router = express.Router();
const {
  getCalendar,
  dispatchJob,
} = require('../controllers/calendar.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

// All internal calendar routes require JWT authentication
router.use(authenticateToken);

// Calendar Grid & Dispatch Endpoints
router.get('/', getCalendar);
router.post('/dispatch', dispatchJob);

module.exports = router;
