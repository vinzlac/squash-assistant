# Changelog

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
