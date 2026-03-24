const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 5000;

const multer = require("multer");

app.use(cors());
app.use(express.json());

/* ─── ADMIN AUTH (password + Telegram 2FA) ──────────────────────────────── */

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || "").split(",").filter(Boolean);

const SESSIONS_FILE = path.join(__dirname, "data", "admin-sessions.json");
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
      const now = Date.now();
      const m = new Map();
      for (const [k, v] of Object.entries(raw)) {
        if (now <= v.expiresAt) m.set(k, v);
      }
      return m;
    }
  } catch (e) { console.error("Failed to load sessions:", e.message); }
  return new Map();
}
function saveSessions() {
  try {
    const dir = path.dirname(SESSIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = {};
    for (const [k, v] of adminSessions) obj[k] = v;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
  } catch (e) { console.error("Failed to save sessions:", e.message); }
}

const adminSessions = loadSessions();
const pendingCodes = new Map();
const loginAttempts = new Map();

const SESSION_TTL = 24 * 60 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW = 15 * 60 * 1000;

function cleanExpired() {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of adminSessions) { if (now > v.expiresAt) { adminSessions.delete(k); changed = true; } }
  for (const [k, v] of pendingCodes) { if (now > v.expiresAt) pendingCodes.delete(k); }
  for (const [k, v] of loginAttempts) { if (now > v.resetAt) loginAttempts.delete(k); }
  if (changed) saveSessions();
}
setInterval(cleanExpired, 60 * 1000);

function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW });
    return true;
  }
  if (record.count >= MAX_ATTEMPTS) return false;
  record.count++;
  return true;
}

async function sendTelegramCode(code) {
  const msg = `🔐 AZISAI Admin Login Code: ${code}\nValid for 5 minutes.`;
  const results = [];
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: Number(chatId.trim()),
        text: msg,
      });
      results.push({ chatId, sent: true });
    } catch (e) {
      const errData = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      console.error(`Telegram send error (${chatId}):`, errData);
      results.push({ chatId, sent: false });
    }
  }
  return results;
}

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const session = adminSessions.get(token);
  if (!session || Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    saveSessions();
    return res.status(401).json({ error: "Session expired" });
  }
  next();
}

app.post("/api/admin/login", async (req, res) => {
  const ip = getClientIP(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const code = crypto.randomInt(100000, 999999).toString();
  const sessionKey = crypto.randomBytes(32).toString("hex");
  pendingCodes.set(sessionKey, { code, expiresAt: Date.now() + CODE_TTL, ip });
  const results = await sendTelegramCode(code);
  const anySent = results.some(r => r.sent);
  if (!anySent) {
    pendingCodes.delete(sessionKey);
    return res.status(500).json({ error: "Failed to send verification code" });
  }
  res.json({ sessionKey, message: "Code sent to Telegram" });
});

app.post("/api/admin/verify", (req, res) => {
  const ip = getClientIP(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }
  const { sessionKey, code } = req.body;
  if (!sessionKey || !code) return res.status(400).json({ error: "Missing fields" });
  const pending = pendingCodes.get(sessionKey);
  if (!pending) return res.status(401).json({ error: "Invalid or expired session" });
  if (Date.now() > pending.expiresAt) {
    pendingCodes.delete(sessionKey);
    return res.status(401).json({ error: "Code expired" });
  }
  if (pending.code !== String(code).trim()) {
    return res.status(401).json({ error: "Invalid code" });
  }
  pendingCodes.delete(sessionKey);
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, { ip: pending.ip, expiresAt: Date.now() + SESSION_TTL });
  saveSessions();
  loginAttempts.delete(ip);
  res.json({ token });
});

app.get("/api/admin/session", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!token) return res.json({ valid: false });
  const session = adminSessions.get(token);
  if (!session || Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    saveSessions();
    return res.json({ valid: false });
  }
  res.json({ valid: true });
});

app.post("/api/admin/logout", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (token) { adminSessions.delete(token); saveSessions(); }
  res.json({ success: true });
});

const uploadsDir = path.join(__dirname, "data", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

app.post("/api/upload", requireAdmin, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No valid image" });
  res.json({ url: "/data/uploads/" + req.file.filename });
});

app.use("/data/uploads", express.static(uploadsDir));

const apiUrl = "https://roobetconnect.com/affiliate/v2/stats";
const apiKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjI2YWU0ODdiLTU3MDYtNGE3ZS04YTY5LTMzYThhOWM5NjMxYiIsIm5vbmNlIjoiZWI2MzYyMWUtMTMwZi00ZTE0LTlmOWMtOTY3MGNiZGFmN2RiIiwic2VydmljZSI6ImFmZmlsaWF0ZVN0YXRzIiwiaWF0IjoxNzI3MjQ2NjY1fQ.rVG_QKMcycBEnzIFiAQuixfu6K_oEkAq2Y8Gukco3b8";
const userId = "26ae487b-5706-4a7e-8a69-33a8a9c9631b";

const formatUsername = (username) => {
  const firstTwo = username.slice(0, 2);
  const lastTwo = username.slice(-2);
  return `${firstTwo}***${lastTwo}`;
};

/* ─── WEEKLY CYCLE: 3/25 JST = 3/24 15:00 UTC, rolling 7 days ───────────── */

const WEEKLY_BASE_UTC = new Date("2025-03-24T15:00:00.000Z");

function getWeeklyWindow(offset) {
  const now = new Date();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const timePassed = now - WEEKLY_BASE_UTC;
  const weeksPassed = Math.floor(timePassed / weekMs);
  const targetWeek = weeksPassed + (offset || 0);
  const start = new Date(WEEKLY_BASE_UTC.getTime() + targetWeek * weekMs);
  const end = new Date(start.getTime() + weekMs - 1);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

/* ─── MONTHLY LEADERBOARD ─────────────────────────────────────────────────── */

let monthlyCache = [];
let monthlyTop14Cache = [];
let previousMonthlyTop14Cache = [];
let previousMonthlyCache = [];

function getMonthlyDateRange() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const jstYear = jstNow.getUTCFullYear();
  const jstMonth = jstNow.getUTCMonth();

  if (jstYear === 2025 && (jstMonth === 5 || jstMonth === 6)) {
    return {
      startDate: "2025-05-31T15:01:00.000Z",
      endDate: "2025-07-31T15:00:00.000Z",
    };
  }

  const year = jstYear;
  const month = jstMonth;
  const getLastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  const prevMonth = month - 1 < 0 ? 11 : month - 1;
  const prevYear = month - 1 < 0 ? year - 1 : year;

  const startDate = new Date(Date.UTC(prevYear, prevMonth, getLastDay(prevYear, prevMonth), 15, 1, 0));
  const endDate = new Date(Date.UTC(year, month, getLastDay(year, month), 15, 0, 0));

  return { startDate: startDate.toISOString(), endDate: endDate.toISOString() };
}

function getPreviousMonthlyDateRange() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const jstYear = jstNow.getUTCFullYear();
  const jstMonth = jstNow.getUTCMonth();

  const getLastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  let curStartMonth = jstMonth - 1 < 0 ? 11 : jstMonth - 1;
  let curStartYear = jstMonth - 1 < 0 ? jstYear - 1 : jstYear;

  let prevEndMonth = curStartMonth;
  let prevEndYear = curStartYear;

  let prevStartMonth = prevEndMonth - 1 < 0 ? 11 : prevEndMonth - 1;
  let prevStartYear = prevEndMonth - 1 < 0 ? prevEndYear - 1 : prevEndYear;

  const startDate = new Date(Date.UTC(prevStartYear, prevStartMonth, getLastDay(prevStartYear, prevStartMonth), 15, 1, 0));
  const endDate = new Date(Date.UTC(prevEndYear, prevEndMonth, getLastDay(prevEndYear, prevEndMonth), 15, 0, 0));

  return { startDate: startDate.toISOString(), endDate: endDate.toISOString() };
}

async function fetchMonthlyData() {
  try {
    const { startDate, endDate } = getMonthlyDateRange();

    const response = await axios.get(apiUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { userId, startDate, endDate },
    });

    const data = response.data;
    const sorted = data
      .filter((p) => p.username !== "azisai205")
      .sort((a, b) => b.weightedWagered - a.weightedWagered);

    monthlyCache = sorted.map((p, i) => ({
      rank: i + 1,
      username: p.username,
      wagered: Math.round(p.wagered),
      weightedWager: Math.round(p.weightedWagered),
    }));

    const above100k = sorted.filter((p) => p.weightedWagered >= 100000);
    const top = above100k.length >= 10 ? above100k : sorted.slice(0, 10);

    monthlyTop14Cache = top.map((p) => ({
      username: formatUsername(p.username),
      wagered: Math.round(p.wagered),
      weightedWager: Math.round(p.weightedWagered),
    }));

    if (monthlyTop14Cache.length >= 2) {
      [monthlyTop14Cache[0], monthlyTop14Cache[1]] = [monthlyTop14Cache[1], monthlyTop14Cache[0]];
    }

    console.log(`[${new Date().toISOString()}] ✅ Monthly leaderboard updated: ${sorted.length} entries`);
  } catch (err) {
    console.error("❌ Monthly fetch error:", err.message);
  }
}

async function fetchPreviousMonthlyData() {
  try {
    const { startDate, endDate } = getPreviousMonthlyDateRange();

    const response = await axios.get(apiUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { userId, startDate, endDate },
    });

    const data = response.data;
    const sorted = data
      .filter((p) => p.username !== "azisai205")
      .sort((a, b) => b.weightedWagered - a.weightedWagered);

    previousMonthlyCache = sorted.map((p, i) => ({
      rank: i + 1,
      username: p.username,
      wagered: Math.round(p.wagered),
      weightedWager: Math.round(p.weightedWagered),
    }));

    const above100k = sorted.filter((p) => p.weightedWagered >= 100000);
    const top = above100k.length >= 10 ? above100k : sorted.slice(0, 10);

    previousMonthlyTop14Cache = top.map((p) => ({
      username: formatUsername(p.username),
      wagered: Math.round(p.wagered),
      weightedWager: Math.round(p.weightedWagered),
    }));

    if (previousMonthlyTop14Cache.length >= 2) {
      [previousMonthlyTop14Cache[0], previousMonthlyTop14Cache[1]] = [previousMonthlyTop14Cache[1], previousMonthlyTop14Cache[0]];
    }

    console.log(`[${new Date().toISOString()}] ✅ Previous monthly leaderboard updated: ${sorted.length} entries`);
  } catch (err) {
    console.error("❌ Previous monthly fetch error:", err.message);
  }
}

/* ─── WEEKLY LEADERBOARD ──────────────────────────────────────────────────── */

let weeklyCache = [];
let weeklyRawCache = [];
let previousWeeklyCache = [];
let previousWeeklyRawCache = [];

async function fetchWeeklyData() {
  try {
    const { startDate, endDate } = getWeeklyWindow(0);

    const response = await axios.get(apiUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { userId, startDate, endDate },
    });

    const sorted = response.data
      .filter((p) => p.username !== "azisai205")
      .sort((a, b) => b.weightedWagered - a.weightedWagered);

    weeklyRawCache = sorted.map((p) => ({
      username: p.username,
      wagered: Math.round(p.weightedWagered),
      weightedWager: Math.round(p.weightedWagered),
    }));

    weeklyCache = sorted.map((p) => ({
      username: formatUsername(p.username),
      wagered: Math.round(p.weightedWagered),
      weightedWager: Math.round(p.weightedWagered),
    }));

    console.log(`[${new Date().toISOString()}] ✅ Weekly leaderboard updated: ${weeklyCache.length} entries`);
  } catch (err) {
    console.error("❌ Weekly fetch error:", err.message);
  }
}

async function fetchPreviousWeeklyData() {
  try {
    const { startDate, endDate } = getWeeklyWindow(-1);

    const response = await axios.get(apiUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { userId, startDate, endDate },
    });

    const sorted = response.data
      .filter((p) => p.username !== "azisai205")
      .sort((a, b) => b.weightedWagered - a.weightedWagered);

    previousWeeklyRawCache = sorted.map((p) => ({
      username: p.username,
      wagered: Math.round(p.weightedWagered),
      weightedWager: Math.round(p.weightedWagered),
    }));

    previousWeeklyCache = sorted.map((p) => ({
      username: formatUsername(p.username),
      wagered: Math.round(p.weightedWagered),
      weightedWager: Math.round(p.weightedWagered),
    }));

    console.log(`[${new Date().toISOString()}] ✅ Previous weekly leaderboard updated: ${sorted.length} entries`);
  } catch (err) {
    console.error("❌ Previous weekly fetch error:", err.message);
  }
}

/* ─── API ROUTES ──────────────────────────────────────────────────────────── */

app.get("/api/monthly/leaderboard", (req, res) => res.json(monthlyCache));

app.get("/api/monthly/top14", (req, res) => res.json(monthlyTop14Cache.slice(0, 14)));

app.get("/api/monthly/previous/top14", (req, res) => res.json(previousMonthlyTop14Cache.slice(0, 14)));

app.get("/api/monthly/current-range", (req, res) => {
  const { startDate, endDate } = getMonthlyDateRange();
  res.json({ startDate, endDate });
});

app.get("/api/monthly/previous-range", (req, res) => {
  const { startDate, endDate } = getPreviousMonthlyDateRange();
  res.json({ startDate, endDate });
});

app.get("/api/user/stats", (req, res) => {
  const username = (req.query.username || "").trim().toLowerCase();
  if (!username) return res.status(400).json({ error: "Username required" });

  const monthlyEntry = monthlyCache.find(p => p.username.toLowerCase() === username);
  const weeklyEntry = weeklyRawCache.find(p => p.username.toLowerCase() === username);

  if (!monthlyEntry && !weeklyEntry) {
    return res.status(404).json({ error: "User not found" });
  }

  function getMonthlyReward(w) {
    if (w >= 2000000) return 10000;
    if (w >= 1000000) return 4000;
    if (w >= 500000) return 1500;
    if (w >= 300000) return 1000;
    if (w >= 100000) return 500;
    if (w >= 50000) return 200;
    return 0;
  }

  function getWeeklyReward(w) {
    if (w >= 50000) return 400;
    if (w >= 5000) return 50;
    if (w >= 1000) return 10;
    return 0;
  }

  const mWager = monthlyEntry ? monthlyEntry.weightedWager : 0;
  const mRank = monthlyEntry ? monthlyEntry.rank : null;
  const mPrize = getMonthlyReward(mWager);
  const wWager = weeklyEntry ? weeklyEntry.weightedWager : 0;
  const wPrize = getWeeklyReward(wWager);

  res.json({
    monthlyWager: mWager,
    monthlyRank: mRank,
    monthlyPrize: mPrize,
    weeklyWager: wWager,
    weeklyPrize: wPrize
  });
});

app.get("/api/weekly/top14", (req, res) => res.json(weeklyCache.slice(0, 14)));

app.get("/api/weekly/1000", (req, res) => {
  res.json(weeklyCache.filter((p) => p.weightedWager >= 1000 && p.weightedWager < 5000));
});

app.get("/api/weekly/5000", (req, res) => {
  res.json(weeklyCache.filter((p) => p.weightedWager >= 5000 && p.weightedWager < 50000));
});

app.get("/api/weekly/50000", (req, res) => {
  res.json(weeklyCache.filter((p) => p.weightedWager >= 50000));
});

app.get("/api/weekly/dates", (req, res) => {
  const current = getWeeklyWindow(0);
  const previous = getWeeklyWindow(-1);
  res.json({ current, previous });
});

/* ─── ADMIN API ROUTES (protected) ────────────────────────────────────────── */

app.get("/api/admin/monthly/current", requireAdmin, (req, res) => res.json(monthlyCache));

app.get("/api/admin/monthly/previous", requireAdmin, (req, res) => res.json(previousMonthlyCache));

app.get("/api/admin/weekly/current", requireAdmin, (req, res) => {
  const { startDate, endDate } = getWeeklyWindow(0);
  res.json({
    dates: { startDate, endDate },
    tiers: {
      tier1000: weeklyRawCache.filter((p) => p.weightedWager >= 1000 && p.weightedWager < 5000),
      tier5000: weeklyRawCache.filter((p) => p.weightedWager >= 5000 && p.weightedWager < 50000),
      tier50000: weeklyRawCache.filter((p) => p.weightedWager >= 50000),
    },
    all: weeklyRawCache,
  });
});

app.get("/api/admin/weekly/previous", requireAdmin, (req, res) => {
  const { startDate, endDate } = getWeeklyWindow(-1);
  res.json({
    dates: { startDate, endDate },
    tiers: {
      tier1000: previousWeeklyRawCache.filter((p) => p.weightedWager >= 1000 && p.weightedWager < 5000),
      tier5000: previousWeeklyRawCache.filter((p) => p.weightedWager >= 5000 && p.weightedWager < 50000),
      tier50000: previousWeeklyRawCache.filter((p) => p.weightedWager >= 50000),
    },
    all: previousWeeklyRawCache,
  });
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
    }

    const response = await axios.get(apiUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { userId, startDate, endDate },
    });

    const sorted = response.data
      .filter((p) => p.username !== "azisai205")
      .sort((a, b) => b.weightedWagered - a.weightedWagered);

    const result = sorted.map((p, i) => ({
      rank: i + 1,
      username: p.username,
      wagered: Math.round(p.wagered),
      weightedWager: Math.round(p.weightedWagered),
    }));

    res.json({ startDate, endDate, count: result.length, data: result });
  } catch (err) {
    console.error("❌ Admin stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── NOTES / STORIES ─────────────────────────────────────────────────────── */

const NOTES_FILE = path.join(__dirname, "data", "notes.json");

function ensureDataDir() {
  const dir = path.join(__dirname, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, "[]");
}
ensureDataDir();

function readNotes() {
  try {
    return JSON.parse(fs.readFileSync(NOTES_FILE, "utf-8"));
  } catch { return []; }
}

function writeNotes(notes) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

app.get("/api/notes", (req, res) => {
  const notes = readNotes().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(notes);
});

app.get("/api/notes/:id", (req, res) => {
  const notes = readNotes();
  const note = notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Not found" });
  res.json(note);
});

app.post("/api/notes", requireAdmin, (req, res) => {
  const { title, content, tags, images } = req.body;
  if (!title || !content) return res.status(400).json({ error: "Title and content required" });
  const safeTags = Array.isArray(tags) ? tags.filter(t => typeof t === "string").map(t => t.slice(0, 50)) : [];
  const safeImages = Array.isArray(images) ? images.filter(u => typeof u === "string").slice(0, 10) : [];
  const notes = readNotes();
  const note = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(title).slice(0, 200),
    content: String(content).slice(0, 10000),
    tags: safeTags,
    images: safeImages,
    views: 0,
    likes: 0,
    comments: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  notes.push(note);
  writeNotes(notes);
  res.json(note);
});

app.put("/api/notes/:id", requireAdmin, (req, res) => {
  const notes = readNotes();
  const idx = notes.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  const { title, content, tags, images } = req.body;
  if (title) notes[idx].title = String(title).slice(0, 200);
  if (content) notes[idx].content = String(content).slice(0, 10000);
  if (tags !== undefined) notes[idx].tags = Array.isArray(tags) ? tags.filter(t => typeof t === "string").map(t => t.slice(0, 50)) : notes[idx].tags;
  if (images !== undefined) notes[idx].images = Array.isArray(images) ? images.filter(u => typeof u === "string").slice(0, 10) : notes[idx].images || [];
  notes[idx].updatedAt = new Date().toISOString();
  writeNotes(notes);
  res.json(notes[idx]);
});

app.post("/api/notes/:id/view", (req, res) => {
  const notes = readNotes();
  const note = notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Not found" });
  note.views = (note.views || 0) + 1;
  writeNotes(notes);
  res.json({ views: note.views });
});

app.post("/api/notes/:id/like", (req, res) => {
  const notes = readNotes();
  const note = notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Not found" });
  note.likes = (note.likes || 0) + 1;
  writeNotes(notes);
  res.json({ likes: note.likes });
});

app.post("/api/notes/:id/comment", (req, res) => {
  const { name, text } = req.body;
  if (!text) return res.status(400).json({ error: "Comment text required" });
  const notes = readNotes();
  const note = notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Not found" });
  if (!note.comments) note.comments = [];
  const comment = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    name: String(name || "Anonymous").slice(0, 50),
    text: String(text).slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  note.comments.push(comment);
  writeNotes(notes);
  res.json(comment);
});

app.delete("/api/notes/:id/comment/:commentId", requireAdmin, (req, res) => {
  const notes = readNotes();
  const note = notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Not found" });
  note.comments = (note.comments || []).filter(c => c.id !== req.params.commentId);
  writeNotes(notes);
  res.json({ success: true });
});

app.delete("/api/notes/:id", requireAdmin, (req, res) => {
  let notes = readNotes();
  notes = notes.filter(n => n.id !== req.params.id);
  writeNotes(notes);
  res.json({ success: true });
});

/* ─── STATIC FILE SERVER ──────────────────────────────────────────────────── */

const ROOT = __dirname;
const mimeTypes = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

app.use((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch (e) {
    urlPath = req.url.split("?")[0];
  }

  if (urlPath.startsWith("/cdn-cgi/")) {
    return res.status(200).end();
  }

  if (urlPath === "/") urlPath = "/index.html";

  let filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    return res.status(403).send("Forbidden");
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.log(`404: ${urlPath}`);
      return res.status(404).send("Not Found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.send(data);
  });
});

/* ─── AUTO TELEGRAM REPORTS (end-of-period) ────────────────────────────── */

const REPORTS_FILE = path.join(__dirname, "data", "sent-reports.json");
function loadSentReports() {
  try {
    if (fs.existsSync(REPORTS_FILE)) return JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
  } catch (e) {}
  return {};
}
function saveSentReport(key) {
  const reports = loadSentReports();
  reports[key] = Date.now();
  try { fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports)); } catch (e) {}
}

function getMonthlyReward(w) {
  if (w >= 2000000) return 10000;
  if (w >= 1000000) return 4000;
  if (w >= 500000) return 1500;
  if (w >= 300000) return 1000;
  if (w >= 100000) return 500;
  if (w >= 50000) return 200;
  return 0;
}

function getWeeklyReward(w) {
  if (w >= 50000) return 400;
  if (w >= 5000) return 50;
  if (w >= 1000) return 10;
  return 0;
}

function fmtUSD(n) { return "$" + Number(n).toLocaleString("en-US"); }

async function sendTelegramMessage(text) {
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: Number(chatId.trim()),
        text,
        parse_mode: "HTML",
      });
    } catch (e) {
      console.error(`Telegram report send error (${chatId}):`, e.response?.data || e.message);
    }
  }
}

async function checkMonthlyEnd() {
  const { endDate } = getMonthlyDateRange();
  const endMs = new Date(endDate).getTime();
  const now = Date.now();
  if (now < endMs || now > endMs + 30 * 60 * 1000) return;
  const key = "monthly-" + endDate;
  if (loadSentReports()[key]) return;
  if (!monthlyCache.length) return;

  let msg = "📊 <b>MONTHLY LEADERBOARD FINAL RESULTS</b>\n";
  msg += "Period ended: " + new Date(endDate).toISOString().slice(0, 16).replace("T", " ") + " UTC\n\n";

  monthlyCache.forEach((p) => {
    const prize = getMonthlyReward(p.weightedWager);
    msg += `#${p.rank} | ${p.username} | Wager: ${fmtUSD(p.weightedWager)} | Prize: ${fmtUSD(prize)}\n`;
  });

  const totalPrizes = monthlyCache.reduce((s, p) => s + getMonthlyReward(p.weightedWager), 0);
  msg += `\nTotal prizes: ${fmtUSD(totalPrizes)} | Players: ${monthlyCache.length}`;

  await sendTelegramMessage(msg);
  saveSentReport(key);
  console.log(`[${new Date().toISOString()}] 📨 Monthly final report sent to Telegram`);
}

async function checkWeeklyEnd() {
  const { endDate } = getWeeklyWindow(0);
  const endMs = new Date(endDate).getTime();
  const now = Date.now();
  if (now < endMs || now > endMs + 30 * 60 * 1000) return;
  const key = "weekly-" + endDate;
  if (loadSentReports()[key]) return;
  if (!weeklyRawCache.length) return;

  const eligible = weeklyRawCache.filter((p) => p.weightedWager >= 1000);

  let msg = "🎯 <b>WEEKLY BONUS FINAL RESULTS</b>\n";
  msg += "Period ended: " + new Date(endDate).toISOString().slice(0, 16).replace("T", " ") + " UTC\n\n";

  if (!eligible.length) {
    msg += "No eligible players this week.\n";
  } else {
    eligible.forEach((p, i) => {
      const prize = getWeeklyReward(p.weightedWager);
      const tier = p.weightedWager >= 50000 ? "$50K+" : p.weightedWager >= 5000 ? "$5K+" : "$1K+";
      msg += `${i + 1}. ${p.username} | Wager: ${fmtUSD(p.weightedWager)} | Tier: ${tier} | Prize: ${fmtUSD(prize)}\n`;
    });
  }

  const totalPrizes = eligible.reduce((s, p) => s + getWeeklyReward(p.weightedWager), 0);
  msg += `\nTotal prizes: ${fmtUSD(totalPrizes)} | Eligible: ${eligible.length} / ${weeklyRawCache.length}`;

  await sendTelegramMessage(msg);
  saveSentReport(key);
  console.log(`[${new Date().toISOString()}] 📨 Weekly final report sent to Telegram`);
}

setInterval(() => {
  checkMonthlyEnd().catch(e => console.error("Monthly report check error:", e.message));
  checkWeeklyEnd().catch(e => console.error("Weekly report check error:", e.message));
}, 60 * 1000);

/* ─── START ───────────────────────────────────────────────────────────────── */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

fetchMonthlyData();
fetchPreviousMonthlyData();
fetchWeeklyData();
fetchPreviousWeeklyData();
setInterval(fetchMonthlyData, 5 * 60 * 1000);
setInterval(fetchPreviousMonthlyData, 30 * 60 * 1000);
setInterval(fetchWeeklyData, 5 * 60 * 1000);
setInterval(fetchPreviousWeeklyData, 30 * 60 * 1000);
