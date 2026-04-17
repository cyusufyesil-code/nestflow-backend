require("dotenv").config();
const express=require("express");
const cors=require("cors");
const jwt=require("jsonwebtoken");
const {Pool}=require("pg");

const app=express();
app.use(cors());
app.use(express.json());

const PORT=process.env.PORT||3000;

const pool=new Pool({
host:process.env.DB_HOST,
port:process.env.DB_PORT,
database:process.env.DB_NAME,
user:process.env.DB_USER,
password:process.env.DB_PASSWORD
});

const SECRET=process.env.JWT_SECRET||"nestflow_secret";

/* JWT */
function token(user){
return jwt.sign(user,SECRET,{expiresIn:"12h"});
}

function auth(req,res,next){
try{
const h=req.headers.authorization;
if(!h) return res.status(401).json({success:false});
req.user=jwt.verify(h.replace("Bearer ",""),SECRET);
next();
}catch{
res.status(401).json({success:false,message:"Geçersiz token"});
}
}

/* INIT */
async function init(){

await pool.query(`
ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;
`);

await pool.query(`
ALTER TABLE work_orders
ADD COLUMN IF NOT EXISTS operator_id INTEGER;
`);

await pool.query(`
ALTER TABLE work_orders
ADD COLUMN IF NOT EXISTS start_time TIMESTAMP;
`);

await pool.query(`
ALTER TABLE work_orders
ADD COLUMN IF NOT EXISTS end_time TIMESTAMP;
`);

console.log("Schema hazır");
}

/* LOGIN */
app.post("/api/login",async(req,res)=>{

const {username,password}=req.body;

const q=await pool.query(
`SELECT * FROM users WHERE username=$1 LIMIT 1`,
[username]
);

if(!q.rows.length)
return res.status(401).json({success:false});

const u=q.rows[0];

if(u.password_hash!==password)
return res.status(401).json({success:false});

await pool.query(
`UPDATE users SET last_login=NOW() WHERE id=$1`,
[u.id]
);

res.json({
success:true,
token:token({
id:u.id,
username:u.username,
role:u.role
}),
user:u
});

});

/* WORKORDER LIST */
app.get("/api/workorders",auth,async(req,res)=>{

const q=await pool.query(`
SELECT
w.id,
w.wo_no,
w.customer_name,
w.product_name,
w.material,
w.thickness,
w.qty,
w.produced_qty,
w.priority,
w.status,
w.due_date,
m.machine_code,
m.machine_name,
u.fullname operator_name
FROM work_orders w
LEFT JOIN machines m ON m.id=w.machine_id
LEFT JOIN users u ON u.id=w.operator_id
ORDER BY w.id DESC
`);

res.json({
success:true,
data:q.rows
});

});

/* CREATE */
app.post("/api/workorders",auth,async(req,res)=>{

const d=req.body;

await pool.query(`
INSERT INTO work_orders
(
wo_no,customer_name,product_name,
material,thickness,qty,
priority,machine_id,status,due_date
)
VALUES
($1,$2,$3,$4,$5,$6,$7,$8,'Bekliyor',$9)
`,[
d.wo_no,d.customer_name,d.product_name,
d.material,d.thickness,d.qty,
d.priority,d.machine_id,d.due_date
]);

res.json({success:true});

});

/* UPDATE */
app.put("/api/workorders/:id",auth,async(req,res)=>{

const id=req.params.id;
const d=req.body;

/* adet ekleme */
if(d.add_qty){

await pool.query(`
UPDATE work_orders
SET produced_qty=produced_qty+$1
WHERE id=$2
`,[d.add_qty,id]);

await pool.query(`
INSERT INTO production_logs
(operator_id,work_order_id,qty)
VALUES($1,$2,$3)
`,[req.user.id,id,d.add_qty]);

return res.json({success:true});
}

/* status update */
await pool.query(`
UPDATE work_orders
SET
status=COALESCE($1,status),
operator_id=COALESCE($2,operator_id),
start_time=
CASE WHEN $1='Üretimde' THEN NOW()
ELSE start_time END,
end_time=
CASE WHEN $1='Tamamlandı' THEN NOW()
ELSE end_time END
WHERE id=$3
`,[
d.status||null,
req.user.id,
id
]);

res.json({success:true});

});

/* DELETE */
app.delete("/api/workorders/:id",auth,async(req,res)=>{

await pool.query(
`DELETE FROM work_orders WHERE id=$1`,
[req.params.id]
);

res.json({success:true});

});

/* DASHBOARD */
app.get("/api/dashboard/summary",auth,async(req,res)=>{

const q=await pool.query(`
SELECT
COUNT(*) FILTER (WHERE status<>'Tamamlandı') active,
COUNT(*) FILTER (WHERE status='Tamamlandı') done,
COALESCE(SUM(produced_qty),0) qty
FROM work_orders
`);

const o=await pool.query(`
SELECT ROUND(AVG(oee)) avg FROM machines
`);

res.json({
success:true,
data:{
active_work_orders:q.rows[0].active,
done:q.rows[0].done,
total_produced_qty:q.rows[0].qty,
avg_oee:o.rows[0].avg||0,
delayed_orders:0
}
});

});

/* START */
app.listen(PORT,async()=>{
console.log("RUNNING "+PORT);
await init();
});