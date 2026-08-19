const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const { pipeline } = require('stream/promises');
const { triggerAutoPhotoRequest } = require('../services/quoteRequest.service');

// Allowed MIME types for attachments
const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/csv', 'image/x-icon'
];
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

// @desc    Receive external webhook to create a Quote (Work Order)
// @route   POST /api/v1/webhooks/quotes
// @access  Private (x-api-key)
const handleIncomingEmailQuote = async (req, res) => {
  try {
    const {
      reference_id,
      subject,
      resident_name,
      contact_email,
      contact_phone,
      property_address,
      description,
      priority,
      attachments,
      manager_name,
      manager_email
    } = req.body;

    // 1. Validation
    if (!reference_id) {
      return res.status(400).json({ success: false, message: 'Missing reference_id' });
    }
    if (!subject) {
      return res.status(400).json({ success: false, message: 'Missing subject' });
    }
    if (!resident_name) {
      return res.status(400).json({ success: false, message: 'Missing resident_name' });
    }
    if (!property_address) {
      return res.status(400).json({ success: false, message: 'Missing property_address' });
    }

    // 2. Idempotency Check
    const [existing] = await pool.query('SELECT id FROM work_orders WHERE external_reference_id = ?', [reference_id]);
    if (existing.length > 0) {
      return res.status(200).json({
        success: true,
        message: 'Duplicate webhook. Quote already exists.',
        workOrderId: existing[0].id
      });
    }

    // 3. Resolve/Create Resident
    let resId = null;
    let resPhone = (contact_phone || 'N/A').trim();
    let resEmail = (contact_email || '').trim() || null;
    let resName = resident_name.trim();
    let resAddress = property_address.trim();

    const [existingRes] = await pool.query('SELECT id FROM residents WHERE phone = ? OR full_name = ?', [resPhone, resName]);
    if (existingRes.length > 0) {
      resId = existingRes[0].id;
    } else {
      const [newResResult] = await pool.query(
        'INSERT INTO residents (full_name, phone, email, address) VALUES (?, ?, ?, ?)',
        [resName, resPhone, resEmail, resAddress]
      );
      resId = newResResult.insertId;
    }

    // 4. Generate Job Specifics
    const randomNumber = Math.floor(1000 + Math.random() * 9000);
    const jobNumber = `JOB-2026-${randomNumber}`;
    const secureToken = `tok_${crypto.randomBytes(32).toString('hex')}`;
    const jobPriority = (['URGENT', 'HIGH', 'NORMAL', 'LOW'].includes(priority?.toUpperCase())) ? priority.toUpperCase() : 'NORMAL';

    // Begin Transaction
    const conn = await pool.getConnection();
    await conn.beginTransaction();

    let workOrderId;
    try {
      // 5. Insert Work Order
      const [insertResult] = await conn.query(
        `INSERT INTO work_orders (
          job_number, external_reference_id, title, resident_id, resident_name, contact_phone, contact_email,
          property_address, description, duration_hours, pipeline_stage,
          priority, secure_token, created_by, manager_name, manager_email
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          jobNumber, reference_id, subject.trim(), resId, resName, resPhone, resEmail,
          resAddress, description ? description.trim() : null, 1.5, 'Quotes',
          jobPriority, secureToken, null,
          manager_name ? manager_name.trim() : 'Email Requester',
          manager_email ? manager_email.trim() : null
        ]
      );
      
      workOrderId = insertResult.insertId;

      // 6. Handle Attachments
      if (Array.isArray(attachments) && attachments.length > 0) {
        const uploadDir = path.join(__dirname, '..', 'uploads', 'customer_media');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        for (const file of attachments) {
          if (!file.file_url) continue;
          
          try {
            const fileResp = await fetch(file.file_url);
            if (!fileResp.ok) {
              console.warn(`[Webhook] Failed to fetch attachment ${file.file_url}: ${fileResp.status}`);
              continue;
            }

            const fullContentType = fileResp.headers.get('content-type') || file.mime_type || 'application/octet-stream';
            const contentType = fullContentType.split(';')[0].trim().toLowerCase();
            const contentLength = fileResp.headers.get('content-length');

            if (!ALLOWED_MIME_TYPES.includes(contentType)) {
              console.warn(`[Webhook] Skipping file ${file.file_name} - Unsupported MIME type ${contentType}`);
              continue;
            }

            if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
              console.warn(`[Webhook] Skipping file ${file.file_name} - Exceeds MAX_FILE_SIZE`);
              continue; // Do not throw 413, just skip oversized to save the quote
            }

            const originalName = file.file_name ? file.file_name.replace(/[^a-zA-Z0-9.-]/g, '_') : 'attachment';
            const uniqueFilename = `email_${Date.now()}_${originalName}`;
            const filePath = path.join(uploadDir, uniqueFilename);
            const dbPath = `/uploads/customer_media/${uniqueFilename}`;

            // Stream file to disk (Handle Node.js fetch WebReadableStream)
            const { Readable } = require('stream');
            const fileStream = fs.createWriteStream(filePath);
            const readableWebStream = Readable.fromWeb(fileResp.body);
            await pipeline(readableWebStream, fileStream);

            const stat = fs.statSync(filePath);
            if (stat.size > MAX_FILE_SIZE) {
              fs.unlinkSync(filePath);
              console.warn(`[Webhook] File too large after download ${file.file_name}`);
              continue;
            }

            await conn.query(
              `INSERT INTO work_order_attachments (work_order_id, file_name, file_path, file_size_bytes, mime_type)
               VALUES (?, ?, ?, ?, ?)`,
              [workOrderId, file.file_name || 'attachment', dbPath, stat.size, contentType]
            );

          } catch (fileErr) {
            console.error('[Webhook] Error processing attachment:', fileErr.message);
            // Continue processing other files
          }
        }
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // Trigger photo request automatically
    await triggerAutoPhotoRequest(workOrderId);

    return res.status(201).json({
      success: true,
      message: 'Quote created successfully from webhook',
      workOrderId: workOrderId
    });

  } catch (error) {
    console.error('[Webhook Error]', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while processing webhook'
    });
  }
};

module.exports = {
  handleIncomingEmailQuote
};
