const AGE_TYPE_NAMES = new Set(['vertex', 'edge', 'path']);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);

class AgtypeParser {
  private position = 0;

  constructor(private readonly input: string) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.position !== this.input.length) this.fail('Unexpected trailing input');
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const initial = this.input[this.position];
    let value: unknown;

    switch (initial) {
      case '{': value = this.parseObject(); break;
      case '[': value = this.parseArray(); break;
      case '"': value = this.parseString(); break;
      case 't': value = this.parseLiteral('true', true); break;
      case 'f': value = this.parseLiteral('false', false); break;
      case 'n': value = this.parseLiteral('null', null); break;
      default: value = this.parseNumber();
    }

    this.skipWhitespace();
    if (this.input.startsWith('::', this.position)) this.parseTypeSuffix();
    return value;
  }

  private parseObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.position += 1;
    this.skipWhitespace();
    if (this.consume('}')) return result;

    while (true) {
      this.skipWhitespace();
      if (this.input[this.position] !== '"') this.fail('Expected an object key');
      const key = this.parseString();
      this.skipWhitespace();
      if (!this.consume(':')) this.fail('Expected a colon after an object key');
      const value = this.parseValue();
      Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
      this.skipWhitespace();
      if (this.consume('}')) return result;
      if (!this.consume(',')) this.fail('Expected a comma or closing brace');
    }
  }

  private parseArray(): unknown[] {
    const result: unknown[] = [];
    this.position += 1;
    this.skipWhitespace();
    if (this.consume(']')) return result;

    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume(']')) return result;
      if (!this.consume(',')) this.fail('Expected a comma or closing bracket');
    }
  }

  private parseString(): string {
    const start = this.position;
    this.position += 1;

    while (this.position < this.input.length) {
      const character = this.input[this.position];
      if (character === '\\') {
        this.position += 2;
        continue;
      }
      this.position += 1;
      if (character === '"') {
        return JSON.parse(this.input.slice(start, this.position)) as string;
      }
    }

    this.fail('Unterminated string');
  }

  private parseNumber(): number | bigint {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.input.slice(this.position));
    if (!match) this.fail('Expected an agtype value');
    const encoded = match[0];
    this.position += encoded.length;

    if (encoded.includes('.') || /[eE]/.test(encoded)) return Number(encoded);
    const integer = BigInt(encoded);
    return integer >= MIN_SAFE_INTEGER && integer <= MAX_SAFE_INTEGER ? Number(integer) : integer;
  }

  private parseLiteral<T>(encoded: string, value: T): T {
    if (!this.input.startsWith(encoded, this.position)) this.fail(`Expected ${encoded}`);
    this.position += encoded.length;
    return value;
  }

  private parseTypeSuffix(): void {
    this.position += 2;
    const match = /^[a-z]+/.exec(this.input.slice(this.position));
    if (!match || !AGE_TYPE_NAMES.has(match[0])) this.fail('Unsupported agtype annotation');
    this.position += match[0].length;
  }

  private consume(expected: string): boolean {
    if (this.input[this.position] !== expected) return false;
    this.position += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.input[this.position] ?? '')) this.position += 1;
  }

  private fail(message: string): never {
    throw new SyntaxError(`${message} at position ${this.position}`);
  }
}

export function decodeAgtype(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return new AgtypeParser(value).parse();
}
