-- Vérification des événements de vote WhatsApp avant le roster vivant (spec §4.2, R2-4, C1-4).
-- LECTURE SEULE : uniquement des comptages, aucun téléphone ni nom en sortie.
--
-- Exécution (les variables $POSTGRES_USER / $POSTGRES_DB sont développées dans le pod, pas en local) :
--   kubectl -n squash-assistant exec -i <pod postgres> -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A' < docs/plan/verif-roster-votes.sql
--
-- Lecture des résultats : si `matched = 0` pour un sondage qui a reçu des votes (requête 1),
-- le filtre sur payload->'data'->>'pollWhatsappMessageId' est à revoir : STOP et question à Vinz.

\echo '== 1. Événements poll_vote_% rattachés aux 6 derniers sondages (job_runs.poll_msg_id) =='
select jr.target_date,
       jr.created_at,
       count(e.id) as matched
from (
  select id, target_date, created_at, poll_msg_id
  from job_runs
  where poll_msg_id is not null
  order by created_at desc
  limit 6
) jr
left join whatsapp_resa_events e
  on e.event_type like 'poll_vote_%'
 and e.payload->'data'->>'pollWhatsappMessageId' = jr.poll_msg_id
group by jr.id, jr.target_date, jr.created_at
order by jr.created_at desc;

\echo '== 2. Identité des votants (tous poll_vote_%) =='
select count(*)                                                                     as total,
       count(*) filter (where actor_phone is null)                                  as sans_telephone,
       count(*) filter (where actor_jid like '%@lid')                               as jid_lid,
       count(*) filter (where actor_jid like '%@lid' and actor_phone is null)       as lid_sans_telephone
from whatsapp_resa_events
where event_type like 'poll_vote_%';

\echo '== 3. Par event_type : selectedOptions ET previousOptions vides =='
select event_type,
       count(*) as total,
       count(*) filter (
         where coalesce(jsonb_array_length(case when jsonb_typeof(payload->'data'->'selectedOptions') = 'array'
                                                then payload->'data'->'selectedOptions' end), 0) = 0
           and coalesce(jsonb_array_length(case when jsonb_typeof(payload->'data'->'previousOptions') = 'array'
                                                then payload->'data'->'previousOptions' end), 0) = 0
       ) as options_vides
from whatsapp_resa_events
where event_type like 'poll_vote_%'
group by event_type
order by event_type;

\echo '== 4. Votes @lid sans téléphone : actor_name présent ? =='
select count(*)                                                          as lid_sans_telephone,
       count(*) filter (where nullif(btrim(actor_name), '') is not null) as avec_actor_name,
       count(*) filter (where nullif(btrim(actor_name), '') is null)     as sans_actor_name
from whatsapp_resa_events
where event_type like 'poll_vote_%'
  and actor_jid like '%@lid'
  and actor_phone is null;

\echo '== 5. Votes @lid sans téléphone dont actor_name = name d''un votant non identifié du collect_votes du même job =='
select count(*) as lid_sans_telephone,
       count(*) filter (where exists (
         select 1
         from job_runs jr
         join events ev
           on ev.job_run_id = jr.id
          and ev.type = 'collect_votes'
          and ev.status = 'success'
         cross join lateral jsonb_array_elements(
           case when jsonb_typeof(ev.detail->'unresolvedVoters') = 'array'
                then ev.detail->'unresolvedVoters' else '[]'::jsonb end
         ) as uv
         where jr.poll_msg_id = e.payload->'data'->>'pollWhatsappMessageId'
           and nullif(btrim(e.actor_name), '') is not null
           and lower(btrim(uv->>'name')) = lower(btrim(e.actor_name))
       )) as nom_egal_votant_non_identifie
from whatsapp_resa_events e
where e.event_type like 'poll_vote_%'
  and e.actor_jid like '%@lid'
  and e.actor_phone is null;
