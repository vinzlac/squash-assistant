# ADR-009 : Pas d'authentification applicative (UI + API interne)

- **Statut** : accepted
- **Date** : 2026-07-14

## Contexte

L'UI d'admin (`apps/ui`) et l'API interne du worker (`apps/worker/src/http/server.ts`, servant le déclenchement manuel des étapes) doivent être accessibles pour un usage mono-utilisateur en homelab.

## Décision

Ni l'UI ni l'API interne du worker n'implémentent d'authentification applicative. Les deux restent **LAN-only** : l'UI n'est exposée que via un Ingress interne au réseau local (`squash-assistant.homelab`), et l'API du worker est un `Service` **ClusterIP uniquement**, jamais exposée via Ingress.

## Raisons

- Usage mono-utilisateur (le porteur du homelab) — pas de besoin de gestion multi-utilisateur ni de contrôle d'accès fin.
- Ajouter une couche d'auth (session, OAuth, etc.) serait un coût disproportionné pour ce contexte (YAGNI), et introduirait une surface d'attaque supplémentaire à maintenir pour un bénéfice nul en pratique.
- Cohérent avec le principe déjà appliqué côté réseau (`publicHost: none`, pas d'Ingress public pour le POC).

## Conséquences

- Ce choix est valable tant que l'accès reste strictement confiné au réseau local — toute exposition future au-delà du LAN (accès distant, partage avec un tiers) devra réévaluer cette décision.
- L'API interne du worker fait confiance à tout appelant sur le ClusterIP : elle ne doit jamais être accessible depuis un Ingress ou un autre namespace non maîtrisé.
