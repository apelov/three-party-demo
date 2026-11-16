// RFC 8785 (JSON Canonicalization Scheme) for the record metadata profile.
//
// The profile is one flat JSON object whose member values are strings and
// integers (CONTRACT.md section 5). Over that domain RFC 8785 says: members
// sorted by the UTF-16 code units of their names (section 3.2.3), no
// whitespace, strings escaped the way ECMAScript's JSON.stringify escapes
// them (section 3.2.2.2), and an integer written as its decimal digits
// (section 3.2.2.3). A value outside the profile is refused, never coerced:
// bytes this module cannot canonicalize must not reach a signature.

function refuse(message) {
  const error = new TypeError(message);
  error.code = 'ERR_JCS_PROFILE';
  throw error;
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// A string with an unpaired surrogate has no UTF-8 form, so it is refused
// (the format's canonicalization domain says the same).
function wellFormed(text, what) {
  if (!text.isWellFormed()) refuse(`${what} holds an unpaired UTF-16 surrogate`);
  return text;
}

// The canonical bytes of a metadata object.
export function canonicalize(metadata) {
  if (typeName(metadata) !== 'object') refuse(`the metadata is a JSON ${typeName(metadata)}, not an object`);
  const proto = Object.getPrototypeOf(metadata);
  if (proto !== Object.prototype && proto !== null) refuse('the metadata is not a plain object');
  // Array.prototype.sort with no comparator orders strings by their UTF-16
  // code units, which is the order RFC 8785 asks for.
  const names = Object.keys(metadata).sort();
  const members = names.map((name) => {
    const label = `member ${JSON.stringify(name)}`;
    wellFormed(name, `the name of ${label}`);
    const value = metadata[name];
    if (typeof value === 'string') return `${JSON.stringify(name)}:${JSON.stringify(wellFormed(value, label))}`;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) refuse(`${label} is ${value}: the profile admits an integer within +-(2^53-1) and no other number`);
      return `${JSON.stringify(name)}:${String(value)}`; // minus zero is written 0
    }
    return refuse(`${label} is a JSON ${typeName(value)}: the profile admits strings and integers`);
  });
  return Buffer.from(`{${members.join(',')}}`, 'utf8');
}
