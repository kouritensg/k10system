require('dotenv').config();
const mysql = require('mysql2');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // Use the specific port from your Aiven dashboard (likely 10944)
  port: process.env.DB_PORT || 10944, 
  // Aiven requires SSL; this is why you were getting ETIMEDOUT
  ssl: {
    rejectUnauthorized: false 
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool.promise();
