/**
 * LED Lucky Draw 3D — Google Apps Script Web App
 * - POST ?action=append_winner  body: { row: {ts, prize_id, prize_name, participant_id, name, mode, operator} }
 * - POST ?action=add_prize      body: { row: {prize_id, prize_name, prize_image_url, qty, active, priority} }
 *
 * ✅ วิธีใช้:
 * 1) เปิด Google Sheet ของคุณ → Extensions → Apps Script
 * 2) วางโค้ดนี้
 * 3) Deploy → New deployment → Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4) ได้ URL (…/exec) เอาไปใส่ server/.env → WRITE_WEBAPP_URL=...
 */

const TAB_WINNERS = "winners_log";
const TAB_PRIZES  = "Prizes";

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return jsonOut({ ok: true, msg: "LED Lucky Draw Web App is running" });
}

function doPost(e) {
  try {
    const action = (e.parameter.action || "").trim();
    const body = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};

    if (action === "append_winner") {
      const row = body.row || {};
      appendWinner_(row);
      return jsonOut({ ok: true });
    }

    if (action === "add_prize") {
      const row = body.row || {};
      addPrize_(row);
      return jsonOut({ ok: true });
    }

    return jsonOut({ ok: false, error: "Unknown action: " + action });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function appendWinner_(row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(TAB_WINNERS);
  if (!sh) throw new Error("Missing sheet: " + TAB_WINNERS);

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const values = headers.map(h => row[h] !== undefined ? row[h] : "");

  sh.appendRow(values);
}

function addPrize_(row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(TAB_PRIZES);
  if (!sh) throw new Error("Missing sheet: " + TAB_PRIZES);

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const values = headers.map(h => row[h] !== undefined ? row[h] : "");

  sh.appendRow(values);
}

