/**
 * `SERVER_START_TIME` est évalué une seule fois, au chargement du module —
 * approximation du démarrage du conteneur (à quelques centaines de ms près),
 * suffisant pour un affichage informatif. Miroir de apps/ui/src/lib/buildInfo.ts.
 */
export const SERVER_START_TIME = new Date().toISOString();

/** Injectés au build de l'image Docker (voir Dockerfile + .github/workflows/build-push.yml). */
export const GIT_SHA = process.env.GIT_SHA ?? "unknown";
export const GIT_COMMIT_DATE = process.env.GIT_COMMIT_DATE ?? "unknown";
