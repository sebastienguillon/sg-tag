export interface Logger {
  readonly info: (...args: unknown[]) => void;
  readonly warn: (...args: unknown[]) => void;
  readonly error: (...args: unknown[]) => void;
}

/** The single place allowed to write to the console. */
export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  return {
    info: (...args) => {
      console.info(prefix, ...args);
    },
    warn: (...args) => {
      console.warn(prefix, ...args);
    },
    error: (...args) => {
      console.error(prefix, ...args);
    },
  };
}
