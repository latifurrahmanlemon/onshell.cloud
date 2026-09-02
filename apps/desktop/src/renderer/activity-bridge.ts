function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof (value as PromiseLike<unknown>).then === "function");
}

/**
 * Copies an Electron contextBridge surface before decorating its async methods.
 * contextBridge freezes every exposed property; proxying those functions breaks
 * the JavaScript invariant for non-configurable properties and crashes startup.
 */
export function copyBridgeWithActivity<T extends object>(
  target: T,
  shouldTrack: (path: string) => boolean,
  track: <Result>(promise: Promise<Result>) => Promise<Result>,
  parent = ""
): T {
  const wrapped: Record<string, unknown> = {};
  for (const property of Object.keys(target)) {
    const value = target[property as keyof T] as unknown;
    const path = parent ? `${parent}.${property}` : property;
    if (typeof value === "function") {
      wrapped[property] = (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args) as unknown;
        return isPromiseLike(result) && shouldTrack(path) ? track(Promise.resolve(result)) : result;
      };
    } else {
      wrapped[property] = value && typeof value === "object"
        ? copyBridgeWithActivity(value as object, shouldTrack, track, path)
        : value;
    }
  }
  return wrapped as T;
}
