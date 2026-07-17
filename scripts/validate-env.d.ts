export interface EnvError {
  name: string;
  reason: string;
}

export interface ValidateEnvOptions {
  target?: string;
  env?: Record<string, string | undefined>;
}

export function validateEnv(options?: ValidateEnvOptions): EnvError[];

export function parseArgs(args: string[]): { target: string };
