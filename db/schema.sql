-- Only the Edge Function's service role can invoke this REST endpoint, which also
-- authenticates a dedicated backend secret before every operation.
-- Its SHA-256 hash is installed separately, so no usable credential enters source control.
-- Tables live in an unexposed schema. Browser publishable keys alone confer no access.
CREATE SCHEMA IF NOT EXISTS prompttap_private;
REVOKE ALL ON SCHEMA prompttap_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS prompttap_private.secrets (
  id text PRIMARY KEY CHECK (id = 'backend'),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS prompttap_private.settings (
  id text PRIMARY KEY CHECK (id = 'backend'),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object')
);
CREATE TABLE IF NOT EXISTS prompttap_private.users (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  language text NOT NULL DEFAULT 'kk' CHECK (language IN ('kk', 'ru', 'en')),
  last_query text NOT NULL DEFAULT '' CHECK (length(last_query) <= 2000)
);
CREATE TABLE IF NOT EXISTS prompttap_private.searches (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{16}$'),
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 100),
  query text NOT NULL CHECK (length(query) <= 2000),
  results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) <= 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS searches_created_at ON prompttap_private.searches(created_at);
CREATE TABLE IF NOT EXISTS prompttap_private.favorites (
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 100),
  prompt_id text NOT NULL CHECK (prompt_id ~ '^[a-f0-9]{12,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, prompt_id)
);
CREATE TABLE IF NOT EXISTS prompttap_private.limits (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200),
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS limits_expiry ON prompttap_private.limits(expires_at);
CREATE TABLE IF NOT EXISTS prompttap_private.updates (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  owner uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'done')),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_expiry ON prompttap_private.updates(expires_at);
CREATE TABLE IF NOT EXISTS prompttap_private.user_locks (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  owner uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS prompttap_private.catalog (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{12,64}$'),
  title text NOT NULL CHECK (length(title) <= 2000),
  content text NOT NULL CHECK (octet_length(content) <= 8388608),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  language text NOT NULL CHECK (language IN ('kk', 'ru', 'en', 'other')),
  category text NOT NULL CHECK (category IN ('design', 'code', 'writing', 'marketing', 'study', 'productivity', 'security', 'general')),
  review_required boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS catalog_eligible ON prompttap_private.catalog(id) WHERE NOT review_required;

ALTER TABLE prompttap_private.secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompttap_private.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompttap_private.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompttap_private.searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompttap_private.favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompttap_private.limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompttap_private.updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompttap_private.user_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompttap_private.catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA prompttap_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA prompttap_private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.prompttap_rpc(op text, payload jsonb, secret text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '15s'
AS $function$
DECLARE
  result jsonb;
  affected integer;
  operation_time timestamptz := clock_timestamp();
  user_id_value text := payload->>'userId';
  id_value text := payload->>'id';
  owner_value uuid;
  lease_until timestamptz;
  limit_maximum integer;
  limit_window integer;
  patch jsonb;
  record_value jsonb;
  language_value text;
  query_value text;
BEGIN
  IF secret IS NULL OR length(secret) NOT BETWEEN 32 AND 256 OR NOT EXISTS (
    SELECT 1 FROM prompttap_private.secrets
    WHERE id = 'backend'
      AND secret_hash = encode(sha256(convert_to(secret, 'UTF8')), 'hex')
  ) THEN
    RAISE SQLSTATE 'PT401' USING MESSAGE = 'Store authentication failed';
  END IF;
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' OR octet_length(payload::text) > 12582912 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Invalid store payload';
  END IF;
  IF length(coalesce(user_id_value, '')) > 100 OR length(coalesce(id_value, '')) > 100 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Invalid store identifier';
  END IF;

  CASE op
    WHEN 'get_user' THEN
      SELECT jsonb_build_object('language', language, 'lastQuery', last_query)
      INTO result FROM prompttap_private.users WHERE id = id_value;
      RETURN coalesce(result, '{"language":"kk","lastQuery":""}'::jsonb);

    WHEN 'set_user' THEN
      patch := payload->'patch';
      IF jsonb_typeof(patch) <> 'object' OR patch IS NULL THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'Invalid user patch';
      END IF;
      language_value := coalesce(patch->>'language', 'kk');
      query_value := coalesce(patch->>'lastQuery', '');
      INSERT INTO prompttap_private.users AS existing(id, language, last_query)
      VALUES (id_value, language_value, query_value)
      ON CONFLICT(id) DO UPDATE SET
        language = CASE WHEN patch ? 'language' THEN excluded.language ELSE existing.language END,
        last_query = CASE WHEN patch ? 'lastQuery' THEN excluded.last_query ELSE existing.last_query END;
      RETURN 'true'::jsonb;

    WHEN 'save_search' THEN
      DELETE FROM prompttap_private.searches WHERE created_at < operation_time - interval '7 days';
      INSERT INTO prompttap_private.searches(id, user_id, query, results)
      VALUES (id_value, user_id_value, payload->>'query', payload->'results');
      RETURN to_jsonb(id_value);

    WHEN 'get_search' THEN
      SELECT jsonb_build_object('query', query, 'results', results) INTO result
      FROM prompttap_private.searches
      WHERE id = id_value AND user_id = user_id_value AND created_at > operation_time - interval '7 days';
      RETURN coalesce(result, 'null'::jsonb);

    WHEN 'toggle_favorite' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(user_id_value || ':' || (payload->>'promptId'), 0));
      DELETE FROM prompttap_private.favorites WHERE user_id = user_id_value AND prompt_id = payload->>'promptId';
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected > 0 THEN RETURN 'false'::jsonb; END IF;
      INSERT INTO prompttap_private.favorites(user_id, prompt_id) VALUES (user_id_value, payload->>'promptId');
      RETURN 'true'::jsonb;

    WHEN 'list_favorites' THEN
      SELECT coalesce(jsonb_agg(prompt_id ORDER BY created_at DESC, prompt_id), '[]'::jsonb) INTO result
      FROM (SELECT prompt_id, created_at FROM prompttap_private.favorites WHERE user_id = user_id_value ORDER BY created_at DESC, prompt_id LIMIT 100) AS selected;
      RETURN result;

    WHEN 'consume' THEN
      limit_maximum := (payload->>'maximum')::integer;
      limit_window := (payload->>'windowMs')::integer;
      IF limit_maximum NOT BETWEEN 1 AND 10000 OR limit_window NOT BETWEEN 1000 AND 86400000 OR limit_maximum IS NULL OR limit_window IS NULL THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'Invalid request budget';
      END IF;
      DELETE FROM prompttap_private.limits WHERE expires_at <= operation_time;
      INSERT INTO prompttap_private.limits AS existing(key, count, expires_at)
      VALUES (payload->>'key', 1, operation_time + limit_window * interval '1 millisecond')
      ON CONFLICT(key) DO UPDATE SET count = existing.count + 1 WHERE existing.count < limit_maximum;
      GET DIAGNOSTICS affected = ROW_COUNT;
      RETURN to_jsonb(affected = 1);

    WHEN 'claim_update' THEN
      owner_value := (payload->>'owner')::uuid;
      limit_window := coalesce((payload->>'ttlMs')::integer, 120000);
      IF limit_window NOT BETWEEN 5000 AND 600000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'Invalid lease duration'; END IF;
      lease_until := operation_time + limit_window * interval '1 millisecond';
      DELETE FROM prompttap_private.updates WHERE expires_at <= operation_time AND status = 'done';
      INSERT INTO prompttap_private.updates AS existing(id, owner, status, expires_at)
      VALUES (id_value, owner_value, 'running', lease_until)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, status = 'running', expires_at = excluded.expires_at
      WHERE existing.status = 'running' AND (existing.expires_at <= operation_time OR existing.owner = owner_value);
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected = 1 THEN RETURN '"claimed"'::jsonb; END IF;
      IF EXISTS (SELECT 1 FROM prompttap_private.updates WHERE id = id_value AND status = 'done') THEN RETURN '"done"'::jsonb; END IF;
      RETURN '"busy"'::jsonb;

    WHEN 'update_done' THEN
      UPDATE prompttap_private.updates SET status = 'done', expires_at = operation_time + interval '7 days'
      WHERE id = id_value AND owner = (payload->>'owner')::uuid AND status = 'running';
      GET DIAGNOSTICS affected = ROW_COUNT;
      RETURN to_jsonb(affected = 1);

    WHEN 'release_update' THEN
      DELETE FROM prompttap_private.updates WHERE id = id_value AND owner = (payload->>'owner')::uuid AND status = 'running';
      GET DIAGNOSTICS affected = ROW_COUNT;
      RETURN to_jsonb(affected = 1);

    WHEN 'acquire_user_lock' THEN
      owner_value := (payload->>'owner')::uuid;
      limit_window := coalesce((payload->>'ttlMs')::integer, 120000);
      IF limit_window NOT BETWEEN 5000 AND 600000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'Invalid lease duration'; END IF;
      lease_until := operation_time + limit_window * interval '1 millisecond';
      INSERT INTO prompttap_private.user_locks AS existing(id, owner, expires_at)
      VALUES (id_value, owner_value, lease_until)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE existing.expires_at <= operation_time OR existing.owner = owner_value;
      GET DIAGNOSTICS affected = ROW_COUNT;
      RETURN to_jsonb(affected = 1);

    WHEN 'release_user_lock' THEN
      DELETE FROM prompttap_private.user_locks WHERE id = id_value AND owner = (payload->>'owner')::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;
      RETURN to_jsonb(affected = 1);

    WHEN 'catalog_page' THEN
      IF coalesce((payload->>'offset')::integer, 0) < 0 OR coalesce((payload->>'limit')::integer, 100) NOT BETWEEN 1 AND 100 THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'Invalid catalog page';
      END IF;
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'content', left(content, 2000), 'sources', sources,
        'language', language, 'category', category, 'reviewRequired', review_required) ORDER BY id), '[]'::jsonb)
      INTO result FROM (
        SELECT * FROM prompttap_private.catalog WHERE NOT review_required ORDER BY id
        LIMIT coalesce((payload->>'limit')::integer, 100) OFFSET coalesce((payload->>'offset')::integer, 0)
      ) AS selected;
      RETURN result;

    WHEN 'get_prompt' THEN
      SELECT jsonb_build_object('id', id, 'title', title, 'content', content, 'sources', sources,
        'language', language, 'category', category, 'reviewRequired', review_required)
      INTO result FROM prompttap_private.catalog WHERE id = id_value AND NOT review_required;
      RETURN coalesce(result, 'null'::jsonb);

    WHEN 'catalog_meta' THEN
      SELECT jsonb_build_object('total', count(*) FILTER (WHERE NOT review_required), 'archiveTotal', count(*),
        'reviewCount', count(*) FILTER (WHERE review_required), 'categories', (
          SELECT coalesce(jsonb_agg(jsonb_build_object('id', category, 'count', amount)), '[]'::jsonb)
          FROM (SELECT category, count(*) AS amount FROM prompttap_private.catalog WHERE NOT review_required GROUP BY category ORDER BY category) AS groups
        )) INTO result FROM prompttap_private.catalog;
      RETURN result;

    WHEN 'import_records' THEN
      IF jsonb_typeof(payload->'records') <> 'array' OR jsonb_array_length(payload->'records') NOT BETWEEN 1 AND 30 THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'Import requires 1 to 30 records';
      END IF;
      FOR record_value IN SELECT value FROM jsonb_array_elements(payload->'records') LOOP
        INSERT INTO prompttap_private.catalog AS existing(id, title, content, sources, language, category, review_required)
        VALUES (record_value->>'id', record_value->>'title', record_value->>'content', record_value->'sources',
          record_value->>'language', record_value->>'category', coalesce((record_value->>'reviewRequired')::boolean, true))
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, sources = excluded.sources,
          language = excluded.language, category = excluded.category, review_required = excluded.review_required;
      END LOOP;
      RETURN to_jsonb(jsonb_array_length(payload->'records'));

    ELSE
      RAISE SQLSTATE 'PT400' USING MESSAGE = 'Unknown store operation';
  END CASE;
END;
$function$;

REVOKE ALL ON FUNCTION public.prompttap_rpc(text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prompttap_rpc(text, jsonb, text) TO service_role;

-- Edge Functions use their platform-injected service role to load backend settings.
-- This entry point is intentionally unavailable to browser publishable keys.
CREATE OR REPLACE FUNCTION public.prompttap_bootstrap()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT config FROM prompttap_private.settings WHERE id = 'backend';
$function$;
REVOKE ALL ON FUNCTION public.prompttap_bootstrap() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prompttap_bootstrap() TO service_role;
