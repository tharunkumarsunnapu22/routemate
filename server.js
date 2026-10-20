require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------- CONFIG ----------
const PORT = process.env.PORT || 5000;
const DEMO_OTP = process.env.DEMO_OTP === "true";   // true: OTP shown on screen (testing only, no SMS)
const AUTO_APPROVE_DOCS = true;                      // true: documents are auto-marked verified (demo)

const HAS_SMS = !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_VERIFY_SID);
const verifySvc = HAS_SMS
  ? require("twilio")(process.env.TWILIO_SID, process.env.TWILIO_TOKEN).verify.v2.services(process.env.TWILIO_VERIFY_SID)
  : null;
if (!HAS_SMS && !DEMO_OTP) console.warn("WARNING: Twilio keys missing in .env - OTP login will not work. Set them or use DEMO_OTP=true for testing.");

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- PERSISTENT DB (db.json) ----------
const DB_FILE = path.join(__dirname, "db.json");
const UP = path.join(__dirname, "uploads");
if (!fs.existsSync(UP)) fs.mkdirSync(UP);
let db = { users: {}, sessions: {}, rides: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) {}
db.users = db.users || {}; db.sessions = db.sessions || {}; db.rides = db.rides || [];
let saveT;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db), () => {}), 200); };

// ---------- IN-MEMORY LIVE DATA ----------
const CAP = { bike: 1, auto: 3, eco: 4, sedan: 4, suv: 6 };
const TTL = 3 * 60 * 1000;           // search disappears if app is idle for 3 minutes
const listings = new Map();          // phone -> active search
const requests = new Map();          // id -> ride request
const locs = new Map();              // phone -> {lat,lng}
const notifs = {};                   // phone -> [{id,text,kind,t}]
const notified = new Set();          // "riderPhone|passengerPhone"
const otps = new Map();              // phone -> {code,exp,tries}   (demo mode only)
const sendLog = new Map();           // phone -> [timestamps of OTP requests]
const verifiedPhones = new Map();    // phone -> expiry (OTP already approved, waiting for name of new user)
let seq = 1, nseq = 1;

const ref = ph => crypto.createHash("sha1").update("ride" + ph).digest("hex").slice(0, 10);
const phoneOfRef = r => { for (const k of listings.keys()) if (ref(k) === r) return k; return null; };
const bookedFor = rp => db.rides.filter(r => r.riderPhone === rp && r.status === "booked");
const s1 = l => String(l || "").split(",")[0];
function notify(ph, text, kind) {
  (notifs[ph] = notifs[ph] || []).push({ id: nseq++, text, kind: kind || "info", t: Date.now() });
  if (notifs[ph].length > 40) notifs[ph].shift();
}

function hav(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function nearest(route, pt) {
  let bi = 0, bd = 1e9;
  route.forEach((c, i) => { const d = hav({ lat: c[0], lng: c[1] }, pt); if (d < bd) { bd = d; bi = i; } });
  return { i: bi, d: bd };
}
function isMatch(rider, pass) {
  if (rider.vehicle !== pass.vehicle) return false;
  if (pass.femaleOnly && rider.gender !== "female") return false;
  const a = nearest(rider.route, pass.pickup), b = nearest(rider.route, pass.drop);
  return a.d <= 0.7 && b.d <= 0.7 && a.i < b.i;   // same route + direction within 700m
}
function removeListing(ph) {
  listings.delete(ph);
  for (const [k, q] of requests) if ((q.passengerPhone === ph || q.riderPhone === ph) && q.status === "pending") requests.delete(k);
  for (const k of [...notified]) if (k.split("|").includes(ph)) notified.delete(k);
}
function clean() {
  const now = Date.now();
  for (const [ph, l] of listings) if (now - l.t > TTL) removeListing(ph);
}
const publicUser = u => ({
  phone: u.phone, name: u.name,
  doc: u.doc ? { verified: !!u.doc.verified, type: u.doc.type, vehicleType: u.doc.vehicleType, vehicleNo: u.doc.vehicleNo, upi: u.doc.upi || "" } : null
});

// ---------- AUTH ----------
const auth = (req, res, next) => {
  const t = (req.headers.authorization || "").replace("Bearer ", "");
  const ph = db.sessions[t];
  if (!ph || !db.users[ph]) return res.status(401).json({ error: "auth" });
  req.phone = ph; req.user = db.users[ph]; next();
};

// ----- SEND OTP (real SMS via Twilio Verify) -----
app.post("/api/auth/send", async (req, res) => {
  const phone = String((req.body || {}).phone || "");
  if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: "Enter a valid 10-digit mobile number" });

  const now = Date.now();
  const log = (sendLog.get(phone) || []).filter(t => now - t < 3600000);
  if (log.length && now - log[log.length - 1] < 30000) return res.status(429).json({ error: "Wait 30 seconds before requesting another OTP" });
  if (log.length >= 5) return res.status(429).json({ error: "Too many OTP requests. Try again after an hour." });
  log.push(now); sendLog.set(phone, log);
  verifiedPhones.delete(phone);

  if (DEMO_OTP) {
    const code = String(crypto.randomInt(100000, 1000000));
    otps.set(phone, { code, exp: now + 5 * 60 * 1000, tries: 0 });
    console.log(`DEMO OTP for ${phone}: ${code}`);
    return res.json({ ok: true, demoOtp: code });
  }
  if (!verifySvc) return res.status(500).json({ error: "SMS service is not configured" });
  try {
    await verifySvc.verifications.create({ to: "+91" + phone, channel: "sms" });
    res.json({ ok: true });
  } catch (e) {
    console.error("Twilio send error:", e.message);
    res.status(500).json({ error: "Could not send OTP. Please try again." });
  }
});

// ----- VERIFY OTP -----
app.post("/api/auth/verify", async (req, res) => {
  const { phone, code, name } = req.body || {};
  const ph = String(phone || "");
  if (!/^[6-9]\d{9}$/.test(ph)) return res.status(400).json({ error: "Enter a valid 10-digit mobile number" });

  const alreadyOk = (verifiedPhones.get(ph) || 0) > Date.now();   // OTP approved earlier, new user is now sending name
  if (!alreadyOk) {
    const c = String(code || "").trim();
    if (!/^\d{4,8}$/.test(c)) return res.status(400).json({ error: "Incorrect OTP" });
    try {
      let ok = false;
      if (DEMO_OTP) {
        const o = otps.get(ph);
        if (!o || Date.now() > o.exp) return res.status(400).json({ error: "OTP expired. Go back and request a new one." });
        if (++o.tries > 5) { otps.delete(ph); return res.status(429).json({ error: "Too many attempts. Request a new OTP." }); }
        ok = c === o.code;
        if (ok) otps.delete(ph);
      } else {
        if (!verifySvc) return res.status(500).json({ error: "SMS service is not configured" });
        const r = await verifySvc.verificationChecks.create({ to: "+91" + ph, code: c });
        ok = r.status === "approved";
      }
      if (!ok) return res.status(400).json({ error: "Incorrect OTP" });
    } catch (e) {
      if (e.status === 404) return res.status(400).json({ error: "OTP expired. Go back and request a new one." });
      if (e.code === 60202) return res.status(429).json({ error: "Too many attempts. Request a new OTP." });
      console.error("Twilio verify error:", e.message);
      return res.status(500).json({ error: "Could not verify OTP. Please try again." });
    }
    verifiedPhones.set(ph, Date.now() + 5 * 60 * 1000);
  }

  let u = db.users[ph];
  if (!u) {
    const nm = String(name || "").trim().slice(0, 30);
    if (!nm) return res.json({ needName: true });
    u = db.users[ph] = { phone: ph, name: nm, createdAt: Date.now(), doc: null };
  }
  verifiedPhones.delete(ph);
  const token = crypto.randomBytes(24).toString("hex");
  db.sessions[token] = ph;
  save();
  res.json({ token, user: publicUser(u) });
});

app.get("/api/me", auth, (req, res) => res.json(publicUser(req.user)));
app.post("/api/logout", auth, (req, res) => {
  const t = (req.headers.authorization || "").replace("Bearer ", "");
  delete db.sessions[t]; save(); res.json({ ok: true });
});

// ---------- RIDER DOCUMENT VERIFICATION ----------
app.post("/api/doc", auth, (req, res) => {
  const b = req.body || {};
  const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(b.image || "");
  if (!m) return res.status(400).json({ error: "Upload a photo of your document" });
  if (!b.docNumber || String(b.docNumber).length < 6) return res.status(400).json({ error: "Enter a valid document number" });
  if (!b.vehicleNo || String(b.vehicleNo).length < 4) return res.status(400).json({ error: "Enter your vehicle number" });
  if (!CAP[b.vehicleType]) return res.status(400).json({ error: "Choose a vehicle type" });
  if (b.upi && !/^[\w.\-]{2,}@[\w]{2,}$/.test(b.upi)) return res.status(400).json({ error: "UPI ID looks invalid (example: name@upi)" });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: "Image is too large" });
  const fn = `${req.phone}-${Date.now()}.${m[1] === "png" ? "png" : "jpg"}`;
  fs.writeFileSync(path.join(UP, fn), buf);
  req.user.doc = {
    type: String(b.docType || "Driving Licence").slice(0, 30), number: String(b.docNumber).slice(0, 30),
    vehicleType: b.vehicleType, vehicleNo: String(b.vehicleNo).slice(0, 15), upi: b.upi ? String(b.upi).slice(0, 60) : "",
    image: fn, verified: AUTO_APPROVE_DOCS, submittedAt: Date.now(), verifiedAt: AUTO_APPROVE_DOCS ? Date.now() : null
  };
  save();
  res.json({ ok: true, verified: AUTO_APPROVE_DOCS });
});

// ---------- SEARCH LISTING + MATCH NOTIFICATIONS ----------
app.post("/api/listing", auth, (req, res) => {
  const b = req.body || {};
  const role = b.role === "rider" ? "rider" : "passenger";
  const okPt = p => p && isFinite(p.lat) && isFinite(p.lng) && typeof p.label === "string";
  if (!okPt(b.pickup) || !okPt(b.drop) || !Array.isArray(b.route) || b.route.length < 2 || b.route.length > 400)
    return res.status(400).json({ error: "Invalid locations" });
  let vehicle = CAP[b.vehicle] ? b.vehicle : "bike";
  if (role === "rider") {
    if (!req.user.doc || !req.user.doc.verified) return res.status(403).json({ error: "doc" });
    vehicle = req.user.doc.vehicleType;
  }
  removeListing(req.phone);
  const l = {
    phone: req.phone, name: req.user.name, role, vehicle,
    gender: b.gender === "female" ? "female" : "male",
    femaleOnly: role === "passenger" && !!b.femaleOnly,
    pickup: { lat: +b.pickup.lat, lng: +b.pickup.lng, label: b.pickup.label.slice(0, 160) },
    drop: { lat: +b.drop.lat, lng: +b.drop.lng, label: b.drop.label.slice(0, 160) },
    route: b.route.map(c => [+c[0], +c[1]]),
    fare: Math.max(0, Math.min(100000, Math.round(+b.fare || 0))),
    pay: b.pay === "upi" ? "upi" : "cash",
    t: Date.now()
  };
  listings.set(req.phone, l);
  for (const o of listings.values()) {
    if (o.phone === l.phone || o.role === l.role) continue;
    const rider = l.role === "rider" ? l : o, pass = l.role === "rider" ? o : l;
    if (pass.rideId || !isMatch(rider, pass)) continue;
    if (bookedFor(rider.phone).length >= CAP[rider.vehicle]) continue;
    const key = rider.phone + "|" + pass.phone;
    if (notified.has(key)) continue;
    notified.add(key);
    notify(rider.phone, `${pass.name} wants a ride on your route: ${s1(pass.pickup.label)} → ${s1(pass.drop.label)} (₹${pass.fare})`, "match");
    notify(pass.phone, `${rider.name} is riding on your route. Open the app and request the ride.`, "match");
  }
  res.json({ ok: true });
});
app.post("/api/listing/cancel", auth, (req, res) => { removeListing(req.phone); res.json({ ok: true }); });

function ridePayload(r, ph) {
  const isP = r.passengerPhone === ph, pp = isP ? r.riderPhone : r.passengerPhone, u = db.users[pp] || {};
  return {
    id: r.id, role: isP ? "passenger" : "rider", status: r.status, fare: r.fare, pay: r.pay, payStatus: r.payStatus,
    vehicle: r.vehicle, pickup: r.pickup, drop: r.drop,
    partner: { name: u.name || "User", phone: pp, loc: locs.get(pp) || null,
      upi: isP && u.doc ? u.doc.upi || "" : "", vehicleNo: isP && u.doc ? u.doc.vehicleNo || "" : "" }
  };
}

// ---------- POLLING ENDPOINT: state, notifs, matches, inbox, rides ----------
app.get("/api/state", auth, (req, res) => {
  clean();
  const ph = req.phone, since = +req.query.since || 0;
  const me = listings.get(ph);
  const out = { notifs: (notifs[ph] || []).filter(n => n.id > since), listing: null, matches: [], inbox: [], rides: [] };
  if (me) {
    me.t = Date.now();
    out.listing = { role: me.role, vehicle: me.vehicle, pickup: me.pickup.label, drop: me.drop.label, fare: me.fare, pay: me.pay };
    for (const o of listings.values()) {
      if (o.phone === ph || o.role === me.role) continue;
      const rider = me.role === "rider" ? me : o, pass = me.role === "rider" ? o : me;
      const rq = [...requests.values()].find(r => r.passengerPhone === pass.phone && r.riderPhone === rider.phone && r.status !== "cancelled");
      if (pass.rideId && !(rq && rq.status === "accepted")) continue;
      if (!isMatch(rider, pass)) continue;
      if (bookedFor(rider.phone).length >= CAP[rider.vehicle] && !(rq && rq.status === "accepted")) continue;
      const item = { ref: ref(o.phone), name: o.name, gender: o.gender, vehicle: o.vehicle, status: rq ? rq.status : null };
      if (me.role === "passenger") {
        item.upi = !!(db.users[o.phone].doc && db.users[o.phone].doc.upi);
        item.inside = bookedFor(o.phone).map(r => r.passengerGender);
      } else {
        item.pickup = o.pickup.label; item.drop = o.drop.label; item.fare = o.fare; item.pay = o.pay; item.femaleOnly = o.femaleOnly;
      }
      out.matches.push(item);
    }
    if (me.role === "rider")
      out.inbox = [...requests.values()].filter(r => r.riderPhone === ph && r.status === "pending").map(r => ({
        id: r.id, name: r.passengerName, gender: r.passengerGender, pickup: r.pickup.label, drop: r.drop.label,
        fare: r.fare, pay: r.pay, femaleOnly: r.femaleOnly }));
  }
  out.rides = db.rides.filter(r => r.status === "booked" && (r.riderPhone === ph || r.passengerPhone === ph)).map(r => ridePayload(r, ph));
  res.json(out);
});

// ---------- REQUEST / RESPOND / COMPLETE / CANCEL ----------
app.post("/api/request", auth, (req, res) => {
  const p = listings.get(req.phone), rph = phoneOfRef((req.body || {}).ref), r = rph && listings.get(rph);
  if (!p || p.role !== "passenger" || !r || r.role !== "rider" || !isMatch(r, p)) return res.status(400).json({ error: "This rider is no longer available" });
  if (p.rideId) return res.status(409).json({ error: "You already have a booked ride" });
  if (p.pay === "upi" && !(db.users[rph].doc && db.users[rph].doc.upi)) return res.status(400).json({ error: "This rider accepts cash only" });
  if (bookedFor(rph).length >= CAP[r.vehicle]) return res.status(409).json({ error: "The vehicle is full" });
  let ex = [...requests.values()].find(x => x.passengerPhone === p.phone && x.riderPhone === rph && (x.status === "pending" || x.status === "accepted"));
  if (!ex) {
    ex = { id: seq++, passengerPhone: p.phone, riderPhone: rph, passengerName: p.name, passengerGender: p.gender, femaleOnly: p.femaleOnly,
      pickup: p.pickup, drop: p.drop, fare: p.fare, pay: p.pay, status: "pending" };
    requests.set(ex.id, ex);
    notify(rph, `${p.name} requested a ride: ${s1(p.pickup.label)} → ${s1(p.drop.label)}, ₹${p.fare}, pays by ${p.pay === "upi" ? "UPI" : "cash"}`, "request");
  }
  res.json({ ok: true });
});

app.post("/api/respond", auth, (req, res) => {
  const q = requests.get(+(req.body || {}).id);
  if (!q || q.riderPhone !== req.phone || q.status !== "pending") return res.status(400).json({ error: "Request not found" });
  if (!req.body.accept) {
    q.status = "rejected";
    notify(q.passengerPhone, `${req.user.name} declined your request`, "info");
    return res.json({ ok: true });
  }
  const rl = listings.get(req.phone), pl = listings.get(q.passengerPhone);
  if (!rl || !pl || pl.rideId) return res.status(409).json({ error: "Passenger is no longer available" });
  if (bookedFor(req.phone).length >= CAP[rl.vehicle]) return res.status(409).json({ error: "Your vehicle is full" });
  const ride = {
    id: "R" + Date.now().toString(36) + Math.floor(Math.random() * 99),
    riderPhone: req.phone, passengerPhone: q.passengerPhone, riderName: req.user.name, passengerName: q.passengerName,
    passengerGender: q.passengerGender, vehicle: rl.vehicle, pickup: pl.pickup, drop: pl.drop, fare: q.fare, pay: q.pay,
    payStatus: "pending", status: "booked", createdAt: Date.now()
  };
  db.rides.push(ride); q.status = "accepted"; q.rideId = ride.id; pl.rideId = ride.id; save();
  notify(q.passengerPhone, `Ride booked! ${req.user.name} will pick you up. Pay ₹${ride.fare} by ${ride.pay === "upi" ? "UPI" : "cash"} to the rider.`, "booked");
  notify(req.phone, `You accepted ${q.passengerName}. Collect ₹${ride.fare} (${ride.pay === "upi" ? "UPI" : "cash"}).`, "booked");
  res.json({ ok: true });
});

const myRide = (req, st) => {
  const r = db.rides.find(x => x.id === (req.body || {}).id);
  return r && r.status === "booked" && (r.riderPhone === req.phone || r.passengerPhone === req.phone) ? r : null;
};
app.post("/api/ride/pay", auth, (req, res) => {
  const r = myRide(req);
  if (!r || r.passengerPhone !== req.phone || r.pay !== "upi") return res.status(400).json({ error: "Not allowed" });
  r.payStatus = "paid_claimed"; save();
  notify(r.riderPhone, `${r.passengerName} says they paid ₹${r.fare} by UPI. Please confirm in your UPI app.`, "pay");
  res.json({ ok: true });
});
app.post("/api/ride/complete", auth, (req, res) => {
  const r = myRide(req);
  if (!r || r.riderPhone !== req.phone) return res.status(400).json({ error: "Not allowed" });
  r.status = "completed"; r.completedAt = Date.now(); r.payStatus = req.body.received ? "paid" : "unpaid"; save();
  removeListing(r.passengerPhone);
  notify(r.passengerPhone, `Ride completed. Fare ₹${r.fare} (${r.pay === "upi" ? "UPI" : "cash"}). Thank you!`, "done");
  res.json({ ok: true });
});
app.post("/api/ride/cancel", auth, (req, res) => {
  const r = myRide(req);
  if (!r) return res.status(400).json({ error: "Not allowed" });
  r.status = "cancelled"; r.cancelledBy = req.phone; save();
  for (const q of requests.values()) if (q.rideId === r.id) q.status = "cancelled";
  const pl = listings.get(r.passengerPhone); if (pl) delete pl.rideId;
  const other = r.riderPhone === req.phone ? r.passengerPhone : r.riderPhone;
  notify(other, `${req.user.name} cancelled the ride`, "info");
  res.json({ ok: true });
});

app.post("/api/location", auth, (req, res) => {
  const { lat, lng } = req.body || {};
  if (isFinite(lat) && isFinite(lng)) locs.set(req.phone, { lat: +lat, lng: +lng });
  res.json({ ok: true });
});

app.get("/api/history", auth, (req, res) => {
  const ph = req.phone;
  const list = db.rides.filter(r => r.riderPhone === ph || r.passengerPhone === ph).slice().reverse().slice(0, 100).map(r => {
    const isP = r.passengerPhone === ph;
    return { id: r.id, role: isP ? "passenger" : "rider", status: r.status, fare: r.fare, pay: r.pay, payStatus: r.payStatus,
      pickup: r.pickup.label, drop: r.drop.label, vehicle: r.vehicle,
      partner: isP ? r.riderName : r.passengerName, createdAt: r.createdAt, completedAt: r.completedAt || null };
  });
  res.json({ rides: list });
});

app.listen(PORT, () => console.log("Running at http://localhost:" + PORT));
