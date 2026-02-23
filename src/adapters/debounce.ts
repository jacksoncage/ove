export type DebouncedFunction<T extends (...args: any[]) => any> = T & {
  flush(): void;
  cancel(): void;
};

export function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): DebouncedFunction<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: any[] | null = null;

  const debounced = ((...args: any[]) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const pending = lastArgs;
      lastArgs = null;
      if (pending) fn(...pending);
    }, ms);
  }) as DebouncedFunction<T>;

  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs) {
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }
  };

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  return debounced;
}
