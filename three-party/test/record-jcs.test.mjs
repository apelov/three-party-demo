// RFC 8785 for the record metadata profile (strings and integers). The three
// examples are the RFC's own data: the sorting sample of section 3.2.3, the
// string member of the section 3.2.2 sample, and the number table of
// Appendix B. The expected bytes are written out here by hand and never
// computed with the code under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize } from '../src/record/jcs.mjs';

const text = (value) => canonicalize(value).toString('utf8');
// Characters outside ASCII are made from their code points, so this file
// holds no such character and no escape that stands for one.
const chr = (...codePoints) => String.fromCodePoint(...codePoints);
const EURO = chr(0x20ac);
const O_DIAERESIS = chr(0xf6);
const DALET_DAGESH = chr(0xfb33);
const GRINNING_FACE = chr(0x1f600);
const U0080 = chr(0x80);
const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdc00);

const refuses = (value, pattern, label) => {
  assert.throws(() => canonicalize(value), (error) => error instanceof TypeError && error.code === 'ERR_JCS_PROFILE' && pattern.test(error.message), label);
};

test('JCS example 1, sorting: the member names of RFC 8785 section 3.2.3 come out in the order that section gives, by UTF-16 code unit', () => {
  // The input of section 3.2.3, member for member, in its order.
  const input = JSON.parse('{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}');
  const out = text(input);
  // The order of values that section gives after sorting.
  const order = ['Carriage Return', 'One', 'Control', 'Latin Small Letter O With Diaeresis', 'Euro Sign', 'Emoji: Grinning Face', 'Hebrew Letter Dalet With Dagesh'];
  const positions = order.map((value) => out.indexOf(`"${value}"`));
  assert.ok(positions.every((at) => at > 0), 'each value is in the output');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  // The whole text: the carriage return is the two-character escape, and
  // every other name is written as its own character.
  assert.equal(out, `{"\\r":"Carriage Return","1":"One","${U0080}":"Control","${O_DIAERESIS}":"Latin Small Letter O With Diaeresis","${EURO}":"Euro Sign","${GRINNING_FACE}":"Emoji: Grinning Face","${DALET_DAGESH}":"Hebrew Letter Dalet With Dagesh"}`);
  // U+0080 is above the escaped range, so it is the two UTF-8 bytes C2 80.
  assert.ok(canonicalize(input).includes(Buffer.from([0x22, 0xc2, 0x80, 0x22])));
});

test('JCS example 2, strings: the string member of the RFC 8785 section 3.2.2 sample serializes to the bytes that section gives', () => {
  // The "string" member of the section's sample input.
  const input = JSON.parse('{"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/"}');
  assert.equal(input.string.length, 12);
  // The "string" member of the section's expected text: the euro sign as its
  // own character, U+000F as a lowercase unicode escape, the line feed as its
  // two-character escape, the quotes and backslashes escaped, the solidus plain.
  const want = `{"string":"${EURO}` + '$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
  assert.equal(text(input), want);
  assert.equal(canonicalize(input).length, Buffer.byteLength(want, 'utf8'));
});

test('JCS example 3, integers: each row of the RFC 8785 Appendix B number table that is an integer inside the profile serializes to the table\'s text, and every other row is refused', () => {
  // Appendix B, the rows that have a text: IEEE 754 bits, and that text.
  // Its two other rows, NaN and Infinity, have none and are tried below.
  const table = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];
  let inside = 0;
  let outside = 0;
  for (const [bits, want] of table) {
    const value = Buffer.from(bits, 'hex').readDoubleBE(0);
    if (Number.isSafeInteger(value)) {
      inside += 1;
      assert.equal(text({ n: value }), `{"n":${want}}`, bits);
    } else {
      outside += 1;
      refuses({ n: value }, /the profile admits an integer within/, bits);
    }
  }
  // Zero and minus zero are the two rows inside the profile; 2^53 and its
  // negative, the rows nearest the bound, are outside it.
  assert.deepEqual({ inside, outside }, { inside: 2, outside: 22 });
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) refuses({ n: value }, /the profile admits an integer within/, String(value));
  // The bound itself is inside, and is written as its digits.
  assert.equal(text({ max: 9007199254740991, min: -9007199254740991 }), '{"max":9007199254740991,"min":-9007199254740991}');
  assert.equal(text({ seq: 5, step: 'pay' }), '{"seq":5,"step":"pay"}');
});

test('JCS refuses what the profile does not hold: a fraction, a nested object, an array, a boolean, null, an unpaired surrogate, and a value that is not a plain object', () => {
  refuses({ amount: 12.5 }, /member "amount" is 12\.5/, 'a fraction');
  refuses({ a: { b: 'c' } }, /member "a" is a JSON object/, 'a nested object');
  refuses({ a: ['b'] }, /member "a" is a JSON array/, 'an array');
  refuses({ a: true }, /member "a" is a JSON boolean/, 'a boolean');
  refuses({ a: null }, /member "a" is a JSON null/, 'null');
  refuses({ a: undefined }, /member "a" is a JSON undefined/, 'undefined');
  refuses({ a: `x${LONE_HIGH}y` }, /member "a" holds an unpaired UTF-16 surrogate/, 'a lone surrogate in a value');
  refuses({ [`x${LONE_LOW}`]: 'a' }, /the name of member .* holds an unpaired UTF-16 surrogate/, 'a lone surrogate in a name');
  refuses(['a'], /the metadata is a JSON array, not an object/, 'an array at the top');
  refuses('a', /the metadata is a JSON string, not an object/, 'a string at the top');
  refuses(null, /the metadata is a JSON null, not an object/, 'null at the top');
  refuses(new Map([['a', 'b']]), /the metadata is not a plain object/, 'a Map');
  // An object with no prototype is a plain object, and an empty one is {}.
  assert.equal(text(Object.assign(Object.create(null), { b: 'x', a: 1 })), '{"a":1,"b":"x"}');
  assert.equal(text({}), '{}');
});
