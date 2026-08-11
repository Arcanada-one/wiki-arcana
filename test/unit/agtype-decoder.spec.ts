import { describe, expect, it } from 'vitest';
import { decodeAgtype } from '../../src/storage/adapters/age/agtype.decoder.js';

describe('decodeAgtype', () => {
  it('normalizes AGE vertex payloads without losing 64-bit integers', () => {
    expect(decodeAgtype('{"id":9007199254740993,"label":"KnowledgeNode","properties":{"id":"n"}}::vertex'))
      .toEqual({ id: 9007199254740993n, label: 'KnowledgeNode', properties: { id: 'n' } });
  });

  it('preserves nested arrays, booleans, null, and escaped strings', () => {
    expect(decodeAgtype(String.raw`[true,null,{"value":"a\n\"b"}]`))
      .toEqual([true, null, { value: 'a\n"b' }]);
  });

  it('decodes a top-level signed int64 without precision loss', () => {
    expect(decodeAgtype('9223372036854775807')).toBe(9223372036854775807n);
    expect(decodeAgtype('-9223372036854775808')).toBe(-9223372036854775808n);
  });

  it('keeps integers at the JavaScript safe boundary as numbers', () => {
    expect(decodeAgtype('[9007199254740991,-9007199254740991]'))
      .toEqual([9007199254740991, -9007199254740991]);
  });

  it('promotes integers just outside the JavaScript safe boundary to bigint', () => {
    expect(decodeAgtype('[9007199254740992,-9007199254740992]'))
      .toEqual([9007199254740992n, -9007199254740992n]);
  });

  it('decodes nested AGE vertices and edges inside a path', () => {
    const encoded = String.raw`[{"id":9223372036854775807,"label":"KnowledgeNode","properties":{"title":"line\n\"quoted\"","values":[-9223372036854775808,{"safe":42}]}}::vertex,{"id":9007199254740992,"label":"LINKS_TO","start_id":9223372036854775806,"end_id":9223372036854775807,"properties":{"weight":0.5}}::edge]::path`;

    expect(decodeAgtype(encoded)).toEqual([
      {
        id: 9223372036854775807n,
        label: 'KnowledgeNode',
        properties: {
          title: 'line\n"quoted"',
          values: [-9223372036854775808n, { safe: 42 }],
        },
      },
      {
        id: 9007199254740992n,
        label: 'LINKS_TO',
        start_id: 9223372036854775806n,
        end_id: 9223372036854775807n,
        properties: { weight: 0.5 },
      },
    ]);
  });
});
