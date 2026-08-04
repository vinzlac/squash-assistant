import { GIT_COMMIT_DATE, GIT_COMMIT_MESSAGE, GIT_SHA, SERVER_START_TIME } from "../../lib/buildInfo";
import { formatDateTimeParis } from "../../lib/datetime";
import { getWorkerHealth, type WorkerHealth } from "../../lib/worker";

function formatBuildDateTime(iso: string): string {
  if (iso === "unknown") return "inconnu";
  return formatDateTimeParis(iso, { dateStyle: "medium", timeStyle: "medium" });
}

export async function Footer() {
  const workerHealth = await getWorkerHealth().catch(() => null as WorkerHealth | null);

  return (
    <footer style={{ marginTop: "3rem" }}>
      <p className="muted" style={{ fontSize: "0.75rem" }}>
        UI — commit {GIT_SHA.slice(0, 12)} « {GIT_COMMIT_MESSAGE} » — {formatBuildDateTime(GIT_COMMIT_DATE)} · conteneur
        démarré le {formatBuildDateTime(SERVER_START_TIME)}
      </p>
      <p className="muted" style={{ fontSize: "0.75rem" }}>
        {workerHealth ? (
          <>
            Worker — commit {workerHealth.gitSha.slice(0, 12)} « {workerHealth.gitCommitMessage} » —{" "}
            {formatBuildDateTime(workerHealth.gitCommitDate)} · conteneur démarré le {formatBuildDateTime(workerHealth.startedAt)}
          </>
        ) : (
          "Worker — indisponible pour l'instant."
        )}
      </p>
    </footer>
  );
}
