import { useEffect, useRef, useState } from "react";
import type { Winner } from "../shared/api";

export function useSpinController() {
  const raf = useRef<number | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [angle, setAngle] = useState(0);

  const angleRef = useRef(0);
  const velRef = useRef(0);
  const targetVelRef = useRef(0);

  // ✅ speed tuning
  const IDLE_SPEED = 0.012;   // หมุนเบาๆ ตอนยังไม่กด start (ดูมีชีวิต)
  const SPIN_SPEED = 0.22;    // ✅ เร็วขึ้นมาก
  const STOP_SPEED = 0.004;   // ลดความเร็วตอนจะหยุด

  const start = () => {
    setSpinning(true);
    targetVelRef.current = SPIN_SPEED;
  };

  const stopWithWinner = (_winner: Winner | null) => {
    targetVelRef.current = STOP_SPEED;
    setTimeout(() => {
      targetVelRef.current = 0;
      setTimeout(() => setSpinning(false), 650);
    }, 1500);
  };

  useEffect(() => {
    velRef.current = IDLE_SPEED;

    const tick = () => {
      const diff = targetVelRef.current - velRef.current;
      const k = spinning ? 0.09 : 0.05; // เร่งไวตอนหมุน, ผ่อนช้าๆตอนหยุด
      velRef.current += diff * k;

      angleRef.current += velRef.current;
      setAngle(angleRef.current);

      raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [spinning]);

  return { spinning, angle, start, stopWithWinner };
}

export function SpinController() {
  return null;
}