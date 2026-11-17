-- Utility & Infrastructure Watchdog - initial schema
-- POPIA note: subscriber rows hold the platform chat id (the minimum needed to
-- deliver a message), never a phone number, name, or address. Alert analytics
-- deliberately store no recipient identifiers so a /stop DELETE is complete.

CREATE TABLE IF NOT EXISTS zones (
    zone_id            TEXT PRIMARY KEY,
    suburb_name        TEXT        NOT NULL,
    provider           TEXT        NOT NULL DEFAULT 'esp',
    current_status_hash TEXT,
    current_stage      SMALLINT,
    last_updated       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscribers (
    id            BIGSERIAL PRIMARY KEY,
    platform      TEXT        NOT NULL CHECK (platform IN ('telegram', 'whatsapp')),
    user_id       TEXT        NOT NULL,
    zone_id       TEXT        NOT NULL REFERENCES zones (zone_id) ON DELETE CASCADE,
    status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    consent_at    TIMESTAMPTZ NOT NULL,
    consent_text  TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT subscribers_platform_user_unique UNIQUE (platform, user_id)
);

CREATE INDEX IF NOT EXISTS subscribers_active_zone_idx
    ON subscribers (zone_id, user_id)
    WHERE status = 'active';

-- Aggregate-only delivery telemetry (no user_id). Supports the "did a broadcast
-- actually go out?" question without retaining personal data.
CREATE TABLE IF NOT EXISTS alert_events (
    id            BIGSERIAL PRIMARY KEY,
    zone_id       TEXT        NOT NULL,
    event_id      TEXT        NOT NULL,
    change_type   TEXT        NOT NULL,
    previous_stage SMALLINT,
    current_stage  SMALLINT,
    message_hash  TEXT        NOT NULL,
    recipients    INTEGER     NOT NULL DEFAULT 0,
    sent          INTEGER     NOT NULL DEFAULT 0,
    failed        INTEGER     NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT alert_events_unique UNIQUE (zone_id, event_id)
);

CREATE INDEX IF NOT EXISTS alert_events_created_idx ON alert_events (created_at DESC);
