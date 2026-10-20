export interface ReadinessDependencies {
  readonly database: boolean;
  readonly auth: boolean;
  readonly migrations: boolean;
}

export type ReadinessResult =
  | { readonly ready: true; readonly code: 'READY' }
  | { readonly ready: false; readonly code: 'NOT_READY' };

export function buildReadinessResult(dependencies: ReadinessDependencies): ReadinessResult {
  if (dependencies.database && dependencies.auth && dependencies.migrations) {
    return { ready: true, code: 'READY' };
  }
  return { ready: false, code: 'NOT_READY' };
}
