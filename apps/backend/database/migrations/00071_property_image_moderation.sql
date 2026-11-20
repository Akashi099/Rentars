-- #922: Image moderation state and audit trail for property images.
--
-- Lifecycle (enforced in apps/backend/src/services/imageModeration.ts):
--   pending  -> approved | rejected | removed   (new uploads start here)
--   approved -> rejected | removed
--   rejected -> approved | removed
--   removed  -> (terminal)
--
-- Only 'approved' images are served on public property detail responses and the
-- public image list. 'rejected' rows keep their moderation_reason so the host can
-- see why and replace the photo. 'removed' rows are hidden from everyone but
-- moderators.
--
-- Existing images were already live before moderation existed, so they are
-- backfilled as 'approved'. Only rows inserted after this migration start 'pending'.

ALTER TABLE property_images
  ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20) NOT NULL DEFAULT 'approved'
    CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'removed')),
  ADD COLUMN IF NOT EXISTS moderation_reason TEXT
    CHECK (moderation_reason IS NULL OR char_length(moderation_reason) <= 500),
  ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS moderated_by UUID;

-- Rows inserted from now on need review before they become public.
ALTER TABLE property_images
  ALTER COLUMN moderation_status SET DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_property_images_property_moderation
  ON property_images (property_id, moderation_status);

COMMENT ON COLUMN property_images.moderation_status IS
  'Public visibility decided by moderation. Only approved images are served publicly.';
COMMENT ON COLUMN property_images.moderation_reason IS
  'Host-facing explanation for a rejected or removed image.';

-- Append-only audit trail. No foreign key to property_images so the history
-- survives when the host later deletes the image record.
CREATE TABLE IF NOT EXISTS property_image_moderation_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id     UUID NOT NULL,
  property_id  UUID NOT NULL,
  actor_id     UUID NOT NULL,
  from_status  VARCHAR(20) NOT NULL,
  to_status    VARCHAR(20) NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_property_image_moderation_events_image
  ON property_image_moderation_events (image_id, created_at);

ALTER TABLE property_image_moderation_events ENABLE ROW LEVEL SECURITY;
