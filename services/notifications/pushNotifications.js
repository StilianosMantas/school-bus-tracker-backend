const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
const winston = require('winston');

// Initialize logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'push-notifications.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Generate VAPID keys (run once and save to environment)
// const vapidKeys = webpush.generateVAPIDKeys();
// console.log('Public Key:', vapidKeys.publicKey);
// console.log('Private Key:', vapidKeys.privateKey);

// Configure web-push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@schoolbus.gr',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

class PushNotificationService {
  // Save subscription to database
  async saveSubscription(userId, subscription) {
    try {
      const { error } = await supabase
        .from('push_subscriptions')
        .upsert({
          user_id: userId,
          subscription: subscription,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id'
        });

      if (error) {
        logger.error('Error saving subscription:', error);
        throw error;
      }

      logger.info(`Subscription saved for user ${userId}`);
    } catch (error) {
      logger.error('Error in saveSubscription:', error);
      throw error;
    }
  }

  // Remove subscription from database
  async removeSubscription(userId) {
    try {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId);

      if (error) {
        logger.error('Error removing subscription:', error);
        throw error;
      }

      logger.info(`Subscription removed for user ${userId}`);
    } catch (error) {
      logger.error('Error in removeSubscription:', error);
      throw error;
    }
  }

  // Get subscription for a user
  async getSubscription(userId) {
    try {
      const { data, error } = await supabase
        .from('push_subscriptions')
        .select('subscription')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') { // Not found is ok
        logger.error('Error fetching subscription:', error);
        throw error;
      }

      return data ? data.subscription : null;
    } catch (error) {
      logger.error('Error in getSubscription:', error);
      throw error;
    }
  }

  // Send push notification to a user
  async sendNotification(userId, payload) {
    try {
      const subscription = await this.getSubscription(userId);
      
      if (!subscription) {
        logger.info(`No push subscription found for user ${userId}`);
        return false;
      }

      const notificationPayload = {
        title: payload.title || 'Σχολικό Λεωφορείο',
        body: payload.body || 'Νέα ειδοποίηση',
        icon: payload.icon || '/logo192.png',
        badge: payload.badge || '/logo192.png',
        data: payload.data || {},
        timestamp: Date.now(),
        tag: payload.tag || `notification-${Date.now()}`,
        requireInteraction: payload.requireInteraction || false,
        actions: payload.actions || []
      };

      await webpush.sendNotification(
        subscription,
        JSON.stringify(notificationPayload)
      );

      logger.info(`Push notification sent to user ${userId}`);
      return true;
    } catch (error) {
      if (error.statusCode === 410) {
        // Subscription is no longer valid, remove it
        logger.info(`Removing invalid subscription for user ${userId}`);
        await this.removeSubscription(userId);
      } else {
        logger.error('Error sending push notification:', error);
      }
      return false;
    }
  }

  // Send notification to multiple users
  async sendBatchNotifications(userIds, payload) {
    const results = await Promise.allSettled(
      userIds.map(userId => this.sendNotification(userId, payload))
    );

    const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const failed = results.filter(r => r.status === 'rejected' || !r.value).length;

    logger.info(`Batch notifications: ${sent} sent, ${failed} failed`);
    return { sent, failed };
  }

  // Send notification based on type
  async sendTypedNotification(type, data) {
    let payload = {};
    let userIds = [];

    switch (type) {
      case 'bus_approaching':
        payload = {
          title: '🚌 Λεωφορείο Πλησιάζει',
          body: `Το λεωφορείο θα φτάσει στη στάση σας σε ${data.eta} λεπτά`,
          data: {
            type: 'bus_approaching',
            busId: data.busId,
            stopId: data.stopId,
            eta: data.eta
          },
          requireInteraction: true,
          tag: `bus-approaching-${data.stopId}`
        };
        userIds = data.parentIds;
        break;

      case 'bus_delayed':
        payload = {
          title: '⏰ Καθυστέρηση Λεωφορείου',
          body: `Το λεωφορείο έχει καθυστέρηση ${data.delay} λεπτών`,
          data: {
            type: 'bus_delayed',
            busId: data.busId,
            delay: data.delay
          },
          tag: `bus-delayed-${data.busId}`
        };
        userIds = data.parentIds;
        break;

      case 'incident':
        payload = {
          title: '⚠️ Περιστατικό',
          body: data.description,
          data: {
            type: 'incident',
            incidentId: data.incidentId,
            severity: data.severity
          },
          requireInteraction: true,
          tag: `incident-${data.incidentId}`
        };
        userIds = data.parentIds;
        break;

      case 'general':
        payload = {
          title: data.title || 'Ειδοποίηση',
          body: data.body,
          data: data.data || {},
          tag: data.tag || `general-${Date.now()}`
        };
        userIds = data.userIds;
        break;
    }

    if (userIds.length > 0) {
      return await this.sendBatchNotifications(userIds, payload);
    }

    return { sent: 0, failed: 0 };
  }
}

module.exports = new PushNotificationService();