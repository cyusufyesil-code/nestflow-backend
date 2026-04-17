require("dotenv").config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

/* =========================================
   CORE
========================================= */
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SECRET = process.env.JWT_SECRET || "nestflow_secret";

/* =========================================
   DATABASE
========================================= */
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        host: process.env.DB_HOST || "localhost",
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || "nestflow",
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD || "1234"
      }
);

pool.on("error", (err) => {
  console.error("PG ERROR:", err.message);
});

/* =========================================
   JWT
========================================= */
function createToken(user) {
  return jwt.sign(user, SECRET, { expiresIn: "12h" });
}

function auth(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header) {
      return res.status(401).json({
        success: false,
        message: "Token gerekli"
      });
    }

    const token = header.replace("Bearer ", "");
    req.user = jwt.verify(token, SECRET);

    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Yetkisiz erişim"
    });
  }
}

/* =========================================
   AUTO INIT
========================================= */
async function initDatabase() {
  try {
    await pool.query(`SELECT NOW()`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(100) NOT NULL,
        fullname VARCHAR(100),
        role VARCHAR(30),
        last_login TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS machines (
        id SERIAL PRIMARY KEY,
        machine_code VARCHAR(50),
        machine_name VARCHAR(100),
        oee NUMERIC DEFAULT 85
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_orders (
        id SERIAL PRIMARY KEY,
        wo_no VARCHAR(50),
        customer_name VARCHAR(100),
        product_name VARCHAR(100),
        material VARCHAR(50),
        thickness NUMERIC,
        qty NUMERIC DEFAULT 0,
        produced_qty NUMERIC DEFAULT 0,
        priority VARCHAR(20),
        status VARCHAR(30) DEFAULT 'Bekliyor',
        machine_id INTEGER,
        operator_id INTEGER,
        due_date DATE,
        start_time TIMESTAMP,
        end_time TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS production_logs (
        id SERIAL PRIMARY KEY,
        operator_id INTEGER,
        work_order_id INTEGER,
        qty NUMERIC DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    /* DEFAULT USERS */
    await pool.query(`
      INSERT INTO users
      (username,password_hash,fullname,role)
      VALUES
      ('admin','1234','System Admin','admin')
      ON CONFLICT (username) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO users
      (username,password_hash,fullname,role)
      VALUES
      ('demo','demo123','Demo User','demo')
      ON CONFLICT (username) DO NOTHING;
    `);

    /* DEFAULT MACHINES */
    await pool.query(`
      INSERT INTO machines (machine_code,machine_name,oee)
      VALUES
      ('LASER-01','Fiber Lazer',88),
      ('ABKANT-01','Abkant Pres',84),
      ('KAYNAK-01','Kaynak Hattı',81),
      ('MONTAJ-01','Montaj Hattı',79)
      ON CONFLICT DO NOTHING;
    `);

    console.log("PostgreSQL connected");
    console.log("Database ready");
  } catch (err) {
    console.error("INIT ERROR:", err.message);
    process.exit(1);
  }
}

/* =========================================
   ROOT
========================================= */
app.get("/", (req, res) => {
  res.json({
    success: true,
    app: "NESTFLOW BACKEND V10",
    status: "running"
  });
});

app.get("/healthz", async (req, res) => {
  try {
    await pool.query(`SELECT 1`);
    res.json({
      success: true,
      db: "ok"
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      db: "error"
    });
  }
});

/* =========================================
   LOGIN
========================================= */
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const q = await pool.query(
      `SELECT * FROM users WHERE username=$1 LIMIT 1`,
      [username]
    );

    if (!q.rows.length) {
      return res.status(401).json({ success: false });
    }

    const user = q.rows[0];

    if (user.password_hash !== password) {
      return res.status(401).json({ success: false });
    }

    await pool.query(
      `UPDATE users SET last_login=NOW() WHERE id=$1`,
      [user.id]
    );

    return res.json({
      success: true,
      token: createToken({
        id: user.id,
        username: user.username,
        role: user.role
      }),
      user
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* =========================================
   WORK ORDER LIST
========================================= */
app.get("/api/workorders", auth, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT
        w.id,
        w.wo_no,
        w.customer_name,
        w.product_name,
        w.material,
        w.thickness,
        w.qty,
        COALESCE(w.produced_qty,0) AS produced_qty,
        w.priority,
        w.status,
        w.due_date,
        m.machine_code,
        m.machine_name,
        u.fullname AS operator_name
      FROM work_orders w
      LEFT JOIN machines m ON m.id = w.machine_id
      LEFT JOIN users u ON u.id = w.operator_id
      ORDER BY w.id DESC
    `);

    res.json({
      success: true,
      data: q.rows
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* =========================================
   CREATE WORK ORDER
========================================= */
app.post("/api/workorders", auth, async (req, res) => {
  try {
    const d = req.body;

    await pool.query(`
      INSERT INTO work_orders
      (
        wo_no,
        customer_name,
        product_name,
        material,
        thickness,
        qty,
        priority,
        machine_id,
        status,
        due_date
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,'Bekliyor',$9)
    `, [
      d.wo_no,
      d.customer_name,
      d.product_name,
      d.material,
      d.thickness,
      d.qty,
      d.priority,
      d.machine_id,
      d.due_date
    ]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* =========================================
   UPDATE WORK ORDER
========================================= */
app.put("/api/workorders/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const d = req.body;

    /* üretim adedi ekle */
    if (d.add_qty) {
      await pool.query(`
        UPDATE work_orders
        SET produced_qty = COALESCE(produced_qty,0) + $1
        WHERE id=$2
      `, [d.add_qty, id]);

      await pool.query(`
        INSERT INTO production_logs
        (operator_id, work_order_id, qty)
        VALUES($1,$2,$3)
      `, [req.user.id, id, d.add_qty]);

      return res.json({ success: true });
    }

    /* durum değiştir */
    await pool.query(`
      UPDATE work_orders
      SET
        status = COALESCE($1,status),
        operator_id = COALESCE($2,operator_id),
        start_time =
          CASE
            WHEN $1='Üretimde' AND start_time IS NULL
            THEN NOW()
            ELSE start_time
          END,
        end_time =
          CASE
            WHEN $1='Tamamlandı'
            THEN NOW()
            ELSE end_time
          END
      WHERE id=$3
    `, [
      d.status || null,
      req.user.id,
      id
    ]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* =========================================
   DELETE WORK ORDER
========================================= */
app.delete("/api/workorders/:id", auth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM work_orders WHERE id=$1`,
      [id = req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* =========================================
   DASHBOARD
========================================= */
app.get("/api/dashboard/summary", auth, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status <> 'Tamamlandı') AS active,
        COUNT(*) FILTER (WHERE status = 'Tamamlandı') AS done,
        COALESCE(SUM(produced_qty),0) AS qty
      FROM work_orders
    `);

    const o = await pool.query(`
      SELECT COALESCE(ROUND(AVG(oee)),0) AS avg
      FROM machines
    `);

    res.json({
      success: true,
      data: {
        active_work_orders: Number(q.rows[0].active || 0),
        done: Number(q.rows[0].done || 0),
        total_produced_qty: Number(q.rows[0].qty || 0),
        avg_oee: Number(o.rows[0].avg || 0),
        delayed_orders: 0
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* =========================================
   START
========================================= */
app.listen(PORT, async () => {
  console.log("RUNNING " + PORT);
  await initDatabase();
});