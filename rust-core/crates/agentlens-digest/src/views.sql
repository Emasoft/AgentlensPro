-- Generator for the unified `u` views of an _ingest catalog. Input: _ingest.producer_types and the
-- events tables it names. Sections are split by the `-- @@ name` marker lines: `prelude` is run
-- once (temp objects only), A, B and C each return rows (kind, source, topic, stmt, error); a row
-- with a non-null `error` means "no statement for this topic", never a statement.

-- @@ prelude
CREATE OR REPLACE TEMP MACRO g_q(x) AS '"' || replace(x, '"', '""') || '"';

-- one row per installed version; vrank is the position among the versions of the same source+topic
CREATE OR REPLACE TEMP VIEW g_ver AS
SELECT source, topic, version, producer_type, duckdb_schema, replaces_json,
       dense_rank() OVER (PARTITION BY source, topic ORDER BY version) AS vrank,
       count(*) OVER (PARTITION BY source, topic) AS nvers
FROM _ingest.producer_types;

-- one row per payload column of every installed version, with its stored type
CREATE OR REPLACE TEMP VIEW g_cols AS
SELECT v.source, v.topic, v.version, v.vrank, v.nvers, v.producer_type, v.duckdb_schema,
       c.column_name AS col, c.data_type AS ty
FROM g_ver v
JOIN duckdb_columns() c
  ON c.database_name = current_database() AND c.schema_name = v.duckdb_schema AND c.table_name = 'events'
WHERE c.column_name NOT LIKE '\_meta\_%' ESCAPE '\';

-- {new: old} renames; replaces_json of version n names the column of the previous version
CREATE OR REPLACE TEMP VIEW g_ren AS
SELECT v.source, v.topic, v.vrank, k.key AS new_name, k.value->>'$' AS old_name
FROM g_ver v, json_each(v.replaces_json) k;

-- canonical name of every (version, column): walk forward through all later versions, applying
-- each rename whose old name equals the current name (a -> b -> c is followed transitively)
CREATE OR REPLACE TEMP VIEW g_canon AS
WITH RECURSIVE r(source, topic, vrank0, col0, cur_rank, cur_name, nvers) AS (
    SELECT source, topic, vrank, col, vrank, col, nvers FROM g_cols
    UNION ALL
    SELECT r.source, r.topic, r.vrank0, r.col0, r.cur_rank + 1, coalesce(n.new_name, r.cur_name), r.nvers
    FROM r LEFT JOIN g_ren n
      ON n.source = r.source AND n.topic = r.topic AND n.vrank = r.cur_rank + 1 AND n.old_name = r.cur_name
    WHERE r.cur_rank < r.nvers)
SELECT source, topic, vrank0 AS vrank, col0 AS col, cur_name AS canon FROM r WHERE cur_rank = nvers;

CREATE OR REPLACE TEMP VIEW g_cc AS
SELECT c.*, k.canon FROM g_cols c JOIN g_canon k USING (source, topic, vrank, col);

CREATE OR REPLACE TEMP VIEW g_t1 AS
SELECT source, topic, canon,
       count(DISTINCT ty) AS ntypes,
       bool_or(ty = 'VARCHAR') AS has_varchar,
       bool_or(ty = 'JSON') AS has_json,
       arg_max(ty, vrank) AS newest_ty,
       list(DISTINCT ty) AS tys
FROM g_cc GROUP BY source, topic, canon;

-- canonical type: VARCHAR, else JSON, else the newest version's type. A differing type is a
-- conflict when a STRUCT/LIST/MAP/UNION is involved and the older type is not a STRUCT that is the
-- newest STRUCT minus fields appended at its end (the only shape DuckDB casts, so a plain CAST works)
CREATE OR REPLACE TEMP VIEW g_types AS
SELECT t.source, t.topic, t.canon,
       CASE WHEN t.has_varchar THEN 'VARCHAR' WHEN t.has_json THEN 'JSON' ELSE t.newest_ty END AS canon_ty,
       NOT (t.has_varchar OR t.has_json) AND coalesce(x.bad, false) AS conflict,
       t.tys
FROM g_t1 t
LEFT JOIN (
    SELECT c.source, c.topic, c.canon,
           bool_or(c.ty <> n.newest_ty
                   AND (regexp_matches(c.ty, '^(STRUCT|MAP|UNION)\(|\]$') OR regexp_matches(n.newest_ty, '^(STRUCT|MAP|UNION)\(|\]$'))
                   AND NOT (starts_with(c.ty, 'STRUCT(') AND starts_with(n.newest_ty, left(c.ty, length(c.ty) - 1) || ', '))) AS bad
    FROM g_cc c JOIN g_t1 n USING (source, topic, canon)
    GROUP BY c.source, c.topic, c.canon) x
  USING (source, topic, canon);

CREATE OR REPLACE TEMP VIEW g_err AS
SELECT source, topic,
       'column ' || g_q(canon) || ' has types that cannot be unified: ' || array_to_string(tys, ' | ') AS msg
FROM g_types WHERE conflict
UNION ALL
SELECT source, topic,
       'version ' || version || ': columns ' || string_agg(g_q(col), ', ' ORDER BY col) ||
       ' all map to canonical name ' || g_q(canon) AS msg
FROM g_cc GROUP BY source, topic, version, canon HAVING count(*) > 1;

CREATE OR REPLACE TEMP VIEW g_sel AS
SELECT v.source, v.topic, v.vrank,
       'SELECT "_meta_ingest_id", "_meta_record_ordinal", "_meta_recorded_at_ns", "_meta_recorded_at", "_meta_ingested_at", '
       || coalesce(p.plist || ', ', '')
       || v.version || ' AS "_meta_version", ''' || replace(v.producer_type, '''', '''''') || ''' AS "_meta_producer_type"'
       || ' FROM ' || g_q(v.duckdb_schema) || '."events"' AS sel
FROM g_ver v
LEFT JOIN (
    SELECT c.source, c.topic, c.vrank,
           string_agg(CASE WHEN c.ty = t.canon_ty THEN g_q(c.col) ELSE 'CAST(' || g_q(c.col) || ' AS ' || t.canon_ty || ')' END
                      || ' AS ' || g_q(c.canon), ', ' ORDER BY c.canon) AS plist
    FROM g_cc c JOIN g_types t USING (source, topic, canon)
    GROUP BY c.source, c.topic, c.vrank) p
  ON p.source = v.source AND p.topic = v.topic AND p.vrank = v.vrank;

CREATE OR REPLACE TEMP VIEW g_topic AS
SELECT source, topic,
       string_agg(sel, ' UNION ALL BY NAME ' ORDER BY vrank) AS view_body,
       string_agg(sel || ' WHERE "_meta_recorded_at" >= t_from AND "_meta_recorded_at" < t_to',
                  ' UNION ALL BY NAME ' ORDER BY vrank) AS macro_body,
       bool_or(e.source IS NOT NULL) AS has_err
FROM g_sel s LEFT JOIN (SELECT DISTINCT source, topic FROM g_err) e USING (source, topic)
GROUP BY source, topic;

-- @@ A
SELECT 'view' AS kind, source, topic,
       'CREATE OR REPLACE VIEW u.' || g_q(source || '__' || topic) || ' AS ' || view_body AS stmt,
       NULL::VARCHAR AS error
FROM g_topic WHERE NOT has_err
UNION ALL
SELECT 'error', source, topic, NULL, msg FROM g_err
ORDER BY source, topic, kind;

-- @@ B
SELECT 'macro' AS kind, source, topic,
       'CREATE OR REPLACE MACRO u.' || g_q(source || '__' || topic || '_between') || '(t_from, t_to) AS TABLE ' || macro_body AS stmt,
       NULL::VARCHAR AS error
FROM g_topic WHERE NOT has_err
UNION ALL
SELECT 'error', source, topic, NULL, msg FROM g_err
ORDER BY source, topic, kind;

-- @@ C
WITH tp AS (
    SELECT source, topic, has_err,
           row_number() OVER (PARTITION BY source ORDER BY topic) AS n,
           count(*) OVER (PARTITION BY source) AS nt
    FROM g_topic),
pc AS (
    SELECT tp.source, tp.topic, tp.n,
           string_agg('t' || tp.n || '.' || g_q(c.canon) || ' AS ' || g_q(tp.topic || '__' || c.canon), ', ' ORDER BY c.canon) AS cols
    FROM tp LEFT JOIN (SELECT DISTINCT source, topic, canon FROM g_cc) c USING (source, topic)
    GROUP BY tp.source, tp.topic, tp.n),
src AS (
    SELECT tp.source, bool_or(tp.has_err) AS has_err,
           string_agg('SELECT "_meta_ingest_id", "_meta_record_ordinal" FROM u.' || g_q(tp.source || '__' || tp.topic), ' UNION ' ORDER BY tp.n) AS keys,
           string_agg('t' || tp.n || '."_meta_recorded_at"', ', ' ORDER BY tp.n) AS ts,
           string_agg(' LEFT JOIN u.' || g_q(tp.source || '__' || tp.topic) || ' t' || tp.n ||
                      ' ON t' || tp.n || '."_meta_ingest_id" = k."_meta_ingest_id" AND t' || tp.n || '."_meta_record_ordinal" = k."_meta_record_ordinal"',
                      '' ORDER BY tp.n) AS joins
    FROM tp WHERE tp.nt > 1 GROUP BY tp.source),
cl AS (SELECT source, string_agg(cols, ', ' ORDER BY n) AS cols FROM pc GROUP BY source)
SELECT 'all' AS kind, s.source, NULL::VARCHAR AS topic,
       'CREATE OR REPLACE VIEW u.' || g_q(s.source || '__all') || ' AS WITH keys AS (' || s.keys || ') SELECT k."_meta_ingest_id", k."_meta_record_ordinal", coalesce(' || s.ts || ') AS "_meta_recorded_at"'
       || coalesce(', ' || cl.cols, '') || ' FROM keys k' || s.joins AS stmt,
       NULL::VARCHAR AS error
FROM src s JOIN cl USING (source) WHERE NOT s.has_err
UNION ALL
SELECT 'error', source, NULL, NULL, 'no ' || g_q(source || '__all') || ' view: a topic of this source has an error' FROM src WHERE has_err
ORDER BY source, kind;
