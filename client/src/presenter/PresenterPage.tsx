import React, { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Environment, Float, Text, Sparkles } from "@react-three/drei";
import * as THREE from "three";
import { realtime } from "../shared/ws";
import { getJSON, SheetPayload, RealtimeState, Winner, safeStr, resolvePrizeImage } from "../shared/api";
import { SpinController, useSpinController } from "./SpinController";

export default function PresenterPage() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<RealtimeState | null>(null);
  const [participants, setParticipants] = useState<Record<string, any>[]>([]);
  const [nameKey, setNameKey] = useState<string>("name");

  const spin = useSpinController();

  useEffect(() => {
    realtime.connect();
    const off = realtime.on((msg) => {
      if (msg.type === "CONNECTED") setConnected(true);
      if (msg.type === "DISCONNECTED") setConnected(false);

      if (msg.type === "STATE") setState(msg.payload);

      if (msg.type === "STARTED") {
        setState(msg.payload);
        spin.start();
      }

      if (msg.type === "STOPPING") {
        const winner: Winner | null = msg.payload?.winner || null;
        setState(msg.payload);
        spin.stopWithWinner(winner);
      }
    });
    return off;
  }, [spin]);

  useEffect(() => {
    (async () => {
      try {
        const data = await getJSON<SheetPayload>("/api/sheets/participants");
        if (data.ok) {
          setParticipants(data.rows || []);
          const cols = data.columns || [];
          const guess = cols.find((c) => /name|ชื่อ/i.test(c)) || cols[0] || "name";
          setNameKey(guess);
        }
      } catch (e) {
        console.warn(e);
      }
    })();
  }, []);

  const names = useMemo(() => {
    const list = (participants || []).map((r) => safeStr(r[nameKey])).filter(Boolean);
    return list.slice(0, 500);
  }, [participants, nameKey]);

  const prizeName = safeStr(state?.prize?.prize_name ?? state?.prize?.name ?? "");
  const prizeImg = resolvePrizeImage(state?.prize || undefined); // ✅ สำคัญมาก
  const winner = state?.lastWinner || null;

  const previewOpen = !!state?.ui?.showPrizePreview && !state?.spinning;
  const previewIndex = typeof state?.ui?.selectedPrizeIndex === "number" ? state?.ui?.selectedPrizeIndex : undefined;
  const previewHint = safeStr(state?.ui?.previewHint || "กด START ที่หน้า Admin เพื่อเริ่มสุ่ม");

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <PrizePreviewFullscreen
        open={previewOpen}
        prizeName={prizeName}
        prizeImg={prizeImg}
        prizeIndex={previewIndex}
        hint={previewHint}
      />

      {/* Top overlay */}
      <div className="overlayWrap">
        <div className="overlayBox">
          <div className="kicker">Presenter</div>
          <div className="h2">{connected ? "Realtime: Connected" : "Realtime: Disconnected"}</div>
          <div className="p">
            โหมด: <b>{state?.mode === "repeat" ? "ไม่ตัดชื่อ" : "ตัดชื่อคนที่ได้แล้ว"}</b>
          </div>
        </div>

        <div className="overlayBox" style={{ textAlign: "right" }}>
          <div className="kicker">Prize</div>
          <div className="h2">{prizeName || "— เลือกรางวัลในหน้า Admin —"}</div>
          <div className="p">{state?.spinning ? "กำลังสุ่ม…" : "พร้อม"}</div>
        </div>
      </div>

      <Canvas camera={{ position: [0, 0.85, 3.65], fov: 52 }} dpr={[1, 1.6]}>
        <color attach="background" args={["#EAF6FF"]} />

        <ambientLight intensity={0.85} />
        <directionalLight position={[2, 3, 2]} intensity={1.2} />
        <directionalLight position={[-3, 2, -2]} intensity={0.7} />

        <Float speed={1.15} floatIntensity={0.08} rotationIntensity={0.10}>
          <group position={[0, -0.02, 0]}>
            <GlobeWithTextTexture names={names} angle={spin.angle} title={prizeName || "LED Lucky Draw 3D"} />
          </group>
        </Float>

        <Sparkles count={90} scale={[7, 3.4, 7]} size={2} speed={0.6} opacity={0.45} />
        <Environment preset="city" />
        <SpinController />
      </Canvas>

      {/* Winner Reveal */}
      {winner && !state?.spinning && (
        <div className="winnerCard">
          <div className="winnerInner">
            <img
              className="prizeImg"
              src={prizeImg || "/placeholder.png"}
              alt=""
              onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
            />
            <div>
              <div className="badge">🎉 ผู้โชคดี</div>
              <h1 className="bigName">{winner.name || winner.participant_id}</h1>
              <div className="bigPrize">{prizeName}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PrizePreviewFullscreen({
  open,
  prizeName,
  prizeImg,
  prizeIndex,
  hint,
}: {
  open: boolean;
  prizeName: string;
  prizeImg: string;
  prizeIndex?: number;
  hint?: string;
}) {
  if (!open) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 9999, // ✅ กันโดนอะไรทับ
        display: "grid",
        placeItems: "center",
        padding: 28,
        background:
          "radial-gradient(1000px 600px at 30% 15%, rgba(130,210,255,.60), transparent 60%)," +
          "radial-gradient(900px 520px at 80% 25%, rgba(170,240,255,.55), transparent 55%)," +
          "linear-gradient(180deg, rgba(234,246,255,0.92), rgba(234,246,255,0.75))",
        backdropFilter: "blur(10px)",
      }}
    >
      <div
        style={{
          width: "min(1100px, 100%)",
          borderRadius: 34,
          background: "rgba(255,255,255,0.86)",
          border: "1px solid rgba(11,42,58,.12)",
          boxShadow: "0 40px 120px rgba(15,23,42,.18)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1.15fr .85fr", minHeight: 560 }}>
          <div style={{ position: "relative" }}>
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "radial-gradient(700px 420px at 40% 30%, rgba(154,215,255,.55), transparent 60%)," +
                  "linear-gradient(180deg, rgba(255,255,255,0.0), rgba(255,255,255,0.82))",
              }}
            />
            <img
              src={prizeImg || "/placeholder.png"}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
            />
          </div>

          <div style={{ padding: 28, display: "grid", gap: 14, alignContent: "center" }}>
            <div
              style={{
                display: "inline-flex",
                gap: 10,
                alignItems: "center",
                justifyContent: "center",
                padding: "12px 16px",
                borderRadius: 999,
                background: "rgba(11,42,58,.06)",
                border: "1px solid rgba(11,42,58,.10)",
                fontWeight: 1000,
                color: "rgba(11,42,58,.82)",
                width: "fit-content",
              }}
            >
              🎁 {typeof prizeIndex === "number" ? `รางวัลที่ ${prizeIndex}` : "รางวัล"}
            </div>

            <div style={{ fontSize: 54, lineHeight: 1.03, fontWeight: 1150, color: "#0B2A3A", letterSpacing: -0.6 }}>
              {prizeName || "—"}
            </div>

            <div style={{ fontSize: 16, color: "rgba(11,42,58,.72)", fontWeight: 900 }}>
              {hint || "กด START เพื่อเริ่มหมุนสุ่ม"}
            </div>

            <div
              style={{
                marginTop: 8,
                height: 10,
                borderRadius: 999,
                background: "linear-gradient(90deg, rgba(84,187,255,.60), rgba(177,240,255,.60))",
                border: "1px solid rgba(11,42,58,.10)",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function GlobeWithTextTexture({ names, angle, title }: { names: string[]; angle: number; title: string }) {
  const globeRadius = 0.95;

  const textTexture = useMemo(() => {
    const size = 2048;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, size, size);

    const bands = 12;
    const marginX = Math.floor(size * 0.04);
    const bandH = size / bands;

    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(11,42,58,0.90)";
    ctx.shadowColor = "rgba(255,255,255,0.65)";
    ctx.shadowBlur = 2;

    const list = names.slice(0, 700);
    let idx = 0;

    for (let b = 0; b < bands; b++) {
      const y = b * bandH + bandH / 2;
      const fontSize = Math.round(size * (0.018 + (b % 3) * 0.0015));
      ctx.font = `800 ${fontSize}px system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", "Tahoma", sans-serif`;

      let x = marginX;
      const maxX = size - marginX;

      let guard = 0;
      while (x < maxX && guard < 2000) {
        guard++;
        const name = safeStr(list[idx % list.length] || "");
        idx++;
        if (!name) continue;

        const token = name + "   •   ";
        ctx.fillText(token, x, y);
        const w = ctx.measureText(token).width;
        x += w;
        if (w <= 0) break;
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 1);
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }, [names]);

  return (
    <group rotation={[0.12, angle * 0.65, 0]}>
      <mesh>
        <sphereGeometry args={[globeRadius, 96, 96]} />
        <meshStandardMaterial color="#8ED3FF" roughness={0.22} metalness={0.08} map={textTexture} />
      </mesh>

      <mesh>
        <sphereGeometry args={[globeRadius * 1.01, 96, 96]} />
        <meshStandardMaterial color="#CFF0FF" roughness={0.35} metalness={0.2} transparent opacity={0.22} />
      </mesh>

      <Text
        position={[0, 0.10, globeRadius + 0.02]}
        fontSize={0.13}
        color="#0B2A3A"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.002}
        outlineColor="rgba(255,255,255,0.85)"
      >
        {title}
      </Text>
    </group>
  );
}