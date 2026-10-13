BEGIN;
ALTER TABLE "User"
  ADD COLUMN "credentialsVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "temporaryCredentialExpiresAt" TIMESTAMPTZ(3);
ALTER TABLE "User" ADD CONSTRAINT "User_credentials_version_check" CHECK ("credentialsVersion" > 0),
  ADD CONSTRAINT "User_recovery_state_check" CHECK ("mustChangePassword" = ("temporaryCredentialExpiresAt" IS NOT NULL));
-- Audit UUID is the durable operation receipt. Never store credential material.
CREATE FUNCTION protect_credential_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."entityType" = 'CredentialRecovery' THEN RAISE EXCEPTION 'Credential audit is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."entityType" = 'CredentialRecovery' THEN RAISE EXCEPTION 'Credential audit is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_credential_audit BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION protect_credential_audit();
COMMIT;
