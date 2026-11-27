-- Add a separately fingerprinted initiation operation while retaining the
-- existing call.accept contract. Existing rows remain valid and unchanged.
BEGIN;

ALTER TABLE call_operations
  DROP CONSTRAINT operations_request_shape;

ALTER TABLE call_operations
  ADD CONSTRAINT operations_request_shape CHECK (
    (
      operation = 'call.accept'
      AND fingerprint_version = 1
      AND fingerprint ~ '^[0-9a-f]{64}$'
      AND length(btrim(key)) BETWEEN 1 AND 200
      AND key = btrim(key)
    )
    OR
    (
      operation = 'campaign.call.initiate'
      AND fingerprint_version = 1
      AND fingerprint ~ '^[0-9a-f]{64}$'
      AND length(btrim(key)) BETWEEN 1 AND 200
      AND key = btrim(key)
    )
  );

COMMIT;
