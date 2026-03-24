# Azisai Official Website

A premium gambling affiliate website for Azisai with an Express backend serving real-time Roobet leaderboard data.

## Project Structure

- `index.html` — Home page (premium dark theme, affiliate card, countdown, stats widget, weekly bonus modal)
- `leaderboard/roobet/index.html` — Monthly Roobet leaderboard (podium, table, modals for rules/rewards/weekly, current/previous toggle)
- `notes/index.html` — Public Notes/Stories page (list + detail view, bilingual)
- `admin.html` — Admin panel (leaderboard viewer, custom stats, weekly rewards, notes CRUD)
- `css/leaderboard.css` — Shared premium CSS (Outfit + Space Grotesk fonts, animated orbs, particles, glass-morphism)
- `server.js` — Combined Express server (static files + leaderboard API + notes CRUD on port 5000)
- `data/notes.json` — Notes storage file (auto-created)
- `assets/` — Images and icons (logo.png, roobet.png, roobetlogo.png, roobet_crystal.png, kick.png, x.png, youtube.png, discord.png)

## Design System

- Fonts: Outfit (headings/body), Space Grotesk (labels/mono)
- Color palette: Primary blue (#4f7df7), Secondary purple (#8b6fff), Accent cyan (#00d4ff)
- Podium: Gold (#ffd700), Silver (#94a3b8), Bronze (#cd7f32)
- Background: Animated gradient orbs, hex grid overlay, CSS particle system
- All pages share `css/leaderboard.css` and use `data-i18n` attribute system for ja/en bilingual support
- Navigation: 3 tabs — Home, Leaderboard, Notes

## API Endpoints (port 5000)

### Monthly Leaderboard
- `GET /api/monthly/top14` — Top 14 players (index 0=2nd, index 1=1st swapped)
- `GET /api/monthly/leaderboard` — Full monthly leaderboard with rank
- `GET /api/monthly/current-range` — Current month date range
- `GET /api/monthly/previous-range` — Previous month date range

### Weekly Leaderboard
- `GET /api/weekly/top14` — Top 14 weekly players
- `GET /api/weekly/1000` — Players wagered $1k-$5k
- `GET /api/weekly/5000` — Players wagered $5k-$50k
- `GET /api/weekly/50000` — Players wagered $50k+

### Admin APIs (no auth — internal use only)
- `GET /api/admin/monthly/current` — Current month full leaderboard (unblurred names)
- `GET /api/admin/monthly/previous` — Previous month full leaderboard (unblurred names)
- `GET /api/admin/weekly/current` — Current week raw names by tier
- `GET /api/admin/weekly/previous` — Previous week raw names by tier
- `GET /api/admin/stats?startDate=&endDate=` — Custom date range stats query

### Notes CRUD
- `GET /api/notes` — List all notes (sorted newest first)
- `GET /api/notes/:id` — Get single note
- `POST /api/notes` — Create note (body: title, content, tags[])
- `PUT /api/notes/:id` — Update note
- `DELETE /api/notes/:id` — Delete note

## Reward Tiers (wager-based, not position-based)

| Wager | Reward |
|-------|--------|
| $2M+  | $10,000|
| $1M+  | $4,000 |
| $500K+| $1,500 |
| $300K+| $1,000 |
| $100K+| $500   |
| $50K+ | $200   |

## Key Features

- Pill-style navigation with Home/Leaderboard/Notes tabs
- Language toggle (Japanese default, English option)
- Animated countdown to month end (special June 2025 rule: ends July 31)
- Weekly countdown based on 2025-03-23T15:00:00Z (3/24 JST) rolling 7-day periods
- Current/Previous toggle on leaderboard page
- Draggable stats widget on home page (checks user rank/wager)
- 3D podium cards with crown animation, sheen effects, prize shimmer
- Modal system for rules, rewards, weekly bonus with winner lists
- Public Notes page with card list view and individual note detail
- Admin panel at /admin.html for managing leaderboard data, stats queries, weekly rewards, and notes

## Key Data Quirks

- Server index 0=2nd place, index 1=1st (swapped in cache). podiumOrder: idx:0→silver, idx:1→gold, idx:2→bronze
- Monthly countdown: July 31 2025 15:00 UTC (special May-June 2025 rule), else end-of-month at 15:00 UTC
- Roobet logo on leaderboard: `style="width:320px;height:auto;border-radius:0;"` inline override
- Social image files: `image-removebg-preview (86).png` and `image-removebg-preview (90).png` in root dir

## Running

```
npm install
node server.js
```

Data auto-refreshes from Roobet Connect API every 5 minutes.
