-- Adds ErrorReport (beta-launch-fixes ticket 16): decoded send failures and
-- error-boundary catches the web posts to POST /error-reports. A new table,
-- so this is a plain CreateTable.

-- CreateTable
CREATE TABLE "ErrorReport" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "signature" TEXT,
    "wallet" TEXT,
    "page" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorReport_pkey" PRIMARY KEY ("id")
);
