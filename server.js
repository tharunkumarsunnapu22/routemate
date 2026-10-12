const express = require("express");
const path = require("path");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const listings = new Map();   // clientId -> listing
const requests = new Map();   // id -> request
const locations = new Map();  // clientId -> {lat,lng}
let seq = 1;
const CAP = { bike: 1, auto: 3, eco: 4, sedan: 4, suv: 6 };
const TTL = 30 * 60 * 1000;

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
function clean() {
  const now = Date.now();
  for (const [k, v] of listings) if (now - v.t > TTL) listings.delete(k);
}
const accepted = riderId => [...requests.values()].filter(r => r.riderId === riderId && r.status === "accepted");
function removeClient(id) {
  listings.delete(id); locations.delete(id);
  for (const [k, r] of requests) if (r.passengerId === id || r.riderId === id) requests.delete(k);
}

app.post("/api/listing", (req, res) => {
  const b = req.body;
  if (!b.clientId || !Array.isArray(b.route) || b.route.length < 2 || !b.pickup || !b.drop)
    return res.status(400).json({ error: "bad request" });
  removeClient(b.clientId);
  listings.set(b.clientId, {
    clientId: b.clientId,
    name: String(b.name || "User").slice(0, 30),
    role: b.role === "rider" ? "rider" : "passenger",
    gender: b.gender === "female" ? "female" : "male",
    vehicle: CAP[b.vehicle] ? b.vehicle : "bike",
    femaleOnly: !!b.femaleOnly,
    pickup: b.pickup, drop: b.drop,
    route: b.route.slice(0, 300),
    t: Date.now()
  });
  res.json({ ok: true });
});

app.get("/api/matches", (req, res) => {
  clean();
  const me = listings.get(req.query.clientId);
  if (!me) return res.json({ matches: [] });
  const out = [];
  for (const o of listings.values()) {
    if (o.clientId === me.clientId || o.role === me.role) continue;
    const rider = me.role === "rider" ? me : o;
    const pass = me.role === "rider" ? o : me;
    if (rider.vehicle !== pass.vehicle) continue;
    if (pass.femaleOnly && rider.gender !== "female") continue;
    const rq = [...requests.values()].find(r => r.passengerId === pass.clientId && r.riderId === rider.clientId);
    if (accepted(rider.clientId).length >= CAP[rider.vehicle] && !(rq && rq.status === "accepted")) continue;
    const a = nearest(rider.route, pass.pickup), b = nearest(rider.route, pass.drop);
    if (a.d > 0.7 || b.d > 0.7 || a.i >= b.i) continue;
    out.push({
      id: o.clientId, name: o.name, gender: o.gender, vehicle: o.vehicle, femaleOnly: o.femaleOnly,
      inside: accepted(rider.clientId).map(r => r.passengerGender),
      status: rq ? rq.status : null
    });
  }
  res.json({ matches: out });
});

app.post("/api/request", (req, res) => {
  const { clientId, targetId } = req.body;
  const p = listings.get(clientId), r = listings.get(targetId);
  if (!p || !r || p.role !== "passenger" || r.role !== "rider") return res.status(400).json({ error: "bad request" });
  if (accepted(targetId).length >= CAP[r.vehicle]) return res.status(409).json({ error: "full" });
  let ex = [...requests.values()].find(x => x.passengerId === clientId && x.riderId === targetId);
  if (!ex) {
    ex = { id: seq++, passengerId: clientId, riderId: targetId, passengerName: p.name, passengerGender: p.gender, status: "pending" };
    requests.set(ex.id, ex);
  }
  res.json({ ok: true });
});

app.get("/api/inbox", (req, res) => {
  const id = req.query.clientId;
  res.json({ requests: [...requests.values()].filter(r => r.riderId === id && r.status === "pending") });
});

app.post("/api/respond", (req, res) => {
  const { clientId, requestId, accept } = req.body;
  const r = requests.get(requestId);
  if (!r || r.riderId !== clientId) return res.status(400).json({ error: "bad request" });
  const rider = listings.get(clientId);
  if (accept && rider && accepted(clientId).length >= CAP[rider.vehicle]) return res.status(409).json({ error: "full" });
  r.status = accept ? "accepted" : "rejected";
  res.json({ ok: true });
});

app.post("/api/location", (req, res) => {
  const { clientId, lat, lng } = req.body;
  if (clientId && isFinite(lat) && isFinite(lng)) locations.set(clientId, { lat, lng });
  res.json({ ok: true });
});
app.get("/api/ride", (req, res) => {
  const id = req.query.clientId;
  const acc = [...requests.values()].filter(r => r.status === "accepted" && (r.passengerId === id || r.riderId === id));
  const partners = acc.map(r => {
    const pid = r.passengerId === id ? r.riderId : r.passengerId;
    const l = listings.get(pid);
    return { id: pid, name: r.passengerId === id ? (l ? l.name : "Rider") : r.passengerName, loc: locations.get(pid) || null };
  });
  res.json({ partners });
});

app.post("/api/cancel", (req, res) => { if (req.body && req.body.clientId) removeClient(req.body.clientId); res.json({ ok: true }); });

app.listen(5000, () => console.log("Running at http://localhost:5000"));

