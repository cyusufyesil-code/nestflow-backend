// backend/config/db.js

const { Pool } = require("pg");

const pool = new Pool({
host: process.env.DB_HOST,
port: process.env.DB_PORT,
database: process.env.DB_NAME,
user: process.env.DB_USER,
password: process.env.DB_PASSWORD,
max: 20,
idleTimeoutMillis: 30000,
connectionTimeoutMillis: 5000
});

pool.on("connect",()=>{
console.log("PostgreSQL bağlantısı başarılı");
});

pool.on("error",(err)=>{
console.error("DB Hatası:",err);
});

module.exports = pool;