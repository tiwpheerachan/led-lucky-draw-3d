// client/src/pages/AdminPage.tsx
import React, { useEffect, useMemo, useState } from "react";
import { realtime } from "../shared/ws";
import { getJSON, SheetPayload, Prize, RealtimeState, SERVER_HTTP } from "../shared/api";

function safeStr(v: any) {
  return String(v ?? "").trim();
}
function uniq(xs: string[]) {
  return Array.from(new Set(xs.filter(Boolean)));
}

type Mapping = {
  idKey: string;
  nameKey: string;
  teamKey: string;
  deptKey: string;
  eligibleKey: string;
};

const DEFAULT_MAPPING: Mapping = {
  idKey: "id",
  nameKey: "name",
  teamKey: "",
  deptKey: "",
  eligibleKey: "",
};

export default function AdminPage() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<RealtimeState | null>(null);

  const [pCols, setPCols] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Mapping>(() => {
    const raw = localStorage.getItem("ld_mapping");
    return raw ? { ...DEFAULT_MAPPING, ...JSON.parse(raw) } : DEFAULT_MAPPING;
  });

  const [prizes, setPrizes] = useState<Prize[]>([]);
  const [selectedPrizeId, setSelectedPrizeId] = useState<string>("");

  const [operator, setOperator] = useState<string>(() => localStorage.getItem("ld_operator") || "");

  const selectedPrize = useMemo(() => {
    const byId = prizes.find((p) => safeStr(p.prize_id || p.id) === selectedPrizeId);
    return byId || null;
  }, [prizes, selectedPrizeId]);

  // ✅ selected index = “รางวัลที่ X” (ตามลำดับ priority)
  const selectedPrizeIndex = useMemo(() => {
    if (!selectedPrizeId) return null;
    const idx = prizes.findIndex((p) => safeStr(p.prize_id || p.id) === selectedPrizeId);
    return idx >= 0 ? idx + 1 : null;
  }, [prizes, selectedPrizeId]);

  useEffect(() => {
    realtime.connect();
    const off = realtime.on((msg) => {
      if (msg.type === "CONNECTED") setConnected(true);
      if (msg.type === "DISCONNECTED") setConnected(false);
      if (msg.type === "STATE") setState(msg.payload);
      if (msg.type === "STARTED") setState(msg.payload);
      if (msg.type === "STOPPING") setState(msg.payload);
    });
    return off;
  }, []);

  useEffect(() => {
    (async () => {
      const p = await getJSON<SheetPayload>("/api/sheets/participants").catch(() => null);
      if (p?.ok) {
        setPCols(p.columns || []);
        // auto guess mapping if first time
        setMapping((prev) => {
          const cols = p.columns || [];
          const nameGuess =
            prev.nameKey && cols.includes(prev.nameKey)
              ? prev.nameKey
              : cols.find((c) => /name|ชื่อ/i.test(c)) || prev.nameKey;
          const idGuess =
            prev.idKey && cols.includes(prev.idKey)
              ? prev.idKey
              : cols.find((c) => /^id$|participant/i.test(c)) || prev.idKey;
          const teamGuess =
            prev.teamKey && cols.includes(prev.teamKey)
              ? prev.teamKey
              : cols.find((c) => /team|ทีม/i.test(c)) || prev.teamKey;
          const deptGuess =
            prev.deptKey && cols.includes(prev.deptKey)
              ? prev.deptKey
              : cols.find((c) => /dept|department|ฝ่าย|แผนก/i.test(c)) || prev.deptKey;
          const eligGuess =
            prev.eligibleKey && cols.includes(prev.eligibleKey)
              ? prev.eligibleKey
              : cols.find((c) => /eligible|สิทธิ|allow/i.test(c)) || prev.eligibleKey;
          const next = {
            ...prev,
            nameKey: nameGuess,
            idKey: idGuess,
            teamKey: teamGuess,
            deptKey: deptGuess,
            eligibleKey: eligGuess,
          };
          localStorage.setItem("ld_mapping", JSON.stringify(next));
          return next;
        });
      }
    })();
  }, []);

  async function loadPrizes() {
    const r = await getJSON<SheetPayload>("/api/sheets/prizes").catch(() => null);
    if (r?.ok) {
      const rows = (r.rows || []) as Prize[];
      // active filter (if exists)
      const active = rows.filter((p) => {
        const a = safeStr(p.active);
        if (!a) return true;
        return !["false", "0", "no", "n", "x", "ปิด"].includes(a.toLowerCase());
      });

      // sort by priority if present (empty -> 999999)
      active.sort((a, b) => {
        const pa = Number(safeStr(a.priority) || 999999);
        const pb = Number(safeStr(b.priority) || 999999);
        if (pa !== pb) return pa - pb;
        // stable secondary: by id/name
        const ia = safeStr(a.prize_id || a.id || "");
        const ib = safeStr(b.prize_id || b.id || "");
        return ia.localeCompare(ib);
      });

      setPrizes(active);

      // keep selection if still exists, else first
      const still = active.some((p) => safeStr(p.prize_id || p.id) === selectedPrizeId);
      if (!still) {
        const first = active[0];
        setSelectedPrizeId(first ? safeStr(first.prize_id || first.id) : "");
      } else if (!selectedPrizeId) {
        const first = active[0];
        if (first) setSelectedPrizeId(safeStr(first.prize_id || first.id));
      }
    }
  }

  useEffect(() => {
    loadPrizes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ✅ เมื่อเลือก prize -> ส่ง SET_PRIZE และเปิด preview บนจอ Presenter
  useEffect(() => {
    if (!selectedPrize) return;

    realtime.send("SET_PRIZE", { prize: selectedPrize });

    // ✅ เปิด fullscreen preview บน Presenter (ใช้ state.ui.showPrizePreview)
    realtime.send("SET_UI", {
      ui: {
        showPrizePreview: true,
        selectedPrizeIndex: selectedPrizeIndex ?? undefined,
        previewHint: "เตรียมพร้อม… กด START เพื่อเริ่มสุ่ม",
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPrizeId]);

  const isSpinning = !!state?.spinning;

  function selectPrizeByIndex(i1: number) {
    const p = prizes[i1 - 1];
    if (!p) return;
    setSelectedPrizeId(safeStr(p.prize_id || p.id));
  }

  function closePreview() {
    realtime.send("SET_UI", { ui: { showPrizePreview: false } });
  }

  function togglePreview() {
    const open = !!state?.ui?.showPrizePreview;
    realtime.send("SET_UI", {
      ui: {
        showPrizePreview: !open,
        selectedPrizeIndex: selectedPrizeIndex ?? undefined,
        previewHint: "กด START เพื่อเริ่มสุ่ม",
      },
    });
  }

  return (
    <div className="container" style={{ height: "100vh", overflow: "auto" }}>
      <div className="card" style={{ padding: 18 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div className="kicker">Admin Control</div>
            <div className="h1">LED Lucky Draw 3D</div>
            <p className="p">
              Realtime: <b>{connected ? "Connected" : "Disconnected"}</b> · Server: <b>{SERVER_HTTP}</b>
            </p>
          </div>

          <div className="pill">
            <span className="badge">{isSpinning ? "SPINNING" : "READY"}</span>
            <span style={{ fontWeight: 950 }}>โหมด:</span>
            <span style={{ fontWeight: 1000, color: "rgba(11,42,58,.72)" }}>
              {state?.mode === "repeat" ? "ไม่ตัดชื่อ" : "ตัดชื่อคนที่ได้แล้ว"}
            </span>
          </div>
        </div>

        <hr />

        <div className="grid grid2">
          {/* =========================
              1) เลือกรางวัล (ปุ่ม 1..N)
          ========================= */}
          <div className="card" style={{ padding: 14 }}>
            <div className="h2">1) เลือกรางวัล</div>
            <p className="p">กดเลขรางวัลตามลำดับ priority (จากชีต Prizes) · กดแล้วโชว์ Preview เต็มจอที่ Presenter</p>

            {/* ✅ ปุ่ม 1..N */}
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <label style={{ margin: 0 }}>รางวัล</label>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button className="btn" onClick={loadPrizes} disabled={isSpinning}>
                    ↻ Refresh prizes
                  </button>
                  <button className="btn" onClick={togglePreview} disabled={!selectedPrize}>
                    👁 Preview
                  </button>
                  <button className="btn" onClick={closePreview}>
                    ✕ ปิด Preview
                  </button>
                </div>
              </div>

              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(56px, 1fr))",
                  gap: 10,
                }}
              >
                {prizes.map((p, idx) => {
                  const id = safeStr(p.prize_id || p.id || idx);
                  const active = safeStr(p.prize_id || p.id) === selectedPrizeId;

                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => selectPrizeByIndex(idx + 1)}
                      disabled={isSpinning}
                      title={safeStr(p.prize_name || p.name || "")}
                      style={{
                        height: 56,
                        borderRadius: 999,
                        border: active ? "2px solid rgba(30,135,255,.55)" : "1px solid rgba(11,42,58,.14)",
                        background: active
                          ? "linear-gradient(180deg, rgba(84,187,255,.95), rgba(120,215,255,.75))"
                          : "rgba(255,255,255,.85)",
                        boxShadow: active ? "0 18px 45px rgba(30,135,255,.22)" : "0 10px 24px rgba(15,23,42,.10)",
                        color: active ? "#06243A" : "rgba(11,42,58,.88)",
                        fontWeight: 1100,
                        fontSize: 18,
                        cursor: isSpinning ? "not-allowed" : "pointer",
                        position: "relative",
                      }}
                    >
                      {idx + 1}
                      {active && (
                        <span
                          style={{
                            position: "absolute",
                            inset: 0,
                            borderRadius: 999,
                            boxShadow: "inset 0 0 0 2px rgba(255,255,255,.55)",
                            pointerEvents: "none",
                          }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {!prizes.length && (
                <div className="p" style={{ marginTop: 10 }}>
                  ⚠️ ไม่พบรางวัลในชีต Prizes (หรือ active=FALSE)
                </div>
              )}
            </div>

            {/* ✅ Card รายละเอียดรางวัลที่เลือก */}
            {selectedPrize && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "130px 1fr",
                  gap: 14,
                  marginTop: 14,
                  alignItems: "center",
                }}
              >
                <img
                  src={safeStr(selectedPrize.prize_image_url || selectedPrize.image)}
                  alt=""
                  style={{
                    width: 130,
                    height: 130,
                    borderRadius: 22,
                    objectFit: "cover",
                    border: "1px solid rgba(11,42,58,.12)",
                    background: "rgba(255,255,255,.75)",
                  }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
                <div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 12px",
                        borderRadius: 999,
                        border: "1px solid rgba(11,42,58,.12)",
                        background: "rgba(11,42,58,.04)",
                        fontWeight: 1000,
                        color: "rgba(11,42,58,.82)",
                      }}
                    >
                      🎁 รางวัลที่ {selectedPrizeIndex ?? "—"}
                    </div>
                    <div className="p" style={{ margin: 0 }}>
                      Qty: <b>{safeStr(selectedPrize.qty || "1")}</b>
                    </div>
                  </div>

                  <div style={{ fontWeight: 1200, fontSize: 20, marginTop: 8 }}>
                    {safeStr(selectedPrize.prize_name || selectedPrize.name)}
                  </div>
                  <div className="p" style={{ marginTop: 6 }}>
                    ID: <b>{safeStr(selectedPrize.prize_id || selectedPrize.id)}</b>
                    {" · "}
                    priority: <b>{safeStr(selectedPrize.priority || "—")}</b>
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                    <AddPrizeButton onAdded={loadPrizes} />
                    <button
                      className={"btn " + (state?.ui?.showPrizePreview ? "btnPrimary" : "")}
                      onClick={() =>
                        realtime.send("SET_UI", {
                          ui: {
                            showPrizePreview: true,
                            selectedPrizeIndex: selectedPrizeIndex ?? undefined,
                            previewHint: "เตรียมพร้อม… กด START เพื่อเริ่มสุ่ม",
                          },
                        })
                      }
                      disabled={!selectedPrize}
                    >
                      📺 โชว์ Preview เต็มจอ
                    </button>
                  </div>
                </div>
              </div>
            )}

            {!selectedPrize && (
              <p className="p" style={{ marginTop: 10 }}>
                ⚠️ กรุณาเลือกรางวัลก่อน
              </p>
            )}
          </div>

          {/* =========================
              2) โหมดสุ่ม + Column Mapper
          ========================= */}
          <div className="card" style={{ padding: 14 }}>
            <div className="h2">2) โหมดสุ่ม + Column Mapper</div>
            <p className="p">เลือก “ตัดชื่อออก” หรือ “ไม่ตัดชื่อ” และแมปคอลัมน์จาก Participants</p>

            <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              <button
                className={"btn " + (state?.mode !== "repeat" ? "btnPrimary" : "")}
                onClick={() => realtime.send("SET_MODE", { mode: "exclude" })}
                disabled={isSpinning}
              >
                ตัดชื่อคนที่ได้แล้ว
              </button>
              <button
                className={"btn " + (state?.mode === "repeat" ? "btnPrimary" : "")}
                onClick={() => realtime.send("SET_MODE", { mode: "repeat" })}
                disabled={isSpinning}
              >
                ไม่ตัดชื่อ (สุ่มซ้ำได้)
              </button>
            </div>

            <hr />

            <div className="grid grid2" style={{ marginTop: 10 }}>
              <div>
                <label>operator (ผู้กด)</label>
                <input
                  className="input"
                  value={operator}
                  onChange={(e) => {
                    setOperator(e.target.value);
                    localStorage.setItem("ld_operator", e.target.value);
                  }}
                  placeholder="เช่น HR / MC / Admin"
                />
              </div>
              <div>
                <label>idKey</label>
                <select value={mapping.idKey} onChange={(e) => setMap("idKey", e.target.value)}>
                  {renderOptions(pCols)}
                </select>
              </div>
              <div>
                <label>nameKey</label>
                <select value={mapping.nameKey} onChange={(e) => setMap("nameKey", e.target.value)}>
                  {renderOptions(pCols)}
                </select>
              </div>
              <div>
                <label>teamKey (optional)</label>
                <select value={mapping.teamKey} onChange={(e) => setMap("teamKey", e.target.value)}>
                  <option value="">(none)</option>
                  {renderOptions(pCols)}
                </select>
              </div>
              <div>
                <label>deptKey (optional)</label>
                <select value={mapping.deptKey} onChange={(e) => setMap("deptKey", e.target.value)}>
                  <option value="">(none)</option>
                  {renderOptions(pCols)}
                </select>
              </div>
              <div>
                <label>eligibleKey (optional)</label>
                <select value={mapping.eligibleKey} onChange={(e) => setMap("eligibleKey", e.target.value)}>
                  <option value="">(none)</option>
                  {renderOptions(pCols)}
                </select>
              </div>
            </div>

            <p className="p" style={{ marginTop: 10 }}>
              * ถ้าไม่มี eligibleKey ระบบถือว่า “ทุกคนมีสิทธิ์”
            </p>
          </div>
        </div>

        <hr />

        {/* =========================
            3) ควบคุมเริ่ม / หยุด
        ========================= */}
        <div className="card" style={{ padding: 14 }}>
          <div className="h2">3) ควบคุมเริ่ม / หยุด</div>
          <p className="p">Start จะเริ่มหมุนบนจอ LED · Stop จะคำนวณผู้ชนะและแสดงผล</p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <button
              className={"btn btnPrimary"}
              onClick={() => {
                // ✅ ปิด preview ก่อนเริ่มหมุน (กันบังจอ LED)
                realtime.send("SET_UI", { ui: { showPrizePreview: false } });
                realtime.send("START_SPIN");
              }}
              disabled={!connected || isSpinning || !selectedPrize}
            >
              ▶ START
            </button>

            <button
              className={"btn"}
              onClick={() => realtime.send("STOP_SPIN", { mapping, operator })}
              disabled={!connected || !isSpinning || !selectedPrize}
            >
              ■ STOP (เลือกผู้ชนะ)
            </button>

            <button className={"btn"} onClick={() => realtime.send("RESET")} disabled={!connected}>
              ↺ RESET
            </button>
          </div>

          {!selectedPrize && (
            <p className="p" style={{ marginTop: 10 }}>
              ⚠️ กรุณาเลือกรางวัลก่อน
            </p>
          )}
        </div>
      </div>
    </div>
  );

  function setMap<K extends keyof Mapping>(k: K, v: Mapping[K]) {
    const next = { ...mapping, [k]: v };
    setMapping(next);
    localStorage.setItem("ld_mapping", JSON.stringify(next));
  }
}

function renderOptions(cols: string[]) {
  return uniq(cols).map((c) => (
    <option key={c} value={c}>
      {c}
    </option>
  ));
}

function AddPrizeButton({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [img, setImg] = useState("");
  const [qty, setQty] = useState("1");
  const [active, setActive] = useState("TRUE");
  const [priority, setPriority] = useState("");

  async function submit() {
    const row = {
      prize_id: id || undefined,
      prize_name: name,
      prize_image_url: img,
      qty,
      active,
      priority,
    };
    const res = await fetch(`${SERVER_HTTP}/api/write/add-prize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row }),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      alert(
        "เพิ่มรางวัลไม่สำเร็จ (ต้องตั้งค่า WRITE_WEBAPP_URL ใน server/.env)\n" + JSON.stringify(json, null, 2)
      );
      return;
    }
    setOpen(false);
    setId("");
    setName("");
    setImg("");
    setQty("1");
    setActive("TRUE");
    setPriority("");
    onAdded();
  }

  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        ＋ Add Prize (พิเศษ)
      </button>
      {open && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(11,42,58,.25)",
            display: "grid",
            placeItems: "center",
            padding: 18,
            zIndex: 50,
          }}
        >
          <div className="card" style={{ width: "min(720px, 100%)", padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <div className="kicker">Add Prize</div>
                <div className="h2">เพิ่มรางวัลพิเศษ (เขียนลงชีต Prizes)</div>
                <p className="p">* ต้อง deploy Google Apps Script Web App แล้วตั้งค่า WRITE_WEBAPP_URL ใน server/.env</p>
              </div>
              <button className="btn" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>

            <div className="grid grid2" style={{ marginTop: 12 }}>
              <div>
                <label>prize_id (optional)</label>
                <input className="input" value={id} onChange={(e) => setId(e.target.value)} placeholder="เช่น P-001" />
              </div>
              <div>
                <label>qty</label>
                <input className="input" value={qty} onChange={(e) => setQty(e.target.value)} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label>prize_name</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="เช่น iPad / Gift Card"
                />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label>prize_image_url (optional)</label>
                <input
                  className="input"
                  value={img}
                  onChange={(e) => setImg(e.target.value)}
                  placeholder="ลิงก์รูป (https://...jpg)"
                />
              </div>
              <div>
                <label>active</label>
                <select value={active} onChange={(e) => setActive(e.target.value)}>
                  <option value="TRUE">TRUE</option>
                  <option value="FALSE">FALSE</option>
                </select>
              </div>
              <div>
                <label>priority (optional)</label>
                <input className="input" value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="เช่น 1,2,3..." />
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setOpen(false)}>
                ยกเลิก
              </button>
              <button className="btn btnPrimary" onClick={submit} disabled={!name.trim()}>
                บันทึก
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}