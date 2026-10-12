# RouteMate

A smart peer-to-peer ride-pooling web app connecting riders and passengers on shared routes. Features individual seat pricing, live route matching, female-safety visibility, instant temple/building search, and real-time GPS tracking across bikes, autos, and cars.

## Tech Stack
- **Frontend:** Vanilla HTML5, CSS3, JavaScript, Leaflet with high-DPI Mapbox Dark-v11 tiles
- **Backend:** Node.js, Express, In-memory matching engine, Geodesic distance routing
- **APIs:** Mapbox Geocoding & Static Tiles, Open-Meteo, OSRM (Open Source Routing Machine)

## Getting Started

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the server:**
   ```bash
   node server.js
   ```

3. **Open the app:**
   Navigate to [http://localhost:5000](http://localhost:5000) in your browser.
