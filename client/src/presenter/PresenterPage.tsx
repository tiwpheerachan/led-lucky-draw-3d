// client/src/presenter/PresenterPage.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Float, Sparkles } from "@react-three/drei";
import * as THREE from "three";
import { realtime } from "../shared/ws";
import { getJSON, SheetPayload, RealtimeState, Winner, safeStr, resolvePrizeImage } from "../shared/api";
import { SpinController, useSpinController } from "./SpinController";

/* =========================
   ✅ Error Boundary — ป้องกัน WebGL crash พาทั้งหน้าพัง
========================= */
class CanvasErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: any) { console.warn("[CanvasErrorBoundary] WebGL failed:", err); }
  render() {
    if (this.state.failed) {
      return (
        <div style={{
          position: "absolute", inset: 0, zIndex: 2,
          display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column", gap: 8,
        }}>
          <div style={{ color: "rgba(255,255,255,.35)", fontSize: 13, textAlign: "center" }}>
            ⚠️ WebGL ไม่พร้อมใช้งาน<br/>
            <span style={{ fontSize: 11, opacity: .7 }}>เปิด Hardware Acceleration ใน browser settings</span>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* =========================
   ✅ BACKGROUND VIDEO
   Put file in: client/public/videos/presenter-bg.mp4
========================= */
const BG_IMAGE = "/images/presenter-bg.jpg";

/* =========================
   ✅ SFX
   Put files in: client/public/sfx/
   - preview.mp3
   - start.mp3
   - spin-loop.mp3
   - win.mp3
========================= */
const SFX = {
  preview: "/sfx/preview.mp3",
  start: "/sfx/start.mp3",
  loop: "/sfx/spin-loop.mp3",
  win: "/sfx/win.mp3",
};

let __audioUnlocked = false;

async function unlockAudioOnce() {
  if (__audioUnlocked) return;
  try {
    const a = new Audio(SFX.preview);
    a.volume = 0.0001;
    await a.play();
    a.pause();
    a.currentTime = 0;
    __audioUnlocked = true;
  } catch {}
}

function makeAudio(src: string, opts?: { loop?: boolean; volume?: number }) {
  const a = new Audio(src);
  a.preload = "auto";
  if (opts?.loop) a.loop = true;
  if (typeof opts?.volume === "number") a.volume = opts.volume;
  return a;
}

const __oneShot = new Map<string, HTMLAudioElement>();
let __loop: HTMLAudioElement | null = null;

async function playOneShot(key: keyof typeof SFX, volume = 0.8) {
  try {
    await unlockAudioOnce();
  } catch {}
  let a = __oneShot.get(key);
  if (!a) {
    a = makeAudio(SFX[key], { volume });
    __oneShot.set(key, a);
  }
  try {
    a.currentTime = 0;
    a.volume = volume;
    await a.play();
  } catch {}
}

async function playLoop(volume = 0.35) {
  try {
    await unlockAudioOnce();
  } catch {}
  if (!__loop) __loop = makeAudio(SFX.loop, { loop: true, volume });
  try {
    __loop.volume = volume;
    __loop.currentTime = 0;
    await __loop.play();
  } catch {}
}

function stopLoop(fadeMs = 220) {
  if (!__loop) return;
  const a = __loop;
  const startVol = a.volume;
  const t0 = performance.now();
  const tick = () => {
    const t = performance.now() - t0;
    const k = Math.min(1, t / fadeMs);
    a.volume = startVol * (1 - k);
    if (k >= 1) {
      a.pause();
      a.currentTime = 0;
      a.volume = startVol;
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* =========================
   ✅ Inline styles
========================= */
function PresenterStyles() {
  return (
    <style>{`
      .presenterRoot{
        position:relative;
        width:100vw;
        height:100vh;
        overflow:hidden;
        background:#08131A;
        font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", "Tahoma", sans-serif;
      }

      .bgImage{
        position:absolute;
        inset:0;
        width:100%;
        height:100%;
        object-fit:cover;
        z-index:0;
      }

      /* Canvas ต้องโปร่งใสเพื่อให้เห็นรูปข้างหลัง */
      .canvasWrap{
        position:absolute;
        inset:0;
        z-index:2;
        background: transparent !important;
      }
      .canvasWrap canvas{
        background: transparent !important;
      }

      .overlayWrap{
        position:absolute;
        left:0; right:0; top:0;
        z-index:6;
        padding:14px 16px 0;
        display:flex;
        gap:10px;
        justify-content:space-between;
        align-items:flex-start;
        pointer-events:none;
      }
      .overlayBox{
        display:inline-flex;
        flex-direction:column;
        align-items:flex-start;
        gap:4px;
        padding:7px 13px;
        border-radius:999px;
        background: rgba(255,255,255,0.72);
        border:1px solid rgba(255,255,255,0.85);
        box-shadow: 0 2px 12px rgba(0,0,0,.12);
        backdrop-filter: blur(10px);
        max-width: min(220px, 28vw);
      }
      .overlayBoxRight{
        align-items:flex-end;
      }
      .kicker{
        font-size:10px;
        font-weight:800;
        color:#000000;
        letter-spacing:.6px;
        text-transform:uppercase;
        line-height:1;
      }
      .h2{
        font-size:12px;
        line-height:1.2;
        font-weight:700;
        color:#000000;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        max-width:100%;
      }
      .p{
        font-size:10px;
        color:rgba(0,0,0,0.60);
        font-weight:600;
        line-height:1;
      }

      /* ✅ Winner banner — กลางจอ สวยงาม */
      .winnerBackdrop{
        position:absolute;
        inset:0;
        z-index:8;
        display:grid;
        place-items:center;
        background: rgba(0,0,0,0.45);
        backdrop-filter: blur(6px);
        animation: fadeBg .35s ease-out both;
      }
      @keyframes fadeBg{
        from{ opacity:0; }
        to{ opacity:1; }
      }
      .winnerBanner{
        position:relative;
        width:min(680px, calc(100vw - 40px));
        border-radius:36px;
        overflow:hidden;
        background:
          radial-gradient(700px 400px at 30% 0%, rgba(255,230,100,.22), transparent 55%),
          radial-gradient(600px 300px at 80% 10%, rgba(255,180,60,.14), transparent 50%),
          linear-gradient(160deg, rgba(255,255,255,.95), rgba(255,248,230,.90));
        border:1.5px solid rgba(255,210,80,.35);
        box-shadow:
          0 0 0 1px rgba(255,255,255,.5),
          0 30px 80px rgba(0,0,0,.38),
          0 0 120px rgba(255,200,50,.18);
        animation: popIn .42s cubic-bezier(0.34,1.56,0.64,1) both;
      }
      @keyframes popIn{
        from { transform: scale(.82) translateY(24px); opacity: 0; }
        to   { transform: scale(1)   translateY(0);    opacity: 1; }
      }

      /* shimmer sweep */
      .winnerShimmer{
        position:absolute;
        inset:-40% -30%;
        background: linear-gradient(108deg,
          transparent 28%,
          rgba(255,255,255,.55) 46%,
          rgba(255,255,255,.18) 52%,
          transparent 68%
        );
        animation: shimmer 2.8s ease-in-out infinite;
        pointer-events:none;
      }
      @keyframes shimmer{
        0%   { transform: translateX(-60%) skewX(-8deg); }
        100% { transform: translateX( 80%) skewX(-8deg); }
      }

      .winnerInner{
        position:relative;
        display:flex;
        flex-direction:column;
        align-items:center;
        padding: 36px 32px 32px;
        gap:0;
        text-align:center;
      }

      /* top badge */
      .ribbon{
        display:inline-flex;
        align-items:center;
        gap:8px;
        padding:8px 18px;
        border-radius:999px;
        background: linear-gradient(90deg, #f5a623, #f7c948);
        box-shadow: 0 4px 18px rgba(245,166,35,.45);
        font-weight: 800;
        font-size: 13px;
        color: #5a2d00;
        letter-spacing:.4px;
        text-transform: uppercase;
        margin-bottom: 20px;
      }

      /* prize image */
      .winnerImg{
        width:140px;
        height:140px;
        border-radius:28px;
        object-fit:cover;
        background: rgba(255,255,255,.6);
        border:3px solid rgba(255,210,80,.5);
        box-shadow:
          0 8px 32px rgba(0,0,0,.18),
          0 0 0 6px rgba(255,210,80,.12);
        margin-bottom:20px;
      }

      /* name */
      .winnerName{
        font-size:52px;
        line-height:1.05;
        letter-spacing:-1.2px;
        font-weight: 800;
        color: #1a1a2e;
        text-shadow: 0 2px 12px rgba(0,0,0,.10);
        margin-bottom:10px;
      }

      /* prize name */
      .winnerPrize{
        font-size:17px;
        font-weight: 600;
        color: rgba(30,30,60,.65);
        margin-bottom:22px;
      }

      /* bottom pills row */
      .winnerSide{
        display:flex;
        gap:10px;
        justify-content:center;
        flex-wrap:wrap;
      }
      .pill{
        padding:10px 18px;
        border-radius:999px;
        background: rgba(26,26,46,.06);
        border:1px solid rgba(26,26,46,.12);
        font-weight: 700;
        font-size:13px;
        color: rgba(26,26,46,.78);
      }
      .pillStrong{
        background: linear-gradient(90deg, rgba(245,166,35,.22), rgba(247,201,72,.22));
        border-color: rgba(245,166,35,.30);
        color: #7a4400;
      }

      /* fireworks canvas — fixed fullscreen, no own background */
      .fireworksCanvas{
        position:fixed;
        inset:0;
        z-index:10;
        pointer-events:none;
        width:100vw;
        height:100vh;
      }

      @media (max-width: 760px){
        .overlayWrap{ padding:10px 10px 0; }
        .overlayBox{ max-width:min(160px,40vw); }
        .h2{ font-size:11px; }
        .winnerName{ font-size:36px; }
        .winnerImg{ width:110px; height:110px; }
      }
    `}</style>
  );
}

/* =========================
   ✅ Procedural textures: snow + ice glints
========================= */
function makeSnowNoiseTexture(size = 512, density = 0.24, repeat = 7) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const r = Math.random();
    const base = 205 + Math.floor(Math.random() * 34);
    let v = base;
    if (r < density) v = 255;
    if (r < density * 0.25) v = 245;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function makeIceGlintTexture(size = 512, glints = 1800, repeat = 6) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < glints; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const s = 0.6 + Math.random() * 1.8;
    const a = 0.08 + Math.random() * 0.22;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(x, y, s, s);

    if (Math.random() < 0.18) {
      ctx.fillStyle = `rgba(210,245,255,${a})`;
      ctx.fillRect(x, y, s * (1.6 + Math.random() * 1.2), 0.6);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/* =========================
   ✅ Ice shard burst + fall on START
========================= */
function IceShardBurst({
  trigger,
  origin = new THREE.Vector3(0, 0, 0),
  radius = 1.15,
}: {
  trigger: number;
  origin?: THREE.Vector3;
  radius?: number;
}) {
  const count = 380;
  const geom = useMemo(() => new THREE.BufferGeometry(), []);
  const mat = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 0.02,
        transparent: true,
        opacity: 0.0,
        color: new THREE.Color("#EAF8FF"),
        depthWrite: false,
      }),
    []
  );

  const data = useRef<{
    alive: boolean;
    t: number;
    life: number;
    pos: Float32Array;
    vel: Float32Array;
    seed: Float32Array;
  } | null>(null);

  const reset = () => {
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const seed = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);

      const r = radius * (0.94 + Math.random() * 0.06);
      const sx = origin.x + r * Math.sin(phi) * Math.cos(theta);
      const sy = origin.y + r * Math.cos(phi);
      const sz = origin.z + r * Math.sin(phi) * Math.sin(theta);

      pos[i * 3 + 0] = sx;
      pos[i * 3 + 1] = sy;
      pos[i * 3 + 2] = sz;

      const out = new THREE.Vector3(sx - origin.x, sy - origin.y, sz - origin.z).normalize();
      const speed = 0.18 + Math.random() * 0.28;
      const drift = 0.03 + Math.random() * 0.08;

      vel[i * 3 + 0] = out.x * speed + (Math.random() - 0.5) * drift;
      vel[i * 3 + 1] = out.y * speed + 0.1 + Math.random() * 0.12;
      vel[i * 3 + 2] = out.z * speed + (Math.random() - 0.5) * drift;

      seed[i] = Math.random();
    }

    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.attributes.position.needsUpdate = true;

    data.current = {
      alive: true,
      t: 0,
      life: 2.2 + Math.random() * 0.6,
      pos,
      vel,
      seed,
    };

    mat.opacity = 0.85;
  };

  useEffect(() => {
    if (!trigger) return;
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  useFrame((_, dt) => {
    const d = data.current;
    if (!d?.alive) return;

    d.t += dt;

    const fadeIn = Math.min(1, d.t / 0.12);
    const fadeOut = Math.max(0, 1 - Math.max(0, (d.t - (d.life - 0.6)) / 0.6));
    mat.opacity = 0.85 * fadeIn * fadeOut;

    const g = 0.85;
    const drag = 0.985;

    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      d.vel[ix + 1] -= g * dt;

      d.vel[ix + 0] *= drag;
      d.vel[ix + 1] *= drag;
      d.vel[ix + 2] *= drag;

      const flutter = Math.sin((d.t * 3.2 + d.seed[i] * 10) * 1.0) * 0.012 * dt;
      d.vel[ix + 0] += flutter;
      d.vel[ix + 2] -= flutter;

      d.pos[ix + 0] += d.vel[ix + 0] * dt;
      d.pos[ix + 1] += d.vel[ix + 1] * dt;
      d.pos[ix + 2] += d.vel[ix + 2] * dt;
    }

    geom.attributes.position.needsUpdate = true;

    if (d.t >= d.life) {
      d.alive = false;
      mat.opacity = 0;
    }
  });

  return <points geometry={geom} material={mat} frustumCulled={false} />;
}

/* =========================
   ✅ Gentle snowfall (thin)
========================= */
function SnowfallThin() {
  return (
    <>
      <Sparkles count={220} scale={[8.2, 5.2, 8.2]} size={1.1} speed={0.18} opacity={0.18} />
      <Sparkles count={120} scale={[7.0, 4.2, 7.0]} size={0.85} speed={0.12} opacity={0.14} />
    </>
  );
}

/* =========================
   ✅ SnowBall
========================= */
function SnowBall({
  angle,
  names,
  iceBurstTrigger,
  spinning,
}: {
  angle: number;
  names: string[];
  iceBurstTrigger: number;
  spinning: boolean;
}) {
  const globeRadius = 0.95;
  const snowTex = useMemo(() => makeSnowNoiseTexture(512, 0.25, 7), []);
  const iceGlint = useMemo(() => makeIceGlintTexture(512, 2200, 7), []);

  const groupRef  = useRef<THREE.Group>(null);
  const fireRef   = useRef<THREE.Mesh>(null);
  const idleAngle = useRef(0);
  const fireTime  = useRef(0);

  useFrame((_, dt) => {
    idleAngle.current += dt * (spinning ? 3.2 : 0.18);
    if (groupRef.current) {
      groupRef.current.rotation.y = angle * 0.65 + idleAngle.current;
    }

    // fire ring pulse
    if (fireRef.current) {
      fireTime.current += dt;
      const mat = fireRef.current.material as THREE.MeshBasicMaterial;
      if (spinning) {
        const pulse = 0.55 + 0.45 * Math.sin(fireTime.current * 6.5);
        mat.opacity = pulse;
        const s = 1.0 + 0.04 * Math.sin(fireTime.current * 4.2);
        fireRef.current.scale.set(s, s, s);
      } else {
        mat.opacity = Math.max(0, mat.opacity - dt * 2.5);
      }
    }
  });

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
    // ✅ ข้อความสีดำ
    ctx.fillStyle = "rgba(0,0,0,0.82)";
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = 3;

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

  // fire ring texture — orange/red glow ring
  const fireRingTex = useMemo(() => {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2, cy = size / 2;
    // outer glow ring
    for (let pass = 0; pass < 3; pass++) {
      const r0 = size * (0.36 + pass * 0.04);
      const r1 = size * (0.50 + pass * 0.03);
      const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
      const colors = pass === 0
        ? ["rgba(255,60,0,0.0)", "rgba(255,120,0,0.7)", "rgba(255,200,0,0.4)", "rgba(255,60,0,0.0)"]
        : pass === 1
        ? ["rgba(255,80,0,0.0)", "rgba(255,40,0,0.5)", "rgba(255,100,20,0.6)", "rgba(255,80,0,0.0)"]
        : ["rgba(255,200,0,0.0)", "rgba(255,240,80,0.5)", "rgba(255,200,0,0.3)", "rgba(255,200,0,0.0)"];
      g.addColorStop(0,   colors[0]);
      g.addColorStop(0.3, colors[1]);
      g.addColorStop(0.6, colors[2]);
      g.addColorStop(1,   colors[3]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    // fire spikes
    for (let i = 0; i < 24; i++) {
      const a = (Math.PI * 2 * i) / 24;
      const r = size * 0.44;
      const sx = cx + Math.cos(a) * r * 0.85;
      const sy = cy + Math.sin(a) * r * 0.85;
      const ex = cx + Math.cos(a) * r * 1.22;
      const ey = cy + Math.sin(a) * r * 1.22;
      const spike = ctx.createLinearGradient(sx, sy, ex, ey);
      spike.addColorStop(0,   "rgba(255,120,0,0.6)");
      spike.addColorStop(0.5, "rgba(255,200,0,0.4)");
      spike.addColorStop(1,   "rgba(255,80,0,0.0)");
      ctx.strokeStyle = spike;
      ctx.lineWidth = 3 + Math.random() * 4;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, []);

  return (
    <group ref={groupRef} rotation={[0.12, 0, 0]}>
      {/* ✅ fire glow ring — visible when spinning */}
      <mesh ref={fireRef} renderOrder={1}>
        <sphereGeometry args={[globeRadius * 1.22, 64, 64]} />
        <meshBasicMaterial
          map={fireRingTex}
          transparent
          opacity={0}
          depthWrite={false}
          side={THREE.BackSide}
        />
      </mesh>

      <mesh>
        <sphereGeometry args={[globeRadius, 96, 96]} />
        <meshStandardMaterial
          color="#F7FDFF"
          roughness={0.98}
          metalness={0.0}
          bumpMap={snowTex}
          bumpScale={0.075}
          roughnessMap={snowTex}
          map={textTexture}
          transparent
          opacity={0.985}
        />
      </mesh>

      <mesh>
        <sphereGeometry args={[globeRadius * 1.01, 96, 96]} />
        <meshPhysicalMaterial
          color="#EAF8FF"
          roughness={0.22}
          metalness={0.0}
          transparent
          opacity={0.22}
          transmission={0.0}
          clearcoat={1.0}
          clearcoatRoughness={0.16}
          map={iceGlint}
        />
      </mesh>

      <IceShardBurst trigger={iceBurstTrigger} radius={globeRadius * 1.14} />
      <Sparkles
        count={spinning ? 180 : 110}
        scale={[2.2, 2.2, 2.2]}
        size={spinning ? 1.4 : 0.9}
        speed={spinning ? 0.9 : 0.25}
        opacity={spinning ? 0.45 : 0.18}
        color={spinning ? "#FF8C00" : "#ffffff"}
      />
    </group>
  );
}

/* =========================
   🎆🎈🎊 CELEBRATION OVERLAY
   — continuous fireworks + balloons + confetti
   — runs as long as `active` is true
========================= */

const CEL_COLORS = [
  "#FFD700","#FFA500","#FF6347","#FF1493","#E040FB",
  "#00E5FF","#69F0AE","#FFFFFF","#FFB6C1","#B388FF",
  "#F0E68C","#40C4FF","#FF80AB","#CCFF90",
];

/* ---- types ---- */
interface Rocket  { x:number; y:number; vy:number; targetY:number; color:string; done:boolean; trail:{x:number;y:number}[] }
interface Spark   { x:number; y:number; vx:number; vy:number; life:number; maxLife:number; color:string; size:number; trail:{x:number;y:number}[]; type:"spark"|"ring"|"star" }
interface Balloon { x:number; y:number; vy:number; vx:number; phase:number; speed:number; r:number; color:string; alpha:number; stringLen:number }
interface Confetti{ x:number; y:number; vx:number; vy:number; rot:number; drot:number; w:number; h:number; color:string; alpha:number; life:number; maxLife:number; shape:"rect"|"circle"|"ribbon" }

function CelebrationOverlay({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);
  const aliveRef  = useRef(false);

  useEffect(() => {
    if (!active) {
      aliveRef.current = false;
      cancelAnimationFrame(rafRef.current);
      const cv = canvasRef.current;
      if (cv) cv.getContext("2d")?.clearRect(0, 0, cv.width, cv.height);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    let W = canvas.width  = window.innerWidth;
    let H = canvas.height = window.innerHeight;

    const onResize = () => {
      W = canvas.width  = window.innerWidth;
      H = canvas.height = window.innerHeight;
    };
    window.addEventListener("resize", onResize);

    aliveRef.current = true;

    /* ---------- pools ---------- */
    const rockets:  Rocket[]   = [];
    const sparks:   Spark[]    = [];
    const balloons: Balloon[]  = [];
    const confetti: Confetti[] = [];

    /* ---------- spawn helpers ---------- */
    const spawnRocket = () => {
      rockets.push({
        x: W * (0.08 + Math.random() * 0.84),
        y: H + 10,
        vy: -(13 + Math.random() * 9),
        targetY: H * (0.08 + Math.random() * 0.30),
        color: CEL_COLORS[Math.floor(Math.random() * CEL_COLORS.length)],
        done: false,
        trail: [],
      });
    };

    const burst = (cx:number, cy:number, color:string) => {
      const N = 90 + Math.floor(Math.random() * 70);
      const isRing = Math.random() < 0.25;
      for (let i = 0; i < N; i++) {
        const angle = (Math.PI*2*i/N) + (Math.random()-0.5)*0.2;
        const speed = isRing
          ? 4.5 + Math.random()*0.8
          : 1.6 + Math.random()*6.2;
        const col = Math.random() < 0.6 ? color : CEL_COLORS[Math.floor(Math.random()*CEL_COLORS.length)];
        const type: Spark["type"] = isRing ? "ring" : Math.random()<0.18 ? "star" : "spark";
        sparks.push({
          x:cx, y:cy,
          vx: Math.cos(angle)*speed,
          vy: Math.sin(angle)*speed - (isRing?0:1.2),
          life:0, maxLife: 52+Math.random()*50,
          color:col,
          size: type==="star" ? 3+Math.random()*2.5 : 1.8+Math.random()*3,
          trail:[],
          type,
        });
      }
      // add center gold flash
      for (let i=0;i<18;i++){
        sparks.push({
          x:cx, y:cy,
          vx:(Math.random()-0.5)*3,
          vy:(Math.random()-0.5)*3-1,
          life:0, maxLife:22,
          color:"#FFFDE7",
          size:4+Math.random()*3,
          trail:[], type:"star",
        });
      }
    };

    const spawnBalloon = () => {
      const hues = ["#FF6B6B","#FF9F43","#FECA57","#48DBFB","#FF9FF3","#54A0FF","#5F27CD","#00D2D3","#C8D6E5"];
      balloons.push({
        x: W * (0.05 + Math.random() * 0.90),
        y: H + 80 + Math.random()*80,
        vy: -(0.9 + Math.random()*1.1),
        vx: (Math.random()-0.5)*0.4,
        phase: Math.random()*Math.PI*2,
        speed: 0.012 + Math.random()*0.018,
        r: 22 + Math.random()*22,
        color: hues[Math.floor(Math.random()*hues.length)],
        alpha: 0.82 + Math.random()*0.18,
        stringLen: 40 + Math.random()*30,
      });
    };

    const spawnConfettiBatch = () => {
      const N = 9 + Math.floor(Math.random()*6); // ลดจาก 14+10 → 9+6
      for (let i=0;i<N;i++){
        const shape: Confetti["shape"] = Math.random()<0.6?"rect":Math.random()<0.5?"circle":"ribbon";
        confetti.push({
          x: Math.random()*W,
          y: -20,
          vx: (Math.random()-0.5)*2.5,
          vy: 1.2 + Math.random()*2.2,
          rot: Math.random()*Math.PI*2,
          drot: (Math.random()-0.5)*0.22,
          w: shape==="ribbon" ? 3+Math.random()*2 : 7+Math.random()*8,
          h: shape==="ribbon" ? 16+Math.random()*14 : 7+Math.random()*8,
          color: CEL_COLORS[Math.floor(Math.random()*CEL_COLORS.length)],
          alpha: 0.75+Math.random()*0.25,
          life:0, maxLife: 200+Math.floor(Math.random()*120),
          shape,
        });
      }
    };

    /* ---------- timing ---------- */
    let rocketTimer  = 0;  // ms between rockets
    let balloonTimer = 0;
    let confettiTimer= 0;
    let lastTs = performance.now();

    // immediate first batch
    for(let i=0;i<3;i++) setTimeout(()=>{ if(aliveRef.current) spawnRocket(); }, i*280);
    for(let i=0;i<5;i++) spawnBalloon();      // ลดจาก 8 → 5
    for(let i=0;i<2;i++) spawnConfettiBatch(); // ลดจาก 3 → 2

    /* ---------- draw helpers ---------- */
    const ctx = canvas.getContext("2d")!;

    const drawStar = (cx:number,cy:number,r:number,col:string,a:number) => {
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for(let i=0;i<5;i++){
        const outer = (Math.PI*2*i/5) - Math.PI/2;
        const inner = outer + Math.PI/5;
        if(i===0) ctx.moveTo(cx+Math.cos(outer)*r, cy+Math.sin(outer)*r);
        else       ctx.lineTo(cx+Math.cos(outer)*r, cy+Math.sin(outer)*r);
        ctx.lineTo(cx+Math.cos(inner)*(r*0.42), cy+Math.sin(inner)*(r*0.42));
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const drawBalloon = (b:Balloon) => {
      ctx.save();
      ctx.globalAlpha = b.alpha;

      // body
      const grd = ctx.createRadialGradient(b.x-b.r*0.3, b.y-b.r*0.3, b.r*0.08, b.x, b.y, b.r);
      grd.addColorStop(0,"rgba(255,255,255,0.55)");
      grd.addColorStop(0.4, b.color);
      grd.addColorStop(1, b.color+"BB");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.r, b.r*1.15, 0, 0, Math.PI*2);
      ctx.fill();

      // shine
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.ellipse(b.x-b.r*0.28, b.y-b.r*0.32, b.r*0.22, b.r*0.14, -0.5, 0, Math.PI*2);
      ctx.fill();

      // knot
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(b.x, b.y+b.r*1.15, 3, 0, Math.PI*2);
      ctx.fill();

      // string — wavy
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y+b.r*1.18);
      for(let s=0;s<b.stringLen;s+=4){
        const wave = Math.sin(s*0.18+b.phase)*5;
        ctx.lineTo(b.x+wave, b.y+b.r*1.18+s);
      }
      ctx.stroke();
      ctx.restore();
    };

    /* ---------- main loop ---------- */
    const tick = (ts: number) => {
      if (!aliveRef.current) return;
      const dt = Math.min(ts - lastTs, 50);
      lastTs = ts;

      ctx.clearRect(0, 0, W, H);

      /* -- spawn schedule -- */
      rocketTimer += dt;
      balloonTimer += dt;
      confettiTimer += dt;

      if (rocketTimer > 1400 + Math.random()*800) {
        rocketTimer = 0;
        spawnRocket();
        if (Math.random()<0.38) setTimeout(()=>{ if(aliveRef.current) spawnRocket(); },220);
      }
      if (balloonTimer > 2400 + Math.random()*1800) { // ช้าลง: 1600+1200 → 2400+1800
        balloonTimer = 0;
        spawnBalloon();
        if(Math.random()<0.30) spawnBalloon(); // โอกาส spawn คู่ลดจาก 0.5 → 0.30
      }
      if (confettiTimer > 950 + Math.random()*600) { // ช้าลง: 600+400 → 950+600
        confettiTimer = 0;
        spawnConfettiBatch();
      }

      /* ---- confetti ---- */
      for(let i=confetti.length-1;i>=0;i--){
        const c=confetti[i];
        c.x+=c.vx; c.y+=c.vy; c.rot+=c.drot; c.life++;
        c.vx += (Math.random()-0.5)*0.06;
        c.vy = Math.min(c.vy+0.022, 4.5);
        const fade = Math.max(0, 1-Math.pow(c.life/c.maxLife,2));
        ctx.save();
        ctx.globalAlpha = c.alpha * fade;
        ctx.translate(c.x,c.y);
        ctx.rotate(c.rot);
        ctx.fillStyle = c.color;
        ctx.shadowColor = c.color;
        ctx.shadowBlur = 4;
        if(c.shape==="circle"){
          ctx.beginPath(); ctx.arc(0,0,c.w/2,0,Math.PI*2); ctx.fill();
        } else {
          ctx.fillRect(-c.w/2,-c.h/2,c.w,c.h);
        }
        ctx.restore();
        if(c.life>=c.maxLife || c.y>H+40) confetti.splice(i,1);
      }

      /* ---- balloons ---- */
      for(let i=balloons.length-1;i>=0;i--){
        const b=balloons[i];
        b.y += b.vy;
        b.phase += b.speed;
        b.x += Math.sin(b.phase)*0.85 + b.vx;
        drawBalloon(b);
        if(b.y < -b.r*2-b.stringLen) balloons.splice(i,1);
      }

      /* ---- rockets ---- */
      for(let i=rockets.length-1;i>=0;i--){
        const r=rockets[i];
        if(r.done){ rockets.splice(i,1); continue; }
        r.trail.push({x:r.x,y:r.y});
        if(r.trail.length>10) r.trail.shift();
        r.y+=r.vy; r.vy*=0.988;

        // trail glow
        for(let k=0;k<r.trail.length;k++){
          const a=(k/r.trail.length)*0.7;
          ctx.beginPath();
          ctx.arc(r.trail[k].x, r.trail[k].y, 2.5*(k/r.trail.length), 0, Math.PI*2);
          ctx.fillStyle = r.color;
          ctx.globalAlpha = a;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        // rocket head glow
        ctx.save();
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = "#FFFFFF";
        ctx.shadowColor = r.color;
        ctx.shadowBlur = 18;
        ctx.beginPath(); ctx.arc(r.x,r.y,3.5,0,Math.PI*2); ctx.fill();
        ctx.restore();
        // sparks from tail
        for(let k=0;k<4;k++){
          ctx.save();
          ctx.globalAlpha = 0.4*Math.random();
          ctx.fillStyle = "#FFF3B0";
          ctx.beginPath();
          ctx.arc(r.x+(Math.random()-0.5)*5, r.y+Math.random()*14, 0.8+Math.random()*1.5,0,Math.PI*2);
          ctx.fill();
          ctx.restore();
        }

        if(r.y<=r.targetY){
          r.done=true;
          burst(r.x, r.y, r.color);
        }
      }

      /* ---- sparks ---- */
      for(let i=sparks.length-1;i>=0;i--){
        const p=sparks[i];
        p.trail.push({x:p.x,y:p.y});
        if(p.trail.length>8) p.trail.shift();
        p.vx*=0.958; p.vy=p.vy*0.958+0.12;
        p.x+=p.vx; p.y+=p.vy; p.life++;
        const prog=p.life/p.maxLife;
        const a=Math.pow(1-prog,1.6);

        if(p.type==="spark" && p.trail.length>2){
          ctx.beginPath();
          ctx.moveTo(p.trail[0].x,p.trail[0].y);
          for(let k=1;k<p.trail.length;k++) ctx.lineTo(p.trail[k].x,p.trail[k].y);
          ctx.strokeStyle=p.color;
          ctx.globalAlpha=a*0.35;
          ctx.lineWidth=p.size*0.5;
          ctx.lineCap="round";
          ctx.stroke();
          ctx.globalAlpha=1;
        }

        if(p.type==="star"){
          drawStar(p.x,p.y, p.size*(1-prog*0.3), p.color, a);
        } else {
          ctx.save();
          ctx.globalAlpha=a;
          ctx.fillStyle=p.color;
          ctx.shadowColor=p.color;
          ctx.shadowBlur=6;
          ctx.beginPath();
          ctx.arc(p.x,p.y, p.size*(1-prog*0.4),0,Math.PI*2);
          ctx.fill();
          ctx.restore();
        }
        if(p.life>=p.maxLife) sparks.splice(i,1);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      aliveRef.current = false;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
      ctx.clearRect(0,0,W,H);
    };
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      className="fireworksCanvas"
      style={{ display: active ? "block" : "none" }}
    />
  );
}

/* =========================
   🌿 หิ่งห้อย Firefly Overlay
========================= */
function FireflyOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let W = canvas.width  = window.innerWidth;
    let H = canvas.height = window.innerHeight;
    const ctx = canvas.getContext("2d")!;
    let alive = true;

    const onResize = () => {
      W = canvas.width  = window.innerWidth;
      H = canvas.height = window.innerHeight;
    };
    window.addEventListener("resize", onResize);

    interface Fly {
      x: number; y: number;
      vx: number; vy: number;
      phase: number;        // blink phase
      blinkSpeed: number;
      wanderAngle: number;  // direction drift
      wanderSpeed: number;  // move speed
      r: number;            // glow radius
      color: string;
      alpha: number;
    }

    const COLORS = [
      "#AAFF88","#CCFF66","#EEFF99",
      "#88FFCC","#AAFFEE","#FFFFAA",
      "#DDFF44","#BBFFBB",
    ];

    const COUNT = 38;
    const flies: Fly[] = [];

    for (let i = 0; i < COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.18 + Math.random() * 0.28;
      flies.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        phase: Math.random() * Math.PI * 2,
        blinkSpeed: 0.8 + Math.random() * 1.4,
        wanderAngle: angle,
        wanderSpeed: speed,
        r: 2.5 + Math.random() * 3.5,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        alpha: 0,
      });
    }

    const tick = () => {
      if (!alive) return;
      ctx.clearRect(0, 0, W, H);

      for (const f of flies) {
        // wander — drift direction slowly
        f.wanderAngle += (Math.random() - 0.5) * 0.12;
        f.vx = f.vx * 0.96 + Math.cos(f.wanderAngle) * f.wanderSpeed * 0.04;
        f.vy = f.vy * 0.96 + Math.sin(f.wanderAngle) * f.wanderSpeed * 0.04;
        f.x += f.vx;
        f.y += f.vy;

        // wrap edges
        if (f.x < -20)  f.x = W + 20;
        if (f.x > W+20) f.x = -20;
        if (f.y < -20)  f.y = H + 20;
        if (f.y > H+20) f.y = -20;

        // blink
        f.phase += f.blinkSpeed * 0.018;
        const blink = Math.pow(Math.max(0, Math.sin(f.phase)), 2.2);
        f.alpha = blink;

        if (f.alpha < 0.02) continue;

        // outer soft glow
        const gOut = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 5);
        gOut.addColorStop(0,   f.color.replace(")", `,${f.alpha * 0.28})`).replace("rgb","rgba").replace("#", "rgba(").replace(/rgba\(([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/, (_,r,g,b)=>`rgba(${parseInt(r,16)},${parseInt(g,16)},${parseInt(b,16)}`));
        gOut.addColorStop(1,   "rgba(0,0,0,0)");

        // simpler approach using hex->rgba helper
        const hex = f.color;
        const r = parseInt(hex.slice(1,3),16);
        const g = parseInt(hex.slice(3,5),16);
        const b = parseInt(hex.slice(5,7),16);

        // outer halo
        const halo = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 6);
        halo.addColorStop(0,   `rgba(${r},${g},${b},${f.alpha * 0.22})`);
        halo.addColorStop(0.4, `rgba(${r},${g},${b},${f.alpha * 0.10})`);
        halo.addColorStop(1,   `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r * 6, 0, Math.PI * 2);
        ctx.fill();

        // mid glow
        const mid = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 2.2);
        mid.addColorStop(0,   `rgba(255,255,220,${f.alpha * 0.85})`);
        mid.addColorStop(0.4, `rgba(${r},${g},${b},${f.alpha * 0.70})`);
        mid.addColorStop(1,   `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = mid;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r * 2.2, 0, Math.PI * 2);
        ctx.fill();

        // bright core dot
        ctx.save();
        ctx.globalAlpha = f.alpha * 0.95;
        ctx.fillStyle = "#FFFFFF";
        ctx.shadowColor = f.color;
        ctx.shadowBlur = f.r * 3;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 3,
        pointerEvents: "none",
        width: "100%",
        height: "100%",
      }}
    />
  );
}

export default function PresenterPage() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<RealtimeState | null>(null);
  const [participants, setParticipants] = useState<Record<string, any>[]>([]);
  const [nameKey, setNameKey] = useState<string>("name");

  const spin = useSpinController();

  const lastSpinningRef = useRef<boolean>(false);
  const lastWinnerKeyRef = useRef<string>("");
  const lastPreviewOpenRef = useRef<boolean>(false);

  const iceBurstRef = useRef(0);
  const [iceBurstTrigger, setIceBurstTrigger] = useState(0);

  useEffect(() => {
    const onFirst = async () => {
      await unlockAudioOnce();
    };
    window.addEventListener("pointerdown", onFirst, { once: true });
    return () => window.removeEventListener("pointerdown", onFirst);
  }, []);

  useEffect(() => {
    realtime.connect();
    const off = realtime.on((msg) => {
      if (msg.type === "CONNECTED") setConnected(true);
      if (msg.type === "DISCONNECTED") setConnected(false);

      if (msg.type === "STATE") setState(msg.payload);

      if (msg.type === "STARTED") {
        setState(msg.payload);
        spin.start();

        iceBurstRef.current += 1;
        setIceBurstTrigger(iceBurstRef.current);

        playOneShot("start", 0.85);
        playLoop(0.35);
      }

      if (msg.type === "STOPPING") {
        const winner: Winner | null = msg.payload?.winner || null;
        setState(msg.payload);
        spin.stopWithWinner(winner);
        stopLoop(180);
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
  const prizeImg = resolvePrizeImage(state?.prize || undefined);
  const winner = state?.lastWinner || null;

  const previewOpen = !!state?.ui?.showPrizePreview && !state?.spinning;
  const previewIndex =
    typeof state?.ui?.selectedPrizeIndex === "number" ? state?.ui?.selectedPrizeIndex : undefined;
  const previewHint = safeStr(state?.ui?.previewHint || "กด START ที่หน้า Admin เพื่อเริ่มสุ่ม");

  useEffect(() => {
    const was = lastPreviewOpenRef.current;
    if (!was && previewOpen) playOneShot("preview", 0.7);
    lastPreviewOpenRef.current = previewOpen;
  }, [previewOpen]);

  useEffect(() => {
    const spinningNow = !!state?.spinning;
    const spinningPrev = lastSpinningRef.current;

    if (!spinningPrev && spinningNow) {
      playOneShot("start", 0.85);
      playLoop(0.35);
    }
    if (spinningPrev && !spinningNow) stopLoop(250);

    lastSpinningRef.current = spinningNow;
  }, [state?.spinning]);

  useEffect(() => {
    if (!winner) return;
    const key = safeStr(winner.participant_id || winner.name || "");
    if (!key) return;

    if (key !== lastWinnerKeyRef.current) {
      lastWinnerKeyRef.current = key;
      stopLoop(120);
      playOneShot("win", 0.95);
    }
  }, [winner]);

  return (
    <div className="presenterRoot">
      <PresenterStyles />

      {/* รูปพื้นหลัง — วางไฟล์ที่ client/public/images/presenter-bg.jpg */}
      <img
        className="bgImage"
        src={BG_IMAGE}
        alt=""
        onError={(e) => (e.currentTarget.style.display = "none")}
      />

      {/* 🌿 หิ่งห้อยบินไปมา */}
      <FireflyOverlay />

      <PrizePreviewFullscreen
        open={previewOpen}
        prizeName={prizeName}
        prizeImg={prizeImg}
        prizeIndex={previewIndex}
        hint={previewHint}
      />

      <div className="overlayWrap">
        <div className="overlayBox">
          <div className="kicker">Presenter</div>
          <div className="h2">{connected ? "Connected ✓" : "Disconnected"}</div>
          <div className="p">{state?.mode === "repeat" ? "ไม่ตัดชื่อ" : "ตัดชื่อแล้ว"}</div>
        </div>

        <div className="overlayBox overlayBoxRight" style={{ alignItems: "flex-end" }}>
          <div className="kicker">Prize</div>
          <div className="h2">{prizeName || "— ยังไม่เลือกรางวัล —"}</div>
          <div className="p">{state?.spinning ? "กำลังสุ่ม…" : "พร้อม"}</div>
        </div>
      </div>

      {/* ✅ Canvas ครอบด้วย ErrorBoundary — WebGL พังก็ไม่ crash ทั้งหน้า */}
      <div className="canvasWrap">
        <CanvasErrorBoundary>
          <Canvas
            camera={{ position: [0, 0.85, 3.65], fov: 52 }}
            dpr={[1, 1.6]}
            gl={{ alpha: true, antialias: true }}
            style={{ background: "transparent" }}
          >
            <ambientLight intensity={0.95} />
            <directionalLight position={[2, 3, 2]} intensity={1.0} />
            <directionalLight position={[-3, 2, -2]} intensity={0.55} />
            <directionalLight position={[0, 2.2, 3]} intensity={0.55} />

            <Float speed={1.15} floatIntensity={0.08} rotationIntensity={0.1}>
              <group position={[0, -0.02, 0]}>
                <SnowBall angle={spin.angle} names={names} iceBurstTrigger={iceBurstTrigger} spinning={!!state?.spinning} />
              </group>
            </Float>

            <SnowfallThin />
            <Environment preset="city" />
            <SpinController />
          </Canvas>
        </CanvasErrorBoundary>
      </div>

      {/* ✅ Winner banner — กลางจอ พร้อมพลุ */}
      {winner && !state?.spinning && (
        <div className="winnerBackdrop">
          {/* 🎆🎈🎊 Celebration ตลอดเวลาที่การ์ดเปิดอยู่ */}
          <CelebrationOverlay active={true} />

          <div className="winnerBanner">
            <div className="winnerShimmer" />
            <div className="winnerInner">
              <div className="ribbon">🏆 ผู้โชคดีประจำรอบ</div>

              <img
                className="winnerImg"
                src={prizeImg || "/placeholder.png"}
                alt=""
                onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
              />

              <div className="winnerName">{winner.name || winner.participant_id}</div>
              <div className="winnerPrize">{prizeName || "—"}</div>

              <div className="winnerSide">
                <div className="pill pillStrong">
                  🎁 {typeof previewIndex === "number" ? `รางวัลที่ ${previewIndex}` : "WINNER"}
                </div>
                <div className="pill">✨ ขอแสดงความยินดี</div>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

/* =========================
   ✅ Prize Preview Fullscreen — Premium
========================= */
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let W = canvas.width  = canvas.offsetWidth  || window.innerWidth;
    let H = canvas.height = canvas.offsetHeight || window.innerHeight;

    const ctx = canvas.getContext("2d")!;
    let alive = true;

    /* ---- types ---- */
    interface Star   { x:number; y:number; r:number; alpha:number; twinkle:number; phase:number }
    interface Shoot  { x:number; y:number; vx:number; vy:number; len:number; alpha:number; life:number; maxLife:number; color:string }
    interface Petal  { x:number; y:number; vx:number; vy:number; rot:number; drot:number; s:number; alpha:number; life:number; maxLife:number; color:string }
    interface Sparkl { x:number; y:number; r:number; alpha:number; life:number; maxLife:number; color:string; rot:number; drot:number }

    /* ---- pools ---- */
    const stars:   Star[]   = [];
    const shoots:  Shoot[]  = [];
    const petals:  Petal[]  = [];
    const sparkles:Sparkl[] = [];

    const STAR_COLORS   = ["#FFD6F0","#FFB3E6","#FFC0FF","#E8D5FF","#D4EEFF","#FFFDE4"];
    const PETAL_COLORS  = ["#FFB7D5","#FFC8E8","#FFD6F0","#FFDDF4","#F9C6E8","#EFC9FF","#D6E8FF"];
    const SHOOT_COLORS  = ["#FFFFFF","#FFE8F8","#FFD4F0","#E8D0FF","#D0E8FF"];

    /* ---- init stars ---- */
    for (let i = 0; i < 90; i++) {
      stars.push({
        x: Math.random() * W, y: Math.random() * H,
        r: 0.5 + Math.random() * 2.2,
        alpha: 0.15 + Math.random() * 0.55,
        twinkle: 0.008 + Math.random() * 0.022,
        phase: Math.random() * Math.PI * 2,
      });
    }

    /* ---- helpers ---- */
    const spawnShoot = () => {
      const fromLeft = Math.random() < 0.5;
      const x = fromLeft ? -40 : W + 40;
      const y = Math.random() * H * 0.65;
      const angle = fromLeft
        ? (Math.PI / 6  + Math.random() * Math.PI / 8)
        : (Math.PI - Math.PI / 6 - Math.random() * Math.PI / 8);
      const speed = 9 + Math.random() * 7;
      shoots.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        len: 90 + Math.random() * 110,
        alpha: 0,
        life: 0,
        maxLife: 55 + Math.floor(Math.random() * 30),
        color: SHOOT_COLORS[Math.floor(Math.random() * SHOOT_COLORS.length)],
      });
    };

    const spawnPetal = () => {
      petals.push({
        x: Math.random() * W,
        y: -18,
        vx: (Math.random() - 0.5) * 1.4,
        vy: 0.7 + Math.random() * 1.2,
        rot: Math.random() * Math.PI * 2,
        drot: (Math.random() - 0.5) * 0.08,
        s: 5 + Math.random() * 9,
        alpha: 0.55 + Math.random() * 0.40,
        life: 0,
        maxLife: 320 + Math.floor(Math.random() * 160),
        color: PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)],
      });
    };

    const spawnSparkle = () => {
      sparkles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: 2.5 + Math.random() * 5,
        alpha: 0,
        life: 0,
        maxLife: 60 + Math.floor(Math.random() * 50),
        color: STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)],
        rot: Math.random() * Math.PI * 2,
        drot: (Math.random() - 0.5) * 0.12,
      });
    };

    const drawStar4 = (cx:number,cy:number,r:number,col:string,a:number,rot:number) => {
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = r * 3;
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const outerA = (Math.PI * 2 * i / 4);
        const innerA = outerA + Math.PI / 4;
        if (i === 0) ctx.moveTo(Math.cos(outerA) * r, Math.sin(outerA) * r);
        else         ctx.lineTo(Math.cos(outerA) * r, Math.sin(outerA) * r);
        ctx.lineTo(Math.cos(innerA) * r * 0.32, Math.sin(innerA) * r * 0.32);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    /* ---- timers ---- */
    let shootTimer = 0;
    let petalTimer = 0;
    let sparkTimer = 0;
    let lastTs = performance.now();

    for (let i = 0; i < 18; i++) spawnPetal();
    for (let i = 0; i < 12; i++) spawnSparkle();
    setTimeout(() => { if (alive) spawnShoot(); }, 400);
    setTimeout(() => { if (alive) spawnShoot(); }, 1400);

    const tick = (ts: number) => {
      if (!alive) return;
      const dt = Math.min(ts - lastTs, 50);
      lastTs = ts;

      ctx.clearRect(0, 0, W, H);

      shootTimer  += dt;
      petalTimer  += dt;
      sparkTimer  += dt;

      if (shootTimer  > 2200 + Math.random() * 1800) { shootTimer  = 0; spawnShoot();  if (Math.random()<0.35) setTimeout(()=>{ if(alive) spawnShoot(); }, 320); }
      if (petalTimer  > 280  + Math.random() * 180)  { petalTimer  = 0; spawnPetal();  if (Math.random()<0.45) spawnPetal(); }
      if (sparkTimer  > 320  + Math.random() * 280)  { sparkTimer  = 0; spawnSparkle(); }

      /* twinkling background stars */
      for (const s of stars) {
        s.phase += s.twinkle;
        const a = s.alpha * (0.45 + 0.55 * Math.abs(Math.sin(s.phase)));
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length) % STAR_COLORS.length] || "#FFD6F0";
        ctx.shadowColor = "#FFB3E6";
        ctx.shadowBlur = s.r * 2.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      /* shooting stars */
      for (let i = shoots.length - 1; i >= 0; i--) {
        const s = shoots[i];
        s.x += s.vx; s.y += s.vy; s.life++;
        const prog = s.life / s.maxLife;
        s.alpha = prog < 0.15 ? prog / 0.15 : prog > 0.75 ? (1 - prog) / 0.25 : 1;

        const tx = s.x - Math.cos(Math.atan2(s.vy, s.vx)) * s.len;
        const ty = s.y - Math.sin(Math.atan2(s.vy, s.vx)) * s.len;

        const grad = ctx.createLinearGradient(tx, ty, s.x, s.y);
        grad.addColorStop(0,   "rgba(255,255,255,0)");
        grad.addColorStop(0.6, `rgba(255,220,240,${s.alpha * 0.55})`);
        grad.addColorStop(1,   `rgba(255,255,255,${s.alpha * 0.95})`);

        ctx.save();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();

        /* head sparkle */
        ctx.globalAlpha = s.alpha * 0.85;
        ctx.fillStyle = "#FFFFFF";
        ctx.shadowColor = "#FFD6F0";
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        /* leave tiny trail sparkles */
        if (Math.random() < 0.35) {
          sparkles.push({
            x: s.x + (Math.random() - 0.5) * 6,
            y: s.y + (Math.random() - 0.5) * 6,
            r: 1.5 + Math.random() * 2.5,
            alpha: 0.7 * s.alpha,
            life: 0, maxLife: 22,
            color: "#FFE0F8",
            rot: Math.random() * Math.PI * 2,
            drot: 0.1,
          });
        }

        if (s.life >= s.maxLife) shoots.splice(i, 1);
      }

      /* petals */
      for (let i = petals.length - 1; i >= 0; i--) {
        const p = petals[i];
        p.x  += p.vx + Math.sin(p.life * 0.028) * 0.55;
        p.y  += p.vy;
        p.rot += p.drot;
        p.life++;
        const fade = Math.max(0, 1 - Math.pow(p.life / p.maxLife, 2));

        ctx.save();
        ctx.globalAlpha = p.alpha * fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 5;
        /* petal ellipse */
        ctx.beginPath();
        ctx.ellipse(0, 0, p.s, p.s * 1.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (p.life >= p.maxLife || p.y > H + 30) petals.splice(i, 1);
      }

      /* 4-pointed sparkles */
      for (let i = sparkles.length - 1; i >= 0; i--) {
        const sp = sparkles[i];
        sp.life++;
        sp.rot += sp.drot;
        const prog = sp.life / sp.maxLife;
        const a = sp.alpha * (prog < 0.3 ? prog / 0.3 : 1 - (prog - 0.3) / 0.7);
        drawStar4(sp.x, sp.y, sp.r, sp.color, Math.max(0, a), sp.rot);
        if (sp.life >= sp.maxLife) sparkles.splice(i, 1);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
      ctx.clearRect(0, 0, W, H);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 9999,
      display: "grid", placeItems: "center", padding: 28,
      background: "rgba(255,240,250,0.55)",
      backdropFilter: "blur(12px)",
    }}>
      {/* princess animation canvas — behind card */}
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute", inset: 0,
          width: "100%", height: "100%",
          pointerEvents: "none", zIndex: 0,
        }}
      />

      {/* card */}
      <div style={{
        position: "relative", zIndex: 1,
        width: "min(980px, 100%)",
        borderRadius: 40,
        overflow: "hidden",
        background: "#FFFFFF",
        border: "1.5px solid rgba(255,182,216,.35)",
        boxShadow:
          "0 0 0 1px rgba(255,255,255,.9)," +
          "0 28px 80px rgba(200,80,140,.14)," +
          "0 0 120px rgba(255,200,230,.22)",
        animation: "pvPopIn .44s cubic-bezier(0.34,1.52,0.64,1) both",
      }}>
        <style>{`
          @keyframes pvPopIn {
            from { transform: scale(.88) translateY(22px); opacity:0; }
            to   { transform: scale(1)   translateY(0);    opacity:1; }
          }
          @keyframes pvShimmer {
            0%   { transform: translateX(-80%) skewX(-10deg); opacity:0; }
            25%  { opacity:1; }
            75%  { opacity:.7; }
            100% { transform: translateX(210%)  skewX(-10deg); opacity:0; }
          }
          @keyframes pvFloat {
            0%,100% { transform: translateY(0px)  scale(1); }
            50%     { transform: translateY(-10px) scale(1.018); }
          }
          @keyframes pvImgGlow {
            0%,100% { filter: drop-shadow(0 12px 32px rgba(220,80,150,.18)); }
            50%     { filter: drop-shadow(0 18px 52px rgba(220,80,150,.38)); }
          }
          @keyframes pvBadge {
            0%,100% { box-shadow: 0 4px 18px rgba(245,100,160,.30); }
            50%     { box-shadow: 0 4px 32px rgba(245,100,160,.58); }
          }
          @keyframes pvDot {
            0%,100% { opacity:.6; transform:scale(1); }
            50%     { opacity:1;  transform:scale(1.3); box-shadow:0 0 10px #F472B6; }
          }
          @keyframes pvTopBar {
            0%,100% { opacity:.7; }
            50%     { opacity:1; }
          }
        `}</style>

        {/* shimmer */}
        <div style={{
          position:"absolute", inset:0, overflow:"hidden",
          borderRadius:40, pointerEvents:"none", zIndex:0,
        }}>
          <div style={{
            position:"absolute", top:0, left:0,
            width:"32%", height:"100%",
            background:"linear-gradient(90deg,transparent,rgba(255,200,230,.55),transparent)",
            animation:"pvShimmer 3.4s ease-in-out infinite",
          }} />
        </div>

        {/* pink top accent */}
        <div style={{
          position:"absolute", top:0, left:0, right:0,
          height:3, zIndex:2,
          background:"linear-gradient(90deg,transparent,#F9A8D4 20%,#F472B6 50%,#F9A8D4 80%,transparent)",
          animation:"pvTopBar 2.5s ease-in-out infinite",
        }} />

        <div style={{
          display:"grid", gridTemplateColumns:"1fr 1fr",
          minHeight:480, position:"relative", zIndex:1,
        }}>
          {/* LEFT — image */}
          <div style={{
            position:"relative",
            display:"flex", alignItems:"center", justifyContent:"center",
            padding:48,
            background:"radial-gradient(ellipse 85% 80% at 50% 55%, rgba(255,182,212,.12), transparent 65%)",
            borderRight:"1px solid rgba(255,182,212,.18)",
          }}>
            {/* dot pattern */}
            <div style={{
              position:"absolute", inset:0, opacity:.04,
              backgroundImage:"radial-gradient(circle, rgba(220,80,150,.7) 1px, transparent 1px)",
              backgroundSize:"26px 26px",
            }} />
            {/* corner sparkles (CSS) */}
            {[
              {top:16,left:18},{top:16,right:18},
              {bottom:16,left:18},{bottom:16,right:18},
            ].map((pos,i) => (
              <div key={i} style={{
                position:"absolute", ...pos as any,
                fontSize:16, opacity:.55,
                animation:`pvDot ${1.6+i*0.4}s ease-in-out infinite`,
              }}>✦</div>
            ))}

            <div style={{
              position:"relative",
              animation:"pvFloat 4.2s ease-in-out infinite",
            }}>
              <div style={{
                position:"absolute", inset:-22, borderRadius:40,
                background:"radial-gradient(ellipse at 50% 65%, rgba(240,100,170,.24), transparent 60%)",
                filter:"blur(22px)",
              }} />
              <img
                src={prizeImg || "/placeholder.png"}
                alt=""
                style={{
                  position:"relative",
                  width:"min(290px,100%)", height:"min(290px,100%)",
                  objectFit:"contain", borderRadius:28, display:"block",
                  animation:"pvImgGlow 3s ease-in-out infinite",
                }}
                onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
              />
            </div>
          </div>

          {/* RIGHT — info */}
          <div style={{
            padding:"44px 40px 40px",
            display:"flex", flexDirection:"column",
            justifyContent:"center", gap:0,
          }}>
            {/* badge */}
            <div style={{
              display:"inline-flex", alignItems:"center", gap:8,
              padding:"9px 18px", borderRadius:999,
              background:"linear-gradient(90deg,#F472B6,#F9A8D4)",
              width:"fit-content", marginBottom:20,
              animation:"pvBadge 2.4s ease-in-out infinite",
            }}>
              <span style={{
                fontSize:13, fontWeight:800,
                color:"#fff", letterSpacing:.5,
                textShadow:"0 1px 4px rgba(180,50,100,.4)",
              }}>
                👑 {typeof prizeIndex === "number" ? `รางวัลที่ ${prizeIndex}` : "รางวัล"}
              </span>
            </div>

            {/* divider */}
            <div style={{
              width:52, height:3, marginBottom:20, borderRadius:999,
              background:"linear-gradient(90deg,#F472B6,#E879F9,#818CF8)",
              boxShadow:"0 0 12px rgba(244,114,182,.45)",
            }} />

            {/* prize name */}
            <div style={{
              fontSize:"clamp(30px,3.8vw,54px)",
              lineHeight:1.08, fontWeight:800,
              color:"#2d0a1e", letterSpacing:-1,
              marginBottom:12,
              textShadow:"0 2px 14px rgba(240,100,160,.14)",
            }}>
              {prizeName || "—"}
            </div>

            {/* hint */}
            <div style={{
              fontSize:15, color:"rgba(120,40,80,.50)",
              fontWeight:500, marginBottom:28, lineHeight:1.6,
            }}>
              {hint || "กด START เพื่อเริ่มหมุนสุ่ม"}
            </div>

            {/* status */}
            <div style={{
              display:"flex", alignItems:"center", gap:12,
              padding:"13px 18px", borderRadius:18,
              background:"rgba(244,114,182,.06)",
              border:"1px solid rgba(244,114,182,.20)",
            }}>
              <div style={{
                width:9, height:9, borderRadius:"50%",
                background:"#F472B6", flexShrink:0,
                animation:"pvDot 2s ease-in-out infinite",
              }} />
              <span style={{
                fontSize:13, color:"rgba(100,30,60,.60)", fontWeight:600,
              }}>
                รอการสุ่มรางวัล — ระบบพร้อม
              </span>
            </div>

            {/* bottom bar */}
            <div style={{
              marginTop:24, height:3, borderRadius:999,
              background:"linear-gradient(90deg,rgba(244,114,182,0),rgba(244,114,182,.5) 40%,rgba(232,121,249,.5) 60%,rgba(244,114,182,0))",
            }} />
          </div>
        </div>
      </div>
    </div>
  );
}