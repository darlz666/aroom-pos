CREATE TABLE "AuthThrottle" (
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "AuthThrottle_pkey" PRIMARY KEY ("scope", "key"),
  CONSTRAINT "AuthThrottle_scope_check" CHECK ("scope" IN ('LOGIN', 'REAUTH')),
  CONSTRAINT "AuthThrottle_key_check" CHECK ("key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AuthThrottle_attempts_check" CHECK ("attempts" BETWEEN 1 AND CASE WHEN "scope" = 'LOGIN' THEN 10 ELSE 5 END)
);
CREATE INDEX "AuthThrottle_expiresAt_idx" ON "AuthThrottle" ("expiresAt");
