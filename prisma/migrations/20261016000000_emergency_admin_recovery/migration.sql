-- Candidate migration 21. Existing AuditLog attribution/protection is unchanged.
-- The operation UUID is owner-approved input, never automatically generated.
CREATE TABLE "EmergencyAdminRecovery" (
    "id" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "resultingVersion" INTEGER NOT NULL,
    "approvalReference" TEXT NOT NULL,
    "operatorIdentity" TEXT NOT NULL,
    "osUsername" TEXT NOT NULL,
    "osUid" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "databaseHost" TEXT NOT NULL,
    "databasePort" INTEGER NOT NULL,
    "databaseName" TEXT NOT NULL,
    "databaseSchema" TEXT NOT NULL,
    "databaseUser" TEXT NOT NULL,
    "databaseSessionUser" TEXT NOT NULL,
    "databaseServerAddress" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyAdminRecovery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmergencyAdminRecovery_versions_check" CHECK (
        "expectedVersion" > 0 AND "expectedVersion" < 2147483647 AND
        "resultingVersion"::BIGINT = "expectedVersion"::BIGINT + 1
    ),
    CONSTRAINT "EmergencyAdminRecovery_metadata_check" CHECK (
        char_length("approvalReference") BETWEEN 1 AND 256 AND
        "approvalReference" = btrim("approvalReference") AND "approvalReference" ~ '[^[:space:]]' AND
        char_length("operatorIdentity") BETWEEN 1 AND 256 AND
        "operatorIdentity" = btrim("operatorIdentity") AND "operatorIdentity" ~ '[^[:space:]]'
    ),
    CONSTRAINT "EmergencyAdminRecovery_host_evidence_check" CHECK (
        char_length("osUsername") BETWEEN 1 AND 255 AND
        "osUsername" = btrim("osUsername") AND "osUsername" ~ '[^[:space:]]' AND
        char_length("osUid") BETWEEN 1 AND 255 AND
        "osUid" = btrim("osUid") AND "osUid" ~ '[^[:space:]]' AND
        char_length("hostname") BETWEEN 1 AND 255 AND
        "hostname" = btrim("hostname") AND "hostname" ~ '[^[:space:]]'
    ),
    CONSTRAINT "EmergencyAdminRecovery_database_evidence_check" CHECK (
        char_length("databaseHost") BETWEEN 1 AND 255 AND
        "databaseHost" = btrim("databaseHost") AND "databaseHost" ~ '[^[:space:]]' AND
        "databasePort" BETWEEN 1 AND 65535 AND
        char_length("databaseName") BETWEEN 1 AND 255 AND
        "databaseName" = btrim("databaseName") AND "databaseName" ~ '[^[:space:]]' AND
        "databaseSchema" = 'public' AND
        char_length("databaseUser") BETWEEN 1 AND 255 AND
        "databaseUser" = btrim("databaseUser") AND "databaseUser" ~ '[^[:space:]]' AND
        char_length("databaseSessionUser") BETWEEN 1 AND 255 AND
        "databaseSessionUser" = btrim("databaseSessionUser") AND "databaseSessionUser" ~ '[^[:space:]]' AND
        char_length("databaseServerAddress") BETWEEN 1 AND 255 AND
        "databaseServerAddress" = btrim("databaseServerAddress") AND "databaseServerAddress" ~ '[^[:space:]]'
    ),
    CONSTRAINT "EmergencyAdminRecovery_intent_check" CHECK (
        "intent" = 'REPLACE_EXISTING_ACTIVE_ADMIN_CREDENTIAL'
    )
);

CREATE INDEX "EmergencyAdminRecovery_targetUserId_createdAt_idx"
    ON "EmergencyAdminRecovery"("targetUserId", "createdAt");

ALTER TABLE "EmergencyAdminRecovery"
    ADD CONSTRAINT "EmergencyAdminRecovery_targetUserId_fkey"
    FOREIGN KEY ("targetUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Ordinary DML, including a statement-level TRUNCATE of an empty table, fails.
-- A database owner/superuser with DDL privilege can disable/drop these triggers;
-- that authority remains outside this database-level audit trust boundary.
CREATE FUNCTION protect_emergency_admin_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Emergency ADMIN recovery receipts are immutable'
        USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "EmergencyAdminRecovery_immutable"
    BEFORE UPDATE OR DELETE ON "EmergencyAdminRecovery"
    FOR EACH ROW EXECUTE FUNCTION protect_emergency_admin_recovery();

CREATE TRIGGER "EmergencyAdminRecovery_no_truncate"
    BEFORE TRUNCATE ON "EmergencyAdminRecovery"
    FOR EACH STATEMENT EXECUTE FUNCTION protect_emergency_admin_recovery();
