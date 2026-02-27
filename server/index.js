// server/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import crypto from "crypto";

dotenv.config();

// ✅ Node 18+ required (global fetch). On Render set NODE_VERSION=18 to be safe.

const PORT = Number(process.env.PORT || 8787);

// ✅ รองรับหลาย origin (comma-separated)
// ตัวอย่างบน Render:
// CORS_ORIGIN=https://your-admin.vercel.app,https://your-presenter.vercel.app,http://localhost:5173
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "http://localhost:5173").trim();
const ALLOWED_ORIGINS = CORS_ORIGIN.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SHEET_ID = process.env.SHEET_ID;
const SHEET_PARTICIPANTS = process.env.SHEET_PARTICIPANTS || "Participants";
const SHEET_PRIZES = process.env.SHEET_PRIZES || "Prizes";
const SHEET_WINNERS = process.env.SHEET_WINNERS || "winners_log";
const WRITE_WEBAPP_URL = (process.env.WRITE_WEBAPP_URL || "").trim();
const RNG_SALT = (process.env.RNG_SALT || "").trim();

if (!SHEET_ID) {
  console.error("Missing SHEET_ID in .env");
  process.exit(1);
}

const app = express();

// ✅ CORS แบบ robust: allow multiple origins + allow no-origin (server-to-server)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: false,
  })
);
app.use(express.json({ limit: "1mb" }));

function nowISO() {
  return new Date().toISOString();
}

// ---- GViz fetch (public read) ----
async function fetchGViz(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
    SHEET_ID
  )}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;

  const res = await fetch(url, { headers: { "User-Agent": "led-lucky-draw-server" } });
  if (!res.ok) throw new Error(`GViz HTTP ${res.status} for sheet=${sheetName}`);

  const txt = await res.text();
  const m = txt.match(/setResponse\((.*)\);?\s*$/s);
  if (!m) throw new Error("Invalid GViz response");
  return JSON.parse(m[1]);
}

function gvizToRows(gvizJson) {
  const table = gvizJson?.table;
  const cols = (table?.cols || []).map((c) => (c?.label || c?.id || "").trim());
  const rows = (table?.rows || []).map((r) => {
    const obj = {};
    (r.c || []).forEach((cell, i) => {
      const key = cols[i] || `col_${i}`;
      const v = cell?.v ?? "";
      obj[key] = v;
    });
    return obj;
  });
  return { columns: cols, rows };
}

// Simple in-memory cache
const cache = {
  participants: { at: 0, data: null },
  prizes: { at: 0, data: null },
  winners: { at: 0, data: null },
};
const CACHE_MS = 10_000;

async function getCached(kind, loader) {
  const c = cache[kind];
  const t = Date.now();
  if (c.data && t - c.at < CACHE_MS) return c.data;
  const data = await loader();
  c.data = data;
  c.at = t;
  return data;
}

// ---- Optional write-back via Apps Script Web App ----
async function writeBack(action, payload) {
  if (!WRITE_WEBAPP_URL) return { ok: false, reason: "WRITE_WEBAPP_URL not set" };

  const url = `${WRITE_WEBAPP_URL}?action=${encodeURIComponent(action)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, json };
  return { ok: true, json };
}

// ---- API endpoints ----
app.get("/api/health", (req, res) => res.json({ ok: true, now: nowISO() }));

app.get("/api/sheets/participants", async (req, res) => {
  try {
    const data = await getCached("participants", async () => {
      const gviz = await fetchGViz(SHEET_PARTICIPANTS);
      return gvizToRows(gviz);
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/sheets/prizes", async (req, res) => {
  try {
    const data = await getCached("prizes", async () => {
      const gviz = await fetchGViz(SHEET_PRIZES);
      return gvizToRows(gviz);
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/sheets/winners", async (req, res) => {
  try {
    const data = await getCached("winners", async () => {
      const gviz = await fetchGViz(SHEET_WINNERS);
      return gvizToRows(gviz);
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/write/add-prize", async (req, res) => {
  const body = req.body || {};
  const out = await writeBack("add_prize", body);
  res.status(out.ok ? 200 : 400).json(out);
});

app.post("/api/write/append-winner", async (req, res) => {
  const body = req.body || {};
  const out = await writeBack("append_winner", body);
  res.status(out.ok ? 200 : 400).json(out);
});

// ---- Realtime State + Winner Selection ----
const state = {
  mode: "exclude", // exclude | repeat
  prize: null,
  spinning: false,
  countdown: 3,
  lastWinner: null,

  // ✅ UI flags for Presenter preview
  ui: {
    showPrizePreview: false,
    selectedPrizeIndex: undefined,
    previewHint: "",
  },
};

function broadcast(wss, msg) {
  const s = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(s);
  }
}

function pickRandomInt(maxExclusive) {
  const b = crypto.randomBytes(4).readUInt32BE(0);
  return b % maxExclusive;
}

function normalizeKey(v) {
  return String(v ?? "").trim().toLowerCase();
}

// ✅ helper: รองรับ winners sheet ที่ตั้งชื่อคอลัมน์ไม่เหมือนกัน
function firstKey(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

async function computeWinner({ mapping }) {
  const p = await getCached("participants", async () => {
    const gviz = await fetchGViz(SHEET_PARTICIPANTS);
    return gvizToRows(gviz);
  });
  const w = await getCached("winners", async () => {
    const gviz = await fetchGViz(SHEET_WINNERS);
    return gvizToRows(gviz);
  });

  const idKey = mapping?.idKey || "id";
  const nameKey = mapping?.nameKey || "name";
  const teamKey = mapping?.teamKey || "";
  const deptKey = mapping?.deptKey || "";
  const eligibleKey = mapping?.eligibleKey || "";

  // ✅ winnersSet robust: participant_id / participantId / idKey / nameKey
  const winnersSet = new Set(
    (w.rows || []).map((r) =>
      normalizeKey(firstKey(r, ["participant_id", "participantId", idKey, nameKey]))
    )
  );

  const eligible = (p.rows || []).filter((r) => {
    const idv = normalizeKey(r[idKey]);
    const namev = normalizeKey(r[nameKey]);
    const key = idv || namev;
    if (!key) return false;

    if (eligibleKey && r[eligibleKey] !== "" && r[eligibleKey] !== null && r[eligibleKey] !== undefined) {
      const ev = normalizeKey(r[eligibleKey]);
      const truthy = ["true", "1", "yes", "y", "ok", "ผ่าน", "มีสิทธิ์", "eligible"];
      const falsy = ["false", "0", "no", "n", "x", "ไม่ผ่าน", "ไม่มีสิทธิ์", "ineligible"];
      if (falsy.includes(ev)) return false;
      if (truthy.includes(ev)) return true;
    }

    if (state.mode === "exclude") return !winnersSet.has(key);
    return true;
  });

  if (!eligible.length) return null;

  const idx = pickRandomInt(eligible.length);
  const row = eligible[idx];

  const winner = {
    participant_id: row[idKey] ?? "",
    name: row[nameKey] ?? "",
    team: teamKey ? row[teamKey] ?? "" : "",
    department: deptKey ? row[deptKey] ?? "" : "",
    raw: row,
  };

  if (!String(winner.participant_id || "").trim()) winner.participant_id = winner.name;

  // Optional deterministic-ish salt mode
  if (RNG_SALT) {
    const h = crypto
      .createHash("sha256")
      .update(JSON.stringify({ eligible, salt: RNG_SALT, t: Date.now() }))
      .digest("hex");
    const n = parseInt(h.slice(0, 8), 16);
    const j = n % eligible.length;
    const r2 = eligible[j];

    winner.participant_id = r2[idKey] ?? (r2[nameKey] ?? "");
    winner.name = r2[nameKey] ?? "";
    winner.team = teamKey ? r2[teamKey] ?? "" : "";
    winner.department = deptKey ? r2[deptKey] ?? "" : "";
    winner.raw = r2;
  }

  return winner;
}

// ---- Start HTTP + WS ----
const server = app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] ALLOWED_ORIGINS=${ALLOWED_ORIGINS.join(",") || "(none)"}`);
  console.log(`[server] SHEET_ID=${SHEET_ID}`);
  console.log(`[server] WRITE_WEBAPP_URL=${WRITE_WEBAPP_URL ? "set" : "(not set)"} (optional)`);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  // ✅ IMPORTANT: ให้ client รู้ว่าเชื่อมแล้ว (กันปุ่ม disabled ถ้าฝั่ง client รอ CONNECTED)
  ws.send(JSON.stringify({ type: "CONNECTED", payload: { t: Date.now() } }));

  // ส่ง state ปัจจุบันให้ทันที
  ws.send(JSON.stringify({ type: "STATE", payload: state }));

  ws.on("message", async (buf) => {
    let msg;
    try {
      msg = JSON.parse(String(buf || ""));
    } catch {
      return;
    }
    const { type, payload } = msg || {};

    if (type === "PING") {
      ws.send(JSON.stringify({ type: "PONG", payload: { t: Date.now() } }));
      return;
    }

    if (type === "SET_MODE") {
      state.mode = payload?.mode === "repeat" ? "repeat" : "exclude";
      broadcast(wss, { type: "STATE", payload: state });
      return;
    }

    if (type === "SET_PRIZE") {
      state.prize = payload?.prize || null;
      broadcast(wss, { type: "STATE", payload: state });
      return;
    }

    // ✅ SET_UI (Presenter Preview)
    if (type === "SET_UI") {
      const ui = payload?.ui || {};
      state.ui = {
        ...state.ui,
        ...ui,
      };
      broadcast(wss, { type: "STATE", payload: state });
      return;
    }

    if (type === "START_SPIN") {
      // ปิด preview กันบังจอ Presenter
      state.ui = { ...state.ui, showPrizePreview: false };

      state.spinning = true;
      state.lastWinner = null;

      broadcast(wss, { type: "STARTED", payload: { ...state } });
      return;
    }

    if (type === "STOP_SPIN") {
      state.spinning = false;

      const mapping = payload?.mapping || {};
      const winner = await computeWinner({ mapping });

      state.lastWinner = winner;

      // แจ้ง client ทันที
      broadcast(wss, { type: "STOPPING", payload: { ...state, winner } });

      // เขียน log ลงชีต (ถ้าตั้ง WRITE_WEBAPP_URL)
      if (winner && state.prize) {
        const row = {
          ts: nowISO(),
          prize_id: state.prize.prize_id ?? state.prize.id ?? "",
          prize_name: state.prize.prize_name ?? state.prize.name ?? "",
          participant_id: winner.participant_id ?? "",
          name: winner.name ?? "",
          mode: state.mode,
          operator: payload?.operator || "",
        };
        await writeBack("append_winner", { row }).catch(() => {});
        cache.winners.at = 0; // invalidate winners cache
      }
      return;
    }

    if (type === "RESET") {
      state.spinning = false;
      state.lastWinner = null;
      state.ui = { ...state.ui, showPrizePreview: false, previewHint: "" };
      broadcast(wss, { type: "STATE", payload: state });
      return;
    }
  });

  // ✅ optional: ส่ง DISCONNECTED ให้ client (ถ้าฝั่ง client ต้องการ)
  ws.on("close", () => {
    // หมายเหตุ: broadcast DISCONNECTED ให้ทุกคนอาจไม่จำเป็น
    // แต่ถ้าต้องการให้ client ที่หลุดรู้เอง ฝั่ง client มัก handle จาก socket close อยู่แล้ว
  });
});