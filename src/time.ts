export interface Remaining {
  overTime: boolean;
  label: string;
  elapsedMinutes: number;
}

export function labelFromSeconds(totalSeconds: number): { overTime: boolean; label: string } {
  if (totalSeconds < 0) {
    const overMinutes = Math.ceil(-totalSeconds / 60);
    return { overTime: true, label: `OVER TIME by ${overMinutes}m` };
  }
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return { overTime: false, label: `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` };
}

export function computeRemaining(deadlineIso: string, startedAtIso: string, now: Date): Remaining {
  const deadline = new Date(deadlineIso).getTime();
  const started = new Date(startedAtIso).getTime();
  const nowMs = now.getTime();

  const elapsedMinutes = Math.max(0, Math.round((nowMs - started) / 60000));
  const remainingMs = deadline - nowMs;

  if (remainingMs < 0) {
    const overMinutes = Math.ceil(-remainingMs / 60000);
    return { overTime: true, label: `OVER TIME by ${overMinutes}m`, elapsedMinutes };
  }

  const totalSeconds = Math.floor(remainingMs / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  const label = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return { overTime: false, label, elapsedMinutes };
}
