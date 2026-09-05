-- CreateTable
CREATE TABLE "Pool" (
    "address" TEXT NOT NULL,
    "poolId" BIGINT NOT NULL,
    "authority" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "epochSeconds" BIGINT NOT NULL,
    "roundSeconds" BIGINT NOT NULL,
    "paused" BOOLEAN NOT NULL,
    "currentEpochId" BIGINT NOT NULL,
    "totalPrincipal" BIGINT NOT NULL,
    "carryPot" BIGINT NOT NULL,
    "updatedSlot" BIGINT NOT NULL,

    CONSTRAINT "Pool_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Epoch" (
    "id" BIGINT NOT NULL,
    "startsAt" BIGINT NOT NULL,
    "endsAt" BIGINT NOT NULL,
    "status" INTEGER NOT NULL,
    "registeredWeight" DECIMAL(40,0) NOT NULL,
    "registeredCount" INTEGER NOT NULL,
    "jackpotAmount" BIGINT NOT NULL,
    "target" DECIMAL(40,0) NOT NULL,
    "winner" TEXT,

    CONSTRAINT "Epoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Round" (
    "id" BIGINT NOT NULL,
    "epochId" BIGINT NOT NULL,
    "startsAt" BIGINT NOT NULL,
    "endsAt" BIGINT NOT NULL,
    "status" INTEGER NOT NULL,
    "pot" BIGINT NOT NULL,
    "winningTile" INTEGER,
    "tileTotals" JSONB NOT NULL,

    CONSTRAINT "Round_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "owner" TEXT NOT NULL,
    "principal" BIGINT NOT NULL,
    "entries" BIGINT NOT NULL,
    "weightAcc" DECIMAL(40,0) NOT NULL,
    "lastUpdate" BIGINT NOT NULL,
    "epochId" BIGINT NOT NULL,
    "frozenWeight" DECIMAL(40,0) NOT NULL,
    "frozenEpoch" BIGINT NOT NULL,
    "regEpoch" BIGINT NOT NULL,
    "regStart" DECIMAL(40,0) NOT NULL,
    "regEnd" DECIMAL(40,0) NOT NULL,
    "isHouse" BOOLEAN NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("owner")
);

-- CreateTable
CREATE TABLE "Position" (
    "address" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "roundId" BIGINT NOT NULL,
    "tiles" BIGINT NOT NULL,
    "stakePerTile" BIGINT NOT NULL,
    "settled" BOOLEAN NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Event" (
    "slot" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "blockTime" BIGINT,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("slot","signature","index")
);

-- CreateTable
CREATE TABLE "Cursor" (
    "id" INTEGER NOT NULL,
    "lastSignature" TEXT,
    "lastSlot" BIGINT,

    CONSTRAINT "Cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaucetClaim" (
    "owner" TEXT NOT NULL,
    "lastClaimAt" BIGINT NOT NULL,

    CONSTRAINT "FaucetClaim_pkey" PRIMARY KEY ("owner")
);

-- CreateTable
CREATE TABLE "OperatorState" (
    "id" INTEGER NOT NULL,
    "lastTickAt" BIGINT,
    "lastAction" TEXT,
    "lastError" TEXT,
    "registeredCount" INTEGER,
    "registeredTotal" INTEGER,

    CONSTRAINT "OperatorState_pkey" PRIMARY KEY ("id")
);
