// Read literal action types from TypeScript hover signatures. Do not invent
// labels from symbol names: custom event factories can use different rules.
function actionTypeFromHover(contents) {
  for (const content of contents) {
    const text = typeof content === 'string' ? content : content.value;

    if (!text) {
      continue;
    }

    const literal = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
    const patterns = [
      new RegExp(`\\bActionCreator\\s*<\\s*${literal}\\s*[,>]`),
      new RegExp(`\\bAction\\s*<\\s*${literal}\\s*>`),
      new RegExp(`\\btype\\s*:\\s*${literal}\\s*(?=[;,}\\n]|$)`),
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);

      if (match) {
        // TypeScript generally prints double-quoted literals. JSON decoding
        // preserves escaped quotes and backslashes instead of displaying them.
        if (match[1].startsWith('"')) {
          try {
            return JSON.parse(match[1]);
          } catch {
            continue;
          }
        }

        return match[1].slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      }
    }
  }
}

module.exports = { actionTypeFromHover };
