const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../uploads');
if (fs.existsSync(dir)) {
  console.log('Files in uploads:', fs.readdirSync(dir));
} else {
  console.log('Uploads directory does not exist.');
}
process.exit(0);
