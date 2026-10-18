/**
 * Source scanner behind the "GitLab adapter source" guard in
 * `cli-flag-shapes.test.ts` (#383, #594). Kept in its own module so the
 * scanner can be tested against fixtures, not only against today's tree:
 * a guard whose only test is "the real tree is clean" cannot tell a correct
 * scanner from one that matches nothing.
 */

/**
 * Remove every `//` and `/* *\/` comment from TypeScript source, leaving
 * string, template and regex literals intact and every newline in place.
 *
 * The old guard dropped only lines that START with a comment, so a trailing
 * comment on a code line (`run(); // glab mr view -F json`) was scanned as
 * code: a false positive (#594). Stripping comments by line prefix cannot fix
 * that, because `//` also appears inside string literals (`'https://…'`) and a
 * prefix rule cannot tell the two apart. This walks the source as a small state
 * machine instead.
 *
 * A `${…}` interpolation is code, and it may hold its own templates: the
 * shell-quote idiom `'${s.replace(/'/g, `'\\''`)}'` nests one. So template text
 * and interpolations are tracked with a stack of brace depths: `${` pushes,
 * and the `}` that brings its depth back to zero resumes the enclosing
 * template. Treating `${…}` as opaque text ends the outer template at the
 * inner backtick and inverts string and code for the rest of the file.
 *
 * A `/` is read as the start of a regex literal when what precedes it cannot
 * end an expression: an operator or opening bracket, or a keyword such as
 * `return` (`return /https?:\/\//.test(x)`). That is the usual heuristic, and
 * it keeps a quote or a `//` inside a regex from flipping the scanner's state.
 */
export function stripTsComments(src: string): string {
  let out = '';
  let i = 0;
  // Last non-whitespace character emitted as code, for the regex heuristic.
  let prev = '';
  const n = src.length;
  // One entry per open `${`: the `{` depth inside that interpolation.
  const interp: number[] = [];

  const copyQuoted = (quote: string): void => {
    out += src[i++];
    while (i < n && src[i] !== quote) {
      if (src[i] === '\\' && i + 1 < n) out += src[i++];
      if (src[i] === '\n') break; // unterminated: stop at EOL
      out += src[i++];
    }
    if (i < n && src[i] === quote) out += src[i++];
    prev = quote;
  };

  // Copy template text up to its closing backtick, or up to and including a
  // `${`, which hands control back to the code loop.
  const copyTemplateText = (): void => {
    while (i < n) {
      const c = src[i];
      if (c === '\\' && i + 1 < n) {
        out += src[i++] + src[i++];
      } else if (c === '`') {
        out += src[i++];
        prev = '`';
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        interp.push(0);
        prev = '{';
        return;
      } else {
        out += src[i++];
      }
    }
  };

  const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'case', 'in', 'of', 'void', 'throw',
    'new', 'delete', 'yield', 'await', 'instanceof', 'else', 'do',
  ]);
  const regexMayStart = (): boolean => {
    if (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)) return true;
    const word = /([A-Za-z_$][\w$]*)\s*$/.exec(out.slice(-64));
    return word !== null && REGEX_KEYWORDS.has(word[1]);
  };

  const copyRegex = (): void => {
    out += src[i++];
    let inClass = false;
    while (i < n && src[i] !== '\n') {
      const c = src[i];
      if (c === '\\' && i + 1 < n) {
        out += src[i++];
      } else if (c === '[') {
        inClass = true;
      } else if (c === ']') {
        inClass = false;
      } else if (c === '/' && !inClass) {
        break;
      }
      out += src[i++];
    }
    if (i < n && src[i] === '/') out += src[i++];
    while (i < n && /[a-z]/i.test(src[i])) out += src[i++]; // flags
    prev = '/';
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
    } else if (c === "'" || c === '"') {
      copyQuoted(c);
    } else if (c === '`') {
      out += src[i++];
      copyTemplateText();
    } else if (c === '/' && regexMayStart()) {
      copyRegex();
    } else if (c === '{' && interp.length > 0) {
      interp[interp.length - 1]++;
      out += src[i++];
      prev = '{';
    } else if (c === '}' && interp.length > 0) {
      out += src[i++];
      if (interp[interp.length - 1] === 0) {
        interp.pop();
        copyTemplateText(); // back inside the enclosing template
      } else {
        interp[interp.length - 1]--;
        prev = '}';
      }
    } else {
      out += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out;
}

/**
 * A `glab` call that asks a non-`api` subcommand for machine output with
 * `-F`, `--output` or `--format`, in argv-array form. The adapters build argv
 * as multi-line arrays and append flags with `.push()`, so the match spans
 * lines (bounded at 400 characters). `glab api` is exempt: there `-F` means a
 * typed request field, and `glab api` is the supported way to get JSON.
 */
const ARGV = /'glab',\s*'(?!api')[\w-]+'[\s\S]{0,400}?'(-F|--output|--format)'/;

/** The same, written as a shell string (`glab label list -F json`). */
const SHELL = /\bglab (?!api\b)[\w-]+[^\n`'"]*?(\s-F\b|\s--output\b|\s--format\b)/;

/**
 * Return the first offending fragment in a TypeScript source file, or null.
 * Comments are stripped first, so prose that NAMES the forbidden form (the
 * adapters' own history notes) is not a hit.
 */
export function findGlabOutputFlag(src: string): string | null {
  const code = stripTsComments(src);
  const hit = ARGV.exec(code) ?? SHELL.exec(code);
  return hit ? hit[0].replace(/\s+/g, ' ') : null;
}
