const { pool } = require('../config/db');

// Helper to convert "HH:mm" time string to minutes from midnight
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const parts = String(timeStr).split(':');
  const hours = parseInt(parts[0], 10) || 0;
  const mins = parseInt(parts[1], 10) || 0;
  return hours * 60 + mins;
};

// Helper to convert minutes from midnight to "HH:mm" time string
const minutesToTime = (totalMinutes) => {
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  const hStr = hours < 10 ? `0${hours}` : `${hours}`;
  const mStr = mins < 10 ? `0${mins}` : `${mins}`;
  return `${hStr}:${mStr}`;
};

// Helper to get 3-letter day abbreviation for date string (YYYY-MM-DD)
const getDayAbbreviation = (dateStr) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dateObj = new Date(`${dateStr}T00:00:00`);
  return days[dateObj.getDay()];
};

/**
 * Calculate available booking slots for a technician on a specific date and duration
 * @param {number} staffProfileId 
 * @param {string} targetDate - 'YYYY-MM-DD'
 * @param {number} durationHours - Float (e.g. 1.0, 1.5, 2.0, 3.0)
 * @param {object} connection - Optional MySQL transaction connection
 */
const calculateStaffAvailableSlots = async (staffProfileId, targetDate, durationHours = 1.5, connection = pool) => {
  // 1. Fetch Staff Profile Working Hours & Days
  const [staffRows] = await connection.query(
    `SELECT 
      sp.id, sp.user_id, sp.working_days_json, sp.work_start_time, sp.work_end_time,
      sp.break_start_time, sp.break_end_time, u.full_name as staff_name
     FROM staff_profiles sp
     JOIN users u ON sp.user_id = u.id
     WHERE sp.id = ?`,
    [staffProfileId]
  );

  if (staffRows.length === 0) {
    return {
      success: false,
      reason: 'Staff profile not found',
      availableSlots: [],
    };
  }

  const staff = staffRows[0];
  const dayAbbrev = getDayAbbreviation(targetDate);
  
  let workingDays = staff.working_days_json;
  if (typeof workingDays === 'string') {
    try {
      workingDays = JSON.parse(workingDays);
    } catch {
      workingDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    }
  }
  if (!Array.isArray(workingDays)) {
    workingDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  }

  // Check Working Day Requirement
  if (!workingDays.includes(dayAbbrev)) {
    return {
      success: true,
      reason: `Date '${targetDate}' (${dayAbbrev}) is outside working days (${workingDays.join(', ')})`,
      availableSlots: [],
    };
  }

  const shiftStartMin = timeToMinutes(staff.work_start_time || '08:00:00');
  const shiftEndMin = timeToMinutes(staff.work_end_time || '17:00:00');
  const breakStartMin = timeToMinutes(staff.break_start_time || '12:00:00');
  const breakEndMin = timeToMinutes(staff.break_end_time || '13:00:00');
  const durationMins = Math.round(durationHours * 60);

  // 2. Fetch Existing Scheduled Jobs for this technician on targetDate
  const [existingJobs] = await connection.query(
    `SELECT id, scheduled_time_slot, duration_hours 
     FROM work_orders 
     WHERE assigned_staff_id = ? AND scheduled_date = ? AND scheduled_time_slot IS NOT NULL`,
    [staffProfileId, targetDate]
  );

  const occupiedIntervals = [];

  for (const job of existingJobs) {
    const slotText = job.scheduled_time_slot;
    if (slotText && slotText.includes('-')) {
      const parts = slotText.split('-').map(s => s.trim());
      const startMin = timeToMinutes(parts[0]);
      const endMin = timeToMinutes(parts[1]);
      occupiedIntervals.push({ start: startMin, end: endMin });
    }
  }

  // 3. Generate Candidate Starting Slots (Every 30 mins)
  const candidateSlots = [];
  const step = 30; // 30-minute interval grid

  for (let slotStartMin = shiftStartMin; slotStartMin + durationMins <= shiftEndMin; slotStartMin += step) {
    const slotEndMin = slotStartMin + durationMins;

    // Reject if overlaps break time
    const overlapsBreak = (slotStartMin < breakEndMin && slotEndMin > breakStartMin);
    if (overlapsBreak) continue;

    // Reject if overlaps existing job interval
    let overlapsJob = false;
    for (const jobInt of occupiedIntervals) {
      if (slotStartMin < jobInt.end && slotEndMin > jobInt.start) {
        overlapsJob = true;
        break;
      }
    }
    if (overlapsJob) continue;

    // Valid slot found!
    const startTimeStr = minutesToTime(slotStartMin);
    const endTimeStr = minutesToTime(slotEndMin);
    candidateSlots.push({
      timeSlot: `${startTimeStr} - ${endTimeStr}`,
      startTime: startTimeStr,
      endTime: endTimeStr,
      durationHours: durationHours,
    });
  }

  return {
    success: true,
    staffId: staffProfileId,
    staffName: staff.staff_name,
    targetDate,
    dayAbbrev,
    durationHours,
    availableSlots: candidateSlots,
  };
};

module.exports = {
  calculateStaffAvailableSlots,
  timeToMinutes,
  minutesToTime,
  getDayAbbreviation,
};
