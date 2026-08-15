require('dotenv').config();
const fs = require('fs');
const FormData = require('form-data');

const BASE_URL = process.env.VITE_API_URL || 'https://nexusfmsbackednshrikant-production.up.railway.app/api/v1';

async function runTest() {
  console.log("=== PHASE 6: TECHNICIAN COMPLETION FLOW TESTS ===");

  try {
    // 1. Tech Login
    console.log("Logging in as Maintenance Staff...");
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test_maintenance_staff@nexus.com', password: 'password123' })
    });
    if (!loginRes.ok) throw new Error(await loginRes.text());
    const techData = await loginRes.json();
    const techToken = techData.token;
    console.log("✅ Tech logged in");

    // 2. Admin Login
    console.log("Logging in as Office Admin...");
    const adminRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test_office_admin@nexus.com', password: 'password123' })
    });
    if (!adminRes.ok) throw new Error(await adminRes.text());
    const adminData = await adminRes.json();
    const adminToken = adminData.token;
    console.log("✅ Admin logged in");

    // 3. Office Team Login
    console.log("Logging in as Office Team...");
    const officeRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test_office_team@nexus.com', password: 'password123' })
    });
    if (!officeRes.ok) throw new Error(await officeRes.text());
    const officeData = await officeRes.json();
    const officeToken = officeData.token;
    console.log("✅ Office Team logged in");

    // 4. Get a job for the tech
    const jobsRes = await fetch(`${BASE_URL}/staff/my-jobs`, {
      headers: { Authorization: `Bearer ${techToken}` }
    });
    const jobsData = await jobsRes.json();
    const activeJobs = jobsData.data.filter(j => j.section !== 'Completed Jobs');
    
    if (activeJobs.length === 0) {
      console.log("⚠️ No active jobs for tech to test completion. Let's create one via DB manually or skip completion part.");
      return;
    }
    const targetJob = activeJobs[0];
    console.log(`Target Job ID: ${targetJob.id}`);

    // 5. Test Office Team cannot hit endpoint
    console.log("Test: Office Team cannot complete job");
    const test1 = await fetch(`${BASE_URL}/jobs/${targetJob.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${officeToken}` }
    });
    if (test1.status !== 403) throw new Error(`Failed: Office team got ${test1.status}`);
    console.log("✅ Office Team correctly blocked (403)");

    // 6. Test Invalid Materials JSON
    console.log("Test: Tech fails with invalid materials (negative quantity)");
    const formFail = new FormData();
    formFail.append('completion_report', 'Fixed');
    formFail.append('materials', JSON.stringify([{ material_name: 'Pipe', quantity: -1, unit_cost: 10 }]));
    
    const test2 = await fetch(`${BASE_URL}/jobs/${targetJob.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${techToken}`, ...formFail.getHeaders() },
      body: formFail
    });
    if (test2.status !== 400) throw new Error(`Failed: Negative qty got ${test2.status}`);
    console.log("✅ Negative quantity correctly blocked (400)");

    // 7. Successful Atomic Completion
    fs.writeFileSync('dummy.jpg', 'fake image data');
    const formSuccess = new FormData();
    formSuccess.append('completion_report', 'Replaced the PVC pipe and sealed the leak.');
    formSuccess.append('materials', JSON.stringify([{ material_name: 'PVC Pipe', quantity: 2, unit_cost: 15.50 }]));
    formSuccess.append('beforePhotos', fs.createReadStream('dummy.jpg'));
    
    console.log("Test: Atomic Completion");
    const test3 = await fetch(`${BASE_URL}/jobs/${targetJob.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${techToken}`, ...formSuccess.getHeaders() },
      body: formSuccess
    });
    const test3Data = await test3.json();
    if (!test3.ok) throw new Error(`Completion Failed: ${test3Data.message}`);
    console.log("✅ Job completed atomically:", test3Data.message);
    
    fs.unlinkSync('dummy.jpg');

    // 8. Verify Job Status and Disappearance
    const jobsResAfter = await fetch(`${BASE_URL}/staff/my-jobs`, {
      headers: { Authorization: `Bearer ${techToken}` }
    });
    const jobsDataAfter = await jobsResAfter.json();
    const stillActive = jobsDataAfter.data.find(j => j.id === targetJob.id && j.section !== 'Completed Jobs');
    if (stillActive) throw new Error("Failed: Job still active in tech queue");
    console.log("✅ Job removed from active technician queue");

    // 9. Verify Financial Isolation for Office Team
    console.log("Test: Financial fields hidden from Office Team");
    const officeJobResAfter = await fetch(`${BASE_URL}/jobs?search=${targetJob.id}`, {
      headers: { Authorization: `Bearer ${officeToken}` }
    });
    const officeJobDataAfter = await officeJobResAfter.json();
    const officeJob = officeJobDataAfter.data.find(j => j.id === targetJob.id);
    if(officeJob && (officeJob.quoteAmount !== undefined || officeJob.totalMaterialCost !== undefined || officeJob.profit !== undefined)) {
      throw new Error("Failed: Office Team received financial data: " + JSON.stringify(officeJob));
    }
    console.log("✅ Office Team correctly isolated from financials");

    // 10. Verify Admin Financial View
    console.log("Test: Admin sees financial fields");
    const adminJobResAfter = await fetch(`${BASE_URL}/jobs?search=${targetJob.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const adminJobDataAfter = await adminJobResAfter.json();
    const adminJob = adminJobDataAfter.data.find(j => j.id === targetJob.id);
    if(!adminJob || adminJob.totalMaterialCost === undefined) {
      throw new Error("Failed: Admin did not receive financial data");
    }
    console.log("✅ Admin correctly sees financials. Total Material Cost: £" + adminJob.totalMaterialCost);
    
    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY");

  } catch(err) {
    console.error("❌ TEST FAILED:");
    console.error(err.message || err);
    if(fs.existsSync('dummy.jpg')) fs.unlinkSync('dummy.jpg');
    process.exit(1);
  }
}

runTest();
