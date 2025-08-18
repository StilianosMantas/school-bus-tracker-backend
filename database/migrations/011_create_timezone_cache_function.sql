-- Create function to cache timezone names and reduce repeated queries
-- This helps with the performance issue where pg_timezone_names is queried 135 times

CREATE OR REPLACE FUNCTION get_timezone_names()
RETURNS TEXT[]
LANGUAGE sql
STABLE
AS $$
  SELECT array_agg(name ORDER BY name) 
  FROM pg_timezone_names
$$;

-- Add comment
COMMENT ON FUNCTION get_timezone_names() IS 'Cached function to return all timezone names as array, reduces repeated pg_timezone_names queries';

-- Create a materialized view for even better performance
CREATE MATERIALIZED VIEW IF NOT EXISTS cached_timezones AS
SELECT name 
FROM pg_timezone_names 
ORDER BY name;

-- Create index on the materialized view
CREATE INDEX IF NOT EXISTS idx_cached_timezones_name ON cached_timezones(name);

-- Add comment
COMMENT ON MATERIALIZED VIEW cached_timezones IS 'Materialized view of timezone names for performance optimization';

-- Function to refresh the materialized view (call this periodically if needed)
CREATE OR REPLACE FUNCTION refresh_timezone_cache()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW cached_timezones;
$$;

-- Create a function that uses the materialized view
CREATE OR REPLACE FUNCTION get_cached_timezone_names()
RETURNS TEXT[]
LANGUAGE sql
STABLE
AS $$
  SELECT array_agg(name ORDER BY name) 
  FROM cached_timezones
$$;