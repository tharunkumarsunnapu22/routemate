# RouteMate 🚗🛵

A modern peer-to-peer ride-pooling web app connecting riders and passengers on shared routes. Features individual seat pricing, live route matching, female-safety visibility, instant temple/building search, real-time GPS tracking across bikes, autos, and cabs, and strict SMS OTP authentication.

## 🎨 Theme & UI
- **Design System:** Deep Purple Glass & Light Red Shade (`--primary: #9333EA`, `--accent: #FB7185`)
- **Navigation:** 4 Bottom Navigation tabs (`Ride`, `Travel History`, `Travel`, `Profile`)
- **Live Travel:** Popular city hotspots, active ride telemetry, and dedicated Emergency SOS dials (112, 1091).

## 📱 Real SMS OTP Authentication
RouteMate features production-ready mobile login with strict SMS verification:
- **No hardcoded demo phone numbers or codes**: Users input their actual 10-digit mobile number.
- **Strict Verification**: Login is only granted upon entering the exact 6-digit OTP code received via SMS; invalid attempts display an immediate `"Incorrect OTP"` message and block access.
- **Persistent Profiles & History**: Existing accounts automatically restore ride history and verification status; new phone numbers are prompted for user registration.

### Configuring Real SMS Delivery
To have SMS verification codes sent directly to your mobile phone, RouteMate supports India's leading SMS gateways without any complex DLT setup:

1. **Fast2SMS (Recommended for India)**:
   - Create a free account at [fast2sms.com](https://www.fast2sms.com) and copy your Dev API Key.
   - Open `sms_config.json` and paste your key:
     ```json
     {
       "provider": "fast2sms",
       "fast2sms_api_key": "YOUR_FAST2SMS_API_KEY"
     }
     ```
   - Alternatively set environment variable: `FAST2SMS_API_KEY="YOUR_KEY"`

2. **2Factor.in**:
   - Paste your API key under `"two_factor_api_key"` in `sms_config.json`.

3. **Twilio**:
   - Enter your `account_sid`, `auth_token`, and `from_phone` in `sms_config.json`.

*(Note: If no API key is entered, OTPs are safely logged to the server terminal for local development, and are never exposed to the client browser).*

## Tech Stack
- **Frontend:** Vanilla HTML5, CSS3, JavaScript, Leaflet with high-DPI Mapbox Dark-v11 tiles
- **Backend:** Node.js (v20+), Express, In-memory route matching engine, Geodesic distance routing
- **Storage:** Lightweight JSON persistence (`db.json`) for accounts, sessions, and travel records
- **APIs:** Mapbox Geocoding & Static Tiles, Open-Meteo, OSRM (Open Source Routing Machine), Fast2SMS / 2Factor / Twilio

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
