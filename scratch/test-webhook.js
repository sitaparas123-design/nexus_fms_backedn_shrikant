require('dotenv').config();
const http = require('http');
const { pool } = require('../config/db');

const API_BASE = 'http://localhost:5000/api/v1';
const SECRET = process.env.WEBHOOK_SECRET_KEY || 'test_secret_key_123';

// Force the process env so our test key works if .env wasn't updated
process.env.WEBHOOK_SECRET_KEY = SECRET;

const makeRequest = (method, path, body = null, apiKey = null) => {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (apiKey) {
      options.headers['x-api-key'] = apiKey;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
};

async function runTests() {
  console.log('==================================================');
  console.log('🧪 Starting Webhook E2E Tests');
  console.log('==================================================');

  try {
    const testRefId = `test-webhook-${Date.now()}`;
    const payload = {
      reference_id: testRefId,
      subject: 'Test Webhook Leak',
      resident_name: 'Webhook Tester',
      contact_email: 'webhook@nexusfms.com',
      contact_phone: '+1 800-WEB-HOOK',
      property_address: '404 Webhook Ln',
      description: 'Testing the external webhook automation.',
      priority: 'HIGH',
      attachments: [
        {
          file_name: 'dummy.ico',
          file_url: 'https://www.google.com/favicon.ico',
          mime_type: 'image/x-icon'
        }
      ]
    };

    // 1. Invalid API Key
    console.log('\n[1] Testing Invalid API Key...');
    let res = await makeRequest('POST', '/webhooks/quotes', payload, 'wrong-key');
    if (res.status === 401) console.log('✅ Passed 401 Unauthorized');
    else throw new Error(`Expected 401, got ${res.status}`);

    // 2. Missing Payload Fields
    console.log('\n[2] Testing Invalid Payload (Missing Subject)...');
    let badPayload = { ...payload, subject: null };
    res = await makeRequest('POST', '/webhooks/quotes', badPayload, SECRET);
    if (res.status === 400) console.log('✅ Passed 400 Bad Request');
    else throw new Error(`Expected 400, got ${res.status}`);

    // 3. Valid Payload Creation
    console.log('\n[3] Testing Valid Quote Creation...');
    res = await makeRequest('POST', '/webhooks/quotes', payload, SECRET);
    if (res.status === 201) {
      console.log('✅ Passed 201 Created');
      console.log('   Work Order ID:', res.body.workOrderId);
    } else {
      throw new Error(`Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    }

    const workOrderId = res.body.workOrderId;

    // 4. Verify DB Records
    console.log('\n[4] Verifying MySQL Database Records...');
    const [woRows] = await pool.query('SELECT * FROM work_orders WHERE id = ?', [workOrderId]);
    if (woRows.length === 0) throw new Error('Work order not found in DB!');
    
    const wo = woRows[0];
    if (wo.external_reference_id === testRefId && wo.pipeline_stage === 'Quotes') {
      console.log('✅ Work Order successfully saved with external_reference_id and pipeline_stage=Quotes');
    } else {
      throw new Error(`DB mismatch: ref=${wo.external_reference_id}, stage=${wo.pipeline_stage}`);
    }

    // 5. Verify Attachments Downloaded
    console.log('\n[5] Verifying Attachments in DB...');
    const [attRows] = await pool.query('SELECT * FROM work_order_attachments WHERE work_order_id = ?', [workOrderId]);
    if (attRows.length === 1 && attRows[0].file_name === 'dummy.ico') {
      console.log('✅ Attachment successfully downloaded and recorded in DB:', attRows[0].file_path);
    } else {
      throw new Error(`Attachment verification failed. Found ${attRows.length} attachments.`);
    }

    // 6. Test Idempotency (Duplicate Prevention)
    console.log('\n[6] Testing Idempotency (Duplicate Webhook)...');
    res = await makeRequest('POST', '/webhooks/quotes', payload, SECRET);
    if (res.status === 200 && res.body.message.includes('Duplicate webhook')) {
      console.log('✅ Passed 200 Duplicate Safely Ignored');
    } else {
      throw new Error(`Expected 200 Duplicate, got ${res.status}`);
    }
    
    // Ensure no second Quote was created
    const [duplicateCheck] = await pool.query('SELECT id FROM work_orders WHERE external_reference_id = ?', [testRefId]);
    if (duplicateCheck.length === 1) {
      console.log('✅ Verified only ONE work order exists in DB for this reference_id.');
    } else {
      throw new Error('Duplicate prevention failed in DB!');
    }

    console.log('\n🎉 All Webhook E2E Tests Passed Successfully!');
  } catch (err) {
    console.error('\n❌ Test Failed:', err.message);
  } finally {
    process.exit(0);
  }
}

runTests();
