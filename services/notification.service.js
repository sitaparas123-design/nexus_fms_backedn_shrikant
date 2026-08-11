const { pool } = require('../config/db');

/**
 * Centralized Notification Service to create user-targeted persistent notifications.
 */
const notificationService = {
  /**
   * Creates a persistent notification in MySQL.
   * Supports transactional query runner connections.
   * 
   * @param {Object} data - Notification details
   * @param {number} data.recipientUserId - Target user ID (recipient)
   * @param {string} data.type - Notification type (e.g. TASK_ASSIGNED)
   * @param {string} data.title - Notification title
   * @param {string} data.message - Notification description
   * @param {string} [data.relatedEntityType] - Optional related table name
   * @param {number} [data.relatedEntityId] - Optional related entity ID
   * @param {string} [data.actionUrl] - Optional frontend redirect URL
   * @param {Object} [connection] - Optional active database connection (for transactions)
   */
  async createNotification(data, connection = null) {
    const db = connection || pool;
    const {
      recipientUserId,
      type,
      title,
      message,
      relatedEntityType = null,
      relatedEntityId = null,
      actionUrl = null
    } = data;

    if (!recipientUserId || !type || !title || !message) {
      throw new Error('[Notification Service] Missing required fields.');
    }

    try {
      await db.query(
        `INSERT INTO notifications 
          (user_id, notification_type, title, message, related_entity_type, related_entity_id, action_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [recipientUserId, type, title, message, relatedEntityType, relatedEntityId, actionUrl]
      );
      console.log(`[Notification Service] Persisted '${type}' notification for user ID ${recipientUserId}`);
    } catch (err) {
      console.error('[Notification Service] Error creating notification:', err.message);
      // Do not crash the parent operation if it fails outside transactions
      if (connection) {
        throw err;
      }
    }
  }
};

module.exports = notificationService;
