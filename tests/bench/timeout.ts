export function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void | Promise<void>,
  message: string,
): Promise<T> {
  let timeoutId: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(message));
      void Promise.resolve()
        .then(() => onTimeout())
        .catch(() => {});
    }, timeoutMs);
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}
