// If-Match parsing, per RFC 9110 sections 8.8.3 (ETag) and 13.1.1 (If-Match).
//
// The header is either a bare "*" or a comma-separated list of entity-tags.
// An entity-tag is a quoted opaque string, optionally prefixed by the weak
// marker "W/". Opaque is the operative word: a tag is compared as the exact
// bytes the server emitted, never parsed as the integer this server happens
// to put inside it.

/** Result of reading an If-Match header off a request. */
export type IfMatch =
  | { kind: "absent" }
  | { kind: "malformed" }
  | { kind: "wildcard" }
  /** Strong tags only: weak tags are dropped here, since they can never strongly match. */
  | { kind: "tags"; strong: string[] };

// One entity-tag: an optional weak marker, then a quoted string of etagc
// characters (RFC 9110 8.8.3: %x21 / %x23-7E / obs-text, i.e. anything
// printable except the double quote that delimits it).
const ENTITY_TAG = /^(W\/)?"([\x21\x23-\x7E\x80-\xFF]*)"$/;

/**
 * Parses an If-Match header value. Returns "malformed" for any value that
 * isn't valid header syntax, including an empty value and "*" mixed into a
 * list, so the caller can answer 400 rather than silently ignoring it.
 */
export function parseIfMatch(header: string | undefined): IfMatch {
  if (header === undefined) return { kind: "absent" };

  const value = header.trim();
  if (value === "") return { kind: "malformed" };
  if (value === "*") return { kind: "wildcard" };

  const members = splitTagList(value);
  if (members === null) return { kind: "malformed" };

  const strong: string[] = [];
  for (const member of members) {
    const match = ENTITY_TAG.exec(member);
    // "*" reaching here came from a list, where the wildcard is not an
    // allowed member - it is an alternative to the whole list, not a tag.
    if (!match) return { kind: "malformed" };
    // A weak tag is valid syntax but never strongly matches. Keeping it out
    // of `strong` (rather than stripping "W/") is what makes If-Match use
    // strong comparison: W/"1" must not match "1".
    if (match[1] === undefined) strong.push(match[2] as string);
  }

  return { kind: "tags", strong };
}

/** True if any strong tag in the header equals the current entity-tag. */
export function matchesStrongly(parsed: IfMatch, currentTag: string): boolean {
  return parsed.kind === "tags" && parsed.strong.includes(currentTag);
}

/**
 * Splits a tag list on the commas that separate members, not on commas
 * inside a quoted tag: `"a,b"` is one tag, not two. Returns null if the
 * list is not well formed (unterminated quote, empty member, junk between
 * a closing quote and the next comma).
 */
function splitTagList(value: string): string[] | null {
  const members: string[] = [];
  let index = 0;

  while (index < value.length) {
    // OWS before a member.
    while (index < value.length && isSpace(value[index])) index++;

    const start = index;
    if (value.startsWith("W/", index)) index += 2;
    if (value[index] !== '"') return null;

    // Consume the quoted string. No backslash escaping: RFC 9110's etagc
    // excludes the quote character outright, so the first quote ends it.
    const closing = value.indexOf('"', index + 1);
    if (closing === -1) return null;
    index = closing + 1;
    members.push(value.slice(start, index));

    // OWS after a member, then either the end or a comma.
    while (index < value.length && isSpace(value[index])) index++;
    if (index === value.length) break;
    if (value[index] !== ",") return null;
    index++;
    // A trailing comma leaves no further member, which is an empty list
    // element rather than a valid tag.
    if (value.slice(index).trim() === "") return null;
  }

  return members.length > 0 ? members : null;
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}
