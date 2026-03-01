const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export { TIMEOUT_MS };

export function withTimeout(proc: { exited: Promise<number>; kill(): void }): Promise<number | "timeout"> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    proc.exited.then((code) => { clearTimeout(timer); return code; }),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        proc.kill();
        resolve("timeout");
      }, TIMEOUT_MS);
    }),
  ]);
}
