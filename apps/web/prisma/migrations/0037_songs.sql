CREATE TABLE "song" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "artist" TEXT NOT NULL DEFAULT '',
  "ccliNumber" TEXT NOT NULL DEFAULT '',
  "bpm" INTEGER,
  "keySignature" TEXT NOT NULL DEFAULT '',
  "ppPresentationUuid" TEXT NOT NULL DEFAULT '',
  "importSource" TEXT NOT NULL DEFAULT 'manual',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "song_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "song_orgId_title_idx" ON "song"("orgId", "title");
CREATE UNIQUE INDEX "song_orgId_ppPresentationUuid_key" ON "song"("orgId", "ppPresentationUuid") WHERE "ppPresentationUuid" <> '';

CREATE TABLE "song_section" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "songId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "lyrics" TEXT NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "sourceSlideIndex" INTEGER,
  CONSTRAINT "song_section_songId_fkey" FOREIGN KEY ("songId") REFERENCES "song" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "song_section_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "song_section_songId_sortOrder_idx" ON "song_section"("songId", "sortOrder");
CREATE INDEX "song_section_orgId_idx" ON "song_section"("orgId");

CREATE TABLE "song_cue_map" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "songId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT 'Default',
  "format" TEXT NOT NULL DEFAULT '{"frameRate":30,"dropFrame":"ndf"}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "song_cue_map_songId_fkey" FOREIGN KEY ("songId") REFERENCES "song" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "song_cue_map_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "song_cue_map_songId_idx" ON "song_cue_map"("songId");
CREATE INDEX "song_cue_map_orgId_idx" ON "song_cue_map"("orgId");

CREATE TABLE "song_cue" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "cueMapId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "triggerTc" TEXT NOT NULL,
  "triggerFrame" INTEGER NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "ppSlideIndex" INTEGER,
  CONSTRAINT "song_cue_cueMapId_fkey" FOREIGN KEY ("cueMapId") REFERENCES "song_cue_map" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "song_cue_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "song_section" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "song_cue_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "song_cue_cueMapId_sortOrder_idx" ON "song_cue"("cueMapId", "sortOrder");
CREATE INDEX "song_cue_sectionId_idx" ON "song_cue"("sectionId");
CREATE INDEX "song_cue_orgId_idx" ON "song_cue"("orgId");
