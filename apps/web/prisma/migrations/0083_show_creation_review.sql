-- Reviewing an unconfirmed creation reserves its original request ID, fencing
-- any delayed write before the operator is allowed to submit edited details.
ALTER TABLE show_creation_request ADD COLUMN cancelledAt INTEGER;
