import { GIT_COMMIT_DATE, GIT_SHA, SERVER_START_TIME } from "../../lib/buildInfo";
import { getWorkerHealth, type WorkerHealth } from "../../lib/worker";

function formatDateTime(iso: string): string {
  if (iso === "unknown") return "inconnu";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "medium", timeZone: "Europe/Paris" });
}

export async function Footer() {
  const workerHealth = await getWorkerHealth().catch(() => null as WorkerHealth | null);

  return (
    <footer style={{ marginTop: "3rem" }}>
      <p className="muted" style={{ fontSize: "0.75rem" }}>
        UI — commit {GIT_SHA.slice(0, 12)} — {formatDateTime(GIT_COMMIT_DATE)} · conteneur démarré le{" "}
        {formatDateTime(SERVER_START_TIME)}
      </p>
      <p className="muted" style={{ fontSize: "0.75rem" }}>
        {workerHealth ? (
          <>
            Worker — commit {workerHealth.gitSha.slice(0, 12)} — {formatDateTime(workerHealth.gitCommitDate)} ·
            conteneur démarré le {formatDateTime(workerHealth.startedAt)}
          </>
        ) : (
          "Worker — indisponible pour l'instant."
        )}
      </p>
    </footer>
  );
}
