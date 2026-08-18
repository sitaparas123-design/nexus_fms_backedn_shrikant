const { pool } = require('../config/db');
const { sendEmail } = require('./notification/providers/email.provider');
const { sendSms } = require('./notification/providers/sms.provider');

let ioInstance = null;

const SENSITIVE_FINANCIAL_FIELDS = [
  'quoteAmount', 'quote_amount', 'material_cost', 'material_costs', 
  'total_job_cost', 'revenue', 'profit', 'margin', 'cost'
];

const sanitizePayload = (role, dataPayload) => {
  if (!dataPayload) return null;
  if (role === 'OFFICE_ADMIN') return dataPayload; 
  const sanitized = { ...dataPayload };
  for (const field of SENSITIVE_FINANCIAL_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
};

const formatMessage = (messageTemplate, structuredData) => {
  if (!structuredData) return messageTemplate;
  // Replace all {{key}} in the template
  return messageTemplate.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    if (structuredData[key] !== undefined) {
      return structuredData[key];
    }
    // If it's a sensitive field that was stripped, hide it
    if (SENSITIVE_FINANCIAL_FIELDS.includes(key)) {
      return '<RESTRICTED>';
    }
    return ''; // Or keep it, but usually we want it blank if missing
  });
};

const notificationService = {
  setIoInstance(io) {
    ioInstance = io;
  },

  getIoInstance() {
    return ioInstance;
  },

  /**
   * Backwards compatible method used by existing Phase 1-9 code.
   * Promoted to use the full dispatcher under the hood.
   */
  async createNotification(data, connection = null) {
    // Map old style to new style
    return this.dispatch({
      recipientUserId: data.recipientUserId,
      recipientRole: 'OFFICE_ADMIN', // Assume admin for legacy generic alerts unless specified otherwise
      type: data.type,
      title: data.title,
      messageTemplate: data.message,
      structuredData: null,
      relatedEntityType: data.relatedEntityType,
      relatedEntityId: data.relatedEntityId,
      actionUrl: data.actionUrl,
      channels: ['IN_APP'], // Legacy calls only trigger IN_APP and socket
      connection
    });
  },

  async dispatch({
    recipientUserId,
    recipientRole,
    type,
    title,
    messageTemplate,
    structuredData,
    actionUrl,
    relatedEntityType,
    relatedEntityId,
    channels = ['IN_APP'],
    contactEmail = null,
    contactPhone = null,
    connection = null
  }) {
    const db = connection || pool;
    const sanitizedData = sanitizePayload(recipientRole, structuredData);
    const finalMessage = formatMessage(messageTemplate, sanitizedData);
    let notificationId = null;

    try {
      if (channels.includes('IN_APP') && recipientUserId && recipientRole !== 'TENANT') {
        const [userExists] = await db.query('SELECT id FROM users WHERE id = ?', [recipientUserId]);
        if (userExists.length > 0) {
          const [res] = await db.query(
            `INSERT INTO notifications 
              (user_id, notification_type, title, message, related_entity_type, related_entity_id, action_url)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [recipientUserId, type, title, finalMessage, relatedEntityType, relatedEntityId, actionUrl]
          );
          notificationId = res.insertId;

          if (ioInstance) {
             ioInstance.to(`user_${recipientUserId}`).emit('NEW_NOTIFICATION', {
               id: notificationId,
               type,
               title,
               message: finalMessage,
               actionUrl,
               createdAt: new Date().toISOString()
             });
          }
        }
      }

      if (channels.includes('EMAIL') && contactEmail) {
        await this._processChannelDelivery(db, notificationId, 'EMAIL', contactEmail, async () => {
           return await sendEmail({ to: contactEmail, subject: title, body: finalMessage });
        });
      }

      if (channels.includes('SMS') && contactPhone) {
         await this._processChannelDelivery(db, notificationId, 'SMS', contactPhone, async () => {
           return await sendSms({ to: contactPhone, message: finalMessage });
         });
      }

    } catch (error) {
      console.error('[NotificationService] Dispatch failed:', error);
      if (connection) throw error; 
    }
  },

  async _processChannelDelivery(db, notificationId, channel, recipient, deliveryFn) {
     const [trackRes] = await db.query(
       `INSERT INTO notification_delivery (notification_id, channel, recipient, status, attempts) VALUES (?, ?, ?, 'PENDING', 0)`,
       [notificationId || null, channel, recipient]
     );
     const deliveryId = trackRes.insertId;

     let attempt = 1;
     const maxAttempts = 3;
     let success = false;
     let providerRes = null;
     let lastError = null;

     while (attempt <= maxAttempts && !success) {
       try {
         await db.query('UPDATE notification_delivery SET attempts = ?, last_attempt_at = NOW() WHERE id = ?', [attempt, deliveryId]);
         providerRes = await deliveryFn();
         success = true;
         await db.query(
           `UPDATE notification_delivery SET status = 'SENT', sent_at = NOW(), provider = ?, provider_message_id = ? WHERE id = ?`,
           [providerRes.provider, providerRes.messageId, deliveryId]
         );
       } catch (error) {
         lastError = error;
         attempt++;
         if (attempt <= maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
       }
     }

     if (!success) {
       await db.query(
         `UPDATE notification_delivery SET status = 'FAILED', failed_at = NOW(), error_message = ? WHERE id = ?`,
         [lastError.message.substring(0, 500), deliveryId]
       );
       console.error(`[NotificationService] Channel ${channel} failed after ${maxAttempts} attempts for delivery ID ${deliveryId}`);
     }
  }
};

module.exports = notificationService;
