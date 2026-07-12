let configuredActor: string | undefined;

/** Resolve logical workflow provenance, never authentication or authorization. */
export function resolveLogicalActor(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const candidate = explicit ?? env.BWRB_ACTOR;
  return candidate?.trim() || 'unknown';
}

/** Fix the actor once for this CLI process before command execution. */
export function configureLogicalActor(explicit?: string): string {
  configuredActor = resolveLogicalActor(explicit);
  return configuredActor;
}

/** Return the process actor, falling back to runner environment when unconfigured. */
export function getLogicalActor(): string {
  return configuredActor ?? resolveLogicalActor(undefined);
}

/** Test isolation for modules exercised in one long-lived Vitest process. */
export function resetLogicalActorForTests(): void {
  configuredActor = undefined;
}
