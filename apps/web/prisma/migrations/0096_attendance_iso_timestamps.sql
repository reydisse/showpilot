-- Staged for the merge -> green deploy -> remote apply protocol.
-- After successful application and postconditions, move this exact file into
-- prisma/migrations and append its name to applied-remote.txt in a record PR.
-- Legacy attendance writers bound epoch milliseconds to these DATETIME columns.
UPDATE crew_member
SET lastCheckIn = strftime('%Y-%m-%dT%H:%M:%fZ', lastCheckIn / 1000.0, 'unixepoch')
WHERE typeof(lastCheckIn) IN ('integer', 'real');

UPDATE crew_member
SET lastCheckOut = strftime('%Y-%m-%dT%H:%M:%fZ', lastCheckOut / 1000.0, 'unixepoch')
WHERE typeof(lastCheckOut) IN ('integer', 'real');
