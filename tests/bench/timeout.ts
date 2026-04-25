export function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void | Promise<void>,
  message: string,
): Promise<T> {
  let timeoutId: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        const timeoutResult = onTimeout();
        void Promise.resolve(timeoutResult).catch((error) => {
          console.error("raceWithTimeout onTimeout failed:", error);
        });
      } catch (error) {
        console.error("raceWithTimeout onTimeout failed:", error);
      }
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}
