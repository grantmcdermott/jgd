export function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void | Promise<void>,
  message: string,
): Promise<T> {
  let timeoutId: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      void Promise.resolve(onTimeout()).catch(() => {});
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}
