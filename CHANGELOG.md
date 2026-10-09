# Changelog

## v1.3.0 (2026-10-09)

### Features

- feat(announce): titre et message d'échec allégés, signature automatique retirée ([a1384ea](https://github.com/vinzlac/squash-assistant/commit/a1384ea))
- feat(worker): votants non identifiés conservés dans l'état et signalés sur Telegram ([23d00dd](https://github.com/vinzlac/squash-assistant/commit/23d00dd))
- feat(sondage): date de clôture des réponses dans la question et l'aperçu UI ([23503b6](https://github.com/vinzlac/squash-assistant/commit/23503b6))
- feat(db): colonnes de clôture du sondage et du récap épinglé (migration 0033) ([7e87401](https://github.com/vinzlac/squash-assistant/commit/7e87401))
- feat(worker): message WhatsApp du récap des inscrits ([345ee5e](https://github.com/vinzlac/squash-assistant/commit/345ee5e))
- feat(collecte): clôture et suppression du sondage après lecture, récap des inscrits épinglé ([0f030c9](https://github.com/vinzlac/squash-assistant/commit/0f030c9))
- feat(worker): désépinglage du récap le jour du match, à l'annulation et au sondage suivant ([07f1a2f](https://github.com/vinzlac/squash-assistant/commit/07f1a2f))
- feat(plan): « Recalculer le plan » recherche à nouveau les votants non identifiés par téléphone ([91e947e](https://github.com/vinzlac/squash-assistant/commit/91e947e))
- feat(worker): pseudo des joueurs dans les messages WhatsApp et Telegram ([4b5f4f0](https://github.com/vinzlac/squash-assistant/commit/4b5f4f0))
- feat(ui): joueurs affichés « Pseudo (Prénom NOM) » dans l'UI admin ([0533cae](https://github.com/vinzlac/squash-assistant/commit/0533cae))

### Bug Fixes

- fix(planning): arrêt au plafond et prête-noms restitués quand la paire reste bloquée ([4e5bf98](https://github.com/vinzlac/squash-assistant/commit/4e5bf98))
- fix(announce): compter les joueurs sans créneau via meta.courtGroups, plus les rounds manquants ([a7ddbad](https://github.com/vinzlac/squash-assistant/commit/a7ddbad))
- fix(worker): masque téléphones et JID dans le récap WhatsApp des inscrits ([bf5ee3c](https://github.com/vinzlac/squash-assistant/commit/bf5ee3c))
- fix(worker): ne mémoriser le récap que s'il est épinglé, et isoler l'échec de mémorisation ([dfe287b](https://github.com/vinzlac/squash-assistant/commit/dfe287b))
- fix(worker): le nettoyage du récap précédent ne bloque plus l'envoi du sondage ([d1a7f77](https://github.com/vinzlac/squash-assistant/commit/d1a7f77))
- fix(worker): retire un numéro de téléphone glissé dans un nom WhatsApp du récap ([74242a8](https://github.com/vinzlac/squash-assistant/commit/74242a8))
- fix(worker): récap « 📋 Inscrits » quand le sondage n'a pas été supprimé ([c24dec7](https://github.com/vinzlac/squash-assistant/commit/c24dec7))
- fix(worker): ne supprime plus un sondage envoyé il y a plus de 48 h ([896316c](https://github.com/vinzlac/squash-assistant/commit/896316c))
- fix(worker): retente la suppression du sondage à la relance d'une collecte clôturée ([1b326d2](https://github.com/vinzlac/squash-assistant/commit/1b326d2))
- fix(worker): date de clôture du sondage lue sur la règle live à l'envoi ([6d5cd33](https://github.com/vinzlac/squash-assistant/commit/6d5cd33))
- fix(worker): distingue une recherche resa-squash en échec d'un numéro inconnu au recalcul ([9996f14](https://github.com/vinzlac/squash-assistant/commit/9996f14))
- fix(worker): garde-fou d'âge aussi à la relance de la collecte ([d17d964](https://github.com/vinzlac/squash-assistant/commit/d17d964))
- fix(worker): événement poll_deleted pour ne pas retenter une suppression réussie ([3f535c1](https://github.com/vinzlac/squash-assistant/commit/3f535c1))
- fix(worker): filtre de numéro du récap sans ponctuation orpheline ni plage d'années ([a0749ae](https://github.com/vinzlac/squash-assistant/commit/a0749ae))
- fix(worker): récap sans caractères de format Unicode invisibles dans les noms ([8807748](https://github.com/vinzlac/squash-assistant/commit/8807748))
- fix(worker): noms nettoyés des volontaires non identifiés dans la synthèse du groupe test ([ef9372a](https://github.com/vinzlac/squash-assistant/commit/ef9372a))
- fix(worker,ui): mention « réponses jusqu'au » omise si la clôture tombe à plus de 48 h ([9cbebdb](https://github.com/vinzlac/squash-assistant/commit/9cbebdb))
- fix(worker): lecture vide suspecte à la collecte — sondage conservé, pas de récap, alerte Telegram ([31fe45e](https://github.com/vinzlac/squash-assistant/commit/31fe45e))
- fix(worker): relance après clôture — Telegram de collecte renvoyé, poll_deleted écrit, désépinglage si non supprimé ([b687663](https://github.com/vinzlac/squash-assistant/commit/b687663))
- fix(worker): lecture vide à la collecte — l'étape échoue pour permettre « Relancer » ([7c3cd15](https://github.com/vinzlac/squash-assistant/commit/7c3cd15))
- fix(worker,ui): marge de 15 min pour la mention de clôture du sondage ([85da1a1](https://github.com/vinzlac/squash-assistant/commit/85da1a1))
- fix(worker): noms du récap — U+200D conservé pour ne pas casser les emojis composés ([4146a98](https://github.com/vinzlac/squash-assistant/commit/4146a98))
- fix(worker): « Relancer » ne lance l'attente du go que si le graphe attend le go ([36593f8](https://github.com/vinzlac/squash-assistant/commit/36593f8))
- fix(worker): message de lecture vide — recours réel (aucune annulation sur une étape en erreur) ([6ffbde1](https://github.com/vinzlac/squash-assistant/commit/6ffbde1))
- fix(worker): ignorer le nom de famille renvoyé comme pseudo de repli ([aa4903e](https://github.com/vinzlac/squash-assistant/commit/aa4903e))
- fix(ui): filtre /listener par nom — valeur « Prénom Nom », libellé admin pour l'affichage ([8561aef](https://github.com/vinzlac/squash-assistant/commit/8561aef))
- fix(worker): l'alerte de capacité compte les joueurs sans créneau, plus les rounds manquants ([e5e4d3f](https://github.com/vinzlac/squash-assistant/commit/e5e4d3f))
- fix(worker): arrondit l'objectif de rounds de l'escalade et teste l'escalade dans planJob ([a9ac29d](https://github.com/vinzlac/squash-assistant/commit/a9ac29d))

### Improvements

- refactor: retrait de « Relire les réponses », aperçu des votes masqué après la collecte ([24deca9](https://github.com/vinzlac/squash-assistant/commit/24deca9))

### Maintenance

- chore(ci): déploiement 9084d0d32dbbd798f34f0388584f0720163239a6 ([6228588](https://github.com/vinzlac/squash-assistant/commit/6228588))
- docs(spec): clôture du sondage à la collecte + récap des inscrits ([c64e093](https://github.com/vinzlac/squash-assistant/commit/c64e093))
- docs(spec): intègre la relecture indépendante (clôture du sondage + récap) ([ea5e599](https://github.com/vinzlac/squash-assistant/commit/ea5e599))
- docs(plan): clôture du sondage + récap des inscrits + allègement de l'annonce ([90e2340](https://github.com/vinzlac/squash-assistant/commit/90e2340))
- docs(plan): intègre la relecture indépendante du plan ([2807a3c](https://github.com/vinzlac/squash-assistant/commit/2807a3c))
- docs(spec): ordre poll_closed_at avant suppression dans la liste des tests ([79af23e](https://github.com/vinzlac/squash-assistant/commit/79af23e))
- docs: ADR-037 et règles fonctionnelles de la clôture du sondage et du récap ([efd526a](https://github.com/vinzlac/squash-assistant/commit/efd526a))
- test(worker): verrouille l'ordre événement collect_votes → clôture → suppression ([a3e95af](https://github.com/vinzlac/squash-assistant/commit/a3e95af))
- docs(adr): ADR-017 note le retrait de « Relire les réponses » (ADR-037) ([ce581ee](https://github.com/vinzlac/squash-assistant/commit/ce581ee))
- docs: garde-fou d'âge, relance, récap « 📋 Inscrits », filtre de numéro, règle live, recherche en échec ([736daf7](https://github.com/vinzlac/squash-assistant/commit/736daf7))
- docs: relance (garde-fou d'âge, poll_deleted), filtre de numéro, puce « Relance » réordonnée ([0135c2e](https://github.com/vinzlac/squash-assistant/commit/0135c2e))
- test(worker): fige l'horloge des tests de sendPoll (mention de clôture explicite) ([31e7607](https://github.com/vinzlac/squash-assistant/commit/31e7607))
- docs: lecture vide suspecte, mention de clôture ≤ 48 h, relance après clôture, noms nettoyés (spec, ADR-037, règles fonctionnelles) ([5a9a292](https://github.com/vinzlac/squash-assistant/commit/5a9a292))
- docs: lecture vide = étape en échec (« Relancer »), marge de 15 min de la mention, ZWJ conservé (spec, règles, ADR-037) ([1eb6c04](https://github.com/vinzlac/squash-assistant/commit/1eb6c04))
- docs: lecture vide — recours réel sans annulation, relance → arrêt à « Calculer le plan » ([b025e8b](https://github.com/vinzlac/squash-assistant/commit/b025e8b))
- docs: lecture vide — recours rédigé sans double parenthèse ([2a42d72](https://github.com/vinzlac/squash-assistant/commit/2a42d72))
- chore(ci): déploiement 2a42d727006827d529967c64fae80da23d5bab6e ([16050cb](https://github.com/vinzlac/squash-assistant/commit/16050cb))
- docs: pseudo dans les messages, « Pseudo (Prénom NOM) » dans l'UI admin (règles §7) ([420757b](https://github.com/vinzlac/squash-assistant/commit/420757b))
- docs: repli du pseudo resa-squash sur le nom de famille ignoré (règles §7) ([08b2818](https://github.com/vinzlac/squash-assistant/commit/08b2818))
- chore(ci): déploiement 8561aef7921bdfa23ae0de2f4a080be0d5c9a319 ([a19fdb2](https://github.com/vinzlac/squash-assistant/commit/a19fdb2))
- test(worker): réécrit le scénario 3 de test-graph pour le moteur actuel ([2dd5316](https://github.com/vinzlac/squash-assistant/commit/2dd5316))
- docs: objectif de l'escalade et alerte de capacité en joueurs (règles §4) ([b84d3eb](https://github.com/vinzlac/squash-assistant/commit/b84d3eb))
- docs(handoff): archive des handoffs du 05/10 et du 07/10 ([a9b398a](https://github.com/vinzlac/squash-assistant/commit/a9b398a))
- chore(ci): déploiement a9b398a81e5e283def0ce92ecf4219e14e998ff0 ([797dc3b](https://github.com/vinzlac/squash-assistant/commit/797dc3b))

**Full changelog**: https://github.com/vinzlac/squash-assistant/compare/v1.2.1...v1.3.0

## v1.2.1 (2026-10-07)

### Bug Fixes

- fix(worker): START_REMINDER_SINCE ramené au 06/10 pour inclure les jobs déjà créés au déploiement ([e89c6c7](https://github.com/vinzlac/squash-assistant/commit/e89c6c7))

### Maintenance

- chore(ci): déploiement 55684ecaecbc5e6d4246bcd4608708fc84c94870 ([ab740fa](https://github.com/vinzlac/squash-assistant/commit/ab740fa))
- docs(handoff): archive du handoff du rappel avant le match ([0501432](https://github.com/vinzlac/squash-assistant/commit/0501432))

**Full changelog**: https://github.com/vinzlac/squash-assistant/compare/v1.2.0...v1.2.1

## v1.2.0 (2026-10-07)

### Features

- feat(db): colonnes du rappel avant le match (migration 0032) ([b329e6e](https://github.com/vinzlac/squash-assistant/commit/b329e6e))
- feat(worker): variante rappel du message de confirmation ([62e83cb](https://github.com/vinzlac/squash-assistant/commit/62e83cb))
- feat(worker): évaluation pure du rappel avant le match ([1cac919](https://github.com/vinzlac/squash-assistant/commit/1cac919))
- feat(worker): envoi du rappel avant le match avec réservation atomique ([82895ff](https://github.com/vinzlac/squash-assistant/commit/82895ff))
- feat(worker): tick global du rappel avant le match ([cc9a5f8](https://github.com/vinzlac/squash-assistant/commit/cc9a5f8))
- feat(ui): étape 6 « Rappel avant le match » sur la page du job ([1d42189](https://github.com/vinzlac/squash-assistant/commit/1d42189))
- feat(ui): réglage du rappel avant le match dans le formulaire de règle ([280c03d](https://github.com/vinzlac/squash-assistant/commit/280c03d))

### Bug Fixes

- fix(worker): retire le garde anti-chevauchement du tick de rappel ([9bb6557](https://github.com/vinzlac/squash-assistant/commit/9bb6557))
- fix(worker): rappel avant match — construire avant de réserver, libération sûre ([83bdbc8](https://github.com/vinzlac/squash-assistant/commit/83bdbc8))

### Maintenance

- chore(ci): déploiement 0afd12e2f0b12b91e974ab940081bb596c186367 ([1d0999e](https://github.com/vinzlac/squash-assistant/commit/1d0999e))
- docs(spec): design du rappel WhatsApp avant le match ([332bd44](https://github.com/vinzlac/squash-assistant/commit/332bd44))
- docs(plan): plan d'implémentation du rappel avant le match ([dc345fc](https://github.com/vinzlac/squash-assistant/commit/dc345fc))
- docs: ADR-036 et règles fonctionnelles du rappel avant le match ([0a65f06](https://github.com/vinzlac/squash-assistant/commit/0a65f06))
- chore(worker): START_REMINDER_SINCE calé sur la date de mise en production ([e25eaf1](https://github.com/vinzlac/squash-assistant/commit/e25eaf1))

**Full changelog**: https://github.com/vinzlac/squash-assistant/compare/v1.1.0...v1.2.0

## v1.1.0 (2026-10-05)

### Features

- feat(pipeline): épingler le sondage puis l'annonce dans WhatsApp ([42ec4af](https://github.com/vinzlac/squash-assistant/commit/42ec4af))
- feat(pipeline): destinataire distinct pour la confirmation WhatsApp + QR (étape 5) ([8993ba7](https://github.com/vinzlac/squash-assistant/commit/8993ba7))

### Bug Fixes

- fix(scheduler): envoyer la confirmation WhatsApp le jour de la décision ([50800e3](https://github.com/vinzlac/squash-assistant/commit/50800e3))

### Maintenance

- chore(ci): déploiement a747f8fa90829ab730803ea98a6b58fa18d0a1fd ([b35d216](https://github.com/vinzlac/squash-assistant/commit/b35d216))
- chore(ci): déploiement 50800e3608ae6714f713b11ff1ca1ae319ee03dc ([f666a71](https://github.com/vinzlac/squash-assistant/commit/f666a71))
- chore(ci): déploiement 42ec4afbf886e3e52f04d1a6d0834a1d1b7ada1f ([5bfb791](https://github.com/vinzlac/squash-assistant/commit/5bfb791))
- docs(adr): ADR-034 épinglage WhatsApp du sondage puis de l'annonce ([985e1e8](https://github.com/vinzlac/squash-assistant/commit/985e1e8))

**Full changelog**: https://github.com/vinzlac/squash-assistant/compare/v1.0.2...v1.1.0

## v1.0.2 (2026-09-30)

### Bug Fixes

- fix(scheduler): confirmation le jour des réservations, pas le jour de la décision ([79f6fdf](https://github.com/vinzlac/squash-assistant/commit/79f6fdf))

### Maintenance

- chore(ci): déploiement 32317273047982e91ad379b2cda03aa58d0680b3 ([dab3ee3](https://github.com/vinzlac/squash-assistant/commit/dab3ee3))

**Full changelog**: https://github.com/vinzlac/squash-assistant/compare/v1.0.1...v1.0.2

## v1.0.1 (2026-09-30)

### Bug Fixes

- fix(ui): affiche ±10 min sur l'heure de confirmation de la règle ([a7ebe2d](https://github.com/vinzlac/squash-assistant/commit/a7ebe2d))

### Maintenance

- chore(ci): déploiement 8fa1070d57078a91091bc389199fccd33477d768 ([04a009c](https://github.com/vinzlac/squash-assistant/commit/04a009c))

**Full changelog**: https://github.com/vinzlac/squash-assistant/compare/v1.0.0...v1.0.1

## v1.0.0 (2026-09-30)

Initial release.
