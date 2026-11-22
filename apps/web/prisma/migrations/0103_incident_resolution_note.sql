-- What fixed an incident, shown on the incident detail page so the next crew
-- knows what to check. Empty until someone writes it.
ALTER TABLE incident ADD COLUMN resolutionNote TEXT NOT NULL DEFAULT '';
