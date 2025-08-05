const express = require('express');
const router = express.Router();
const winston = require('winston');
const { createClient } = require('@supabase/supabase-js');
const Joi = require('joi');
const { authenticateToken, authorizeRoles } = require('../auth/middleware');
const pushNotifications = require('./pushNotifications');

// Initialize logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'notifications.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Validation schemas
const notificationSchema = Joi.object({
  type: Joi.string().valid('bus_approaching', 'bus_delayed', 'bus_arrived', 'incident', 'general').required(),
  recipient_id: Joi.string().uuid().required(),
  title: Joi.string().max(100).required(),
  message: Joi.string().max(500).required(),
  data: Joi.object().optional(),
  priority: Joi.string().valid('low', 'medium', 'high', 'urgent').default('medium')
});

const batchNotificationSchema = Joi.object({
  type: Joi.string().valid('bus_approaching', 'bus_delayed', 'bus_arrived', 'incident', 'general').required(),
  recipient_ids: Joi.array().items(Joi.string().uuid()).min(1).required(),
  title: Joi.string().max(100).required(),
  message: Joi.string().max(500).required(),
  data: Joi.object().optional(),
  priority: Joi.string().valid('low', 'medium', 'high', 'urgent').default('medium')
});

const notificationPreferencesSchema = Joi.object({
  bus_approaching: Joi.boolean().default(true),
  bus_delayed: Joi.boolean().default(true),
  bus_arrived: Joi.boolean().default(true),
  incident: Joi.boolean().default(true),
  general: Joi.boolean().default(true),
  email_enabled: Joi.boolean().default(false),
  sms_enabled: Joi.boolean().default(false),
  push_enabled: Joi.boolean().default(true)
});

// Send single notification
router.post('/send', authenticateToken, authorizeRoles(['admin', 'dispatcher', 'driver']), async (req, res) => {
  try {
    const { error: validationError, value } = notificationSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { type, recipient_id, title, message, data, priority } = value;

    // Check recipient preferences
    const { data: preferences, error: prefError } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', recipient_id)
      .single();

    if (prefError && prefError.code !== 'PGRST116') { // Not found is ok
      logger.error('Error fetching preferences:', prefError);
      return res.status(500).json({ error: 'Failed to fetch preferences' });
    }

    // Check if user wants this type of notification
    if (preferences && preferences[type] === false) {
      logger.info(`User ${recipient_id} has disabled ${type} notifications`);
      return res.json({ 
        success: true, 
        message: 'Notification not sent due to user preferences',
        sent: false 
      });
    }

    // Create notification record
    const { data: notification, error: createError } = await supabase
      .from('notifications')
      .insert({
        type,
        recipient_id,
        sender_id: req.user.id,
        title,
        message,
        data,
        priority,
        status: 'pending',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (createError) {
      logger.error('Error creating notification:', createError);
      return res.status(500).json({ error: 'Failed to create notification' });
    }

    // Send real-time notification using Supabase Realtime
    await supabase
      .from('notifications')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', notification.id);

    logger.info(`Notification sent: ${notification.id} to ${recipient_id}`);

    res.json({
      success: true,
      notification_id: notification.id,
      sent: true
    });
  } catch (error) {
    logger.error('Error sending notification:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send batch notifications
router.post('/send-batch', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { error: validationError, value } = batchNotificationSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { type, recipient_ids, title, message, data, priority } = value;

    // Get preferences for all recipients
    const { data: preferences, error: prefError } = await supabase
      .from('notification_preferences')
      .select('user_id')
      .in('user_id', recipient_ids)
      .eq(type, true);

    if (prefError) {
      logger.error('Error fetching preferences:', prefError);
      return res.status(500).json({ error: 'Failed to fetch preferences' });
    }

    // Filter recipients based on preferences
    const enabledRecipients = preferences ? preferences.map(p => p.user_id) : recipient_ids;
    
    if (enabledRecipients.length === 0) {
      return res.json({
        success: true,
        message: 'No recipients with enabled preferences',
        sent_count: 0,
        total_count: recipient_ids.length
      });
    }

    // Create notification records
    const notifications = enabledRecipients.map(recipient_id => ({
      type,
      recipient_id,
      sender_id: req.user.id,
      title,
      message,
      data,
      priority,
      status: 'pending',
      created_at: new Date().toISOString()
    }));

    const { data: created, error: createError } = await supabase
      .from('notifications')
      .insert(notifications)
      .select();

    if (createError) {
      logger.error('Error creating notifications:', createError);
      return res.status(500).json({ error: 'Failed to create notifications' });
    }

    // Mark as sent
    const notificationIds = created.map(n => n.id);
    await supabase
      .from('notifications')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .in('id', notificationIds);

    logger.info(`Batch notifications sent: ${created.length} notifications`);

    res.json({
      success: true,
      sent_count: created.length,
      total_count: recipient_ids.length,
      notification_ids: notificationIds
    });
  } catch (error) {
    logger.error('Error sending batch notifications:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get notifications for current user
router.get('/my-notifications', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, unread_only = false } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('recipient_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (unread_only === 'true') {
      query = query.is('read_at', null);
    }

    const { data: notifications, error, count } = await query;

    if (error) {
      logger.error('Error fetching notifications:', error);
      return res.status(500).json({ error: 'Failed to fetch notifications' });
    }

    res.json({
      notifications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    logger.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark notification as read
router.put('/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const { data: notification, error: fetchError } = await supabase
      .from('notifications')
      .select('recipient_id')
      .eq('id', id)
      .single();

    if (fetchError || !notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    if (notification.recipient_id !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Mark as read
    const { error: updateError } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id);

    if (updateError) {
      logger.error('Error marking notification as read:', updateError);
      return res.status(500).json({ error: 'Failed to update notification' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark all notifications as read
router.put('/read-all', authenticateToken, async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('recipient_id', req.user.id)
      .is('read_at', null);

    if (error) {
      logger.error('Error marking all notifications as read:', error);
      return res.status(500).json({ error: 'Failed to update notifications' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get notification preferences
router.get('/preferences', authenticateToken, async (req, res) => {
  try {
    const { data: preferences, error } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') { // Not found
      logger.error('Error fetching preferences:', error);
      return res.status(500).json({ error: 'Failed to fetch preferences' });
    }

    // Return defaults if no preferences exist
    if (!preferences) {
      return res.json({
        bus_approaching: true,
        bus_delayed: true,
        bus_arrived: true,
        incident: true,
        general: true,
        email_enabled: false,
        sms_enabled: false,
        push_enabled: true
      });
    }

    res.json(preferences);
  } catch (error) {
    logger.error('Error fetching preferences:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update notification preferences
router.put('/preferences', authenticateToken, async (req, res) => {
  try {
    const { error: validationError, value } = notificationPreferencesSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // Upsert preferences
    const { error } = await supabase
      .from('notification_preferences')
      .upsert({
        user_id: req.user.id,
        ...value,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      });

    if (error) {
      logger.error('Error updating preferences:', error);
      return res.status(500).json({ error: 'Failed to update preferences' });
    }

    res.json({ success: true, preferences: value });
  } catch (error) {
    logger.error('Error updating preferences:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send automated notifications (called by other services)
router.post('/automated', async (req, res) => {
  try {
    // Verify internal service call with API key
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type, route_id, bus_id, stop_id, message_data } = req.body;

    let recipients = [];
    let title = '';
    let message = '';

    switch (type) {
      case 'bus_approaching':
        // Get parents of students on this route/stop
        const { data: students } = await supabase
          .from('students')
          .select('parent_id')
          .eq('route_id', route_id)
          .eq('stop_id', stop_id);
        
        recipients = [...new Set(students.map(s => s.parent_id))];
        title = 'Λεωφορείο Πλησιάζει';
        message = `Το σχολικό λεωφορείο θα φτάσει στη στάση σας σε ${message_data.eta} λεπτά`;
        break;

      case 'bus_delayed':
        // Get all parents on this route
        const { data: routeStudents } = await supabase
          .from('students')
          .select('parent_id')
          .eq('route_id', route_id);
        
        recipients = [...new Set(routeStudents.map(s => s.parent_id))];
        title = 'Καθυστέρηση Λεωφορείου';
        message = `Το σχολικό λεωφορείο έχει καθυστέρηση ${message_data.delay} λεπτών`;
        break;

      case 'incident':
        // Notify admins and dispatchers
        const { data: admins } = await supabase
          .from('users')
          .select('id')
          .in('role', ['admin', 'dispatcher']);
        
        recipients = admins.map(a => a.id);
        title = 'Αναφορά Περιστατικού';
        message = message_data.description;
        break;
    }

    if (recipients.length > 0) {
      // Send batch notification
      const notifications = recipients.map(recipient_id => ({
        type,
        recipient_id,
        sender_id: 'system',
        title,
        message,
        data: message_data,
        priority: type === 'incident' ? 'urgent' : 'medium',
        status: 'sent',
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString()
      }));

      await supabase
        .from('notifications')
        .insert(notifications);
      
      // Send push notifications
      await pushNotifications.sendTypedNotification(type, {
        ...message_data,
        parentIds: recipients,
        busId: bus_id,
        stopId: stop_id,
        userIds: recipients
      });
    }

    res.json({ success: true, recipients_count: recipients.length });
  } catch (error) {
    logger.error('Error sending automated notification:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get notifications for a parent
router.get("/parent/:parentId", authenticateToken, authorizeRoles(["parent", "admin"]), async (req, res) => {
  try {
    const { parentId } = req.params;
    
    // Verify parent is accessing their own notifications
    if (req.user.role === "parent" && req.user.id !== parentId) {
      return res.status(403).json({ error: "Unauthorized access" });
    }

    const { data: notifications, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("recipient_id", parentId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      logger.error("Failed to fetch parent notifications:", error);
      return res.status(500).json({ error: "Failed to fetch notifications" });
    }

    res.json({ notifications });
  } catch (error) {
    logger.error("Error fetching parent notifications:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Mark parent notification as read
router.put("/parent/:parentId/notifications/:notificationId/read", authenticateToken, authorizeRoles(["parent", "admin"]), async (req, res) => {
  try {
    const { parentId, notificationId } = req.params;
    
    // Verify parent is accessing their own notifications
    if (req.user.role === "parent" && req.user.id !== parentId) {
      return res.status(403).json({ error: "Unauthorized access" });
    }

    // Verify notification belongs to this parent
    const { data: notification, error: fetchError } = await supabase
      .from("notifications")
      .select("recipient_id")
      .eq("id", notificationId)
      .single();

    if (fetchError || !notification || notification.recipient_id !== parentId) {
      return res.status(404).json({ error: "Notification not found" });
    }

    // Mark as read
    const { error: updateError } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notificationId);

    if (updateError) {
      logger.error("Error marking parent notification as read:", updateError);
      return res.status(500).json({ error: "Failed to update notification" });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error("Error marking parent notification as read:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete parent notification
router.delete("/parent/:parentId/notifications/:notificationId", authenticateToken, authorizeRoles(["parent", "admin"]), async (req, res) => {
  try {
    const { parentId, notificationId } = req.params;
    
    // Verify parent is accessing their own notifications
    if (req.user.role === "parent" && req.user.id !== parentId) {
      return res.status(403).json({ error: "Unauthorized access" });
    }

    // Verify notification belongs to this parent
    const { data: notification, error: fetchError } = await supabase
      .from("notifications")
      .select("recipient_id")
      .eq("id", notificationId)
      .single();

    if (fetchError || !notification || notification.recipient_id !== parentId) {
      return res.status(404).json({ error: "Notification not found" });
    }

    // Delete notification
    const { error: deleteError } = await supabase
      .from("notifications")
      .delete()
      .eq("id", notificationId);

    if (deleteError) {
      logger.error("Error deleting parent notification:", deleteError);
      return res.status(500).json({ error: "Failed to delete notification" });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error("Error deleting parent notification:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Clear all parent notifications
router.delete("/parent/:parentId/notifications", authenticateToken, authorizeRoles(["parent", "admin"]), async (req, res) => {
  try {
    const { parentId } = req.params;
    
    // Verify parent is accessing their own notifications
    if (req.user.role === "parent" && req.user.id !== parentId) {
      return res.status(403).json({ error: "Unauthorized access" });
    }

    // Delete all notifications for this parent
    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("recipient_id", parentId);

    if (error) {
      logger.error("Error clearing parent notifications:", error);
      return res.status(500).json({ error: "Failed to clear notifications" });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error("Error clearing parent notifications:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get VAPID public key for push notifications
router.get('/vapid-public-key', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  
  if (!publicKey) {
    return res.status(500).json({ error: 'VAPID public key not configured' });
  }
  
  res.json({ publicKey });
});

// Subscribe to push notifications
router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    const { subscription, userId } = req.body;
    
    if (!subscription) {
      return res.status(400).json({ error: 'Subscription data required' });
    }
    
    // Verify user is subscribing for themselves
    if (req.user.id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    await pushNotifications.saveSubscription(userId, subscription);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Error subscribing to push notifications:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Unsubscribe from push notifications
router.delete('/unsubscribe/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Verify user is unsubscribing themselves
    if (req.user.id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    await pushNotifications.removeSubscription(userId);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Error unsubscribing from push notifications:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// Send test push notification
router.post('/test-push', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await pushNotifications.sendNotification(userId, {
      title: 'Δοκιμαστική Ειδοποίηση',
      body: 'Αυτή είναι μια δοκιμαστική ειδοποίηση push',
      data: {
        type: 'test',
        timestamp: Date.now()
      }
    });
    
    if (result) {
      res.json({ success: true, message: 'Test notification sent' });
    } else {
      res.json({ success: false, message: 'No push subscription found' });
    }
  } catch (error) {
    logger.error('Error sending test push notification:', error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

module.exports = router;
