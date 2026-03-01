const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export { TIMEOUT_MS };

export function withTimeout(proc: { exited: Promise<number>; kill(): void }): Promise<number | "timeout"> {
  return Promise.race([
    proc.exited,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => {
        proc.kill();
        resolve("timeout");
      }, TIMEOUT_MS)
    ),
  ]);
}
