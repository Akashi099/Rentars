-- Synthetic monitoring probe results
-- Stores results from external health check probes

CREATE TABLE IF NOT EXISTS probe_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    suite_name TEXT NOT NULL,
    location TEXT NOT NULL,
    deployment_version TEXT NOT NULL,
    overall_success BOOLEAN NOT NULL,
    failed_targets TEXT[],
    results_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_probe_results_suite_location
    ON probe_results (suite_name, location, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_probe_results_deployment
    ON probe_results (deployment_version, created_at DESC);