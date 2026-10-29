const express=require('express'),mysql=require('mysql2/promise'),nodemailer=require('nodemailer'),crypto=require('crypto');
// ===== CONFIG =====
const E=process.env;
const DB={host:E.DB_HOST||'localhost',port:+E.DB_PORT||3306,user:E.DB_USER||'root',password:E.DB_PASSWORD||'',database:E.DB_NAME||'icct_queue'};
if(E.DB_SSL)DB.ssl={minVersion:'TLSv1.2',rejectUnauthorized:true}; // needed by online databases such as TiDB Cloud
const SMTP={user:E.GMAIL_USER||'',pass:E.GMAIL_APP_PASSWORD||''}; // local PC only: Gmail + App Password
const BREVO=E.BREVO_API_KEY,FROM=E.MAIL_FROM||SMTP.user; // online hosting: send email through Brevo's web API
const DEFAULT_MAX=20,TIMES=['09:00','10:00','11:00','13:00','14:00','15:00'];
const REQ={get:'Form 137 and PSA birth certificate',update:'Current prospectus and SOG (Summary of Grades)'};
let pool;const tokens=new Map();
const hash=(p,s=crypto.randomBytes(8).toString('hex'))=>s+':'+crypto.scryptSync(p,s,32).toString('hex');
const check=(p,h)=>hash(p,h.split(':')[0])===h;
const tx=!BREVO&&SMTP.user&&nodemailer.createTransport({service:'gmail',auth:SMTP});
if(BREVO)console.log('Email via Brevo API:',FROM);else if(!tx)console.log('WARNING: Email not set up. Set BREVO_API_KEY + MAIL_FROM (online) or GMAIL_USER + GMAIL_APP_PASSWORD (local).');else tx.verify().then(()=>console.log('Email ready:',SMTP.user)).catch(e=>console.log('EMAIL LOGIN FAILED:',e.message));
async function sendBrevo(to,subject,text){try{const r=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':BREVO,'content-type':'application/json'},body:JSON.stringify({sender:{name:'ICCT Queue',email:FROM},to:[{email:to}],subject,textContent:text})});if(!r.ok)console.log('Brevo failed:',r.status,await r.text())}catch(e){console.log('Brevo failed:',e.message)}}
async function mail(to,subject,text){console.log('EMAIL ->',to,'|',subject);if(BREVO&&to)return sendBrevo(to,subject,text);if(!tx||!to)return;try{await tx.sendMail({from:'ICCT Queue <'+SMTP.user+'>',to,subject,text})}catch(e){console.log('Email failed:',e.message)}}
const q=async(s,p)=>(await pool.query(s,p))[0];
const dates=()=>{const a=[];for(let i=0;a.length<14;i++){const d=new Date(Date.now()+i*864e5),w=d.getDay();if(w&&w<6)a.push(d.toLocaleDateString('en-CA'))}return a};
const auth=(...roles)=>(req,res,next)=>{const u=tokens.get(req.headers.authorization);if(!u||(roles.length&&!roles.includes(u.role)))return res.status(401).json({error:'Not allowed. Please log in.'});req.u=u;next()};
const wrap=f=>async(req,res)=>{try{res.json(await f(req))}catch(e){res.status(400).json({error:e.message||String(e)})}};
async function book(u,d,t,type,oldId){
 if(!dates().includes(d)||!TIMES.includes(t)||!REQ[type])throw 'Invalid date, time or request type.';
 const c=await pool.getConnection();
 try{await c.beginTransaction();
  if(oldId)await c.query("UPDATE appointments SET status='rescheduled' WHERE id=? AND user_id=? AND status='booked'",[oldId,u.id]);
  const[[ex]]=await c.query("SELECT COUNT(*) n FROM appointments WHERE user_id=? AND status='booked'",[u.id]);
  if(ex.n)throw 'You already have an active appointment. Cancel or reschedule it first.';
  await c.query('INSERT IGNORE INTO schedules(d,max_slots) VALUES(?,?)',[d,DEFAULT_MAX]);
  const[[s]]=await c.query('SELECT max_slots FROM schedules WHERE d=? FOR UPDATE',[d]);
  const[[a]]=await c.query("SELECT COALESCE(MAX(serial),0) mx,COALESCE(SUM(status NOT IN('cancelled','rescheduled')),0) n FROM appointments WHERE d=?",[d]);
  if(+a.n>=s.max_slots)throw 'That date is already full. Please choose another date.';
  const serial=+a.mx+1;
  const[r]=await c.query('INSERT INTO appointments(user_id,d,t,type,serial) VALUES(?,?,?,?,?)',[u.id,d,t,type,serial]);
  await c.commit();
  mail(u.email,'Appointment confirmed - Slot #'+serial,`Hi ${u.name},\n\nYour prospectus appointment is confirmed.\nDate: ${d} ${t}\nStudent no.: ${u.login}\nSlot number: ${serial}\n\nPlease bring: ${REQ[type]}`);
  return{id:r.insertId,serial}
 }catch(e){await c.rollback();throw e}finally{c.release()}}
const app=express();app.get('/health',(q,r)=>r.send('ok'));app.use(express.json(),express.static(__dirname+'/public'));
app.post('/api/register',wrap(async r=>{const{student_no,name,email,password}=r.body;
 if(!student_no||!name||!/\S+@\S+/.test(email||'')||(password||'').length<6)throw 'Fill in all fields (password min 6 characters).';
 try{await q('INSERT INTO users(role,login,name,email,pw) VALUES("student",?,?,?,?)',[student_no,name,email,hash(password)])}catch{throw 'Student number already registered.'}return{ok:1}}));
app.post('/api/login',async(req,res)=>{const[u]=await q('SELECT * FROM users WHERE login=?',[req.body.id]);
 if(!u||!check(req.body.password||'',u.pw))return res.status(401).json({error:'Wrong ID or password.'});
 const t=crypto.randomBytes(16).toString('hex'),user={id:u.id,role:u.role,login:u.login,name:u.name,email:u.email};tokens.set(t,user);res.json({token:t,user})});
app.get('/api/slots',auth(),wrap(async()=>{const ds=dates(),s=await q('SELECT d,max_slots FROM schedules WHERE d IN (?)',[ds]),
 c=await q("SELECT d,COUNT(*) n FROM appointments WHERE d IN (?) AND status NOT IN('cancelled','rescheduled') GROUP BY d",[ds]);
 return{times:TIMES,days:ds.map(d=>{const m=(s.find(x=>x.d==d)||{max_slots:DEFAULT_MAX}).max_slots,n=+(c.find(x=>x.d==d)||{}).n||0;return{d,max:m,left:Math.max(0,m-n)}})}}));
app.post('/api/book',auth('student'),wrap(r=>book(r.u,r.body.date,r.body.time,r.body.type)));
app.post('/api/reschedule/:id',auth('student'),wrap(async r=>{const[o]=await q('SELECT type FROM appointments WHERE id=? AND user_id=?',[r.params.id,r.u.id]);if(!o)throw 'Not found';return book(r.u,r.body.date,r.body.time,o.type,r.params.id)}));
app.post('/api/cancel/:id',auth('student'),wrap(async r=>{await q("UPDATE appointments SET status='cancelled' WHERE id=? AND user_id=? AND status='booked'",[r.params.id,r.u.id]);return{ok:1}}));
app.get('/api/my',auth('student'),wrap(r=>q('SELECT * FROM appointments WHERE user_id=? ORDER BY id DESC',[r.u.id])));
app.get('/api/queue',auth('staff','admin'),wrap(r=>q('SELECT a.id,a.serial,a.t,a.type,a.status,u.name,u.login FROM appointments a JOIN users u ON u.id=a.user_id WHERE a.d=? ORDER BY a.serial',[r.query.date])));
app.post('/api/status/:id',auth('staff','admin'),wrap(async r=>{if(!['served','missed','rescheduled'].includes(r.body.status))throw 'Bad status';await q('UPDATE appointments SET status=? WHERE id=?',[r.body.status,r.params.id]);return{ok:1}}));
app.post('/api/schedule',auth('admin'),wrap(async r=>{const m=+r.body.max;if(!r.body.date||!(m>=0))throw 'Enter a date and max slots.';await q('INSERT INTO schedules(d,max_slots) VALUES(?,?) ON DUPLICATE KEY UPDATE max_slots=?',[r.body.date,m,m]);return{ok:1}}));
app.get('/api/report',auth('admin'),wrap(()=>q("SELECT d,COUNT(*) total,SUM(status='served') served,SUM(status='missed') missed,SUM(status='cancelled') cancelled FROM appointments GROUP BY d ORDER BY d DESC LIMIT 60")));
app.post('/api/staff',auth('admin'),wrap(async r=>{const{login,name,password}=r.body;if(!login||!name||(password||'').length<6)throw 'Fill in all fields (password min 6).';
 try{await q('INSERT INTO users(role,login,name,email,pw) VALUES("staff",?,?,"",?)',[login,name,hash(password)])}catch{throw 'Login already exists.'}return{ok:1}}));
(async()=>{try{const c=await mysql.createConnection({...DB,database:undefined});await c.query('CREATE DATABASE IF NOT EXISTS '+DB.database);await c.end()}catch(e){console.log('Skipped CREATE DATABASE:',e.message)}
 pool=mysql.createPool({...DB,dateStrings:true});
 await q('CREATE TABLE IF NOT EXISTS users(id INT AUTO_INCREMENT PRIMARY KEY,role VARCHAR(10),login VARCHAR(40) UNIQUE,name VARCHAR(80),email VARCHAR(80),pw VARCHAR(200))');
 await q('CREATE TABLE IF NOT EXISTS schedules(d DATE PRIMARY KEY,max_slots INT)');
 await q("CREATE TABLE IF NOT EXISTS appointments(id INT AUTO_INCREMENT PRIMARY KEY,user_id INT,d DATE,t VARCHAR(5),type VARCHAR(10),serial INT,status VARCHAR(12) DEFAULT 'booked',reminded TINYINT DEFAULT 0,UNIQUE(d,serial))");
 for(const[r,l,n]of[['admin','admin','Administrator'],['staff','staff','Registrar Staff']])await q('INSERT IGNORE INTO users(role,login,name,email,pw) VALUES(?,?,?,"",?)',[r,l,n,hash(E[l.toUpperCase()+'_PASSWORD']||l+'123')]);
 setInterval(async()=>{const d=new Date(Date.now()+864e5).toLocaleDateString('en-CA');
  for(const a of await q("SELECT a.*,u.email,u.name,u.login FROM appointments a JOIN users u ON u.id=a.user_id WHERE a.d=? AND a.status='booked' AND a.reminded=0",[d])){
   await mail(a.email,'Reminder: appointment tomorrow - Slot #'+a.serial,`Hi ${a.name}, reminder: ${a.d} ${a.t}, slot #${a.serial}. Bring: ${REQ[a.type]}`);await q('UPDATE appointments SET reminded=1 WHERE id=?',[a.id])}},36e5);
 app.listen(E.PORT||3000,()=>console.log('Running on port '+(E.PORT||3000)))})().catch(e=>{console.error('Startup failed (is MySQL running in XAMPP?):',e.message)});
