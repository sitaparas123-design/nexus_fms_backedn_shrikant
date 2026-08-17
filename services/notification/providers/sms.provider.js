/**
 * Mock SMS Provider for Development
 * In production, this would wrap Twilio, SNS, Plivo, MessageBird, etc.
 */

const sendSms = async ({ to, message }) => {
  console.log(`[SMS_PROVIDER] 📱 Sending SMS to ${to}`);
  console.log(`[SMS_PROVIDER] Message: ${message}`);
  
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 500));

  // In development, we always pretend it succeeded unless explicitly forced to fail
  if (process.env.SIMULATE_PROVIDER_FAILURES === 'true' && Math.random() < 0.2) {
    throw new Error('DEVELOPMENT_PROVIDER_SIMULATED_FAILURE');
  }

  const messageId = `dev-sms-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  return {
    success: true,
    provider: 'DEVELOPMENT_SMS_PROVIDER',
    messageId,
  };
};

module.exports = { sendSms };
