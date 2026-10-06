import type { WorkspaceTerms } from "./types";

/** Resolve audited, static UI copy. Never pass user-entered names or content. */
export function workspaceCopy(text: string, terms: WorkspaceTerms): string {
  const church = terms.participate === "serve";
  // Protect inserted values from later substitutions: a custom noun such as
  // "Sunday" is a name, not another piece of source copy to translate.
  const values: string[] = [];
  const insert = (value: string) => `\u0000${values.push(value) - 1}\u0000`;
  const finish = (value: string) =>
    value.replace(
      /\u0000(\d+)\u0000/g,
      (_, index: string) => values[Number(index)],
    );
  const casing = (match: string, replacement: string) =>
    match === match.toUpperCase()
      ? replacement.toUpperCase()
      : /^[A-Z]/.test(match)
        ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
        : replacement.toLowerCase();
  let copy = text
    .replace(/Show or service (name|title)/gi, (_, noun: string) =>
      insert(`${terms.eventTitle} ${noun}`),
    )
    .replace(/Covering rundown for Sunday service/gi, () =>
      insert(`Covering rundown for this weekend’s ${terms.event}`),
    )
    .replace(/Advance to sermon/gi, "Advance to next segment");
  if (!church) {
    copy = copy
      .replace(
        /Add the people who serve on your production team\./g,
        "Add the people on your production team.",
      )
      .replace(/for service\b/gi, () => insert(`for the ${terms.event}`))
      .replace(/Sunday(?: morning)?(?: service)?(?: standard)?/gi, () =>
        insert(terms.eventNameExample),
      )
      .replace(/Scan to serve/gi, () => insert(terms.checkinCta));
  }
  copy = copy.replace(
    /\b(a\s+|an\s+)?(services?)\b/gi,
    (_match, article: string | undefined, noun: string) => {
      const word = casing(
        noun,
        /s$/i.test(noun) ? terms.eventPlural : terms.event,
      );
      if (!article) return insert(word);
      const indefinite = /^[aeiou]/i.test(word) ? "an" : "a";
      const prefix =
        noun === noun.toUpperCase()
          ? indefinite.toUpperCase()
          : /^[A-Z]/.test(article)
            ? indefinite.charAt(0).toUpperCase() + indefinite.slice(1)
            : indefinite;
      return insert(`${prefix} ${word}`);
    },
  );
  if (church) return finish(copy);
  copy = copy
    .replace(/\bWorship Set\b/gi, () => insert(terms.sectionExample))
    .replace(/\bPastor James(?: Mensah)?\b/gi, () =>
      insert(terms.presenterExample),
    )
    .replace(/\b(?:worship|sermon)\b/gi, (match) =>
      insert(casing(match, terms.section)),
    )
    .replace(/\b(?:pastor|speaker)\b/gi, (match) =>
      insert(casing(match, terms.presenter)),
    )
    .replace(/\b(?:congregation|sanctuary)\b/gi, (match) =>
      casing(match, match.toLowerCase() === "sanctuary" ? "venue" : "audience"),
    )
    .replace(/\b(?:churches|church|ministry)\b/gi, (match) =>
      casing(
        match,
        match.toLowerCase() === "churches"
          ? "production teams"
          : "production team",
      ),
    )
    .replace(/\b(?:serving|serve)\b/gi, (match) =>
      casing(
        match,
        match.toLowerCase() === "serving" ? "working" : "participate",
      ),
    );
  return finish(copy);
}
