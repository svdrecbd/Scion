CREATE TABLE IF NOT EXISTS device_pairing_codes (
    pairing_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_code_hash TEXT NOT NULL UNIQUE,
    user_code_hash TEXT NOT NULL,
    device_name TEXT NOT NULL,
    platform TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    approved_user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    approved_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    request_ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_pairing_codes_user_code
    ON device_pairing_codes(user_code_hash);

CREATE INDEX IF NOT EXISTS idx_device_pairing_codes_expires_at
    ON device_pairing_codes(expires_at);
