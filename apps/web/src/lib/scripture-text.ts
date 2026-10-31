// ProPresenter often flattens its verse and reference text boxes into one string.
// Only detach references at the edges; a reference quoted inside a verse stays.
const book = String.raw`(?:[1-3]\s*)?(?:Genesis|Gen\.?|Exodus|Exod?\.?|Leviticus|Lev\.?|Numbers|Num\.?|Deuteronomy|Deut\.?|Joshua|Josh\.?|Judges|Judg\.?|Ruth|Samuel|Sam\.?|Kings|Kgs\.?|Chronicles|Chron\.?|Ezra|Nehemiah|Neh\.?|Esther|Esth\.?|Job|Psalms?|Ps\.?|Proverbs|Prov\.?|Ecclesiastes|Eccl\.?|Song of (?:Solomon|Songs)|Isaiah|Isa\.?|Jeremiah|Jer\.?|Lamentations|Lam\.?|Ezekiel|Ezek\.?|Daniel|Dan\.?|Hosea|Hos\.?|Joel|Amos|Obadiah|Obad\.?|Jonah|Micah|Mic\.?|Nahum|Nah\.?|Habakkuk|Hab\.?|Zephaniah|Zeph\.?|Haggai|Hag\.?|Zechariah|Zech\.?|Malachi|Mal\.?|Matthew|Matt?\.?|Mark|Mk\.?|Luke|Lk\.?|John|Jn\.?|Acts|Romans|Rom\.?|Corinthians|Cor\.?|Galatians|Gal\.?|Ephesians|Eph\.?|Philippians|Phil\.?|Colossians|Col\.?|Thessalonians|Thess\.?|Timothy|Tim\.?|Titus|Philemon|Philem\.?|Hebrews|Heb\.?|James|Jas\.?|Peter|Pet\.?|Jude|Revelation|Rev\.?)`;
const passage = String.raw`${book}\s+\d{1,3}(?::\d{1,3})?(?:\s*[-–—]\s*\d{1,3}(?::\d{1,3})?)?(?:\s*,\s*\d{1,3}(?:\s*[-–]\s*\d{1,3})?)*`;
const version = String.raw`(?:New King James Version|King James Version|New International Version|English Standard Version|New Living Translation|New American Standard Bible|NKJV|KJV|NIV|ESV|NLT|NASB(?:1995|2020)?|CSB|HCSB|NRSVUE|NRSV|RSV|AMP|AMPC|MSG|NET|GNT|TPT|CEV|ERV|ASV|WEB)`;
const suffix = String.raw`(?:\s*(?:[·|—–-][ \t]*)?\(?${version}\)?)?`;
const leading = new RegExp(String.raw`^\s*(${passage}${suffix})(?=\s|$)[ \t]*(?:\r?\n|[·|—–-][ \t]*)?`, "i");
const trailing = new RegExp(String.raw`(?:^|\s|[—–])(${passage}${suffix})\s*$`, "i");
const metadataReference = new RegExp(String.raw`\b(${passage}${suffix})(?=\s|$|[·|])`, "i");

export function splitScriptureText(text: string, metadata: readonly string[] = []) {
  const start = text.match(leading);
  const end = start ? null : text.match(trailing);
  const match = start ?? end;
  if (match) {
    let body = start ? text.slice(match[0].length) : text.slice(0, match.index);
    // Some templates put the translation in its own final text box.
    const translation = body.match(new RegExp(String.raw`(?:\r?\n)\s*(\(?${version}\)?)\s*$`, "i"));
    if (translation) body = body.slice(0, translation.index);
    return {
      text: body.trim(),
      reference: `${match[1].trim().replace(/\s+/g, " ")}${translation ? ` · ${translation[1]}` : ""}`,
    };
  }
  const reference = metadata.map((value) => value.match(metadataReference)?.[1]).find(Boolean) ?? "";
  return { text, reference };
}
