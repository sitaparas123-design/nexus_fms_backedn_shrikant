const { pool } = require('../config/db');
const { categorizeWorkOrder } = require('./ai.service');

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
      sp.id, sp.user_id, sp.role_title, sp.working_days_json, sp.work_start_time, sp.work_end_time,
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
      staffId: staffProfileId,
      staffName: staff.staff_name,
      staffRole: staff.role_title,
    });
  }

  return {
    success: true,
    staffId: staffProfileId,
    staffName: staff.staff_name,
    staffRole: staff.role_title,
    targetDate,
    dayAbbrev,
    durationHours,
    availableSlots: candidateSlots,
  };
};

/**
 * Calculate available booking slots for a job on a targetDate across all qualified staff,
 * performing AI skill category matching and proximity/location ranking when assigned_staff_id is null.
 */
const calculateAvailableSlotsForJob = async (workOrder, targetDate, connection = pool) => {
  const durationHours = parseFloat(workOrder.duration_hours || workOrder.durationHours || 1.5);
  const assignedStaffId = workOrder.assigned_staff_id || workOrder.assignedStaffId || null;
  const dayAbbrev = getDayAbbreviation(targetDate);

  // 1. If a specific staff is assigned or preferred, calculate specifically for that staff
  if (assignedStaffId) {
    const singleResult = await calculateStaffAvailableSlots(assignedStaffId, targetDate, durationHours, connection);
    return {
      ...singleResult,
      isSpecificStaff: true,
      category: workOrder.category || 'General Maintenance',
    };
  }

  // 2. AI Categorize work order description/title to match technician skills
  const jobText = `${workOrder.title || ''} ${workOrder.description || ''}`.trim();
  let aiCategoryResult = { category: 'General Maintenance' };
  try {
    aiCategoryResult = await categorizeWorkOrder(jobText);
  } catch (e) {
    console.warn('[AI Categorization Error]', e.message);
  }
  const detectedCategory = aiCategoryResult.category || 'General Maintenance';

  // 3. Fetch all active technicians
  const [staffRows] = await connection.query(
    `SELECT 
      sp.id, sp.user_id, sp.role_title, sp.working_days_json, sp.work_start_time, sp.work_end_time,
      sp.break_start_time, sp.break_end_time, sp.home_address, sp.home_postcode, sp.duty_status,
      u.full_name as staff_name, u.phone as staff_phone
     FROM staff_profiles sp
     JOIN users u ON sp.user_id = u.id`
  );

  if (staffRows.length === 0) {
    return {
      success: true,
      availableSlots: [],
      reason: 'No staff profiles found in directory.',
      category: detectedCategory,
    };
  }

  // 4. Filter staff by working day on targetDate
  const workingStaff = staffRows.filter(staff => {
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
    return workingDays.includes(dayAbbrev);
  });

  if (workingStaff.length === 0) {
    return {
      success: true,
      availableSlots: [],
      reason: `No technicians are working on ${dayAbbrev} (${targetDate}). Please select an available working day (Mon - Sat).`,
      category: detectedCategory,
    };
  }

  // 5. Score and rank working staff candidates
  const scoredStaff = workingStaff.map(staff => {
    let score = 0;
    const roleLower = (staff.role_title || '').toLowerCase();
    const catLower = detectedCategory.toLowerCase();

    // Skill Category Match
    if (catLower.includes('electric') && (roleLower.includes('electric') || roleLower.includes('wire') || roleLower.includes('light'))) {
      score += 60;
    } else if (catLower.includes('plumb') && (roleLower.includes('plumb') || roleLower.includes('pipe') || roleLower.includes('leak') || roleLower.includes('sink') || roleLower.includes('tap'))) {
      score += 60;
    } else if (catLower.includes('hvac') && (roleLower.includes('hvac') || roleLower.includes('ac') || roleLower.includes('air') || roleLower.includes('heat') || roleLower.includes('duct'))) {
      score += 60;
    } else if (catLower.includes('lock') && (roleLower.includes('lock') || roleLower.includes('carpenter') || roleLower.includes('door') || roleLower.includes('gate'))) {
      score += 60;
    } else if (roleLower.includes('specialist') || roleLower.includes('technician')) {
      score += 30; // General qualification
    }

    // Proximity / Location Match (postcode/city similarity check)
    let proximityScore = 10;
    const jobAddress = workOrder.property_address || workOrder.address || '';
    if (staff.home_address && jobAddress) {
      const staffAddr = staff.home_address.toLowerCase();
      const jobAddr = jobAddress.toLowerCase();
      
      if (staff.home_postcode && jobAddr.includes(staff.home_postcode.toLowerCase())) {
        proximityScore += 30;
      }
      const staffWords = staffAddr.split(/[,\s]+/).filter(w => w.length > 3);
      for (const word of staffWords) {
        if (jobAddr.includes(word)) {
          proximityScore += 10;
        }
      }
    }
    score += proximityScore;

    return {
      staff,
      score,
    };
  });

  // Sort candidates highest score first
  scoredStaff.sort((a, b) => b.score - a.score);

  // 6. Calculate available slots for each candidate and aggregate unique time slots
  const slotMap = new Map(); // timeSlot string -> slot object with best assigned staff

  for (const { staff } of scoredStaff) {
    const res = await calculateStaffAvailableSlots(staff.id, targetDate, durationHours, connection);
    if (res.success && Array.isArray(res.availableSlots)) {
      for (const slot of res.availableSlots) {
        if (!slotMap.has(slot.timeSlot)) {
          slotMap.set(slot.timeSlot, {
            ...slot,
            staffId: staff.id,
            staffName: staff.staff_name,
            staffRole: staff.role_title,
          });
        }
      }
    }
  }

  // Sort slots chronologically
  const aggregatedSlots = Array.from(slotMap.values()).sort((a, b) => {
    return timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
  });

  const bestStaff = scoredStaff.length > 0 ? scoredStaff[0].staff : null;

  return {
    success: true,
    targetDate,
    dayAbbrev,
    durationHours,
    category: detectedCategory,
    staffName: bestStaff ? bestStaff.staff_name : 'Any Available Staff',
    staffRole: bestStaff ? bestStaff.role_title : 'Technician',
    availableSlots: aggregatedSlots,
    reason: aggregatedSlots.length === 0 ? `All technicians are booked or unavailable for ${durationHours}h slots on ${targetDate}.` : undefined,
  };
};

module.exports = {
  calculateStaffAvailableSlots,
  calculateAvailableSlotsForJob,
  timeToMinutes,
  minutesToTime,
  getDayAbbreviation,
};
