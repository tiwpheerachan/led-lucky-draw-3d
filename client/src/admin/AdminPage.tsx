// client/src/pages/AdminPage.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { realtime } from "../shared/ws";
import { getJSON, SheetPayload, Prize, RealtimeState, SERVER_HTTP } from "../shared/api";

/* =========================
   Helpers
========================= */
function safeStr(v: any) {
  return String(v ?? "").trim();
}
function uniq(xs: string[]) {
  return Array.from(new Set(xs.filter(Boolean)));
}
function isActiveRow(p: any) {
  const a = safeStr((p as any)?.active);
  if (!a) return true;
  return !["false", "0", "no", "n", "x", "ปิด"].includes(a.toLowerCase());
}
function isLikelyUrl(s: string) {
  return /^https?:\/\//i.test(s) || s.startsWith("/");
}
function prettyServerLabel() {
  try {
    const u = new URL(SERVER_HTTP);
    return `${u.protocol}//${u.host}`;
  } catch {
    return SERVER_HTTP;
  }
}

/* =========================
   Sound (simple + safe)
   - Put files in /public/sounds/...
   - You can rename paths below as you like
========================= */
const SOUND = {
  click: "/sounds/ui-click.mp3",
  previewOn: "/sounds/ui-preview-on.mp3",
  previewOff: "/sounds/ui-preview-off.mp3",
  start: "/sounds/ui-start.mp3",
  stop: "/sounds/ui-stop.mp3",
  reset: "/sounds/ui-reset.mp3",
};

function clamp01(n: number) {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/* =========================
   Field (UI helper)
========================= */
function Field({
  label,
  hint,
  children,
  full,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div style={{ ...S.field, ...(full ? S.fieldFull : null) }}>
      <div style={S.fieldTop}>
        <div style={S.label}>{label}</div>
        {hint ? <div style={S.hint}>{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

/* =========================
   Types
========================= */
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

/* =========================
   Page
========================= */
export default function AdminPage() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<RealtimeState | null>(null);

  // ✅ mapping/ผู้กด “ยังคงอยู่ใน logic” แต่ “ตัด UI ควบคุมการสุ่ม” ออกตามที่ขอ
  const [pCols, setPCols] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Mapping>(() => {
    const raw = localStorage.getItem("ld_mapping");
    return raw ? { ...DEFAULT_MAPPING, ...JSON.parse(raw) } : DEFAULT_MAPPING;
  });
  const [operator, setOperator] = useState<string>(() => localStorage.getItem("ld_operator") || "");

  const [prizes, setPrizes] = useState<Prize[]>([]);
  const [selectedPrizeId, setSelectedPrizeId] = useState<string>("");

  // catalog filters
  const [qPrize, setQPrize] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  // Add Prize (Dropdown)
  const [addOpen, setAddOpen] = useState(false);
  const [apId, setApId] = useState("");
  const [apName, setApName] = useState("");
  const [apImg, setApImg] = useState("");
  const [apQty, setApQty] = useState("1");
  const [apActive, setApActive] = useState("TRUE");
  const [apPriority, setApPriority] = useState("");

  // ✅ Sound controls (persist)
  const [soundOn, setSoundOn] = useState<boolean>(() => {
    const raw = localStorage.getItem("ld_sound_on");
    if (raw === null) return true;
    return raw === "true";
  });
  const [volume, setVolume] = useState<number>(() => {
    const raw = Number(localStorage.getItem("ld_sound_volume") ?? "0.7");
    return clamp01(raw);
  });

  // ✅ Keep a tiny in-memory audio map
  const audioRef = useRef<Record<string, HTMLAudioElement | null>>({});
  const lastSpinningRef = useRef<boolean>(false);

  const selectedPrize = useMemo(() => {
    const byId = prizes.find((p: any) => safeStr(p.prize_id || p.id) === selectedPrizeId);
    return byId || null;
  }, [prizes, selectedPrizeId]);

  const selectedPrizeIndex = useMemo(() => {
    if (!selectedPrizeId) return null;
    const idx = prizes.findIndex((p: any) => safeStr(p.prize_id || p.id) === selectedPrizeId);
    return idx >= 0 ? idx + 1 : null;
  }, [prizes, selectedPrizeId]);

  const isSpinning = !!state?.spinning;
  const previewOpen = !!state?.ui?.showPrizePreview;

  // persist sound settings
  useEffect(() => {
    localStorage.setItem("ld_sound_on", String(!!soundOn));
  }, [soundOn]);
  useEffect(() => {
    localStorage.setItem("ld_sound_volume", String(clamp01(volume)));
    // apply volume to base audio objects (if any)
    const map = audioRef.current || {};
    Object.values(map).forEach((a) => {
      try {
        if (a) a.volume = clamp01(volume);
      } catch {}
    });
  }, [volume]);

  // preload audio once
  useEffect(() => {
    const map: Record<string, HTMLAudioElement> = {};
    (Object.keys(SOUND) as Array<keyof typeof SOUND>).forEach((k) => {
      try {
        const a = new Audio(SOUND[k]);
        a.preload = "auto";
        a.volume = clamp01(volume);
        map[k] = a;
      } catch {}
    });
    audioRef.current = map;
    // no cleanup needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function playSound(name: keyof typeof SOUND) {
    if (!soundOn) return;
    const base = audioRef.current?.[name];
    if (!base) return;

    try {
      // clone for overlap + avoid "play() interrupted" issues
      const a = base.cloneNode(true) as HTMLAudioElement;
      a.volume = clamp01(volume);
      a.currentTime = 0;
      // play best-effort (autoplay may be blocked until user interacts)
      void a.play().catch(() => {});
    } catch {}
  }

  /* =========================
     Realtime connect
  ========================= */
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

  // Optional: react to spin state changes from server and play stop/start sound once
  useEffect(() => {
    const prev = lastSpinningRef.current;
    const now = !!state?.spinning;
    if (!prev && now) playSound("start");
    if (prev && !now) playSound("stop");
    lastSpinningRef.current = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.spinning]);

  /* =========================
     Load participants cols (mapping) — auto guess
  ========================= */
  useEffect(() => {
    (async () => {
      const p = await getJSON<SheetPayload>("/api/sheets/participants").catch(() => null);
      if (p?.ok) {
        setPCols(p.columns || []);
        setMapping((prev) => {
          const cols = p.columns || [];
          const nameGuess =
            prev.nameKey && cols.includes(prev.nameKey) ? prev.nameKey : cols.find((c) => /name|ชื่อ/i.test(c)) || prev.nameKey;
          const idGuess =
            prev.idKey && cols.includes(prev.idKey) ? prev.idKey : cols.find((c) => /^id$|participant/i.test(c)) || prev.idKey;
          const teamGuess =
            prev.teamKey && cols.includes(prev.teamKey) ? prev.teamKey : cols.find((c) => /team|ทีม/i.test(c)) || prev.teamKey;
          const deptGuess =
            prev.deptKey && cols.includes(prev.deptKey)
              ? prev.deptKey
              : cols.find((c) => /dept|department|ฝ่าย|แผนก/i.test(c)) || prev.deptKey;
          const eligGuess =
            prev.eligibleKey && cols.includes(prev.eligibleKey)
              ? prev.eligibleKey
              : cols.find((c) => /eligible|สิทธิ|allow/i.test(c)) || prev.eligibleKey;

          const next = { ...prev, nameKey: nameGuess, idKey: idGuess, teamKey: teamGuess, deptKey: deptGuess, eligibleKey: eligGuess };
          localStorage.setItem("ld_mapping", JSON.stringify(next));
          return next;
        });

        // ✅ ถ้า operator ว่าง ให้ตั้งค่า default แบบเงียบๆ
        setOperator((prev) => {
          if (safeStr(prev)) return prev;
          const next = "Admin";
          localStorage.setItem("ld_operator", next);
          return next;
        });
      }
    })();
  }, []);

  /* =========================
     Load prizes
  ========================= */
  async function loadPrizes() {
    const r = await getJSON<SheetPayload>("/api/sheets/prizes").catch(() => null);
    if (!r?.ok) return;

    const rows = (r.rows || []) as Prize[];
    const filtered = showInactive ? rows : rows.filter((p) => isActiveRow(p));

    filtered.sort((a: any, b: any) => {
      const pa = Number(safeStr(a.priority) || 999999);
      const pb = Number(safeStr(b.priority) || 999999);
      if (pa !== pb) return pa - pb;
      const ia = safeStr(a.prize_id || a.id || "");
      const ib = safeStr(b.prize_id || b.id || "");
      return ia.localeCompare(ib);
    });

    setPrizes(filtered);

    const still = filtered.some((p: any) => safeStr(p.prize_id || p.id) === selectedPrizeId);
    if (!still) {
      const first: any = filtered[0];
      setSelectedPrizeId(first ? safeStr(first.prize_id || first.id) : "");
    } else if (!selectedPrizeId) {
      const first: any = filtered[0];
      if (first) setSelectedPrizeId(safeStr(first.prize_id || first.id));
    }
  }

  useEffect(() => {
    loadPrizes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInactive]);

  /* =========================
     When selected prize -> set + open preview
  ========================= */
  useEffect(() => {
    if (!selectedPrize) return;

    realtime.send("SET_PRIZE", { prize: selectedPrize });
    realtime.send("SET_UI", {
      ui: {
        showPrizePreview: true,
        selectedPrizeIndex: selectedPrizeIndex ?? undefined,
        previewHint: "เตรียมพร้อม… กด START เพื่อเริ่มสุ่ม",
      },
    });

    // ✅ sound
    playSound("click");

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPrizeId]);

  function selectPrizeByIndex(i1: number) {
    const p: any = (prizes as any[])[i1 - 1];
    if (!p) return;
    setSelectedPrizeId(safeStr(p.prize_id || p.id));
    playSound("click");
  }

  function closePreview() {
    realtime.send("SET_UI", { ui: { showPrizePreview: false } });
    playSound("previewOff");
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
    playSound(open ? "previewOff" : "previewOn");
  }

  function pressStart() {
    realtime.send("SET_UI", { ui: { showPrizePreview: false } });
    realtime.send("START_SPIN");
    playSound("start");
  }

  function pressStop() {
    // ✅ mapping/operator ยังส่งเหมือนเดิม (แค่ไม่โชว์ UI)
    realtime.send("STOP_SPIN", { mapping, operator });
    playSound("stop");
  }

  function pressReset() {
    realtime.send("RESET");
    playSound("reset");
  }

  const selected: any = selectedPrize as any;
  const prizeName = safeStr(selected?.prize_name || selected?.name || "");
  const prizeId = safeStr(selected?.prize_id || selected?.id || "");
  const prizeQty = safeStr(selected?.qty || "1");
  const prizePriority = safeStr(selected?.priority || "—");
  const prizeImg = safeStr(selected?.prize_image_url || selected?.image || "");

  const filteredCatalog = useMemo(() => {
    const q = safeStr(qPrize).toLowerCase();
    if (!q) return prizes;
    return (prizes as any[]).filter((p) => {
      const name = safeStr(p.prize_name || p.name || "").toLowerCase();
      const id = safeStr(p.prize_id || p.id || "").toLowerCase();
      const pri = safeStr(p.priority || "").toLowerCase();
      return name.includes(q) || id.includes(q) || pri.includes(q);
    });
  }, [prizes, qPrize]);

  async function submitAddPrize() {
    const row = {
      prize_id: apId || undefined,
      prize_name: apName,
      prize_image_url: apImg,
      qty: apQty,
      active: apActive,
      priority: apPriority,
    };

    const res = await fetch(`${SERVER_HTTP}/api/write/add-prize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row }),
    });

    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      alert("เพิ่มรางวัลไม่สำเร็จ (ต้องตั้งค่า WRITE_WEBAPP_URL ใน server/.env)\n" + JSON.stringify(json, null, 2));
      return;
    }

    setApId("");
    setApName("");
    setApImg("");
    setApQty("1");
    setApActive("TRUE");
    setApPriority("");

    setAddOpen(false);
    await loadPrizes();
    playSound("click");
  }

  function resetAddForm() {
    setApId("");
    setApName("");
    setApImg("");
    setApQty("1");
    setApActive("TRUE");
    setApPriority("");
    playSound("click");
  }

  function setMode(mode: "exclude" | "repeat") {
    realtime.send("SET_MODE", { mode });
    playSound("click");
  }

  return (
    <div style={S.page}>
      <style>{CSS}</style>

      <div style={S.shell}>
        {/* ================= Header ================= */}
        <div style={S.header}>
          <div style={S.headerLeft}>
            <div style={S.kicker}>ADMIN CONTROL</div>
            <div style={S.title}>LED Lucky Draw 3D</div>
            <div style={S.metaRow}>
              <StatusDot ok={connected} />
              <div style={S.metaText}>
                Realtime:{" "}
                <b style={{ color: connected ? "rgba(10,120,100,1)" : "rgba(190,40,40,1)" }}>
                  {connected ? "Connected" : "Disconnected"}
                </b>
              </div>
              <div style={S.metaDot}>•</div>
              <div style={S.metaText}>
                Server: <b style={{ color: "rgba(15,23,42,.92)" }}>{prettyServerLabel()}</b>
              </div>
            </div>
          </div>

          {/* ✅ ย้ายปุ่ม “ตัดชื่อ/สุ่มซ้ำ” มาไว้ตรงพื้นที่วงในรูป (Header ขวา) */}
          <div style={S.headerRight}>
            <div style={S.readyCard}>
              <div style={S.readyTop}>
                <div style={{ ...S.readyBadge, ...(isSpinning ? S.badgeSpin : S.badgeReady) }}>
                  {isSpinning ? "SPINNING" : "READY"}
                </div>

                <div style={S.modeCompactHint}>{state?.mode === "repeat" ? "ไม่ตัดชื่อ (สุ่มซ้ำได้)" : "ตัดชื่อคนที่ได้แล้ว"}</div>
              </div>

              <div style={S.modeSwitchRow}>
                <button
                  type="button"
                  onClick={() => setMode("exclude")}
                  disabled={isSpinning}
                  style={{ ...S.modeChip, ...(state?.mode !== "repeat" ? S.modeChipOn : null), ...(isSpinning ? S.disabled : null) }}
                >
                  ตัดชื่อคนที่ได้แล้ว
                </button>
                <button
                  type="button"
                  onClick={() => setMode("repeat")}
                  disabled={isSpinning}
                  style={{ ...S.modeChip, ...(state?.mode === "repeat" ? S.modeChipOn : null), ...(isSpinning ? S.disabled : null) }}
                >
                  ไม่ตัดชื่อ (สุ่มซ้ำได้)
                </button>
              </div>

              {/* ✅ SOUND CONTROLS */}
              <div style={S.soundRow}>
                <button
                  type="button"
                  onClick={() => {
                    setSoundOn((v) => !v);
                    // if enabling -> tiny click (may be blocked until user gesture; this is a gesture)
                    if (!soundOn) playSound("click");
                  }}
                  style={{ ...S.soundToggle, ...(soundOn ? S.soundToggleOn : null) }}
                  title="เปิด/ปิดเสียง"
                >
                  {soundOn ? "🔊 Sound On" : "🔇 Muted"}
                </button>

                <div style={S.soundRight}>
                  <div style={S.soundLabel}>Volume</div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(clamp01(volume) * 100)}
                    onChange={(e) => setVolume(clamp01(Number(e.target.value) / 100))}
                    style={S.soundRange}
                    aria-label="Volume"
                  />
                  <div style={S.soundPct}>{Math.round(clamp01(volume) * 100)}%</div>
                </div>
              </div>

              <div style={S.readyHint}>เลือกของรางวัล → กด Preview/Start/Stop ได้ทันที</div>
            </div>
          </div>
        </div>

        {/* ================= Add Prize (Dropdown Accordion) ================= */}
        <div style={S.addWrap}>
          <button
            type="button"
            onClick={() => {
              setAddOpen((v) => !v);
              playSound("click");
            }}
            style={{ ...S.addToggle, ...(addOpen ? S.addToggleOn : null) }}
            aria-expanded={addOpen}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={S.addIcon}>{addOpen ? "▾" : "▸"}</div>
              <div style={{ display: "grid", gap: 2, textAlign: "left" }}>
                <div style={S.addTitle}>Add Prize</div>
                <div style={S.addSub}>กดเพื่อเปิด/ปิดฟอร์มเพิ่มรางวัล (ไม่ชนกับส่วนอื่น)</div>
              </div>
            </div>

            <div style={S.addRight}>
              <button
                type="button"
                style={S.btnGhost}
                onClick={(e) => {
                  e.stopPropagation();
                  loadPrizes();
                  playSound("click");
                }}
                disabled={isSpinning}
              >
                ↻ Refresh
              </button>
              <button
                type="button"
                style={S.btnGhost}
                onClick={(e) => {
                  e.stopPropagation();
                  resetAddForm();
                }}
              >
                เคลียร์
              </button>
            </div>
          </button>

          {addOpen ? (
            <div style={S.addPanel}>
              <div style={S.addGrid}>
                {/* form */}
                <div style={S.addForm}>
                  <div style={S.formGrid}>
                    <Field label="prize_id (optional)" hint="เช่น R001">
                      <input style={S.input} value={apId} onChange={(e) => setApId(e.target.value)} placeholder="R004" />
                    </Field>

                    <Field label="qty" hint="จำนวน">
                      <input style={S.input} inputMode="numeric" value={apQty} onChange={(e) => setApQty(e.target.value)} placeholder="1" />
                    </Field>

                    <Field label="priority (optional)" hint="ลำดับ 1..N">
                      <input
                        style={S.input}
                        inputMode="numeric"
                        value={apPriority}
                        onChange={(e) => setApPriority(e.target.value)}
                        placeholder="1,2,3..."
                      />
                    </Field>

                    <Field label="active" hint="เปิด/ปิด">
                      <select style={S.select} value={apActive} onChange={(e) => setApActive(e.target.value)}>
                        <option value="TRUE">TRUE</option>
                        <option value="FALSE">FALSE</option>
                      </select>
                    </Field>

                    <Field label="prize_name" hint="ชื่อรางวัล" full>
                      <input style={S.input} value={apName} onChange={(e) => setApName(e.target.value)} placeholder="เช่น iPad 10th Gen" />
                    </Field>

                    <Field label="prize_image_url (optional)" hint="https://... หรือ /images/..." full>
                      <input
                        style={S.input}
                        value={apImg}
                        onChange={(e) => setApImg(e.target.value)}
                        placeholder="https://...jpg หรือ /images/prizes/xxx.jpg"
                      />
                    </Field>
                  </div>

                  <div style={S.addFooter}>
                    <button
                      style={{ ...S.btnPrimary, ...(apName.trim() ? null : S.disabledBtn) }}
                      onClick={submitAddPrize}
                      disabled={!apName.trim() || isSpinning}
                    >
                      ＋ บันทึกลงชีต Prizes
                    </button>
                    <div style={S.note}>
                      ต้องมี <b>WRITE_WEBAPP_URL</b> ใน <b>server/.env</b> (Google Apps Script Web App)
                    </div>
                  </div>
                </div>

                {/* preview */}
                <div style={S.addPreview}>
                  <div style={S.previewTop}>
                    <div style={S.h3}>Preview</div>
                    <span style={{ ...S.tag, ...(apActive === "TRUE" ? S.tagOk : S.tagOff) }}>{apActive === "TRUE" ? "ACTIVE" : "INACTIVE"}</span>
                  </div>

                  <div style={S.previewCard}>
                    <div style={S.previewMedia}>
                      {apImg && isLikelyUrl(apImg) ? (
                        <img
                          src={apImg}
                          alt=""
                          style={S.previewImg}
                          onError={(e) => (((e.currentTarget as HTMLImageElement).style.display = "none"), undefined)}
                        />
                      ) : (
                        <div style={S.previewFallback}>
                          <div style={{ fontWeight: 900, color: "rgba(15,23,42,.86)" }}>ภาพตัวอย่าง</div>
                          <div style={{ marginTop: 6, fontSize: 12, color: "rgba(100,116,139,.85)", fontWeight: 700 }}>
                            ใส่ prize_image_url เพื่อแสดงรูป
                          </div>
                        </div>
                      )}
                    </div>

                    <div style={S.previewInfo}>
                      <div style={S.previewName}>{apName || "ชื่อรางวัล"}</div>
                      <div style={S.previewRow}>
                        <span style={S.previewKey}>ID</span>
                        <span style={S.previewVal}>{apId || "—"}</span>
                      </div>
                      <div style={S.previewRow}>
                        <span style={S.previewKey}>Qty</span>
                        <span style={S.previewVal}>{apQty || "1"}</span>
                      </div>
                      <div style={S.previewRow}>
                        <span style={S.previewKey}>Priority</span>
                        <span style={S.previewVal}>{apPriority || "—"}</span>
                      </div>
                    </div>
                  </div>

                  <div style={S.previewTip}>Tip: ใส่ priority เพื่อให้เรียงบนปุ่ม 1..N และ Catalog</div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* ================= Main Layout ================= */}
        {/* ✅ เปลี่ยนเป็นคอลัมน์เดียว: Prize Catalog กว้างเต็ม */}
        <div className="admGrid" style={S.mainGrid}>
          <section style={S.card}>
            <div style={S.cardTop}>
              <div>
                <div style={S.h2}>เลือกของรางวัล</div>
                <div style={S.p}>กดเลขเพื่อเลือก · ระบบจะส่งไป Presenter และเปิด Preview ให้อัตโนมัติ</div>
              </div>
              <div style={S.topActions}>
                <button
                  style={S.btnGhost}
                  onClick={() => {
                    loadPrizes();
                    playSound("click");
                  }}
                  disabled={isSpinning}
                >
                  ↻ Refresh
                </button>
                <button
                  style={{ ...S.btn, ...(previewOpen ? S.btnOn : null) }}
                  onClick={togglePreview}
                  disabled={!selectedPrize}
                >
                  👁 Preview
                </button>
                <button style={S.btnGhost} onClick={closePreview}>
                  ✕ ปิด
                </button>
              </div>
            </div>

            {/* Quick numbers */}
            <div style={S.numberGrid}>
              {(prizes as any[]).map((p, idx) => {
                const id = safeStr(p.prize_id || p.id || idx);
                const active = safeStr(p.prize_id || p.id) === selectedPrizeId;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => selectPrizeByIndex(idx + 1)}
                    disabled={isSpinning}
                    title={safeStr(p.prize_name || p.name || "")}
                    style={{ ...S.numBtn, ...(active ? S.numBtnOn : null), ...(isSpinning ? S.disabled : null) }}
                  >
                    {idx + 1}
                  </button>
                );
              })}
              {!prizes.length ? <div style={{ ...S.p, marginTop: 8 }}>⚠️ ไม่พบรางวัลในชีต Prizes</div> : null}
            </div>

            {/* Selected prize */}
            <div style={S.selectedWrap}>
              <div style={S.selectedInfo}>
                <div style={S.selectedBadgeRow}>
                  <div style={S.selectedBadge}>🎁 รางวัลที่ {selectedPrizeIndex ?? "—"}</div>
                  <div style={S.selectedMeta}>
                    Qty: <b>{safeStr(prizeQty)}</b>
                  </div>
                </div>
                <div style={S.selectedName}>{prizeName || "— เลือกรางวัล —"}</div>
                <div style={S.selectedSub}>
                  ID: <b>{prizeId || "—"}</b>
                  <span style={S.dotSep}>•</span>
                  Priority: <b>{prizePriority}</b>
                </div>
                <div style={S.selectedMiniActions}>
                  <button
                    style={{ ...S.btn, ...(previewOpen ? S.btnOn : null) }}
                    onClick={() => {
                      realtime.send("SET_UI", {
                        ui: {
                          showPrizePreview: true,
                          selectedPrizeIndex: selectedPrizeIndex ?? undefined,
                          previewHint: "เตรียมพร้อม… กด START เพื่อเริ่มสุ่ม",
                        },
                      });
                      playSound("previewOn");
                    }}
                    disabled={!selectedPrize}
                  >
                    📺 โชว์ Preview เต็มจอ
                  </button>
                </div>
              </div>

              <div style={S.selectedMedia}>
                {prizeImg && isLikelyUrl(prizeImg) ? (
                  <img
                    src={prizeImg}
                    alt=""
                    style={S.prizeImg}
                    onError={(e) => (((e.currentTarget as HTMLImageElement).style.display = "none"), undefined)}
                  />
                ) : (
                  <div style={S.prizeImgFallback}>
                    <div style={{ fontWeight: 900, color: "rgba(15,23,42,.86)" }}>No image</div>
                    <div style={{ marginTop: 6, fontSize: 12, color: "rgba(100,116,139,.86)" }}>ใส่ prize_image_url ในชีต Prizes</div>
                  </div>
                )}
              </div>
            </div>

            {/* Catalog */}
            <div style={S.catalogBar}>
              <div style={{ display: "grid", gap: 4 }}>
                <div style={S.h3}>Prize Catalog</div>
                <div style={S.pSmall}>รายการทั้งหมด + ค้นหา + กดเลือก</div>
              </div>

              <div style={S.catalogControls}>
                <input style={S.inputWide} value={qPrize} onChange={(e) => setQPrize(e.target.value)} placeholder="ค้นหา (ชื่อ / id / priority)" />
                <button
                  style={{ ...S.btnGhost, ...(showInactive ? S.btnGhostOn : null) }}
                  onClick={() => {
                    setShowInactive((v) => !v);
                    playSound("click");
                  }}
                  title="แสดงรางวัล inactive ด้วย"
                >
                  {showInactive ? "✓ Show Inactive" : "Show Inactive"}
                </button>
              </div>
            </div>

            <div style={S.tableWrap}>
              <div style={S.tableHead}>
                <div>#</div>
                <div>ภาพ</div>
                <div>ชื่อรางวัล</div>
                <div>ID</div>
                <div>Qty</div>
                <div>Priority</div>
                <div>Active</div>
                <div />
              </div>

              <div style={S.tableBodyFlex}>
                {filteredCatalog.map((p: any, idx) => {
                  const id = safeStr(p.prize_id || p.id || idx);
                  const name = safeStr(p.prize_name || p.name || "");
                  const img = safeStr(p.prize_image_url || p.image || "");
                  const qty = safeStr(p.qty || "1");
                  const pri = safeStr(p.priority || "—");
                  const active = isActiveRow(p);
                  const isSel = safeStr(p.prize_id || p.id) === selectedPrizeId;

                  return (
                    <div key={id} style={{ ...S.tr, ...(isSel ? S.trOn : null) }}>
                      <div style={S.tdMono}>{idx + 1}</div>

                      <div>
                        <div style={S.thumb}>
                          {img && isLikelyUrl(img) ? (
                            <img
                              src={img}
                              alt=""
                              style={S.thumbImg}
                              onError={(e) => (((e.currentTarget as HTMLImageElement).style.display = "none"), undefined)}
                            />
                          ) : (
                            <div style={S.thumbFallback}>—</div>
                          )}
                        </div>
                      </div>

                      <div style={S.tdStrong}>{name || "—"}</div>
                      <div style={S.tdMono}>{id || "—"}</div>
                      <div style={S.tdMono}>{qty}</div>
                      <div style={S.tdMono}>{pri}</div>

                      <div>
                        <span style={{ ...S.tag, ...(active ? S.tagOk : S.tagOff) }}>{active ? "TRUE" : "FALSE"}</span>
                      </div>

                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <button
                          style={{ ...S.btnMini, ...(isSel ? S.btnMiniOn : null) }}
                          onClick={() => {
                            setSelectedPrizeId(safeStr(p.prize_id || p.id));
                            playSound("click");
                          }}
                          disabled={isSpinning}
                        >
                          {isSel ? "Selected" : "Select"}
                        </button>
                      </div>
                    </div>
                  );
                })}

                {!filteredCatalog.length ? (
                  <div style={{ padding: 14, color: "rgba(100,116,139,.90)", fontWeight: 800 }}>ไม่พบรางวัลที่ค้นหา</div>
                ) : null}
              </div>
            </div>

            {/* ACTION bottom */}
            <div style={S.actionDockWrap}>
              <div style={S.actionDockTitle}>ACTION</div>
              <div style={S.actionDockGrid}>
                <DockBtn
                  label="PREVIEW"
                  sub="โชว์ของรางวัล"
                  active={previewOpen && !isSpinning}
                  disabled={!selectedPrize || isSpinning}
                  onClick={togglePreview}
                />
                <DockBtn label="START" sub="เริ่มหมุน" active={isSpinning} disabled={!connected || isSpinning || !selectedPrize} onClick={pressStart} />
                <DockBtn
                  label="STOP"
                  sub="หยุด + เลือกผู้ชนะ"
                  danger
                  disabled={!connected || !isSpinning || !selectedPrize}
                  onClick={pressStop}
                />
                <DockBtn label="RESET" sub="รีเซ็ตสถานะ" disabled={!connected} onClick={pressReset} />
              </div>

              {!selectedPrize ? <div style={S.warnText}>⚠️ กรุณาเลือกรางวัลก่อน</div> : null}
            </div>
          </section>
        </div>

        <div style={{ height: 18 }} />
      </div>
    </div>
  );
}

/* =========================
   Small Components
========================= */
function StatusDot({ ok }: { ok: boolean }) {
  return <span style={{ ...S.dot, ...(ok ? S.dotOk : S.dotBad) }} />;
}

function DockBtn({
  label,
  sub,
  active,
  danger,
  disabled,
  onClick,
}: {
  label: string;
  sub?: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...S.dockBtn,
        ...(danger ? S.dockBtnDanger : null),
        ...(active ? (danger ? S.dockBtnDangerOn : S.dockBtnOn) : null),
        ...(disabled ? S.disabled : null),
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 900, letterSpacing: 0.2 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.92, fontWeight: 700 }}>{sub || ""}</div>
    </button>
  );
}

function renderOptions(cols: string[]) {
  return uniq(cols).map((c) => (
    <option key={c} value={c}>
      {c}
    </option>
  ));
}

/* =========================
   Responsive CSS
========================= */
const CSS = `
  html, body, #root { height: auto !important; min-height: 100% !important; overflow: auto !important; }

  /* ✅ ตอนนี้เป็นคอลัมน์เดียวอยู่แล้ว แต่กันไว้เผื่อ override */
  @media (max-width: 1120px){
    .admGrid{ grid-template-columns: 1fr !important; }
  }
`;

/* =========================
   Styles
========================= */
const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(900px 520px at 16% 10%, rgba(16,185,129,.18), transparent 60%)," +
      "radial-gradient(900px 520px at 88% 6%, rgba(56,189,248,.14), transparent 60%)," +
      "linear-gradient(180deg, rgba(248,250,252,1), rgba(241,245,249,1))",
    padding: "18px 14px 22px",
    color: "rgba(15,23,42,.92)",
  },

  shell: { maxWidth: 1240, margin: "0 auto" },

  header: {
    display: "flex",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    borderRadius: 22,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.72)",
    boxShadow: "0 26px 90px -70px rgba(15,23,42,.30)",
    padding: 16,
    backdropFilter: "blur(14px)",
  },
  headerLeft: { minWidth: 300 },
  headerRight: { minWidth: 360, display: "grid", justifyItems: "end" },

  kicker: { fontSize: 12, fontWeight: 900, letterSpacing: 1.1, color: "rgba(100,116,139,.90)" },
  title: { marginTop: 3, fontSize: 24, fontWeight: 950, letterSpacing: -0.3, color: "rgba(15,23,42,.94)" },

  metaRow: { marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  metaText: { fontSize: 13, fontWeight: 750, color: "rgba(51,65,85,.95)" },
  metaDot: { opacity: 0.45, fontWeight: 900 },

  dot: { width: 9, height: 9, borderRadius: 999, boxShadow: "0 0 0 4px rgba(15,23,42,.06)" },
  dotOk: { background: "rgba(16,185,129,1)" },
  dotBad: { background: "rgba(239,68,68,1)" },

  readyCard: {
    width: "min(680px, 100%)",
    borderRadius: 18,
    border: "1px solid rgba(15,23,42,.10)",
    background: "linear-gradient(180deg, rgba(255,255,255,.78), rgba(255,255,255,.56))",
    padding: 12,
  },
  readyTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" },
  readyBadge: {
    borderRadius: 999,
    padding: "7px 12px",
    fontWeight: 950,
    fontSize: 12,
    letterSpacing: 0.9,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.72)",
  },
  badgeReady: { color: "rgba(10,120,100,1)", border: "1px solid rgba(16,185,129,.25)", background: "rgba(16,185,129,.10)" },
  badgeSpin: { color: "rgba(190,40,40,1)", border: "1px solid rgba(239,68,68,.25)", background: "rgba(239,68,68,.10)" },

  modeCompactHint: {
    borderRadius: 999,
    padding: "7px 10px",
    fontSize: 12,
    fontWeight: 800,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(15,23,42,.04)",
    color: "rgba(15,23,42,.82)",
    whiteSpace: "nowrap",
  },

  modeSwitchRow: {
    marginTop: 10,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  modeChip: {
    height: 44,
    borderRadius: 999,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.80)",
    color: "rgba(15,23,42,.88)",
    fontWeight: 950,
    cursor: "pointer",
    boxShadow: "0 18px 60px -52px rgba(15,23,42,.30)",
  },
  modeChipOn: {
    border: "1px solid rgba(16,185,129,.40)",
    background: "linear-gradient(180deg, rgba(16,185,129,.14), rgba(255,255,255,.82))",
  },

  // ✅ SOUND UI
  soundRow: {
    marginTop: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
    borderRadius: 16,
    border: "1px solid rgba(15,23,42,.08)",
    background: "rgba(255,255,255,.70)",
    padding: "10px 10px",
  },
  soundToggle: {
    height: 38,
    padding: "0 12px",
    borderRadius: 999,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.86)",
    color: "rgba(15,23,42,.88)",
    fontWeight: 900,
    cursor: "pointer",
    boxShadow: "0 18px 60px -52px rgba(15,23,42,.22)",
  },
  soundToggleOn: {
    border: "1px solid rgba(16,185,129,.35)",
    background: "linear-gradient(180deg, rgba(16,185,129,.12), rgba(255,255,255,.86))",
  },
  soundRight: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" },
  soundLabel: { fontSize: 12, fontWeight: 900, color: "rgba(71,85,105,.95)" },
  soundRange: { width: 170 },
  soundPct: { fontSize: 12, fontWeight: 900, color: "rgba(15,23,42,.78)", minWidth: 42, textAlign: "right" },

  readyHint: { marginTop: 10, fontSize: 12, fontWeight: 700, color: "rgba(71,85,105,.95)" },

  addWrap: {
    marginTop: 12,
    borderRadius: 22,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.70)",
    boxShadow: "0 26px 90px -70px rgba(15,23,42,.26)",
    overflow: "hidden",
    backdropFilter: "blur(14px)",
  },
  addToggle: {
    width: "100%",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    padding: 14,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  addToggleOn: { background: "rgba(16,185,129,.06)" },
  addIcon: {
    width: 26,
    height: 26,
    borderRadius: 10,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.84)",
    display: "grid",
    placeItems: "center",
    fontWeight: 900,
    color: "rgba(15,23,42,.80)",
  },
  addTitle: { fontSize: 15, fontWeight: 950, color: "rgba(15,23,42,.92)" },
  addSub: { fontSize: 12, fontWeight: 700, color: "rgba(71,85,105,.92)" },
  addRight: { display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" },
  addPanel: {
    borderTop: "1px solid rgba(15,23,42,.08)",
    padding: 14,
    background: "rgba(255,255,255,.62)",
  },

  // ✅ single column
  mainGrid: {
    marginTop: 12,
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 14,
    alignItems: "start",
  },

  card: {
    borderRadius: 22,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.70)",
    boxShadow: "0 26px 90px -70px rgba(15,23,42,.28)",
    padding: 14,
    backdropFilter: "blur(14px)",
  },

  cardTop: { display: "flex", alignItems: "start", justifyContent: "space-between", gap: 10, flexWrap: "wrap" },

  h2: { fontSize: 16, fontWeight: 950, color: "rgba(15,23,42,.92)" },
  h3: { fontSize: 14, fontWeight: 900, color: "rgba(15,23,42,.88)" },
  p: { marginTop: 6, fontSize: 13, fontWeight: 700, color: "rgba(71,85,105,.95)", lineHeight: 1.35 },
  pSmall: { marginTop: 2, fontSize: 12, fontWeight: 700, color: "rgba(71,85,105,.92)" },

  topActions: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" },

  btn: {
    height: 40,
    padding: "0 12px",
    borderRadius: 12,
    border: "1px solid rgba(16,185,129,.30)",
    background: "linear-gradient(180deg, rgba(16,185,129,.16), rgba(16,185,129,.08))",
    color: "rgba(15,23,42,.92)",
    fontWeight: 900,
    cursor: "pointer",
    boxShadow: "0 20px 60px -46px rgba(15,23,42,.35)",
  },
  btnOn: { border: "1px solid rgba(16,185,129,.45)", background: "linear-gradient(180deg, rgba(16,185,129,.22), rgba(16,185,129,.10))" },
  btnGhost: {
    height: 40,
    padding: "0 12px",
    borderRadius: 12,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.76)",
    color: "rgba(15,23,42,.86)",
    fontWeight: 850,
    cursor: "pointer",
  },
  btnGhostOn: { border: "1px solid rgba(16,185,129,.30)", background: "rgba(16,185,129,.10)" },

  numberGrid: { marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(52px, 1fr))", gap: 10 },
  numBtn: {
    height: 52,
    borderRadius: 999,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.70)",
    color: "rgba(15,23,42,.90)",
    fontWeight: 950,
    fontSize: 16,
    cursor: "pointer",
    boxShadow: "0 18px 60px -48px rgba(15,23,42,.35)",
  },
  numBtnOn: { border: "1px solid rgba(16,185,129,.45)", background: "linear-gradient(180deg, rgba(16,185,129,.14), rgba(255,255,255,.74))" },

  selectedWrap: { marginTop: 14, display: "grid", gridTemplateColumns: "1.15fr 0.85fr", gap: 12, alignItems: "stretch" },
  selectedInfo: { borderRadius: 18, border: "1px solid rgba(15,23,42,.10)", background: "rgba(255,255,255,.72)", padding: 14, display: "grid", gap: 10 },
  selectedBadgeRow: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" },
  selectedBadge: { borderRadius: 999, padding: "8px 12px", border: "1px solid rgba(15,23,42,.10)", background: "rgba(15,23,42,.03)", fontWeight: 900 },
  selectedMeta: { fontSize: 13, fontWeight: 750, color: "rgba(71,85,105,.95)" },
  selectedName: { fontSize: 18, fontWeight: 950, color: "rgba(15,23,42,.94)" },
  selectedSub: { fontSize: 13, fontWeight: 750, color: "rgba(71,85,105,.95)" },
  dotSep: { margin: "0 8px", opacity: 0.45 },
  selectedMiniActions: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 2 },

  selectedMedia: {
    borderRadius: 18,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.72)",
    overflow: "hidden",
    minHeight: 160,
    display: "grid",
    placeItems: "center",
  },
  prizeImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  prizeImgFallback: { width: "100%", height: "100%", display: "grid", placeItems: "center", textAlign: "center", padding: 12 },

  catalogBar: {
    marginTop: 14,
    paddingTop: 12,
    borderTop: "1px solid rgba(15,23,42,.08)",
    display: "flex",
    gap: 10,
    alignItems: "start",
    justifyContent: "space-between",
    flexWrap: "wrap",
  },
  catalogControls: { display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" },

  input: {
    width: "100%",
    height: 44,
    borderRadius: 14,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.82)",
    padding: "0 12px",
    color: "rgba(15,23,42,.90)",
    fontWeight: 800,
    outline: "none",
    boxSizing: "border-box",
  },
  inputWide: {
    width: "min(360px, 100%)",
    height: 44,
    borderRadius: 14,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.82)",
    padding: "0 12px",
    color: "rgba(15,23,42,.90)",
    fontWeight: 800,
    outline: "none",
    boxSizing: "border-box",
  },
  select: {
    width: "100%",
    height: 44,
    borderRadius: 14,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.82)",
    padding: "0 12px",
    color: "rgba(15,23,42,.90)",
    fontWeight: 800,
    outline: "none",
    boxSizing: "border-box",
  },

  label: { display: "block", fontSize: 12, fontWeight: 850, color: "rgba(71,85,105,.95)" },
  hint: { fontSize: 11, fontWeight: 750, color: "rgba(100,116,139,.95)", whiteSpace: "nowrap" },

  field: { display: "grid", gap: 8, minWidth: 0 },
  fieldFull: { gridColumn: "1 / -1" },
  fieldTop: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, minWidth: 0 },

  tableWrap: { marginTop: 10, borderRadius: 16, border: "1px solid rgba(15,23,42,.10)", overflow: "hidden", background: "rgba(255,255,255,.76)" },
  tableHead: { display: "grid", gridTemplateColumns: "52px 64px 1fr 160px 90px 100px 90px 96px", gap: 10, padding: "10px 12px", background: "rgba(15,23,42,.03)", color: "rgba(71,85,105,.95)", fontWeight: 900, fontSize: 12 },

  tableBodyFlex: { maxHeight: "clamp(320px, 52vh, 720px)", overflow: "auto" },

  tr: { display: "grid", gridTemplateColumns: "52px 64px 1fr 160px 90px 100px 90px 96px", gap: 10, padding: "10px 12px", borderTop: "1px solid rgba(15,23,42,.08)", alignItems: "center" },
  trOn: { background: "linear-gradient(90deg, rgba(16,185,129,.10), rgba(255,255,255,.70))" },

  tdMono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace", fontSize: 12, fontWeight: 800, color: "rgba(15,23,42,.86)" },
  tdStrong: { fontSize: 13, fontWeight: 900, color: "rgba(15,23,42,.90)" },

  thumb: { width: 48, height: 48, borderRadius: 12, border: "1px solid rgba(15,23,42,.10)", background: "rgba(255,255,255,.82)", overflow: "hidden", display: "grid", placeItems: "center" },
  thumbImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  thumbFallback: { fontWeight: 900, color: "rgba(100,116,139,.95)" },

  tag: { display: "inline-flex", alignItems: "center", justifyContent: "center", height: 28, padding: "0 10px", borderRadius: 999, border: "1px solid rgba(15,23,42,.10)", fontWeight: 900, fontSize: 12 },
  tagOk: { background: "rgba(16,185,129,.12)", color: "rgba(10,120,100,1)", border: "1px solid rgba(16,185,129,.22)" },
  tagOff: { background: "rgba(239,68,68,.10)", color: "rgba(190,40,40,1)", border: "1px solid rgba(239,68,68,.20)" },

  btnMini: { height: 32, padding: "0 10px", borderRadius: 999, border: "1px solid rgba(15,23,42,.10)", background: "rgba(255,255,255,.82)", color: "rgba(15,23,42,.86)", fontWeight: 900, cursor: "pointer" },
  btnMiniOn: { border: "1px solid rgba(16,185,129,.30)", background: "rgba(16,185,129,.10)" },

  actionDockWrap: { marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(15,23,42,.08)" },
  actionDockTitle: { fontSize: 12, fontWeight: 900, letterSpacing: 1.1, color: "rgba(71,85,105,.95)" },
  actionDockGrid: { marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 },

  dockBtn: {
    height: 72,
    borderRadius: 999,
    border: "1px solid rgba(15,23,42,.10)",
    background: "rgba(255,255,255,.82)",
    color: "rgba(15,23,42,.88)",
    textAlign: "left",
    padding: "10px 14px",
    cursor: "pointer",
    boxShadow: "0 20px 70px -58px rgba(15,23,42,.40)",
  },
  dockBtnOn: { border: "1px solid rgba(16,185,129,.35)", background: "rgba(16,185,129,.12)" },
  dockBtnDanger: { border: "1px solid rgba(239,68,68,.22)" },
  dockBtnDangerOn: { border: "1px solid rgba(239,68,68,.35)", background: "rgba(239,68,68,.10)" },

  warnText: { marginTop: 10, fontSize: 12, fontWeight: 800, color: "rgba(190,40,40,1)" },

  addGrid: { marginTop: 2, display: "grid", gridTemplateColumns: "1.25fr 0.75fr", gap: 12, alignItems: "start" },
  addForm: { borderRadius: 18, border: "1px solid rgba(15,23,42,.10)", background: "rgba(255,255,255,.78)", padding: 12 },
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },

  addFooter: { marginTop: 12, display: "grid", gap: 10 },

  btnPrimary: {
    height: 46,
    width: "100%",
    borderRadius: 16,
    border: "1px solid rgba(16,185,129,.30)",
    background: "linear-gradient(180deg, rgba(16,185,129,.18), rgba(16,185,129,.09))",
    color: "rgba(15,23,42,.92)",
    fontWeight: 950,
    cursor: "pointer",
    boxShadow: "0 26px 90px -72px rgba(15,23,42,.35)",
  },
  disabledBtn: { opacity: 0.55, cursor: "not-allowed" },

  note: { fontSize: 12, fontWeight: 750, color: "rgba(71,85,105,.95)", padding: "10px 12px", borderRadius: 14, border: "1px solid rgba(15,23,42,.10)", background: "rgba(15,23,42,.03)" },

  addPreview: { borderRadius: 18, border: "1px solid rgba(15,23,42,.10)", background: "rgba(255,255,255,.78)", padding: 12 },
  previewTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" },
  previewCard: { marginTop: 10, borderRadius: 18, border: "1px solid rgba(15,23,42,.10)", background: "rgba(255,255,255,.85)", overflow: "hidden" },
  previewMedia: { width: "100%", aspectRatio: "16 / 10", background: "rgba(15,23,42,.03)", overflow: "hidden", display: "grid", placeItems: "center" },
  previewImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  previewFallback: { height: "100%", display: "grid", placeItems: "center", textAlign: "center", padding: 12 },

  previewInfo: { padding: 12, display: "grid", gap: 8 },
  previewName: { fontSize: 15, fontWeight: 950, color: "rgba(15,23,42,.92)" },
  previewRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 14, border: "1px solid rgba(15,23,42,.08)", background: "rgba(15,23,42,.02)" },
  previewKey: { fontSize: 12, fontWeight: 800, color: "rgba(71,85,105,.95)" },
  previewVal: { fontSize: 12, fontWeight: 900, color: "rgba(15,23,42,.88)" },

  previewTip: { marginTop: 10, color: "rgba(71,85,105,.92)", fontSize: 12, fontWeight: 700, lineHeight: 1.35 },

  disabled: { opacity: 0.55, cursor: "not-allowed", boxShadow: "none" },
};