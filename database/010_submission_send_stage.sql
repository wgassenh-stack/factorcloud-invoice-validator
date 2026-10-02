-- How far sending a submission to FactorCloud got: SENDING (reserved, invoice not known yet),
-- CREATED (invoice exists, documents not confirmed), COMPLETE, or FAILED (refused, nothing created).
-- A crash between steps leaves SENDING or CREATED behind, which Recovery lists after 10 minutes.
-- Older submissions have no stage and are not listed.
alter table submissions add column if not exists send_stage text;
