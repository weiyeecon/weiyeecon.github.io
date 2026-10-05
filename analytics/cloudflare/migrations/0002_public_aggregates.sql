-- Additive and repeatable. Leaves all existing private-mode wa_ tables untouched.
-- No event IDs, visitor identifiers, IPs, user agents, paths, or exact timestamps.
CREATE TABLE IF NOT EXISTS wa_aggregate_hours (
  day TEXT NOT NULL,
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  pageviews INTEGER NOT NULL CHECK (pageviews >= 0),
  PRIMARY KEY (day, hour)
);
CREATE TABLE IF NOT EXISTS wa_aggregate_geography (
  day TEXT NOT NULL,
  country TEXT NOT NULL,
  region_code TEXT NOT NULL,
  region TEXT NOT NULL,
  city TEXT NOT NULL,
  pageviews INTEGER NOT NULL CHECK (pageviews >= 0),
  PRIMARY KEY (day, country, region_code, region, city)
);
CREATE TABLE IF NOT EXISTS wa_aggregate_budget (
  day TEXT PRIMARY KEY,
  hits INTEGER NOT NULL CHECK (hits >= 0)
);
