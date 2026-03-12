// client/src/shared/sfx.ts
type SfxKey = "preview" | "start" | "loop" | "win" | "stop";

const PATHS: Record<SfxKey, string> = {
  preview: "/sfx/preview.mp3",
  start: "/sfx/start.mp3",
  loop: "/sfx/spin-loop.mp3",
  win: "/sfx/win.mp3",
  stop: "/sfx/preview.mp3", // ถ้าไม่มี stop ก็ใช้สั้นๆแทนได้
};

let unlocked = false;

/** เรียกครั้งแรกจาก "การคลิกของผู้ใช้" เพื่อปลดล็อคเสียงบนมือถือ/Chrome policy */
export async function unlockAudio() {
  if (unlocked) return;
  try {
    const a = new Audio(PATHS.preview);
    a.volume = 0.0001;
    await a.play();
    a.pause();
    a.currentTime = 0;
    unlocked = true;
  } catch {
    // ถ้า play ไม่ได้ก็ยังไม่เป็นไร (ให้ผู้ใช้คลิกอีกครั้ง)
  }
}

function makeAudio(src: string, opts?: { loop?: boolean; volume?: number }) {
  const a = new Audio(src);
  a.preload = "auto";
  if (opts?.loop) a.loop = true;
  if (typeof opts?.volume === "number") a.volume = opts.volume;
  return a;
}

const oneShot = new Map<SfxKey, HTMLAudioElement>();
let loopAudio: HTMLAudioElement | null = null;

export async function playSfx(key: SfxKey, opts?: { volume?: number }) {
  await unlockAudio();

  // loop แยก
  if (key === "loop") {
    if (!loopAudio) loopAudio = makeAudio(PATHS.loop, { loop: true, volume: opts?.volume ?? 0.35 });
    try {
      loopAudio.currentTime = 0;
      loopAudio.volume = opts?.volume ?? 0.35;
      await loopAudio.play();
    } catch {}
    return;
  }

  // one-shot
  let a = oneShot.get(key);
  if (!a) {
    a = makeAudio(PATHS[key], { volume: opts?.volume ?? 0.7 });
    oneShot.set(key, a);
  }

  try {
    a.currentTime = 0;
    a.volume = opts?.volume ?? a.volume;
    await a.play();
  } catch {}
}

export function stopLoop(fadeMs = 220) {
  if (!loopAudio) return;
  const a = loopAudio;

  // fade out
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