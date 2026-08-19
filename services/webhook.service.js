/**
 * N8N & External Automation Webhook Dispatcher
 * Dispatches event payloads to N8N.cloud workflows
 */

const dispatchN8NWebhook = async (eventType, payload) => {
  const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;

  const eventData = {
    event: eventType,
    timestamp: new Date().toISOString(),
    source: 'nexus_fms_backend',
    data: payload,
  };

  if (!n8nWebhookUrl) {
    console.log(`[N8N_WEBHOOK_DEV] 📡 Event "${eventType}" ready. (Set N8N_WEBHOOK_URL in .env to dispatch live)`);
    return { success: true, mode: 'mock', event: eventType };
  }

  try {
    console.log(`[N8N_WEBHOOK] 🚀 Dispatching "${eventType}" to ${n8nWebhookUrl}`);
    
    const response = await fetch(n8nWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Nexus-Event': eventType,
        'X-Nexus-Secret': process.env.WEBHOOK_SECRET_KEY || 'nexus-secret',
      },
      body: JSON.stringify(eventData),
    });

    if (!response.ok) {
      console.warn(`[N8N_WEBHOOK] ⚠ N8N returned status ${response.status}`);
      return { success: false, status: response.status };
    }

    const resJson = await response.json().catch(() => ({}));
    console.log(`[N8N_WEBHOOK] ✓ Event "${eventType}" successfully delivered to N8N`);
    return { success: true, data: resJson };
  } catch (err) {
    console.error(`[N8N_WEBHOOK_ERROR] ❌ Failed to send webhook for "${eventType}":`, err.message);
    return { success: false, error: err.message };
  }
};

module.exports = {
  dispatchN8NWebhook,
};
