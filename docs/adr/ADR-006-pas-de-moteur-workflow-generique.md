# ADR-006 : Pas de moteur de workflow générique (pipeline fixe, pas de type n8n)

- **Statut** : accepted
- **Date** : 2026-07-14

## Contexte

En construisant l'UI d'admin (viewer d'events + déclenchement manuel des étapes), la tentation existait de généraliser vers un moteur de workflow visuel type n8n : étapes éditables par l'utilisateur, graphe reconfigurable, etc.

## Décision

Les 4 étapes du pipeline (SendPoll → CollectVotes → BookSlots → Announce) restent une **logique métier fixe**, pas un graphe éditable par l'utilisateur. L'UI n'expose qu'un viewer d'historique et des boutons de déclenchement manuel des étapes existantes (`apps/worker/src/http/server.ts` + `apps/ui`), en réutilisant les fonctions déjà appelées par le cron plutôt que d'inventer un nouveau moteur.

## Raisons

- Le besoin réel est de pouvoir tester/rejouer une étape sans attendre le prochain cron, pas de personnaliser l'ordre ou la nature des étapes.
- Construire un moteur générique aurait un coût disproportionné par rapport au bénéfice pour un pipeline à 4 étapes fixes (YAGNI).
- La table `events` (Postgres) sert déjà d'historique d'exécution consultable — pas besoin d'un nouveau modèle de données pour ça.

## Conséquences

- Généraliser "une règle par étape" (au-delà de `BookingRule` pour BookSlots) ou une génération de règle assistée par IA restent explicitement hors scope tant qu'un besoin concret ne se manifeste pas sur une autre étape.
- Le modèle "jobs" introduit ensuite (voir [ADR-011](./ADR-011-modele-jobs-plutot-que-thread-unique.md)) reste dans cet esprit : plusieurs *exécutions* du même pipeline fixe, pas un pipeline reconfigurable.
