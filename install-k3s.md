# Contexte homelab — k3s, CI/CD et ce dépôt

> **Objectif** : document de référence pour un **assistant IA** ou un nouveau contributeur travaillant **dans ce dépôt app** (hors mono-repo `k3s-homelab`). Dernière génération / mise à jour : **2026-07-12T17:27:46Z**.

---

## 1. Où tourne la prod ?

| Élément | Valeur |
|---------|--------|
| **Machine** | geekom-as6 (mini-PC homelab) |
| **IP LAN typique** | 192.168.1.153 |
| **Orchestrateur** | **k3s** (Kubernetes léger), conteneurs via **containerd** |
| **Données volumineuses** | Sous **`/data`** sur le serveur (k3s, volumes, etc.) |

Accès admin : **SSH** vers `geekom-as6` (clé SSH, utilisateur défini dans l’inventaire Ansible du repo homelab).

---

## 2. CI — build image (ce dépôt)

Les workflows GitHub Actions tournent sur des runners **ARC** (*Actions Runner Controller*) **dans le cluster** (pods éphémères), pas sur les runners hébergés par GitHub.com.

| Paramètre | Détail |
|-----------|--------|
| **Label workflow** | `runs-on: arc-runner-squash-assistant` (nom du *scale set* Helm = nom d’installation ARC) |
| **Build** | **BuildKit** en **ClusterIP** dans le namespace `cicd` |
| **Secret obligatoire** | **`BUILDKIT_HOST`** = `tcp://buildkitd.cicd.svc.cluster.local:1234` |
| **Registry** | **GHCR** — image **`ghcr.io/vinzlac/squash-assistant`** (tags **`:<sha>`** et **`:main`**) |
| **Déclencheur** | Push sur **`main`** ; les commits qui ne touchent que **`kubernetes/`** ne relancent pas le build (`paths-ignore`) pour éviter une boucle avec le commit bot sur `deployment.yaml` |
| **GitOps dans ce repo** | Après build, le workflow met à jour **`kubernetes/deployment.yaml`** (ligne `image:` avec le SHA) via `github-actions[bot]` (`contents: write` + `packages: write`) |

Plateforme image cible : **linux/amd64** (nœud homelab type Intel/AMD).

---

## 3. CD — Argo CD (GitOps)

Argo CD est installé **sur le cluster** ; il lit les manifests **dans ce dépôt Git** (pas dans le repo `k3s-homelab` pour le code app).

| Paramètre | Valeur |
|-----------|--------|
| **Dépôt source (celui-ci)** | https://github.com/vinzlac/squash-assistant.git |
| **Branche** | main |
| **Chemin manifests** | `kubernetes/` |
| **Namespace cible** | **`squash-assistant`** |
| **Application Argo (nom)** | **`squash-assistant`** |
| **Déclaration côté pilote** | Fichier Application dans le repo **`https://github.com/vinzlac/k3s-homelab.git`** : `kubernetes/argocd/applications/squash-assistant.yaml` |
| **Sync** | Automatisée (polling ~3 min, pas de webhook Internet obligatoire) |

Si ce dépôt GitHub est **privé**, le cluster Argo utilise un **PAT** + secret **`repo-creds`** (préfixe d’URL) — voir la doc homelab **ADR-0022**.

---

## 4. Accès application (LAN)

| Élément | Valeur |
|---------|--------|
| **Ingress (hostname)** | **`squash-assistant.homelab`** |
| **URL** | `http://squash-assistant.homelab` (Traefik, classe `traefik`) |
| **Prérequis client** | Entrée dans `/etc/hosts` ou DNS local ; pour les pods du cluster, ConfigMap CoreDNS custom dans le repo homelab |

**Secret pull GHCR** (si le package image est **privé**) : secret **`ghcr-pull`** dans le namespace **`squash-assistant`**, référencé par le Deployment (`imagePullSecrets`).

---

## 5. Référence dépôt « pilote » (infra)

Toute la doc vivante (Ansible, manifests cluster, scripts, ADR) est dans :

- **`https://github.com/vinzlac/k3s-homelab.git`** (clone local habituel : dossier **voisin** de ce repo, ex. `../k3s-homelab`)

Liens utiles (chemins dans ce repo) :

- ARC + BuildKit : `docs/guides/install-arc-k3s.md`, `docs/plan/plan-cicd-buildkit-todoapp.md`
- Argo CD : `docs/plan/plan-argocd-k3s.md`, `kubernetes/argocd/README.md`
- Ajouter une app externe : `docs/guides/guide-add-external-app-k3s.md`

Scripts typiques depuis une machine avec **kubectl** configuré :

- Kubeconfig : `scripts/setup-kubeconfig.sh` → `~/.kube/config-k3s`
- Vérifier les pods : `scripts/check-pods-running.sh`

---

## 6. Récap technique (ce dépôt)

| Clé | Valeur |
|-----|--------|
| **Org / repo GitHub** | vinzlac / **squash-assistant** |
| **Ressource K8s (Deployment/Service)** | squash-assistant |
| **Image** | `ghcr.io/vinzlac/squash-assistant:<sha>` (mis à jour par CI) |
| **Stack (create-app)** | Dépôt GitHub déjà existant — pas de squelette (CI/k8s : sync-app ou merge manuel) (`existing-repo`) |

Les détails (ports, resources, probes, `securityContext`) suivent **`Dockerfile`** et **`kubernetes/deployment.yaml`** dans **ce** dépôt.

---

*Fichier généré ou régénéré par **`k3s-homelab/scripts/create-app.sh`** ou **`update-app.sh`** — à committer dans ce dépôt app pour que les outils IA aient le contexte.*
