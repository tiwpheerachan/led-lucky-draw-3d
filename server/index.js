// server/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

const PORT = Number(process.env.PORT || 8787);
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "http://localhost:5173").trim();
const ALLOWED_ORIGINS = CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
const SHEET_ID = process.env.SHEET_ID;
const SHEET_PARTICIPANTS = process.env.SHEET_PARTICIPANTS || "Participants";
const SHEET_PRIZES = process.env.SHEET_PRIZES || "Prizes";
const SHEET_WINNERS = process.env.SHEET_WINNERS || "winners_log";
const WRITE_WEBAPP_URL = (process.env.WRITE_WEBAPP_URL || "").trim();
const RNG_SALT = (process.env.RNG_SALT || "").trim();

if (!SHEET_ID) { console.error("Missing SHEET_ID in .env"); process.exit(1); }

// ─────────────────────────────────────────────
//  Express
// ─────────────────────────────────────────────
const app = express();
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: false,
}));
app.use(express.json({ limit: "1mb" }));

function nowISO() { return new Date().toISOString(); }

// ─────────────────────────────────────────────
//  GViz + Cache
// ─────────────────────────────────────────────
async function fetchGViz(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(SHEET_ID)}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
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
      obj[cols[i] || `col_${i}`] = cell?.v ?? "";
    });
    return obj;
  });
  return { columns: cols, rows };
}

const cache = {
  participants: { at: 0, data: null },
  prizes:       { at: 0, data: null },
  winners:      { at: 0, data: null },
};
const CACHE_MS = 10_000;

async function getCached(kind, loader) {
  const c = cache[kind];
  if (c.data && Date.now() - c.at < CACHE_MS) return c.data;
  const data = await loader();
  c.data = data; c.at = Date.now();
  return data;
}

// ─────────────────────────────────────────────
//  Write-back (Apps Script)
// ─────────────────────────────────────────────
async function writeBack(action, payload) {
  if (!WRITE_WEBAPP_URL) return { ok: false, reason: "WRITE_WEBAPP_URL not set" };
  const res = await fetch(`${WRITE_WEBAPP_URL}?action=${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, json } : { ok: false, status: res.status, json };
}

// ─────────────────────────────────────────────
//  Persist store  { ids: [...], reset_at: ISO|null }
//
//  reset_at = เวลาที่กด RESET ล่าสุด
//  ใช้กรอง winners_log ตอน restart:
//    เอาเฉพาะ row ที่ ts > reset_at เท่านั้น
// ─────────────────────────────────────────────
const STORE_FILE = path.join(__dirname, "excluded_ids.json");

function loadStore() {
  try {
    const obj = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { ids: new Set(Array.isArray(obj.ids) ? obj.ids : []), reset_at: obj.reset_at || null };
  } catch {
    return { ids: new Set(), reset_at: null };
  }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ ids: [...excludedIds], reset_at: lastResetAt }), "utf8");
  } catch (e) {
    console.error("[persist] save failed:", e.message);
  }
}

const { ids: excludedIds, reset_at: _resetAt } = loadStore();
let lastResetAt = _resetAt;
console.log(`[persist] loaded: ${excludedIds.size} ids, reset_at=${lastResetAt || "never"}`);

// ─────────────────────────────────────────────
//  Startup sync — อ่าน winners_log แล้ว merge
//  กรองเฉพาะ row ที่ ts > lastResetAt
//
//  ✅ top-level await = server ไม่รับ connection
//     จนกว่า sync จะเสร็จ 100%
// ─────────────────────────────────────────────
function normalizeKey(v) { return String(v ?? "").trim().toLowerCase(); }

async function syncWinnersOnStartup() {
  try {
    const gviz = await fetchGViz(SHEET_WINNERS);
    const w = gvizToRows(gviz);
    cache.winners.data = w; cache.winners.at = Date.now(); // prime cache

    let added = 0;
    for (const r of w.rows || []) {
      // ข้าม row ที่เกิดก่อนหรือเท่ากับ lastResetAt
      if (lastResetAt) {
        const ts = String(r["ts"] || "").trim();
        if (ts && ts <= lastResetAt) continue;
      }
      const key = normalizeKey(r["participant_id"] || r["participantId"] || r["id"] || r["name"] || "");
      if (key && !excludedIds.has(key)) { excludedIds.add(key); added++; }
    }

    if (added > 0) saveStore();
    console.log(`[startup] sync winners_log: +${added} added, total excluded=${excludedIds.size}`);
  } catch (e) {
    console.warn("[startup] sync winners_log failed (non-fatal):", e.message);
  }
}

// ✅ รอ sync ก่อนเริ่ม server
await syncWinnersOnStartup();

// ─────────────────────────────────────────────
//  Realtime state
// ─────────────────────────────────────────────
const state = {
  mode: "exclude",
  prize: null,
  spinning: false,
  countdown: 3,
  lastWinner: null,
  ui: { showPrizePreview: false, selectedPrizeIndex: undefined, previewHint: "" },
};

function broadcast(wss, msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

function pickRandomInt(n) { return crypto.randomBytes(4).readUInt32BE(0) % n; }

function firstKey(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

// ─────────────────────────────────────────────
//  computeWinner
// ─────────────────────────────────────────────
async function computeWinner({ mapping }) {
  const p = await getCached("participants", async () => {
    const gviz = await fetchGViz(SHEET_PARTICIPANTS);
    return gvizToRows(gviz);
  });

  const idKey       = mapping?.idKey       || "id";
  const nameKey     = mapping?.nameKey     || "name";
  const teamKey     = mapping?.teamKey     || "";
  const deptKey     = mapping?.deptKey     || "";
  const eligibleKey = mapping?.eligibleKey || "";

  // ✅ ใช้ excludedIds (in-memory, ซึ่ง sync มาจาก file + sheet แล้ว) เป็น source of truth
  const winnersSet = new Set(excludedIds);

  // เสริมจาก sheet (best-effort, cover กรณี race ระหว่าง start-stop ถี่ๆ)
  if (state.mode === "exclude") {
    try {
      const w = await getCached("winners", async () => {
        const gviz = await fetchGViz(SHEET_WINNERS);
        return gvizToRows(gviz);
      });
      for (const r of w.rows || []) {
        if (lastResetAt) {
          const ts = String(r["ts"] || "").trim();
          if (ts && ts <= lastResetAt) continue;
        }
        const k = normalizeKey(firstKey(r, ["participant_id", "participantId", idKey, nameKey]));
        if (k) winnersSet.add(k);
      }
    } catch {}
  }

  console.log(`[computeWinner] mode=${state.mode} excluded=${winnersSet.size}`);

  // ✅ DEBUG: แสดง columns จริงใน Participants sheet + ค่า row แรก
  const firstRow = p.rows?.[0] || {};
  console.log(`[DEBUG] Participants columns:`, p.columns);
  console.log(`[DEBUG] First row keys:`, Object.keys(firstRow));
  console.log(`[DEBUG] First row sample:`, JSON.stringify(firstRow).slice(0, 200));
  console.log(`[DEBUG] winnersSet contents:`, [...winnersSet].slice(0, 10));

  // auto-detect idKey จากคอลัมน์จริงใน sheet
  const actualIdKey = (() => {
    const candidates = [idKey, "participant_id", "participantId", "id", "employee_id", "emp_id"];
    for (const k of candidates) {
      if (firstRow[k] !== undefined && String(firstRow[k] || "").trim() !== "") return k;
    }
    return idKey; // fallback
  })();
  if (actualIdKey !== idKey) {
    console.log(`[computeWinner] idKey override: "${idKey}" → "${actualIdKey}"`);
  }

  const eligible = (p.rows || []).filter((r) => {
    const idv   = normalizeKey(r[actualIdKey]);
    const namev = normalizeKey(r[nameKey]);
    // ✅ ตรวจทั้ง id และ name — ป้องกัน key mismatch
    if (!idv && !namev) return false;

    if (eligibleKey && r[eligibleKey] !== "" && r[eligibleKey] !== null && r[eligibleKey] !== undefined) {
      const ev = normalizeKey(r[eligibleKey]);
      if (["false","0","no","n","x","ไม่ผ่าน","ไม่มีสิทธิ์","ineligible"].includes(ev)) return false;
      if (["true","1","yes","y","ok","ผ่าน","มีสิทธิ์","eligible"].includes(ev)) {
        // ✅ eligible=true → ต้องตรวจ exclude ด้วย ห้าม return true ออกไปเลย!
        if (state.mode === "exclude") return !winnersSet.has(idv) && !winnersSet.has(namev);
        return true;
      }
    }

    if (state.mode === "exclude") {
      return !winnersSet.has(idv) && !winnersSet.has(namev);
    }
    return true;
  });

  console.log(`[computeWinner] eligible pool = ${eligible.length}`);
  if (!eligible.length) { console.warn("[computeWinner] pool exhausted"); return null; }

  let row;
  if (RNG_SALT) {
    const h = crypto.createHash("sha256").update(JSON.stringify({ eligible, salt: RNG_SALT, t: Date.now() })).digest("hex");
    row = eligible[parseInt(h.slice(0, 8), 16) % eligible.length];
  } else {
    row = eligible[pickRandomInt(eligible.length)];
  }

  const winner = {
    participant_id: row[actualIdKey] ?? row[idKey] ?? "",
    name:           row[nameKey] ?? "",
    team:           teamKey ? row[teamKey]   ?? "" : "",
    department:     deptKey ? row[deptKey]   ?? "" : "",
    raw: row,
  };
  if (!String(winner.participant_id || "").trim()) winner.participant_id = winner.name;
  return winner;
}

// ─────────────────────────────────────────────
//  API endpoints
// ─────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ ok: true, now: nowISO(), excluded: excludedIds.size }));

app.get("/api/sheets/participants", async (_, res) => {
  try { res.json({ ok: true, ...(await getCached("participants", async () => gvizToRows(await fetchGViz(SHEET_PARTICIPANTS)))) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});
app.get("/api/sheets/prizes", async (_, res) => {
  try { res.json({ ok: true, ...(await getCached("prizes", async () => gvizToRows(await fetchGViz(SHEET_PRIZES)))) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});
app.get("/api/sheets/winners", async (_, res) => {
  try { res.json({ ok: true, ...(await getCached("winners", async () => gvizToRows(await fetchGViz(SHEET_WINNERS)))) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});

// ✅ debug endpoint — ดูรายชื่อที่ถูกตัดสิทธิ์ปัจจุบัน
app.get("/api/excluded", (_, res) => {
  res.json({ count: excludedIds.size, reset_at: lastResetAt, ids: [...excludedIds] });
});

app.post("/api/write/add-prize",     async (req, res) => { const o = await writeBack("add_prize",     req.body || {}); res.status(o.ok ? 200 : 400).json(o); });
app.post("/api/write/append-winner", async (req, res) => { const o = await writeBack("append_winner", req.body || {}); res.status(o.ok ? 200 : 400).json(o); });

// ─────────────────────────────────────────────
//  WebSocket handlers
// ─────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`[server] :${PORT} | excluded=${excludedIds.size} | reset_at=${lastResetAt || "never"}`);
  console.log(`[server] WRITE_WEBAPP_URL=${WRITE_WEBAPP_URL ? "set" : "(not set)"}`);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "CONNECTED", payload: { t: Date.now() } }));
  ws.send(JSON.stringify({ type: "STATE", payload: state }));

  ws.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(String(buf || "")); } catch { return; }
    const { type, payload } = msg || {};

    // ── PING ──
    if (type === "PING") {
      ws.send(JSON.stringify({ type: "PONG", payload: { t: Date.now() } }));
      return;
    }

    // ── SET_MODE ──
    if (type === "SET_MODE") {
      state.mode = payload?.mode === "repeat" ? "repeat" : "exclude";
      // merge excludedIds จาก client (fallback กรณี server เพิ่ง restart)
      _mergeClientIds(payload?.excludedIds);
      broadcast(wss, { type: "STATE", payload: state });
      return;
    }

    // ── SET_PRIZE ──
    if (type === "SET_PRIZE") {
      state.prize = payload?.prize || null;
      broadcast(wss, { type: "STATE", payload: state });
      return;
    }

    // ── SET_UI ──
    if (type === "SET_UI") {
      state.ui = { ...state.ui, ...(payload?.ui || {}) };
      broadcast(wss, { type: "STATE", payload: state });
      return;
    }

    // ── START_SPIN ──
    if (type === "START_SPIN") {
      state.ui = { ...state.ui, showPrizePreview: false };
      state.spinning = true;
      state.lastWinner = null;
      // merge excludedIds จาก client
      _mergeClientIds(payload?.excludedIds);
      broadcast(wss, { type: "STARTED", payload: { ...state } });
      return;
    }

    // ── STOP_SPIN ──
    if (type === "STOP_SPIN") {
      state.spinning = false;
      const mapping = payload?.mapping || {};
      const winner = await computeWinner({ mapping });
      state.lastWinner = winner;

      // ✅ บันทึก winner ลง excludedIds ทันที — เก็บทั้ง id และ name
      // ป้องกัน key mismatch กรณีชีตใช้คอลัมน์ต่างกัน
      if (winner) {
        const kId   = normalizeKey(winner.participant_id || "");
        const kName = normalizeKey(winner.name || "");
        let changed = false;
        if (kId)   { excludedIds.add(kId);   changed = true; }
        if (kName) { excludedIds.add(kName); changed = true; }
        if (changed) {
          saveStore();
          console.log(`[STOP_SPIN] +excluded id="${kId}" name="${kName}", total=${excludedIds.size}`);
        }
      }

      broadcast(wss, { type: "STOPPING", payload: { ...state, winner } });

      // write log (best-effort)
      if (winner && state.prize) {
        const row = {
          ts:             nowISO(),
          prize_id:       state.prize.prize_id ?? state.prize.id ?? "",
          prize_name:     state.prize.prize_name ?? state.prize.name ?? "",
          participant_id: winner.participant_id ?? "",
          name:           winner.name ?? "",
          mode:           state.mode,
          operator:       payload?.operator || "",
        };
        writeBack("append_winner", { row })
          .then(() => { cache.winners.at = 0; }) // invalidate cache หลัง write
          .catch(() => {});
      }
      return;
    }

    // ── RESET ──
    if (type === "RESET") {
      state.spinning   = false;
      state.lastWinner = null;
      state.ui = { ...state.ui, showPrizePreview: false, previewHint: "" };

      // ✅ บันทึกเวลา reset — ใช้กรอง winners_log ตอน restart
      lastResetAt = nowISO();
      excludedIds.clear();
      saveStore();

      // invalidate winners cache — กันดึงข้อมูลเก่ากลับมา
      cache.winners.data = null;
      cache.winners.at   = 0;

      console.log(`[RESET] cleared all excluded, reset_at=${lastResetAt}`);
      broadcast(wss, { type: "STATE", payload: state });
      return;
    }
  });

  ws.on("close", () => {});
});

// ─────────────────────────────────────────────
//  Helper: merge client excludedIds เข้า server
//  (fallback กรณี server restart แล้ว client ส่งมาให้)
// ─────────────────────────────────────────────
function _mergeClientIds(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return;
  let added = 0;
  for (const id of arr) {
    const k = normalizeKey(id);
    if (k && !excludedIds.has(k)) { excludedIds.add(k); added++; }
  }
  if (added > 0) {
    saveStore();
    console.log(`[merge] +${added} client ids, total excluded=${excludedIds.size}`);
  }
}