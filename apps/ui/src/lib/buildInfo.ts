/**
 * `SERVER_START_TIME` est évalué une seule fois, au chargement du module —
 * approximation du démarrage du conteneur (à quelques centaines de ms près,
 * le temps du boot Next.js), suffisant pour un affichage informatif. Il n'y
 * a pas d'équivalent "pod creationTimestamp" exposable via la downward API
 * Kubernetes, donc pas d'alternative plus précise sans appel à l'API k8s.
 */
export const SERVER_START_TIME = new Date().toISOString();

/** Injectés au build de l'image Docker (voir Dockerfile + .github/workflows/build-push-ui.yml). */
export const GIT_SHA = process.env.GIT_SHA ?? "unknown";
export const GIT_COMMIT_DATE = process.env.GIT_COMMIT_DATE ?? "unknown";
